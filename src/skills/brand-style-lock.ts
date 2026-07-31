/**
 * brand/style-lock (spec §5): locks a prompt to the brand's visual identity.
 *
 * In practice this skill is also the pipeline's MOTION/SHOT prompt writer — its
 * only call sites are src/stages/clip (broll_motion, avatar_shot) and
 * src/stages/outro, which hand it a scene description and store what comes back
 * as the prompt the video model actually runs. The system prompt below has to
 * say so, because the previous framing ("rewrite without changing the scene's
 * subject, action, or composition") contradicted the target-model guidance it
 * is concatenated with: Veo's end-frame rules state that both frames are
 * supplied as images and the text must describe ONLY the motion connecting
 * them. The model was being told to preserve the composition description and to
 * omit it in the same prompt. "Keep the shot the director asked for" and
 * "restate that shot in the text" are different instructions, and only the
 * first one was ever meant.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import { targetModelSystemBlock, type TargetModel } from "./model-prompt/guidance";
import type { ReelModelContext } from "./model-prompt/constraints";
import type { BrandContext } from "./types";

const outputSchema = z.object({ prompt: z.string().min(1) });

const SYSTEM_PROMPT = [
  "You are the brand/style-lock skill.",
  "You are given a scene's visual description plus the brand's identity, and you return the FINAL prompt that will be sent to the generation model producing that scene.",
  "Keep the shot the director asked for: do not substitute a different subject, action or framing. Express that same shot in the brand's visual language — palette, materials, lighting mood, tone.",
  "WHICH PARTS OF THE SHOT BELONG IN THE TEXT depends on the target model described below. Some models receive the composition as supplied images and want the text to describe ONLY the motion connecting them; restating the framing there fights the images and costs quality. Follow the target model's rules over any instinct to describe the whole scene.",
  "Return only the prompt text — no commentary, no preamble.",
].join("\n");

/**
 * Without a target model this stays the original generic rewrite. With one, the
 * same call doubles as the model-optimisation pass — no extra LLM call, and the
 * stored prompt is already written the way that specific video model wants it.
 *
 * This is the pipeline's motion/shot prompt (broll_motion, avatar_shot), so it
 * is the call where the clip model's limits bite hardest: whether the shot may
 * describe a landing composition depends on last-frame support, and how much
 * motion the shot should carry depends on the length the model will actually
 * render. `ctx` is what carries those in (see targetModelSystemBlock).
 */
function systemFor(target?: TargetModel, ctx?: ReelModelContext): string {
  if (!target) {
    return `${SYSTEM_PROMPT}\nKeep the result concise — it is still a single generic prompt, not model-specific syntax.`;
  }
  return [SYSTEM_PROMPT, "", targetModelSystemBlock(target, ctx)].join("\n");
}

export async function brandStyleLock(
  prompt: string,
  brand: BrandContext,
  refs: string[] = [],
  onUsage?: LlmUsageSink,
  model?: string,
  target?: TargetModel,
  ctx?: ReelModelContext,
  apiKey?: string
): Promise<string> {
  const userPrompt = JSON.stringify({ prompt, brand, reference_paths: refs });

  const result = await callLlmJson({
    system: systemFor(target, ctx),
    prompt: `Apply brand/style lock:\n${userPrompt}\n\nRespond as JSON: { "prompt": string }`,
    schema: outputSchema,
    onUsage,
    model,
    apiKey,
  });

  return result.prompt;
}
