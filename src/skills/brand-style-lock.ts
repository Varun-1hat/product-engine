/**
 * brand/style-lock (spec §5): rewrites a generic prompt to consistently
 * reflect the brand's visual identity without changing subject/composition.
 */
import { z } from "zod";
import { callLlmJson } from "./llm";
import type { BrandContext } from "./types";

const outputSchema = z.object({ prompt: z.string().min(1) });

const SYSTEM_PROMPT = [
  "You are the brand/style-lock skill.",
  "Rewrite the given image/video generation prompt so it consistently reflects the brand's visual identity",
  "(colors, fonts/mood, tone) WITHOUT changing the scene's subject, action, or composition.",
  "Keep the result concise — it is still a single generic prompt, not model-specific syntax.",
].join("\n");

export async function brandStyleLock(prompt: string, brand: BrandContext, refs: string[] = []): Promise<string> {
  const userPrompt = JSON.stringify({ prompt, brand, reference_paths: refs });

  const result = await callLlmJson({
    system: SYSTEM_PROMPT,
    prompt: `Apply brand/style lock:\n${userPrompt}\n\nRespond as JSON: { "prompt": string }`,
    schema: outputSchema,
  });

  return result.prompt;
}
