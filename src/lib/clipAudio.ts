/**
 * Cross-stage clip-audio state + review hooks. Sits in src/lib for the same
 * reason ./assetUpload.ts does: it is one behaviour that three stages (Clip,
 * Trim, Music) all present, so it lives once here rather than being copied
 * into three stage modules and drifting.
 *
 * That shared ownership is also what keeps requirement "the on/off choice
 * stays synced across all three stages" true by construction: there is a
 * single row (`assets.audio_enabled` on the clip's `clip_audio` slot) and a
 * single endpoint, so the three pages cannot hold three different answers —
 * there is no per-stage copy of the flag to fall out of step.
 *
 * The outro clip is included (it is model-generated video like any other
 * clip); it is the reel-level `clip_audio` row, the one with scene_id null.
 */
import type { StageContext, ReviewHooks } from "@/src/stages/types";
import type { AssetRow, AssetVersion, ReelConfigRow, SceneRow } from "@/src/lib/db/types";
import { getReelConfig, getScenesForReel } from "@/src/lib/rows";
import { effectiveBrollModel, resolveOutroRoute, supportsEndFrameLookupFor } from "@/src/lib/routing";
import { assetHistory, getAsset, revertAssetVersion, upsertAssetVersion } from "@/src/lib/versioning";
import { uploadAssetVersion } from "@/src/lib/assetUpload";
import type { ServiceClient } from "@/src/lib/supabase/service";

/**
 * Loaded on demand: src/lib/jobs/clipAudio.ts pulls in ffmpeg-static, and this
 * module is imported by stage GETs that mostly never need to demux anything.
 */
async function loadExtractor() {
  return (await import("@/src/lib/jobs/clipAudio")).ensureClipAudio;
}

/** The `clip_audio` slot belonging to one clip. `sceneId` is null for the reel's outro clip. */
export async function getClipAudioAsset(
  supa: ServiceClient,
  reelId: string,
  sceneId: string | null
): Promise<AssetRow | null> {
  const query = supa.from("assets").select("*").eq("reel_id", reelId).eq("slot", "clip_audio");
  const { data, error } = await (sceneId ? query.eq("scene_id", sceneId) : query.is("scene_id", null)).maybeSingle();
  if (error) throw new Error(`assets lookup (clip_audio) failed: ${error.message}`);
  return (data as AssetRow | null) ?? null;
}

/** The reel-level `clip_audio` row (scene_id null) belongs to the outro clip. */
export const OUTRO_KEY = "outro";

export interface ClipAudioVersionSummary {
  id: string;
  version_no: number;
  created_at: string;
  source: string;
}

export interface ClipAudioDetail {
  /** Scene id, or OUTRO_KEY — the stable handle the three pages key their rows off. */
  key: string;
  scene_id: string | null;
  label: string;
  position: number;
  clip_asset_id: string;
  /** The picture's current length, so the audio trim range can be bounded the same way. */
  clip_duration_s: number | null;
  /** True when this clip's model produces audio at all — false for e.g. Higgsfield/HeyGen. */
  emits_audio: boolean;
  /** null until a track exists (nothing extracted yet, or the model emits none). */
  asset_id: string | null;
  enabled: boolean;
  current_version_id: string | null;
  current_version_no: number;
  /** The track's own length, which may differ from the clip's once trimmed independently. */
  duration_s: number | null;
  source: string | null;
  preview_url: string | null;
  history: ClipAudioVersionSummary[];
}

interface ClipAudioTarget {
  key: string;
  scene_id: string | null;
  label: string;
  position: number;
  clip_asset_id: string;
  emits_audio: boolean;
}

/** Does the model that renders this clip emit a native audio track? capabilities() is the only source of truth (invariant 5). */
function sceneEmitsAudio(ctx: StageContext, scene: SceneRow, reelConfig: ReelConfigRow): boolean {
  if (scene.type !== "broll") {
    return ctx.adapters.tryGet("video_avatar", "heygen")?.capabilities().emits_audio ?? false;
  }
  const model = effectiveBrollModel(scene, reelConfig);
  if (!model) return false;
  return ctx.adapters.tryGet("video_broll", model)?.capabilities(reelConfig.veo_variant).emits_audio ?? false;
}

