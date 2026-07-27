"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { PromptReview } from "@/app/components/PromptReview";
import { AssetReview } from "@/app/components/AssetReview";
import { CostEstimateBar } from "@/app/components/CostEstimateBar";

interface SceneRow {
  id: string;
  position: number;
  type: "avatar" | "broll";
  description: string | null;
}

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface SlotDetail {
  asset_id: string;
  media_type: "image" | "video" | "audio";
  shared: boolean;
  current_version_id: string | null;
  current_version_no: number;
  preview_url: string | null;
  history: VersionSummary[];
  prompt: { id: string; text: string; version_no: number; history: VersionSummary[] } | null;
}

interface ImageStateResponse {
  scenes: SceneRow[];
  slots: Record<string, { start?: SlotDetail; end?: SlotDetail }>;
  estimate: { total_usd: number | null; rate_missing: boolean; lines: never[] };
}

const REVIEW_ENDPOINT_SUFFIX = "/image/review";

/**
 * Stage 4 (image) reference review page (spec §7 Stage 4 — "reference
 * implementation for two-granularity review"). The remaining stage pages
 * (clip/outro/...) follow this same shape: fetch the stage's enriched GET,
 * render one PromptReview + AssetReview pair per slot, a Generate action,
 * and a CostEstimateBar.
 */
export default function ImageStagePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const reviewEndpoint = `/api/reels/${reelId}${REVIEW_ENDPOINT_SUFFIX}`;

  const [state, setState] = useState<ImageStateResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/reels/${reelId}/image`);
    const data = await res.json();
    if (res.ok) setState(data);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/image`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "generate failed");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  if (!state) return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;

  const brollScenes = state.scenes.filter((s) => s.type === "broll").sort((a, b) => a.position - b.position);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Stage 4 — Images</h1>
        <div className="flex gap-3 text-sm">
          <Link href={`/reels/${reelId}/scene`} className="text-muted-foreground underline">
            ← Scene
          </Link>
          <Link href={`/reels/${reelId}/clip`} className="text-muted-foreground underline">
            Clip →
          </Link>
        </div>
      </div>

      <CostEstimateBar estimate={state.estimate} />

      <Button onClick={handleGenerate} disabled={generating} className="w-fit">
        {generating ? "Generating…" : "Generate missing images"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}

      {brollScenes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No b-roll scenes — Stage 4 is a no-op for this reel.</p>
      ) : null}

      {brollScenes.map((scene) => {
        const slot = state.slots[scene.id];
        return (
          <Card key={scene.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>
                  Scene {scene.position + 1}: {scene.description ?? "(no description)"}
                </CardTitle>
                {(slot?.start?.shared || slot?.end?.shared) ? <Badge variant="secondary">shared boundary frame</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 sm:flex-row">
              {slot?.start ? (
                <div className="flex flex-1 flex-col gap-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">Start</span>
                  <AssetReview
                    reviewEndpoint={reviewEndpoint}
                    assetId={slot.start.asset_id}
                    mediaType={slot.start.media_type}
                    previewUrl={slot.start.preview_url}
                    currentVersionId={slot.start.current_version_id}
                    currentVersionNo={slot.start.current_version_no}
                    history={slot.start.history}
                    shared={slot.start.shared}
                    onChanged={load}
                  />
                  {slot.start.prompt ? (
                    <PromptReview
                      reviewEndpoint={reviewEndpoint}
                      promptId={slot.start.prompt.id}
                      currentText={slot.start.prompt.text}
                      currentVersionNo={slot.start.prompt.version_no}
                      history={slot.start.prompt.history}
                      onChanged={load}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="flex-1 text-xs text-muted-foreground">start image not generated yet</div>
              )}

              {slot?.end ? (
                <div className="flex flex-1 flex-col gap-2">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">End</span>
                  <AssetReview
                    reviewEndpoint={reviewEndpoint}
                    assetId={slot.end.asset_id}
                    mediaType={slot.end.media_type}
                    previewUrl={slot.end.preview_url}
                    currentVersionId={slot.end.current_version_id}
                    currentVersionNo={slot.end.current_version_no}
                    history={slot.end.history}
                    shared={slot.end.shared}
                    onChanged={load}
                  />
                  {slot.end.prompt ? (
                    <PromptReview
                      reviewEndpoint={reviewEndpoint}
                      promptId={slot.end.prompt.id}
                      currentText={slot.end.prompt.text}
                      currentVersionNo={slot.end.prompt.version_no}
                      history={slot.end.prompt.history}
                      onChanged={load}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="flex-1 text-xs text-muted-foreground">
                  no end slot (either not needed for a hard_cut boundary, or the effective model has no
                  supports_end_frame)
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
