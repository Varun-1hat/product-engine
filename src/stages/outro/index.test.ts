/**
 * src/stages/outro/index.ts had zero test coverage before this pass.
 * Focus: V2 Phase 0 item 4 / N2 (.pipeline/spec.md) — the outro_gen job
 * enqueue (enqueueOutroClip) previously had no idempotency_key, which left
 * src/lib/jobs/reconcile.ts's cost_log double-charge guard (partial
 * UNIQUE(reel_id, provider, idempotency_key)) inert for outro-via-a-model
 * generations. Also covers item 2/BLOCK-2's redaction on this stage's
 * redoAsset review hook (toPublicJob), since it shares enqueueOutroClip with
 * process() and is the second of the three call sites the spec named.
 *
 * Runs outroStage.process() / createOutroReviewHooks(ctx).redoAsset() for
 * real against a fake Supabase client (src/testUtils/fakeSupabase.ts) + the
 * REAL job queue (src/lib/jobs/queue.ts). ctx.adapters is a fake registry
 * whose tryGet() always returns undefined, which deterministically forces
 * resolveOutroRoute() to the "crossfade" route (see src/lib/routing.ts) —
 * that keeps this test independent of ctx.skills.brandStyleLock (only
 * called on the "model" route, which needs a real/mocked LLM skill and is
 * out of scope for this stage's N2 fix, which applies to the job enqueue
 * unconditionally regardless of route).
 */
import { describe, expect, it, vi } from "vitest";

// Jobs now run inline at their enqueue point (src/lib/jobs/run.ts) rather
// than being picked up by a separate process. These tests are about what
// this stage ENQUEUES (idempotency_key, BLOCK-2 redaction) — not the ffmpeg/
// provider work itself, which needs real Storage — so the inline run is
// stubbed to a pass-through and the enqueued row stays what's asserted on.
vi.mock("@/src/lib/jobs/run", () => ({
  runJobInline: async (_deps: unknown, job: unknown) => job,
  reconcilePendingJobs: async () => {},
}));

import { outroStage, createOutroReviewHooks } from "./index";
import { createJobQueue } from "@/src/lib/jobs/queue";
import { createFakeSupabase, type FakeRow, type FakeSupabaseClient } from "@/src/testUtils/fakeSupabase";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StageContext } from "@/src/stages/types";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { CostEngine } from "@/src/lib/cost/engine";
import type { SkillRegistry } from "@/src/skills/types";
import type { StorageClient } from "@/src/lib/storage";
import type { KeyResolver } from "@/src/lib/crypto/vault";

const REEL_ID = "reel-1";
const CLIENT_ID = "client-1";
const SCENE_ID = "scene-last";

function seedSupa(): FakeSupabaseClient {
  return createFakeSupabase({
    reel_config: [
      {
        reel_id: REEL_ID,
        topic: "widget",
        total_seconds_target: 20,
        avatar_enabled: false,
        broll_provider: "higgsfield", // supports_end_frame=false anyway — see fakeAdapters() below
        image_provider: "nano_banana",
        veo_variant: "standard",
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
        seconds: 5,
        transition_to_next: null,
        broll_provider_override: null,
        description: "last scene",
        start_image_id: null,
        end_image_id: null,
        clip_asset_id: null,
      },
    ] as FakeRow[],
    assets: [],
    client_config: [],
  });
}

/** Always reports supports_end_frame=false, which forces resolveOutroRoute() to "crossfade" (src/lib/routing.ts) regardless of broll_provider. */
function fakeAdapters(): AdapterRegistry {
  return {
    tryGet: () => undefined,
    get: () => {
      throw new Error("adapters.get() should not be called on the crossfade route");
    },
    list: () => [],
    register: () => {},
  };
}

function unusedCostEngine(): CostEngine {
  return {
    estimate: async () => {
      throw new Error("costEngine.estimate() should not be called by outroStage.process()");
    },
    log: async () => {
      throw new Error("costEngine.log() should not be called by outroStage.process()");
    },
    spentSoFar: async () => {
      throw new Error("costEngine.spentSoFar() should not be called by outroStage.process()");
    },
  };
}

