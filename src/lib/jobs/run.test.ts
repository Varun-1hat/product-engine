/**
 * src/lib/jobs/run.ts had ZERO test coverage before this pass. Jobs now run
 * inline at their enqueue point (the separate worker process — its claim
 * loop and reconcile timer — was removed entirely) via runJobInline()'s
 * dispatch-by-job-type switch. This covers:
 *   - dispatch routing per job type (avatar_pull/trim/endframe_render/
 *     outro_gen/assembly), including the two job types that must NEVER
 *     reach this dispatcher (broll_gen/avatar_gen — src/stages/clip marks
 *     those awaiting_provider directly) and the unused image_gen type;
 *   - jobs.complete() placement, in particular outro_gen's model route,
 *     which must stay awaiting_provider (NOT complete — reconcilePendingJobs
 *     finishes it later) while the crossfade route completes immediately;
 *   - the failure path: jobs.fail(id, message, {retry:false}) + rethrow.
 *     This is the thing that stops a failed inline job from being silently
 *     left in status 'queued' — a status nothing polls anymore now that the
 *     worker's claim loop is gone (see queue.ts's fail()/retryLater() doc
 *     comments) — proven here by seeding a job with attempts well below
 *     max_attempts, where fail()'s default (no retry:false) would otherwise
 *     requeue it;
 *   - the refreshed-job return value (re-fetched from the DB, with a
 *     graceful fallback to the original object if the refetch comes back
 *     null);
 *   - reconcilePendingJobs()'s workerId="inline" wiring, its defaulting of
 *     adapters/costEngine when the caller doesn't supply them, and that it
 *     never throws (errors are swallowed — reconciliation must never break
 *     a read).
 *
 * The real per-job-type handlers (ffmpeg/satori/Storage/HeyGen-HTTP work in
 * ./trim, ./endframe, ./assembly, ./outro, pullAvatarLooks, and the poll
 * loop in ./reconcile) are mocked here — this file is about run.ts's OWN
 * dispatch/completion/error logic, not re-testing handler bodies that only
 * moved (verbatim, per git history) from worker/*.ts with no behavior
 * change, or reconcileJob()'s own logic (already covered in
 * src/lib/jobs/reconcile.test.ts). Uses the REAL job queue
 * (src/lib/jobs/queue.ts) against fakeSupabase so job-row status
 * transitions are the same ones a caller of runJobInline actually observes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./trim", () => ({ runTrimJob: vi.fn() }));
vi.mock("./endframe", () => ({ runEndframeRenderJob: vi.fn() }));
vi.mock("./assembly", () => ({ runAssemblyJob: vi.fn() }));
vi.mock("./outro", () => ({ runOutroGenJob: vi.fn() }));
vi.mock("@/src/adapters/video_avatar/heygen", () => ({ pullAvatarLooks: vi.fn() }));
vi.mock("./reconcile", () => ({ runReconcileTick: vi.fn() }));
vi.mock("@/src/adapters/registry", () => ({ getDefaultAdapterRegistry: vi.fn() }));

import { runJobInline, reconcilePendingJobs, type InlineJobDeps } from "./run";
import { createJobQueue } from "./queue";
import { createCostEngine } from "@/src/lib/cost/engine";
import { createFakeSupabase, type FakeRow, type FakeSupabaseClient } from "@/src/testUtils/fakeSupabase";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import type { KeyResolver } from "@/src/lib/crypto/vault";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { Adapter } from "@/src/adapters/types";

import { runTrimJob } from "./trim";
import { runEndframeRenderJob } from "./endframe";
import { runAssemblyJob } from "./assembly";
import { runOutroGenJob } from "./outro";
import { pullAvatarLooks } from "@/src/adapters/video_avatar/heygen";
import { runReconcileTick } from "./reconcile";
import { getDefaultAdapterRegistry } from "@/src/adapters/registry";

const REEL_ID = "reel-1";
const SCENE_ID = "scene-1";
const ASSET_ID = "asset-1";

function unusedStorage(): StorageClient {
  return {
    upload: async () => {
      throw new Error("storage.upload should not be called in this test");
    },
    download: async () => {
      throw new Error("storage.download should not be called in this test");
    },
    signedUrl: async () => "https://signed.example/unused",
    remove: async () => {},
  };
}

function fakeKeys(key = "fake-provider-key"): KeyResolver {
  return {
    forProvider: async () => key,
    decrypt: async () => "fake-secret",
  };
}

function fakeAdapterRegistry(): AdapterRegistry {
  const adapter: Adapter = {
    id: "fake@1",
    category: "video_broll",
    provider: "veo",
    capabilities: () => ({
      category: "video_broll",
      provider: "veo",
      supported_aspect_ratios: ["9:16"],
      supported_resolutions: ["1080p"],
      accepted_inputs: [],
      async: true,
      billing_unit: "second",
    }),
    validate: () => ({ ok: true, violations: [], warnings: [] }),
    estimate: () => ({ units: 1, unit_type: "second" }),
    generate: async () => {
      throw new Error("generate() should not be called from run.ts's dispatcher");
    },
  };
  return { get: () => adapter, tryGet: () => adapter, list: () => [adapter], register: () => {} };
}

function makeSupa(): FakeSupabaseClient {
  return createFakeSupabase({ jobs: [] });
}

function makeDeps(supa: FakeSupabaseClient, withAdapters = true): InlineJobDeps {
  const supaClient = supa as unknown as ServiceClient;
  return {
    supa: supaClient,
    storage: unusedStorage(),
    jobs: createJobQueue(supaClient),
    keys: fakeKeys(),
    adapters: withAdapters ? fakeAdapterRegistry() : undefined,
  };
}

/**
 * Directly seeds a fully-formed jobs row (bypassing enqueue()'s DB-default
 * gaps — fakeSupabase doesn't replicate Postgres column defaults like
 * `attempts int not null default 0`) so attempts/max_attempts are exactly
 * controlled. Mirrors src/lib/jobs/queue.test.ts's fullJob()/seedJob-style helpers.
 */
