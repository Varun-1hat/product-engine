/**
 * src/lib/cost/engine.ts — the Supabase-touching half of the cost engine
 * (src/lib/cost/rateCard.test.ts already covers the pure resolveRateFromRows
 * matching logic in isolation). These tests exercise createCostEngine()
 * against a fake Supabase client (src/testUtils/fakeSupabase.ts) so the
 * actual `log()`/`estimate()`/`spentSoFar()` code paths run for real,
 * including the partial-unique-index idempotency retry on `cost_log`
 * (spec §2.2: "Partial UNIQUE(reel_id, provider, idempotency_key) WHERE
 * idempotency_key IS NOT NULL — prevents double-charge on retries") and the
 * failed_unbilled vs rate_missing cost_usd distinction (spec §4).
 */
import { describe, expect, it } from "vitest";
import { createCostEngine } from "./engine";
import { createFakeSupabase, type FakeRow } from "@/src/testUtils/fakeSupabase";
import type { ServiceClient } from "@/src/lib/supabase/service";

const RATE_CARD_SEED: FakeRow[] = [
  {
    id: "rate-nano-banana",
    provider: "nano_banana",
    unit_type: "image",
    variant: null,
    unit_cost_usd: 0.039,
    currency: "USD",
    client_id: null,
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
    source_note: null,
  },
  {
    id: "rate-heygen",
    provider: "heygen",
    unit_type: "video",
    variant: null,
    unit_cost_usd: 7.0,
    currency: "USD",
    client_id: null,
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
    source_note: null,
  },
  {
    id: "rate-veo-fast-1080p",
    provider: "veo",
    unit_type: "second",
    variant: "fast@1080p",
    unit_cost_usd: 0.12,
    currency: "USD",
    client_id: null,
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
    source_note: null,
  },
  // Higgsfield deliberately NOT seeded (spec §14.4: "do not seed a value ...
  // until set, rate_missing=true, cost_usd=NULL") — used below to exercise
  // the rate_missing path.
];

function makeEngine(seed: Record<string, FakeRow[]> = {}) {
  const supa = createFakeSupabase(
    { rate_card: RATE_CARD_SEED, cost_log: [], ...seed },
    {
      uniqueConstraints: [
        // Mirrors supabase/migrations/0001_init.sql's partial unique index.
        { table: "cost_log", columns: ["reel_id", "provider", "idempotency_key"], where: (r) => r.idempotency_key != null },
      ],
    }
  );
  const engine = createCostEngine(supa as unknown as ServiceClient);
  return { engine, supa };
}

describe("createCostEngine().log()", () => {
  it("resolves the matching rate_card row and computes cost_usd for a successful call", async () => {
    const { engine, supa } = makeEngine();
    const row = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "image",
      provider: "nano_banana",
      adapter: "nano_banana@1",
      call_type: "generate",
      call_status: "success",
      units: 1,
      unit_type: "image",
    });

    expect(row.cost_usd).toBe(0.039);
    expect(row.unit_cost_usd).toBe(0.039);
    expect(row.rate_card_id).toBe("rate-nano-banana");
    expect(row.rate_missing).toBe(false);
    expect(supa._tables.cost_log).toHaveLength(1);
  });

  it("HeyGen redo bills the flat $7 rate exactly like a first generate (R3/edge #12)", async () => {
    const { engine } = makeEngine();
    const row = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "redo",
      call_status: "success",
      units: 1,
      unit_type: "video",
    });
    expect(row.cost_usd).toBe(7.0);
    expect(row.call_type).toBe("redo");
  });

  it("failed_unbilled forces cost_usd=0 even when units/unit_type are present (a known zero, not 'rate not configured')", async () => {
    const { engine } = makeEngine();
    const row = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "generate",
      call_status: "failed_unbilled",
      units: 1,
      unit_type: "video",
    });
    expect(row.cost_usd).toBe(0);
    expect(row.rate_missing).toBe(false);
    expect(row.unit_cost_usd).toBeNull();
  });

  it("rate_missing=true and cost_usd=NULL when no rate_card row matches (Higgsfield, not yet seeded — spec §14.4)", async () => {
    const { engine } = makeEngine();
    const row = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "higgsfield",
      adapter: "higgsfield@1",
      call_type: "generate",
      call_status: "success",
      units: 3,
      unit_type: "credit",
    });
    expect(row.cost_usd).toBeNull();
    expect(row.rate_missing).toBe(true);
    expect(row.rate_card_id).toBeNull();
  });

  it("a distinct billed failure (failed_billed) still prices against the rate card, unlike failed_unbilled", async () => {
    const { engine } = makeEngine();
    const row = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "generate",
      call_status: "failed_billed",
      units: 1,
      unit_type: "video",
    });
    expect(row.cost_usd).toBe(7.0);
  });

  it("idempotency-key retry on the SAME (reel_id, provider, idempotency_key) does NOT double-charge — returns the original row", async () => {
    const { engine, supa } = makeEngine();
    const first = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "generate",
      call_status: "success",
      units: 1,
      unit_type: "video",
      idempotency_key: "idem-abc",
    });

    // Simulate a retried webhook/poll delivering the exact same completion twice.
    const second = await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "generate",
      call_status: "success",
      units: 1,
      unit_type: "video",
      idempotency_key: "idem-abc",
    });

    expect(second.id).toBe(first.id);
    expect(supa._tables.cost_log.filter((r) => r.idempotency_key === "idem-abc")).toHaveLength(1);
  });

  it("a different idempotency_key on the same reel/provider is NOT deduped (genuinely a second billable call)", async () => {
    const { engine, supa } = makeEngine();
    await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "generate",
      call_status: "success",
      units: 1,
      unit_type: "video",
      idempotency_key: "idem-1",
    });
    await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "clip",
      provider: "heygen",
      adapter: "heygen@1",
      call_type: "redo",
      call_status: "success",
      units: 1,
      unit_type: "video",
      idempotency_key: "idem-2",
    });
    expect(supa._tables.cost_log).toHaveLength(2);
  });

  it("calls with no idempotency_key at all are never deduped (only the partial index applies when it's set)", async () => {
    const { engine, supa } = makeEngine();
    await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "image",
      provider: "nano_banana",
      adapter: "nano_banana@1",
      call_type: "generate",
      call_status: "success",
      units: 1,
      unit_type: "image",
    });
    await engine.log({
      reel_id: "reel-1",
      client_id: "client-1",
      stage: "image",
      provider: "nano_banana",
      adapter: "nano_banana@1",
      call_type: "redo",
      call_status: "success",
      units: 1,
      unit_type: "image",
    });
    expect(supa._tables.cost_log).toHaveLength(2);
  });
});

