/**
 * model-prompt: nano_banana (spec §5). Gemini 2.5 Flash Image takes plain
 * natural-language prompts + inline reference images — no special
 * negative-prompt syntax or motion tokens (that's a video-model concern).
 * Called INSIDE src/adapters/image/nano_banana.ts.
 */
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
