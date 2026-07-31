/**
 * Stage 5 — Clip generation (spec §7 Stage 5, §8 routing table). Copies
 * the src/stages/image reference pattern (two-granularity review) — see
 * that file's header note on why `review` isn't a static field.
 *
 * Routes by scene.type: b-roll -> getAdapter('video_broll', effectiveModel)
 * (start(+end only if supports_end_frame) -> clip); avatar (silent) ->
 * getAdapter('video_avatar','heygen') (prompt+look -> clip,
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
 * src/lib/jobs/reconcile.ts (poll) or app/api/webhooks/heygen/route.ts (webhook),
 * which read the billing context (units/unit_type/variant/call_type) back
 * out of `jobs.payload` — see those files' header notes for why (mirrors
 * the same contract-shape gap documented in the Veo/HeyGen adapters).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState, ReviewHooks, CostEstimate } from "../types";
import { nextStage } from "../types";
import { effectiveBrollModel, needsEndImage, supportsEndFrameLookupFor } from "@/src/lib/routing";
import { reelModelContext } from "@/src/lib/modelConstraints";
import { getReelConfig, getScene, getScenesForReel } from "@/src/lib/rows";
import { getBrandContext, guessMimeFromExt } from "@/src/lib/brandContext";
import { buildAssetRefFromAssetId, buildAssetRefFromStoragePath } from "@/src/lib/assetRefs";
import { productRefPaths } from "@/src/lib/productRefs";
import {
  assetHistory,
  getAsset,
  getCurrentPromptVersion,
  promptHistory,
  revertAssetVersion,
  revertPromptVersion,
  upsertPromptVersion,
} from "@/src/lib/versioning";
import { createUploadedAsset, uploadAssetVersion } from "@/src/lib/assetUpload";
import { heygenCallbackUrl } from "@/src/adapters/config";
import { composeVeoVariant } from "@/src/adapters/video_broll/veo";
import { promptStaleness, targetModelFor, type TargetModel } from "@/src/skills/model-prompt/guidance";
import type { AssetRow, AvatarRow, PromptRow, ReelConfigRow, SceneRow } from "@/src/lib/db/types";
import type { AssetRef, GenerateInput } from "@/src/adapters/types";
import { toPublicJob } from "@/src/lib/jobs/queue";
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
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);

  // Per scene: is the stored prompt still written for the model that will run
  // it? Advisory only — redoPrompt() is the "re-optimise" action, and doing
  // nothing is a valid choice, so nothing is rewritten here.
  const prompt_staleness = Object.fromEntries(
    await Promise.all(
      scenes.map(async (scene) => {
        const kind: PromptKind = scene.type === "broll" ? "broll_motion" : "avatar_shot";
        const stored = await getStoredTargetModel(ctx, scene.id, kind);
        return [scene.id, promptStaleness(stored, targetModelForScene(scene, reelConfig))] as const;
      })
    )
  );

  return { stage: "clip", data: { scenes, prompt_staleness } };
}

/** Reads back which model a scene's stored prompt was optimised for. */
async function getStoredTargetModel(ctx: StageContext, sceneId: string, kind: PromptKind): Promise<string | null> {
  const { data, error } = await ctx.supa.from("prompts").select("id").eq("scene_id", sceneId).eq("kind", kind).maybeSingle();
  if (error) throw new Error(`prompts lookup failed: ${error.message}`);
  if (!data) return null;
  const current = await getCurrentPromptVersion(ctx.supa, (data as { id: string }).id);
  const metadata = current?.metadata as { target_model?: string } | null | undefined;
  return metadata?.target_model ?? null;
}

async function getMotionPrompt(
  ctx: StageContext,
  sceneId: string,
  kind: PromptKind
): Promise<{ promptId: string; promptVersionId: string; text: string; reference_paths: string[] } | null> {
  const { data, error } = await ctx.supa.from("prompts").select("*").eq("scene_id", sceneId).eq("kind", kind).maybeSingle();
  if (error) throw new Error(`prompts lookup failed: ${error.message}`);
  if (!data) return null;
  const promptRow = data as PromptRow;
  const current = await getCurrentPromptVersion(ctx.supa, promptRow.id);
  if (!current) return null;
  return {
    promptId: promptRow.id,
    promptVersionId: current.id,
    text: current.text,
    reference_paths: current.reference_paths ?? [],
  };
}

/**
 * Resolves the model this scene's clip will actually be generated by, so the
 * prompt is written for that model. Must use the per-scene override, not the
 * reel default — a scene flipped to higgsfield needs higgsfield's prompt rules.
 */
function targetModelForScene(scene: SceneRow, reelConfig: ReelConfigRow): TargetModel | null {
  if (scene.type !== "broll") return targetModelFor("heygen");
  const model = effectiveBrollModel(scene, reelConfig);
  return model ? targetModelFor(model, reelConfig.veo_variant ?? undefined) : null;
}