/** The crossfade outro is rendered locally by ffmpeg and is silent; the model route emits whatever that model does. */
function outroEmitsAudio(ctx: StageContext, reelConfig: ReelConfigRow): boolean {
  const route = resolveOutroRoute(reelConfig, supportsEndFrameLookupFor(ctx.adapters, reelConfig.veo_variant));
  if (route.kind !== "model") return false;
  return ctx.adapters.tryGet("video_broll", route.provider)?.capabilities(reelConfig.veo_variant).emits_audio ?? false;
}

/** Every clip in the reel that could carry audio — scenes in order, then the outro. */
async function listClipAudioTargets(ctx: StageContext): Promise<ClipAudioTarget[]> {
  const [reelConfig, scenes] = await Promise.all([getReelConfig(ctx.supa, ctx.reelId), getScenesForReel(ctx.supa, ctx.reelId)]);

  const targets: ClipAudioTarget[] = [];
  for (const scene of scenes) {
    if (!scene.clip_asset_id) continue;
    targets.push({
      key: scene.id,
      scene_id: scene.id,
      label: `Scene ${scene.position + 1}: ${scene.description ?? "(no description)"}`,
      position: scene.position,
      clip_asset_id: scene.clip_asset_id,
      emits_audio: sceneEmitsAudio(ctx, scene, reelConfig),
    });
  }

  const { data: outroAsset, error } = await ctx.supa
    .from("assets")
    .select("id")
    .eq("reel_id", ctx.reelId)
    .eq("slot", "outro_clip")
    .maybeSingle();
  if (error) throw new Error(`assets lookup (outro_clip) failed: ${error.message}`);
  if (outroAsset) {
    targets.push({
      key: OUTRO_KEY,
      scene_id: null,
      label: "Outro",
      position: scenes.length,
      clip_asset_id: (outroAsset as { id: string }).id,
      emits_audio: outroEmitsAudio(ctx, reelConfig),
    });
  }

  return targets;
}

async function currentVersionDurationS(ctx: StageContext, assetId: string): Promise<number | null> {
  const asset = await getAsset(ctx.supa, assetId);
  if (!asset.current_version_id) return null;
  const { data, error } = await ctx.supa
    .from("asset_versions")
    .select("metadata")
    .eq("id", asset.current_version_id)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
  return (data as { metadata: { duration_s?: number } | null }).metadata?.duration_s ?? null;
}

async function buildDetail(ctx: StageContext, target: ClipAudioTarget, audioAsset: AssetRow | null): Promise<ClipAudioDetail> {
  const clipDurationS = await currentVersionDurationS(ctx, target.clip_asset_id);

  if (!audioAsset) {
    return {
      ...target,
      clip_duration_s: clipDurationS,
      asset_id: null,
      enabled: true,
      current_version_id: null,
      current_version_no: 0,
      duration_s: null,
      source: null,
      preview_url: null,
      history: [],
    };
  }

  const versions = await assetHistory(ctx.supa, audioAsset.id);
  const current = versions.find((v) => v.id === audioAsset.current_version_id) ?? null;
  const preview_url = current?.storage_path ? await ctx.storage.signedUrl("assets", current.storage_path) : null;

  return {
    ...target,
    clip_duration_s: clipDurationS,
    asset_id: audioAsset.id,
    enabled: audioAsset.audio_enabled,
    current_version_id: audioAsset.current_version_id,
    current_version_no: current?.version_no ?? 0,
    duration_s: current?.metadata?.duration_s ?? null,
    source: current?.source ?? null,
    preview_url,
    history: versions.map((v) => ({ id: v.id, version_no: v.version_no, created_at: v.created_at, source: v.source })),
  };
}

