/**
 * model-prompt: veo (spec §5). Veo 3.1 takes a `prompt` + an optional
 * dedicated `negativePrompt` field. A generic broll-motion prompt may carry
 * an optional trailing "Negative: ..." convention (set by a human redo or
 * the image-prompt/scene-brain output); this skill splits that into Veo's
 * negativePrompt field and passes aspect/resolution straight through.
 * Called INSIDE src/adapters/video_broll/veo.ts.
 *
 * Also the single source of truth for how the orchestrator LLM should WRITE
 * a prompt for each of the four Google b-roll models this adapter fronts
 * (VEO_PROMPT_GUIDANCE) — keyed per model, because their prompt semantics
 * genuinely differ (end-frame interpolation, duration control, resolution).
 * Sources: ai.google.dev/gemini-api/docs/veo + Google Cloud "Ultimate
 * prompting guide for Veo 3.1" (cloud.google.com/blog, verified 2026-07-30).
 */
import type { VeoVariant } from "@/src/lib/db/enums";
import type { ModelConstraint, ModelConstraints, ReelModelContext } from "./constraints";

/**
 * Shared cinematic core for the Veo 3.1 family. The official prompt formula
 * is [Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]
 * and Veo responds to real film vocabulary, so the vocabulary lists below are
 * quoted from Google's guide rather than paraphrased.
 */
const VEO_31_CORE = [
  "TARGET MODEL: Google Veo 3.1 (text+image-to-video). Write for it specifically.",
  "Structure the prompt in Google's documented order: [Cinematography] [Subject] [Action] [Context] [Style & ambiance].",
  "Use real film vocabulary — Veo is trained on it. Camera movement: dolly shot, tracking shot, crane shot, aerial view, slow pan, POV shot. Composition: wide shot, close-up, extreme close-up, low angle, two-shot. Lens/focus: shallow depth of field, wide-angle lens, soft focus, macro lens, deep focus.",
  "ONE camera move per clip. These clips are 4-8s — a second move reads as a jump cut and degrades motion coherence.",
  "PHRASE EVERYTHING POSITIVELY. Never write 'no X' or 'don't X' in the prompt body; describe the desired state instead ('a desolate landscape with no buildings' -> 'an empty windswept plain of bare rock').",
  "SILENT PIPELINE: Veo 3.1 generates native audio but this build strips it at assembly. Do NOT write dialogue, quoted speech, 'SFX:' lines, ambient-noise direction, or music cues — they consume prompt budget, pull the model toward talking-head framing, and are discarded.",
  "Do NOT use timestamp blocks ([00:00-00:02] ...). Those are for multi-shot single generations; one scene here is one continuous shot.",
  "Do NOT write aspect-ratio, resolution, or duration tokens in the text — they are separate API fields.",
].join("\n");

/**
 * Veo's `negativePrompt` is a separate field, so the convention is a trailing
 * "Negative: ..." line that modelPromptVeo() splits out below. Google is
 * explicit that this field takes bare terms, NOT instructions — "no motion
 * blur" is worse than "motion blur", because the negation is tokenized as
 * content. Most community guides get this backwards.
 */
const VEO_NEGATIVE_LINE = [
  "OPTIONAL LAST LINE: `Negative: <comma-separated bare noun phrases>`.",
  "This is lifted verbatim into Veo's dedicated negativePrompt API field, which takes TERMS TO AVOID, not instructions.",
  "Correct: `Negative: motion blur, warped hands, text overlay, watermark, duplicated limbs, flickering light`.",
  "Wrong: `Negative: no motion blur, don't warp the hands` — the words 'no'/'don't' are tokenized as content and weaken the field.",
  "Omit the line entirely when there is nothing specific to suppress.",
].join("\n");

const VEO_31_END_FRAME = [
  VEO_31_CORE,
  "",
  "THIS MODEL INTERPOLATES BETWEEN A START AND AN END FRAME. Both frames are supplied as images, so do NOT re-describe what is already visible in them. Describe the MOTION THAT CONNECTS THEM — the camera path and the subject's change of state from first frame to last.",
  "Good: 'The camera performs a smooth 180-degree arc from the front-facing view around to a rear three-quarter angle, the product rotating with it.'",
  "Bad: 'A white sneaker on a marble plinth in soft studio light.' (that is the frame, not the motion)",
  "",
  VEO_NEGATIVE_LINE,
].join("\n");

