/**
 * model-prompt: veo (spec §5). Veo 3.1 takes a `prompt` + an optional
 * dedicated `negativePrompt` field. A generic broll-motion prompt may carry
 * an optional trailing "Negative: ..." convention (set by a human redo or
 * the image-prompt/scene-brain output); this skill splits that into Veo's
 * negativePrompt field and passes aspect/resolution straight through.
 * Called INSIDE src/adapters/video_broll/veo.ts.
 */
export interface VeoPromptOpts {
  aspectRatio: string;
  resolution: string;
}

export interface VeoPayload {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  resolution: string;
}

const NEGATIVE_SUFFIX_RE = /\n?negative:\s*(.+)$/i;

export function modelPromptVeo(genericPrompt: string, opts: VeoPromptOpts): VeoPayload {
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