/**
 * Per-clip audio for the whole reel — the single payload all three stage
 * pages render from.
 *
 * Also backfills: a clip whose model emits audio but has no track yet gets one
 * demuxed here. That covers clips generated before this feature existed and
 * retries an extraction that failed during reconcile. Gated on the model's
 * `emits_audio` so a silent-model reel never pays for a pointless download +
 * ffmpeg probe on every page load. Best-effort — a failure degrades to "no
 * track yet", it never fails the read.
 */
export async function loadClipAudioState(ctx: StageContext): Promise<ClipAudioDetail[]> {
  const targets = await listClipAudioTargets(ctx);

  const details: ClipAudioDetail[] = [];
  for (const target of targets) {
    let audioAsset = await getClipAudioAsset(ctx.supa, ctx.reelId, target.scene_id);
    if (!audioAsset && target.emits_audio) {
      try {
        const ensureClipAudio = await loadExtractor();
        await ensureClipAudio(ctx.supa, ctx.storage, target.clip_asset_id);
        audioAsset = await getClipAudioAsset(ctx.supa, ctx.reelId, target.scene_id);
      } catch (err) {
        console.error(`[clip-audio] extraction failed for clip ${target.clip_asset_id}:`, err);
      }
    }
    details.push(await buildDetail(ctx, target, audioAsset));
  }

  return details;
}

/** The on/off choice itself — one row, so every stage that reads it agrees. */
export async function setClipAudioEnabled(ctx: StageContext, assetId: string, enabled: boolean): Promise<void> {
  const asset = await getAsset(ctx.supa, assetId);
  if (asset.slot !== "clip_audio") throw new Error(`asset ${assetId} is not a clip_audio asset`);
  const { error } = await ctx.supa.from("assets").update({ audio_enabled: enabled }).eq("id", assetId);
  if (error) throw new Error(`assets update (audio_enabled) failed: ${error.message}`);
}

/**
 * Locates one clip by the same `key` the pages use (a scene id, or OUTRO_KEY),
 * so a caller can address a clip's audio slot without re-deriving how clips
 * are enumerated. Used by the Music stage to generate a track clip-wise.
 */
export async function resolveClipAudioTarget(
  ctx: StageContext,
  key: string
): Promise<{ scene_id: string | null; clip_asset_id: string; clip_duration_s: number | null }> {
  const target = (await listClipAudioTargets(ctx)).find((t) => t.key === key);
  if (!target) throw new Error(`no clip found for "${key}" — generate its clip first`);
  return {
    scene_id: target.scene_id,
    clip_asset_id: target.clip_asset_id,
    clip_duration_s: await currentVersionDurationS(ctx, target.clip_asset_id),
  };
}

/** The clip a track was demuxed from, so "Redo" knows what to re-extract. */
async function sourceClipAssetIdFor(ctx: StageContext, audioAsset: AssetRow): Promise<string | null> {
  const versions = await assetHistory(ctx.supa, audioAsset.id);
  const stamped = versions.find((v) => v.metadata?.source_clip_asset_id);
  if (stamped) return stamped.metadata!.source_clip_asset_id!;
  // Uploaded-only track (never extracted): fall back to the clip that owns this slot.
  const targets = await listClipAudioTargets(ctx);
  return targets.find((t) => t.scene_id === audioAsset.scene_id)?.clip_asset_id ?? null;
}

/**
 * ctx-bound review hooks for clip audio — the same ReviewHooks contract the
 * image/clip/outro stages use, so the existing AssetReview component drives
 * upload / download / history / revert here with no audio-specific UI
 * (requirement: "same option set as how other assets are already handled").
 * Prompts are not part of this slot; those hooks throw rather than no-op,
 * matching src/stages/trim's precedent.
 */
