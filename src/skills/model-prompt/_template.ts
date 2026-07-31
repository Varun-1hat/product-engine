/**
 * ===========================================================================
 * TEMPLATE — copy this file to add a new model's prompt handling.
 * ===========================================================================
 *
 * Copy to `src/skills/model-prompt/<model>.ts` (same directory, so imports
 * carry over), then find/replace `Template`/`TEMPLATE`.
 *
 * ---------------------------------------------------------------------------
 * ONE FILE PER MODEL, NOT PER PROVIDER — and it owns two different things
 * ---------------------------------------------------------------------------
 * Both halves below are about the same model, which is why they share a file:
 * change the provider docs once and both stay in step.
 *
 *   1. `<MODEL>_PROMPT_GUIDANCE` — how the orchestrator LLM should WRITE a
 *      prompt for this model. Injected verbatim into a runtime skill's system
 *      prompt (src/skills/image-prompt.ts, music-prompt.ts, …) via
 *      `targetModelFor()` in ./guidance.ts. Read at PROMPT-GENERATION time.
 *
 *   2. `modelPromptTemplate()` — how that finished prompt maps onto this
 *      model's actual API fields. Called INSIDE the adapter, at GENERATION
 *      time. Pure and synchronous: no I/O, no LLM call.
 *
 * Per-model rather than per-provider because prompt semantics genuinely differ
 * *within* a provider: the veo adapter fronts four Google models and only two
 * of them interpolate to a last frame, while the two music models want
 * near-opposite prompt shapes (Eleven Music rewards BPM-and-instrumentation
 * prose; Lyria wants 3-6 terse descriptors and treats BPM as session config).
 * Collapsing either pair into one blob loses the optimisation.
 *
 * ---------------------------------------------------------------------------
 * KEEP THE HEADER HONEST
 * ---------------------------------------------------------------------------
 * Sources: <the provider doc URLs the guidance below is derived from>
 * (verified <YYYY-MM-DD> — bump this date whenever you re-check the docs).
 *
 * Guidance written from memory rather than from the provider's own docs is
 * worse than none: it reads authoritative and silently steers every prompt.
 * Research it into `skills/providers/<provider>/SKILL.md` first, then distil.
 */

/**
 * How the orchestrator LLM should WRITE a prompt for this model.
 *
 * Write it as an array of single-idea lines joined with "\n" (not one prose
 * blob) — lines survive being concatenated into a larger system prompt, get
 * individually edited when docs change, and read as rules rather than prose.
 *
 * The shape that has worked across the six existing models:
 *
 *   1. `TARGET MODEL: <exact model name>. Write for it specifically.` — first
 *      line, always. It frames everything after it.
 *   2. The documented prompt STRUCTURE this model expects, in the provider's
 *      own words and order.
 *   3. Vocabulary the model is known to be trained on — quote the provider's
 *      lists rather than paraphrasing them.
 *   4. CONSTRAINTS THAT CHANGE HOW YOU WRITE. Not a spec dump: only limits
 *      with a prompt-level consequence, stated with that consequence. "720p
 *      only, so avoid fine texture and tiny on-frame text" beats "720p".
 *   5. Explicit `Do NOT` lines for anything that wastes prompt budget or is
 *      silently ignored — separate API fields (aspect ratio, duration, BPM),
 *      capabilities the model lacks, output this pipeline discards.
 *   6. One `Good output:` / `Bad output:` pair. It disambiguates more than a
 *      paragraph of rules.
 *
 * The audience is an LLM, so be blunt and imperative. Every line costs tokens
 * on every call: if a line does not change what gets written, delete it.
 */
