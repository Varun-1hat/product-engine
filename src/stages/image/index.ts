/**
 * Stage 4 — Start & End images (b-roll only) (spec §7 Stage 4). REFERENCE
 * IMPLEMENTATION for two-granularity review (brief §8) — src/stages/clip
 * and src/stages/outro follow this same shape.
 *
 * Capability-driven image slots (planImageSlots, ./plan.ts): a start slot
 * always, an end slot only if the effective model supports_end_frame; a
 * continuous boundary's end/start is ONE shared asset generated once
 * (§2.4). Estimate = count(distinct slots) x $0.039. Cost logged per
 * Nano Banana call including redos.
 *
 * NOTE on `review`: ReviewHooks methods (spec §6) take no ctx parameter,
 * but every one of them needs Supabase/adapter/skill access. `review` is
 * therefore NOT populated on the static `imageStage` object (it's optional
 * per the StageModule type) — instead `createImageReviewHooks(ctx)` builds
 * a ctx-bound ReviewHooks instance, which is what app/api/** route handlers
 * actually call. Same pattern in src/stages/clip and src/stages/outro.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState, ReviewHooks, CostEstimate } from "../types";
import { nextStage } from "../types";
import { planImageSlots, type DistinctImageSlot } from "./plan";
import { supportsEndFrameLookupFor } from "@/src/lib/routing";
import { getReelConfig, getScene, getScenesForReel } from "@/src/lib/rows";
import { getBrandContext, getProductsWithPhotos, guessMimeFromExt } from "@/src/lib/brandContext";
import {
  assetHistory,
  getAsset,
  getCurrentPromptVersion,
  getPrompt,
  promptHistory,
  revertAssetVersion,
  revertPromptVersion,
  upsertAssetVersion,
  upsertPromptVersion,
} from "@/src/lib/versioning";
import { createUploadedAsset, uploadAssetVersion } from "@/src/lib/assetUpload";
import type { AssetRow, AssetVersion, ReelConfigRow, SceneRow } from "@/src/lib/db/types";
import type { PromptKind } from "@/src/lib/db/enums";

export const imageInputSchema = z.object({});
export type ImageInput = z.infer<typeof imageInputSchema>;

export interface ImageSlotResult {
  slot: DistinctImageSlot;
  asset: AssetRow;
}
export interface ImageOutput {
  slots: ImageSlotResult[];
}

function promptKindFor(role: "start" | "end"): PromptKind {
  return role === "start" ? "image_start" : "image_end";
}

async function load(ctx: StageContext): Promise<StageState> {
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  return { stage: "image", data: { scenes } };
}

/**
 * Creates (never overwrites) the prompt for one planned slot. Reusing an
 * existing prompt is what makes it editable BEFORE the paid image call —
 * ensureImagePrompts() below writes them ahead of time, and a user edit
 * survives into the generate that follows.
 */
async function ensureSlotPrompt(
  ctx: StageContext,
  slotPlan: DistinctImageSlot,
  scene: SceneRow
): Promise<{ promptId: string; versionId: string; text: string; reference_paths: string[] }> {
  const kind = promptKindFor(slotPlan.role);
  const { data, error } = await ctx.supa
    .from("prompts")
    .select("id, current_version_id")
    .eq("scene_id", scene.id)
    .eq("kind", kind)
    .maybeSingle();
  if (error) throw new Error(`prompts lookup failed: ${error.message}`);
  const existing = data as { id: string; current_version_id: string | null } | null;

  if (existing?.current_version_id) {
    const current = await getCurrentPromptVersion(ctx.supa, existing.id);
    if (current) {
      return {
        promptId: existing.id,
        versionId: current.id,
        text: current.text,
        reference_paths: current.reference_paths ?? [],
      };
    }
  }

  const brand = await getBrandContext(ctx.supa, ctx.clientId);
  const products = await getProductsWithPhotos(ctx.supa, ctx.clientId);

  const neighborScene =
    slotPlan.linked_scene_ids.length > 1
      ? await getScene(ctx.supa, slotPlan.linked_scene_ids.find((id) => id !== slotPlan.primary_scene_id)!)
      : null;

  const { prompt, reference_paths } = await ctx.skills.imagePrompt({
    scene: {
      description: scene.description,
      type: scene.type,
      product_in_scene: scene.product_in_scene,
      seconds: scene.seconds,
    },
    boundary_context: {
      role: slotPlan.role,
      shared: slotPlan.shared,
      neighborDescription: neighborScene?.description ?? undefined,
    },
    brand,
    products,
  });

  const { prompt: promptRow, version } = await upsertPromptVersion(ctx.supa, {
    promptId: existing?.id,
    reel_id: ctx.reelId,
    scene_id: scene.id,
    kind,
    text: prompt,
    reference_paths,
    source: "skill",
  });

  return { promptId: promptRow.id, versionId: version.id, text: version.text, reference_paths };
}

