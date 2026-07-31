/**
 * Pins the duration arithmetic behind the scene editor's render badges
 * (src/lib/modelConstraints.ts `sceneRenderNote`) and the resolution of the
 * constraint sets themselves.
 *
 * Why this is worth a test: these rules are the reason the whole change exists.
 * A scene asking for 2 seconds from a model that renders 8 whenever it
 * interpolates produces no error anywhere — it just returns a longer clip and a
 * 4x bill — so a regression here is silent in exactly the way the bug was.
 *
 * The numbers below trace to ai.google.dev/gemini-api/docs/veo ("durationSeconds
 * … Must be '8' when using extension, reference images or with 1080p and 4k
 * resolutions") and developers.heygen.com/cinematic-avatar ("duration 4–15
 * seconds"), both verified 2026-07-30. Pure functions, no fakes needed.
 */
import { describe, expect, it } from "vitest";
import { reelConstraintSets, sceneBrainConstraintSets, sceneRenderNote, type ReelModelSelection } from "./modelConstraints";

function selection(overrides: Partial<ReelModelSelection> = {}): ReelModelSelection {
  return {
    broll_provider: "veo",
    veo_variant: "fast",
    avatar_enabled: false,
    image_provider: "nano_banana",
    music_provider: null,
    aspect_ratio: "9:16",
    resolution: "720p",
    has_product_references: false,
    ...overrides,
  };
}

describe("sceneRenderNote — b-roll durations (Veo 3.1 family)", () => {
  it("stays silent when the requested seconds are exactly generatable", () => {
    for (const seconds of [4, 6, 8]) {
      expect(sceneRenderNote({ type: "broll", seconds, uses_end_frame: false }, selection())).toBeNull();
    }
  });

  it("reports the rounded-up length, and that billing follows it", () => {
    const note = sceneRenderNote({ type: "broll", seconds: 5, uses_end_frame: false }, selection());
    expect(note?.severity).toBe("forced");
    expect(note?.message).toContain("Renders 6s");
    expect(note?.message).toContain("billed at 6s");
    expect(note?.message).toContain("trimmed to 5s");
  });

  it("rounds a very short scene up to the 4s floor rather than reporting 2s", () => {
    const note = sceneRenderNote({ type: "broll", seconds: 2, uses_end_frame: false }, selection());
    expect(note?.message).toContain("Renders 4s");
  });

  // The originating bug: a continuous boundary puts Veo in interpolation mode,
  // which renders exactly 8s whatever the script asked for.
  it("reports the full 8s when a continuous boundary supplies a last frame", () => {
    const note = sceneRenderNote({ type: "broll", seconds: 2, uses_end_frame: true }, selection());
    expect(note?.severity).toBe("forced");
    expect(note?.message).toContain("Renders 8s");
    expect(note?.message).toContain("interpolation mode");
    // The badge has to name the fix, not just the symptom.
    expect(note?.message).toContain("hard cut");
  });

  it("reports the full 8s at 1080p even with no last frame", () => {
    const note = sceneRenderNote(
      { type: "broll", seconds: 4, uses_end_frame: false },
      selection({ resolution: "1080p" })
    );
    expect(note?.message).toContain("Renders 8s");
    expect(note?.message).toContain("1080p");
  });

  // Both causes apply at once here. Naming the boundary would invite a fix that
  // changes nothing, since 1080p forces the full length on its own.
  it("blames the resolution, not the boundary, when both force 8s", () => {
    const note = sceneRenderNote(
      { type: "broll", seconds: 3, uses_end_frame: true },
      selection({ resolution: "1080p" })
    );
    expect(note?.message).toContain("1080p");
    expect(note?.message).not.toContain("interpolation");
    expect(note?.message).not.toContain("hard cut");
  });

  it("does not claim interpolation on Lite, which has no last-frame support", () => {
    // Same inputs that force 8s on fast; Lite cannot interpolate, so the scene
    // rounds up normally instead.
    const note = sceneRenderNote(
      { type: "broll", seconds: 5, uses_end_frame: true },
      selection({ veo_variant: "lite" })
    );
    expect(note?.message).toContain("Renders 6s");
    expect(note?.message).not.toContain("interpolation");
  });

  it("reports Omni's uncontrollable length", () => {
    const note = sceneRenderNote(
      { type: "broll", seconds: 5, uses_end_frame: false },
      selection({ veo_variant: "omni" })
    );
    expect(note?.severity).toBe("forced");
    expect(note?.message).toContain("no duration control");
    expect(note?.message).toContain("3–10s");
  });

  it("stays silent for a b-roll provider with no verified duration rules", () => {
    expect(
      sceneRenderNote({ type: "broll", seconds: 5, uses_end_frame: false }, selection({ broll_provider: "higgsfield" }))
    ).toBeNull();
  });
});

