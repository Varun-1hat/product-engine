/**
 * music-prompt (spec §5): writes the Stage-8 music prompt from the reel brief
 * + brand, optimised for the selected music model.
 *
 * This closes the one gap where the pipeline had no LLM step at all — the music
 * prompt was previously typed by hand into reel_config.music_prompt. It stays
 * fully editable; this only supplies the first draft (and the re-run).
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import { targetModelSystemBlock, type TargetModel } from "./model-prompt/guidance";
import type { ReelModelContext } from "./model-prompt/constraints";
import type { MusicPromptInput, MusicPromptOutput } from "./types";

const outputSchema = z.object({ prompt: z.string().min(1) });

const SYSTEM_PROMPT = [
  "You are the music-prompt skill for a short-form product-ad video pipeline.",
  "Write the prompt for the reel's single background music track, from the reel brief and brand context.",
  "The track is a BED under a silent product ad — it must not fight a voiceover (there is none) but it must not demand attention either. No vocals, no lyrics.",
  "Match the energy to the reel's pacing: a fast cut-heavy reel wants drive, a slow product-hero reel wants atmosphere.",
  "Return only the prompt text — no commentary.",
].join("\n");

function systemFor(target?: TargetModel, ctx?: ReelModelContext): string {
  if (!target) return SYSTEM_PROMPT;
  return [SYSTEM_PROMPT, "", targetModelSystemBlock(target, ctx)].join("\n");
}

export async function musicPrompt(
  input: MusicPromptInput,
  onUsage?: LlmUsageSink,
  model?: string,
  target?: TargetModel,
  ctx?: ReelModelContext,
  apiKey?: string
): Promise<MusicPromptOutput> {
  const userPrompt = JSON.stringify({
    topic: input.topic,
    topic_description: input.topic_description ?? null,
    total_seconds_target: input.total_seconds_target,
    scene_count: input.scene_count ?? null,
    brand: input.brand,
  });

  return callLlmJson({
    system: systemFor(target, ctx),
    prompt: `Write the music prompt for this reel:\n${userPrompt}\n\nRespond as JSON: { "prompt": string }`,
    schema: outputSchema,
    onUsage,
    model,
    apiKey,
  });
}
