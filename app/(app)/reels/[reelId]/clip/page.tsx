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
import { ClipAudioPanel, useClipAudio } from "@/app/components/ClipAudioPanel";
import { CostEstimateBar, type EstimateLine } from "@/app/components/CostEstimateBar";
import { useApiResource } from "@/app/hooks/useApiResource";
import type { Reel, ReelConfigRow, SceneRow } from "@/src/lib/db/types";

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface SlotDetail {
  asset_id: string;
  media_type: "video";
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

/** Matches `GET /api/reels/{reelId}/clip`'s response shape (spec §5.1). */
interface ClipStateResponse {
  stage: "clip";
  data: { scenes: SceneRow[] };
  slots: Record<string, SlotDetail | undefined>;
  /** Per-scene motion/shot prompt, present even before the clip is generated. */
  prompts: Record<string, NonNullable<SlotDetail["prompt"]> | null>;
  estimate: { total_usd: number | null; rate_missing: boolean; lines: EstimateLine[] };
}

/** Minimal projection of `GET /api/reels/{reelId}` (spec §5.2) — aspect ratio + selected avatar look. */
interface ReelDetailResponse {
  reel: Reel;
  reel_config: ReelConfigRow;
}

/** Minimal projection of `GET /api/clients/{clientId}` (spec §5.2) — only the avatars list is needed here. */
interface ClientDetailResponse {
  avatars: Array<{ id: string; name: string; preview_image_url: string | null }>;
}

/** HeyGen's flat per-avatar-clip rate (spec §5.2) — a known constant, never derived from the estimate response. */
const AVATAR_CLIP_COST_USD = 7;

const REVIEW_ENDPOINT_SUFFIX = "/clip/review";

/**
 * Maps each b-roll scene to its corresponding cost-estimate line, by
 * position. Unlike Image's flat per-slot rate (every line there is
 * economically identical, so any line will do), b-roll clip cost varies by
 * duration/variant (spec §5.2 — "use the real computed value, not a
 * guess"), so this needs a real per-scene value. `EstimateLine` carries no
 * scene id to key off directly, so this pairs by position among just the
 * "video_broll" lines/scenes (avatar scenes never consult this map — spec
 * §5.2 says pass a flat $7 constant for those instead). Requires `scenes`
 * to already be in position order. If clipStage.estimate() ever skips a
 * b-roll scene (via `continue`, only when no b-roll model/adapter resolves
 * for it — the same condition that blocks generation for that scene, see
 * src/stages/clip/index.ts's generateClipForScene), the trailing scene(s)
 * past that mismatch simply get no redo-cost confirmation (costUsd stays
 * undefined) rather than a silently wrong number.
 */
function brollCostUsdByScene(scenes: SceneRow[], estimate: ClipStateResponse["estimate"]): Map<string, number> {
  const brollScenes = scenes.filter((s) => s.type === "broll");
  const brollLines = estimate.lines.filter((l) => l.category === "video_broll");
  const map = new Map<string, number>();
  brollScenes.forEach((scene, i) => {
    const cost = brollLines[i]?.cost_usd;
    if (typeof cost === "number") map.set(scene.id, cost);
  });
  return map;
}

/**
 * Stage 5 (clip) review page (spec §5.2). Mirrors image/page.tsx's
 * structure (spec §7 Stage 4's "reference implementation for
 * two-granularity review") closely, simplified to a single AssetReview +
 * PromptReview pair per scene — unlike Image, Clip has one slot per scene,
 * not a start/end pair.
 */
export default function ClipStagePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const reviewEndpoint = `/api/reels/${reelId}${REVIEW_ENDPOINT_SUFFIX}`;

  const [state, setState] = useState<ClipStateResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reel's aspect ratio + selected avatar look (spec §5.2) — the shared layout
  // (spec §2.6) doesn't expose a React context, so this is its own independent
  // fetch, same pattern image/page.tsx uses for aspect ratio alone.
  const { data: reelDetail } = useApiResource<ReelDetailResponse>(`/api/reels/${reelId}`);
  const aspectRatio = reelDetail?.reel_config.aspect_ratio as AssetReviewProps["aspectRatio"];
  const avatarLookId = reelDetail?.reel_config.avatar_look_id ?? null;
  const clientId = reelDetail?.reel.client_id ?? null;

  // Client's avatars, to resolve avatarLookId -> a display name (spec §5.2).
  const { data: clientDetail } = useApiResource<ClientDetailResponse>(clientId ? `/api/clients/${clientId}` : null);
  const avatarName = clientDetail?.avatars.find((a) => a.id === avatarLookId)?.name ?? null;

  // Each clip's retained model audio (spec: reviewable here, in Trim and in
  // Music, off the one shared endpoint so the on/off choice can't diverge).
  const { clips: clipAudio, reloadClipAudio } = useClipAudio(reelId);
  const audioByKey = new Map((clipAudio ?? []).map((c) => [c.key, c]));

  async function load() {
    const res = await fetch(`/api/reels/${reelId}/clip`);
    const data = await res.json();
    if (res.ok) setState(data);
    await reloadClipAudio();
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelId]);

  /** Creates the motion/shot prompts (free) so they can be edited before the paid generate. */
  async function handlePreparePrompts() {
    setPreparing(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/clip/prompts`, { method: "POST" });
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
      const res = await fetch(`/api/reels/${reelId}/clip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
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

  const scenes = [...state.data.scenes].sort((a, b) => a.position - b.position);
  const brollCostUsd = brollCostUsdByScene(scenes, state.estimate);
  const generateCostUsd = state.estimate.total_usd;
  const generateButtonLabel = generating ? "Generating…" : "Generate missing clips";

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
              <AlertDialogTitle>Generate missing clips?</AlertDialogTitle>
              <AlertDialogDescription>
                Generate the missing clips below for an estimated ${generateCostUsd.toFixed(2)}?
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

      {scenes.length === 0 ? <p className="text-sm text-muted-foreground">No scenes configured yet.</p> : null}

      {scenes.map((scene) => {
        const slot = state.slots[scene.id];
        const prompt = state.prompts?.[scene.id] ?? slot?.prompt ?? null;
        const costUsd = scene.type === "avatar" ? AVATAR_CLIP_COST_USD : brollCostUsd.get(scene.id);
        return (
          <Card key={scene.id}>
            <CardHeader>
              <CardTitle>
                Scene {scene.position + 1}: {scene.description ?? "(no description)"}
              </CardTitle>
              {scene.type === "avatar" ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Avatar look: {avatarName ?? "none selected"}</span>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {slot ? (
                <>
                  <AssetReview
                    reviewEndpoint={reviewEndpoint}
                    assetId={slot.asset_id}
                    mediaType={slot.media_type}
                    previewUrl={slot.preview_url}
                    currentVersionId={slot.current_version_id}
                    currentVersionNo={slot.current_version_no}
                    history={slot.history}
                    aspectRatio={aspectRatio}
                    costUsd={costUsd}
                    clientId={clientId}
                    reelId={reelId}
                    onChanged={load}
                  />
                  {audioByKey.has(scene.id) ? (
                    <ClipAudioPanel
                      reelId={reelId}
                      clientId={clientId}
                      clip={audioByKey.get(scene.id)!}
                      onChanged={load}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <div className="text-xs text-muted-foreground">clip not generated yet</div>
                  <UploadSlot
                    reviewEndpoint={reviewEndpoint}
                    mediaType="video"
                    clientId={clientId}
                    reelId={reelId}
                    sceneId={scene.id}
                    onUploaded={load}
                  />
                </>
              )}
              {/* Keyed by scene, not by the clip asset, so the prompt is editable before generating. */}
              {prompt ? (
                <PromptReview
                  reviewEndpoint={reviewEndpoint}
                  promptId={prompt.id}
                  currentText={prompt.text}
                  currentVersionNo={prompt.version_no}
                  history={prompt.history}
                  currentRefs={prompt.reference_paths}
                  promptsEndpoint={`/api/reels/${reelId}/clip/prompts`}
                  useProductRefs={prompt.use_product_refs}
                  clientId={clientId}
                  reelId={reelId}
                  onChanged={load}
                />
              ) : (
                <div className="text-xs text-muted-foreground">
                  prompt not written yet — click “Prepare prompts” above to review it before generating
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </main>
  );
}
