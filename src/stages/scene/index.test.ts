/**
 * src/stages/scene/index.ts's process() regression test (spec §3.2).
 *
 * The "Save silently discards edits" bug described in spec §3.1 was actually
 * a *frontend* bug: the old app/(app)/reels/[reelId]/scene/page.tsx had no
 * inline-editing UI at all, and its "Save" button POSTed `{ regenerate:
 * false }` with no `scenes` field — which, per the `if (input.regenerate ||
 * !desired)` branch below, is indistinguishable from "no scenes supplied"
 * and silently re-ran scene-brain instead of saving anything. process()
 * itself already implements the correct contract (edit-in-place when
 * `scenes` is supplied and `regenerate` is falsy; regenerate only when
 * `regenerate: true` or `scenes` is omitted) — this test pins that existing,
 * correct backend contract so a future edit here can't silently reintroduce
 * the bug the §3.1 frontend rewrite fixes.
 *
 * Follows the direct-injection pattern of src/lib/reviewAction.test.ts and
 * src/stages/outro/index.test.ts: fakes passed straight to the function
 * under test, using src/testUtils/fakeSupabase.ts for the in-memory
 * Supabase double — no live Supabase project. costEngine/jobs/storage/keys
 * are built via their real, synchronous factories (they close over the
 * client but do no I/O until a method is called, and process() never calls
 * any of them) purely to satisfy StageContext's type; `adapters` is a small
 * hand-built fake (mirroring outro's test) since the real
 * getDefaultAdapterRegistry() is async and needs a live Supabase project to
 * construct.
 *
 * Note: exercising the `regenerate: true` branch against a reel that already
 * has a scene also exercises `process()`'s delete-by-omission cleanup (the
 * freshly-generated scene has no `id`, so the previously-seeded scene must
 * be deleted) — src/testUtils/fakeSupabase.ts had no `.delete()`/`.in()`
 * support at all until this pass (nothing previously exercised that path);
 * see the additive changes there.
 */
import { describe, expect, it, vi } from "vitest";
import { sceneStage } from "./index";
import { createCostEngine } from "@/src/lib/cost/engine";
import { createJobQueue } from "@/src/lib/jobs/queue";
import { createStorageClient } from "@/src/lib/storage";
import { createKeyResolver } from "@/src/lib/crypto/vault";
import { createFakeSupabase, type FakeRow, type FakeSupabaseClient } from "@/src/testUtils/fakeSupabase";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StageContext } from "@/src/stages/types";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { SkillRegistry } from "@/src/skills/types";

const REEL_ID = "reel-1";
const CLIENT_ID = "client-1";
const SCENE_ID = "scene-1";

function seedSupa(): FakeSupabaseClient {
  return createFakeSupabase({
    reel_config: [
      {
        reel_id: REEL_ID,
        topic: "widget",
        total_seconds_target: 20,
        avatar_enabled: false,
        broll_provider: "veo",
        image_provider: "nano_banana",
        veo_variant: "fast",
        outro_provider_override: null,
        avatar_look_id: null,
        aspect_ratio: "9:16",
        resolution: "1080p",
        output_fps: 30,
        end_frame_mode: "default",
        end_frame_asset_id: null,
        outro_tagline: null,
        outro_seconds: 2,
        music_path: null,
        music_trim: null,
      },
    ] as FakeRow[],
    scenes: [
      {
        id: SCENE_ID,
        reel_id: REEL_ID,
        position: 0,
        type: "broll",
        product_in_scene: false,
        seconds: 5,
        transition_to_next: null,
        broll_provider_override: null,
        description: "original description",
        start_image_id: null,
        end_image_id: null,
        clip_asset_id: null,
      },
    ] as FakeRow[],
    client_config: [],
    products: [],
  });
}

/** Always reports supports_end_frame=false — process() calls this unconditionally to compute hints regardless of branch, but neither test below asserts on hints. */
function fakeAdapters(): AdapterRegistry {
  return {
    tryGet: () => undefined,
    get: () => {
      throw new Error("adapters.get() should not be called by sceneStage.process()");
    },
    list: () => [],
    register: () => {},
  };
}

function makeCtx(supa: FakeSupabaseClient, sceneBrain: SkillRegistry["sceneBrain"]): StageContext {
  const supaClient = supa as unknown as ServiceClient;
  const skills: SkillRegistry = {
    sceneBrain,
    imagePrompt: async () => {
      throw new Error("imagePrompt should not be called by sceneStage.process()");
    },
    brandStyleLock: async () => {
      throw new Error("brandStyleLock should not be called by sceneStage.process()");
    },
    briefJudge: async () => {
      throw new Error("briefJudge should not be called by sceneStage.process()");
    },
  };

  return {
    reelId: REEL_ID,
    clientId: CLIENT_ID,
    supa: supaClient,
    costEngine: createCostEngine(supaClient),
    adapters: fakeAdapters(),
    skills,
    jobs: createJobQueue(supaClient),
    storage: createStorageClient(supaClient),
    keys: createKeyResolver(supaClient),
  };
}

describe("sceneStage.process() — save vs regenerate (spec §3.1/§3.2)", () => {
  it("a save (scenes provided, regenerate:false) edits in place and never calls sceneBrain", async () => {
    const supa = seedSupa();
    const sceneBrain = vi.fn().mockRejectedValue(new Error("must not be called"));
    const ctx = makeCtx(supa, sceneBrain);

    const output = await sceneStage.process(
      {
        regenerate: false,
        scenes: [
          {
            id: SCENE_ID,
            position: 0,
            type: "broll",
            product_in_scene: false,
            seconds: 5,
            transition_to_next: null,
            broll_provider_override: null,
            description: "edited description",
          },
        ],
      },
      ctx
    );

    expect(sceneBrain).not.toHaveBeenCalled();
    expect(output.scenes).toHaveLength(1);
    // The existing scene's id must be preserved, never regenerated (spec §3.1).
    expect(output.scenes[0].id).toBe(SCENE_ID);
    expect(output.scenes[0].description).toBe("edited description");

    // Reflected in the underlying fake table too, not just the in-memory return value.
    const row = supa._tables.scenes.find((s) => s.id === SCENE_ID)!;
    expect(row).toBeTruthy();
    expect(row.description).toBe("edited description");
  });

  it("a regenerate (regenerate:true, no scenes) calls sceneBrain exactly once and replaces the scene list", async () => {
    const supa = seedSupa();
    const sceneBrain = vi.fn().mockResolvedValue({
      scenes: [
        {
          type: "broll",
          product_in_scene: false,
          seconds: 6,
          transition_to_next: null,
          description: "brand new generated scene",
        },
      ],
    });
    const ctx = makeCtx(supa, sceneBrain);

    const output = await sceneStage.process({ regenerate: true }, ctx);

    expect(sceneBrain).toHaveBeenCalledTimes(1);
    expect(output.scenes).toHaveLength(1);
    expect(output.scenes[0].description).toBe("brand new generated scene");

    // Delete-by-omission: the old scene (not present in scene-brain's fresh, id-less output) is gone.
    const staleRow = supa._tables.scenes.find((s) => s.id === SCENE_ID);
    expect(staleRow).toBeUndefined();
    expect(supa._tables.scenes).toHaveLength(1);
  });
});