const VEO_31_START_FRAME_ONLY = [
  VEO_31_CORE,
  "",
  "THIS MODEL TAKES A START FRAME ONLY — there is no last-frame interpolation. Describe motion flowing OUTWARD from the start frame. Do not describe a specific end state the clip must land on exactly; the model cannot guarantee it and the scene's outgoing boundary is a hard cut.",
  "",
  VEO_NEGATIVE_LINE,
].join("\n");

const OMNI = [
  "TARGET MODEL: Gemini Omni Flash (preview) video generation. Write for it specifically.",
  "Structure: [Cinematography] [Subject] [Action] [Context] [Style & ambiance]. Standard film vocabulary applies (dolly, tracking, slow pan, wide shot, close-up, shallow depth of field).",
  "CONSTRAINTS THAT CHANGE HOW YOU WRITE: 720p only, START FRAME ONLY (no end-frame interpolation), and NO DURATION CONTROL — the model returns whatever length it chooses and Stage 6 trims it.",
  "Because length is not controllable, FRONT-LOAD the motion: the essential movement must read in the first ~2 seconds, since the tail may be trimmed away. Keep it to one simple, continuous camera move.",
  "Because it is 720p, avoid prompting for fine texture detail or tiny on-frame text — it will not resolve. Favour bold shapes, strong silhouettes and clear contrast.",
  "Prefer positive phrasing, but note this model is the EXCEPTION to the pipeline's positive-only rule: Google document that negative prompts are unsupported as a field and that you should 'put your negatives in the regular prompt: e.g., \"Do not do X\"'. Use that sparingly, for a specific artefact you actually need suppressed.",
  "SILENT PIPELINE: no dialogue, no 'SFX:' lines, no ambient-audio or music direction.",
  "This model has NO negativePrompt field — never emit a trailing 'Negative:' line (it would be rendered as visible prompt body). Put the negation inline instead, per the line above.",
].join("\n");

/** Per-model prompt-writing guidance, mirroring VEO_VARIANT_CAPABILITIES. */
export const VEO_PROMPT_GUIDANCE: Record<VeoVariant, string> = {
  standard: VEO_31_END_FRAME,
  fast: VEO_31_END_FRAME,
  lite: VEO_31_START_FRAME_ONLY,
  omni: OMNI,
};

/**
 * ---------------------------------------------------------------------------
 * CONSTRAINTS (see ./constraints.ts for why these are separate from guidance)
 * ---------------------------------------------------------------------------
 * Transcribed from the `Veo model parameters` table at
 * ai.google.dev/gemini-api/docs/veo (verified 2026-07-30). The load-bearing
 * rows, quoted:
 *
 *   durationSeconds — `"4"`, `"6"`, `"8"`. *Must be "8" when using extension,
 *                     reference images or with 1080p and 4k resolutions*
 *   resolution      — `"720p"` (default), `"1080p"` (only supports 8s
 *                     duration), `"4k"` (only supports 8s duration)
 *   aspectRatio     — `"16:9"` (default), `"9:16"`
 *   lastFrame       — "The final image for an interpolation video to
 *                     transition. Must be used in combination with the `image`
 *                     parameter." Veo 3.1 models only.
 *   referenceImages — "Up to three images to be used as style and content
 *                     references."
 *
 * The 8s-on-last-frame rule is the one that motivated all of this: it is what
 * turns a 2-second beat with a continuous boundary into an 8-second render,
 * billed at 8 seconds, trimmed back to 2 in Stage 6.
 */
const VEO_DOCS = "https://ai.google.dev/gemini-api/docs/veo";
const VEO_VERIFIED_ON = "2026-07-30";

/** 1080p and 4k are the resolutions Veo renders only at its full 8s length. */
const FULL_DURATION_ONLY = ["1080p", "4k"];

