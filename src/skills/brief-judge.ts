/**
 * brief-judge (spec §5): OPTIONAL, ADVISORY, NON-BLOCKING. Surfaced in the
 * review UI as a hint; never gates generation/advance. This is a text-based
 * gut-check against the brief/brand context (not pixel-level vision
 * grading) — build-last per spec, kept intentionally lightweight.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import type { BriefJudgeInput, BriefJudgeOutput } from "./types";

const outputSchema = z.object({
  score: z.number().min(0).max(1),
  notes: z.string(),
});

const SYSTEM_PROMPT = [
  "You are the brief-judge skill: an OPTIONAL, ADVISORY-ONLY reviewer.",
  "Given a creative brief/brand context and a description of a generated asset, give a rough 0-1 adherence score and short notes.",
  "You are NOT a gate. Your output is only ever shown as a hint in a human review UI and never blocks any action.",
].join("\n");

export async function briefJudge(input: BriefJudgeInput, onUsage?: LlmUsageSink): Promise<BriefJudgeOutput> {
  const userPrompt = JSON.stringify({ brief: input.brief, brand: input.brand, asset: input.assetRef });

  return callLlmJson({
    system: SYSTEM_PROMPT,
    prompt: `Judge this asset against the brief:\n${userPrompt}\n\nRespond as JSON: { "score": number (0-1), "notes": string }`,
    schema: outputSchema,
    onUsage,
  });
}
