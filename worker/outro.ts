/**
 * worker/outro.ts — Stage 7 `outro_gen` job handler (job_type_t
 * 'outro_gen', spec §7 Stage 7, §8, R2 routing rule). Not one of the 5
 * worker files spec §12 names verbatim, but Stage 7's dual-route logic
 * (model vs deterministic crossfade) needs a home distinct from the
 * dispatcher (index.ts) and the Stage 9 pipeline (assembly.ts) — added
 * here with the same "worker does the ffmpeg/provider work" split as the
 * other worker/*.ts files (see .pipeline/changes.md).
 *
 * route='crossfade': ffmpeg fade from the last scene's final frame to the
 * branded end-frame image over outro_seconds — no provider call, cost $0
 * (job completes in this one call).
 * route='model': resolve the start reference (last scene's own end_image,
 * or — if it has none, e.g. avatar-last or a non-end-frame b-roll model —
 * extract the last frame of its clip via ffmpeg), call the effective
 * outro model's generate(), and mark the job awaiting_provider so
 * worker/reconcile.ts's poll loop finishes it (same cost-logging-at-
 * completion pattern as Stage 5 clips).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import ffmpeg from "./ffmpegSetup";
import { withTempDir, writeTempFile, readTempFile } from "./tempFiles";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import type { JobQueue, Job } from "@/src/lib/jobs/queue";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { KeyResolver } from "@/src/lib/crypto/vault";
import { getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import { dimensionsFor } from "@/src/adapters/dimensions";
import { composeVeoVariant } from "@/src/adapters/video_broll/veo";
import type { Provider } from "@/src/lib/db/enums";

export interface OutroGenPayload {
  call_type: "generate" | "redo";
  route: "model" | "crossfade";
  provider: string | null;
  outro_seconds: number;
  aspect_ratio: string;
  resolution: string;
  variant?: string | null;
  end_frame_asset_id: string;
  prompt_version_id: string | null;
  last_scene_end_image_id: string | null;
  last_scene_clip_asset_id: string | null;
}

async function currentVersionPath(supa: ServiceClient, assetId: string): Promise<string> {
  const asset = await getAsset(supa, assetId);
  if (!asset.current_version_id) throw new Error(`asset ${assetId} has no current version`);
  const { data, error } = await supa
    .from("asset_versions")
    .select("storage_path")
    .eq("id", asset.current_version_id)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
  const storagePath = (data as { storage_path: string | null }).storage_path;
  if (!storagePath) throw new Error(`asset ${assetId}'s current version has no storage_path`);
  return storagePath;
}

/** Grabs the true last frame: seek near EOF, decode to the end, keep only the final frame (image2 `-update 1`). */
async function extractLastFrame(storage: StorageClient, clipStoragePath: string, dir: string): Promise<string> {
  const clipBuffer = await storage.download("assets", clipStoragePath);
  const clipPath = await writeTempFile(dir, "outro_source_clip.mp4", clipBuffer);
  const framePath = path.join(dir, "last_frame.png");

  await new Promise<void>((resolve, reject) => {
    ffmpeg(clipPath)
      .inputOptions(["-sseof", "-3"])
      .outputOptions(["-update", "1", "-q:v", "2"])
      .on("error", (err: Error) => reject(err))
      .on("end", () => resolve())
      .save(framePath);
  });

  return framePath;
}

async function resolveStartFramePath(
  supa: ServiceClient,
  storage: StorageClient,
  dir: string,
  payload: OutroGenPayload,
  jobId: string
): Promise<string> {
  if (payload.last_scene_end_image_id) {
    const storagePath = await currentVersionPath(supa, payload.last_scene_end_image_id);
    const buffer = await storage.download("assets", storagePath);
    return writeTempFile(dir, "start.png", buffer);
  }
  if (payload.last_scene_clip_asset_id) {
    const clipStoragePath = await currentVersionPath(supa, payload.last_scene_clip_asset_id);
    return extractLastFrame(storage, clipStoragePath, dir);
  }
  throw new Error(`outro_gen job ${jobId}: no start reference available (neither an end image nor a clip)`);
}

async function runCrossfade(
  supa: ServiceClient,
  storage: StorageClient,
  job: Job,
  payload: OutroGenPayload
): Promise<void> {
  if (!job.asset_id) throw new Error(`outro_gen job ${job.id} has no asset_id`);
  if (!job.reel_id) throw new Error(`outro_gen job ${job.id} has no reel_id`);

  await withTempDir(async (dir) => {
    const startImagePath = await resolveStartFramePath(supa, storage, dir, payload, job.id);
    const endFrameStoragePath = await currentVersionPath(supa, payload.end_frame_asset_id);
    const endImageBuffer = await storage.download("assets", endFrameStoragePath);
    const endImagePath = await writeTempFile(dir, "end.png", endImageBuffer);

    const { width, height } = dimensionsFor(payload.aspect_ratio, payload.resolution);
    const outputPath = path.join(dir, "outro_crossfade.mp4");

    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(startImagePath)
        .inputOptions(["-loop", "1", "-t", String(payload.outro_seconds)])
        .input(endImagePath)
        .inputOptions(["-loop", "1", "-t", String(payload.outro_seconds)])
        .complexFilter([
          `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v0]`,
          `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v1]`,
          `[v0][v1]xfade=transition=fade:duration=${payload.outro_seconds}:offset=0[outv]`,
        ])
        .outputOptions(["-map", "[outv]"])
        .videoCodec("libx264")
        .on("error", (err: Error) => reject(err))
        .on("end", () => resolve())
        .save(outputPath);
    });

    const outputBuffer = await readTempFile(outputPath);
    const destPath = `_provider_results/crossfade/${job.id}-${Date.now()}.mp4`;
    await storage.upload("assets", destPath, outputBuffer, "video/mp4");

    await upsertAssetVersion(supa, {
      assetId: job.asset_id!,
      reel_id: job.reel_id!,
      scene_id: job.scene_id,
      slot: "outro_clip",
      media_type: "video",
      storage_path: destPath,
      source: "generated",
      provider: null,
      metadata: {
        width,
        height,
        aspect: payload.aspect_ratio,
        resolution: payload.resolution,
        duration_s: payload.outro_seconds,
        codec: "h264",
        mime: "video/mp4",
      },
    });
    // No provider call -> no cost_log entry (deterministic crossfade, $0 — spec §7 Stage 7).
  });
}

