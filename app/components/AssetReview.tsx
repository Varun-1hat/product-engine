"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { DownloadButton } from "./DownloadButton";
import { VersionHistory, type VersionHistoryEntry } from "./VersionHistory";

export interface AssetReviewProps {
  /** The stage's review endpoint, e.g. `/api/reels/{reelId}/image/review`. */
  reviewEndpoint: string;
  assetId: string;
  mediaType: "image" | "video" | "audio";
  previewUrl?: string | null;
  currentVersionId?: string | null;
  currentVersionNo: number;
  history?: VersionHistoryEntry[];
  /** Shared boundary frame (spec §2.4) — editing/reverting affects both scenes. */
  shared?: boolean;
  onChanged?: () => void;
}

/**
 * Asset-level review (spec §7 Stage 4/5/7, two-granularity review, brief
 * §8): preview the current version, redo (regenerate via the same
 * prompt), download, or revert to a prior version. Single-redo regenerates
 * only this asset — never cascades to other slots.
 */
export function AssetReview({
  reviewEndpoint,
  assetId,
  mediaType,
  previewUrl,
  currentVersionId,
  currentVersionNo,
  history = [],
  shared,
  onChanged,
}: AssetReviewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRedo() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "redoAsset", assetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "redo failed");
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Asset</span>
        {shared ? (
          <span className="text-xs text-muted-foreground">shared frame — editing/reverting affects both scenes</span>
        ) : null}
      </div>

      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
        {previewUrl ? (
          mediaType === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not a static asset
            <img src={previewUrl} alt="asset preview" className="max-h-full max-w-full object-contain" />
          ) : mediaType === "video" ? (
            <video src={previewUrl} controls className="max-h-full max-w-full" />
          ) : (
            <audio src={previewUrl} controls />
          )
        ) : (
          <span className="text-xs text-muted-foreground">not generated yet</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleRedo} disabled={busy}>
          {busy ? "Redoing…" : "Redo"}
        </Button>
        {currentVersionId ? <DownloadButton reviewEndpoint={reviewEndpoint} assetVersionId={currentVersionId} /> : null}
      </div>

      {error ? <span className="text-xs text-destructive">{error}</span> : null}

      {history.length > 0 ? (
        <VersionHistory
          reviewEndpoint={reviewEndpoint}
          kind="asset"
          targetId={assetId}
          currentVersionNo={currentVersionNo}
          versions={history}
          onReverted={onChanged}
        />
      ) : null}
    </div>
  );
}
