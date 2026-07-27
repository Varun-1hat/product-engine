/**
 * model-prompt: higgsfield (spec §5, WAVE 2 — low confidence, verify docs
 * before wiring per skills/providers/higgsfield/SKILL.md). Adds the
 * motion_intensity token the (third-party-documented) image-to-video
 * endpoint expects. Called INSIDE src/adapters/video_broll/higgsfield.ts.
 */
export type HiggsfieldMotionIntensity = "low" | "medium" | "high";

export interface HiggsfieldPromptOpts {
  motionIntensity?: HiggsfieldMotionIntensity;
}

export interface HiggsfieldPayload {
  prompt: string;
  motion_intensity: HiggsfieldMotionIntensity;
}

export function modelPromptHiggsfield(genericPrompt: string, opts: HiggsfieldPromptOpts = {}): HiggsfieldPayload {
  return {
    prompt: genericPrompt.trim(),
    motion_intensity: opts.motionIntensity ?? "medium",
  };
}
