/**
 * Effective-model routing + continuity helpers (§2.4, R2, the "capability-
 * driven continuity" routing rule, §8 routing table). Pure logic, no I/O,
 * so it is independently unit-testable — this is the deterministic core
 * that Stage 4 (image slots), Stage 5 (clip generator selection), Stage 7
 * (outro routing) and Stage 9 (assembly seam trimming) all call through.
 */
import type { Boundary, SceneType } from "@/src/lib/db/enums";

export interface SceneLike {
  id: string;
  position: number;
  type: SceneType;
  transition_to_next: Boundary | null;
  broll_provider_override: string | null;
}

export interface ReelConfigLike {
  broll_provider: string | null;
  outro_provider_override: string | null;
}

/** A capability lookup: does this effective provider support an end frame? */
export type SupportsEndFrameLookup = (provider: string) => boolean;

/** Effective b-roll model for a scene = COALESCE(scene override, reel default). */
export function effectiveBrollModel(
  scene: Pick<SceneLike, "broll_provider_override">,
  reelConfig: Pick<ReelConfigLike, "broll_provider">
): string | null {
  return scene.broll_provider_override ?? reelConfig.broll_provider ?? null;
}

/** Effective outro model = COALESCE(reel_config.outro_provider_override, reel_config.broll_provider). */
export function effectiveOutroModel(reelConfig: ReelConfigLike): string | null {
  return reelConfig.outro_provider_override ?? reelConfig.broll_provider ?? null;
}

/**
 * effectiveBoundary(sceneN) = 'continuous' iff:
 *   sceneN.type === 'broll' AND sceneN.transition_to_next === 'continuous'
 *   AND sceneN+1 exists and is 'broll'
 *   AND capabilities(effectiveModel(sceneN)).supports_end_frame === true
 * else 'hard_cut'. Avatar boundaries (and boundaries into an avatar scene,
 * or off the last scene) are always hard_cut (edge #7).
 */
export function effectiveBoundary(
  sceneN: SceneLike,
  sceneNPlus1: SceneLike | null | undefined,
  reelConfig: ReelConfigLike,
  supportsEndFrame: SupportsEndFrameLookup
): Boundary {
  if (sceneN.type !== "broll") return "hard_cut";
  if (sceneN.transition_to_next !== "continuous") return "hard_cut";
  if (!sceneNPlus1 || sceneNPlus1.type !== "broll") return "hard_cut";

  const model = effectiveBrollModel(sceneN, reelConfig);
  if (!model) return "hard_cut";
  return supportsEndFrame(model) ? "continuous" : "hard_cut";
}

/**
 * True only when the user's stored intent was 'continuous' but the
 * *effective* boundary was forced to hard_cut purely because the effective
 * model lacks supports_end_frame (edge #6/#7) — drives the "downgraded"
 * hint in the Stage 3/6 UI. False if the user never asked for continuous,
 * and false if it genuinely stayed continuous.
 */
export function isDowngradedToHardCut(
  sceneN: SceneLike,
  sceneNPlus1: SceneLike | null | undefined,
  reelConfig: ReelConfigLike,
  supportsEndFrame: SupportsEndFrameLookup
): boolean {
  if (sceneN.type !== "broll" || sceneN.transition_to_next !== "continuous") return false;
  if (!sceneNPlus1 || sceneNPlus1.type !== "broll") return false;
  return effectiveBoundary(sceneN, sceneNPlus1, reelConfig, supportsEndFrame) === "hard_cut";
}

/**
 * Whether scene N needs an end-image slot generated at all (Stage 4):
 * only if it's b-roll AND its effective model supports an end frame.
 * Start-frame-only models (Higgsfield) skip the end image entirely — cost
 * saved, no needless Nano Banana call (brief §13).
 */
export function needsEndImage(
  scene: SceneLike,
  reelConfig: ReelConfigLike,
  supportsEndFrame: SupportsEndFrameLookup
): boolean {
  if (scene.type !== "broll") return false;
  const model = effectiveBrollModel(scene, reelConfig);
  if (!model) return false;
  return supportsEndFrame(model);
}

export type OutroRoute = { kind: "model"; provider: string } | { kind: "crossfade" };

/**
 * Outro routing (§7 Stage 7, §8 table): if the effective outro model
 * exists AND supports_end_frame, generate via that model (last scene's end
 * frame -> branded end frame); else a deterministic crossfade-to-endframe
 * ($0, no provider call) — covers "no model selected", "model lacks
 * end-frame support" and "all-avatar reel with no b-roll model" alike.
 */
export function resolveOutroRoute(reelConfig: ReelConfigLike, supportsEndFrame: SupportsEndFrameLookup): OutroRoute {
  const model = effectiveOutroModel(reelConfig);
  if (model && supportsEndFrame(model)) return { kind: "model", provider: model };
  return { kind: "crossfade" };
}

/**
 * Pairs up scenes (ordered by position) with their successor, for callers
 * that need to walk every boundary in a reel (Stage 9 assembly, Stage 3/6
 * UI hints).
 */
export function withNextScene<T extends SceneLike>(scenesByPosition: T[]): Array<{ scene: T; next: T | null }> {
  return scenesByPosition.map((scene, i) => ({ scene, next: scenesByPosition[i + 1] ?? null }));
}