function seedJob(overrides: FakeRow = {}): FakeRow {
  return {
    id: "job-seeded",
    reel_id: REEL_ID,
    scene_id: SCENE_ID,
    asset_id: ASSET_ID,
    type: "trim",
    provider: null,
    status: "processing",
    provider_job_id: null,
    attempts: 0,
    max_attempts: 5,
    idempotency_key: null,
    payload: {},
    result: null,
    error: null,
    callback_token: null,
    locked_by: null,
    locked_at: null,
    run_after: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// vitest.config.ts's global `restoreMocks: true` does not reliably clear
// call history for vi.fn()s vended by a vi.mock(factory) (verified: without
// this, later tests observed earlier tests' calls to the same shared mock
// — e.g. runOutroGenJob's call count/args leaking across it() blocks). Every
// test below configures whatever return value it needs itself, so a plain
// clear (not a full reset of implementations) before each test is enough.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("runJobInline — dispatch by job type", () => {
  it("avatar_pull: pulls looks via the resolved provider key and upserts one avatars row per look, then completes the job", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa, false); // ConfigStageContext has no adapter registry — avatar_pull doesn't need one
    vi.mocked(pullAvatarLooks).mockResolvedValue([
      { heygen_look_id: "look-1", name: "Look One", preview_image_url: null, preview_video_url: null, raw: { a: 1 } },
    ]);

    const job = await deps.jobs.enqueue({
      reel_id: null,
      type: "avatar_pull",
      provider: "heygen",
      payload: { client_id: "client-1" },
    });

    const result = await runJobInline(deps, job);

    expect(pullAvatarLooks).toHaveBeenCalledWith("fake-provider-key");
    expect(supa._tables.avatars).toHaveLength(1);
    expect(supa._tables.avatars[0]).toMatchObject({ client_id: "client-1", heygen_look_id: "look-1", name: "Look One" });
    expect(result.status).toBe("succeeded");
  });

  it("avatar_pull: throws (and terminally fails the job) when payload has no client_id, without ever calling pullAvatarLooks", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa, false);
    const job = await deps.jobs.enqueue({ reel_id: null, type: "avatar_pull", provider: "heygen", payload: {} });

    await expect(runJobInline(deps, job)).rejects.toThrow(/has no client_id in payload/);

    expect(pullAvatarLooks).not.toHaveBeenCalled();
    const row = supa._tables.jobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe("failed");
  });

  it("trim: calls runTrimJob(supa, storage, job) then completes the job", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runTrimJob).mockResolvedValue(undefined);

    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      scene_id: SCENE_ID,
      asset_id: ASSET_ID,
      type: "trim",
      payload: { base_version_id: "v1", start_s: 0, end_s: 4 },
    });

    const result = await runJobInline(deps, job);

    expect(runTrimJob).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(runTrimJob).mock.calls[0];
    expect(callArgs[0]).toBe(deps.supa);
    expect(callArgs[1]).toBe(deps.storage);
    expect(callArgs[2].id).toBe(job.id);
    expect(result.status).toBe("succeeded");
  });

  it("endframe_render: calls runEndframeRenderJob then completes the job", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runEndframeRenderJob).mockResolvedValue(undefined);

    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      asset_id: ASSET_ID,
      type: "endframe_render",
      payload: { tagline: "hello" },
    });

    const result = await runJobInline(deps, job);

    expect(runEndframeRenderJob).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
  });

  it("assembly: calls runAssemblyJob then completes the job", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runAssemblyJob).mockResolvedValue(undefined);

    const job = await deps.jobs.enqueue({ reel_id: REEL_ID, type: "assembly", payload: { plan: {} } });

    const result = await runJobInline(deps, job);

    expect(runAssemblyJob).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
  });

  it("outro_gen crossfade route ('completed' outcome): completes the job", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runOutroGenJob).mockResolvedValue("completed");
    const completeSpy = vi.spyOn(deps.jobs, "complete");

    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      scene_id: SCENE_ID,
      asset_id: ASSET_ID,
      type: "outro_gen",
      provider: null,
      payload: { route: "crossfade" },
    });

    const result = await runJobInline(deps, job);

    expect(runOutroGenJob).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith(job.id);
    expect(result.status).toBe("succeeded");
  });

  it("outro_gen model route ('awaiting_provider' outcome): does NOT complete the job (reconcilePendingJobs finishes it later)", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runOutroGenJob).mockResolvedValue("awaiting_provider");
    const completeSpy = vi.spyOn(deps.jobs, "complete");

    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      scene_id: SCENE_ID,
      asset_id: ASSET_ID,
      type: "outro_gen",
      provider: "veo",
      payload: { route: "model" },
    });

    const result = await runJobInline(deps, job);

    expect(runOutroGenJob).toHaveBeenCalledTimes(1);
    expect(completeSpy).not.toHaveBeenCalled();
    expect(result.status).not.toBe("succeeded");
  });

  it("outro_gen: throws immediately (never calling runOutroGenJob) when no adapter registry was supplied", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa, false); // adapters omitted
    const job = await deps.jobs.enqueue({ reel_id: REEL_ID, type: "outro_gen", payload: { route: "crossfade" } });

    await expect(runJobInline(deps, job)).rejects.toThrow(/needs an adapter registry/);
    expect(runOutroGenJob).not.toHaveBeenCalled();
  });

  it("broll_gen/avatar_gen reaching the inline dispatcher is treated as a bug and fails loudly rather than silently dropped", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      scene_id: SCENE_ID,
      asset_id: ASSET_ID,
      type: "broll_gen",
      provider: "veo",
    });

    await expect(runJobInline(deps, job)).rejects.toThrow(/reached the inline dispatcher unexpectedly/);
    const row = supa._tables.jobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe("failed");
  });

  it("image_gen is rejected as unused in this build", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    const job = await deps.jobs.enqueue({ reel_id: REEL_ID, type: "image_gen" });

    await expect(runJobInline(deps, job)).rejects.toThrow(/image_gen is unused/);
    const row = supa._tables.jobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe("failed");
  });
});

