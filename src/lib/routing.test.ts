import { describe, expect, it } from "vitest";
import {
  effectiveBrollModel,
  effectiveOutroModel,
  effectiveBoundary,
  isDowngradedToHardCut,
  needsEndImage,
  resolveOutroRoute,
  withNextScene,
  type SceneLike,
} from "./routing";

// Veo supports end frame, Higgsfield does not — matches §14.2/§14.5.
const supportsEndFrame = (provider: string) => provider === "veo";

function scene(overrides: Partial<SceneLike> = {}): SceneLike {
  return {
    id: "scene-1",
    position: 0,
    type: "broll",
    transition_to_next: null,
    broll_provider_override: null,
    ...overrides,
  };
}

describe("effectiveBrollModel", () => {
  it("prefers the scene override over the reel default", () => {
    expect(
      effectiveBrollModel({ broll_provider_override: "higgsfield" }, { broll_provider: "veo" })
    ).toBe("higgsfield");
  });

  it("falls back to the reel default when there is no override", () => {
    expect(effectiveBrollModel({ broll_provider_override: null }, { broll_provider: "veo" })).toBe("veo");
  });

  it("is null when neither is set (e.g. all-avatar reel, no b-roll model chosen)", () => {
    expect(effectiveBrollModel({ broll_provider_override: null }, { broll_provider: null })).toBeNull();
  });
});

describe("effectiveOutroModel", () => {
  it("prefers outro_provider_override over broll_provider", () => {
    expect(effectiveOutroModel({ broll_provider: "veo", outro_provider_override: "higgsfield" })).toBe(
      "higgsfield"
    );
  });

  it("falls back to broll_provider when no override", () => {
    expect(effectiveOutroModel({ broll_provider: "veo", outro_provider_override: null })).toBe("veo");
  });

  it("is null when neither is set", () => {
    expect(effectiveOutroModel({ broll_provider: null, outro_provider_override: null })).toBeNull();
  });
});

describe("effectiveBoundary — capability-driven continuity (routing rule)", () => {
  it("is continuous when broll->broll, intent continuous, and the effective model supports an end frame", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "broll" });
    expect(effectiveBoundary(a, b, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(
      "continuous"
    );
  });

  it("is forced hard_cut when the effective model lacks supports_end_frame (Higgsfield)", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "broll" });
    expect(
      effectiveBoundary(a, b, { broll_provider: "higgsfield", outro_provider_override: null }, supportsEndFrame)
    ).toBe("hard_cut");
  });

  it("a per-scene override to a non-end-frame model forces hard_cut even if the reel default supports it", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous", broll_provider_override: "higgsfield" });
    const b = scene({ id: "b", type: "broll" });
    expect(effectiveBoundary(a, b, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(
      "hard_cut"
    );
  });

  it("avatar scenes are always hard_cut regardless of transition_to_next", () => {
    const a = scene({ id: "a", type: "avatar", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "broll" });
    expect(effectiveBoundary(a, b, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(
      "hard_cut"
    );
  });

  it("a boundary into an avatar scene is hard_cut even if the b-roll scene intends continuous", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "avatar" });
    expect(effectiveBoundary(a, b, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(
      "hard_cut"
    );
  });

  it("the last scene (no successor) is hard_cut", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: null });
    expect(effectiveBoundary(a, null, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(
      "hard_cut"
    );
  });

  it("is hard_cut when there is no effective model at all", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "broll" });
    expect(effectiveBoundary(a, b, { broll_provider: null, outro_provider_override: null }, supportsEndFrame)).toBe(
      "hard_cut"
    );
  });
});

describe("isDowngradedToHardCut", () => {
  it("is true when intent was continuous but the effective model lacks end-frame support", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "broll" });
    expect(
      isDowngradedToHardCut(a, b, { broll_provider: "higgsfield", outro_provider_override: null }, supportsEndFrame)
    ).toBe(true);
  });

  it("is false when the user never asked for continuous", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "hard_cut" });
    const b = scene({ id: "b", type: "broll" });
    expect(
      isDowngradedToHardCut(a, b, { broll_provider: "higgsfield", outro_provider_override: null }, supportsEndFrame)
    ).toBe(false);
  });

  it("is false when it genuinely stayed continuous", () => {
    const a = scene({ id: "a", type: "broll", transition_to_next: "continuous" });
    const b = scene({ id: "b", type: "broll" });
    expect(
      isDowngradedToHardCut(a, b, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)
    ).toBe(false);
  });
});

describe("needsEndImage — Stage 4 capability-driven image slots", () => {
  it("is true for a broll scene on an end-frame-capable model (Veo)", () => {
    const a = scene({ type: "broll" });
    expect(needsEndImage(a, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(true);
  });

  it("is false for a start-frame-only model (Higgsfield) — cost saved, no needless Nano Banana call", () => {
    const a = scene({ type: "broll" });
    expect(
      needsEndImage(a, { broll_provider: "higgsfield", outro_provider_override: null }, supportsEndFrame)
    ).toBe(false);
  });

  it("is false for avatar scenes (Stage 4 skips avatar scenes entirely)", () => {
    const a = scene({ type: "avatar" });
    expect(needsEndImage(a, { broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toBe(false);
  });

  it("is false when there is no effective model", () => {
    const a = scene({ type: "broll" });
    expect(needsEndImage(a, { broll_provider: null, outro_provider_override: null }, supportsEndFrame)).toBe(false);
  });
});

describe("resolveOutroRoute", () => {
  it("routes to the model when the effective outro model supports an end frame", () => {
    expect(resolveOutroRoute({ broll_provider: "veo", outro_provider_override: null }, supportsEndFrame)).toEqual({
      kind: "model",
      provider: "veo",
    });
  });

  it("falls back to crossfade when the effective outro model lacks end-frame support", () => {
    expect(
      resolveOutroRoute({ broll_provider: "higgsfield", outro_provider_override: null }, supportsEndFrame)
    ).toEqual({ kind: "crossfade" });
  });

  it("falls back to crossfade when there is no b-roll model at all (all-avatar reel)", () => {
    expect(resolveOutroRoute({ broll_provider: null, outro_provider_override: null }, supportsEndFrame)).toEqual({
      kind: "crossfade",
    });
  });

  it("an outro override can upgrade an otherwise non-capable default to a model route", () => {
    expect(
      resolveOutroRoute({ broll_provider: "higgsfield", outro_provider_override: "veo" }, supportsEndFrame)
    ).toEqual({ kind: "model", provider: "veo" });
  });
});

describe("withNextScene", () => {
  it("pairs each scene with its successor, last scene paired with null", () => {
    const scenes = [scene({ id: "a", position: 0 }), scene({ id: "b", position: 1 }), scene({ id: "c", position: 2 })];
    const pairs = withNextScene(scenes);
    expect(pairs.map((p) => [p.scene.id, p.next?.id ?? null])).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["c", null],
    ]);
  });
});
