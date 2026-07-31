import { describe, expect, it } from "vitest";
import { planImageSlots } from "./plan";
import type { SceneLike } from "@/src/lib/routing";

const supportsEndFrame = (provider: string) => provider === "veo";

function scene(overrides: Partial<SceneLike>): SceneLike {
  return {
    id: "scene",
    position: 0,
    type: "broll",
    transition_to_next: null,
    broll_provider_override: null,
    ...overrides,
  };
}

describe("planImageSlots — Stage 4 shared-frame lineage", () => {
  it("all-avatar reel: no image slots at all (Stage 4 no-op)", () => {
    const scenes = [scene({ id: "a", type: "avatar" }), scene({ id: "b", type: "avatar" })];
    const slots = planImageSlots(scenes, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame);
    expect(slots).toEqual([]);
  });

  it("a single b-roll scene on Veo (hard_cut, last scene) gets a start AND end slot, neither shared", () => {
    const scenes = [scene({ id: "a", type: "broll", transition_to_next: null })];
    const slots = planImageSlots(scenes, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame);
    expect(slots).toHaveLength(2);
    expect(slots.find((s) => s.role === "start")).toMatchObject({
      key: "a:start",
      primary_scene_id: "a",
      linked_scene_ids: ["a"],
      shared: false,
    });
    expect(slots.find((s) => s.role === "end")).toMatchObject({
      key: "a:end",
      primary_scene_id: "a",
      linked_scene_ids: ["a"],
      shared: false,
    });
  });

  it("start-frame-only model (Higgsfield) gets a start slot only — no end slot, cost saved", () => {
    const scenes = [scene({ id: "a", type: "broll", transition_to_next: "continuous" }), scene({ id: "b", type: "broll" })];
    const slots = planImageSlots(
      scenes,
      { broll_provider: "higgsfield", outro_provider_override: null },
      supportsEndFrame
    );
    // Scene a: start only (no end — higgsfield lacks supports_end_frame).
    // Scene b: start only (its own start, since a's end wasn't produced/shared).
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.role === "start")).toBe(true);
    expect(slots.map((s) => s.primary_scene_id).sort()).toEqual(["a", "b"]);
  });

  it("a continuous Veo boundary produces ONE shared slot linked to both scenes, not two", () => {
    const scenes = [
      scene({ id: "a", type: "broll", transition_to_next: "continuous" }),
      scene({ id: "b", type: "broll", transition_to_next: null }),
    ];
    const slots = planImageSlots(scenes, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame);

    // a:start, a:end(shared with b:start), b:end. b's start must NOT appear separately.
    expect(slots).toHaveLength(3);

    const shared = slots.find((s) => s.shared);
    expect(shared).toBeTruthy();
    expect(shared?.role).toBe("end");
    expect(shared?.primary_scene_id).toBe("a");
    expect(shared?.linked_scene_ids).toEqual(["a", "b"]);

    // b must not get its own separate start slot — it's covered by the shared one
    // (b is still linked from 2 slots total: the shared end~start, and its own end).
    expect(slots.filter((s) => s.role === "start" && s.linked_scene_ids.includes("b"))).toHaveLength(0);
    expect(slots.find((s) => s.key === "b:start")).toBeUndefined();

    // b still gets its own (non-shared) end slot since it's the last scene.
    const bEnd = slots.find((s) => s.primary_scene_id === "b");
    expect(bEnd?.shared).toBe(false);
    expect(bEnd?.role).toBe("end");
  });

  it("a run of 3 continuous Veo scenes shares 2 boundary frames and produces 4 distinct slots total, not 6", () => {
    const scenes = [
      scene({ id: "a", type: "broll", transition_to_next: "continuous" }),
      scene({ id: "b", type: "broll", transition_to_next: "continuous" }),
      scene({ id: "c", type: "broll", transition_to_next: null }),
    ];
    const slots = planImageSlots(scenes, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame);

    // a:start, a:end~b:start (shared), b:end~c:start (shared), c:end = 4 slots.
    expect(slots).toHaveLength(4);
    expect(slots.filter((s) => s.shared)).toHaveLength(2);
    // Every scene id must be referenced by exactly the slots that touch it,
    // and none of b/c should get their own separate "start" slot.
    expect(slots.find((s) => s.key === "b:start")).toBeUndefined();
    expect(slots.find((s) => s.key === "c:start")).toBeUndefined();
  });

  it("a per-scene override to a non-end-frame model breaks sharing at that boundary only", () => {
    const scenes = [
      scene({ id: "a", type: "broll", transition_to_next: "continuous", broll_provider_override: "higgsfield" }),
      scene({ id: "b", type: "broll", transition_to_next: "continuous" }),
      scene({ id: "c", type: "broll", transition_to_next: null }),
    ];
    const slots = planImageSlots(scenes, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame);

    // a (higgsfield): start only, no end slot at all.
    expect(slots.find((s) => s.key === "a:end")).toBeUndefined();
    // b still gets its own separate start (a's boundary was NOT shared/continuous).
    expect(slots.find((s) => s.key === "b:start")).toBeTruthy();
    // b->c boundary is continuous on veo: shared end/start.
    const bcShared = slots.find((s) => s.shared);
    expect(bcShared?.linked_scene_ids).toEqual(["b", "c"]);
  });

  it("mixed reel: avatar scenes contribute no slots and don't break broll boundary logic around them", () => {
    const scenes = [
      scene({ id: "a", type: "broll", transition_to_next: "hard_cut" }),
      scene({ id: "avatar1", type: "avatar", transition_to_next: "hard_cut" }),
      scene({ id: "b", type: "broll", transition_to_next: null }),
    ];
    const slots = planImageSlots(scenes, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame);
    expect(slots.some((s) => s.linked_scene_ids.includes("avatar1"))).toBe(false);
    // a: start+end (hard_cut, not shared with the avatar scene). b: start+end.
    expect(slots).toHaveLength(4);
  });
});