/** Writes the prompt for every planned slot without generating any image. */
export async function ensureImagePrompts(ctx: StageContext): Promise<void> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const plan = planImageSlots(scenes, reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));
  for (const slotPlan of plan) {
    const scene = scenes.find((s) => s.id === slotPlan.primary_scene_id);
    if (scene) await ensureSlotPrompt(ctx, slotPlan, scene);
  }
}

/** Generates (or reuses) the image for one planned slot and returns its asset row. */
async function generateSlotAsset(
  ctx: StageContext,
  reelConfig: ReelConfigRow,
  slotPlan: DistinctImageSlot,
  scene: SceneRow
): Promise<AssetRow> {
  const { promptId, versionId, text, reference_paths } = await ensureSlotPrompt(ctx, slotPlan, scene);

  const { asset } = await generateAndPersistImage(ctx, reelConfig, slotPlan, scene, text, reference_paths, versionId);

  // Link the prompt to the asset it produced (lineage — prompts.asset_id).
  await ctx.supa.from("prompts").update({ asset_id: asset.id }).eq("id", promptId);

  return asset;
}

/**
 * Reconciles one materialized asset's lineage against `slotPlan` (recomputed
 * from live DB state on every run — see process()'s header note on N4):
 * points every scene in slotPlan.linked_scene_ids at `assetId` (both sides
 * of a shared boundary — the "owning" scene's own start/end column, plus
 * the sibling's start_image_id when shared) and reconciles assets.shared to
 * match. Used on the fresh-generation/redo path (generateAndPersistImage)
 * and the reuse path (process(), which also detaches any stale sibling
 * link separately — see detachStaleSiblingLinks) so this logic isn't
 * duplicated inline at either call site.
 */
async function linkSlotAsset(
  ctx: StageContext,
  slotPlan: DistinctImageSlot,
  scene: SceneRow,
  assetId: string
): Promise<void> {
  const { error: sharedError } = await ctx.supa.from("assets").update({ shared: slotPlan.shared }).eq("id", assetId);
  if (sharedError) throw new Error(`assets update (shared) failed: ${sharedError.message}`);

  // Point the owning scene(s) at this asset — both sides for a shared frame.
  for (const linkedSceneId of slotPlan.linked_scene_ids) {
    const column =
      linkedSceneId === scene.id ? (slotPlan.role === "start" ? "start_image_id" : "end_image_id") : "start_image_id";
    const { error } = await ctx.supa.from("scenes").update({ [column]: assetId }).eq("id", linkedSceneId);
    if (error) throw new Error(`scenes update (${column}) failed: ${error.message}`);
  }
}

/**
 * N4 companion to linkSlotAsset: clears any OTHER scene's start/end pointer
 * that still references `assetId` but the CURRENT plan no longer links here
 * (e.g. the user flipped transition_to_next off after this asset was
 * generated as a shared boundary). Only meaningful on the reuse path —
 * a freshly generated or redone asset id can't already be stale-referenced
 * by another scene, so linkSlotAsset's call sites don't need this. Without
 * it, a stale sibling pointer would make a future run wrongly treat that
 * scene's own slot as "already generated" instead of planning it fresh.
 */
async function detachStaleSiblingLinks(
  ctx: StageContext,
  scenesForReel: SceneRow[],
  slotPlan: DistinctImageSlot,
  assetId: string
): Promise<void> {
  for (const other of scenesForReel) {
    if (slotPlan.linked_scene_ids.includes(other.id)) continue;
    const updates: Partial<Pick<SceneRow, "start_image_id" | "end_image_id">> = {};
    if (other.start_image_id === assetId) updates.start_image_id = null;
    if (other.end_image_id === assetId) updates.end_image_id = null;
    if (Object.keys(updates).length === 0) continue;
    const { error } = await ctx.supa.from("scenes").update(updates).eq("id", other.id);
    if (error) throw new Error(`scenes update (detach stale link) failed: ${error.message}`);
  }
}

