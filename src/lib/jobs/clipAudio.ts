/**
 * src/lib/jobs/clipAudio.ts — demuxes a video-gen model's native audio track
 * out of a generated clip into a `clip_audio` asset of its own.
 *
 * Why a separate asset rather than leaving it inside the clip mp4 (where it
 * already physically lives): a track buried in the video file cannot be
 * switched off per clip, overridden by an upload, trimmed independently of the
 * picture, or reverted to after either — all of which are ordinary
 * asset_versions operations once the audio is an asset in its own right.
 *
 * Not a job_type_t: there is no provider call, no cost and no async wait — it
 * is a local derivation, so it runs as a plain function from the two places a
 * clip version comes into existence (src/lib/jobs/reconcile.ts on completion,
 * and lazily from the clip-audio GET, which also backfills clips generated
 * before this existed). Both paths call ensureClipAudio(), which is idempotent.
 *
 * IMPORT LAZILY. This module pulls in ffmpeg-static (a large binary package)
 * through ./ffmpegSetup, and both of its callers sit on hot read paths —
 * reconcile runs from every stage GET. Both therefore `await import()` this
 * file inside the branch that actually needs it, keeping ffmpeg out of their
 * static graphs; the DB-only half callers usually want (getClipAudioAsset)
 * lives in src/lib/clipAudio.ts precisely so it can be imported normally.
 */
import ffmpeg from "./ffmpegSetup";
import { withTempDir, writeTempFile, readTempFile } from "./tempFiles";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import { assetHistory, getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import { getClipAudioAsset } from "@/src/lib/clipAudio";
import type { AssetVersion } from "@/src/lib/db/types";

/** Everything the mix lane expects: stereo 48kHz AAC, playable standalone in an `<audio>` element. */
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
export const CLIP_AUDIO_MIME = "audio/mp4";

/**
 * Strips the video stream and re-encodes the audio to a standalone .m4a.
 * Re-encodes rather than `-c:a copy` so the result is a well-formed file with
 * timestamps starting at zero, whatever container quirks the provider emitted.
 *
 * Resolves `false` — not an error — when the source simply has no audio
 * stream, which is the normal case for a provider whose capabilities say
 * `emits_audio: false`. ffmpeg fails that case with "does not contain any
 * stream", so the codecData sniffed during this same pass is what tells the
 * two apart; any other failure is re-thrown.
 */
export async function extractAudioTrack(inputPath: string, outputPath: string): Promise<boolean> {
  let sawAudioStream = false;

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .on("codecData", (data: { audio?: string }) => {
          const audio = data.audio?.trim().toLowerCase();
          sawAudioStream = Boolean(audio) && audio !== "none";
        })
        .noVideo()
        .audioCodec("aac")
        .audioChannels(AUDIO_CHANNELS)
        .audioFrequency(AUDIO_SAMPLE_RATE)
        .outputOptions(["-movflags", "+faststart"])
        .on("error", (err: Error) => reject(err))
        .on("end", () => resolve())
        .save(outputPath);
    });
  } catch (err) {
    if (!sawAudioStream) return false;
    throw err;
  }

  return sawAudioStream;
}

/**
 * Makes sure the clip's current version has had its audio extracted, and
 * returns the resulting version (or null when there was no audio to take).
 *
 * Idempotent on `metadata.base_version_id`: a version already extracted from
 * this exact clip version is left alone, so repeat page loads cost nothing,
 * a user's uploaded override is never overwritten, and a *clip* redo — which
 * produces a new clip version — correctly yields fresh audio for the new take
 * while the previous one stays in history.
 */
export async function ensureClipAudio(
  supa: ServiceClient,
  storage: StorageClient,
  clipAssetId: string
): Promise<AssetVersion | null> {
  const clipAsset = await getAsset(supa, clipAssetId);
  if (!clipAsset.current_version_id) return null;

  const { data: clipVersionData, error: clipVersionError } = await supa
    .from("asset_versions")
    .select("id, storage_path, provider, metadata")
    .eq("id", clipAsset.current_version_id)
    .single();
  if (clipVersionError) throw new Error(`asset_versions lookup failed: ${clipVersionError.message}`);
  const clipVersion = clipVersionData as Pick<AssetVersion, "id" | "storage_path" | "provider" | "metadata">;
  if (!clipVersion.storage_path) return null;

  const audioAsset = await getClipAudioAsset(supa, clipAsset.reel_id, clipAsset.scene_id);
  if (audioAsset) {
    const versions = await assetHistory(supa, audioAsset.id);
    const alreadyExtracted = versions.find((v) => v.metadata?.base_version_id === clipVersion.id);
    if (alreadyExtracted) return alreadyExtracted;
  }

  return withTempDir(async (dir) => {
    const inputBuffer = await storage.download("assets", clipVersion.storage_path!);
    const inputPath = await writeTempFile(dir, "clip.mp4", inputBuffer);
    const outputPath = `${dir}/audio.m4a`;

    const hasAudio = await extractAudioTrack(inputPath, outputPath);
    if (!hasAudio) return null;

    const destPath = `${clipVersion.storage_path!.replace(/\.[a-z0-9]+$/i, "")}-audio-${Date.now()}.m4a`;
    await storage.upload("assets", destPath, await readTempFile(outputPath), CLIP_AUDIO_MIME);

    const { version } = await upsertAssetVersion(supa, {
      assetId: audioAsset?.id,
      reel_id: clipAsset.reel_id,
      scene_id: clipAsset.scene_id,
      slot: "clip_audio",
      media_type: "audio",
      storage_path: destPath,
      source: "generated",
      provider: clipVersion.provider,
      metadata: {
        mime: CLIP_AUDIO_MIME,
        duration_s: clipVersion.metadata?.duration_s,
        base_version_id: clipVersion.id,
        source_clip_asset_id: clipAsset.id,
      },
    });
    return version;
  });
}
