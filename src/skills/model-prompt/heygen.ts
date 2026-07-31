/**
 * model-prompt: heygen (spec §5). Cinematic Avatar clips are silent — no
 * script/voice (deferred VO seam, brief §11). Strips any dialogue/voiceover
 * bracket directions a human might paste into a redo, keeping only the
 * visual shot brief. Called INSIDE src/adapters/video_avatar/heygen.ts.
 */
/**
 * How the orchestrator LLM should WRITE a Cinematic Avatar prompt. HeyGen's
 * `prompt` is a creative brief (1-10,000 chars), NOT a script. The engine
 * behind it (Seedance) has two properties that change the prompt shape versus
 * Veo: the avatar look arrives as an image, so re-describing the person fights
 * the reference; and there is NO negative-prompt field at all, so every
 * constraint must be phrased as a desired positive quality.
 * Sources: developers.heygen.com/cinematic-avatar + HeyGen's own Seedance
 * Avatar Shots prompting guide (community.heygen.com, verified 2026-07-30).
 */
import type { ModelConstraint, ModelConstraints, ReelModelContext } from "./constraints";

export const HEYGEN_PROMPT_GUIDANCE = [
  "TARGET MODEL: HeyGen Cinematic Avatar (Seedance engine), silent. Write for it specifically.",
  "Structure in HeyGen's documented order: Subject -> Action -> Environment -> Camera -> Style -> Constraints.",
  "THE AVATAR LOOK IS SUPPLIED AS AN IMAGE. Do NOT describe the person's face, age, build, hair or clothing — restating what the reference already shows causes identity drift. Describe only what CHANGES: their motion, gesture, and the camera.",
  "Include the literal phrase 'preserve composition and colors' — HeyGen documents it as the lock for visual style against the reference.",
  "Use concrete verbs with intensity ('gestures decisively toward the whiteboard', not 'moves'). Vague adjectives like 'nice' or 'good' are documented failure cases.",
  "ONE camera move only. Vocabulary that works: slow push-in, dolly out, pan left/right, tracking shot, smooth orbit, aerial descent, handheld with slight natural shake, locked-off fixed framing.",
  "SILENT CLIPS — THIS IS ABSOLUTE. Never write a script, quoted dialogue, voiceover text, or a '[dialogue]' / '[vo]' direction. HeyGen's own guidance is that mixing a script with cinematic action degrades quality, and this pipeline has no voice track at all. Describe visual performance only.",
  "NO NEGATIVE PROMPT FIELD EXISTS. Never emit a trailing 'Negative:' line — it would be pasted into the visible prompt body and rendered as content.",
  "Convert every constraint into a positive quality. HeyGen's documented mappings: 'no broken hands' -> 'detailed natural hands, correct finger count'; 'no camera shake' -> 'stable framing, smooth motion'; 'avoid flickering' -> 'consistent lighting, no temporal flicker'; 'don't change the face' -> 'avoid identity drift, consistent appearance'; 'no stiff movement' -> 'physically accurate, natural motion flow'.",
  "For a clip longer than ~10s you may break it into 2-3 time-coded beats ('[0s-4s] ... [4s-10s] ...'), describing the environment once up front and referencing it after. For shorter clips write one continuous shot.",
  "Do NOT write aspect-ratio, resolution or duration tokens — they are separate API fields.",
].join("\n");

/**
 * Constraints (see ./constraints.ts). Transcribed from the Cinematic Avatar
 * parameter table at developers.heygen.com/cinematic-avatar (verified
 * 2026-07-30): prompt "1–10,000 characters describing the shot"; avatar_id
 * "1–3 avatar look IDs"; aspect_ratio "16:9" (default), "9:16", "1:1";
 * resolution "720p" (default) or "1080p"; duration "4–15 seconds, default 10.
 * Omit when auto_duration is true"; references "Up to 3 videos / 9 images",
 * sharing that budget with the avatar looks.
 *
 * The duration row is the one that hard-fails rather than silently overriding:
 * the adapter's validate() turns an out-of-range scene into a violation, so a
 * 2-second avatar scene blocks the clip instead of quietly rendering long.
 */
