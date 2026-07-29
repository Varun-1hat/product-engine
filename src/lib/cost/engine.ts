/**
 * Cost engine (§4) — cross-cutting. Every adapter generate/redo/poll and
 * every billed failure gets logged here; estimates are per-scene (R2) using
 * the scene's effective model, priced via rate_card with NO provider call.
 * Server/worker-only by code-organization convention (see
 * src/lib/supabase/service.ts for why `server-only` is not used here —
 * this module must also run under Vitest and the tsx-run worker).
 */
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { Category, StageId, CallType, CallStatus, Provider } from "@/src/lib/db/enums";
import { resolveRateFromRows, roundMoney, type RateCardRow } from "./rateCard";

export interface EstimateCall {
  provider: string;
  category: Category;
  unit_type: string;
  variant?: string;
  units: number;
  client_id: string;
}

export interface EstimateLine extends EstimateCall {
  unit_cost_usd: number | null;
  cost_usd: number | null;
}

export interface EstimateResult {
  total_usd: number | null;
  rate_missing: boolean;
  lines: EstimateLine[];
}

export interface LogEntryInput {
  reel_id: string;
  client_id: string;
  scene_id?: string;
  stage: StageId;
  provider: Provider;
  adapter: string;
  call_type: CallType;
  call_status: CallStatus;
  units?: number;
  unit_type?: string;
  variant?: string;
  provider_asset_id?: string;
  asset_version_id?: string;
  idempotency_key?: string;
}

export interface CostLogRow {
  id: string;
  reel_id: string;
  client_id: string;
  scene_id: string | null;
  stage: StageId;
  provider: Provider;
  adapter: string;
  call_type: CallType;
  call_status: CallStatus;
  units: number | null;
  unit_type: string | null;
  variant: string | null;
  unit_cost_usd: number | null;
  cost_usd: number | null;
  rate_card_id: string | null;
  rate_missing: boolean;
  provider_asset_id: string | null;
  asset_version_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface SpentSoFar {
  total_usd: number;
  by_stage: Record<string, number>;
}

export interface CostEngine {
  estimate(calls: EstimateCall[], at?: Date): Promise<EstimateResult>;
  log(entry: LogEntryInput): Promise<CostLogRow>;
  spentSoFar(reelId: string): Promise<SpentSoFar>;
}

const RATE_CARD_COLUMNS =
  "id, provider, unit_type, variant, unit_cost_usd, currency, client_id, effective_from, effective_to, source_note";

async function fetchRateCandidates(
  supa: ServiceClient,
  provider: string,
  unit_type: string
): Promise<RateCardRow[]> {
  const { data, error } = await supa
    .from("rate_card")
    .select(RATE_CARD_COLUMNS)
    .eq("provider", provider)
    .eq("unit_type", unit_type);
  if (error) throw new Error(`rate_card lookup failed: ${error.message}`);
  return (data ?? []) as unknown as RateCardRow[];
}

function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

/** rateCache entries older than this are re-fetched instead of served stale (minor — .pipeline/review.md). */
const RATE_CACHE_TTL_MS = 5 * 60_000;

interface RateCacheEntry {
  rows: RateCardRow[];
  fetchedAt: number;
}

export function createCostEngine(supa: ServiceClient): CostEngine {
  const rateCache = new Map<string, RateCacheEntry>();

  async function ratesFor(provider: string, unit_type: string): Promise<RateCardRow[]> {
    const key = `${provider}::${unit_type}`;
    const cached = rateCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_TTL_MS) return cached.rows;
    const rows = await fetchRateCandidates(supa, provider, unit_type);
    rateCache.set(key, { rows, fetchedAt: Date.now() });
    return rows;
  }

  return {
    async estimate(calls, at = new Date()) {
      const lines: EstimateLine[] = [];
      let rateMissing = false;
      let total = 0;

      for (const call of calls) {
        const rows = await ratesFor(call.provider, call.unit_type);
        const rate = resolveRateFromRows(rows, {
          provider: call.provider,
          unit_type: call.unit_type,
          variant: call.variant ?? null,
          client_id: call.client_id,
          at,
        });

        if (!rate) {
          rateMissing = true;
          lines.push({ ...call, unit_cost_usd: null, cost_usd: null });
          continue;
        }

        const cost = roundMoney(rate.unit_cost_usd * call.units);
        total += cost;
        lines.push({ ...call, unit_cost_usd: rate.unit_cost_usd, cost_usd: cost });
      }

      return { total_usd: rateMissing ? null : roundMoney(total), rate_missing: rateMissing, lines };
    },

    async log(entry) {
      let unit_cost_usd: number | null = null;
      let cost_usd: number | null = null;
      let rate_card_id: string | null = null;
      let rate_missing = false;

      // failed_unbilled is a known, definite zero — not "rate not configured".
      if (entry.call_status === "failed_unbilled") {
        cost_usd = 0;
      } else if (entry.units != null && entry.unit_type) {
        const rows = await ratesFor(entry.provider, entry.unit_type);
        const rate = resolveRateFromRows(rows, {
          provider: entry.provider,
          unit_type: entry.unit_type,
          variant: entry.variant ?? null,
          client_id: entry.client_id,
        });
        if (rate) {
          unit_cost_usd = rate.unit_cost_usd;
          cost_usd = roundMoney(rate.unit_cost_usd * entry.units);
          rate_card_id = rate.id;
        } else {
          rate_missing = true;
        }
      }

      const { data, error } = await supa
        .from("cost_log")
        .insert({
          reel_id: entry.reel_id,
          client_id: entry.client_id,
          scene_id: entry.scene_id ?? null,
          stage: entry.stage,
          provider: entry.provider,
          adapter: entry.adapter,
          call_type: entry.call_type,
          call_status: entry.call_status,
          units: entry.units ?? null,
          unit_type: entry.unit_type ?? null,
          variant: entry.variant ?? null,
          unit_cost_usd,
          cost_usd,
          rate_card_id,
          rate_missing,
          provider_asset_id: entry.provider_asset_id ?? null,
          asset_version_id: entry.asset_version_id ?? null,
          idempotency_key: entry.idempotency_key ?? null,
        })
        .select("*")
        .single();

      if (error) {
        // Idempotency guard (partial UNIQUE(reel_id, provider, idempotency_key)):
        // a retried call returns the existing row instead of double-charging.
        if (entry.idempotency_key && isUniqueViolation(error)) {
          const existing = await supa
            .from("cost_log")
            .select("*")
            .eq("reel_id", entry.reel_id)
            .eq("provider", entry.provider)
            .eq("idempotency_key", entry.idempotency_key)
            .single();
          if (existing.error) {
            throw new Error(`cost_log.log idempotent fetch failed: ${existing.error.message}`);
          }
          return existing.data as CostLogRow;
        }
        throw new Error(`cost_log.log failed: ${error.message}`);
      }

      return data as CostLogRow;
    },

    async spentSoFar(reelId) {
      const { data, error } = await supa.from("cost_log").select("stage, cost_usd").eq("reel_id", reelId);
      if (error) throw new Error(`cost_log.spentSoFar failed: ${error.message}`);

      const by_stage: Record<string, number> = {};
      let total = 0;
      for (const row of (data ?? []) as Array<{ stage: string; cost_usd: number | null }>) {
        const cost = row.cost_usd ?? 0;
        by_stage[row.stage] = roundMoney((by_stage[row.stage] ?? 0) + cost);
        total += cost;
      }
      return { total_usd: roundMoney(total), by_stage };
    },
  };
}