function veo31Constraints(variant: Exclude<VeoVariant, "omni">, ctx: ReelModelContext): ModelConstraints {
  const label = variant === "standard" ? "Veo 3.1" : variant === "fast" ? "Veo 3.1 Fast" : "Veo 3.1 Lite";
  const supportsEndFrame = variant !== "lite";
  const resolutionForcesFull = FULL_DURATION_ONLY.includes(ctx.resolution);
  const items: ModelConstraint[] = [];

  // Lead with whichever duration reality actually applies to this reel, rather
  // than listing every branch and leaving the reader to work out which is live.
  if (resolutionForcesFull) {
    items.push({
      label: "Clip length is fixed at 8s",
      detail: `this reel renders at ${ctx.resolution}, which this model only produces at its full 8-second length. Every scene is generated and billed as 8s no matter what the script asks for, then trimmed back to the scene's seconds in Stage 6 — so seconds below 8 buy shorter screen time, never a cheaper or faster render.`,
      severity: "forced",
    });
  } else {
    items.push({
      label: "Clip length is 4s, 6s or 8s only",
      detail:
        "there is no other generatable length. A scene asking for 5s is generated at 6s and trimmed back; a scene asking for 2s is generated at 4s and trimmed. Billing follows the generated length, not the trimmed one, so anything under 4s costs the same as 4s.",
      severity: "forced",
    });
  }

  if (supportsEndFrame && !resolutionForcesFull) {
    // Sharpened from a rule to a statement of fact when the caller already
    // knows a last frame is being supplied (a specific scene on a continuous
    // boundary), because "this renders 8s" is reasoned from far more reliably
    // than "this would render 8s if".
    items.push(
      ctx.uses_end_frames
        ? {
            label: "This scene renders at 8s",
            detail:
              "it sits on a continuous boundary, so a last frame is supplied and the model runs in interpolation mode — which renders exactly 8 seconds regardless of the requested duration. The clip is billed at 8s and trimmed back to the scene's seconds afterwards.",
            severity: "forced",
          }
        : {
            label: "A continuous boundary forces 8s",
            detail:
              "supplying a last frame puts this model in interpolation mode, which renders exactly 8 seconds regardless of the requested duration. A short scene given a continuous transition is therefore generated and billed as 8s. Short beats are cheapest as hard cuts; continuous flow is worth paying for where the motion genuinely carries across the cut.",
            severity: "forced",
          }
    );
  }

  items.push(
    supportsEndFrame
      ? {
          label: "Start and last frame supported",
          detail:
            "this model interpolates between a supplied first and last image, which is what makes a continuous boundary between two b-roll scenes possible at all.",
          severity: "quality",
        }
      : {
          label: "No last-frame interpolation",
          detail:
            "this model takes a start frame only. Continuous boundaries are silently downgraded to hard cuts, no end images are generated for its scenes, and a shot written to land on an exact final composition will not land on it.",
          severity: "forced",
        }
  );

  items.push({
    label: "Aspect ratio",
    detail: `16:9 or 9:16 only (this reel is ${ctx.aspect_ratio}). It is a separate API field — never write it into the prompt text.`,
    severity: "quality",
  });

  items.push({
    label: "Resolution",
    detail:
      variant === "lite"
        ? "720p or 1080p; 1080p renders at 8s only. No 4k on this tier."
        : "720p, 1080p or 4k; 1080p and 4k render at 8s only.",
    severity: "quality",
  });

  if (ctx.uses_reference_images) {
    // Two separate truths, and stating only one of them would mislead: Google
    // forces 8s when referenceImages are attached, but this build never
    // forwards them to Veo (src/adapters/video_broll/veo.ts sends `image` and
    // `config.lastFrame` and nothing else), so today they cost nothing and do
    // nothing. The actionable half is the last clause.
    items.push({
      label: "Product references are not sent to this model",
      detail:
        "Google accepts up to three reference images and requires 8s whenever they are attached, but this build does not currently forward the reel's product photos to this model. They will not steer the clip — describe the product's material, colour and form in the prompt text instead, and rely on the start frame to carry its identity.",
      severity: "quality",
    });
  }

  items.push({
    label: "Audio is always generated",
    detail:
      "this model produces native audio and it cannot be turned off. Assembly strips it, so any dialogue, SFX or music direction in the prompt is paid for and discarded.",
    severity: "quality",
  });

  return { model: label, role: "b-roll", source: VEO_DOCS, verified_on: VEO_VERIFIED_ON, items };
}

/**
 * Gemini Omni Flash is a different model behind the same adapter, and almost
 * every constraint differs. Sources: ai.google.dev/gemini-api/docs/omni and the
 * gemini-omni-flash model card, which gives the output envelope as
 * "3s-10s (720p, 24 FPS)" (verified 2026-07-30).
 */