/**
 * Whether this scene's clip call will actually carry a last frame — the same
 * capability-driven answer Stage 4 uses to decide whether to generate an end
 * image at all, so the prompt is written for the mode the clip really runs in
 * (interpolation vs start-frame-only) rather than for the user's stored intent.
 */
function sceneUsesEndFrame(ctx: StageContext, scene: SceneRow, reelConfig: ReelConfigRow): boolean {
  return needsEndImage(scene, reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));
}

async function ensureMotionPrompt(
  ctx: StageContext,
  scene: SceneRow,
  kind: PromptKind,
  brand: BrandContext,
  target: TargetModel | null,
  reelConfig: ReelConfigRow
): Promise<{ promptId: string; promptVersionId: string; text: string; reference_paths: string[] }> {
  const existing = await getMotionPrompt(ctx, scene.id, kind);
  if (existing) return existing;

  const text = await ctx.skills.brandStyleLock(
    scene.description ?? "",
    brand,
    undefined,
    target ?? undefined,
    // Resolved per scene, not per reel: whether this clip interpolates decides
    // both the length it renders at and whether the shot may describe a landing
    // composition at all.
    reelModelContext(reelConfig, { uses_end_frames: sceneUsesEndFrame(ctx, scene, reelConfig) })
  );
  const { prompt, version } = await upsertPromptVersion(ctx.supa, {
    reel_id: ctx.reelId,
    scene_id: scene.id,
    kind,
    text,
    source: "skill",
    // Stamps which model this text was optimised for; the review UI compares it
    // against the scene's current model and offers a re-run when they diverge.
    metadata: target ? { target_model: target.id, target_model_label: target.label } : null,
  });
  return { promptId: prompt.id, promptVersionId: version.id, text: version.text, reference_paths: [] };
}

/**
 * The reference images for one clip call: the prompt's own stage-level
 * uploads first, then the reel's product reference photos (unless this clip
 * opted out), trimmed to whatever the adapter's image-reference cap leaves
 * over after the start/end frames have taken their slots.
 */
async function buildClipReferences(
  ctx: StageContext,
  reelConfig: ReelConfigRow,
  promptId: string,
  stagePaths: string[],
  maxReferenceImages: number | undefined,
  framesUsed: number
): Promise<AssetRef[]> {
  const productPaths = await productRefPaths(ctx.supa, reelConfig, promptId);
  const paths = [...stagePaths, ...productPaths];
  const budget = maxReferenceImages == null ? paths.length : Math.max(0, maxReferenceImages - framesUsed);
  return Promise.all(
    paths
      .slice(0, budget)
      .map((path) => buildAssetRefFromStoragePath(ctx.storage, "assets", path, guessMimeFromExt(path)))
  );
}

/**
 * Creates (never overwrites) the motion/shot prompt for every scene without
 * generating anything — so the prompt is editable BEFORE the expensive clip
 * call, instead of only on a paid redo. generateClipForScene() reuses
 * whatever is here via the same ensureMotionPrompt().
 */
export async function ensureClipPrompts(ctx: StageContext): Promise<void> {
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const brand = await getBrandContext(ctx.supa, ctx.clientId);
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  for (const scene of scenes) {
    await ensureMotionPrompt(
      ctx,
      scene,
      scene.type === "broll" ? "broll_motion" : "avatar_shot",
      brand,
      targetModelForScene(scene, reelConfig),
      reelConfig
    );
  }
}

