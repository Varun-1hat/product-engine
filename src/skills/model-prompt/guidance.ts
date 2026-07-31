/**
 * Resolves the per-MODEL prompt-writing guidance that gets injected into the
 * orchestrator LLM's system prompt, plus the stable model id that prompt was
 * written for.
 *
 * Why per-model and not per-provider: the veo adapter alone fronts four Google
 * models whose prompt semantics genuinely differ (end-frame interpolation on
 * 3.1 standard/fast, none on lite, no duration control at all on omni), and the
 * two music models want near-opposite prompt shapes — Eleven Music rewards
 * genre+instrumentation+BPM prose and needs an explicit "instrumental only",
 * while Lyria wants 3-6 terse descriptors and treats BPM as session config.
 * Collapsing either pair to one blob would lose the optimisation.
 *
 * Each model's guidance lives beside that model's payload shaping in
 * src/skills/model-prompt/<model>.ts — one truth file per model. Update it
 * there when provider docs change, and bump `verified_on` in the header.
 */
import { VEO_CONFIG, ELEVENLABS_CONFIG, LYRIA_CONFIG, NANO_BANANA_CONFIG } from "@/src/adapters/config";
import { isVeoVariant } from "@/src/adapters/video_broll/veoCapabilities";
import { NANO_BANANA_PROMPT_GUIDANCE } from "./nano_banana";
import { VEO_PROMPT_GUIDANCE } from "./veo";
import { HIGGSFIELD_PROMPT_GUIDANCE } from "./higgsfield";
import { HEYGEN_PROMPT_GUIDANCE } from "./heygen";
import { ELEVENLABS_PROMPT_GUIDANCE } from "./elevenlabs";
import { LYRIA_PROMPT_GUIDANCE } from "./lyria";
import { constraintsFor, renderConstraintsForPrompt, type ModelConstraints, type ReelModelContext } from "./constraints";

export type { ModelConstraint, ModelConstraints, ReelModelContext, ConstraintSeverity } from "./constraints";

/**
 * Surfaced next to a stored prompt when the model it was written for is no
 * longer the model that will run it — e.g. a scene flipped from Veo to
 * Higgsfield after its prompt was generated.
 *
 * Deliberately advisory. The prompt still generates; it is just written to the
 * wrong model's strengths (a Veo prompt landing on Higgsfield carries an
 * end-frame transition Higgsfield cannot honour, and a `Negative:` line that
 * model has no field for). The UI offers "leave as is" or "re-optimise", and
 * never rewrites a prompt on its own — a human may have edited it.
 */
export interface PromptStaleness {
  written_for: string;
  will_run_on: string;
  message: string;
}

/**
 * `storedId` comes from prompt_versions.metadata.target_model (or
 * reel_config.music_prompt_target_model). Null/absent means no claim was ever
 * recorded — hand-typed, or written before per-model optimisation existed — so
 * there is nothing to contradict and no warning is shown.
 */
export function promptStaleness(storedId: string | null | undefined, current: TargetModel | null): PromptStaleness | null {
  if (!storedId || !current || storedId === current.id) return null;
  const writtenFor = labelForModelId(storedId) ?? storedId;
  return {
    written_for: writtenFor,
    will_run_on: current.label,
    message: `This prompt was optimised for ${writtenFor} but will run on ${current.label}. It will still generate — re-optimise to rewrite it for ${current.label}, or leave it as is.`,
  };
}

/** Reverse lookup so the warning can name the old model even after a switch. */
function labelForModelId(id: string): string | null {
  for (const [variant, modelId] of Object.entries(VEO_CONFIG.models)) {
    if (modelId === id) return VEO_LABELS[variant] ?? null;
  }
  if (id === NANO_BANANA_CONFIG.model) return "Nano Banana (Gemini 2.5 Flash Image)";
  if (id === ELEVENLABS_CONFIG.model) return "ElevenLabs Music";
  if (id === LYRIA_CONFIG.model) return "Lyria RealTime";
  if (id === HIGGSFIELD_MODEL_ID) return "Higgsfield DoP";
  if (id === HEYGEN_MODEL_ID) return "HeyGen Cinematic Avatar";
  return null;
}

