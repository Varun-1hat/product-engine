/**
 * Stage 8 — Music (spec §7 Stage 8, brief §11). A track can be generated
 * from an editable prompt (generate() below, ElevenLabs or Lyria) or simply
 * uploaded as an override — either way it lands in the music/ bucket ->
 * reel_config.music_path + music_trim, applied at assembly (Stage 9):
 * trim + fade to length; loop if shorter (brief §10.20).
 *
 * Two lengths, one call: generate() with no `target_clip` produces that
 * reel-length background bed; with one it produces a track for a single clip,
 * which becomes a version of that clip's `clip_audio` slot (src/lib/clipAudio.ts)
 * rather than touching the bed. The bed and the clips' own audio play together
 * in the final mix, so this stage is where a reel's whole soundtrack is
 * assembled — background underneath, per-clip audio on top.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState } from "../types";
import { nextStage } from "../types";
import type { AssetRow, AssetVersion, ReelConfigRow } from "@/src/lib/db/types";
import { PROVIDERS, type Provider, type StageId } from "@/src/lib/db/enums";
import { assetHistory, revertAssetVersion, upsertAssetVersion } from "@/src/lib/versioning";
import { getBrandContext } from "@/src/lib/brandContext";
import { getScenesForReel } from "@/src/lib/rows";
import { promptStaleness, targetModelFor } from "@/src/skills/model-prompt/guidance";
import { reelModelContext } from "@/src/lib/modelConstraints";
import { OUTRO_KEY, getClipAudioAsset, resolveClipAudioTarget } from "@/src/lib/clipAudio";

export const musicInputSchema = z.object({
  /** Already-uploaded (music/ bucket) path for the new/replacement track — omit to only change the trim. */
  music_storage_path: z.string().optional(),
  music_trim: z
    .object({
      start_s: z.number().nonnegative(),
      end_s: z.number().positive(),
    })
    .optional(),
  /** Editable generation prompt — saved without generating, so it can be reviewed first. */
  music_prompt: z.string().optional(),
  music_provider: z.enum(PROVIDERS).optional(),
  /** How `music_storage_path` was produced — versions are labelled with it in the history list. */
  music_source: z.enum(["generated", "uploaded"]).optional(),
});
export type MusicInput = z.infer<typeof musicInputSchema>;

export const musicGenerateInputSchema = z.object({
  /** Overrides (and saves) reel_config.music_prompt when present. */
  prompt: z.string().min(1).optional(),
  provider: z.enum(PROVIDERS).optional(),
  duration_s: z.number().positive().optional(),
  /**
   * Omit to generate the reel-length background track (the original
   * behaviour). A scene id — or "outro" — instead generates for that one clip,
   * landing as a new version of its `clip_audio` slot alongside the model's
   * own take and any upload, so all three are revertable from one history.
   */
  target_clip: z.union([z.string().uuid(), z.literal(OUTRO_KEY)]).optional(),
});
export type MusicGenerateInput = z.infer<typeof musicGenerateInputSchema>;

const DEFAULT_MUSIC_PROVIDER: Provider = "elevenlabs";

/**
 * Writes the music prompt from the reel brief, optimised for the selected music
 * model — the first draft only. It never overwrites an existing prompt, so a
 * hand-edited one survives; `force` is how the UI's "re-optimise for <model>"
 * action asks for a rewrite after the provider changed.
 *
 * Kept separate from generate() so the prompt is reviewable BEFORE the paid
 * call, matching how ensureClipPrompts/ensureImagePrompts work.
 */
export async function ensureMusicPrompt(
  ctx: StageContext,
  opts: { force?: boolean } = {}
): Promise<ReelConfigRow> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  const reelConfig = data as ReelConfigRow;

  if (!opts.force && reelConfig.music_prompt?.trim()) return reelConfig;

  const provider = reelConfig.music_provider ?? DEFAULT_MUSIC_PROVIDER;
  const target = targetModelFor(provider);
  const brand = await getBrandContext(ctx.supa, ctx.clientId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);

  const { prompt } = await ctx.skills.musicPrompt(
    {
      topic: reelConfig.topic,
      topic_description: reelConfig.topic_description,
      total_seconds_target: Number(reelConfig.total_seconds_target),
      scene_count: scenes.length,
      brand,
    },
    target ?? undefined,
    reelModelContext(reelConfig)
  );

  const { data: updated, error: updateError } = await ctx.supa
    .from("reel_config")
    .update({ music_prompt: prompt, music_prompt_target_model: target?.id ?? null })
    .eq("reel_id", ctx.reelId)
    .select("*")
    .single();
  if (updateError) throw new Error(`reel_config update (music_prompt) failed: ${updateError.message}`);
  return updated as ReelConfigRow;
}

