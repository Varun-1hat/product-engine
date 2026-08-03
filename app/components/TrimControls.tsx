"use client";

import { Button } from "./ui/button";
import { Slider } from "./ui/slider";

export interface TrimControlsProps {
  /** Names what this range cuts — picture and sound together, or one of them alone. */
  label?: string;
  durationS: number;
  range: [number, number];
  onChange: (range: [number, number]) => void;
  onSubmit: (range: [number, number]) => void;
  saving: boolean;
}

/**
 * A start_s/end_s range over one clip, bounded by that clip's persisted
 * duration. Submitting posts a trim job for a single asset — which is why the
 * Trim page (per scene) and the Outro page (the outro clip) can share it: the
 * trim endpoint is asset-keyed, so neither caller needs its own shape.
 */
export function TrimControls({ label = "Trim range", durationS, range, onChange, onSubmit, saving }: TrimControlsProps) {
  const [start, end] = range;
  const invalid = end <= start;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">
          {start.toFixed(1)}s – {end.toFixed(1)}s of {durationS.toFixed(1)}s
        </span>
      </div>
      <Slider
        min={0}
        max={durationS}
        step={0.1}
        value={range}
        onValueChange={(v) => onChange([v[0] ?? start, v[1] ?? end])}
      />
      <Button size="sm" className="w-fit" disabled={saving || invalid} onClick={() => onSubmit(range)}>
        {saving ? "Trimming…" : "Trim"}
      </Button>
      {invalid ? <span className="text-xs text-destructive">End must be after start.</span> : null}
    </div>
  );
}
