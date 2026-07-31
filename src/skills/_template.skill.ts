/**
 * ===========================================================================
 * TEMPLATE — copy this file to add a new runtime skill.
 * ===========================================================================
 *
 * Copy to `src/skills/<skill-name>.ts` (same directory, so imports carry
 * over), then find/replace `templateSkill`/`TemplateSkill`.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RUNTIME SKILL IS — and what it is NOT
 * ---------------------------------------------------------------------------
 * A runtime skill is one product-internal LLM call: structured input in,
 * zod-validated JSON out. scene-brain, image-prompt, music-prompt,
 * brand-style-lock and brief-judge are the five that exist.
 *
 * Do not confuse it with two neighbours that share the word "skill":
 *   - `skills/providers/<x>/SKILL.md` — static provider facts, read by a human
 *     or a coding agent at build time. No runtime role at all.
 *   - `src/skills/model-prompt/<model>.ts` — pure, synchronous prompt shaping
 *     and per-model guidance text. No LLM call.
 *
 * Four rules:
 *
 *   1. NEVER pick the model. The reel's orchestrator model arrives as the
 *      `model` argument (reel_config.orchestrator_model, bound per reel in
 *      src/lib/context.ts). Pass it through to callLlmJson untouched — a
 *      hardcoded model id silently overrides the user's Stage 2 choice.
 *   2. ALWAYS thread `onUsage` through. That is what turns tokens into
 *      cost_log rows; a skill that drops it makes the reel's spend wrong.
 *   3. ALWAYS zod-validate the output. callLlmJson retries up to 3 times on a
 *      parse/validation failure and then throws — never hand-parse JSON.
 *   4. Take `target?: TargetModel` if the text you return will be sent to a
 *      generation model. That is what makes the output model-optimised rather
 *      than generic.
 */
import { z } from "zod";
import { callLlmJson, type LlmUsageSink } from "./llm";
import type { TargetModel } from "./model-prompt/guidance";
import type { BrandContext } from "./types";

/**
 * Input/output types live in `./types.ts` for real skills, next to the
 * `SkillRegistry` interface that exposes them — they are the contract the
 * stages import, so they belong with the other contracts rather than buried in
 * an implementation file. Defined locally here only to keep the template
 * self-contained.
 */
export interface TemplateSkillInput {
  topic: string;
  /** Longer brief from Stage 2 — nullable because it is optional in the DB. */
  topic_description?: string | null;
  total_seconds_target: number;
  brand: BrandContext;
}

export interface TemplateSkillOutput {
  text: string;
  notes: string[];
}

/**
 * Describe the SHAPE, and constrain what you actually depend on — `.min(1)`
 * turns "the model returned an empty string" into a retry instead of a
 * downstream mystery. Anything not in this schema is dropped, so the caller
 * can never accidentally consume an unvalidated field.
 *
 * Gotcha: do NOT use `.default(...)` here. It gives the schema a different
 * input type from its output type, which no longer matches callLlmJson's
 * `z.ZodType<T>` parameter and fails to compile. Declare the field required
 * and ask for it in the prompt, or make it `.optional()` and handle the
 * absence at the call site.
 */
const outputSchema = z.object({
  text: z.string().min(1),
  notes: z.array(z.string()),
});

/**
 * The system prompt is an array of single-idea lines, same convention as the
 * model-prompt guidance blocks — individually editable, and they survive being
 * concatenated with the per-model guidance below.
 *
 * State the role, the product context that changes the answer, and the output
 * discipline. Leave the JSON-only instruction to callLlmJson: it appends its
 * own, so repeating it here just costs tokens.
 */
const SYSTEM_PROMPT = [
  "You are the template skill for a short-form product-ad video pipeline.",
  "<Say exactly what this skill decides, in one sentence.>",
  "<State the product constraints that change the answer — e.g. the pipeline is silent, reels are 9:16, a human reviews and edits every output before it is used.>",
  "Return only the requested fields — no commentary.",
].join("\n");

/**
 * Appends the target model's own prompt-writing rules, and says plainly that
 * they win. Without the override line the model tends to blend its generic
 * habits with the specific guidance and satisfy neither.
 *
 * Skip this helper entirely for skills whose output is not sent to a
 * generation model (brief-judge scores an asset; nothing downstream renders
 * its text).
 */
function systemFor(target?: TargetModel): string {
  if (!target) return SYSTEM_PROMPT;
  return [
    SYSTEM_PROMPT,
    "",
    "The prompt you return is sent to the specific model described below. Write it exactly the way that model wants it — its rules override any generic prompt-writing habit you have.",
    "",
    target.guidance,
  ].join("\n");
}

/**
 * Argument order is fixed across every skill — `(input, onUsage, model,
 * target)` — because createSkillRegistry() binds `onUsage`/`model` positionally
 * for all of them. Keep it, even if this skill ignores `target`.
 *
 * The user prompt is JSON, not prose: it keeps field names stable, makes nulls
 * explicit, and means adding an input field never re-words a sentence.
 * Normalise `undefined` to `null` so an absent field is visibly absent rather
 * than silently missing from the JSON.
 */
export async function templateSkill(
  input: TemplateSkillInput,
  onUsage?: LlmUsageSink,
  model?: string,
  target?: TargetModel
): Promise<TemplateSkillOutput> {
  const userPrompt = JSON.stringify({
    topic: input.topic,
    topic_description: input.topic_description ?? null,
    total_seconds_target: input.total_seconds_target,
    brand: input.brand,
  });

  return callLlmJson({
    system: systemFor(target),
    prompt: `<One imperative line naming the task>:\n${userPrompt}\n\nRespond as JSON: { "text": string, "notes": string[] }`,
    schema: outputSchema,
    onUsage,
    model,
  });
}

/**
 * ---------------------------------------------------------------------------
 * REGISTER IT — in `./types.ts`, in three places
 * ---------------------------------------------------------------------------
 *   1. Move `TemplateSkillInput`/`TemplateSkillOutput` there.
 *   2. Add the method to the `SkillRegistry` interface:
 *        templateSkill(input: TemplateSkillInput, target?: TargetModel): Promise<TemplateSkillOutput>;
 *      Note what the interface HIDES: call sites never pass `onUsage` or
 *      `model`. That is the whole point of the registry — a stage cannot
 *      forget to bill an LLM call or accidentally use the wrong model.
 *   3. Add it to `createSkillRegistry()`: the dynamic `import("./<name>")` in
 *      the Promise.all, and the bound closure
 *        `templateSkill: (input, target) => templateSkill(input, onUsage, model, target)`.
 *
 * Imports there are dynamic so that importing the registry does not eagerly
 * construct SDK clients before env vars exist — keep that shape.
 *
 * Then call it from a stage as `ctx.skills.templateSkill(input, target)`, with
 * `target` from `targetModelFor(provider, variant)` when the output feeds a
 * generation model. Persist `target.id` alongside the text (prompt_versions
 * .metadata.target_model, or a dedicated column as reel_config.music_prompt
 * _target_model does) so `promptStaleness()` can warn if the model changes
 * later — and null it out whenever a human edits the text by hand, since the
 * claim "optimised for X" stops being true at that moment.
 */