describe("runJobInline — failure path never leaves a job stranded in 'queued'", () => {
  it("calls jobs.fail(id, message, {retry:false}) and rethrows even when attempts are well below max_attempts (proving it's a terminal failure, not a silent requeue nothing will ever pick up)", async () => {
    const supa = makeSupa();
    supa._tables.jobs.push(seedJob({ id: "job-will-fail", attempts: 0, max_attempts: 5, type: "trim" }));
    const deps = makeDeps(supa);
    vi.mocked(runTrimJob).mockRejectedValue(new Error("ffmpeg exploded"));

    const job = (await deps.jobs.get("job-will-fail"))!;
    const failSpy = vi.spyOn(deps.jobs, "fail");

    await expect(runJobInline(deps, job)).rejects.toThrow("ffmpeg exploded");

    expect(failSpy).toHaveBeenCalledWith("job-will-fail", "ffmpeg exploded", { retry: false });
    const row = supa._tables.jobs.find((j) => j.id === "job-will-fail")!;
    // NOT 'queued' — that status is what fail()'s default (no retry:false)
    // would have produced here (attempts 0 < max_attempts 5), and 'queued'
    // is a status nothing polls anymore now that the worker's claim loop is
    // gone. run.ts must force a terminal outcome instead.
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(0); // fail() never bumps attempts either way
  });

  it("wraps a non-Error throw as a string message and still rethrows the original rejection reason", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runAssemblyJob).mockRejectedValue("plain string rejection");

    const job = await deps.jobs.enqueue({ reel_id: REEL_ID, type: "assembly", payload: {} });

    await expect(runJobInline(deps, job)).rejects.toBe("plain string rejection");
    const row = supa._tables.jobs.find((j) => j.id === job.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("plain string rejection");
  });
});

