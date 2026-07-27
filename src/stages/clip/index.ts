/**
 * Stage 5 — Clip generation (spec §7 Stage 5, §8 routing table). Copies
 * the src/stages/image reference pattern (two-granularity review) — see
 * that file's header note on why `review` isn't a static field.
 *
 * Routes by scene.type: b-roll -> getAdapter('video_broll', effectiveModel)
 * (start(+end only if supports_end_frame) -> clip); avatar (silent) ->
 * getAdapter('video_avatar','heygen') (prompt+look(+product refs) -> clip,
 * no Nano Banana composite). Motion/shot prompts (broll_motion/avatar_shot)
 * have no dedicated generation skill in §5 — this build derives the
 * initial prompt via brandStyleLock(scene.description, brand), giving that
 * named skill a concrete call site; "redo" re-runs it.
 *
 * Async (video_broll/video_avatar are always async): process() calls
 * adapter.generate() (fast — returns a provider_job_id quickly), creates
 * the clip `assets` row + a `jobs` row already marked awaiting_provider,
 * and returns immediately — "enqueue all scene jobs (parallel)". Cost is
 * NOT logged here: generate() returning 'pending' doesn't yet know
 * success/failure, so costEngine.log() happens at completion time in
 * worker/reconcile.ts (poll) or app/api/webhooks/heygen/route.ts (webhook),
 * which read the billing context (units/unit_type/variant/call_type) back
 * out of `jobs.payload` — see those files' header notes for why (mirrors
 * the same contract-shape gap documented in the Veo/HeyGen adapters).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState, ReviewHooks, CostEstimate } from "../types";
import { nextStage } from "../types";
import { effectiveBrollModel } from "@/src/lib/routing";
import { getReelConfig, getScene, getScenesForReel } from "@/src/lib/rows";
import { getBrandContext, getProductsWithPhotos, guessMimeFromExt } from "@/src/lib/brandContext";
import { buildAssetRefFromAssetId, buildAssetRefFromStoragePath } from "@/src/lib/assetRefs";
import {
  assetHistory,
  getAsset,
  getCurrentPromptVersion,
  promptHistory,
  revertAssetVersion,
  revertPromptVersion,
  upsertPromptVersion,
} from "@/src/lib/versioning";
import { heygenCallbackUrl } from "@/src/adapters/config";
import { composeVeoVariant } from "@/src/adapters/video_broll/veo";
import type { AssetRow, AvatarRow, PromptRow, ReelConfigRow, SceneRow } from "@/src/lib/db/types";
import type { AssetRef, GenerateInput } from "@/src/adapters/types";
import type { Job } from "@/src/lib/jobs/queue";
import type { PromptKind, Provider } from "@/src/lib/db/enums";
import type { BrandContext } from "@/src/skills/types";

export const clipInputSchema = z.object({
  /** Omit to (re)generate every scene that doesn't already have a materialized clip. */
  scene_ids: z.array(z.string().uuid()).optional(),
});
export type ClipInput = z.infer<typeof clipInputSchema>;

export interface ClipSceneResult {
  scene_id: string;
  status: "already_generated" | "enqueued" | "blocked";
  reason?: string;
  job_id?: string;
  asset_id?: string;
}
interface ClipGenerationOutcome extends ClipSceneResult {
  job?: Job;
}

export interface ClipOutput {
  scenes: ClipSceneResult[];
}

async function load(ctx: StageContext): Promise<StageState> {
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  return { stage: "clip", data: { scenes } };
}

async function getMotionPrompt(
  ctx: StageContext,
  sceneId: string,
  kind: PromptKind
): Promise<{ promptId: string; promptVersionId: string; text: string } | null> {
  const { data, error } = await ctx.supa.from("prompts").select("*").eq("scene_id", sceneId).eq("kind", kind).maybeSingle();
  if (error) throw new Error(`prompts lookup failed: ${error.message}`);
  if (!data) return null;
  const promptRow = data as PromptRow;
  const current = await getCurrentPromptVersion(ctx.supa, promptRow.id);
  if (!current) return null;
  return { promptId: promptRow.id, promptVersionId: current.id, text: current.text };
}