export function createClipAudioReviewHooks(ctx: StageContext): ReviewHooks {
  return {
    async redoPrompt() {
      throw new Error("clip audio has no prompts to redo");
    },
    async editPrompt() {
      throw new Error("clip audio has no prompts to edit");
    },
    async revertPrompt() {
      throw new Error("clip audio has no prompts to revert");
    },

    /**
     * Restores the model's own audio for the clip's current take. Free — a
     * local demux, no provider call. When the track was already extracted
     * (the usual case, and why ensureClipAudio no-ops) this re-points the
     * slot at it, which is what "undo my upload, give me the model's audio
     * back" has to mean.
     */
    async redoAsset(assetId) {
      const audioAsset = await getAsset(ctx.supa, assetId);
      const clipAssetId = await sourceClipAssetIdFor(ctx, audioAsset);
      if (!clipAssetId) throw new Error(`no source clip found for audio asset ${assetId}`);

      const ensureClipAudio = await loadExtractor();
      const version = await ensureClipAudio(ctx.supa, ctx.storage, clipAssetId);
      if (!version) throw new Error("this clip's model produced no audio to restore");
      if (version.id !== audioAsset.current_version_id) {
        await revertAssetVersion(ctx.supa, assetId, version.version_no);
      }
      return { version };
    },

    async uploadAsset(assetId, storagePath) {
      return uploadAssetVersion(ctx, assetId, storagePath);
    },

    /**
     * Custom audio for a clip that has no track yet — a silent-model clip, or
     * one whose extraction produced nothing. `sceneId` omitted targets the
     * reel-level (outro) slot; unambiguous here because this hooks factory
     * only ever addresses clip audio.
     */
    async uploadNewAsset({ sceneId }, storagePath) {
      const existing = await getClipAudioAsset(ctx.supa, ctx.reelId, sceneId ?? null);
      const { version } = await upsertAssetVersion(ctx.supa, {
        assetId: existing?.id,
        reel_id: ctx.reelId,
        scene_id: sceneId ?? null,
        slot: "clip_audio",
        media_type: "audio",
        storage_path: storagePath,
        source: "uploaded",
      });
      return version;
    },

    async revertAsset(assetId, versionNo) {
      await revertAssetVersion(ctx.supa, assetId, versionNo);
    },

    async setAudioEnabled(assetId, enabled) {
      await setClipAudioEnabled(ctx, assetId, enabled);
    },

    async download(assetVersionId) {
      const { data, error } = await ctx.supa
        .from("asset_versions")
        .select("storage_path")
        .eq("id", assetVersionId)
        .single();
      if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
      const path = (data as { storage_path: string | null }).storage_path;
      if (!path) throw new Error(`asset_version ${assetVersionId} has no storage_path`);
      return ctx.storage.signedUrl("assets", path);
    },

    async history({ assetId }) {
      if (!assetId) return [];
      return assetHistory(ctx.supa, assetId);
    },
  };
}

/**
 * The audio each clip contributes to the final render — scene_id (or
 * OUTRO_KEY) -> storage_path, already filtered by the user's on/off choice.
 * Stage 9's single read point for requirement "the user decides whether to
 * use it".
 */
export async function enabledClipAudioPaths(ctx: StageContext): Promise<Record<string, string>> {
  const { data, error } = await ctx.supa
    .from("assets")
    .select("id, scene_id, current_version_id, audio_enabled")
    .eq("reel_id", ctx.reelId)
    .eq("slot", "clip_audio");
  if (error) throw new Error(`assets lookup (clip_audio) failed: ${error.message}`);

  const rows = (data ?? []) as Array<Pick<AssetRow, "id" | "scene_id" | "current_version_id" | "audio_enabled">>;
  const paths: Record<string, string> = {};

  for (const row of rows) {
    if (!row.audio_enabled || !row.current_version_id) continue;
    const { data: versionRow, error: versionError } = await ctx.supa
      .from("asset_versions")
      .select("storage_path")
      .eq("id", row.current_version_id)
      .single();
    if (versionError) throw new Error(`asset_versions lookup failed: ${versionError.message}`);
    const storagePath = (versionRow as Pick<AssetVersion, "storage_path">).storage_path;
    if (storagePath) paths[row.scene_id ?? OUTRO_KEY] = storagePath;
  }

  return paths;
}
