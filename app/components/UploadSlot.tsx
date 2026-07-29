"use client";

import { useState } from "react";
import { useFileUpload } from "@/app/hooks/useFileUpload";

export interface UploadSlotProps {
  /** The stage's review endpoint, e.g. `/api/reels/{reelId}/image/review`. */
  reviewEndpoint: string;
  mediaType: "image" | "video";
  clientId?: string | null;
  reelId: string;
  /** Locates the slot for the stage's `uploadNewAsset` hook. */
  sceneId?: string;
  role?: "start" | "end";
  onUploaded?: () => void;
}

/**
 * AssetReview's counterpart for a slot that hasn't been generated yet: the
 * same "bring your own file" override, except there's no asset row to
 * append to — the stage's `uploadNewAsset` hook creates it along with this
 * first `uploaded` version, so the initial generation can be skipped
 * entirely. Once it exists, the slot renders as a normal AssetReview and
 * further uploads/redos are just more versions.
 */
export function UploadSlot({ reviewEndpoint, mediaType, clientId, reelId, sceneId, role, onUploaded }: UploadSlotProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { upload, uploading } = useFileUpload(clientId ?? "");

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !clientId) return;
    setBusy(true);
    setError(null);
    try {
      const storagePath = await upload(file, "asset", reelId);
      const res = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "uploadNewAsset", storagePath, sceneId, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "upload failed");
      onUploaded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!clientId) return null;

  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span>Already have this {mediaType}? Upload it instead of generating</span>
      <input
        type="file"
        accept={`${mediaType}/*`}
        onChange={handleChange}
        disabled={busy || uploading}
        className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-secondary-foreground"
      />
      {error ? <span className="text-destructive">{error}</span> : null}
    </label>
  );
}
