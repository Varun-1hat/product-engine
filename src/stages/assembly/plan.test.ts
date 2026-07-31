import { describe, expect, it } from "vitest";
import { buildAssemblyPlan, MUSIC_VOLUME_UNDER_CLIP_AUDIO, type SceneLike } from "./plan";

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

describe("buildAssemblyPlan", () => {
  it("orders clips by scene position and appends the outro clip last", () => {
    const scenes = [
      scene({ id: "b", position: 1, transition_to_next: null }),
      scene({ id: "a", position: 0, transition_to_next: null }),
    ];
    // caller is expected to pass scenesByPosition already ordered — verify
    // the plan preserves whatever order it's given and appends the outro.
    const ordered = [scenes[1], scenes[0]];
    const plan = buildAssemblyPlan({
      scenesByPosition: ordered,
      clipStoragePaths: { a: "path/a.mp4", b: "path/b.mp4" },
      sceneDurations: { a: 4, b: 4 },
      outroClipStoragePath: "path/outro.mp4",
      outroSeconds: 2,
      reelConfig: { broll_provider: "veo", outro_provider_override: null },
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      supportsEndFrame,
      music: null,
      outputPath: "renders/final.mp4",
    });

    expect(plan.clips.map((c) => c.scene_id)).toEqual(["a", "b", null]);
    expect(plan.clips[2].role).toBe("outro");
    expect(plan.clips[2].storage_path).toBe("path/outro.mp4");
  });

  it("throws a clear error when a scene has no clip storage_path", () => {
    const scenes = [scene({ id: "a", position: 0 })];
    expect(() =>
      buildAssemblyPlan({
        scenesByPosition: scenes,
        clipStoragePaths: {},
        sceneDurations: { a: 4 },
        outroClipStoragePath: "path/outro.mp4",
        outroSeconds: 2,
        reelConfig: { broll_provider: "veo", outro_provider_override: null },
        aspectRatio: "9:16",
        resolution: "1080p",
        fps: 30,
        supportsEndFrame,
        music: null,
        outputPath: "renders/final.mp4",
      })
    ).toThrow(/no clip storage_path/);
  });

  it("marks trim_head_frame=true only on the incoming side of a continuous (Veo) boundary", () => {
    const scenes = [
      scene({ id: "a", position: 0, transition_to_next: "continuous" }),
      scene({ id: "b", position: 1, transition_to_next: "hard_cut" }),
      scene({ id: "c", position: 2, transition_to_next: null }),
    ];
    const plan = buildAssemblyPlan({
      scenesByPosition: scenes,
      clipStoragePaths: { a: "a.mp4", b: "b.mp4", c: "c.mp4" },
      sceneDurations: { a: 4, b: 4, c: 4 },
      outroClipStoragePath: "outro.mp4",
      outroSeconds: 2,
      reelConfig: { broll_provider: "veo", outro_provider_override: null },
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      supportsEndFrame,
      music: null,
      outputPath: "renders/final.mp4",
    });

    const byScene = Object.fromEntries(plan.clips.map((c) => [c.scene_id ?? "outro", c.trim_head_frame]));
    expect(byScene.a).toBe(false); // first clip, nothing precedes it
    expect(byScene.b).toBe(true); // incoming side of a->b continuous boundary
    expect(byScene.c).toBe(false); // b->c is hard_cut
    expect(byScene.outro).toBe(false); // outro never gets the seam trim
  });

  it("forces no seam trim when the effective model lacks supports_end_frame (Higgsfield), even if intent was continuous", () => {
    const scenes = [
      scene({ id: "a", position: 0, transition_to_next: "continuous" }),
      scene({ id: "b", position: 1, transition_to_next: null }),
    ];
    const plan = buildAssemblyPlan({
      scenesByPosition: scenes,
      clipStoragePaths: { a: "a.mp4", b: "b.mp4" },
      sceneDurations: { a: 4, b: 4 },
      outroClipStoragePath: "outro.mp4",
      outroSeconds: 2,
      reelConfig: { broll_provider: "higgsfield", outro_provider_override: null },
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      supportsEndFrame,
      music: null,
      outputPath: "renders/final.mp4",
    });

    expect(plan.clips.find((c) => c.scene_id === "b")?.trim_head_frame).toBe(false);
  });

  it("computes total_duration_s as the sum of scene durations plus outro_seconds", () => {
    const scenes = [scene({ id: "a", position: 0 }), scene({ id: "b", position: 1 })];
    const plan = buildAssemblyPlan({
      scenesByPosition: scenes,
      clipStoragePaths: { a: "a.mp4", b: "b.mp4" },
      sceneDurations: { a: 5, b: 7 },
      outroClipStoragePath: "outro.mp4",
      outroSeconds: 2.5,
      reelConfig: { broll_provider: "veo", outro_provider_override: null },
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      supportsEndFrame,
      music: null,
      outputPath: "renders/final.mp4",
    });
    expect(plan.total_duration_s).toBe(14.5);
  });

  it("passes through aspect_ratio/resolution/fps and output_path unchanged", () => {
    const scenes = [scene({ id: "a", position: 0 })];
    const plan = buildAssemblyPlan({
      scenesByPosition: scenes,
      clipStoragePaths: { a: "a.mp4" },
      sceneDurations: { a: 4 },
      outroClipStoragePath: "outro.mp4",
      outroSeconds: 2,
      reelConfig: { broll_provider: "veo", outro_provider_override: null },
      aspectRatio: "16:9",
      resolution: "720p",
      fps: 24,
      supportsEndFrame,
      music: null,
      outputPath: "renders/custom.mp4",
    });
    expect(plan.aspect_ratio).toBe("16:9");
    expect(plan.resolution).toBe("720p");
    expect(plan.fps).toBe(24);
    expect(plan.output_path).toBe("renders/custom.mp4");
  });

  describe("music plan", () => {
    const scenes = [scene({ id: "a", position: 0 })];
    const baseParams = {
      scenesByPosition: scenes,
      clipStoragePaths: { a: "a.mp4" },
      sceneDurations: { a: 10 },
      outroClipStoragePath: "outro.mp4",
      outroSeconds: 2, // total_duration_s = 12
      reelConfig: { broll_provider: "veo", outro_provider_override: null },
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      supportsEndFrame,
      outputPath: "renders/final.mp4",
    };

    it("is null when no music was uploaded", () => {
      const plan = buildAssemblyPlan({ ...baseParams, music: null });
      expect(plan.music).toBeNull();
    });

    it("loops when the trimmed track is shorter than the total reel duration", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 8 } }, // 8s < 12s total
      });
      expect(plan.music?.loop).toBe(true);
    });

    it("does not loop when the trimmed track already covers the total duration", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 20 } }, // 20s >= 12s total
      });
      expect(plan.music?.loop).toBe(false);
    });

    it("falls back to source_duration_s when music_trim has no explicit end_s", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: { storage_path: "music/track.mp3", music_trim: null, source_duration_s: 5 },
      });
      expect(plan.music?.start_s).toBe(0);
      expect(plan.music?.end_s).toBe(5);
      expect(plan.music?.loop).toBe(true); // 5s < 12s total
    });

    it("caps the fade duration at half the total reel duration for very short reels", () => {
      const plan = buildAssemblyPlan({
        scenesByPosition: [scene({ id: "a", position: 0 })],
        clipStoragePaths: { a: "a.mp4" },
        sceneDurations: { a: 1 },
        outroClipStoragePath: "outro.mp4",
        outroSeconds: 1, // total_duration_s = 2 -> half = 1, less than default 1.5s fade
        reelConfig: { broll_provider: "veo", outro_provider_override: null },
        aspectRatio: "9:16",
        resolution: "1080p",
        fps: 30,
        supportsEndFrame,
        outputPath: "renders/final.mp4",
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 30 } },
      });
      expect(plan.music?.fade_in_s).toBe(1);
      expect(plan.music?.fade_out_s).toBe(1);
    });

    it("uses a custom fadeSeconds when provided and it fits", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        fadeSeconds: 3,
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 30 } },
      });
      expect(plan.music?.fade_in_s).toBe(3);
    });
  });

  describe("clip audio", () => {
    const scenes = [scene({ id: "a", position: 0 }), scene({ id: "b", position: 1 })];
    const baseParams = {
      scenesByPosition: scenes,
      clipStoragePaths: { a: "a.mp4", b: "b.mp4" },
      sceneDurations: { a: 4, b: 4 },
      outroClipStoragePath: "outro.mp4",
      outroSeconds: 2,
      reelConfig: { broll_provider: "veo", outro_provider_override: null },
      aspectRatio: "9:16",
      resolution: "1080p",
      fps: 30,
      supportsEndFrame,
      outputPath: "renders/final.mp4",
    };

    it("carries each clip's audio through by scene, and the outro's separately", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: null,
        clipAudioPaths: { a: "a-audio.m4a", b: "b-audio.m4a" },
        outroAudioPath: "outro-audio.m4a",
      });

      const byScene = Object.fromEntries(plan.clips.map((c) => [c.scene_id ?? "outro", c.audio_storage_path]));
      expect(byScene).toEqual({ a: "a-audio.m4a", b: "b-audio.m4a", outro: "outro-audio.m4a" });
    });

    it("leaves a clip silent when it has no audio — a switched-off clip is simply absent from the map", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: null,
        clipAudioPaths: { a: "a-audio.m4a" }, // b muted by the user, outro never had any
      });

      const byScene = Object.fromEntries(plan.clips.map((c) => [c.scene_id ?? "outro", c.audio_storage_path]));
      expect(byScene).toEqual({ a: "a-audio.m4a", b: null, outro: null });
    });

    it("ducks the music bed under the clips' audio when any clip has some", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 30 } },
        clipAudioPaths: { b: "b-audio.m4a" },
      });
      expect(plan.music?.volume).toBe(MUSIC_VOLUME_UNDER_CLIP_AUDIO);
    });

    it("keeps the music bed at full level when nothing else is playing", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 30 } },
        clipAudioPaths: {},
      });
      expect(plan.music?.volume).toBe(1);
    });

    it("defaults every clip to silent when no audio is passed at all (pre-clip-audio reels)", () => {
      const plan = buildAssemblyPlan({
        ...baseParams,
        music: { storage_path: "music/track.mp3", music_trim: { start_s: 0, end_s: 30 } },
      });
      expect(plan.clips.every((c) => c.audio_storage_path === null)).toBe(true);
      expect(plan.music?.volume).toBe(1);
    });
  });
});