/** Identifies the exact model a prompt was optimised for. */
export interface TargetModel {
  /** Stable id stored in prompt_versions.metadata.target_model. */
  id: string;
  /** Human label for the staleness warning in the review UI. */
  label: string;
  /** Injected verbatim into the skill's system prompt. */
  guidance: string;
  /**
   * This model's hard limits, resolved against the reel's own settings
   * (./constraints.ts). Separate from `guidance` because they answer a
   * different question — guidance is how to write well FOR the model,
   * constraints are what the model will refuse or silently override — and
   * because they cannot be baked in statically: Veo's duration rule changes
   * with the reel's resolution and with whether a last frame is supplied.
   *
   * A function rather than a value so `targetModelFor()` keeps its current
   * signature and callers that only need an id/label pay nothing.
   */
  constraints(ctx: ReelModelContext): ModelConstraints | null;
}

const HIGGSFIELD_MODEL_ID = "higgsfield-dop";
const HEYGEN_MODEL_ID = "heygen-cinematic-avatar";

const VEO_LABELS: Record<string, string> = {
  standard: "Veo 3.1",
  fast: "Veo 3.1 Fast",
  lite: "Veo 3.1 Lite",
  omni: "Gemini Omni Flash",
};

/**
 * `variant` only matters for veo (reel_config.veo_variant). Unknown
 * provider/variant combinations fall back to the fast tier the same way
 * veoCapabilitiesFor() does, so a stale config row can never throw here.
 */
export function targetModelFor(provider: string, variant?: string): TargetModel | null {
  const constraints = (ctx: ReelModelContext) => constraintsFor(provider, variant, ctx);
  switch (provider) {
    case "nano_banana":
      return {
        id: NANO_BANANA_CONFIG.model,
        label: "Nano Banana (Gemini 2.5 Flash Image)",
        guidance: NANO_BANANA_PROMPT_GUIDANCE,
        constraints,
      };
    case "veo": {
      const key = isVeoVariant(variant) ? variant : "fast";
      return {
        id: VEO_CONFIG.models[key],
        label: VEO_LABELS[key],
        guidance: VEO_PROMPT_GUIDANCE[key],
        // Resolve against the SAME normalised key, so an unknown variant gets
        // the fast tier's guidance and the fast tier's constraints rather than
        // a mismatched pair.
        constraints: (ctx) => constraintsFor(provider, key, ctx),
      };
    }
    case "higgsfield":
      return { id: HIGGSFIELD_MODEL_ID, label: "Higgsfield DoP", guidance: HIGGSFIELD_PROMPT_GUIDANCE, constraints };
    case "heygen":
      return { id: HEYGEN_MODEL_ID, label: "HeyGen Cinematic Avatar", guidance: HEYGEN_PROMPT_GUIDANCE, constraints };
    case "elevenlabs":
      return { id: ELEVENLABS_CONFIG.model, label: "ElevenLabs Music", guidance: ELEVENLABS_PROMPT_GUIDANCE, constraints };
    case "lyria":
      return { id: LYRIA_CONFIG.model, label: "Lyria RealTime", guidance: LYRIA_PROMPT_GUIDANCE, constraints };
    default:
      return null;
  }
}

/**
 * The two halves a skill needs to write for one specific model: how to write
 * for it, and what it will refuse. Every prompt skill composes its system
 * prompt the same way, so this lives here rather than being re-implemented in
 * five `systemFor()` helpers that could drift apart.
 *
 * `ctx` omitted (no reel context to resolve against) degrades to guidance only
 * — the previous behaviour, never an error.
 */
export function targetModelSystemBlock(target: TargetModel, ctx?: ReelModelContext): string {
  const constraints = ctx ? target.constraints(ctx) : null;
  return [
    "The prompt you return is sent to the specific generation model described below. Write it exactly the way that model wants it — its rules override any generic prompt-writing habit you have.",
    "",
    target.guidance,
    ...(constraints ? ["", renderConstraintsForPrompt([constraints])] : []),
  ].join("\n");
}
