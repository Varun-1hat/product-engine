import { describe, expect, it } from "vitest";
import { resolveRateFromRows, roundMoney, type RateCardRow } from "./rateCard";

function row(overrides: Partial<RateCardRow> = {}): RateCardRow {
  return {
    id: "rate-1",
    provider: "nano_banana",
    unit_type: "image",
    variant: null,
    unit_cost_usd: 0.039,
    currency: "USD",
    client_id: null,
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: null,
    source_note: null,
    ...overrides,
  };
}

describe("resolveRateFromRows", () => {
  it("matches an agency-wide (client_id NULL) row with no variant", () => {
    const rows = [row()];
    const rate = resolveRateFromRows(rows, {
      provider: "nano_banana",
      unit_type: "image",
      client_id: "client-a",
    });
    expect(rate?.unit_cost_usd).toBe(0.039);
  });

  it("returns null when no row matches provider/unit_type", () => {
    const rows = [row()];
    const rate = resolveRateFromRows(rows, {
      provider: "higgsfield",
      unit_type: "credit",
      client_id: "client-a",
    });
    expect(rate).toBeNull();
  });

  it("requires an exact variant match — NULL variant rows do not satisfy a variant'd call", () => {
    const rows = [row({ id: "no-variant", variant: null, unit_cost_usd: 999 })];
    const rate = resolveRateFromRows(rows, {
      provider: "nano_banana",
      unit_type: "image",
      variant: "fast@1080p",
      client_id: "client-a",
    });
    expect(rate).toBeNull();
  });

  it("resolves the correct Veo tier by variant x resolution", () => {
    const rows: RateCardRow[] = [
      row({ id: "std-720", provider: "veo", unit_type: "second", variant: "standard@720p", unit_cost_usd: 0.4 }),
      row({ id: "fast-720", provider: "veo", unit_type: "second", variant: "fast@720p", unit_cost_usd: 0.1 }),
      row({ id: "fast-1080", provider: "veo", unit_type: "second", variant: "fast@1080p", unit_cost_usd: 0.12 }),
    ];
    const rate = resolveRateFromRows(rows, {
      provider: "veo",
      unit_type: "second",
      variant: "fast@1080p",
      client_id: "client-a",
    });
    expect(rate?.id).toBe("fast-1080");
    expect(rate?.unit_cost_usd).toBe(0.12);
  });

  it("prefers a client-specific override row over the agency-wide row", () => {
    const rows: RateCardRow[] = [
      row({ id: "agency", provider: "higgsfield", unit_type: "credit", unit_cost_usd: 0.05, client_id: null }),
      row({ id: "override", provider: "higgsfield", unit_type: "credit", unit_cost_usd: 0.08, client_id: "client-a" }),
    ];
    const forClientA = resolveRateFromRows(rows, {
      provider: "higgsfield",
      unit_type: "credit",
      client_id: "client-a",
    });
    const forClientB = resolveRateFromRows(rows, {
      provider: "higgsfield",
      unit_type: "credit",
      client_id: "client-b",
    });
    expect(forClientA?.id).toBe("override");
    expect(forClientB?.id).toBe("agency");
  });

  it("respects the effective_from/effective_to window ([from, to))", () => {
    const rows: RateCardRow[] = [
      row({
        id: "old",
        unit_cost_usd: 0.05,
        effective_from: "2025-01-01T00:00:00.000Z",
        effective_to: "2026-01-01T00:00:00.000Z",
      }),
      row({
        id: "new",
        unit_cost_usd: 0.039,
        effective_from: "2026-01-01T00:00:00.000Z",
        effective_to: null,
      }),
    ];
    expect(
      resolveRateFromRows(rows, {
        provider: "nano_banana",
        unit_type: "image",
        client_id: "c",
        at: new Date("2025-06-01T00:00:00.000Z"),
      })?.id
    ).toBe("old");
    expect(
      resolveRateFromRows(rows, {
        provider: "nano_banana",
        unit_type: "image",
        client_id: "c",
        at: new Date("2026-06-01T00:00:00.000Z"),
      })?.id
    ).toBe("new");
    // effective_to is exclusive: exactly at the boundary belongs to the new row.
    expect(
      resolveRateFromRows(rows, {
        provider: "nano_banana",
        unit_type: "image",
        client_id: "c",
        at: new Date("2026-01-01T00:00:00.000Z"),
      })?.id
    ).toBe("new");
  });

  it("returns null before effective_from (not yet effective)", () => {
    const rows = [row({ effective_from: "2099-01-01T00:00:00.000Z" })];
    const rate = resolveRateFromRows(rows, {
      provider: "nano_banana",
      unit_type: "image",
      client_id: "c",
      at: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(rate).toBeNull();
  });

  it("resolves the HeyGen flat per-video rate regardless of variant", () => {
    const rows = [row({ provider: "heygen", unit_type: "video", unit_cost_usd: 7.0 })];
    const rate = resolveRateFromRows(rows, {
      provider: "heygen",
      unit_type: "video",
      client_id: "c",
    });
    expect(rate?.unit_cost_usd).toBe(7.0);
  });
});

describe("roundMoney", () => {
  it("preserves sub-cent precision (Nano Banana $0.039/image)", () => {
    expect(roundMoney(0.039 * 1)).toBe(0.039);
    expect(roundMoney(0.039 * 10)).toBeCloseTo(0.39, 6);
  });

  it("suppresses floating point noise beyond 6dp", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });
});
