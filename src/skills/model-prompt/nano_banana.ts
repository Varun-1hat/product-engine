/**
 * model-prompt: nano_banana (spec §5). Gemini 2.5 Flash Image takes plain
 * natural-language prompts + inline reference images — no special
 * negative-prompt syntax or motion tokens (that's a video-model concern).
 * Called INSIDE src/adapters/image/nano_banana.ts.
 */
import type { ModelConstraint, ModelConstraints, ReelModelContext } from "./constraints";

/**
 * How the orchestrator LLM should WRITE a prompt for this model. Google's
 * guidance is unusually specific here: Gemini 2.5 Flash Image is tuned for
 * DESCRIPTIVE NARRATIVE prose, not the comma-separated keyword soup that
 * Stable-Diffusion-era models rewarded. Source:
 * ai.google.dev/gemini-api/docs/image-generation (verified 2026-07-30).
 */
export const NANO_BANANA_PROMPT_GUIDANCE = [
  "TARGET MODEL: Google Gemini 2.5 Flash Image ('Nano Banana'). Write for it specifically.",
  "Write ONE flowing descriptive paragraph in natural language. Google is explicit that narrative description outperforms keyword lists for this model — do NOT emit comma-separated tag soup ('8k, hyperrealistic, trending on artstation, masterpiece'), it actively hurts output here.",
  "For a photorealistic shot, follow Google's documented template: 'A photorealistic [shot type] of [subject description] in [setting description]. [Description of the light]. Shot from a [camera angle] with a [lens type].'",
  "For a product-forward shot, use their product template: 'A high-resolution, studio-lit product photograph of [product] on [background/surface]. The lighting is [setup] to [purpose].'",
  "Always state the lighting explicitly — it is the single highest-leverage detail for this model.",
  "Name the camera angle and lens type (e.g. 'low three-quarter angle with an 85mm macro lens'). Vague framing produces vague composition.",
  "PHRASE EVERYTHING POSITIVELY. This model has NO negative-prompt field — a 'no X' clause is read as content and tends to SUMMON X. Describe the clean desired state instead ('an uncluttered seamless white sweep' rather than 'no clutter, no props').",
  "Do NOT write aspect-ratio tokens, resolution tokens, '--ar 9:16', or negative-prompt syntax — aspect ratio is a separate API field and the rest is ignored.",
  "When continuity with a neighbouring shot matters, restate the shared setting, lighting direction and colour temperature in words so the two frames read as one location.",
].join("\n");

/**
 * Constraints (see ./constraints.ts). Sources:
 * ai.google.dev/gemini-api/docs/image-generation and the gemini-2.5-flash-image
 * model card (verified 2026-07-30).
 *
 * Confidence note, kept honest per skills/providers/nano-banana/SKILL.md: the
 * ten supported aspect ratios and the absence of a negative-prompt field are
 * well attested. The maximum input-image count is NOT — Google's model card
 * omits it and the Vertex spec is reported as 3 per prompt, while this build's
 * capability table allows 8. That gap is recorded as a follow-up rather than
 * asserted here, because a wrong hard number in a user-facing panel is worse
 * than an absent one.
 */
export function nanoBananaConstraints(ctx: ReelModelContext): ModelConstraints {
  const items: ModelConstraint[] = [
    {
      label: "One still image per call — no motion",
      detail:
        "this model produces a single frame. It has no concept of duration, and a scene's seconds mean nothing to it: motion is the b-roll model's job, and this frame is only that clip's starting (or ending) composition.",
      severity: "quality",
    },
    {
      label: "No negative-prompt field",
      detail:
        "there is nowhere to put terms to avoid, and a 'no X' clause in the body tends to summon X. Describe the clean desired state instead.",
      severity: "quality",
    },
    {
      label: "Aspect ratio is an API field",
      detail: `set separately by the reel (this reel is ${ctx.aspect_ratio}) — '--ar' tokens and resolution words in the prompt text are ignored and waste budget.`,
      severity: "quality",
    },
    {
      label: "Shared boundary frames must match exactly",
      detail:
        "when one image serves as both the end of a scene and the start of the next, it is generated once. Setting, lighting direction and colour temperature have to be stated in words, because the two shots either read as one location or the seam shows.",
      severity: "quality",
    },
  ];

  if (ctx.uses_reference_images) {
    items.push({
      label: "Reference images supplement, never replace, the description",
      detail:
        "product photos are attached inline, but the published input-image limit for this model is lower than what this build sends, so a reference may be dropped. Always describe the product's material, colour and form in words as well.",
      severity: "quality",
    });
  }

  return {
    model: "Nano Banana (Gemini 2.5 Flash Image)",
    role: "image",
    source: "https://ai.google.dev/gemini-api/docs/image-generation",
    verified_on: "2026-07-30",
    items,
  };
}

export interface NanoBananaPromptOpts {
  aspectRatio: string;
}

export interface NanoBananaPayload {
  prompt: string;
  aspectRatio: string;
}

export function modelPromptNanoBanana(genericPrompt: string, opts: NanoBananaPromptOpts): NanoBananaPayload {
  return {
    prompt: genericPrompt.trim(),
    aspectRatio: opts.aspectRatio,
  };
}
