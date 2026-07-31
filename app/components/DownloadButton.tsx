"use client";

import { useState } from "react";
import { Button } from "./ui/button";

export interface DownloadButtonProps {
  /** The review endpoint for this stage, e.g. `/api/reels/{reelId}/image/review`. */
  reviewEndpoint: string;
  /** An asset_versions.id (a specific version), not an assets.id. */
  assetVersionId: string;
  label?: string;
}

/** Calls the shared review action 'download' (src/lib/reviewAction.ts) and opens the returned signed URL. */
export function DownloadButton({ reviewEndpoint, assetVersionId, label = "Download" }: DownloadButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "download", assetVersionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "download failed");
      window.open(data.url as string, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={loading}>
        {loading ? "Preparing…" : label}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
