/**
 * Stage 7 — End frame (branded outro) (spec §7 Stage 7, §8, R2 routing
 * rule). Copies the src/stages/image reference pattern — see that file's
 * header note on why `review` isn't a static field.
 *
 * Branded end-frame image: an `endframe_render` worker job (satori->resvg,
 * worker/endframe.ts) from logo + outro_tagline (client default, editable);
 * user may upload a custom one instead (`uploaded` version,
 * end_frame_mode='custom'); "return to default" re-renders.
 *
 * Outro clip routing (resolveOutroRoute, src/lib/routing.ts): if the
 * effective outro model exists and supports_end_frame, generate via that
 * model (start = last scene's end frame, or — if the last scene's OWN
 * effective model never produced one (e.g. it's avatar, or its own model
 * lacks end-frame support) — the worker extracts the clip's last frame via
 * ffmpeg; end = branded end-frame image). Else a deterministic
 * crossfade-to-endframe (no provider call, cost $0). Both routes are
 * dispatched as an `outro_gen` job (worker/index.ts branches on
 * payload.route) since either can involve ffmpeg work that shouldn't block
 * an HTTP request.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState, ReviewHooks, CostEstimate } from "../types";
import { nextStage } from "../types";
import { resolveOutroRoute, supportsEndFrameLookupFor, type OutroRoute } from "@/src/lib/routing";
import { getClientConfigRow, getReelConfig, getScenesForReel } from "@/src/lib/rows";
import { getBrandContext } from "@/src/lib/brandContext";
import { assetHistory, getAsset, promptHistory, revertAssetVersion, revertPromptVersion, upsertAssetVersion, upsertPromptVersion } from "@/src/lib/versioning";
import { uploadAssetVersion } from "@/src/lib/assetUpload";
import { composeVeoVariant } from "@/src/adapters/video_broll/veo";
import type { AdapterRegistry } from "@/src/adapters/registry";
import { toPublicJob } from "@/src/lib/jobs/queue";
import type { Job } from "@/src/lib/jobs/queue";
import type { Provider, StageId } from "@/src/lib/db/enums";
import type { ReelConfigRow, SceneRow } from "@/src/lib/db/types";

export const outroInputSchema = z.object({
  outro_tagline: z.string().optional(),
  /** Already-uploaded (Storage) path for a user-supplied custom end frame. */
  custom_end_frame_storage_path: z.string().optional(),
  return_to_default: z.boolean().optional(),
});
export type OutroInput = z.infer<typeof outroInputSchema>;

export interface OutroOutput {
  end_frame_asset_id: string;
  end_frame_job?: Job;
  outro_clip_asset_id: string;
  outro_clip_job: Job;
  route: OutroRoute;
}

async function load(ctx: StageContext): Promise<StageState> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  return { stage: "outro", data: { reelConfig } };
}

async function ensureEndFrameAsset(ctx: StageContext, existingId: string | null | undefined): Promise<string> {
  if (existingId) return existingId;
  const { data, error } = await ctx.supa
    .from("assets")
    .insert({ reel_id: ctx.reelId, slot: "end_frame_image", media_type: "image" })
    .select("id")
    .single();
  if (error) throw new Error(`assets insert (end_frame_image) failed: ${error.message}`);
  const assetId = (data as { id: string }).id;
  await ctx.supa.from("reel_config").update({ end_frame_asset_id: assetId }).eq("reel_id", ctx.reelId);
  return assetId;
}

async function enqueueEndFrameRender(ctx: StageContext, assetId: string, tagline: string | null): Promise<Job> {
  return ctx.jobs.enqueue({
    reel_id: ctx.reelId,
    asset_id: assetId,
    type: "endframe_render",
    payload: { tagline },
  });
}

/**
 * Creates (never overwrites) the outro motion prompt, without generating
 * anything — so it's editable BEFORE the expensive outro-clip call, instead
 * of only on a paid redo. enqueueOutroClip() reuses whatever is here.
 */
export async function ensureOutroPrompt(ctx: StageContext): Promise<{ promptId: string; versionId: string }> {
  const { data, error } = await ctx.supa
    .from("prompts")
    .select("id, current_version_id")
    .eq("reel_id", ctx.reelId)
    .eq("kind", "outro_motion")
    .maybeSingle();
  if (error) throw new Error(`prompts lookup failed: ${error.message}`);
  const existing = data as { id: string; current_version_id: string | null } | null;
  if (existing?.current_version_id) return { promptId: existing.id, versionId: existing.current_version_id };

  const brand = await getBrandContext(ctx.supa, ctx.clientId);
  const text = await ctx.skills.brandStyleLock(
    "Smooth, elegant motion transitioning the last shot into a clean branded end card.",
    brand
  );
  const { prompt, version } = await upsertPromptVersion(ctx.supa, {
    promptId: existing?.id,
    reel_id: ctx.reelId,
    kind: "outro_motion",
    text,
    source: "skill",
  });
  return { promptId: prompt.id, versionId: version.id };
}

