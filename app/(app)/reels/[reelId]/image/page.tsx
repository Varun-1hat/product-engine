"use client";

import { useEffect, useState, use as usePromise } from "react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
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
} from "@/app/components/ui/alert-dialog";
import { PromptReview } from "@/app/components/PromptReview";
import { AssetReview, type AssetReviewProps } from "@/app/components/AssetReview";
import { UploadSlot } from "@/app/components/UploadSlot";
import { CostEstimateBar, type EstimateLine } from "@/app/components/CostEstimateBar";
import { useApiResource } from "@/app/hooks/useApiResource";
import type { ReelConfigRow } from "@/src/lib/db/types";

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
  prompt: {
    id: string;
    text: string;
    version_no: number;
    history: VersionSummary[];
    reference_paths: string[];
    use_product_refs: boolean;
  } | null;
}

interface ImageStateResponse {
  scenes: SceneRow[];
  slots: Record<string, { start?: SlotDetail; end?: SlotDetail }>;
  /** Per-scene start/end prompts, present even before the images are generated. */
  prompts: Record<string, { start: NonNullable<SlotDetail["prompt"]> | null; end: NonNullable<SlotDetail["prompt"]> | null }>;
  estimate: { total_usd: number | null; rate_missing: boolean; lines: EstimateLine[] };
}

/** Minimal projection of `GET /api/reels/{reelId}` (spec §4) — the aspect ratio, plus the client id the upload endpoint is scoped to. */
interface ReelDetailResponse {
  reel: { client_id: string };
  reel_config: ReelConfigRow;
}

/** Nano Banana's known flat per-image rate — spec §4's fallback for when `estimate.lines` can't be tied to a specific slot (see the per-line-detail note on `perImageCostUsd` below). */
const FALLBACK_IMAGE_COST_USD = 0.039;

/**
 * Every line `imageStage.estimate()` produces is economically identical (one
 * `{ provider: image_provider, category: "image", unit_type: "image", units:
 * 1 }` call per planned slot, no `variant` — see src/stages/image/index.ts's
 * `estimate()`), and `EstimateLine` carries no scene/asset id to key a
 * specific line to a specific slot anyway. So there's no real "per-line
 * breakdown" to address a slot with — spec §4's fallback applies: use the
 * live per-image rate when the estimate has resolved one (still correct even
 * though we're reading line 0, since every line has the same cost here), else
 * the known-fixed Nano Banana constant.
 */