async function generateAndPersistImage(
  ctx: StageContext,
  reelConfig: ReelConfigRow,
  slotPlan: DistinctImageSlot,
  scene: SceneRow,
  prompt: string,
  referencePaths: string[],
  promptVersionId: string,
  /** Pass the existing asset id on a redo — appends a new version instead of creating a new `assets` row. */
  existingAssetId?: string,
  callType: "generate" | "redo" = "generate"
): Promise<{ asset: AssetRow; version: AssetVersion }> {
  const provider = reelConfig.image_provider;
  const adapter = ctx.adapters.get("image", provider);
  const providerKey = await ctx.keys.forProvider(ctx.clientId, provider);

  const references = await Promise.all(
    referencePaths.map(async (path) => {
      const buffer = await ctx.storage.download("products", path);
      return { base64: buffer.toString("base64"), mime_type: guessMimeFromExt(path) };
    })
  );

  const idempotencyKey = randomUUID();
  const result = await adapter.generate({
    client_id: ctx.clientId,
    reel_id: ctx.reelId,
    scene_id: scene.id,
    prompt,
    references,
    aspect_ratio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    provider_key: providerKey,
    idempotency_key: idempotencyKey,
  });

  // Nano Banana is synchronous (async:false) — this always resolves 'succeeded' or throws.
  const costLog = await ctx.costEngine.log({
    reel_id: ctx.reelId,
    client_id: ctx.clientId,
    scene_id: scene.id,
    stage: "image",
    provider,
    adapter: adapter.id,
    call_type: callType,
    call_status: "success",
    units: result.units,
    unit_type: result.unit_type,
    idempotency_key: idempotencyKey,
  });

  const { asset, version } = await upsertAssetVersion(ctx.supa, {
    assetId: existingAssetId,
    reel_id: ctx.reelId,
    scene_id: slotPlan.primary_scene_id,
    slot: slotPlan.role === "start" ? "start_image" : "end_image",
    media_type: "image",
    shared: slotPlan.shared,
    storage_path: result.asset?.storage_path ?? null,
    source: "generated",
    prompt_version_id: promptVersionId,
    provider,
    // §2.2: asset_versions.metadata includes `mime`, even though GenerateResultAsset
    // carries it as a sibling field (§3) — fold it in here.
    metadata: { ...(result.asset?.metadata ?? {}), mime: result.asset?.mime },
    units: result.units,
    unit_type: result.unit_type,
    cost_log_id: costLog.id,
  });

  await linkSlotAsset(ctx, slotPlan, scene, asset.id);

  return { asset, version };
}

async function process(_input: ImageInput, ctx: StageContext): Promise<ImageOutput> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const plan = planImageSlots(scenes, reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));

  const results: ImageSlotResult[] = [];
  for (const slotPlan of plan) {
    const scene = scenes.find((s) => s.id === slotPlan.primary_scene_id);
    if (!scene) continue;

    const existingAssetId = slotPlan.role === "start" ? scene.start_image_id : scene.end_image_id;
    if (existingAssetId) {
      // N4: generation itself isn't needed, but `plan` is recomputed from
      // live DB state on every run — still reconcile scenes.{start,end}_image_id
      // and assets.shared against the CURRENT plan before reusing (attach a
      // newly-shared sibling / detach a no-longer-shared one), so lineage
      // never silently drifts from what the plan says today.
      await linkSlotAsset(ctx, slotPlan, scene, existingAssetId);
      await detachStaleSiblingLinks(ctx, scenes, slotPlan, existingAssetId);
      results.push({ slot: slotPlan, asset: await getAsset(ctx.supa, existingAssetId) });
      continue;
    }

    results.push({ slot: slotPlan, asset: await generateSlotAsset(ctx, reelConfig, slotPlan, scene) });
  }

  return { slots: results };
}

async function estimate(_input: ImageInput, ctx: StageContext): Promise<CostEstimate> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const plan = planImageSlots(scenes, reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));

  return ctx.costEngine.estimate(
    plan.map(() => ({
      provider: reelConfig.image_provider,
      category: "image" as const,
      unit_type: "image",
      units: 1,
      client_id: ctx.clientId,
    }))
  );
}

