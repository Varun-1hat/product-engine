/**
 * scene-brain (brief §9, spec §5): produces an ordered visual shot-list
 * (no dialogue) for a reel. VO seam: a future immutable script is NOT
 * built here (§13).
 */
import { z } from "zod";
import { callLlmJson } from "./llm";
import type { SceneBrainInput, SceneBrainOutput } from "./types";

const sceneSchema = z.object({
  type: z.enum(["avatar", "broll"]),
  product_in_scene: z.boolean(),
  seconds: z.number().positive(),
  transition_to_next: z.enum(["continuous", "hard_cut"]).nullable(),
  description: z.string().min(1),
});

const outputSchema = z.object({ scenes: z.array(sceneSchema).min(1) });

const SYSTEM_PROMPT = [
  "You are the scene-brain skill for a short-form silent product-ad video pipeline.",
  "Produce an ordered visual shot-list (a shot list, NOT a script/voiceover) for a reel.",
  "Hard rules:",
  "- Only ever use type='avatar' scenes when avatar_enabled is true. If avatar_enabled is false, every scene is 'broll'.",
  "- Only set product_in_scene=true when has_products is true.",
  "- Avatar scenes MUST have transition_to_next='hard_cut' (avatar boundaries are always a hard cut).",
  "- The LAST scene in the list MUST have transition_to_next=null.",
  "- For every other scene, transition_to_next is 'continuous' (visually flows into the next shot) or 'hard_cut' — use your best creative judgement.",
  "- sum(seconds) across all scenes should aim at total_seconds_target — this is a soft target, not an exact requirement.",
  "- description is a visual shot description only (camera framing, subject, action, setting) — never dialogue or voiceover text.",
].join("\n");

export async function sceneBrain(input: SceneBrainInput): Promise<SceneBrainOutput> {
  const userPrompt = JSON.stringify({
    topic: input.topic,
    total_seconds_target: input.total_seconds_target,
    avatar_enabled: input.avatar_enabled,
    has_products: input.has_products,
    brand: input.brand,
  });

  const result = await callLlmJson({
    system: SYSTEM_PROMPT,
    prompt: `Generate the scene list for this reel brief:\n${userPrompt}\n\nRespond as JSON: { "scenes": [ { "type", "product_in_scene", "seconds", "transition_to_next", "description" }, ... ] }`,
    schema: outputSchema,
  });

  // Defensive re-assertion of the hard rules even if the model drifts —
  // these are deterministic constraints the pipeline depends on elsewhere
  // (routing, boundary logic), not just prompting hints.
  const scenes = result.scenes.map((scene, i, arr) => {
    const isLast = i === arr.length - 1;
    const type = input.avatar_enabled ? scene.type : "broll";
    return {
      ...scene,
      type,
      product_in_scene: input.has_products ? scene.product_in_scene : false,
      transition_to_next: isLast ? null : type === "avatar" ? "hard_cut" : scene.transition_to_next,
    } satisfies SceneBrainOutput["scenes"][number];
  });

  return { scenes };
}
