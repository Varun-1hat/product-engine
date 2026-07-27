export interface CapabilityGuardProps {
  validation: { ok: boolean; violations: string[]; warnings: string[] };
  /** Rendered only when validation.ok — the guarded action (e.g. a "Generate" button). */
  children?: React.ReactNode;
}

/** Blocks/warns at the adapter capability boundary (spec §3: "validate() blocks/warns"). */
export function CapabilityGuard({ validation, children }: CapabilityGuardProps) {
  return (
    <div className="flex flex-col gap-2">
      {validation.violations.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {validation.violations.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : null}
      {validation.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {validation.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      {validation.ok ? children : null}
    </div>
  );
}