describe("sceneRenderNote — avatar durations (HeyGen)", () => {
  it("blocks below the 4s floor", () => {
    const note = sceneRenderNote({ type: "avatar", seconds: 2, uses_end_frame: false }, selection());
    expect(note?.severity).toBe("blocking");
    expect(note?.message).toContain("4–15s");
  });

  it("blocks above the 15s ceiling", () => {
    expect(sceneRenderNote({ type: "avatar", seconds: 20, uses_end_frame: false }, selection())?.severity).toBe(
      "blocking"
    );
  });

  it("stays silent inside the window — this model honours the requested length", () => {
    for (const seconds of [4, 7.5, 15]) {
      expect(sceneRenderNote({ type: "avatar", seconds, uses_end_frame: false }, selection())).toBeNull();
    }
  });
});

describe("constraint set resolution", () => {
  it("gives scene-brain the b-roll and avatar models only", () => {
    // The image and music models have no bearing on how seconds and transitions
    // are allocated, so they are noise scene-brain would read past on every call.
    const roles = sceneBrainConstraintSets(selection({ avatar_enabled: true })).map((s) => s.role);
    expect(roles).toEqual(["b-roll", "avatar"]);
  });

  it("omits the avatar model when the reel has no avatar", () => {
    expect(sceneBrainConstraintSets(selection()).map((s) => s.role)).toEqual(["b-roll"]);
  });

  it("resolves the full set in pipeline order for the setup panel", () => {
    const sets = reelConstraintSets(selection({ avatar_enabled: true, music_provider: "elevenlabs" }));
    expect(sets.map((s) => s.role)).toEqual(["b-roll", "avatar", "image", "music"]);
  });

  it("names the exact model variant, not the provider", () => {
    expect(sceneBrainConstraintSets(selection({ veo_variant: "lite" }))[0].model).toBe("Veo 3.1 Lite");
    expect(sceneBrainConstraintSets(selection({ veo_variant: "omni" }))[0].model).toBe("Gemini Omni Flash (preview)");
  });

  it("falls back to the fast tier for an unknown variant instead of throwing", () => {
    // Matches veoCapabilitiesFor()/targetModelFor()'s existing posture, so a
    // stale config row degrades rather than breaking the page.
    expect(sceneBrainConstraintSets(selection({ veo_variant: "nonsense" }))[0].model).toBe("Veo 3.1 Fast");
  });

  it("surfaces the 8s-at-1080p rule as the duration constraint, not the 4/6/8 one", () => {
    const items = sceneBrainConstraintSets(selection({ resolution: "1080p" }))[0].items;
    expect(items.some((i) => i.label === "Clip length is fixed at 8s")).toBe(true);
    expect(items.some((i) => i.label === "Clip length is 4s, 6s or 8s only")).toBe(false);
  });

  it("mentions product references only when the reel actually has some", () => {
    const without = sceneBrainConstraintSets(selection())[0].items;
    const like = (label: string) => label.toLowerCase().includes("reference");
    expect(without.some((i) => like(i.label))).toBe(false);
    expect(sceneBrainConstraintSets(selection({ has_product_references: true }))[0].items.some((i) => like(i.label))).toBe(
      true
    );
  });
});