function omniConstraints(ctx: ReelModelContext): ModelConstraints {
  return {
    model: "Gemini Omni Flash (preview)",
    role: "b-roll",
    source: "https://ai.google.dev/gemini-api/docs/omni",
    verified_on: VEO_VERIFIED_ON,
    items: [
      {
        label: "Clip length cannot be requested",
        detail:
          "this model exposes no duration parameter. It returns somewhere between 3 and 10 seconds of its own choosing and Stage 6 trims to the scene's seconds — so a scene's duration is a target for the edit, never an instruction to the model. Write the shot so its essential motion reads in the first ~2 seconds, because the tail may be trimmed away.",
        severity: "forced",
      },
      {
        label: "No first-and-last-frame interpolation",
        detail:
          "the docs list video interpolation and video extension as unsupported. Every boundary out of a scene on this model is a hard cut, and no end images are generated for it.",
        severity: "forced",
      },
      {
        label: "720p only, 24 fps",
        detail: `no 1080p or 4k (this reel is set to ${ctx.resolution}). Fine texture and small on-frame text will not resolve — favour bold shapes, strong silhouettes and clear contrast.`,
        severity: "quality",
      },
      {
        label: "Aspect ratio",
        detail: `16:9 or 9:16 only (this reel is ${ctx.aspect_ratio}).`,
        severity: "quality",
      },
      {
        label: "No negative-prompt field",
        detail:
          "unlike Veo 3.1 there is no separate negativePrompt API field, so a trailing 'Negative:' line would be sent as visible prompt body. Google's own guidance for this model is to put negatives in the prompt text instead ('Do not do X') — the one place in this pipeline where that phrasing is correct.",
        severity: "quality",
      },
      {
        label: "Audio is always generated",
        detail: "native audio is produced and stripped at assembly — audio direction in the prompt is wasted budget.",
        severity: "quality",
      },
    ],
  };
}

/** Per-model constraints, mirroring VEO_PROMPT_GUIDANCE and VEO_VARIANT_CAPABILITIES. */
export function veoConstraints(variant: VeoVariant, ctx: ReelModelContext): ModelConstraints {
  return variant === "omni" ? omniConstraints(ctx) : veo31Constraints(variant, ctx);
}

/** What a scene's requested duration actually turns into on this model. */
export interface VeoRenderPlan {
  /** Seconds the model will generate. `null` when the model picks its own length. */
  generated_s: number | null;
  /**
   * The two "forced to full length" causes are kept apart because only one of
   * them is actionable. A last frame forcing 8s can be avoided by making the
   * boundary a hard cut; a resolution forcing 8s cannot be avoided at all, and
   * telling the user to change the transition there would be advice that does
   * nothing. When both apply, the resolution wins — it binds regardless.
   */
  reason: "as_requested" | "rounded_up" | "forced_by_resolution" | "forced_by_end_frame" | "model_chooses";
}

const VEO_31_DURATIONS = [4, 6, 8] as const;

/**
 * Resolves a requested scene duration against this model's real rules, so the
 * scene editor can say what a typed number will actually render as.
 *
 * ⚠️ This currently states the same rule the adapter applies inline at
 * generate() (src/adapters/video_broll/veo.ts — `useEndFrame ||
 * full_duration_only_resolutions.includes(resolution) ? max : billableDurationS`).
 * That duplication is deliberate but temporary: the adapter's copy cannot be
 * imported into a client component (it pulls in @google/genai), and moving the
 * rule into `capabilities()` — where architecture.md's invariant 5 says it
 * belongs, and where `estimate()` would also pick it up — was explicitly
 * deferred. When that happens, both this and the adapter's inline branch should
 * be replaced by the capability-driven answer.
 */
export function veoRenderPlan(
  variant: VeoVariant,
  ctx: ReelModelContext,
  requestedSeconds: number
): VeoRenderPlan {
  if (variant === "omni") return { generated_s: null, reason: "model_chooses" };

  // Resolution first: it binds whatever the boundary does, so reporting the
  // avoidable cause here would suggest a change that cannot help.
  if (FULL_DURATION_ONLY.includes(ctx.resolution)) {
    return { generated_s: 8, reason: "forced_by_resolution" };
  }
  const supportsEndFrame = variant !== "lite";
  if (supportsEndFrame && ctx.uses_end_frames) {
    return { generated_s: 8, reason: "forced_by_end_frame" };
  }

  const rounded = VEO_31_DURATIONS.find((d) => d >= requestedSeconds) ?? 8;
  return { generated_s: rounded, reason: rounded === requestedSeconds ? "as_requested" : "rounded_up" };
}

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
