export interface SpendBarProps {
  spent: { total_usd: number; by_stage: Record<string, number> };
}

/** Dashboard spent-so-far display (spec §4: costEngine.spentSoFar — actuals only, incl. redos). */
export function SpendBar({ spent }: SpendBarProps) {
  const stages = Object.entries(spent.by_stage).filter(([, v]) => v > 0);
  const max = Math.max(spent.total_usd, 0.01);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">Spent so far</span>
        <span className="text-lg font-semibold">${spent.total_usd.toFixed(2)}</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {stages.map(([stage, value]) => (
          <div
            key={stage}
            className="h-full bg-primary/70 first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(value / max) * 100}%` }}
            title={`${stage}: $${value.toFixed(2)}`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {stages.map(([stage, value]) => (
          <li key={stage}>
            {stage}: ${value.toFixed(2)}
          </li>
        ))}
      </ul>
    </div>
  );
}
