/**
 * worker/reconcile.ts had ZERO test coverage before this pass (V2 Phase 0 —
 * .pipeline/spec.md item 3 / N1 explicitly flags this as the Tester's top
 * priority, since worker/** had no tests at all). Exercises reconcileJob()
 * end-to-end against a fake Supabase client (src/testUtils/fakeSupabase.ts)
 * + the REAL job queue (src/lib/jobs/queue.ts, including the new
 * retryLater()) + the REAL cost engine (src/lib/cost/engine.ts) — only the
 * adapter's poll() and the key resolver are stubbed, the two genuine
 * external-I/O boundaries this module wraps. Same "mock the SDK boundary,
 * run the real logic" pattern as app/api/webhooks/heygen/route.test.ts.
 *
 * Core focus (N1): a caught poll() error must re-arm the job via
 * jobs.retryLater() rather than route through jobs.fail()'s default retry
 * (which moves a retryable job to 'queued' — a status worker/index.ts's main
 * claim loop treats as fatal for broll_gen/avatar_gen/outro_gen, since those
 * job types never pass through it), and must NOT log a cost_log row under
 * the generation's real idempotency_key until the job is genuinely terminal
 * (attempts >= max_attempts).
 */
import { describe, expect, it, vi } from "vitest";
import { reconcileJob, runReconcileTick } from "./reconcile";
import { createJobQueue } from "@/src/lib/jobs/queue";
import { createCostEngine } from "@/src/lib/cost/engine";
import { createFakeSupabase, type FakeRow, type FakeSupabaseClient } from "@/src/testUtils/fakeSupabase";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { Adapter, GenerateResult } from "@/src/adapters/types";
import type { KeyResolver } from "@/src/lib/crypto/vault";

const REEL_ID = "reel-1";
const CLIENT_ID = "client-1";
const SCENE_ID = "scene-1";
const ASSET_ID = "asset-1";

const RATE_CARD_SEED: FakeRow[] = [
  {
    id: "rate-veo-second",
    provider: "veo",
    unit_type: "second",
    variant: null,
    unit_cost_usd: 0.12,
    currency: "USD",
    client_id: null,
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
  },
];

function baseTables(extraJobs: FakeRow[]): Record<string, FakeRow[]> {
  return {
    jobs: extraJobs,
    reels: [{ id: REEL_ID, client_id: CLIENT_ID, display_name: "Test Reel", current_stage: "clip", status: "in_progress" }],
    rate_card: RATE_CARD_SEED,
    assets: [
      {
        id: ASSET_ID,
        reel_id: REEL_ID,
        scene_id: SCENE_ID,
        slot: "broll_clip",
        media_type: "video",
        current_version_id: null,
        shared: false,
      },
    ],
    asset_versions: [],
    cost_log: [],
  };
}

function seedSupa(jobs: FakeRow[]): FakeSupabaseClient {
  return createFakeSupabase(baseTables(jobs), {
    uniqueConstraints: [
      // Mirrors supabase/migrations/0001_init.sql's partial unique index —
      // the exact guard N2/N1 rely on to make double-charging impossible.
      { table: "cost_log", columns: ["reel_id", "provider", "idempotency_key"], where: (r) => r.idempotency_key != null },
    ],
  });
}

function baseJob(overrides: FakeRow): FakeRow {
  return {
    id: "job-x",
    reel_id: REEL_ID,
    scene_id: SCENE_ID,
    asset_id: ASSET_ID,
    type: "broll_gen",
    provider: "veo",
    status: "awaiting_provider",
    provider_job_id: "prov-job-x",
    attempts: 0,
    max_attempts: 3,
    idempotency_key: "idem-x",
    payload: {
      call_type: "generate",
      units: 6,
      unit_type: "second",
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration_s: 6,
    },
    result: null,
    error: null,
    callback_token: null,
    locked_by: "worker-1",
    locked_at: new Date().toISOString(),
    run_after: new Date().toISOString(),
    ...overrides,
  };
}

function fakeAdapterRegistry(poll: NonNullable<Adapter["poll"]>): AdapterRegistry {
  const adapter: Adapter = {
    id: "fake-veo@1",
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
    estimate: () => ({ units: 6, unit_type: "second" }),
    generate: async () => {
      throw new Error("generate() should never be called by reconcileJob — it only polls");
    },
    poll,
  };
  return {
    get: () => adapter,
    tryGet: () => adapter,
    list: () => [adapter],
    register: () => {},
  };
}

function fakeKeys(): KeyResolver {
  return {
    forProvider: async () => "fake-provider-key",
    decrypt: async () => "fake-secret",
  };
}