async function ensureOutroClipAsset(ctx: StageContext): Promise<string> {
  const { data: existing, error } = await ctx.supa
    .from("assets")
    .select("id")
    .eq("reel_id", ctx.reelId)
    .eq("slot", "outro_clip")
    .maybeSingle();
  if (error) throw new Error(`assets lookup (outro_clip) failed: ${error.message}`);
  if (existing) return (existing as { id: string }).id;

  const { data, error: insertError } = await ctx.supa
    .from("assets")
    .insert({ reel_id: ctx.reelId, slot: "outro_clip", media_type: "video" })
    .select("id")
    .single();
  if (insertError) throw new Error(`assets insert (outro_clip) failed: ${insertError.message}`);
  return (data as { id: string }).id;
}

async function enqueueOutroClip(
  ctx: StageContext,
  reelConfig: ReelConfigRow,
  lastScene: SceneRow,
  endFrameAssetId: string,
  route: OutroRoute,
  callType: "generate" | "redo" = "generate"
): Promise<{ assetId: string; job: Job }> {
  const assetId = await ensureOutroClipAsset(ctx);

  let promptVersionId: string | null = null;
  if (route.kind === "model") {
    // Reuses an already-prepared/edited prompt rather than re-running the
    // skill over it, so a pre-generation edit actually reaches the provider.
    promptVersionId = (await ensureOutroPrompt(ctx)).versionId;
  }

  const job = await ctx.jobs.enqueue({
    reel_id: ctx.reelId,
    scene_id: lastScene.id,
    asset_id: assetId,
    type: "outro_gen",
    provider: route.kind === "model" ? (route.provider as Provider) : null,
    // N2: without this, worker/reconcile.ts's double-charge guard
    // (cost_log's partial UNIQUE(reel_id, provider, idempotency_key)) is
    // inert for outro-via-Veo generations — mirrors src/stages/clip/index.ts's
    // b-roll enqueue (generateInput.idempotency_key).
    idempotency_key: randomUUID(),
    payload: {
      call_type: callType,
      route: route.kind,
      provider: route.kind === "model" ? route.provider : null,
      outro_seconds: reelConfig.outro_seconds,
      aspect_ratio: reelConfig.aspect_ratio,
      resolution: reelConfig.resolution,
      variant: reelConfig.veo_variant,
      end_frame_asset_id: endFrameAssetId,
      prompt_version_id: promptVersionId,
      // Preferred start reference: the last scene's own end frame if Stage 4
      // produced one; else the worker extracts the last frame of its clip
      // via ffmpeg (covers both avatar-last and broll-last-without-end-image).
      last_scene_end_image_id: lastScene.end_image_id,
      last_scene_clip_asset_id: lastScene.clip_asset_id,
    },
  });

  return { assetId, job };
}

async function process(input: OutroInput, ctx: StageContext): Promise<OutroOutput> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const lastScene = scenes[scenes.length - 1];
  if (!lastScene) throw new Error("reel has no scenes yet — run Stage 3 first");

  let endFrameAssetId = reelConfig.end_frame_asset_id ?? null;
  let endFrameJob: Job | undefined;

  if (input.custom_end_frame_storage_path) {
    endFrameAssetId = await ensureEndFrameAsset(ctx, endFrameAssetId);
    await upsertAssetVersion(ctx.supa, {
      assetId: endFrameAssetId,
      reel_id: ctx.reelId,
      slot: "end_frame_image",
      media_type: "image",
      storage_path: input.custom_end_frame_storage_path,
      source: "uploaded",
    });
    await ctx.supa
      .from("reel_config")
      .update({ end_frame_asset_id: endFrameAssetId, end_frame_mode: "custom" })
      .eq("reel_id", ctx.reelId);
  } else if (input.return_to_default || !endFrameAssetId || input.outro_tagline) {
    endFrameAssetId = await ensureEndFrameAsset(ctx, endFrameAssetId);
    const clientConfig = await getClientConfigRow(ctx.supa, ctx.clientId);
    const tagline = input.outro_tagline ?? reelConfig.outro_tagline ?? clientConfig?.default_tagline ?? null;
    endFrameJob = await enqueueEndFrameRender(ctx, endFrameAssetId, tagline);
    await ctx.supa
      .from("reel_config")
      .update({ end_frame_mode: "default", outro_tagline: tagline })
      .eq("reel_id", ctx.reelId);
  }

  const route = resolveOutroRoute(reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));
  const { assetId: outroClipAssetId, job: outroClipJob } = await enqueueOutroClip(
    ctx,
    reelConfig,
    lastScene,
    endFrameAssetId!,
    route
  );

  return {
    end_frame_asset_id: endFrameAssetId!,
    end_frame_job: endFrameJob,
    outro_clip_asset_id: outroClipAssetId,
    outro_clip_job: outroClipJob,
    route,
  };
}

