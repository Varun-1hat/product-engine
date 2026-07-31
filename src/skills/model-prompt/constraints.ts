/**
 * Per-MODEL generation constraints — the limits the selected models impose on
 * what the pipeline can ask for, resolved against the reel's own settings.
 *
 * WHY THIS EXISTS SEPARATELY FROM `<MODEL>_PROMPT_GUIDANCE`: guidance says how
 * to WRITE for a model; this says what the model will REFUSE or SILENTLY
 * OVERRIDE. Both are per-model facts and live in the same `<model>.ts` file,
 * but they have different audiences and different failure modes. Guidance
 * ignored = a weaker prompt. A constraint ignored = a scene script that asks
 * for 2 seconds from a model that only renders 8, which either errors out or
 * quietly bills 4x what the plan said — and every downstream stage inherits it.
 *
 * WHY IT IS RESOLVED, NOT STATIC: most of these limits are conditional on the
 * reel's own config. Veo renders 4/6/8s normally but exactly 8s at 1080p, and
 * exactly 8s again whenever a last frame or a reference image is supplied. A
 * flat list would have to state every branch and let the reader work out which
 * applies; `constraintsFor()` takes the reel's settings and returns only the
 * ones that are actually in force, already phrased with their consequence.
 *
 * ONE SOURCE, TWO RENDERINGS: `renderConstraintsForPrompt()` produces the block
 * injected into the orchestrator LLM's system prompt (scene-brain and every
 * downstream prompt skill); the UI reads the same `ModelConstraints` structs and
 * renders them as bullets. They can never drift, because there is nothing to
 * keep in step — the setup panel and the LLM are reading the same objects.
 *
 * Kept free of SDK, storage and adapter-config imports so a client component can
 * import it directly and re-resolve on every dropdown change, the same way
 * src/lib/brollModels.ts reads the capability table.
 */
import type { VeoVariant } from "@/src/lib/db/enums";
import { veoConstraints } from "./veo";
import { nanoBananaConstraints } from "./nano_banana";
import { heygenConstraints } from "./heygen";
import { higgsfieldConstraints } from "./higgsfield";
import { elevenLabsConstraints } from "./elevenlabs";
import { lyriaConstraints } from "./lyria";

/**
 * What happens if THE SCRIPT OR PROMPT ignores this constraint. Drives ordering
 * (the UI and the prompt block both lead with `blocking`) and the UI's colour.
 *
 * - `blocking` — the provider rejects the call and nothing is generated.
 * - `forced`   — the call succeeds, but the model overrides what was asked for.
 *   The dangerous class: nothing errors, the bill and the runtime just differ
 *   from the plan.
 * - `quality`  — nothing breaks; the output is worse than it needed to be.
 *
 * Graded against what a scene script or a prompt can actually get WRONG, not
 * against how strict the API field is. A reel's aspect ratio is a rigid
 * enum the provider will reject — but the user picked it in setup and no prompt
 * can violate it, so it is `quality` here (the failure mode is wasting tokens
 * restating it in the text). HeyGen's 4–15s window, by contrast, is something a
 * scene script really can breach, so it is `blocking`. Grading by API strictness
 * instead would push the settings the model cannot control to the top of every
 * list and bury the durations, which is the one thing scene-brain most needs to
 * read first.
 */
export type ConstraintSeverity = "blocking" | "forced" | "quality";

export interface ModelConstraint {
  /** Short noun phrase — the bullet's lead-in in the UI. */
  label: string;
  /**
   * One sentence: the limit AND what it costs to ignore it. Written to be read
   * by both an LLM and a human, so never "1080p is 8s-only" on its own —
   * always the consequence too.
   */
  detail: string;
  severity: ConstraintSeverity;
}

/** Which slot in the pipeline this model fills — the heading it renders under. */
export type ConstraintRole = "b-roll" | "avatar" | "image" | "music";

export interface ModelConstraints {
  /** Human label of the exact model, e.g. "Veo 3.1 Fast". */
  model: string;
  role: ConstraintRole;
  /** Provider doc URL these were transcribed from. */
  source: string;
  /** ISO date the list was last checked against `source`. Bump when re-checked. */
  verified_on: string;
  items: ModelConstraint[];
}

/**
 * The reel settings that decide which conditional limits are in force.
 *
 * `uses_end_frames` / `uses_reference_images` are deliberately reel-level
 * booleans rather than per-scene: at scene-brain time no scene exists yet, so
 * the honest statement is "if you give a scene a continuous boundary, that
 * scene renders at 8s". Per-scene callers (the clip/image prompt skills) narrow
 * them to that one scene's reality.
 */
export interface ReelModelContext {
  aspect_ratio: string;
  resolution: string;
  /** A last frame will be supplied — i.e. at least one continuous boundary is possible. */
  uses_end_frames: boolean;
  /** Product reference photos ride along on the generation calls (src/lib/productRefs.ts). */
  uses_reference_images: boolean;
}

/**
 * Resolves one model's constraints. Mirrors `targetModelFor()` in ./guidance.ts
 * — same (provider, variant) key, same null-for-unknown contract — so a caller
 * that can name a target model can always name its constraints too.
 */
export function constraintsFor(
  provider: string | null | undefined,
  variant: string | null | undefined,
  ctx: ReelModelContext
): ModelConstraints | null {
  switch (provider) {
    case "veo":
      return veoConstraints(isVeoVariant(variant) ? variant : "fast", ctx);
    case "higgsfield":
      return higgsfieldConstraints(ctx);
    case "heygen":
      return heygenConstraints(ctx);
    case "nano_banana":
      return nanoBananaConstraints(ctx);
    case "elevenlabs":
      return elevenLabsConstraints(ctx);
    case "lyria":
      return lyriaConstraints(ctx);
    default:
      return null;
  }
}

/**
 * Local narrowing rather than importing `isVeoVariant` from the adapter layer:
 * this module is imported by client components, and the adapter's copy sits in
 * a file that also exports the capability table. Same fallback tier as
 * `veoCapabilitiesFor()` and `targetModelFor()`, so a stale config row can
 * never throw here either.
 */
function isVeoVariant(value: string | null | undefined): value is VeoVariant {
  return value === "standard" || value === "fast" || value === "lite" || value === "omni";
}

const SEVERITY_ORDER: Record<ConstraintSeverity, number> = { blocking: 0, forced: 1, quality: 2 };

/** Most-consequential first, stable within a severity. Used by both renderings. */
export function sortConstraints(items: ModelConstraint[]): ModelConstraint[] {
  return [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * The block appended to a skill's system prompt.
 *
 * Framed as facts rather than instructions on purpose: an LLM told "keep scenes
 * under 8 seconds" will treat it as a stylistic preference and drift, whereas
 * "this model renders exactly 8 seconds and bills for 8" is a premise it
 * reasons from. The per-skill instruction on what to DO with these lives in the
 * skill (scene-brain allocates around them; the prompt skills write within
 * them) — this function only states the facts.
 */
export function renderConstraintsForPrompt(sets: Array<ModelConstraints | null | undefined>): string {
  const present = sets.filter((s): s is ModelConstraints => !!s && s.items.length > 0);
  if (present.length === 0) return "";

  const blocks = present.map((set) => {
    const lines = sortConstraints(set.items).map((item) => `- ${item.label}: ${item.detail}`);
    return [`${set.role.toUpperCase()} MODEL — ${set.model}:`, ...lines].join("\n");
  });

  return [
    "MODEL CONSTRAINTS — the generation models this reel will actually run on.",
    "These are properties of the models, not preferences, and they are not negotiable by the prompt. Work within them.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
