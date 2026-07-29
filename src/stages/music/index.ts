/**
 * Stage 8 — Music (spec §7 Stage 8, brief §11). A track can be generated
 * from an editable prompt (generate() below, ElevenLabs or Lyria) or simply
 * uploaded as an override — either way it lands in the music/ bucket ->
 * reel_config.music_path + music_trim, applied at assembly (Stage 9):
 * trim + fade to length; loop if shorter (brief §10.20).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState } from "../types";
import { nextStage } from "../types";
import type { AssetRow, AssetVersion, ReelConfigRow } from "@/src/lib/db/types";
import { PROVIDERS, type Provider, type StageId } from "@/src/lib/db/enums";
import { assetHistory, revertAssetVersion, upsertAssetVersion } from "@/src/lib/versioning";

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
});
export type MusicGenerateInput = z.infer<typeof musicGenerateInputSchema>;

const DEFAULT_MUSIC_PROVIDER: Provider = "elevenlabs";

export interface MusicOutput {
  reel_config: ReelConfigRow;
}

async function load(ctx: StageContext): Promise<StageState> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  return { stage: "music", data: { reel_config: data as ReelConfigRow } };
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
  if (input.music_prompt !== undefined) patch.music_prompt = input.music_prompt;
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

  const prompt = input.prompt ?? reelConfig.music_prompt;
  if (!prompt?.trim()) throw new Error("a music prompt is required before generating");
  const provider = input.provider ?? reelConfig.music_provider ?? DEFAULT_MUSIC_PROVIDER;
  const requestedDurationS = input.duration_s ?? Number(reelConfig.total_seconds_target);

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
    stage: "music",
    provider,
    adapter: adapter.id,
    call_type: "generate",
    call_status: "success",
    units: result.units,
    unit_type: result.unit_type,
    idempotency_key: idempotencyKey,
  });

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
