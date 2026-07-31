"use client";

import { useState } from "react";
import { cn } from "@/src/lib/cn";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { DownloadButton } from "./DownloadButton";
import { VersionHistory, type VersionHistoryEntry } from "./VersionHistory";
import { useFileUpload } from "@/app/hooks/useFileUpload";

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
  /** Preview container's aspect ratio (spec §4) — defaults to "16:9" (today's hardcoded behavior) when omitted. */
  aspectRatio?: "9:16" | "1:1" | "16:9";
  /**
   * Per-redo cost in USD (spec §4). When present and > 0, "Redo" is gated
   * behind an AlertDialog confirmation and shows the amount on the button;
   * when 0/undefined, redo stays a single immediate click — no added
   * friction for free actions.
   */
  costUsd?: number;
  /**
   * Client + reel this asset belongs to. Both are needed to reach the
   * uploads endpoint — pass them to offer the "upload an override" input;
   * omit either and the upload UI is simply hidden.
   */
  clientId?: string | null;
  reelId?: string;
  /** Overrides the "Redo" label where regenerating means something more specific than "generate it again". */
  redoLabel?: string;
  onChanged?: () => void;
}

const ASPECT_RATIO_CLASS: Record<NonNullable<AssetReviewProps["aspectRatio"]>, string> = {
  "9:16": "aspect-[9/16]",
  "1:1": "aspect-square",
  "16:9": "aspect-video",
};

/**
 * Asset-level review (spec §7 Stage 4/5/7, two-granularity review, brief
 * §8): preview the current version, redo (regenerate via the same
 * prompt), upload an override, download, or revert to a prior version.
 * Single-redo regenerates only this asset — never cascades to other slots.
 *
 * The upload path is deliberately just another version: a user who already
 * has the footage/still can drop it in instead of paying for a generation,
 * and because it lands as an ordinary `uploaded` version the generated ones
 * stay in history and remain revertable. One file per upload; upload again
 * later for a further version.
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
  aspectRatio = "16:9",
  costUsd,
  clientId,
  reelId,
  redoLabel = "Redo",
  onChanged,
}: AssetReviewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { upload, uploading } = useFileUpload(clientId ?? "");

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

  /** One file per call — it becomes this asset's new current version. */
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !clientId || !reelId) return;
    setBusy(true);
    setError(null);
    try {
      const storagePath = await upload(file, "asset", reelId);
      const res = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "uploadAsset", assetId, storagePath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "upload failed");
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

      {/* Audio has no picture to frame — an aspect-ratio box would be a large empty rectangle around a thin player. */}
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden rounded-md bg-muted",
          mediaType === "audio" ? "p-3" : ASPECT_RATIO_CLASS[aspectRatio]
        )}
      >
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
        {costUsd && costUsd > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" disabled={busy}>
                {busy ? "Redoing…" : `${redoLabel} · $${costUsd.toFixed(2)}`}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate?</AlertDialogTitle>
                <AlertDialogDescription>
                  Regenerate this {mediaType} for ${costUsd.toFixed(2)}?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleRedo}>Regenerate</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button size="sm" onClick={handleRedo} disabled={busy}>
            {busy ? "Redoing…" : redoLabel}
          </Button>
        )}
        {currentVersionId ? <DownloadButton reviewEndpoint={reviewEndpoint} assetVersionId={currentVersionId} /> : null}
      </div>

      {clientId && reelId ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>Upload your own {mediaType} instead (saved as a new version)</span>
          <input
            type="file"
            accept={`${mediaType}/*`}
            onChange={handleUpload}
            disabled={busy || uploading}
            className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-secondary-foreground"
          />
        </label>
      ) : null}

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