async function ensureMotionPrompt(
  ctx: StageContext,
  scene: SceneRow,
  kind: PromptKind,
  brand: BrandContext
): Promise<{ promptId: string; promptVersionId: string; text: string }> {
  const existing = await getMotionPrompt(ctx, scene.id, kind);
  if (existing) return existing;

  const text = await ctx.skills.brandStyleLock(scene.description ?? "", brand);
  const { prompt, version } = await upsertPromptVersion(ctx.supa, {
    reel_id: ctx.reelId,
    scene_id: scene.id,
    kind,
    text,
    source: "skill",
  });
  return { promptId: prompt.id, promptVersionId: version.id, text: version.text };
}

async function enqueueClip(
  ctx: StageContext,
  scene: SceneRow,
  provider: string,
  jobType: "broll_gen" | "avatar_gen",
  generateInput: GenerateInput,
  callbackToken: string | null,
  callType: "generate" | "redo"
): Promise<ClipGenerationOutcome> {
  const category = jobType === "broll_gen" ? "video_broll" : "video_avatar";
  const adapter = ctx.adapters.get(category, provider);

  const validation = adapter.validate(generateInput);
  if (!validation.ok) {
    return { scene_id: scene.id, status: "blocked", reason: validation.violations.join("; ") };
  }

  const result = await adapter.generate(generateInput);
  if (result.status !== "pending" || !result.provider_job_id) {
    throw new Error(`${provider} generate() for scene ${scene.id} did not return a pending async job`);
  }

  const slot = jobType === "broll_gen" ? "broll_clip" : "avatar_clip";
  let assetId = scene.clip_asset_id;
  if (!assetId) {
    const { data, error } = await ctx.supa
      .from("assets")
      .insert({ reel_id: ctx.reelId, scene_id: scene.id, slot, media_type: "video" })
      .select("id")
      .single();
    if (error) throw new Error(`assets insert failed: ${error.message}`);
    assetId = (data as { id: string }).id;
    const { error: sceneError } = await ctx.supa.from("scenes").update({ clip_asset_id: assetId }).eq("id", scene.id);
    if (sceneError) throw new Error(`scenes update (clip_asset_id) failed: ${sceneError.message}`);
  }

  const job = await ctx.jobs.enqueue({
    reel_id: ctx.reelId,
    scene_id: scene.id,
    asset_id: assetId,
    type: jobType,
    provider: provider as Job["provider"],
    idempotency_key: generateInput.idempotency_key,
    callback_token: callbackToken,
    payload: {
      call_type: callType,
      provider,
      // Billing context needs the resolution-qualified form for Veo
      // (rate_card is seeded that way); result.variant/generateInput.variant
      // are the BARE form the adapter itself needs (model-id lookup) and
      // must never be composed there — see composeVeoVariant's doc comment.
      variant:
        provider === "veo" && generateInput.variant
          ? composeVeoVariant(generateInput.variant, generateInput.resolution)
          : (result.variant ?? generateInput.variant ?? null),
      units: result.units,
      unit_type: result.unit_type,
      aspect_ratio: generateInput.aspect_ratio,
      resolution: generateInput.resolution,
      duration_s: generateInput.duration_s ?? null,
      prompt_version_id: null as string | null,
    },
  });
  const awaiting = await ctx.jobs.markAwaitingProvider(job.id, result.provider_job_id);

  return { scene_id: scene.id, status: "enqueued", job_id: job.id, asset_id: assetId, job: awaiting };
}

