/**
 * Stage 8 — Music (spec §7 Stage 8, brief §11). Manual upload only — no
 * generation adapter is called (the tts/music stub adapters are the
 * deferred future seam, §3.4/§13). One track -> music/ bucket ->
 * reel_config.music_path + music_trim, applied at assembly (Stage 9):
 * trim + fade to length; loop if shorter (brief §10.20). Cost: none.
 */
import { z } from "zod";
import type { StageContext, StageModule, StageState } from "../types";
import { nextStage } from "../types";
import type { ReelConfigRow } from "@/src/lib/db/types";
import type { StageId } from "@/src/lib/db/enums";

export const musicInputSchema = z.object({
  /** Already-uploaded (music/ bucket) path for the new/replacement track — omit to only change the trim. */
  music_storage_path: z.string().optional(),
  music_trim: z
    .object({
      start_s: z.number().nonnegative(),
      end_s: z.number().positive(),
    })
    .optional(),
});
export type MusicInput = z.infer<typeof musicInputSchema>;

export interface MusicOutput {
  reel_config: ReelConfigRow;
}

async function load(ctx: StageContext): Promise<StageState> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  return { stage: "music", data: { reel_config: data as ReelConfigRow } };
}

async function process(input: MusicInput, ctx: StageContext): Promise<MusicOutput> {
  const patch: Record<string, unknown> = {};
  if (input.music_storage_path !== undefined) patch.music_path = input.music_storage_path;
  if (input.music_trim !== undefined) patch.music_trim = input.music_trim;

  const { data, error } = await ctx.supa
    .from("reel_config")
    .update(patch)
    .eq("reel_id", ctx.reelId)
    .select("*")
    .single();
  if (error) throw new Error(`reel_config update failed: ${error.message}`);

  return { reel_config: data as ReelConfigRow };
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