const HEYGEN_DOCS = "https://developers.heygen.com/cinematic-avatar";

export function heygenConstraints(ctx: ReelModelContext): ModelConstraints {
  const items: ModelConstraint[] = [
    {
      label: "Avatar scenes must be 4–15 seconds",
      detail:
        "this is a hard range, not a preference — an avatar scene shorter than 4s or longer than 15s is rejected before generation and blocks the clip with a validation error. Split a longer avatar beat across consecutive avatar scenes rather than asking for one long one.",
      severity: "blocking",
    },
    {
      label: "Duration is honoured within that range",
      detail:
        "unlike the b-roll models, this one renders the requested length, so avatar seconds are real and cost nothing extra to shorten. Billing is flat per video regardless of length, so a 4s avatar clip and a 15s one cost the same — short avatar scenes waste paid runtime.",
      severity: "quality",
    },
    {
      label: "Silent — no script, no voice",
      detail:
        "the prompt is a shot brief, never dialogue. There is no voice track anywhere in this pipeline, and HeyGen's own guidance is that mixing a script into a cinematic prompt degrades the result.",
      severity: "quality",
    },
    {
      label: "Avatar boundaries are always hard cuts",
      detail:
        "this model takes no first/last frame, so a transition into or out of an avatar scene can never be continuous. Plan avatar scenes as self-contained beats.",
      severity: "forced",
    },
    {
      label: "Aspect ratio and resolution",
      detail: `16:9, 9:16 or 1:1, at 720p or 1080p (this reel is ${ctx.aspect_ratio} ${ctx.resolution}).`,
      severity: "quality",
    },
    {
      label: "Prompt length",
      detail: "1–10,000 characters. Ample — but the look arrives as an image, so re-describing the person causes identity drift rather than adding detail.",
      severity: "quality",
    },
  ];

  if (ctx.uses_reference_images) {
    items.push({
      label: "Reference budget is shared with the avatar looks",
      detail:
        "at most 3 videos and 9 images total across the looks and the product references combined, so product photos compete with the looks for slots rather than adding to them.",
      severity: "quality",
    });
  }

  return { model: "HeyGen Cinematic Avatar", role: "avatar", source: HEYGEN_DOCS, verified_on: "2026-07-30", items };
}

/** HeyGen's documented duration window — the adapter rejects anything outside it. */
export const HEYGEN_MIN_DURATION_S = 4;
export const HEYGEN_MAX_DURATION_S = 15;

/**
 * Unlike the b-roll models this one honours the requested length, so the only
 * question is whether the request is legal at all. Out of range is a hard
 * validation failure, not a silent override — which is why the scene editor
 * flags it as blocking rather than informational.
 */
export function heygenDurationCheck(requestedSeconds: number): { ok: boolean; min: number; max: number } {
  return {
    ok: requestedSeconds >= HEYGEN_MIN_DURATION_S && requestedSeconds <= HEYGEN_MAX_DURATION_S,
    min: HEYGEN_MIN_DURATION_S,
    max: HEYGEN_MAX_DURATION_S,
  };
}

export interface HeyGenPromptOpts {
  aspectRatio: string;
  resolution: string;
  durationS: number;
}

export interface HeyGenPayload {
  prompt: string;
}

const DIALOGUE_BRACKET_RE = /\[(dialogue|voiceover|vo|script)[^\]]*\]/gi;

/**
 * Cinematic Avatar has NO negativePrompt field, so the trailing "Negative: ..."
 * convention that Veo relies on has nowhere to go here — left in place it would
 * be sent as part of the visible prompt body and rendered as content. The
 * guidance tells the orchestrator not to emit one; this drops it deterministically
 * if a human redo or a drifting model adds one anyway (same defensive posture as
 * scene-brain's post-call rule re-assertion).
 */
const NEGATIVE_SUFFIX_RE = /\n?negative:\s*.+$/i;

export function modelPromptHeygen(genericPrompt: string, _opts: HeyGenPromptOpts): HeyGenPayload {
  return {
    prompt: genericPrompt.replace(DIALOGUE_BRACKET_RE, "").replace(NEGATIVE_SUFFIX_RE, "").trim(),
  };
}
