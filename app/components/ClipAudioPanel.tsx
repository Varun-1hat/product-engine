"use client";

import { useState } from "react";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { AssetReview } from "./AssetReview";
import { UploadSlot } from "./UploadSlot";
import { useApiResource } from "@/app/hooks/useApiResource";

export interface ClipAudioVersionSummary {
  id: string;
  version_no: number;
  created_at: string;
  source: string;
}

/** Mirrors ClipAudioDetail from src/lib/clipAudio.ts (`GET /api/reels/{reelId}/clip-audio`). */
export interface ClipAudioDetail {
  key: string;
  scene_id: string | null;
  label: string;
  position: number;
  clip_asset_id: string;
  clip_duration_s: number | null;
  emits_audio: boolean;
  asset_id: string | null;
  enabled: boolean;
  current_version_id: string | null;
  current_version_no: number;
  duration_s: number | null;
  source: string | null;
  preview_url: string | null;
  history: ClipAudioVersionSummary[];
}

export function clipAudioEndpoint(reelId: string): string {
  return `/api/reels/${reelId}/clip-audio`;
}

/**
 * Shared hook for the one clip-audio payload the Clip, Trim and Music pages
 * all render. They deliberately fetch the same endpoint rather than each
 * embedding audio in its own stage response: one source, so a clip switched
 * off in Trim is already off when Music loads.
 */
export function useClipAudio(reelId: string) {
  const { data, reload } = useApiResource<{ clips: ClipAudioDetail[] }>(clipAudioEndpoint(reelId));
  return { clips: data?.clips ?? null, reloadClipAudio: reload };
}

const SOURCE_LABEL: Record<string, string> = {
  generated: "from the model",
  uploaded: "your upload",
  derived: "trimmed",
};

export interface ClipAudioPanelProps {
  reelId: string;
  clientId: string | null;
  clip: ClipAudioDetail;
  onChanged: () => void;
  /** Stage-specific extras rendered under the player — the Trim page's range, the Music page's generate controls. */
  children?: React.ReactNode;
}

/**
 * One clip's audio: the on/off switch, the track itself, and the ordinary
 * asset actions (replace by upload, download, revert to any earlier take —
 * including the model's own after an override, via "Use model audio").
 *
 * The switch writes straight to the clip's asset row through the shared
 * endpoint, which is why the same choice shows up in whichever of the three
 * stages the user looks at next.
 */
export function ClipAudioPanel({ reelId, clientId, clip, onChanged, children }: ClipAudioPanelProps) {
  const endpoint = clipAudioEndpoint(reelId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(enabled: boolean) {
    if (!clip.asset_id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setAudioEnabled", assetId: clip.asset_id, enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "could not change this clip's audio");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const switchId = `clip-audio-${clip.key}`;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Clip audio</span>
          <span className="text-xs text-muted-foreground">
            {clip.asset_id
              ? `${SOURCE_LABEL[clip.source ?? ""] ?? clip.source ?? "track"}${
                  clip.duration_s != null ? ` · ${clip.duration_s.toFixed(1)}s` : ""
                }`
              : clip.emits_audio
                ? "no track yet — it appears once the clip finishes generating"
                : "this clip's model produces no audio"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={switchId} className="text-xs text-muted-foreground">
            {clip.enabled ? "Used in the reel" : "Muted"}
          </Label>
          <Switch
            id={switchId}
            checked={clip.enabled}
            disabled={busy || !clip.asset_id}
            onCheckedChange={handleToggle}
          />
        </div>
      </div>

      {clip.asset_id ? (
        <AssetReview
          reviewEndpoint={endpoint}
          assetId={clip.asset_id}
          mediaType="audio"
          previewUrl={clip.preview_url}
          currentVersionId={clip.current_version_id}
          currentVersionNo={clip.current_version_no}
          history={clip.history}
          clientId={clientId}
          reelId={reelId}
          // A local demux, not a paid generation — no cost dialog.
          redoLabel="Use model audio"
          onChanged={onChanged}
        />
      ) : (
        <UploadSlot
          reviewEndpoint={endpoint}
          mediaType="audio"
          clientId={clientId}
          reelId={reelId}
          sceneId={clip.scene_id ?? undefined}
          onUploaded={onChanged}
        />
      )}

      {children}

      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
