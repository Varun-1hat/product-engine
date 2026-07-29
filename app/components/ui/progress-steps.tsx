import Link from "next/link";
import { cn } from "@/src/lib/cn";

export interface ProgressStep {
  id: string;
  label: string;
  href: string | null;
}

export interface ProgressStepsProps {
  steps: ProgressStep[];
  /** Which step the user is currently viewing. */
  currentIndex: number;
  /** Furthest index actually reached (reel.current_stage-derived). */
  reachedIndex: number;
}

/**
 * Stage stepper: a thin filled progress bar + a horizontal (wrapping) row of step labels.
 * Steps at or before `reachedIndex` are navigable (when they carry an `href`); steps beyond
 * it render as inert, more-muted spans — never a dead/hidden step, just non-interactive.
 */
export function ProgressSteps({ steps, currentIndex, reachedIndex }: ProgressStepsProps) {
  const percent =
    steps.length > 1 ? Math.min(100, Math.max(0, (reachedIndex / (steps.length - 1)) * 100)) : 100;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
          Step {currentIndex + 1} of {steps.length}
        </span>
        <div className="h-1.5 w-full flex-1 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {steps.map((step, index) => {
          const isReached = index <= reachedIndex;
          const isCurrent = index === currentIndex;
          const labelClassName = cn(
            "text-sm transition-colors",
            isCurrent ? "font-medium text-foreground" : isReached ? "text-muted-foreground" : "text-muted-foreground/50"
          );

          if (isReached && step.href) {
            return (
              <Link key={step.id} href={step.href} className={cn(labelClassName, "hover:text-foreground")}>
                {step.label}
              </Link>
            );
          }

          return (
            <span key={step.id} className={labelClassName}>
              {step.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
