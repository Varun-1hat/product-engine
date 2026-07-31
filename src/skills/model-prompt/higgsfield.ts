/**
 * model-prompt: higgsfield (spec §5, WAVE 2 — low confidence, verify docs
 * before wiring per skills/providers/higgsfield/SKILL.md). Adds the
 * motion_intensity token the (third-party-documented) image-to-video
 * endpoint expects. Called INSIDE src/adapters/video_broll/higgsfield.ts.
 */
/**
 * How the orchestrator LLM should WRITE a Higgsfield motion prompt.
 *
 * ⚠️ Consistent with skills/providers/higgsfield/SKILL.md, this is WAVE 2 and
 * LOW CONFIDENCE — drawn from third-party write-ups and community cheat
 * sheets, not official docs. Re-verify against cloud.higgsfield.ai before
 * relying on it. The one well-attested finding is the identity-preservation
 * line, which multiple independent write-ups report as load-bearing.
 * Verified 2026-07-30 (third-party).
 */
import type { ModelConstraints, ReelModelContext } from "./constraints";

export const HIGGSFIELD_PROMPT_GUIDANCE = [
  "TARGET MODEL: Higgsfield DoP (image-to-video). Write for it specifically.",
  "Separate the prompt into two clear parts: (1) what must stay fixed, (2) the motion. Community findings are consistent that blending them causes the model to redraw the subject.",
  "Include the literal line 'preserve the original face, lighting, and geometry' — widely reported as the difference between a camera move and an unwanted re-render of the subject.",
  "Describe motion in terms of Higgsfield's own camera-preset vocabulary, which reinforces the move: 360 orbit, 3D rotation, arc left, arc right, dolly in, dolly out, crane up, handheld follow, static hold.",
  "ONE main camera move per clip — this model is reported to render cleanest with a single move and to smear with compound moves.",
  "State explicitly what should remain static as well as what moves ('the bottle stays fixed centre-frame while the camera arcs left').",
  "START FRAME ONLY — no last-frame interpolation. Do not describe an exact end state the clip must land on; the scene's outgoing boundary is a hard cut.",
  "PHRASE EVERYTHING POSITIVELY — never 'no X' or 'don't X'.",
  "Do NOT write a motion-intensity token, fps, duration or aspect ratio in the text — motion_intensity and the rest are separate API fields.",
  "This model has no negativePrompt field — never emit a trailing 'Negative:' line.",
].join("\n");

/**
 * Constraints (see ./constraints.ts). ⚠️ LOW CONFIDENCE, matching
 * skills/providers/higgsfield/SKILL.md — third-party write-ups, not official
 * docs, and this provider is WAVE 2 and not selectable in the setup UI. Only
 * the two facts the codebase actually routes on are asserted; the numeric
 * limits are deliberately absent rather than guessed, because a wrong duration
 * number in a user-facing panel is worse than a missing one.
 */
export function higgsfieldConstraints(_ctx: ReelModelContext): ModelConstraints {
  return {
    model: "Higgsfield DoP",
    role: "b-roll",
    source: "https://cloud.higgsfield.ai (official docs pending — see skills/providers/higgsfield/SKILL.md)",
    verified_on: "2026-07-26",
    items: [
      {
        label: "Start frame only",
        detail:
          "no last-frame interpolation, so every boundary out of a scene on this model is a hard cut and no end image is generated for it. Do not write a shot that has to land on an exact final composition.",
        severity: "forced",
      },
      {
        label: "Limits not yet verified against official docs",
        detail:
          "duration, resolution and reference-image limits for this model are unconfirmed (third-party sources only). Treat generated durations as approximate and check a clip before committing a reel to it.",
        severity: "quality",
      },
    ],
  };
}

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