function makeDeps(supa: FakeSupabaseClient, poll: NonNullable<Adapter["poll"]>) {
  const supaClient = supa as unknown as ServiceClient;
  return {
    supa: supaClient,
    costEngine: createCostEngine(supaClient),
    jobs: createJobQueue(supaClient),
    adapters: fakeAdapterRegistry(poll),
    keys: fakeKeys(),
  };
}

describe("reconcileJob — poll() still pending", () => {
  it("leaves the job exactly as-is (no status change, no cost_log, no attempts bump) for another tick to pick up", async () => {
    const supa = seedSupa([baseJob({ id: "job-pending" })]);
    const pollMock = vi.fn(async (): Promise<GenerateResult> => ({
      status: "pending",
      provider_job_id: "prov-job-x",
      units: 6,
      unit_type: "second",
      raw: {},
    }));
    const deps = makeDeps(supa, pollMock);
    const job = (await deps.jobs.get("job-pending"))!;

    await reconcileJob({ ...deps, job });

    expect(supa._tables.cost_log).toHaveLength(0);
    const row = supa._tables.jobs.find((j) => j.id === "job-pending")!;
    expect(row.status).toBe("awaiting_provider");
    expect(row.attempts).toBe(0);
  });
});

describe("reconcileJob — happy path (poll() succeeds)", () => {
  it("logs the real cost under the job's idempotency_key, persists an asset_version, and completes the job", async () => {
    const supa = seedSupa([baseJob({ id: "job-ok", idempotency_key: "idem-ok" })]);
    const pollMock = vi.fn(async (): Promise<GenerateResult> => ({
      status: "succeeded",
      provider_job_id: "prov-job-x",
      units: 6,
      unit_type: "second",
      asset: {
        storage_path: "assets/fake.mp4",
        mime: "video/mp4",
        metadata: { width: 1080, height: 1920, aspect: "9:16", resolution: "1080p" },
      },
      raw: {},
    }));
    const deps = makeDeps(supa, pollMock);
    const job = (await deps.jobs.get("job-ok"))!;

    await reconcileJob({ ...deps, job });

    expect(pollMock).toHaveBeenCalledWith("prov-job-x", "fake-provider-key");

    expect(supa._tables.cost_log).toHaveLength(1);
    const costRow = supa._tables.cost_log[0];
    expect(costRow.call_status).toBe("success");
    expect(costRow.idempotency_key).toBe("idem-ok");
    expect(costRow.cost_usd).toBeCloseTo(0.72, 6); // 6 units * $0.12

    expect(supa._tables.asset_versions).toHaveLength(1);
    const versionRow = supa._tables.asset_versions[0];

    const jobRow = supa._tables.jobs.find((j) => j.id === "job-ok")!;
    expect(jobRow.status).toBe("succeeded");
    expect((jobRow.result as FakeRow)?.asset_version_id).toBe(versionRow.id);

    const assetRow = supa._tables.assets.find((a) => a.id === ASSET_ID)!;
    expect(assetRow.current_version_id).toBe(versionRow.id);
  });
});

describe("reconcileJob — transient failure, retries remaining (N1 core fix)", () => {
  it("re-arms via jobs.retryLater instead of jobs.fail(): status stays awaiting_provider, attempts +1, run_after moves forward, and NO cost_log row is written", async () => {
    const supa = seedSupa([baseJob({ id: "job-transient", attempts: 0, max_attempts: 3, idempotency_key: "idem-transient" })]);
    const originalRunAfter = supa._tables.jobs[0].run_after as string;
    const pollMock = vi.fn(async (): Promise<GenerateResult> => {
      throw new Error("veo: 503 from provider");
    });
    const deps = makeDeps(supa, pollMock);
    const job = (await deps.jobs.get("job-transient"))!;

    await reconcileJob({ ...deps, job });

    // The whole point of N1: this generation's real idempotency_key must not
    // be burned by a cost_log row on a merely-transient path.
    expect(supa._tables.cost_log).toHaveLength(0);

    const row = supa._tables.jobs.find((j) => j.id === "job-transient")!;
    expect(row.status).toBe("awaiting_provider"); // never 'queued' (jobs.fail()'s default) or 'failed'
    expect(row.attempts).toBe(1); // bumped by exactly one attempt
    expect(row.error).toMatch(/veo: 503 from provider/);
    expect(new Date(row.run_after as string).getTime()).toBeGreaterThan(new Date(originalRunAfter).getTime());
    expect(row.locked_by).toBeNull(); // retryLater releases the lock so another tick can reclaim it
  });

  it("caps the linear backoff at RECONCILE_RETRY_BACKOFF_CAP_MS (5 min) instead of growing unbounded with attempts", async () => {
    const supa = seedSupa([baseJob({ id: "job-highattempts", attempts: 20, max_attempts: 25, idempotency_key: "idem-high" })]);
    const before = Date.now();
    const pollMock = vi.fn(async (): Promise<GenerateResult> => {
      throw new Error("still failing");
    });
    const deps = makeDeps(supa, pollMock);
    const job = (await deps.jobs.get("job-highattempts"))!;

    await reconcileJob({ ...deps, job });

    const row = supa._tables.jobs.find((j) => j.id === "job-highattempts")!;
    const backoffMs = new Date(row.run_after as string).getTime() - before;
    // Uncapped linear backoff would be 30_000 * (20+1) = 630_000ms (10.5min);
    // RECONCILE_RETRY_BACKOFF_CAP_MS caps it to 5 minutes.
    expect(backoffMs).toBeGreaterThan(4 * 60_000);
    expect(backoffMs).toBeLessThanOrEqual(5 * 60_000 + 2_000); // +2s slack for test execution time
  });
});