export const TEMPLATE_PROMPT_GUIDANCE = [
  "TARGET MODEL: Example Model v1 (text+image-to-video). Write for it specifically.",
  "Structure the prompt in the documented order: [Cinematography] [Subject] [Action] [Context] [Style & ambiance].",
  "Use real film vocabulary — this model is trained on it. Camera movement: dolly shot, tracking shot, crane shot, slow pan, POV shot. Composition: wide shot, close-up, low angle. Lens/focus: shallow depth of field, wide-angle lens, soft focus.",
  "ONE camera move per clip. These clips are 4-8s — a second move reads as a jump cut and degrades motion coherence.",
  "PHRASE EVERYTHING POSITIVELY. Never write 'no X' or 'don't X' in the prompt body; describe the desired state instead ('a room with no clutter' -> 'a bare room with clean empty surfaces').",
  "THIS MODEL TAKES A START FRAME ONLY — there is no last-frame interpolation. Describe motion flowing OUTWARD from the start frame; do not describe an exact end state it must land on.",
  "SILENT PIPELINE: this build strips audio at assembly. Do NOT write dialogue, quoted speech, 'SFX:' lines, ambient-noise direction, or music cues — they consume prompt budget and are discarded.",
  "Do NOT write aspect-ratio, resolution, or duration tokens in the text — they are separate API fields.",
  "OPTIONAL LAST LINE: `Negative: <comma-separated bare noun phrases>`. It is lifted verbatim into the dedicated negativePrompt API field, which takes TERMS TO AVOID, not instructions. Correct: `Negative: motion blur, warped hands, watermark`. Wrong: `Negative: no motion blur` — 'no' is tokenized as content and weakens the field. Omit the line when there is nothing to suppress.",
  "Good output: 'Slow dolly-in, wide shot, a matte-black espresso machine on a concrete counter, steam curling upward, morning side-light, shallow depth of field, muted editorial palette.'",
  "Bad output: 'A really nice 9:16 8-second cinematic video of a coffee machine, no blur, with upbeat music.'",
].join("\n");

export interface TemplatePromptOpts {
  aspectRatio: string;
  resolution: string;
}

/** Exactly the fields this model's API takes — nothing generic, nothing extra. */
export interface TemplatePayload {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  resolution: string;
}

/**
 * The `Negative:` trailing-line convention exists because a prompt travels
 * through the system as one string (prompt_versions.text, hand-editable in the
 * review UI) but lands on models with a *separate* negative field. Split it
 * here, at the boundary, so nothing upstream has to know.
 *
 * Drop this regex entirely for models with no negative-prompt field — and say
 * so in the guidance above, so the LLM never emits the line in the first place.
 */
const NEGATIVE_SUFFIX_RE = /\n?negative:\s*(.+)$/i;

/**
 * Maps a generic prompt onto this model's API fields. Pure and synchronous:
 * called inside the adapter on every generate, so it must never do I/O.
 *
 * This is also where you ENFORCE IN CODE anything the model must always be
 * told and that a human editing the prompt must not be able to break — the
 * ElevenLabs adapter appends "instrumental only" here rather than trusting the
 * guidance, because a vocal track is unusable under a product ad.
 */
export function modelPromptTemplate(genericPrompt: string, opts: TemplatePromptOpts): TemplatePayload {
  const match = genericPrompt.match(NEGATIVE_SUFFIX_RE);
  const negativePrompt = match?.[1]?.trim() || undefined;
  const prompt = (match ? genericPrompt.slice(0, match.index) : genericPrompt).trim();

  return {
    prompt,
    negativePrompt,
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution,
  };
}

/**
 * ---------------------------------------------------------------------------
 * REGISTER IT — this file is inert until you do
 * ---------------------------------------------------------------------------
 * In `./guidance.ts`:
 *
 *   1. Import `TEMPLATE_PROMPT_GUIDANCE` and add a `case` to `targetModelFor()`
 *      returning `{ id, label, guidance }`.
 *        - `id` MUST be the stable model id (import it from
 *          src/adapters/config.ts — never retype the string). It is persisted
 *          to prompt_versions.metadata.target_model and is what the staleness
 *          check compares against.
 *        - `label` is what the user reads in the "written for X, will run on Y"
 *          warning.
 *   2. Add the same id -> label pair to `labelForModelId()`, so the warning can
 *      still name this model after the user switches away from it.
 *
 * Skipping step 2 is the usual miss: everything works until someone changes
 * models, and then the warning shows a raw model id instead of a name.
 */