async function generateClipForScene(
  ctx: StageContext,
  reelConfig: ReelConfigRow,
  scene: SceneRow,
  callType: "generate" | "redo" = "generate"
): Promise<ClipGenerationOutcome> {
  const brand = await getBrandContext(ctx.supa, ctx.clientId);

  if (scene.type === "broll") {
    const model = effectiveBrollModel(scene, reelConfig);
    if (!model) {
      return {
        scene_id: scene.id,
        status: "blocked",
        reason: "select a b-roll model (reel default or per-scene override) before generating this clip",
      };
    }
    if (!scene.start_image_id) {
      return { scene_id: scene.id, status: "blocked", reason: "start image not generated yet (Stage 4)" };
    }

    const adapter = ctx.adapters.get("video_broll", model);
    const caps = adapter.capabilities();
    const { text } = await ensureMotionPrompt(ctx, scene, "broll_motion", brand);

    const startImage = await buildAssetRefFromAssetId(ctx.supa, ctx.storage, scene.start_image_id);
    const endImage =
      caps.supports_end_frame && scene.end_image_id
        ? await buildAssetRefFromAssetId(ctx.supa, ctx.storage, scene.end_image_id)
        : undefined;

    const providerKey = await ctx.keys.forProvider(ctx.clientId, model as Provider);
    const generateInput: GenerateInput = {
      client_id: ctx.clientId,
      reel_id: ctx.reelId,
      scene_id: scene.id,
      prompt: text,
      start_image: startImage,
      end_image: endImage,
      aspect_ratio: reelConfig.aspect_ratio,
      resolution: reelConfig.resolution,
      duration_s: scene.seconds,
      variant: reelConfig.veo_variant,
      provider_key: providerKey,
      idempotency_key: randomUUID(),
    };

    return enqueueClip(ctx, scene, model, "broll_gen", generateInput, null, callType);
  }

  // avatar (silent) — spec §7 Stage 5, §14.3
  if (!reelConfig.avatar_look_id) {
    return { scene_id: scene.id, status: "blocked", reason: "no avatar look selected for this reel" };
  }

  const { data: avatarData, error: avatarError } = await ctx.supa
    .from("avatars")
    .select("*")
    .eq("id", reelConfig.avatar_look_id)
    .single();
  if (avatarError) throw new Error(`avatars lookup failed: ${avatarError.message}`);
  const avatar = avatarData as AvatarRow;

  const { text } = await ensureMotionPrompt(ctx, scene, "avatar_shot", brand);

  let references: AssetRef[] = [];
  if (scene.product_in_scene) {
    const products = await getProductsWithPhotos(ctx.supa, ctx.clientId);
    const photoPaths = products.flatMap((p) => p.photo_paths);
    references = await Promise.all(
      photoPaths.map((path) => buildAssetRefFromStoragePath(ctx.storage, "products", path, guessMimeFromExt(path)))
    );
  }

  const callbackToken = randomUUID();
  const providerKey = await ctx.keys.forProvider(ctx.clientId, "heygen");
  const generateInput: GenerateInput = {
    client_id: ctx.clientId,
    reel_id: ctx.reelId,
    scene_id: scene.id,
    prompt: text,
    avatar_ids: [avatar.heygen_look_id],
    references,
    aspect_ratio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    duration_s: scene.seconds,
    provider_key: providerKey,
    idempotency_key: randomUUID(),
    callback_url: heygenCallbackUrl(callbackToken),
  };

  return enqueueClip(ctx, scene, "heygen", "avatar_gen", generateInput, callbackToken, callType);
}

