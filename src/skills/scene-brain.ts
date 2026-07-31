/**
 * scene-brain (brief §9, spec §5): produces an ordered visual shot-list
 * (no dialogue) for a reel. VO seam: a future immutable script is NOT
 * built here (§13).
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import { renderConstraintsForPrompt } from "./model-prompt/constraints";
import type { SceneBrainInput, SceneBrainOutput } from "./types";

const sceneSchema = z.object({
  type: z.enum(["avatar", "broll"]),
  seconds: z.number().positive(),
  transition_to_next: z.enum(["continuous", "hard_cut"]).nullable(),
  description: z.string().min(1),
});

const outputSchema = z.object({ scenes: z.array(sceneSchema).min(1) });

/**
 * Exported so the scene page can seed its editable copy with the real default.
 *
 * The craft half of this is not decoration. `description` is the ONLY thing
 * this stage produces, and it is consumed verbatim by two later skills — the
 * image skill that composes the frame and the motion skill that animates it.
 * Detail omitted here cannot be recovered downstream: both consumers can only
 * elaborate on what they were given, so a vague description produces a vague
 * frame AND vague motion, and the reel is weak for reasons that never surface
 * as an error. Telling the model what its output feeds is the single
 * highest-leverage line in the whole pipeline.
 */
export const SCENE_BRAIN_SYSTEM_PROMPT = [
  "You are the scene-brain skill for a short-form silent product-ad video pipeline.",
  "Produce an ordered visual shot-list (a shot list, NOT a script/voiceover) for a reel.",
  "",
  "WHAT EACH DESCRIPTION BECOMES — this is why the writing matters here more than anywhere else:",
  "- It is handed verbatim to an image skill that generates this scene's start (and sometimes end) FRAME.",
  "- It is handed verbatim to a motion skill that writes the prompt animating that frame into the clip.",
  "Each description therefore has to carry BOTH a concrete composition and a clear movement. Neither consumer can recover detail you leave out — they can only elaborate on what you give them.",
  "",
  "WRITING A GOOD DESCRIPTION:",
  "- Name the framing, the subject, what moves, and the setting. 'Slow push-in on the matte-black bottle standing on wet slate, water beading down its side, cool overcast light raking from the left' — not 'the product looks premium'.",
  "- ONE clear action per scene. Two competing actions read as a jump cut once animated.",
  "- Be specific about light and surface. They are what make a product shot look expensive, and they are what let neighbouring shots read as the same place.",
  "- Vary the framing across the reel — wide establishing, mid, macro detail. A reel of near-identical mid-shots is the most common failure mode.",
  "- Keep the product itself consistent: describe its material, colour and form the same way in every scene it appears, so the frames do not drift apart.",
  "- Never write dialogue, voiceover, on-screen text, captions or audio direction. This pipeline is silent, strips audio, and adds its own branded end card.",
  "",
  "Hard rules:",
  "- Only ever use type='avatar' scenes when avatar_enabled is true. If avatar_enabled is false, every scene is 'broll'.",
  "- Avatar scenes MUST have transition_to_next='hard_cut' (avatar boundaries are always a hard cut).",
  "- The LAST scene in the list MUST have transition_to_next=null.",
  "- For every other scene, transition_to_next is 'continuous' (the next shot flows visually out of this one, sharing a frame) or 'hard_cut'. Choose deliberately rather than alternating: continuity is worth it where the motion genuinely carries across the cut, and on some models it also commits that scene to a longer render — see the model constraints below.",
  "- sum(seconds) across all scenes should aim at total_seconds_target — this is a soft target, not an exact requirement.",
  "- Give each scene the seconds its action actually needs, informed by the lengths the selected model can produce (below).",
  "- description is a visual shot description only (camera framing, subject, action, setting) — never dialogue or voiceover text.",
].join("\n");

/**
 * How to USE the constraint block that follows it. Separate from the block
 * itself (which states only facts) because this half is scene-brain's job
 * specifically: it is the stage that allocates seconds and transitions, so it
 * is the only one that can spend them well.
 *
 * These are reasoning instructions, not limits — the user's chosen policy is
 * inform-don't-constrain, so nothing here forbids a duration. A 2-second beat
 * that renders as 8 and gets trimmed is a legitimate creative choice; it just
 * has to be a choice, made knowing the cost, rather than an accident.
 */
const CONSTRAINT_USAGE = [
  "HOW TO USE THE CONSTRAINTS BELOW:",
  "- They are facts about the models, not style preferences. A scene that ignores them still generates, but it renders at a length or with a transition you did not choose.",
  "- Where a model rounds a duration up or fixes it outright, the rounded length is what is generated, billed, and then trimmed back. Seconds shorter than the model's floor buy shorter screen time, never a cheaper render.",
  "- So: prefer durations the model can actually produce, and when you deliberately want a beat shorter than the floor, say why in the description (a quick punch-in, a flash cut) rather than picking a short number by default.",
  "- Transitions have a duration cost on some models. If a boundary forces a full-length render, spend it where the continuous motion genuinely carries across the cut, and use hard cuts for short rhythmic beats.",
  "- Never write a duration, aspect ratio or resolution into a scene description. Those are separate API fields; in the text they are ignored and waste prompt budget.",
].join("\n");

export async function sceneBrain(
  input: SceneBrainInput,
  onUsage?: LlmUsageSink,
  model?: string,
  apiKey?: string
): Promise<SceneBrainOutput> {
  const userPrompt = JSON.stringify({
    topic: input.topic,
    topic_description: input.topic_description ?? null,
    total_seconds_target: input.total_seconds_target,
    avatar_enabled: input.avatar_enabled,
    brand: input.brand,
  });

  // The constraint block is APPENDED to the instruction rather than written
  // into it. `system_prompt` is user-editable and REPLACES the built-in
  // default wholesale, so constraints living inside that text would vanish the
  // moment anyone customised or reset it — which is exactly the failure this
  // fixes. Same defensive posture as the post-call rule re-assertion below:
  // the pipeline's non-negotiables do not depend on the editable copy.
  const constraints = renderConstraintsForPrompt(input.model_constraints ?? []);
  const system = [
    input.system_prompt?.trim() || SCENE_BRAIN_SYSTEM_PROMPT,
    ...(constraints ? ["", CONSTRAINT_USAGE, "", constraints] : []),
  ].join("\n");

  const result = await callLlmJson({
    // The hard rules below are re-asserted deterministically after the call,
    // so a user-edited instruction can't break the pipeline's invariants.
    system,
    prompt: `Generate the scene list for this reel brief:\n${userPrompt}\n\nRespond as JSON: { "scenes": [ { "type", "seconds", "transition_to_next", "description" }, ... ] }`,
    schema: outputSchema,
    onUsage,
    model,
    apiKey,
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
      transition_to_next: isLast ? null : type === "avatar" ? "hard_cut" : scene.transition_to_next,
    } satisfies SceneBrainOutput["scenes"][number];
  });

  return { scenes };
}
