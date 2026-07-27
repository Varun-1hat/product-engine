/**
 * Stage 4 image-slot planning (spec §7 Stage 4, §2.4, §11) — pure, no I/O.
 * For each b-roll scene: always a start slot, an end slot ONLY if the
 * scene's effective model supports_end_frame. At a continuous boundary,
 * the end slot of scene N *is* the start slot of scene N+1 — one shared
 * `assets` row, generated once, referenced twice (asset reuse, brief §13).
 * Avatar scenes are skipped entirely (no image slots at all).
 */
import {
  effectiveBoundary,
  effectiveBrollModel,
  needsEndImage,
  type ReelConfigLike,
  type SceneLike,
  type SupportsEndFrameLookup,
} from "@/src/lib/routing";

export interface DistinctImageSlot {
  /** Stable key for this distinct generation — one imagePrompt + one Nano Banana call per key. */
  key: string;
  role: "start" | "end";
  /** The scene whose row "owns" this asset (assets.scene_id) when persisted. */
  primary_scene_id: string;
  /** Every scene this slot's asset is referenced from (length 2 when shared). */
  linked_scene_ids: string[];
  shared: boolean;
  /** Effective b-roll model this slot's image will be generated/used for (start<->its own scene; end<->its own scene). */
  effective_model: string;
}

export function planImageSlots(
  scenesByPosition: SceneLike[],
  reelConfig: ReelConfigLike,
  supportsEndFrame: SupportsEndFrameLookup
): DistinctImageSlot[] {
  const slots: DistinctImageSlot[] = [];
  // Scenes whose start slot was already produced as the shared end-frame of
  // the previous scene — skip generating a separate start slot for them.
  const startAlreadyProduced = new Set<string>();

  for (let i = 0; i < scenesByPosition.length; i++) {
    const scene = scenesByPosition[i];
    if (scene.type !== "broll") continue;

    const model = effectiveBrollModel(scene, reelConfig);

    if (!startAlreadyProduced.has(scene.id)) {
      slots.push({
        key: `${scene.id}:start`,
        role: "start",
        primary_scene_id: scene.id,
        linked_scene_ids: [scene.id],
        shared: false,
        effective_model: model ?? "",
      });
    }

    if (!needsEndImage(scene, reelConfig, supportsEndFrame)) continue;

    const next = scenesByPosition[i + 1] ?? null;
    const boundary = effectiveBoundary(scene, next, reelConfig, supportsEndFrame);

    if (boundary === "continuous" && next) {
      slots.push({
        key: `${scene.id}:end~shared~${next.id}:start`,
        role: "end",
        primary_scene_id: scene.id,
        linked_scene_ids: [scene.id, next.id],
        shared: true,
        effective_model: model ?? "",
      });
      startAlreadyProduced.add(next.id);
    } else {
      slots.push({
        key: `${scene.id}:end`,
        role: "end",
        primary_scene_id: scene.id,
        linked_scene_ids: [scene.id],
        shared: false,
        effective_model: model ?? "",
      });
    }
  }

  return slots;
}

export type { ReelConfigLike, SceneLike, SupportsEndFrameLookup };