async function process(input: ClipInput, ctx: StageContext): Promise<ClipOutput> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const targetScenes = input.scene_ids ? scenes.filter((s) => input.scene_ids!.includes(s.id)) : scenes;

  const results = await Promise.all(
    targetScenes.map(async (scene): Promise<ClipSceneResult> => {
      try {
        if (scene.clip_asset_id) {
          const asset = await getAsset(ctx.supa, scene.clip_asset_id);
          if (asset.current_version_id) {
            return { scene_id: scene.id, status: "already_generated", asset_id: asset.id };
          }
        }
        const outcome = await generateClipForScene(ctx, reelConfig, scene);
        const { job: _job, ...rest } = outcome;
        return rest;
      } catch (err) {
        return { scene_id: scene.id, status: "blocked", reason: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  return { scenes: results };
}

async function estimate(input: ClipInput, ctx: StageContext): Promise<CostEstimate> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const targetScenes = input.scene_ids ? scenes.filter((s) => input.scene_ids!.includes(s.id)) : scenes;

  const calls: Parameters<StageContext["costEngine"]["estimate"]>[0] = [];
  for (const scene of targetScenes) {
    if (scene.type === "broll") {
      const model = effectiveBrollModel(scene, reelConfig);
      if (!model) continue;
      const adapter = ctx.adapters.tryGet("video_broll", model);
      if (!adapter) continue;
      const est = adapter.estimate({
        aspect_ratio: reelConfig.aspect_ratio,
        resolution: reelConfig.resolution,
        duration_s: scene.seconds,
        // Veo's rate_card is resolution-qualified (composeVeoVariant); other
        // b-roll providers (e.g. Higgsfield) don't use this scheme, so they
        // keep getting the bare reel default unchanged.
        variant: model === "veo" ? composeVeoVariant(reelConfig.veo_variant, reelConfig.resolution) : reelConfig.veo_variant,
      });
      calls.push({
        provider: model,
        category: "video_broll",
        unit_type: est.unit_type,
        variant: est.variant,
        units: est.units,
        client_id: ctx.clientId,
      });
    } else {
      const adapter = ctx.adapters.tryGet("video_avatar", "heygen");
      if (!adapter) continue;
      const est = adapter.estimate({
        aspect_ratio: reelConfig.aspect_ratio,
        resolution: reelConfig.resolution,
        duration_s: scene.seconds,
      });
      calls.push({
        provider: "heygen",
        category: "video_avatar",
        unit_type: est.unit_type,
        units: est.units,
        client_id: ctx.clientId,
      });
    }
  }

  return ctx.costEngine.estimate(calls);
}

async function advance(ctx: StageContext): Promise<import("@/src/lib/db/enums").StageId> {
  const next = nextStage("clip");
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const clipStage: StageModule<ClipInput, ClipOutput> = {
  id: "clip",
  inputSchema: clipInputSchema,
  load,
  process,
  estimate,
  advance,
};

/** ctx-bound review hooks (see src/stages/image/index.ts header note). */
export function createClipReviewHooks(ctx: StageContext): ReviewHooks {
  return {
    async redoPrompt(promptId) {
      const { data, error } = await ctx.supa.from("prompts").select("*").eq("id", promptId).single();
      if (error) throw new Error(`prompts lookup failed: ${error.message}`);
      const promptRow = data as PromptRow;
      if (!promptRow.scene_id) throw new Error(`prompt ${promptId} has no associated scene`);
      const scene = await getScene(ctx.supa, promptRow.scene_id);
      const brand = await getBrandContext(ctx.supa, ctx.clientId);
      const text = await ctx.skills.brandStyleLock(scene.description ?? "", brand);
      const { version } = await upsertPromptVersion(ctx.supa, {
        promptId,
        reel_id: promptRow.reel_id,
        scene_id: promptRow.scene_id,
        asset_id: promptRow.asset_id,
        kind: promptRow.kind,
        text,
        source: "skill",
      });
      return version;
    },

    async editPrompt(promptId, text, refs) {
      const { data, error } = await ctx.supa.from("prompts").select("*").eq("id", promptId).single();
      if (error) throw new Error(`prompts lookup failed: ${error.message}`);
      const promptRow = data as PromptRow;
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
      const outcome = await generateClipForScene(ctx, reelConfig, scene, "redo");
      if (outcome.status === "blocked") throw new Error(outcome.reason ?? "redo blocked");
      return { job: outcome.job };
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