function unusedSkills(): SkillRegistry {
  return {
    sceneBrain: async () => {
      throw new Error("sceneBrain should not be called on the crossfade route");
    },
    musicPrompt: async () => {
      throw new Error("musicPrompt should not be called by outro");
    },
    imagePrompt: async () => {
      throw new Error("imagePrompt should not be called by outro");
    },
    sceneDescription: async () => {
      throw new Error("sceneDescription should not be called by outroStage");
    },
    sceneInstruction: async () => {
      throw new Error("sceneInstruction should not be called by outroStage");
    },
    brandStyleLock: async () => {
      throw new Error("brandStyleLock should not be called on the crossfade route");
    },
    briefJudge: async () => {
      throw new Error("briefJudge should not be called by outro");
    },
  };
}

function unusedStorage(): StorageClient {
  return {
    upload: async () => {
      throw new Error("storage.upload() should not be called by outroStage.process()");
    },
    download: async () => {
      throw new Error("storage.download() should not be called by outroStage.process()");
    },
    signedUrl: async () => "https://signed.example/unused",
    remove: async () => {},
  };
}

function unusedKeys(): KeyResolver {
  return {
    forProvider: async () => {
      throw new Error("keys.forProvider() should not be called by outroStage.process()");
    },
    decrypt: async () => {
      throw new Error("keys.decrypt() should not be called by outroStage.process()");
    },
  };
}

function makeCtx(supa: FakeSupabaseClient): StageContext {
  const supaClient = supa as unknown as ServiceClient;
  return {
    reelId: REEL_ID,
    clientId: CLIENT_ID,
    supa: supaClient,
    costEngine: unusedCostEngine(),
    adapters: fakeAdapters(),
    skills: unusedSkills(),
    jobs: createJobQueue(supaClient),
    storage: unusedStorage(),
    keys: unusedKeys(),
  };
}

describe("outroStage.process() — outro_gen job idempotency_key (N2)", () => {
  it("enqueues the outro_gen job with a non-null, unique idempotency_key", async () => {
    const supa = seedSupa();
    const ctx = makeCtx(supa);

    const output = await outroStage.process({}, ctx);

    expect(output.route).toEqual({ kind: "crossfade" });
    expect(output.outro_clip_job.type).toBe("outro_gen");
    expect(output.outro_clip_job.idempotency_key).toBeTruthy();
    expect(typeof output.outro_clip_job.idempotency_key).toBe("string");

    // Confirm it actually landed in the DB row too, not just the in-memory return value.
    const jobRow = supa._tables.jobs.find((j) => j.id === output.outro_clip_job.id)!;
    expect(jobRow.idempotency_key).toBe(output.outro_clip_job.idempotency_key);
    expect(jobRow.idempotency_key).not.toBeNull();
  });

  it("gives each outro_gen job a DIFFERENT idempotency_key across two separate reels (never a shared/static value)", async () => {
    const supaA = seedSupa();
    const outputA = await outroStage.process({}, makeCtx(supaA));

    const supaB = seedSupa();
    const outputB = await outroStage.process({}, makeCtx(supaB));

    expect(outputA.outro_clip_job.idempotency_key).not.toBe(outputB.outro_clip_job.idempotency_key);
  });
});

describe("createOutroReviewHooks(ctx).redoAsset — outro_clip branch (N2 + BLOCK-2 redaction)", () => {
  async function seedWithOutroClipAsset(): Promise<{ supa: FakeSupabaseClient; assetId: string }> {
    const supa = seedSupa();
    const { data, error } = await supa
      .from("assets")
      .insert({ reel_id: REEL_ID, slot: "outro_clip", media_type: "video", shared: false })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { supa, assetId: (data as FakeRow).id as string };
  }

  it("redo also carries a fresh idempotency_key, and the returned job is a redacted PublicJob (no callback_token/payload leak)", async () => {
    const { supa, assetId } = await seedWithOutroClipAsset();
    const ctx = makeCtx(supa);
    const hooks = createOutroReviewHooks(ctx);

    const result = await hooks.redoAsset(assetId);

    expect(result.job).toBeTruthy();
    // PublicJob's exact shape (BLOCK-2): only these four keys, ever.
    expect(Object.keys(result.job!).sort()).toEqual(["id", "provider_job_id", "status", "type"]);
    expect((result.job as unknown as FakeRow).callback_token).toBeUndefined();
    expect((result.job as unknown as FakeRow).payload).toBeUndefined();

    const jobRow = supa._tables.jobs.find((j) => j.id === result.job!.id)!;
    expect(jobRow.type).toBe("outro_gen");
    expect(jobRow.idempotency_key).toBeTruthy();
    expect(jobRow.payload).toMatchObject({ call_type: "redo" });
  });
});
