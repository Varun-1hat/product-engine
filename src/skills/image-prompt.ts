/**
 * image-prompt (spec §5): one call per DISTINCT image slot (start/end
 * frame of a b-roll scene). Produces a model-agnostic prompt; model-
 * specific syntax is layered on later, inside the adapter, by the
 * corresponding src/skills/model-prompt/* skill.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import type { ImagePromptInput, ImagePromptOutput } from "./types";

const outputSchema = z.object({
  prompt: z.string().min(1),
  reference_paths: z.array(z.string()),
});

const SYSTEM_PROMPT = [
  "You are the image-prompt skill for a short-form product-ad video pipeline.",
  "Write a single generic (model-agnostic) image-generation prompt for ONE image slot",
  "— either the start frame or end frame of a b-roll scene.",
  "Do not include model-specific syntax (aspect-ratio tokens, negative-prompt syntax) — that is added later.",
  "Only choose reference photos from the product photo library when the scene features the product (product_in_scene=true).",
  "When boundary_context is provided, keep continuity with the neighboring shot (matching setting/lighting/subject) so a shared or adjacent frame reads as one continuous motion.",
].join("\n");

export async function imagePrompt(input: ImagePromptInput, onUsage?: LlmUsageSink): Promise<ImagePromptOutput> {
  const userPrompt = JSON.stringify({
    scene: input.scene,
    boundary_context: input.boundary_context ?? null,
    brand: input.brand,
    products: input.scene.product_in_scene ? input.products : [],
  });

  const result = await callLlmJson({
    system: SYSTEM_PROMPT,
    prompt: `Write the image prompt for this slot:\n${userPrompt}\n\nRespond as JSON: { "prompt": string, "reference_paths": string[] }`,
    schema: outputSchema,
    onUsage,
  });

  return {
    prompt: result.prompt,
    reference_paths: input.scene.product_in_scene ? result.reference_paths : [],
  };
}
