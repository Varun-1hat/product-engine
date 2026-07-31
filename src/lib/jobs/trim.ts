/**
 * src/lib/jobs/trim.ts — Stage 6 trim job handler (job_type_t 'trim', spec §7
 * Stage 6). Re-encodes the current version of an asset to [start_s, end_s)
 * and creates a new `derived` asset_version (metadata.trim +
 * base_version_id) — Veo clips generated at native duration (~8s) get
 * trimmed down to scene.seconds here.
 */
import ffmpeg from "./ffmpegSetup";
import { withTempDir, writeTempFile, readTempFile } from "./tempFiles";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import { getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import type { Job } from "@/src/lib/jobs/queue";
import type { AssetVersionMetadata } from "@/src/lib/db/types";

export interface TrimJobPayload {
  base_version_id: string;
  start_s: number;
  end_s: number;
}

async function reencodeTrim(inputPath: string, outputPath: string, startS: number, endS: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startS)
      .duration(Math.max(0.01, endS - startS))
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-pix_fmt", "yuv420p"])
      .on("error", (err) => reject(err))
      .on("end", () => resolve())
      .save(outputPath);
  });
}

export async function runTrimJob(supa: ServiceClient, storage: StorageClient, job: Job): Promise<void> {
  const payload = job.payload as unknown as TrimJobPayload;
  if (!job.asset_id) throw new Error(`trim job ${job.id} has no asset_id`);
  if (!payload?.base_version_id) throw new Error(`trim job ${job.id} payload missing base_version_id`);

  const { data: versionData, error } = await supa
    .from("asset_versions")
    .select("storage_path, metadata")
    .eq("id", payload.base_version_id)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
  const baseVersion = versionData as { storage_path: string | null; metadata: AssetVersionMetadata };
  if (!baseVersion.storage_path) throw new Error(`base version ${payload.base_version_id} has no storage_path`);

  const asset = await getAsset(supa, job.asset_id);

  await withTempDir(async (dir) => {
    const inputBuffer = await storage.download("assets", baseVersion.storage_path!);
    const inputPath = await writeTempFile(dir, "input.mp4", inputBuffer);
    const outputPath = `${dir}/output.mp4`;

    await reencodeTrim(inputPath, outputPath, payload.start_s, payload.end_s);
    const outputBuffer = await readTempFile(outputPath);

    const destPath = baseVersion.storage_path!.replace(/\.[a-z0-9]+$/i, "") + `-trim-${Date.now()}.mp4`;
    await storage.upload("assets", destPath, outputBuffer, "video/mp4");

    await upsertAssetVersion(supa, {
      assetId: asset.id,
      reel_id: asset.reel_id,
      scene_id: asset.scene_id,
      slot: asset.slot,
      media_type: asset.media_type,
      shared: asset.shared,
      storage_path: destPath,
      source: "derived",
      metadata: {
        ...baseVersion.metadata,
        duration_s: Math.max(0.01, payload.end_s - payload.start_s),
        trim: { start_s: payload.start_s, end_s: payload.end_s },
        base_version_id: payload.base_version_id,
      },
    });
  });
}