describe("createCostEngine().estimate()", () => {
  it("sums cost across multiple calls when every rate resolves", async () => {
    const { engine } = makeEngine();
    const result = await engine.estimate([
      { provider: "nano_banana", category: "image", unit_type: "image", units: 2, client_id: "client-1" },
      { provider: "heygen", category: "video_avatar", unit_type: "video", units: 1, client_id: "client-1" },
    ]);
    expect(result.rate_missing).toBe(false);
    expect(result.total_usd).toBeCloseTo(0.039 * 2 + 7.0, 6);
    expect(result.lines).toHaveLength(2);
  });

  it("Veo estimate resolves the correct variant@resolution tier", async () => {
    const { engine } = makeEngine();
    const result = await engine.estimate([
      { provider: "veo", category: "video_broll", unit_type: "second", variant: "fast@1080p", units: 8, client_id: "client-1" },
    ]);
    expect(result.lines[0].unit_cost_usd).toBe(0.12);
    expect(result.total_usd).toBeCloseTo(0.96, 6);
  });

  it("a single rate_missing line (Higgsfield) suppresses the overall total_usd to null but still reports resolved per-line costs", async () => {
    const { engine } = makeEngine();
    const result = await engine.estimate([
      { provider: "nano_banana", category: "image", unit_type: "image", units: 1, client_id: "client-1" },
      { provider: "higgsfield", category: "video_broll", unit_type: "credit", units: 5, client_id: "client-1" },
    ]);
    expect(result.rate_missing).toBe(true);
    expect(result.total_usd).toBeNull();
    const nanoLine = result.lines.find((l) => l.provider === "nano_banana");
    const higgsLine = result.lines.find((l) => l.provider === "higgsfield");
    // The resolved line still carries its own real cost even though the
    // aggregate total is suppressed — the UI can still show "$0.039" next
    // to the Nano Banana line and "rate not configured" next to Higgsfield.
    expect(nanoLine?.cost_usd).toBe(0.039);
    expect(higgsLine?.cost_usd).toBeNull();
  });

  it("returns an empty-but-valid result for zero calls", async () => {
    const { engine } = makeEngine();
    const result = await engine.estimate([]);
    expect(result).toEqual({ total_usd: 0, rate_missing: false, lines: [] });
  });
});

describe("createCostEngine().spentSoFar()", () => {
  it("aggregates cost_usd by stage and totals across stages, treating a null cost_usd (rate_missing rows) as 0 spent so far", async () => {
    const { engine } = makeEngine({
      cost_log: [
        { id: "c1", reel_id: "reel-1", stage: "image", cost_usd: 0.039 },
        { id: "c2", reel_id: "reel-1", stage: "image", cost_usd: 0.039 },
        { id: "c3", reel_id: "reel-1", stage: "clip", cost_usd: 7.0 },
        { id: "c4", reel_id: "reel-1", stage: "clip", cost_usd: null }, // rate_missing (Higgsfield) — $0 spent so far, not an error
        { id: "c5", reel_id: "reel-OTHER", stage: "image", cost_usd: 100 }, // different reel — must not leak in
      ],
    });
    const result = await engine.spentSoFar("reel-1");
    expect(result.by_stage.image).toBeCloseTo(0.078, 6);
    expect(result.by_stage.clip).toBeCloseTo(7.0, 6);
    expect(result.total_usd).toBeCloseTo(7.078, 6);
  });
});