async function estimate(_input: OutroInput, ctx: StageContext): Promise<CostEstimate> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const route = resolveOutroRoute(reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));
  if (route.kind === "crossfade") {
    return { total_usd: 0, rate_missing: false, lines: [] };
  }
  const adapter = ctx.adapters.get("video_broll", route.provider);
  const est = adapter.estimate({
    aspect_ratio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    duration_s: reelConfig.outro_seconds,
    // Veo's rate_card is resolution-qualified (composeVeoVariant); other
    // b-roll providers (e.g. Higgsfield) don't use this scheme, so they keep
    // getting the bare reel default unchanged.
    variant: route.provider === "veo" ? composeVeoVariant(reelConfig.veo_variant, reelConfig.resolution) : reelConfig.veo_variant,
  });
  return ctx.costEngine.estimate([
    {
      provider: route.provider,
      category: "video_broll",
      unit_type: est.unit_type,
      variant: est.variant,
      units: est.units,
      client_id: ctx.clientId,
    },
  ]);
}

async function advance(ctx: StageContext): Promise<StageId> {
  const next = nextStage("outro");
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const outroStage: StageModule<OutroInput, OutroOutput> = {
  id: "outro",
  inputSchema: outroInputSchema,
  load,
  process,
  estimate,
  advance,
};

/** ctx-bound review hooks (see src/stages/image/index.ts header note). */
export function createOutroReviewHooks(ctx: StageContext): ReviewHooks {
  return {
    async redoPrompt(promptId) {
      const { data, error } = await ctx.supa.from("prompts").select("*").eq("id", promptId).single();
      if (error) throw new Error(`prompts lookup failed: ${error.message}`);
      const promptRow = data as { id: string; reel_id: string; scene_id: string | null; asset_id: string | null; kind: string };
      const brand = await getBrandContext(ctx.supa, ctx.clientId);
      const text = await ctx.skills.brandStyleLock(
        "Smooth, elegant motion transitioning the last shot into a clean branded end card.",
        brand
      );
      const { version } = await upsertPromptVersion(ctx.supa, {
        promptId,
        reel_id: promptRow.reel_id,
        scene_id: promptRow.scene_id,
        asset_id: promptRow.asset_id,
        kind: promptRow.kind as "outro_motion",
        text,
        source: "skill",
      });
      return version;
    },

    async editPrompt(promptId, text, refs) {
      const { data, error } = await ctx.supa.from("prompts").select("*").eq("id", promptId).single();
      if (error) throw new Error(`prompts lookup failed: ${error.message}`);
      const promptRow = data as { id: string; reel_id: string; scene_id: string | null; asset_id: string | null; kind: string };
      const { version } = await upsertPromptVersion(ctx.supa, {
        promptId,
        reel_id: promptRow.reel_id,
        scene_id: promptRow.scene_id,
        asset_id: promptRow.asset_id,
        kind: promptRow.kind as "outro_motion",
        text,
        reference_paths: refs ?? null,
        source: "manual",
      });
      return version;
    },

    async redoAsset(assetId) {
      const asset = await getAsset(ctx.supa, assetId);
      const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);

      if (asset.slot === "end_frame_image") {
        const clientConfig = await getClientConfigRow(ctx.supa, ctx.clientId);
        const tagline = reelConfig.outro_tagline ?? clientConfig?.default_tagline ?? null;
        const job = await enqueueEndFrameRender(ctx, assetId, tagline);
        // Never pass through the raw job row (callback_token/payload) to a
        // route handler that JSON's this return value verbatim (BLOCK-2).
        return { job: toPublicJob(job) };
      }

      // outro_clip
      const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
      const lastScene = scenes[scenes.length - 1];
      if (!lastScene) throw new Error("reel has no scenes");
      const route = resolveOutroRoute(reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));
      const { job } = await enqueueOutroClip(
        ctx,
        reelConfig,
        lastScene,
        reelConfig.end_frame_asset_id ?? assetId,
        route,
        "redo"
      );
      return { job: toPublicJob(job) };
    },

    async uploadAsset(assetId, storagePath) {
      return uploadAssetVersion(ctx, assetId, storagePath);
    },

    async uploadNewAsset(_target, storagePath) {
      // The outro clip is a single per-reel slot — no locator needed.
      return uploadAssetVersion(ctx, await ensureOutroClipAsset(ctx), storagePath);
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
