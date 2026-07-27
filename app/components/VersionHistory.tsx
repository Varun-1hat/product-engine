"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

export interface VersionHistoryEntry {
  id: string;
  version_no: number;
  created_at: string;
  /** Free-form label — prompt text snippet, or asset provider/source. */
  summary?: string | null;
}

export interface VersionHistoryProps {
  reviewEndpoint: string;
  /** 'prompt' reverts via promptId+versionNo; 'asset' reverts via assetId+versionNo. */
  kind: "prompt" | "asset";
  targetId: string;
  currentVersionNo: number;
  versions: VersionHistoryEntry[];
  onReverted?: () => void;
}

/** Versioned + revertible history list (spec §2.4: revert re-points a pointer, never deletes). */
export function VersionHistory({ reviewEndpoint, kind, targetId, currentVersionNo, versions, onReverted }: VersionHistoryProps) {
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revertTo(versionNo: number) {
    setPending(versionNo);
    setError(null);
    try {
      const action = kind === "prompt" ? "revertPrompt" : "revertAsset";
      const idField = kind === "prompt" ? { promptId: targetId } : { assetId: targetId };
      const res = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...idField, versionNo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "revert failed");
      onReverted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">Version history</span>
      <ul className="flex flex-col gap-1">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono">v{v.version_no}</span>
              {v.version_no === currentVersionNo ? <Badge variant="secondary">current</Badge> : null}
              {v.summary ? <span className="max-w-[24ch] truncate text-muted-foreground">{v.summary}</span> : null}
            </div>
            {v.version_no !== currentVersionNo ? (
              <Button variant="ghost" size="sm" disabled={pending === v.version_no} onClick={() => revertTo(v.version_no)}>
                {pending === v.version_no ? "Reverting…" : "Revert"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
