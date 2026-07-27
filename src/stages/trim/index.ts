/**
 * Stage 6 — Trim / reorder (spec §7 Stage 6). Human-managed, no enforcement
 * (brief §6, §10.6): editing/reordering/trimming a shared boundary (or
 * trimming below the end frame) may break the continuous seam — hint only,
 * blocks nothing. Cost: none.
 *
 * Trim: enqueues a `trim` worker job (worker/trim.ts re-encodes the current
 * version -> a new `derived` asset_version with metadata.trim +
 * base_version_id). Veo clips are generated at native duration (~8s) —
 * trimming to the shorter scene.seconds happens here.
 * Reorder: plain UPDATE scenes.position (no uniqueness enforced, by
 * design — see supabase/migrations/0001_init.sql).
 *
 * This stage has no prompts (nothing to redo/edit at the prompt level), so
 * `redoPrompt`/`editPrompt` are not meaningful here; they throw rather than
 * silently no-op. `redoAsset`/`revertAsset`/`download`/`history` work
 * normally against the asset_versions trim history.
 */
import { z } from "zod";
import type { StageContext, StageModule, StageState, ReviewHooks } from "../types";
import { nextStage } from "../types";
import type { Job } from "@/src/lib/jobs/queue";
import { effectiveBoundary, type SupportsEndFrameLookup } from "@/src/lib/routing";
import { getReelConfig, getScenesForReel } from "@/src/lib/rows";
import { assetHistory, getAsset, revertAssetVersion } from "@/src/lib/versioning";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { SceneRow } from "@/src/lib/db/types";

export const trimInputSchema = z.object({
  asset_id: z.string().uuid(),
  start_s: z.number().nonnegative(),
  end_s: z.number().positive(),
});
export type TrimInput = z.infer<typeof trimInputSchema>;

export interface TrimOutput {
  job: Job;
}

function supportsEndFrameLookup(adapters: AdapterRegistry): SupportsEndFrameLookup {
  return (provider) => adapters.tryGet("video_broll", provider)?.capabilities().supports_end_frame ?? false;
}

export interface TrimHint {
  scene_id: string;
  note: string;
}

/** Which scenes' clips sit on a continuous seam — trimming/reordering them may break it (hint only). */
export async function computeTrimHints(ctx: StageContext): Promise<TrimHint[]> {
  const reelConfig = await getReelConfig(ctx.supa, ctx.reelId);
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  const supportsEndFrame = supportsEndFrameLookup(ctx.adapters);

  const hints: TrimHint[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const next = scenes[i + 1] ?? null;
    if (effectiveBoundary(scene, next, reelConfig, supportsEndFrame) === "continuous" && next) {
      hints.push({
        scene_id: scene.id,
        note: `this clip's end is a shared frame with "${next.description ?? next.id}" — trimming below the end frame or reordering may break the continuous seam`,
      });
    }
  }
  return hints;
}

async function load(ctx: StageContext): Promise<StageState> {
  const scenes = await getScenesForReel(ctx.supa, ctx.reelId);
  return { stage: "trim", data: { scenes } };
}

async function process(input: TrimInput, ctx: StageContext): Promise<TrimOutput> {
  const asset = await getAsset(ctx.supa, input.asset_id);
  if (!asset.current_version_id) {
    throw new Error(`asset ${input.asset_id} has no current version to trim`);
  }

  const job = await ctx.jobs.enqueue({
    reel_id: ctx.reelId,
    scene_id: asset.scene_id,
    asset_id: asset.id,
    type: "trim",
    payload: {
      base_version_id: asset.current_version_id,
      start_s: input.start_s,
      end_s: input.end_s,
    },
  });

  return { job };
}

/** Reorder = plain UPDATE scenes.position (brief §10.6 — human-managed, not enforced). */
export async function reorderScenes(ctx: StageContext, sceneIdsInOrder: string[]): Promise<SceneRow[]> {
  for (let position = 0; position < sceneIdsInOrder.length; position++) {
    const { error } = await ctx.supa
      .from("scenes")
      .update({ position })
      .eq("id", sceneIdsInOrder[position])
      .eq("reel_id", ctx.reelId);
    if (error) throw new Error(`scenes reorder failed: ${error.message}`);
  }
  return getScenesForReel(ctx.supa, ctx.reelId);
}

async function advance(ctx: StageContext): Promise<import("@/src/lib/db/enums").StageId> {
  const next = nextStage("trim");
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const trimStage: StageModule<TrimInput, TrimOutput> = {
  id: "trim",
  inputSchema: trimInputSchema,
  load,
  process,
  advance,
};

/** ctx-bound review hooks (see src/stages/image/index.ts header note). No prompts exist for trim. */
export function createTrimReviewHooks(ctx: StageContext): ReviewHooks {
  return {
    async redoPrompt() {
      throw new Error("trim has no prompts to redo");
    },
    async editPrompt() {
      throw new Error("trim has no prompts to edit");
    },
    async redoAsset(assetId) {
      const asset = await getAsset(ctx.supa, assetId);
      if (!asset.current_version_id) throw new Error(`asset ${assetId} has no current version`);
      const { data, error } = await ctx.supa
        .from("asset_versions")
        .select("metadata")
        .eq("id", asset.current_version_id)
        .single();
      if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);
      const trim = (data as { metadata: { trim?: { start_s: number; end_s: number } } }).metadata?.trim;
      if (!trim) throw new Error(`asset ${assetId} has no prior trim to redo — use trim.process() with explicit start_s/end_s`);

      const job = await ctx.jobs.enqueue({
        reel_id: ctx.reelId,
        scene_id: asset.scene_id,
        asset_id: asset.id,
        type: "trim",
        payload: { base_version_id: asset.current_version_id, start_s: trim.start_s, end_s: trim.end_s },
      });
      return { job };
    },
    async revertPrompt() {
      throw new Error("trim has no prompts to revert");
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
      if (!path) throw new Error(`asset_version ${assetVersionId} has no storage_path`);
      return ctx.storage.signedUrl("assets", path);
    },
    async history({ assetId }) {
      if (!assetId) return [];
      return assetHistory(ctx.supa, assetId);
    },
  };
}