function perImageCostUsd(estimate: ImageStateResponse["estimate"]): number {
  const line = estimate.lines[0];
  return typeof line?.cost_usd === "number" ? line.cost_usd : FALLBACK_IMAGE_COST_USD;
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
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reel's aspect ratio (spec §4) — the shared layout (spec §2.6) doesn't expose a React
  // context, so this is its own independent fetch, same pattern the layout itself uses.
  const { data: reelDetail } = useApiResource<ReelDetailResponse>(`/api/reels/${reelId}`);
  const aspectRatio = reelDetail?.reel_config.aspect_ratio as AssetReviewProps["aspectRatio"];
  const clientId = reelDetail?.reel.client_id ?? null;

  async function load() {
    const res = await fetch(`/api/reels/${reelId}/image`);
    const data = await res.json();
    if (res.ok) setState(data);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelId]);

  /** Writes the slot prompts (free) so they can be edited before the paid generate. */
  async function handlePreparePrompts() {
    setPreparing(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/image/prompts`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "prepare failed");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  }

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
  const redoCostUsd = perImageCostUsd(state.estimate);
  const generateCostUsd = state.estimate.total_usd;
  const generateButtonLabel = generating ? "Generating…" : "Generate missing images";

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <CostEstimateBar estimate={state.estimate} />

      <Button variant="outline" onClick={handlePreparePrompts} disabled={preparing} className="w-fit">
        {preparing ? "Preparing…" : "Prepare prompts"}
      </Button>

      {typeof generateCostUsd === "number" && generateCostUsd > 0 ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={generating} className="w-fit">
              {generateButtonLabel}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Generate missing images?</AlertDialogTitle>
              <AlertDialogDescription>
                Generate the missing images below for an estimated ${generateCostUsd.toFixed(2)}?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleGenerate}>Generate</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Button onClick={handleGenerate} disabled={generating} className="w-fit">
          {generateButtonLabel}
        </Button>
      )}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}

      {brollScenes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No b-roll scenes — Stage 4 is a no-op for this reel.</p>
      ) : null}

      {brollScenes.map((scene) => {
        const slot = state.slots[scene.id];
        const startPrompt = state.prompts?.[scene.id]?.start ?? slot?.start?.prompt ?? null;
        const endPrompt = state.prompts?.[scene.id]?.end ?? slot?.end?.prompt ?? null;
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
              <div className="flex flex-1 flex-col gap-2">
                <span className="text-xs font-semibold uppercase text-muted-foreground">Start</span>
                {slot?.start ? (
                  <AssetReview
                    reviewEndpoint={reviewEndpoint}
                    assetId={slot.start.asset_id}
                    mediaType={slot.start.media_type}
                    previewUrl={slot.start.preview_url}
                    currentVersionId={slot.start.current_version_id}
                    currentVersionNo={slot.start.current_version_no}
                    history={slot.start.history}
                    shared={slot.start.shared}
                    aspectRatio={aspectRatio}
                    costUsd={redoCostUsd}
                    clientId={clientId}
                    reelId={reelId}
                    onChanged={load}
                  />
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">start image not generated yet</span>
                    <UploadSlot
                      reviewEndpoint={reviewEndpoint}
                      mediaType="image"
                      clientId={clientId}
                      reelId={reelId}
                      sceneId={scene.id}
                      role="start"
                      onUploaded={load}
                    />
                  </>
                )}
                {/* Keyed by scene, not by the asset, so the prompt is editable before generating. */}
                {startPrompt ? (
                  <PromptReview
                    reviewEndpoint={reviewEndpoint}
                    promptId={startPrompt.id}
                    currentText={startPrompt.text}
                    currentVersionNo={startPrompt.version_no}
                    history={startPrompt.history}
                    currentRefs={startPrompt.reference_paths}
                    promptsEndpoint={`/api/reels/${reelId}/image/prompts`}
                    useProductRefs={startPrompt.use_product_refs}
                    clientId={clientId}
                    reelId={reelId}
                    onChanged={load}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    prompt not written yet — click “Prepare prompts” above to review it before generating
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col gap-2">
                <span className="text-xs font-semibold uppercase text-muted-foreground">End</span>
                {slot?.end ? (
                  <AssetReview
                    reviewEndpoint={reviewEndpoint}
                    assetId={slot.end.asset_id}
                    mediaType={slot.end.media_type}
                    previewUrl={slot.end.preview_url}
                    currentVersionId={slot.end.current_version_id}
                    currentVersionNo={slot.end.current_version_no}
                    history={slot.end.history}
                    shared={slot.end.shared}
                    aspectRatio={aspectRatio}
                    costUsd={redoCostUsd}
                    clientId={clientId}
                    reelId={reelId}
                    onChanged={load}
                  />
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      no end image yet (a hard_cut boundary or a model without supports_end_frame never gets one)
                    </span>
                    <UploadSlot
                      reviewEndpoint={reviewEndpoint}
                      mediaType="image"
                      clientId={clientId}
                      reelId={reelId}
                      sceneId={scene.id}
                      role="end"
                      onUploaded={load}
                    />
                  </>
                )}
                {endPrompt ? (
                  <PromptReview
                    reviewEndpoint={reviewEndpoint}
                    promptId={endPrompt.id}
                    currentText={endPrompt.text}
                    currentVersionNo={endPrompt.version_no}
                    history={endPrompt.history}
                    currentRefs={endPrompt.reference_paths}
                    promptsEndpoint={`/api/reels/${reelId}/image/prompts`}
                    useProductRefs={endPrompt.use_product_refs}
                    clientId={clientId}
                    reelId={reelId}
                    onChanged={load}
                  />
                ) : null}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