async function runModelRoute(
  supa: ServiceClient,
  storage: StorageClient,
  jobs: JobQueue,
  adapters: AdapterRegistry,
  keys: KeyResolver,
  job: Job,
  payload: OutroGenPayload
): Promise<void> {
  if (!payload.provider) throw new Error(`outro_gen job ${job.id}: route='model' but no provider set`);
  // Narrow into a const so it stays typed as `string` (not `string | null`)
  // inside the withTempDir closure below.
  const providerId = payload.provider;
  if (!job.reel_id) throw new Error(`outro_gen job ${job.id} has no reel_id`);

  const { data: reelRow, error: reelError } = await supa.from("reels").select("client_id").eq("id", job.reel_id).single();
  if (reelError) throw new Error(`reels lookup failed: ${reelError.message}`);
  const clientId = (reelRow as { client_id: string }).client_id;

  await withTempDir(async (dir) => {
    const startImagePath = await resolveStartFramePath(supa, storage, dir, payload, job.id);
    const startBuffer = await readTempFile(startImagePath);

    const endFrameStoragePath = await currentVersionPath(supa, payload.end_frame_asset_id);
    const endImageBuffer = await storage.download("assets", endFrameStoragePath);

    let promptText = "Smooth, elegant motion transitioning into a clean branded end card.";
    if (payload.prompt_version_id) {
      const { data } = await supa.from("prompt_versions").select("text").eq("id", payload.prompt_version_id).maybeSingle();
      if (data) promptText = (data as { text: string }).text;
    }

    const providerKey = await keys.forProvider(clientId, providerId as Provider);
    const adapter = adapters.get("video_broll", providerId);

    const result = await adapter.generate({
      client_id: clientId,
      reel_id: job.reel_id!,
      scene_id: job.scene_id ?? undefined,
      prompt: promptText,
      start_image: { base64: startBuffer.toString("base64"), mime_type: "image/png" },
      end_image: { base64: endImageBuffer.toString("base64"), mime_type: "image/png" },
      aspect_ratio: payload.aspect_ratio,
      resolution: payload.resolution,
      duration_s: payload.outro_seconds,
      variant: payload.variant ?? undefined,
      provider_key: providerKey,
      idempotency_key: randomUUID(),
    });

    if (result.status !== "pending" || !result.provider_job_id) {
      throw new Error(`${payload.provider} generate() for outro job ${job.id} did not return a pending async job`);
    }

    await jobs.markAwaitingProvider(job.id, result.provider_job_id);

    // Stash the now-known billing context in payload for worker/reconcile.ts
    // to log accurately at completion (JobQueue has no dedicated "patch
    // payload" method, so this updates the row directly).
    //
    // variant: `payload.variant` at this point is still the BARE reel
    // default (src/stages/outro/index.ts deliberately stores it bare, since
    // it's what generate() above needed for model-id lookup). For Veo,
    // billing needs the resolution-qualified form (composeVeoVariant) —
    // `result.variant` is Veo's own echoed-back BARE variant and must NOT
    // be allowed to win here, or the rate_card lookup at completion time
    // (worker/reconcile.ts) silently comes back rate_missing again.
    const billingVariant =
      providerId === "veo" && payload.variant
        ? composeVeoVariant(payload.variant, payload.resolution)
        : (result.variant ?? payload.variant ?? null);

    const { error: updateError } = await supa
      .from("jobs")
      .update({
        payload: {
          ...payload,
          units: result.units,
          unit_type: result.unit_type,
          variant: billingVariant,
          duration_s: payload.outro_seconds,
        },
      })
      .eq("id", job.id);
    if (updateError) throw new Error(`jobs payload update failed: ${updateError.message}`);
  });
}

/** Returns whether the job is now finished in this call, or left awaiting_provider for reconcile.ts. */
export async function runOutroGenJob(deps: {
  supa: ServiceClient;
  storage: StorageClient;
  jobs: JobQueue;
  adapters: AdapterRegistry;
  keys: KeyResolver;
  job: Job;
}): Promise<"completed" | "awaiting_provider"> {
  const payload = deps.job.payload as unknown as OutroGenPayload;
  if (payload.route === "crossfade") {
    await runCrossfade(deps.supa, deps.storage, deps.job, payload);
    return "completed";
  }
  await runModelRoute(deps.supa, deps.storage, deps.jobs, deps.adapters, deps.keys, deps.job, payload);
  return "awaiting_provider";
}
