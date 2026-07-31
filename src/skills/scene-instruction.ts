/**
 * scene-instruction (spec §5 family): writes the SYSTEM PROMPT that scene-brain
 * will be run with for one reel — the editable instruction stored in
 * `reel_config.scene_prompt`.
 *
 * This is the only skill in the pipeline whose output is another skill's
 * instruction rather than a generation prompt, and that changes two things.
 *
 * 1. IT MUST NOT DROP THE HARD RULES. src/stages/scene's enforceRules() and
 *    sceneBrain()'s post-call re-assertion both repair the structural
 *    invariants afterwards, so an instruction that omits them cannot break the
 *    pipeline — it just makes scene-brain plan in ignorance of rules it will
 *    then be silently forced to obey, which produces a worse shot list with no
 *    visible symptom. The rules are therefore restated as non-negotiable
 *    content of the OUTPUT, not merely as context.
 *
 * 2. IT IS DELIBERATELY NOT GIVEN THE MODEL CONSTRAINTS. Every other skill here
 *    receives them; this one must not. `scene_prompt` persists across model
 *    changes — a user can switch b-roll model or resolution at any time — so an
 *    instruction that had baked "clips are 8 seconds" into its prose would go
 *    quietly stale the moment they did, and would then contradict the real
 *    constraint block that scene-brain.ts appends fresh on every call. Keeping
 *    durations and frame rules out of this text is what lets the two stay in
 *    step: the instruction carries craft, the appended block carries limits.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import type { SceneInstructionInput, SceneInstructionOutput } from "./types";

const outputSchema = z.object({ instruction: z.string().min(1) });

const SYSTEM_PROMPT = [
  "You are writing the SYSTEM PROMPT that another AI — the scene-brain skill — will be given when it plans the shot list for one specific reel.",
  "You are NOT writing scenes. You are writing the instruction that will produce them.",
  "You are given the pipeline's current instruction as your baseline, plus this reel's brief and brand. Return a replacement instruction specialised to this reel: the shot vocabulary, pacing, and visual register this particular product and brand actually call for.",
  "",
  "THE INSTRUCTION YOU RETURN MUST STILL CONTAIN, IN SUBSTANCE:",
  "- Only use type='avatar' scenes when avatar_enabled is true; otherwise every scene is 'broll'.",
  "- Avatar scenes always have transition_to_next='hard_cut'.",
  "- The last scene has transition_to_next=null.",
  "- Every other scene's transition_to_next is 'continuous' or 'hard_cut', chosen deliberately.",
  "- sum(seconds) aims at total_seconds_target as a soft target, not an exact requirement.",
  "- description is a visual shot description only — never dialogue, voiceover, on-screen text, captions or audio direction. The pipeline is silent.",
  "- description is handed verbatim to an image skill (which generates the frame) and a motion skill (which animates it), so it must carry BOTH a concrete composition and a clear movement.",
  "Omitting any of these makes the shot list worse without making it fail: the pipeline repairs the structural rules in code afterwards, so scene-brain would simply be planning blind to constraints it is then forced to obey.",
  "",
  "DO NOT write anything about the generation models' limits — durations, clip lengths, resolutions, aspect ratios, or first/last-frame rules. A separate block carrying those is appended to your instruction automatically, resolved for whichever models the reel currently uses. Your text outlives model changes; theirs does not. Numbers you hardcode here go stale and then contradict the real ones.",
  "DO NOT bake this reel's specific topic or product details into the instruction as if they were rules — the brief is supplied separately at run time. Specialise the CRAFT: which shot types, lighting, textures, pacing and framing serve a brand and product like this one.",
  "Keep the register and shape of the baseline: plain imperative instruction lines, grouped under short headings. Aim for a similar length — this is read on every generation, so a line that does not change what gets written is a line to cut.",
  "Return the instruction text only — no commentary, no preamble, no markdown code fence.",
].join("\n");

export async function sceneInstruction(
  input: SceneInstructionInput,
  onUsage?: LlmUsageSink,
  model?: string,
  apiKey?: string
): Promise<SceneInstructionOutput> {
  const userPrompt = JSON.stringify({
    topic: input.topic,
    topic_description: input.topic_description ?? null,
    brand: input.brand,
    avatar_enabled: input.avatar_enabled,
    total_seconds_target: input.total_seconds_target,
    current_instruction: input.current_instruction,
  });

  const result = await callLlmJson({
    system: SYSTEM_PROMPT,
    prompt: `Write the scene-brain instruction for this reel:\n${userPrompt}\n\nRespond as JSON: { "instruction": string }`,
    schema: outputSchema,
    onUsage,
    model,
    apiKey,
  });

  return { instruction: result.instruction.trim() };
}
