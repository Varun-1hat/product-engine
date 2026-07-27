/**
 * worker/assembly.ts — Stage 9 assembly job handler (job_type_t
 * 'assembly', spec §7 Stage 9). Executes the deterministic
 * src/stages/assembly/plan.ts AssemblyPlan with real ffmpeg commands:
 * strip audio + normalize every clip (resolution/aspect/fps/yuv420p/
 * H.264), drop 1 head frame on continuous-seam incoming clips, concat,
 * build the music bed (trim/loop/fade), mux to mp4 (H.264+AAC) -> renders/
 * -> a new final_render asset_version. Re-assembly reuses the same
 * final_render asset (new version, same row) and re-sets
 * `reels.status='assembled'`.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import ffmpeg from "./ffmpegSetup";
import { withTempDir, writeTempFile, readTempFile } from "./tempFiles";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import { upsertAssetVersion } from "@/src/lib/versioning";
import { dimensionsFor } from "@/src/adapters/dimensions";
import type { Job } from "@/src/lib/jobs/queue";
import type { AssemblyPlan, MusicPlan } from "@/src/stages/assembly/plan";

function runFfmpeg(build: (cmd: ReturnType<typeof ffmpeg>) => void, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    build(cmd);
    cmd
      .on("error", (err: Error) => reject(err))
      .on("end", () => resolve())
      .save(outputPath);
  });
}

/** Strip audio, drop the head frame on a continuous-seam incoming clip, normalize to reel spec (§10.9-10.11). */
export async function normalizeClip(
  inputPath: string,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  trimHeadFrame: boolean
): Promise<void> {
  const filters: string[] = [];
  if (trimHeadFrame) {
    // Drop exactly frame 0 (the duplicate shared frame) and reset timestamps.
    filters.push("select='gte(n\\,1)'", "setpts=PTS-STARTPTS");
  }
  filters.push(
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
    "format=yuv420p"
  );

  await runFfmpeg((cmd) => {
    cmd
      .input(inputPath)
      .videoFilters(filters)
      .noAudio()
      .videoCodec("libx264")
      .outputOptions(["-movflags", "+faststart"]);
  }, outputPath);
}

export async function concatClips(clipPaths: string[], dir: string, outputPath: string): Promise<void> {
  const listPath = path.join(dir, "concat_list.txt");
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, listContent, "utf-8");

  await runFfmpeg((cmd) => {
    cmd.input(listPath).inputOptions(["-f", "concat", "-safe", "0"]).outputOptions(["-c", "copy"]);
  }, outputPath);
}

/** Trim/loop the source track to the total reel duration and apply fade in/out (§10.20). */
export async function buildMusicTrack(
  inputPath: string,
  dir: string,
  musicPlan: MusicPlan,
  totalDurationS: number
): Promise<string> {
  const segmentPath = path.join(dir, "music_segment.wav");
  await runFfmpeg((cmd) => {
    cmd
      .input(inputPath)
      .setStartTime(musicPlan.start_s)
      .duration(Math.max(0.01, musicPlan.end_s - musicPlan.start_s))
      .audioChannels(2)
      .audioFrequency(44100)
      .audioCodec("pcm_s16le");
  }, segmentPath);

  const outputPath = path.join(dir, "music_final.m4a");
  const fadeOutStart = Math.max(0, totalDurationS - musicPlan.fade_out_s);
  await runFfmpeg((cmd) => {
    cmd.input(segmentPath);
    if (musicPlan.loop) cmd.inputOptions(["-stream_loop", "-1"]);
    cmd
      .duration(totalDurationS)
      .audioFilters([`afade=t=in:st=0:d=${musicPlan.fade_in_s}`, `afade=t=out:st=${fadeOutStart}:d=${musicPlan.fade_out_s}`])
      .audioCodec("aac");
  }, outputPath);

  return outputPath;
}

/** mp4, H.264 + AAC (§7 Stage 9.6) — video-only (no audio stream) when there's no music bed at all. */
export async function muxFinal(videoPath: string, audioPath: string | null, outputPath: string): Promise<void> {
  await runFfmpeg((cmd) => {
    cmd.input(videoPath);
    if (audioPath) {
      cmd
        .input(audioPath)
        .outputOptions(["-map", "0:v:0", "-map", "1:a:0", "-shortest"])
        .videoCodec("copy")
        .audioCodec("aac");
    } else {
      cmd.outputOptions(["-map", "0:v:0"]).videoCodec("copy");
    }
    cmd.outputOptions(["-movflags", "+faststart"]);
  }, outputPath);
}

export async function runAssemblyJob(supa: ServiceClient, storage: StorageClient, job: Job): Promise<void> {
  if (!job.reel_id) throw new Error(`assembly job ${job.id} has no reel_id`);
  const plan = (job.payload as unknown as { plan: AssemblyPlan }).plan;
  if (!plan) throw new Error(`assembly job ${job.id} payload missing plan`);

  const { width, height } = dimensionsFor(plan.aspect_ratio, plan.resolution);

  await withTempDir(async (dir) => {
    const normalizedPaths: string[] = [];
    for (let i = 0; i < plan.clips.length; i++) {
      const clip = plan.clips[i];
      const inputBuffer = await storage.download("assets", clip.storage_path);
      const inputPath = await writeTempFile(dir, `clip_${i}_in.mp4`, inputBuffer);
      const outputPath = path.join(dir, `clip_${i}_norm.mp4`);
      await normalizeClip(inputPath, outputPath, width, height, plan.fps, clip.trim_head_frame);
      normalizedPaths.push(outputPath);
    }

    const concatenatedPath = path.join(dir, "concatenated.mp4");
    await concatClips(normalizedPaths, dir, concatenatedPath);

    let audioPath: string | null = null;
    if (plan.music) {
      const musicBuffer = await storage.download("music", plan.music.storage_path);
      const musicInputPath = await writeTempFile(dir, "music_in", musicBuffer);
      audioPath = await buildMusicTrack(musicInputPath, dir, plan.music, plan.total_duration_s);
    }

    const finalPath = path.join(dir, "final.mp4");
    await muxFinal(concatenatedPath, audioPath, finalPath);
    const finalBuffer = await readTempFile(finalPath);

    await storage.upload("renders", plan.output_path, finalBuffer, "video/mp4");

    // Re-assembly reuses the same final_render asset row (new version, not a new row).
    const { data: existingAsset, error: existingError } = await supa
      .from("assets")
      .select("id")
      .eq("reel_id", job.reel_id)
      .eq("slot", "final_render")
      .maybeSingle();
    if (existingError) throw new Error(`assets lookup (final_render) failed: ${existingError.message}`);

    await upsertAssetVersion(supa, {
      assetId: (existingAsset as { id: string } | null)?.id,
      reel_id: job.reel_id!,
      slot: "final_render",
      media_type: "video",
      storage_path: plan.output_path,
      source: "assembled",
      metadata: {
        width,
        height,
        aspect: plan.aspect_ratio,
        resolution: plan.resolution,
        fps: plan.fps,
        duration_s: plan.total_duration_s,
        codec: "h264",
        mime: "video/mp4",
      },
    });

    const { error: statusError } = await supa.from("reels").update({ status: "assembled" }).eq("id", job.reel_id!);
    if (statusError) throw new Error(`reels status update failed: ${statusError.message}`);
  });
}