async function advance(ctx: StageContext): Promise<import("@/src/lib/db/enums").StageId> {
  const next = nextStage("image");
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const imageStage: StageModule<ImageInput, ImageOutput> = {
  id: "image",
  inputSchema: imageInputSchema,
  load,
  process,
  estimate,
  advance,
};

/** ctx-bound review hooks (see file header note) — used by app/api/**. */
export function createImageReviewHooks(ctx: StageContext): ReviewHooks {
  return {
    async redoPrompt(promptId) {
      const promptRow = await getPrompt(ctx.supa, promptId);
      if (!promptRow.scene_id) throw new Error(`prompt ${promptId} has no associated scene`);
      const scene = await getScene(ctx.supa, promptRow.scene_id);
      const brand = await getBrandContext(ctx.supa, ctx.clientId);
      const products = await getProductsWithPhotos(ctx.supa, ctx.clientId);
      const role: "start" | "end" = promptRow.kind === "image_start" ? "start" : "end";

      const { prompt, reference_paths } = await ctx.skills.imagePrompt({
        scene: {
          description: scene.description,
          type: scene.type,
          product_in_scene: scene.product_in_scene,
          seconds: scene.seconds,
        },
        boundary_context: { role, shared: false },
        brand,
        products,
      });

      const { version } = await upsertPromptVersion(ctx.supa, {
        promptId,
        reel_id: promptRow.reel_id,
        scene_id: promptRow.scene_id,
        asset_id: promptRow.asset_id,
        kind: promptRow.kind,
        text: prompt,
        reference_paths,
        source: "skill",
      });
      return version;
    },

    async editPrompt(promptId, text, refs) {
      const promptRow = await getPrompt(ctx.supa, promptId);
      const { version } = await upsertPromptVersion(ctx.supa, {
        promptId,
        reel_id: promptRow.reel_id,
        scene_id: promptRow.scene_id,
        asset_id: promptRow.asset_id,
        kind: promptRow.kind,
        text,
        reference_paths: refs ?? null,
        source: "manual",
      });
      return version;
    },

    async redoAsset(assetId) {
      const asset = await getAsset(ctx.supa, assetId);
      if (!asset.scene_id) throw new Error(`asset ${assetId} has no associated scene`);
      const scene = await getScene(ctx.supa, asset.scene_id);
      const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);

      const { data: promptRow, error } = await ctx.supa.from("prompts").select("*").eq("asset_id", assetId).maybeSingle();
      if (error) throw new Error(`prompts lookup failed: ${error.message}`);
      const currentPromptVersion = promptRow ? await getCurrentPromptVersion(ctx.supa, (promptRow as { id: string }).id) : null;
      if (!currentPromptVersion) throw new Error(`no current prompt found for asset ${assetId}`);

      const slotPlan: DistinctImageSlot = {
        key: asset.id,
        role: asset.slot === "start_image" ? "start" : "end",
        primary_scene_id: scene.id,
        linked_scene_ids: [scene.id],
        shared: asset.shared,
        effective_model: reelConfig.image_provider,
      };

      const { version } = await generateAndPersistImage(
        ctx,
        reelConfig,
        slotPlan,
        scene,
        currentPromptVersion.text,
        currentPromptVersion.reference_paths ?? [],
        currentPromptVersion.id,
        assetId,
        "redo"
      );
      return { version };
    },

    async uploadAsset(assetId, storagePath) {
      return uploadAssetVersion(ctx, assetId, storagePath);
    },

    async uploadNewAsset({ sceneId, role }, storagePath) {
      if (!sceneId || !role) throw new Error("sceneId and role are required to upload an image for a new slot");
      const { asset, version } = await createUploadedAsset(ctx, {
        slot: role === "start" ? "start_image" : "end_image",
        mediaType: "image",
        storagePath,
        sceneId,
      });
      // Point the scene at it, so process() treats the slot as already
      // materialized and never generates over the upload.
      const column = role === "start" ? "start_image_id" : "end_image_id";
      const { error } = await ctx.supa.from("scenes").update({ [column]: asset.id }).eq("id", sceneId);
      if (error) throw new Error(`scenes update (${column}) failed: ${error.message}`);
      return version;
    },

    async revertPrompt(promptId, versionNo) {
      await revertPromptVersion(ctx.supa, promptId, versionNo);
    },
    async revertAsset(assetId, versionNo) {
      await revertAssetVersion(ctx.supa, assetId, versionNo);
    },
    async download(assetVersionId) {
      const { data, error } = await ctx.supa
        .from("asset_versions")
        .select("storage_path")
        .eq("id", assetVersionId)
        .single();
      if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
      const path = (data as { storage_path: string | null }).storage_path;
      if (!path) throw new Error(`asset_version ${assetVersionId} has no storage_path (not yet materialized)`);
      return ctx.storage.signedUrl("assets", path);
    },
    async history({ promptId, assetId }) {
      if (promptId) return promptHistory(ctx.supa, promptId);
      if (assetId) return assetHistory(ctx.supa, assetId);
      return [];
    },
  };
}