export interface MusicOutput {
  reel_config: ReelConfigRow;
}

async function load(ctx: StageContext): Promise<StageState> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  const reelConfig = data as ReelConfigRow;
  return {
    stage: "music",
    data: {
      reel_config: reelConfig,
      // Advisory: the two music models want near-opposite prompt shapes, so a
      // provider switch is worth flagging. ensureMusicPrompt({force:true}) is
      // the re-optimise action; leaving it alone is fine.
      prompt_staleness: promptStaleness(
        reelConfig.music_prompt_target_model,
        targetModelFor(reelConfig.music_provider ?? DEFAULT_MUSIC_PROVIDER)
      ),
    },
  };
}

/** The reel's single music slot (one `assets` row, one version per generate/upload). */
export async function getMusicAsset(ctx: StageContext): Promise<AssetRow | null> {
  const { data, error } = await ctx.supa
    .from("assets")
    .select("*")
    .eq("reel_id", ctx.reelId)
    .eq("slot", "music_track")
    .maybeSingle();
  if (error) throw new Error(`assets lookup failed: ${error.message}`);
  return (data as AssetRow | null) ?? null;
}

export async function musicHistory(ctx: StageContext): Promise<AssetVersion[]> {
  const asset = await getMusicAsset(ctx);
  return asset ? assetHistory(ctx.supa, asset.id) : [];
}

/** Make a previous track current again (same semantics as image/clip revert). */
export async function revertMusic(ctx: StageContext, versionNo: number): Promise<MusicOutput> {
  const asset = await getMusicAsset(ctx);
  if (!asset) throw new Error("this reel has no music versions yet");
  await revertAssetVersion(ctx.supa, asset.id, versionNo);

  const versions = await assetHistory(ctx.supa, asset.id);
  const target = versions.find((v) => v.version_no === versionNo);
  if (!target) throw new Error(`music version ${versionNo} not found`);

  return process({ music_storage_path: target.storage_path ?? undefined }, ctx, { recordVersion: false });
}

async function process(
  input: MusicInput,
  ctx: StageContext,
  opts: { recordVersion?: boolean } = {}
): Promise<MusicOutput> {
  const patch: Record<string, unknown> = {};
  if (input.music_storage_path !== undefined) patch.music_path = input.music_storage_path;
  if (input.music_trim !== undefined) patch.music_trim = input.music_trim;
  // A hand-edited prompt is no longer "optimised for model X" — drop the claim
  // rather than let the UI keep asserting something that is no longer true.
  if (input.music_prompt !== undefined) {
    patch.music_prompt = input.music_prompt;
    patch.music_prompt_target_model = null;
  }
  if (input.music_provider !== undefined) patch.music_provider = input.music_provider;

  // A new track (generated or uploaded) becomes a new immutable version of the
  // reel's music slot — nothing is overwritten, so any earlier take can be
  // played back and restored (revertMusic).
  if (input.music_storage_path !== undefined && opts.recordVersion !== false) {
    const asset = await getMusicAsset(ctx);
    await upsertAssetVersion(ctx.supa, {
      reel_id: ctx.reelId,
      slot: "music_track",
      media_type: "audio",
      storage_path: input.music_storage_path,
      source: input.music_source ?? "uploaded",
      provider: input.music_source === "generated" ? (input.music_provider as Provider | undefined) ?? null : null,
      assetId: asset?.id,
    });
  }

  const { data, error } = await ctx.supa
    .from("reel_config")
    .update(patch)
    .eq("reel_id", ctx.reelId)
    .select("*")
    .single();
  if (error) throw new Error(`reel_config update failed: ${error.message}`);

  return { reel_config: data as ReelConfigRow };
}

/**
 * Generates a track from the (editable) prompt and makes it the reel's
 * current music — a regenerate is just this called again, and an upload
 * override (process() with music_storage_path) simply replaces it.
 */