describe("reconcileJob — retries exhausted (genuine terminal failure)", () => {
  it("logs failed_unbilled under the real idempotency_key and calls jobs.fail(..., {retry:false}) once attempts >= max_attempts", async () => {
    const supa = seedSupa([baseJob({ id: "job-exhausted", attempts: 3, max_attempts: 3, idempotency_key: "idem-exhausted" })]);
    const pollMock = vi.fn(async (): Promise<GenerateResult> => {
      throw new Error("veo: permanently gone (404)");
    });
    const deps = makeDeps(supa, pollMock);
    const job = (await deps.jobs.get("job-exhausted"))!;

    await reconcileJob({ ...deps, job });

    expect(supa._tables.cost_log).toHaveLength(1);
    const costRow = supa._tables.cost_log[0];
    expect(costRow.call_status).toBe("failed_unbilled");
    expect(costRow.cost_usd).toBe(0);
    expect(costRow.idempotency_key).toBe("idem-exhausted");

    const row = supa._tables.jobs.find((j) => j.id === "job-exhausted")!;
    expect(row.status).toBe("failed"); // terminal — retry:false overrides jobs.fail()'s default "retryable -> queued"
    expect(row.error).toMatch(/veo: permanently gone \(404\)/);
  });
});

describe("reconcileJob — defensive early-return guard", () => {
  it("is a no-op (never calls poll()) for a job whose type/payload doesn't map to a pollable category, e.g. a crossfade-route outro_gen row", async () => {
    const supa = seedSupa([
      baseJob({
        id: "job-no-category",
        type: "outro_gen",
        provider: null,
        payload: { call_type: "generate", route: "crossfade" },
      }),
    ]);
    const pollMock = vi.fn();
    const deps = makeDeps(supa, pollMock as unknown as NonNullable<Adapter["poll"]>);
    const job = (await deps.jobs.get("job-no-category"))!;

    await expect(reconcileJob({ ...deps, job })).resolves.toBeUndefined();

    expect(pollMock).not.toHaveBeenCalled();
    const row = supa._tables.jobs.find((j) => j.id === "job-no-category")!;
    expect(row.status).toBe("awaiting_provider");
  });
});

describe("runReconcileTick — claims + fans out to reconcileJob", () => {
  it("claims every awaiting_provider job via the RPC and reconciles each independently, returning the claimed count", async () => {
    const supa = seedSupa([
      baseJob({ id: "job-a", provider_job_id: "prov-a", idempotency_key: "idem-a" }),
      baseJob({ id: "job-b", provider_job_id: "prov-b", idempotency_key: "idem-b" }),
    ]);
    supa._registerRpc("claim_awaiting_jobs", () => supa._tables.jobs.filter((j) => j.status === "awaiting_provider"));

    const pollMock = vi.fn(async (providerJobId: string): Promise<GenerateResult> => ({
      status: "pending",
      provider_job_id: providerJobId,
      units: 6,
      unit_type: "second",
      raw: {},
    }));
    const deps = makeDeps(supa, pollMock);

    const claimedCount = await runReconcileTick({
      ...deps,
      storage: {} as StorageClient,
      workerId: "worker-test-1",
    });

    expect(claimedCount).toBe(2);
    expect(pollMock).toHaveBeenCalledTimes(2);
    expect(pollMock).toHaveBeenCalledWith("prov-a", "fake-provider-key");
    expect(pollMock).toHaveBeenCalledWith("prov-b", "fake-provider-key");
  });
});
