import { Badge } from "./ui/badge";

export interface EstimateLine {
  provider: string;
  category: string;
  unit_type: string;
  variant?: string;
  units: number;
  unit_cost_usd: number | null;
  cost_usd: number | null;
}

export interface CostEstimateBarProps {
  estimate: { total_usd: number | null; rate_missing: boolean; lines: EstimateLine[] };
}

function formatUsd(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** Per-scene cost estimate display (spec §4/§11) — warns HeyGen $7/video flat and Veo standard-vs-fast tiering. */
export function CostEstimateBar({ estimate }: CostEstimateBarProps) {
  const hasHeygen = estimate.lines.some((l) => l.provider === "heygen");
  const hasVeoStandard = estimate.lines.some((l) => l.provider === "veo" && l.variant?.startsWith("standard"));

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Estimated cost</span>
        <span className="text-lg font-semibold">{estimate.rate_missing ? "rate not configured" : formatUsd(estimate.total_usd)}</span>
      </div>

      {estimate.lines.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {estimate.lines.map((line, i) => (
            <li key={i} className="flex items-center justify-between">
              <span>
                {line.provider} · {line.units} {line.unit_type}
                {line.variant ? ` (${line.variant})` : ""}
              </span>
              <span>{line.cost_usd === null ? "rate not configured" : formatUsd(line.cost_usd)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {hasHeygen ? (
        <Badge variant="warning" className="w-fit">
          Every HeyGen avatar clip (and every redo) bills a flat $7.00 — this typically dominates reel cost.
        </Badge>
      ) : null}
      {hasVeoStandard ? (
        <Badge variant="warning" className="w-fit">
          Veo "standard" is ~4–8x the cost of "fast" for the same duration.
        </Badge>
      ) : null}
      {estimate.rate_missing ? (
        <Badge variant="destructive" className="w-fit">
          One or more providers have no configured rate — actual cost cannot be computed yet.
        </Badge>
      ) : null}
    </div>
  );
}
