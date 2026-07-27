/**
 * Pure `resolveRate` resolution logic (§2.2 rate_card), split out from
 * src/lib/cost/engine.ts so it is unit-testable with plain in-memory rows —
 * no Supabase/network access needed.
 *
 * Deterministic match: (provider, unit_type) and variant (NULL matches only
 * when the call itself has no variant) where `at` falls in
 * [effective_from, effective_to); prefers a client_id-specific row over the
 * agency-wide (client_id NULL) row; no match -> null (caller sets
 * rate_missing=true, cost_usd=NULL).
 */

export interface RateCardRow {
  id: string;
  provider: string;
  unit_type: string;
  variant: string | null;
  unit_cost_usd: number;
  currency: string;
  client_id: string | null;
  effective_from: string; // ISO timestamptz
  effective_to: string | null; // ISO timestamptz
  source_note?: string | null;
}

export interface ResolveRateParams {
  provider: string;
  unit_type: string;
  variant?: string | null;
  client_id: string;
  at?: Date;
}

export function resolveRateFromRows(rows: RateCardRow[], params: ResolveRateParams): RateCardRow | null {
  const at = (params.at ?? new Date()).getTime();
  const variant = params.variant ?? null;

  const candidates = rows.filter((row) => {
    if (row.provider !== params.provider) return false;
    if (row.unit_type !== params.unit_type) return false;
    if (row.variant !== variant) return false;
    const from = new Date(row.effective_from).getTime();
    if (at < from) return false;
    if (row.effective_to != null && at >= new Date(row.effective_to).getTime()) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  const clientSpecific = candidates.find((row) => row.client_id === params.client_id);
  if (clientSpecific) return clientSpecific;

  const agencyWide = candidates.filter((row) => row.client_id === null);
  if (agencyWide.length > 0) {
    return [...agencyWide].sort(
      (a, b) => new Date(b.effective_from).getTime() - new Date(a.effective_from).getTime()
    )[0];
  }

  return candidates[0];
}

/** Round to 6dp — enough headroom for sub-cent per-unit rates (e.g. $0.039/image) without float noise. */
export function roundMoney(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
