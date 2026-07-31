"use client";

import { useState, use as usePromise } from "react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { Slider } from "@/app/components/ui/slider";
import { AssetReview, type AssetReviewProps } from "@/app/components/AssetReview";
import { useApiResource } from "@/app/hooks/useApiResource";
import type { ReelConfigRow } from "@/src/lib/db/types";

interface SceneRow {
  id: string;
  position: number;
  description: string | null;
}

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface TrimSlotDetail {
  asset_id: string;
  media_type: string;
  current_version_id: string | null;
  current_version_no: number;
  /** Current version's persisted clip length (src/lib/jobs/trim.ts keeps this current after every trim) — bounds the sliders below. */
  duration_s: number | null;
  preview_url: string | null;
  history: VersionSummary[];
}

interface TrimHint {
  scene_id: string;
  note: string;
}

interface TrimStateResponse {
  data: { scenes: SceneRow[] };
  hints: TrimHint[];
  slots: Record<string, TrimSlotDetail | undefined>;
}

/** Minimal projection of `GET /api/reels/{reelId}` (spec §4 pattern) — only the aspect ratio is needed here. */
interface ReelDetailResponse {
  reel_config: ReelConfigRow;
}

const REVIEW_ENDPOINT_SUFFIX = "/trim/review";

/**
 * Stage 6 (trim) page (spec §7 Stage 6): one card per scene showing its
 * current clip (AssetReview bound to /trim/review — Download/History/Revert
 * all work against the same asset Stage 5 (clip) created; "Redo" re-runs the
 * last-applied trim job, see src/stages/trim/index.ts's redoAsset — that's a
 * local re-encode with no adapter/provider call, so it's free and doesn't
 * need the cost-confirmation dialog from spec §4), a start_s/end_s range
 * below it bounded by the current version's persisted duration, and up/down
 * reorder controls (same swap-with-neighbor pattern as spec §3.1's scene
 * rows). No CostEstimateBar here — trim has no cost to estimate.
 */
export default function TrimStagePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const reviewEndpoint = `/api/reels/${reelId}${REVIEW_ENDPOINT_SUFFIX}`;

  const {
    data: state,
    loading,
    error: loadError,
    reload,
  } = useApiResource<TrimStateResponse>(`/api/reels/${reelId}/trim`);

  // Reel's aspect ratio (spec §4 pattern) — same independent second fetch image/page.tsx uses.
  const { data: reelDetail } = useApiResource<ReelDetailResponse>(`/api/reels/${reelId}`);
  const aspectRatio = reelDetail?.reel_config.aspect_ratio as AssetReviewProps["aspectRatio"];

  // Per-scene, not-yet-submitted start_s/end_s selection; cleared back to the
  // full current range once a trim for that scene succeeds (see handleTrim).
  const [trimRange, setTrimRange] = useState<Record<string, [number, number]>>({});
  const [savingSceneId, setSavingSceneId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !state) {
    return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;
  }
  if (loadError || !state) {
    return <main className="p-8 text-sm text-destructive">{loadError ?? "Failed to load trim stage."}</main>;
  }

  const scenes = [...state.data.scenes].sort((a, b) => a.position - b.position);
  const hintsByScene = new Map<string, TrimHint[]>();
  for (const hint of state.hints) {
    const list = hintsByScene.get(hint.scene_id) ?? [];
    list.push(hint);
    hintsByScene.set(hint.scene_id, list);
  }

  function rangeFor(sceneId: string, durationS: number): [number, number] {
    return trimRange[sceneId] ?? [0, durationS];
  }

  async function handleTrim(sceneId: string, assetId: string, range: [number, number]) {
    setSavingSceneId(sceneId);
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_id: assetId, start_s: range[0], end_s: range[1] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "trim failed");
      setTrimRange((prev) => {
        const next = { ...prev };
        delete next[sceneId];
        return next;
      });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSceneId(null);
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= scenes.length) return;
    const reordered = [...scenes];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    setReordering(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/trim/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene_ids: reordered.map((s) => s.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "reorder failed");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setReordering(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      {actionError ? <span className="text-xs text-destructive">{actionError}</span> : null}

      {scenes.length === 0 ? <p className="text-sm text-muted-foreground">No scenes yet.</p> : null}

      {scenes.map((scene, index) => {
        const slot = state.slots[scene.id];
        const hints = hintsByScene.get(scene.id) ?? [];

        return (
          <Card key={scene.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>
                    Scene {scene.position + 1}: {scene.description ?? "(no description)"}
                  </CardTitle>
                  {hints.map((hint, i) => (
                    <Badge key={i} variant="warning">
                      {hint.note}
                    </Badge>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reordering || index === 0}
                    onClick={() => handleMove(index, -1)}
                    aria-label="Move scene up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reordering || index === scenes.length - 1}
                    onClick={() => handleMove(index, 1)}
                    aria-label="Move scene down"
                  >
                    ↓
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {slot ? (
                <>
                  <AssetReview
                    reviewEndpoint={reviewEndpoint}
                    assetId={slot.asset_id}
                    mediaType="video"
                    previewUrl={slot.preview_url}
                    currentVersionId={slot.current_version_id}
                    currentVersionNo={slot.current_version_no}
                    history={slot.history}
                    aspectRatio={aspectRatio}
                    onChanged={reload}
                  />

                  {slot.duration_s != null ? (
                    <TrimControls
                      durationS={slot.duration_s}
                      range={rangeFor(scene.id, slot.duration_s)}
                      onChange={(range) => setTrimRange((prev) => ({ ...prev, [scene.id]: range }))}
                      onSubmit={(range) => handleTrim(scene.id, slot.asset_id, range)}
                      saving={savingSceneId === scene.id}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">clip duration unknown — nothing to trim yet</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">clip not generated yet — visit the Clip stage first</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}

function TrimControls({
  durationS,
  range,
  onChange,
  onSubmit,
  saving,
}: {
  durationS: number;
  range: [number, number];
  onChange: (range: [number, number]) => void;
  onSubmit: (range: [number, number]) => void;
  saving: boolean;
}) {
  const [start, end] = range;
  const invalid = end <= start;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Trim range</span>
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
