/**
 * src/lib/jobs/queue.ts had ZERO test coverage before this pass. Focus is
 * the two BLOCK-2/N1 additions from V2 Phase 0 (.pipeline/spec.md items 2
 * and 3): toPublicJob() (never leak callback_token/payload to a route
 * handler that JSON's a redoAsset() return value verbatim) and retryLater()
 * (re-arm an awaiting_provider job for another poll attempt WITHOUT routing
 * through fail()'s default retry-to-'queued' behavior — see
 * worker/reconcile.test.ts for the higher-level integration coverage of how
 * worker/reconcile.ts actually uses this). Also covers fail()'s existing
 * retry-vs-terminal branching for contrast, since retryLater's docstring
 * explicitly exists to avoid it for awaiting_provider jobs.
 */
import { describe, expect, it } from "vitest";
import { createJobQueue, toPublicJob, type Job } from "./queue";
import { createFakeSupabase, type FakeRow } from "@/src/testUtils/fakeSupabase";
import type { ServiceClient } from "@/src/lib/supabase/service";

function makeQueue() {
  const supa = createFakeSupabase({ jobs: [] });
  const queue = createJobQueue(supa as unknown as ServiceClient);
  return { supa, queue };
}

/** Full Job-shaped row for seeding the fake `jobs` table directly (bypassing enqueue()'s defaults). */
function fullJob(overrides: FakeRow = {}): FakeRow {
  return {
    id: "job-1",
    reel_id: "reel-1",
    scene_id: "scene-1",
    asset_id: "asset-1",
    type: "avatar_gen",
    provider: "heygen",
    status: "awaiting_provider",
    provider_job_id: "prov-1",
    attempts: 0,
    max_attempts: 3,
    idempotency_key: "idem-1",
    payload: { secret_internal_detail: "must never leak" },
    result: null,
    error: null,
    callback_token: "super-secret-callback-token",
    locked_by: null,
    locked_at: null,
    run_after: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("toPublicJob (BLOCK-2)", () => {
  it("keeps only id/status/type/provider_job_id — strips callback_token and payload", () => {
    const job = fullJob() as unknown as Job;
    const pub = toPublicJob(job);

    expect(pub).toEqual({
      id: "job-1",
      status: "awaiting_provider",
      type: "avatar_gen",
      provider_job_id: "prov-1",
    });
    expect(Object.keys(pub).sort()).toEqual(["id", "provider_job_id", "status", "type"]);
    expect("callback_token" in pub).toBe(false);
    expect("payload" in pub).toBe(false);
  });
});

describe("JobQueue.enqueue / get", () => {
  it("round-trips defaults (status defaulted by the DB layer's insert, max_attempts=3, callback_token/idempotency_key null when omitted)", async () => {
    const { queue, supa } = makeQueue();
    const job = await queue.enqueue({ reel_id: "reel-1", type: "trim" });

    expect(job.max_attempts).toBe(3);
    expect(job.callback_token).toBeNull();
    expect(job.idempotency_key).toBeNull();
    expect(supa._tables.jobs).toHaveLength(1);

    const fetched = await queue.get(job.id);
    expect(fetched?.id).toBe(job.id);
  });

  it("get() returns null for an unknown id rather than throwing", async () => {
    const { queue } = makeQueue();
    expect(await queue.get("does-not-exist")).toBeNull();
  });
});

describe("JobQueue.retryLater (N1)", () => {
  it("re-arms to awaiting_provider, bumps attempts by exactly one, sets run_after/error, and releases the lock", async () => {
    const { queue, supa } = makeQueue();
    supa._tables.jobs.push(
      fullJob({ id: "job-retry", status: "awaiting_provider", attempts: 1, locked_by: "worker-1", locked_at: new Date().toISOString() })
    );

    const runAfter = new Date(Date.now() + 60_000);
    const updated = await queue.retryLater("job-retry", runAfter, "429 from provider");

    expect(updated.status).toBe("awaiting_provider");
    expect(updated.attempts).toBe(2);
    expect(updated.run_after).toBe(runAfter.toISOString());
    expect(updated.error).toBe("429 from provider");
    expect(updated.locked_by).toBeNull();
    expect(updated.locked_at).toBeNull();
  });

  it("never transitions the job to 'queued' or 'failed', unlike fail()", async () => {
    const { queue, supa } = makeQueue();
    supa._tables.jobs.push(fullJob({ id: "job-retry-2", attempts: 0 }));

    await queue.retryLater("job-retry-2", new Date(Date.now() + 1_000));
    const row = supa._tables.jobs.find((j) => j.id === "job-retry-2");
    expect(row?.status).toBe("awaiting_provider");
  });

  it("defaults error to null when no message is given", async () => {
    const { queue, supa } = makeQueue();
    supa._tables.jobs.push(fullJob({ id: "job-retry-3", error: "stale previous error" }));

    const updated = await queue.retryLater("job-retry-3", new Date(Date.now() + 1_000));
    expect(updated.error).toBeNull();
  });
});

describe("JobQueue.fail — contrast with retryLater", () => {
  it("with attempts < max_attempts and no explicit retry:false, moves the job to 'queued' (why reconcile.ts needed retryLater instead)", async () => {
    const { queue, supa } = makeQueue();
    supa._tables.jobs.push(fullJob({ id: "job-fail-retryable", attempts: 0, max_attempts: 3 }));

    const updated = await queue.fail("job-fail-retryable", "transient error");
    expect(updated.status).toBe("queued");
  });

  it("with retry:false explicitly, terminates the job regardless of remaining attempts", async () => {
    const { queue, supa } = makeQueue();
    supa._tables.jobs.push(fullJob({ id: "job-fail-terminal", attempts: 0, max_attempts: 3 }));

    const updated = await queue.fail("job-fail-terminal", "permanent error", { retry: false });
    expect(updated.status).toBe("failed");
  });

  it("with attempts already at max_attempts, terminates even without an explicit retry:false", async () => {
    const { queue, supa } = makeQueue();
    supa._tables.jobs.push(fullJob({ id: "job-fail-exhausted", attempts: 3, max_attempts: 3 }));

    const updated = await queue.fail("job-fail-exhausted", "still failing");
    expect(updated.status).toBe("failed");
  });
});
