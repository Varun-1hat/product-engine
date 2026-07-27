/**
 * app/api/webhooks/heygen/route.ts — per .pipeline/changes.md "What the
 * Tester should focus on" #5, this route had ZERO automated test coverage
 * (build-verified only). Mocks ONLY the module boundary named in the
 * Tester brief (src/lib/supabase/service.ts's createServiceClient) with a
 * fake Postgrest/storage client (src/testUtils/fakeSupabase.ts) and global
 * fetch (for the video download) — everything else (the REAL adapter
 * registry, the REAL heygen adapter's parseWebhook(), the REAL job queue /
 * cost engine / versioning helpers) runs unmocked, so this exercises the
 * actual production wiring: callback_token auth, and the
 * "job.payload -> cost_log/asset_versions.metadata" handoff the Coder
 * explicitly flagged as the least spec-literal, highest-risk part of the
 * adapter contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow, type FakeSupabaseClient } from "@/src/testUtils/fakeSupabase";

let currentSupa: FakeSupabaseClient = createFakeSupabase();

vi.mock("@/src/lib/supabase/service", () => ({
  createServiceClient: () => currentSupa,
}));

const { POST } = await import("./route");
const { NextRequest } = await import("next/server");
const { buildPollResultPath } = await import("@/src/lib/storage");

const REEL_ID = "reel-1";
const CLIENT_ID = "client-1";
const SCENE_ID = "scene-1";
const ASSET_ID = "asset-1";

const RATE_CARD_SEED: FakeRow[] = [
  {
    id: "rate-heygen-1",
    provider: "heygen",
    unit_type: "video",
    variant: null,
    unit_cost_usd: 7.0,
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
        slot: "avatar_clip",
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
  const supa = createFakeSupabase(baseTables(jobs), {
    uniqueConstraints: [
      { table: "cost_log", columns: ["reel_id", "provider", "idempotency_key"], where: (r) => r.idempotency_key != null },
    ],
  });
  currentSupa = supa;
  return supa;
}

function baseJob(overrides: FakeRow): FakeRow {
  return {
    id: "job-x",
    reel_id: REEL_ID,
    scene_id: SCENE_ID,
    asset_id: ASSET_ID,
    type: "avatar_gen",
    provider: "heygen",
    status: "awaiting_provider",
    provider_job_id: "vid_x",
    attempts: 0,
    max_attempts: 3,
    idempotency_key: null,
    payload: {},
    result: null,
    error: null,
    callback_token: "tok-x",
    locked_by: null,
    locked_at: null,
    run_after: new Date().toISOString(),
    ...overrides,
  };
}

function postWebhook(token: string | null, body: unknown): Promise<Response> {
  const url = token
    ? `http://localhost/api/webhooks/heygen?token=${encodeURIComponent(token)}`
    : "http://localhost/api/webhooks/heygen";
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

function videoDownloadResponse(bytes = "fake-mp4-bytes"): Response {
  const buf = new TextEncoder().encode(bytes);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "video/mp4" }),
    arrayBuffer: async () => buf.buffer,
  } as unknown as Response;
}

describe("POST /api/webhooks/heygen — callback_token auth", () => {
  beforeEach(() => {
    seedSupa([]);
  });

  it("401s when no token query param is present at all", async () => {
    const res = await postWebhook(null, { event: "avatar_video.success", video_id: "v1" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/missing callback token/);
  });

  it("401s on an unknown/expired token — never trusts the payload body alone (spec §3.1: 'verify callback_token')", async () => {
    seedSupa([baseJob({ id: "job-real", callback_token: "tok-real" })]);
    const res = await postWebhook("tok-does-not-exist", { event: "avatar_video.success", video_id: "v1" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unknown or expired callback token/);
  });

  it("500s defensively when the looked-up job has no reel_id (should never happen for avatar_gen, but the route checks explicitly)", async () => {
    seedSupa([baseJob({ id: "job-no-reel", reel_id: null, callback_token: "tok-no-reel", type: "avatar_pull" })]);
    const res = await postWebhook("tok-no-reel", { event: "avatar_video.success", video_id: "v1" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/no reel_id/);
  });
});

describe("POST /api/webhooks/heygen — avatar_video.fail", () => {
  it("logs a failed_unbilled cost row (parseWebhook reports billed:false on failure) and fails the job", async () => {
    const supa = seedSupa([
      baseJob({
        id: "job-fail",
        callback_token: "tok-fail",
        idempotency_key: "idem-fail-1",
        attempts: 3,
        max_attempts: 3, // exhausted -> jobs.fail() marks it terminally "failed", not retried
        payload: { call_type: "generate", units: 1, unit_type: "video" },
      }),
    ]);

    const res = await postWebhook("tok-fail", { event: "avatar_video.fail", video_id: "vid_fail_1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(supa._tables.cost_log).toHaveLength(1);
    const logRow = supa._tables.cost_log[0];
    expect(logRow.call_status).toBe("failed_unbilled");
    expect(logRow.cost_usd).toBe(0);
    expect(logRow.provider).toBe("heygen");
    expect(logRow.stage).toBe("clip");

    const jobRow = supa._tables.jobs.find((j) => j.id === "job-fail");
    expect(jobRow?.status).toBe("failed");
  });
});

describe("POST /api/webhooks/heygen — avatar_video.success", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads the video, uploads it, logs the real $7 flat cost, and persists an asset_version using job.payload metadata (NOT the adapter's placeholder)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(videoDownloadResponse());
    vi.stubGlobal("fetch", fetchMock);

    // Deliberately DIFFERENT from heygen.ts's hardcoded placeholder
    // (aspect "9:16", resolution "1080p", no duration_s) — if the route
    // ever regresses to trusting parseWebhook()'s placeholder metadata
    // instead of job.payload, these assertions below will catch it.
    const supa = seedSupa([
      baseJob({
        id: "job-success",
        callback_token: "tok-success",
        provider_job_id: "vid_success_1",
        idempotency_key: "idem-success-1",
        payload: { call_type: "generate", units: 1, unit_type: "video", aspect_ratio: "1:1", resolution: "720p", duration_s: 11 },
      }),
    ]);

    const res = await postWebhook("tok-success", {
      event: "avatar_video.success",
      video_id: "vid_success_1",
      video_url: "https://cdn.heygen.example/vid_success_1.mp4",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith("https://cdn.heygen.example/vid_success_1.mp4");

    const expectedPath = buildPollResultPath({ provider: "heygen", provider_job_id: "vid_success_1", ext: "mp4" });
    expect(supa._uploads).toHaveLength(1);
    expect(supa._uploads[0]).toMatchObject({ bucket: "assets", path: expectedPath });

    expect(supa._tables.cost_log).toHaveLength(1);
    const logRow = supa._tables.cost_log[0];
    expect(logRow.call_status).toBe("success");
    expect(logRow.cost_usd).toBe(7.0);
    expect(logRow.rate_card_id).toBe("rate-heygen-1");
    expect(logRow.units).toBe(1);
    expect(logRow.unit_type).toBe("video");

    expect(supa._tables.asset_versions).toHaveLength(1);
    const versionRow = supa._tables.asset_versions[0];
    expect(versionRow.asset_id).toBe(ASSET_ID);
    expect(versionRow.storage_path).toBe(expectedPath);
    expect(versionRow.source).toBe("generated");
    expect(versionRow.provider).toBe("heygen");
    const metadata = versionRow.metadata as Record<string, unknown>;
    expect(metadata.aspect).toBe("1:1");
    expect(metadata.resolution).toBe("720p");
    expect(metadata.duration_s).toBe(11);

    const jobRow = supa._tables.jobs.find((j) => j.id === "job-success");
    expect(jobRow?.status).toBe("succeeded");
    expect((jobRow?.result as Record<string, unknown>)?.asset_version_id).toBe(versionRow.id);

    const assetRow = supa._tables.assets.find((a) => a.id === ASSET_ID);
    expect(assetRow?.current_version_id).toBe(versionRow.id);
  });

  it("400s when the webhook reports success but carries no asset url, and touches neither cost_log nor the job", async () => {
    const supa = seedSupa([
      baseJob({
        id: "job-no-url",
        callback_token: "tok-no-url",
        provider_job_id: "vid_no_url",
        payload: { call_type: "generate", units: 1, unit_type: "video" },
      }),
    ]);

    const res = await postWebhook("tok-no-url", { event: "avatar_video.success", video_id: "vid_no_url" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no asset url was present/);

    expect(supa._tables.cost_log).toHaveLength(0);
    const jobRow = supa._tables.jobs.find((j) => j.id === "job-no-url");
    expect(jobRow?.status).toBe("awaiting_provider");
  });

  it("a resent webhook (same idempotency_key) does NOT double-charge cost_log, even though it is not the cost engine being tested directly here", async () => {
    const fetchMock = vi.fn().mockResolvedValue(videoDownloadResponse());
    vi.stubGlobal("fetch", fetchMock);

    const supa = seedSupa([
      baseJob({
        id: "job-retry",
        callback_token: "tok-retry",
        provider_job_id: "vid_retry",
        idempotency_key: "idem-retry-1",
        payload: { call_type: "generate", units: 1, unit_type: "video", aspect_ratio: "9:16", resolution: "1080p" },
      }),
    ]);

    const body = { event: "avatar_video.success", video_id: "vid_retry", video_url: "https://cdn.heygen.example/vid_retry.mp4" };
    const first = await postWebhook("tok-retry", body);
    const second = await postWebhook("tok-retry", body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(supa._tables.cost_log.filter((r) => r.idempotency_key === "idem-retry-1")).toHaveLength(1);
  });
});