async function enqueueClip(
  ctx: StageContext,
  scene: SceneRow,
  provider: string,
  jobType: "broll_gen" | "avatar_gen",
  generateInput: GenerateInput,
  callbackToken: string | null,
  callType: "generate" | "redo",
  promptId: string
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

  // Link the prompt to the asset it's producing — without this, buildSlotDetail's
  // asset_id lookup (app/api/reels/[reelId]/clip/route.ts) never finds it, and the
  // motion/shot prompt never becomes editable in the UI (unlike src/stages/image,
  // which does this same link).
  const { error: promptLinkError } = await ctx.supa.from("prompts").update({ asset_id: assetId }).eq("id", promptId);
  if (promptLinkError) throw new Error(`prompts update (asset_id) failed: ${promptLinkError.message}`);

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
    const caps = adapter.capabilities(reelConfig.veo_variant);
    const { promptId, text, reference_paths } = await ensureMotionPrompt(
      ctx,
      scene,
      "broll_motion",
      brand,
      targetModelFor(model, reelConfig.veo_variant ?? undefined),
      reelConfig
    );

    const startImage = await buildAssetRefFromAssetId(ctx.supa, ctx.storage, scene.start_image_id);
    const endImage =
      caps.supports_end_frame && scene.end_image_id
        ? await buildAssetRefFromAssetId(ctx.supa, ctx.storage, scene.end_image_id)
        : undefined;

    const references = await buildClipReferences(
      ctx,
      reelConfig,
      promptId,
      reference_paths,
      caps.max_reference_images,
      1 + (endImage ? 1 : 0)
    );

    const providerKey = await ctx.keys.forProvider(ctx.clientId, model as Provider);
    const generateInput: GenerateInput = {
      client_id: ctx.clientId,
      reel_id: ctx.reelId,
      scene_id: scene.id,
      prompt: text,
      start_image: startImage,
      end_image: endImage,
      references: references.length > 0 ? references : undefined,
      aspect_ratio: reelConfig.aspect_ratio,
      resolution: reelConfig.resolution,
      duration_s: scene.seconds,
      // N6: veo_variant is a Veo-only concept ('standard'|'fast') — only
      // stamp it for this scene/job when veo is the effective provider,
      // matching how estimate() below already gates the same value.
      // Leaving it unset for e.g. higgsfield keeps enqueueClip's
      // payload.variant (the billing context) from falling back to this
      // Veo variant, per that function's own comment.
      variant: model === "veo" ? reelConfig.veo_variant : undefined,
      provider_key: providerKey,
      idempotency_key: randomUUID(),
    };

    return enqueueClip(ctx, scene, model, "broll_gen", generateInput, null, callType, promptId);
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

  const { promptId, text, reference_paths } = await ensureMotionPrompt(
    ctx,
    scene,
    "avatar_shot",
    brand,
    targetModelFor("heygen"),
    reelConfig
  );

  // avatar_ids take video slots, not image slots — the whole image budget is free.
  const references = await buildClipReferences(
    ctx,
    reelConfig,
    promptId,
    reference_paths,
    ctx.adapters.get("video_avatar", "heygen").capabilities().max_reference_images,
    0
  );

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

  return enqueueClip(ctx, scene, "heygen", "avatar_gen", generateInput, callbackToken, callType, promptId);
}

/** Google (Veo) rate-limits concurrent generate calls — dispatch in small batches instead of all at once. */
const CLIP_GENERATE_CONCURRENCY = 1;

async function process(input: ClipInput, ctx: StageContext): Promise<ClipOutput> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const targetScenes = input.scene_ids ? scenes.filter((s) => input.scene_ids!.includes(s.id)) : scenes;

  const results: ClipSceneResult[] = [];
  for (let i = 0; i < targetScenes.length; i += CLIP_GENERATE_CONCURRENCY) {
    const batch = targetScenes.slice(i, i + CLIP_GENERATE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (scene): Promise<ClipSceneResult> => {
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
    results.push(...batchResults);
  }

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
      // Reads the scene's CURRENT model, so a redo doubles as the
      // "re-optimise for the model I switched to" action the UI offers.
      const reelConfig = await getReelConfig(ctx.supa, promptRow.reel_id);
      const target = targetModelForScene(scene, reelConfig);
      const text = await ctx.skills.brandStyleLock(
        scene.description ?? "",
        brand,
        undefined,
        target ?? undefined,
        reelModelContext(reelConfig, { uses_end_frames: sceneUsesEndFrame(ctx, scene, reelConfig) })
      );
      const { version } = await upsertPromptVersion(ctx.supa, {
        promptId,
        reel_id: promptRow.reel_id,
        scene_id: promptRow.scene_id,
        asset_id: promptRow.asset_id,
        kind: promptRow.kind,
        text,
        source: "skill",
        metadata: target ? { target_model: target.id, target_model_label: target.label } : null,
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
      // Never pass through the raw job row (callback_token/payload) to a
      // route handler that JSON's this return value verbatim (BLOCK-2).
      return { job: outcome.job ? toPublicJob(outcome.job) : undefined };
    },

    async uploadAsset(assetId, storagePath) {
      return uploadAssetVersion(ctx, assetId, storagePath);
    },

    async uploadNewAsset({ sceneId }, storagePath) {
      if (!sceneId) throw new Error("sceneId is required to upload a clip for a new slot");
      const scene = await getScene(ctx.supa, sceneId);
      const { asset, version } = await createUploadedAsset(ctx, {
        slot: scene.type === "broll" ? "broll_clip" : "avatar_clip",
        mediaType: "video",
        storagePath,
        sceneId,
      });
      // Point the scene at it, so process() reports "already_generated" and
      // never generates over the upload.
      const { error } = await ctx.supa.from("scenes").update({ clip_asset_id: asset.id }).eq("id", sceneId);
      if (error) throw new Error(`scenes update (clip_asset_id) failed: ${error.message}`);
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
