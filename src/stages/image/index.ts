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
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { SupportsEndFrameLookup } from "@/src/lib/routing";
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

function supportsEndFrameLookup(adapters: AdapterRegistry): SupportsEndFrameLookup {
  return (provider) => adapters.tryGet("video_broll", provider)?.capabilities().supports_end_frame ?? false;
}

function promptKindFor(role: "start" | "end"): PromptKind {
  return role === "start" ? "image_start" : "image_end";
}

async function load(ctx: StageContext): Promise<StageState> {
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  return { stage: "image", data: { scenes } };
}

/** Generates (or reuses) the image for one planned slot and returns its asset row. */
async function generateSlotAsset(
  ctx: StageContext,
  reelConfig: ReelConfigRow,
  slotPlan: DistinctImageSlot,
  scene: SceneRow
): Promise<AssetRow> {
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

  const { prompt: promptRow, version: promptVersion } = await upsertPromptVersion(ctx.supa, {
    reel_id: ctx.reelId,
    scene_id: scene.id,
    kind: promptKindFor(slotPlan.role),
    text: prompt,
    reference_paths,
    source: "skill",
  });

  const { asset } = await generateAndPersistImage(
    ctx,
    reelConfig,
    slotPlan,
    scene,
    prompt,
    reference_paths,
    promptVersion.id
  );

  // Link the prompt to the asset it produced (lineage — prompts.asset_id).
  await ctx.supa.from("prompts").update({ asset_id: asset.id }).eq("id", promptRow.id);

  return asset;
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

  // Point the owning scene(s) at this asset — both sides for a shared frame.
  for (const linkedSceneId of slotPlan.linked_scene_ids) {
    const column =
      linkedSceneId === scene.id ? (slotPlan.role === "start" ? "start_image_id" : "end_image_id") : "start_image_id";
    const { error } = await ctx.supa.from("scenes").update({ [column]: asset.id }).eq("id", linkedSceneId);
    if (error) throw new Error(`scenes update (${column}) failed: ${error.message}`);
  }

  return { asset, version };
}

async function process(_input: ImageInput, ctx: StageContext): Promise<ImageOutput> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const plan = planImageSlots(scenes, reelConfig, supportsEndFrameLookup(ctx.adapters));

  const results: ImageSlotResult[] = [];
  for (const slotPlan of plan) {
    const scene = scenes.find((s) => s.id === slotPlan.primary_scene_id);
    if (!scene) continue;

    const existingAssetId = slotPlan.role === "start" ? scene.start_image_id : scene.end_image_id;
    if (existingAssetId) {
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
  const plan = planImageSlots(scenes, reelConfig, supportsEndFrameLookup(ctx.adapters));

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