export async function generate(input: MusicGenerateInput, ctx: StageContext): Promise<MusicOutput> {
  const { data: configRow, error: configError } = await ctx.supa
    .from("reel_config")
    .select("*")
    .eq("reel_id", ctx.reelId)
    .single();
  if (configError) throw new Error(`reel_config lookup failed: ${configError.message}`);
  const reelConfig = configRow as ReelConfigRow;

  // No hand-typed prompt needed any more: the music-prompt skill drafts one
  // from the reel brief, optimised for the selected model.
  const resolved = input.prompt ?? reelConfig.music_prompt ?? (await ensureMusicPrompt(ctx)).music_prompt;
  const prompt = resolved;
  if (!prompt?.trim()) throw new Error("a music prompt is required before generating");
  const provider = input.provider ?? reelConfig.music_provider ?? DEFAULT_MUSIC_PROVIDER;

  // Clip-wise: the track is written for one clip, so it is that clip's length
  // that matters, not the reel's. The model's own minimum still applies below
  // (ElevenLabs will not go under 10s), and a track longer than its clip is
  // simply truncated to it when the audio lane is laid out at assembly.
  const clipTarget = input.target_clip ? await resolveClipAudioTarget(ctx, input.target_clip) : null;
  const requestedDurationS =
    input.duration_s ?? clipTarget?.clip_duration_s ?? Number(reelConfig.total_seconds_target);

  const adapter = ctx.adapters.get("music", provider);
  // Each music model has its own length window (ElevenLabs 10-300s, Lyria is
  // bounded by its realtime session) — hold the reel's target inside the
  // selected model's window instead of applying one generic rule. Assembly
  // trims/loops the track to the reel's length anyway.
  const caps = adapter.capabilities();
  const durationS = Math.min(
    Math.max(requestedDurationS, caps.min_duration_s ?? requestedDurationS),
    caps.max_duration_s ?? requestedDurationS
  );

  const validation = adapter.validate({ prompt, duration_s: durationS });
  if (!validation.ok) {
    throw new Error(`${provider} cannot generate this track: ${validation.violations.join("; ")}`);
  }

  const idempotencyKey = randomUUID();
  const result = await adapter.generate({
    client_id: ctx.clientId,
    reel_id: ctx.reelId,
    prompt,
    aspect_ratio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    duration_s: durationS,
    provider_key: await ctx.keys.forProvider(ctx.clientId, provider),
    idempotency_key: idempotencyKey,
  });

  await ctx.costEngine.log({
    reel_id: ctx.reelId,
    client_id: ctx.clientId,
    scene_id: clipTarget?.scene_id ?? undefined,
    stage: "music",
    provider,
    adapter: adapter.id,
    call_type: "generate",
    call_status: "success",
    units: result.units,
    unit_type: result.unit_type,
    idempotency_key: idempotencyKey,
  });

  // Clip-wise generation targets that clip's own audio slot and leaves the
  // reel's background track alone — the two coexist in the final mix.
  if (clipTarget) {
    if (!result.asset?.storage_path) throw new Error(`${provider} returned no track to attach to the clip`);

    // The music adapters land their output in the `music/` bucket (that is
    // where a reel's background track belongs). Clip audio is an ordinary
    // reel asset and is read from `assets/` everywhere — by the signed
    // previews and by assembly — so copy it across rather than making every
    // clip-audio reader carry a per-version bucket.
    const mime = result.asset.mime;
    const ext = mime.split("/").pop() ?? "mp3";
    const destPath = `${ctx.clientId}/${ctx.reelId}/clip_audio/${clipTarget.scene_id ?? OUTRO_KEY}/${idempotencyKey}.${ext}`;
    await ctx.storage.upload("assets", destPath, await ctx.storage.download("music", result.asset.storage_path), mime);

    const existing = await getClipAudioAsset(ctx.supa, ctx.reelId, clipTarget.scene_id);
    await upsertAssetVersion(ctx.supa, {
      assetId: existing?.id,
      reel_id: ctx.reelId,
      scene_id: clipTarget.scene_id,
      slot: "clip_audio",
      media_type: "audio",
      storage_path: destPath,
      source: "generated",
      provider,
      metadata: { mime, duration_s: durationS, source_clip_asset_id: clipTarget.clip_asset_id },
      units: result.units,
      unit_type: result.unit_type,
    });
    return { reel_config: reelConfig };
  }

  return process(
    {
      music_storage_path: result.asset?.storage_path,
      music_prompt: prompt,
      music_provider: provider,
      music_source: "generated",
    },
    ctx
  );
}

async function advance(ctx: StageContext): Promise<StageId> {
  const next = nextStage("music");
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const musicStage: StageModule<MusicInput, MusicOutput> = {
  id: "music",
  inputSchema: musicInputSchema,
  load,
  process,
  advance,
};