describe("runJobInline — refreshed-job return value", () => {
  it("returns the job re-fetched from the DB (reflecting complete()'s write), not the stale pre-dispatch object", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runTrimJob).mockResolvedValue(undefined);

    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      scene_id: SCENE_ID,
      asset_id: ASSET_ID,
      type: "trim",
      payload: { base_version_id: "v1", start_s: 0, end_s: 1 },
    });
    expect(job.status).not.toBe("succeeded"); // sanity: pre-dispatch object isn't already "succeeded"

    const result = await runJobInline(deps, job);

    expect(result.status).toBe("succeeded");
    const refetched = await deps.jobs.get(job.id);
    expect(result).toEqual(refetched);
  });

  it("falls back to the original job object if the refetch (jobs.get) comes back null", async () => {
    const supa = makeSupa();
    const deps = makeDeps(supa);
    vi.mocked(runTrimJob).mockResolvedValue(undefined);

    const job = await deps.jobs.enqueue({
      reel_id: REEL_ID,
      scene_id: SCENE_ID,
      asset_id: ASSET_ID,
      type: "trim",
      payload: { base_version_id: "v1", start_s: 0, end_s: 1 },
    });
    vi.spyOn(deps.jobs, "get").mockResolvedValue(null);

    const result = await runJobInline(deps, job);
    expect(result).toBe(job);
  });
});

describe("reconcilePendingJobs", () => {
  function fakeDeps(supa: FakeSupabaseClient) {
    const supaClient = supa as unknown as ServiceClient;
    return {
      supa: supaClient,
      storage: unusedStorage(),
      jobs: createJobQueue(supaClient),
      keys: fakeKeys(),
    };
  }

  it("delegates to runReconcileTick with workerId 'inline' and passes through the given deps unchanged", async () => {
    vi.mocked(runReconcileTick).mockResolvedValue(0);
    const supa = makeSupa();
    const deps = fakeDeps(supa);
    const adapters = fakeAdapterRegistry();
    const costEngine = createCostEngine(deps.supa);

    await reconcilePendingJobs({ ...deps, adapters, costEngine });

    expect(runReconcileTick).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(runReconcileTick).mock.calls[0][0];
    expect(arg.workerId).toBe("inline");
    expect(arg.supa).toBe(deps.supa);
    expect(arg.storage).toBe(deps.storage);
    expect(arg.jobs).toBe(deps.jobs);
    expect(arg.keys).toBe(deps.keys);
    expect(arg.adapters).toBe(adapters);
    expect(arg.costEngine).toBe(costEngine);
  });

  it("defaults adapters via getDefaultAdapterRegistry() and synthesizes a costEngine when neither is supplied", async () => {
    vi.mocked(runReconcileTick).mockResolvedValue(0);
    const defaultRegistry = fakeAdapterRegistry();
    vi.mocked(getDefaultAdapterRegistry).mockResolvedValue(defaultRegistry);
    const supa = makeSupa();
    const deps = fakeDeps(supa);

    await reconcilePendingJobs(deps); // no adapters, no costEngine supplied

    expect(getDefaultAdapterRegistry).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(runReconcileTick).mock.calls[0][0];
    expect(arg.adapters).toBe(defaultRegistry);
    expect(arg.costEngine).toBeTruthy();
  });

  it("never throws even when runReconcileTick rejects — reconciliation must never break a read", async () => {
    vi.mocked(runReconcileTick).mockRejectedValue(new Error("provider poll blew up"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supa = makeSupa();
    const deps = fakeDeps(supa);

    await expect(reconcilePendingJobs({ ...deps, adapters: fakeAdapterRegistry() })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
