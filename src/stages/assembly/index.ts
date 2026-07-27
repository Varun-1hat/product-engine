/**
 * Stage 9 — Assembly (spec §7 Stage 9). Gathers everything
 * worker/assembly.ts needs (buildAssemblyPlan, ./plan.ts), enqueues an
 * `assembly` job, and returns immediately — the actual ffmpeg work
 * (audio-strip/normalize/seam-trim/concat/music bed/mux) runs in the
 * worker. Re-running this stage enqueues a new job -> a new `final_render`
 * asset_version on the SAME asset (worker looks it up by reel_id+slot).
 * Cost: none (no provider calls at this stage).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StageContext, StageModule, StageState } from "../types";
import { getReelConfig, getScenesForReel } from "@/src/lib/rows";
import { getAsset } from "@/src/lib/versioning";
import { buildAssemblyPlan, type AssemblyMusicSource, type AssemblyPlan } from "./plan";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { SupportsEndFrameLookup } from "@/src/lib/routing";
import type { AssetRow } from "@/src/lib/db/types";
import type { Job } from "@/src/lib/jobs/queue";
import type { StageId } from "@/src/lib/db/enums";

export const assemblyInputSchema = z.object({});
export type AssemblyInput = z.infer<typeof assemblyInputSchema>;

export interface AssemblyOutput {
  job: Job;
  plan: AssemblyPlan;
}

function supportsEndFrameLookup(adapters: AdapterRegistry): SupportsEndFrameLookup {
  return (provider) => adapters.tryGet("video_broll", provider)?.capabilities().supports_end_frame ?? false;
}

async function currentVersionStoragePath(
  ctx: StageContext,
  assetId: string
): Promise<{ storage_path: string; duration_s?: number }> {
  const asset = await getAsset(ctx.supa, assetId);
  if (!asset.current_version_id) throw new Error(`asset ${assetId} has no current version yet`);
  const { data, error } = await ctx.supa
    .from("asset_versions")
    .select("storage_path, metadata")
    .eq("id", asset.current_version_id)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
  const row = data as { storage_path: string | null; metadata: { duration_s?: number } | null };
  if (!row.storage_path) throw new Error(`asset ${assetId}'s current version has no storage_path yet`);
  return { storage_path: row.storage_path, duration_s: row.metadata?.duration_s };
}

async function buildPlanForReel(ctx: StageContext): Promise<AssemblyPlan> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  if (scenes.length === 0) throw new Error("reel has no scenes yet");

  const clipStoragePaths: Record<string, string> = {};
  const sceneDurations: Record<string, number> = {};
  for (const scene of scenes) {
    if (!scene.clip_asset_id) {
      throw new Error(`scene ${scene.id} (position ${scene.position}) has no clip yet — finish Stage 5 first`);
    }
    const { storage_path, duration_s } = await currentVersionStoragePath(ctx, scene.clip_asset_id);
    clipStoragePaths[scene.id] = storage_path;
    sceneDurations[scene.id] = duration_s ?? scene.seconds;
  }

  const { data: outroAssetRow, error: outroAssetError } = await ctx.supa
    .from("assets")
    .select("*")
    .eq("reel_id", ctx.reelId)
    .eq("slot", "outro_clip")
    .maybeSingle();
  if (outroAssetError) throw new Error(`assets lookup (outro_clip) failed: ${outroAssetError.message}`);
  if (!outroAssetRow) throw new Error("outro clip not generated yet — finish Stage 7 first");
  const { storage_path: outroClipStoragePath } = await currentVersionStoragePath(ctx, (outroAssetRow as AssetRow).id);

  const music: AssemblyMusicSource | null = reelConfig.music_path
    ? { storage_path: reelConfig.music_path, music_trim: reelConfig.music_trim }
    : null;

  const outputPath = `${ctx.clientId}/${ctx.reelId}/assembly/${randomUUID()}.mp4`;

  return buildAssemblyPlan({
    scenesByPosition: scenes,
    clipStoragePaths,
    sceneDurations,
    outroClipStoragePath,
    outroSeconds: reelConfig.outro_seconds,
    reelConfig,
    aspectRatio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    fps: reelConfig.output_fps,
    supportsEndFrame: supportsEndFrameLookup(ctx.adapters),
    music,
    outputPath,
  });
}

async function load(ctx: StageContext): Promise<StageState> {
  const { data, error } = await ctx.supa.from("reels").select("*").eq("id", ctx.reelId).single();
  if (error) throw new Error(`reels lookup failed: ${error.message}`);
  return { stage: "assembly", data: { reel: data } };
}

async function process(_input: AssemblyInput, ctx: StageContext): Promise<AssemblyOutput> {
  const plan = await buildPlanForReel(ctx);

  const job = await ctx.jobs.enqueue({
    reel_id: ctx.reelId,
    type: "assembly",
    payload: { plan },
  });

  return { job, plan };
}

async function advance(ctx: StageContext): Promise<StageId> {
  // Assembly is the last stage in the fixed order — stays put. reels.status
  // transitions to 'assembled' when worker/assembly.ts finishes the job,
  // not here (this only enqueues it).
  const { error } = await ctx.supa.from("reels").update({ current_stage: "assembly" }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return "assembly";
}

export const assemblyStage: StageModule<AssemblyInput, AssemblyOutput> = {
  id: "assembly",
  inputSchema: assemblyInputSchema,
  load,
  process,
  advance,
};
