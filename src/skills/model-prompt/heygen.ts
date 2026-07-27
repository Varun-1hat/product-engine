/**
 * model-prompt: heygen (spec §5). Cinematic Avatar clips are silent — no
 * script/voice (deferred VO seam, brief §11). Strips any dialogue/voiceover
 * bracket directions a human might paste into a redo, keeping only the
 * visual shot brief. Called INSIDE src/adapters/video_avatar/heygen.ts.
 */
export interface HeyGenPromptOpts {
  aspectRatio: string;
  resolution: string;
  durationS: number;
}

export interface HeyGenPayload {
  prompt: string;
}

const DIALOGUE_BRACKET_RE = /\[(dialogue|voiceover|vo|script)[^\]]*\]/gi;

export function modelPromptHeygen(genericPrompt: string, _opts: HeyGenPromptOpts): HeyGenPayload {
  return {
    prompt: genericPrompt.replace(DIALOGUE_BRACKET_RE, "").trim(),
  };
}
