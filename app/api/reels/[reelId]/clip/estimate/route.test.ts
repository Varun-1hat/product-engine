/**
 * app/api/reels/[reelId]/clip/estimate/route.ts — per .pipeline/changes.md
 * "What the Tester should focus on" #5/#6: no app/api/** route had request-
 * level test coverage, and HeyGen's flat $7/video billing was verified only
 * at the adapter level, "not yet re-verified end-to-end through the route".
 *
 * This mocks ONLY src/lib/supabase/service.ts's createServiceClient (the
 * boundary named in the Tester brief) with a fake Postgrest client
 * (src/testUtils/fakeSupabase.ts); everything downstream — src/lib/context.ts's
 * buildStageContext, the REAL adapter registry (real Veo/HeyGen adapters),
 * and the REAL cost engine's rate resolution — runs unmocked. Running the
 * real stage/adapter code against a rate_card seed that mirrors
 * supabase/migrations/0004_seed_rate_card.sql exactly (rather than a
 * synthetic one shaped to whatever the code happens to emit) originally
 * surfaced a genuine bug (Veo's variant was never composed with resolution
 * before hitting resolveRate) — see .pipeline/test-results.md. The Coder has
 * since fixed it in src/adapters/video_broll/veo.ts, src/stages/clip/index.ts
 * and src/stages/outro/index.ts; the last describe block below is now kept
 * as a regression guard rather than a live bug report.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow, type FakeSupabaseClient } from "@/src/testUtils/fakeSupabase";

let currentSupa: FakeSupabaseClient = createFakeSupabase();

vi.mock("@/src/lib/supabase/service", () => ({
  createServiceClient: () => currentSupa,
}));

const { GET } = await import("./route");
const { NextRequest } = await import("next/server");

const REEL_ID = "reel-ctx-1";
const CLIENT_ID = "client-ctx-check";

/** Mirrors supabase/migrations/0004_seed_rate_card.sql's Veo rows exactly (§14.4). */
const VEO_RATE_CARD_SEED: FakeRow[] = [
  { id: "veo-standard-720p", provider: "veo", unit_type: "second", variant: "standard@720p", unit_cost_usd: 0.4, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
  { id: "veo-standard-1080p", provider: "veo", unit_type: "second", variant: "standard@1080p", unit_cost_usd: 0.4, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
  { id: "veo-fast-720p", provider: "veo", unit_type: "second", variant: "fast@720p", unit_cost_usd: 0.1, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
  { id: "veo-fast-1080p", provider: "veo", unit_type: "second", variant: "fast@1080p", unit_cost_usd: 0.12, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
];

function seed(rateCard: FakeRow[]): FakeSupabaseClient {
  const supa = createFakeSupabase({
    reels: [{ id: REEL_ID, client_id: CLIENT_ID, display_name: "Ctx Reel", current_stage: "clip", status: "in_progress" }],
    reel_config: [
      {
        reel_id: REEL_ID,
        topic: "widget",
        total_seconds_target: 20,
        avatar_enabled: true,
        broll_provider: "veo",
        image_provider: "nano_banana",
        veo_variant: "fast",
        outro_provider_override: null,
        avatar_look_id: "avatar-1",
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
    ],
    scenes: [
      { id: "scene-broll", reel_id: REEL_ID, position: 0, type: "broll", product_in_scene: false, seconds: 5, transition_to_next: "hard_cut", broll_provider_override: null, description: "b-roll" },
      { id: "scene-avatar-long", reel_id: REEL_ID, position: 1, type: "avatar", product_in_scene: false, seconds: 15, transition_to_next: "hard_cut", broll_provider_override: null, description: "avatar long" },
      { id: "scene-avatar-short", reel_id: REEL_ID, position: 2, type: "avatar", product_in_scene: false, seconds: 4, transition_to_next: null, broll_provider_override: null, description: "avatar short" },
    ] as FakeRow[],
    rate_card: rateCard,
  });
  currentSupa = supa;
  return supa;
}

function getEstimate(reelId: string): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/reels/${reelId}/clip/estimate`);
  return GET(req, { params: Promise.resolve({ reelId }) });
}

describe("GET /api/reels/[reelId]/clip/estimate — context threading (reelId -> clientId via buildStageContext)", () => {
  it("resolves ctx.clientId from the reel row and carries it onto every EstimateCall (Higgsfield/agency-override lookups depend on this)", async () => {
    seed([
      { id: "heygen-flat", provider: "heygen", unit_type: "video", variant: null, unit_cost_usd: 7.0, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
      ...VEO_RATE_CARD_SEED,
    ]);
    const res = await getEstimate(REEL_ID);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lines.length).toBeGreaterThan(0);
    for (const line of body.lines) {
      // Every line must carry the client_id resolved from reels.client_id via
      // buildStageContext -> ctx.clientId, NOT an empty/undefined value.
      expect(line.client_id).toBe(CLIENT_ID);
    }

    const brollLine = body.lines.find((l: FakeRow) => l.provider === "veo");
    // billableDurationS(5) picks the smallest of [4,6,8] >= 5 -> 6 seconds billed
    // (independent of the rate-resolution bug documented below).
    expect(brollLine.units).toBe(6);
  });
});

describe("GET /api/reels/[reelId]/clip/estimate — HeyGen flat $7/video (R3), isolated from b-roll billing", () => {
  it("HeyGen's cost is identical for a 15s scene and a 4s scene, and is unaffected by whatever the Veo line resolves to", async () => {
    seed([
      { id: "heygen-flat", provider: "heygen", unit_type: "video", variant: null, unit_cost_usd: 7.0, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
      ...VEO_RATE_CARD_SEED,
    ]);
    const res = await getEstimate(REEL_ID);
    const body = await res.json();

    const heygenLines = body.lines.filter((l: FakeRow) => l.provider === "heygen");
    expect(heygenLines).toHaveLength(2);
    for (const line of heygenLines) {
      expect(line.units).toBe(1);
      expect(line.unit_type).toBe("video");
      expect(line.cost_usd).toBe(7.0);
      expect(line.unit_cost_usd).toBe(7.0);
    }
  });

  it("a scene with no effective b-roll model (all-avatar reel, broll_provider unset) is skipped rather than blocking the whole estimate", async () => {
    const supa = seed([
      { id: "heygen-flat", provider: "heygen", unit_type: "video", variant: null, unit_cost_usd: 7.0, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
    ]);
    supa._tables.reel_config[0].broll_provider = null;

    const res = await getEstimate(REEL_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines.some((l: FakeRow) => l.provider === "veo")).toBe(false);
    expect(body.lines.filter((l: FakeRow) => l.provider === "heygen")).toHaveLength(2);
    // No Higgsfield/Veo line was attempted at all, so nothing is rate_missing.
    expect(body.rate_missing).toBe(false);
    expect(body.total_usd).toBeCloseTo(14.0, 6);
  });
});

describe("GET /api/reels/[reelId]/clip/estimate — Veo variant@resolution rate resolution (regression guard)", () => {
  it("a Veo b-roll line resolves against the EXACT rate_card seed shape from supabase/migrations/0004_seed_rate_card.sql", async () => {
    // Originally this test's seed() call carried ONLY the Veo rows (no
    // heygen-flat row) and asserted body.rate_missing===false. That assertion
    // failed for TWO independent reasons at the time:
    //   (1) [the real bug, since fixed] Veo's variant was never composed with
    //       resolution anywhere in the runtime path, so the veo line itself
    //       never resolved a rate.
    //   (2) [a fixture gap in this test, fixed now] the shared seed() fixture
    //       always includes 2 avatar (HeyGen) scenes regardless of which
    //       rate_card rows are passed in, and this call omitted heygen-flat —
    //       so even with (1) fixed, the two HeyGen lines would still have come
    //       back rate_missing on their own, independent of Veo entirely. Every
    //       sibling test in this file already includes heygen-flat for
    //       exactly this reason; this one now does too.
    //
    // Root cause of (1) (confirmed by reading source, not just this test):
    //   - supabase/migrations/0004_seed_rate_card.sql seeds Veo rate_card rows
    //     with variant values "standard@720p" / "standard@1080p" /
    //     "fast@720p" / "fast@1080p", with an explicit comment: "the adapter
    //     emits variant = '<veo_variant>@<reel resolution>'; resolveRate
    //     matches it."
    //   - src/adapters/video_broll/veo.ts's estimate()/generate() used to emit
    //     the BARE veo_variant ("standard"/"fast") with no resolution suffix,
    //     and src/stages/clip/index.ts / src/stages/outro/index.ts passed
    //     `variant: reelConfig.veo_variant` straight through uncomposed too.
    //   - src/lib/cost/rateCard.ts's resolveRateFromRows() requires an EXACT
    //     string match on `variant`, so "fast" never matched "fast@1080p".
    // The Coder has since composed `${veo_variant}@${resolution}` in those
    // three files (plus a related fix in worker/outro.ts) — see
    // .pipeline/test-results.md for the full history. The assertions below
    // now pass and this test stays as a regression guard.
    seed([
      { id: "heygen-flat", provider: "heygen", unit_type: "video", variant: null, unit_cost_usd: 7.0, currency: "USD", client_id: null, effective_from: "2026-01-01T00:00:00.000Z", effective_to: null },
      ...VEO_RATE_CARD_SEED,
    ]);
    const res = await getEstimate(REEL_ID);
    const body = await res.json();
    const brollLine = body.lines.find((l: FakeRow) => l.provider === "veo");

    expect(brollLine.unit_cost_usd).toBe(0.12); // fast@1080p tier (spec §14.4)
    expect(brollLine.cost_usd).toBeCloseTo(0.72, 6); // 6s billed * $0.12
    expect(body.rate_missing).toBe(false);
    expect(body.total_usd).toBeCloseTo(0.72 + 7.0 * 2, 6); // veo line + 2 flat HeyGen avatar lines
  });
});
