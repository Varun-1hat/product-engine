/**
 * image-prompt (spec §5): one call per DISTINCT image slot (start/end
 * frame of a b-roll scene). Produces a model-agnostic prompt; model-
 * specific syntax is layered on later, inside the adapter, by the
 * corresponding src/skills/model-prompt/* skill.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import { targetModelSystemBlock, type TargetModel } from "./model-prompt/guidance";
import type { ReelModelContext } from "./model-prompt/constraints";
import type { ImagePromptInput, ImagePromptOutput } from "./types";

const outputSchema = z.object({
  prompt: z.string().min(1),
});

/**
 * The load-bearing line here is that this is a FRAME, not a photograph.
 * These prompts were producing compositions that are excellent as stills and
 * poor as inputs to a video model — a subject centred and filling the frame
 * leaves a camera push-in nowhere to go, and an end-frame composed as its own
 * hero shot does not read as the resting state of the motion that reached it.
 * The image model cannot know any of that; only this instruction can tell it.
 */
const SYSTEM_PROMPT = [
  "You are the image-prompt skill for a short-form product-ad video pipeline.",
  "Write a single image-generation prompt for ONE image slot — either the start frame or the end frame of a b-roll scene.",
  "",
  "THIS IS A FRAME OF A MOVING SHOT, NOT A STANDALONE PHOTOGRAPH. The still you describe is handed straight to a video model that animates it. Compose for the movement in the scene description: leave the room the camera move needs, and do not centre and fill the frame with a subject the camera is about to push into or arc around.",
  "A 'start' slot is where the movement BEGINS — compose the opening of the motion. An 'end' slot is where it LANDS — compose the resting state the clip resolves to, consistent with having arrived there from the start frame.",
  "When boundary_context is provided, keep continuity with the neighbouring shot — the same setting, lighting direction, colour temperature and subject — so a shared or adjacent frame reads as one continuous motion rather than two separate setups.",
  "Describe the product's material, colour and form in words even when reference images are attached: references are capped and can be dropped, but the text always arrives.",
  "No on-screen text, captions, watermarks, logos-as-text or UI overlays — the pipeline adds its own branded end card.",
].join("\n");

/**
 * Without a target model the prompt stays deliberately model-agnostic (the
 * original behaviour). With one, the model's own documented prompt rules are
 * appended so the stored prompt is already shaped the way that model wants —
 * e.g. Nano Banana wants narrative prose and punishes keyword lists. With a
 * reel context too, that model's hard limits come along (see
 * targetModelSystemBlock) — a start frame written for a scene whose clip model
 * will render 8 seconds needs a composition that survives 8 seconds of motion.
 */
function systemFor(target?: TargetModel, ctx?: ReelModelContext): string {
  if (!target) {
    return `${SYSTEM_PROMPT}\nDo not include model-specific syntax (aspect-ratio tokens, negative-prompt syntax) — that is added later.`;
  }
  return [SYSTEM_PROMPT, "", targetModelSystemBlock(target, ctx)].join("\n");
}

export async function imagePrompt(
  input: ImagePromptInput,
  onUsage?: LlmUsageSink,
  model?: string,
  target?: TargetModel,
  ctx?: ReelModelContext,
  apiKey?: string
): Promise<ImagePromptOutput> {
  const userPrompt = JSON.stringify({
    scene: input.scene,
    boundary_context: input.boundary_context ?? null,
    brand: input.brand,
  });

  const result = await callLlmJson({
    system: systemFor(target, ctx),
    prompt: `Write the image prompt for this slot:\n${userPrompt}\n\nRespond as JSON: { "prompt": string }`,
    schema: outputSchema,
    onUsage,
    model,
    apiKey,
  });

  // The skill never picks references itself — reference_paths is filled only
  // by what the user attaches on the image page (PromptReview).
  return { prompt: result.prompt, reference_paths: [] };
}
