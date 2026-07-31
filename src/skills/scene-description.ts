/**
 * scene-description (spec §5 family, sibling of scene-brain): rewrites ONE
 * scene's visual description in place, leaving every other scene untouched.
 *
 * WHY THIS IS NOT scene-brain: scene-brain invents the whole list, so the only
 * way to use it on one scene is to regenerate all of them and throw the rest
 * away — which is exactly what "Re-run scene-brain" does, and why re-rolling a
 * single weak shot currently costs the user every edit they have made to the
 * other scenes. This skill takes the scene's fixed slot (its position, type,
 * seconds and outgoing transition are decided already) and rewrites only the
 * prose, against its real neighbours.
 *
 * The neighbours are the point. A description regenerated in isolation drifts
 * away from the shots on either side of it — different lighting, a different
 * surface, a product described differently — and continuity is precisely what
 * the frames on a shared boundary depend on. Passing the adjacent descriptions
 * makes the rewrite fit the reel it is going back into.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import { renderConstraintsForPrompt } from "./model-prompt/constraints";
import type { SceneDescriptionInput, SceneDescriptionOutput } from "./types";

const outputSchema = z.object({ description: z.string().min(1) });

/**
 * Deliberately shares the "what this becomes" framing with
 * SCENE_BRAIN_SYSTEM_PROMPT rather than importing it: scene-brain's prompt is
 * user-editable per reel, so reusing it here would make a customised
 * shot-listing instruction silently govern single-scene rewrites too. The craft
 * rules are restated in the one form that applies to rewriting a single shot.
 */
const SYSTEM_PROMPT = [
  "You are the scene-description skill for a short-form silent product-ad video pipeline.",
  "Rewrite ONE scene's visual description. Everything else about the scene is already decided — its position in the reel, whether it is avatar or b-roll, its duration and its outgoing transition are given to you and are not yours to change.",
  "",
  "WHAT THE DESCRIPTION BECOMES:",
  "- It is handed verbatim to an image skill that generates this scene's start (and sometimes end) FRAME.",
  "- It is handed verbatim to a motion skill that writes the prompt animating that frame into the clip.",
  "So it must carry BOTH a concrete composition and a clear movement. Neither consumer can recover detail you leave out.",
  "",
  "RULES FOR THE REWRITE:",
  "- Name the framing, the subject, what moves, and the setting. Be concrete about light and surface — they are what make a product shot look expensive.",
  "- ONE clear action. Two competing actions read as a jump cut once animated.",
  "- FIT THE NEIGHBOURS. The previous and next scenes are given to you. Match the product's described material and colour exactly, and keep the lighting and setting coherent with them unless this shot is deliberately a new location.",
  "- If this scene's outgoing transition is 'continuous', its final moment and the next scene's opening share a frame — end this description where that scene begins.",
  "- Produce a genuinely different shot from the one being replaced. This is a re-roll; returning a paraphrase wastes the call.",
  "- Never write dialogue, voiceover, on-screen text, captions or audio direction. The pipeline is silent and adds its own branded end card.",
  "- Return the description only — no commentary, no scene number, no preamble.",
].join("\n");

export async function sceneDescription(
  input: SceneDescriptionInput,
  onUsage?: LlmUsageSink,
  model?: string,
  apiKey?: string
): Promise<SceneDescriptionOutput> {
  const userPrompt = JSON.stringify({
    topic: input.topic,
    topic_description: input.topic_description ?? null,
    brand: input.brand,
    scene: input.scene,
    previous_scene: input.previous_scene ?? null,
    next_scene: input.next_scene ?? null,
  });

  // Same non-negotiable block scene-brain gets: a rewritten shot still has to be
  // renderable by the model that will run it, and a rewrite is exactly when a
  // description drifts into motion the model cannot produce.
  const constraints = renderConstraintsForPrompt(input.model_constraints ?? []);

  const result = await callLlmJson({
    system: constraints ? `${SYSTEM_PROMPT}\n\n${constraints}` : SYSTEM_PROMPT,
    prompt: `Rewrite the description for this scene:\n${userPrompt}\n\nRespond as JSON: { "description": string }`,
    schema: outputSchema,
    onUsage,
    model,
    apiKey,
  });

  return { description: result.description.trim() };
}
