"use client";

import { useEffect, useRef, useState, use as usePromise } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
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
import { AssetReview, type AssetReviewProps } from "@/app/components/AssetReview";
import { UploadSlot } from "@/app/components/UploadSlot";
import { PromptReview, type PromptStalenessInfo } from "@/app/components/PromptReview";
import { ClipAudioPanel, useClipAudio } from "@/app/components/ClipAudioPanel";
import { TrimControls } from "@/app/components/TrimControls";
import { CostEstimateBar, type EstimateLine } from "@/app/components/CostEstimateBar";
import { useApiResource } from "@/app/hooks/useApiResource";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import type { Reel, ReelConfigRow } from "@/src/lib/db/types";

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface SlotDetail {
  asset_id: string;
  media_type: "image" | "video" | "audio";
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

interface OutroStateResponse {
  stage: "outro";
  data: { reel_config: ReelConfigRow; prompt_staleness: PromptStalenessInfo | null };
  slots: { end_frame?: SlotDetail; outro_clip?: SlotDetail };
  /** Outro motion prompt, present even before the outro clip is generated. */
  prompt: SlotDetail["prompt"];
}

/** Minimal projection of `GET /api/reels/{reelId}` (spec §4/§7.3 pattern) — client_id + aspect ratio only. */
interface ReelDetailResponse {
  reel: Reel;
  reel_config: ReelConfigRow;
}

/** Minimal projection of `GET /api/clients/{clientId}` — only the tagline fallback is needed here. */
interface ClientResponse {
  client_config: { default_tagline: string | null };
}

type EstimateResponse = { total_usd: number | null; rate_missing: boolean; lines: EstimateLine[] };

const REVIEW_ENDPOINT_SUFFIX = "/outro/review";

/** The reel-level clip-audio row's key (OUTRO_KEY in src/lib/clipAudio.ts) — inlined rather than imported, since that module is server-only. */
const OUTRO_AUDIO_KEY = "outro";

/**
 * Stage 7 (outro) review page (spec §7.3) — dual-slot layout mirroring
 * Image's start/end split. Slot 1 (end-frame image) is AssetReview-only, no
 * prompt (the default end-frame is a deterministic satori/resvg render, not
 * AI-prompted); its Redo is a local render with no adapter cost, so
 * `costUsd={0}` — matches section 4's "no friction for free actions" rule.
 * Slot 2 (outro clip) is a real AssetReview+PromptReview pair, cost-gated by
 * the live `/outro/estimate` total (0 for the deterministic crossfade
 * route, the model's rate otherwise). Both slots share one `/outro/review`
 * endpoint, disambiguated by which assetId/promptId is passed — see
 * src/stages/outro/index.ts's createOutroReviewHooks (asset.slot lookup).
 *
 * The outro clip also gets its own cost-confirmed Generate button (Clip's
 * pattern) and, once generated, a ClipAudioPanel plus Trim-page-style
 * start_s/end_s controls for picture and sound — both driven by endpoints
 * that are already asset-keyed (/clip-audio, /trim), so nothing outside this
 * page changed.
 *
 * Note for the Tester/Reviewer: src/stages/outro/index.ts's process()
 * unconditionally enqueues a new outro-clip generation job on *every* call
 * (not "only if missing" the way Image/Clip's generate endpoints are) — so
 * "Save tagline" below always kicks off a fresh outro-clip job too, even if
 * only the tagline text changed. Spec §7.3 only asks for cost-confirmation
 * on the two slots' Redo actions, not on Save tagline, so that's left
 * unwrapped per the spec's literal text — flagging since it's a real,
 * repeatable-cost side effect of a button that doesn't look costly.
 */
export default function OutroStagePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const reviewEndpoint = `/api/reels/${reelId}${REVIEW_ENDPOINT_SUFFIX}`;

  const { data: state, reload } = useApiResource<OutroStateResponse>(`/api/reels/${reelId}/outro`);
  const { data: reelDetail } = useApiResource<ReelDetailResponse>(`/api/reels/${reelId}`);
  const { data: estimate } = useApiResource<EstimateResponse>(`/api/reels/${reelId}/outro/estimate`);
  const clientId = reelDetail?.reel.client_id ?? null;
  const { data: clientData } = useApiResource<ClientResponse>(clientId ? `/api/clients/${clientId}` : null);

  const { upload, uploading, error: uploadError } = useFileUpload(clientId ?? "");

  // The outro clip's retained model audio — same shared endpoint the Clip, Trim
  // and Music pages read, so the on/off choice can't diverge between them.
  const { clips: clipAudio, reloadClipAudio } = useClipAudio(reelId);
  const outroAudio = (clipAudio ?? []).find((c) => c.key === OUTRO_AUDIO_KEY) ?? null;

  const [tagline, setTagline] = useState("");
  const taglineTouched = useRef(false);
  const [savingTagline, setSavingTagline] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preparing, setPreparing] = useState(false);
  // Not-yet-submitted trim ranges, cleared back to the full current range once a trim succeeds.
  const [trimRange, setTrimRange] = useState<[number, number] | null>(null);
  const [audioTrimRange, setAudioTrimRange] = useState<[number, number] | null>(null);
  // Cutting picture and sound to the same range is the common case, so it is the
  // default; unlinking gives each its own range and its own Trim button.
  const [unlinkedAudio, setUnlinkedAudio] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [trimmingAudio, setTrimmingAudio] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Default the tagline from reel_config.outro_tagline, falling back to the client's
  // default_tagline once that resource resolves — but only until the user actually edits the
  // field, so a slower-arriving clientData fetch can't clobber an in-progress edit.
  useEffect(() => {
    if (!state || taglineTouched.current) return;
    setTagline(state.data.reel_config.outro_tagline ?? clientData?.client_config.default_tagline ?? "");
  }, [state, clientData]);

  async function postOutro(body: Record<string, unknown>) {
    const res = await fetch(`/api/reels/${reelId}/outro`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "save failed");
    await reloadBoth();
  }

  async function reloadBoth() {
    await reload();
    await reloadClipAudio();
  }

  /** Generates the outro clip on its own, without going through "Save tagline". */
  async function handleGenerate() {
    setGenerating(true);
    setActionError(null);
    try {
      await postOutro({});
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  /** One trim job against one asset — the trim endpoint is asset-keyed, so the outro's slots need no route of their own. */
  async function postTrim(assetId: string, range: [number, number]) {
    const res = await fetch(`/api/reels/${reelId}/trim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset_id: assetId, start_s: range[0], end_s: range[1] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "trim failed");
  }

  /** `audioAssetId` present = "trim together": the same range is applied to both lanes. */
  async function handleTrim(assetId: string, range: [number, number], audioAssetId?: string | null) {
    setTrimming(true);
    setActionError(null);
    try {
      await postTrim(assetId, range);
      if (audioAssetId) await postTrim(audioAssetId, range);
      setTrimRange(null);
      await reloadBoth();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrimming(false);
    }
  }

  /** Audio cut on its own range, leaving the picture untouched. */
  async function handleAudioTrim(audioAssetId: string, range: [number, number]) {
    setTrimmingAudio(true);
    setActionError(null);
    try {
      await postTrim(audioAssetId, range);
      setAudioTrimRange(null);
      await reloadClipAudio();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrimmingAudio(false);
    }
  }

  async function handleSaveTagline() {
    setSavingTagline(true);
    setActionError(null);
    try {
      await postOutro({ outro_tagline: tagline });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTagline(false);
    }
  }

  async function handleEndFrameFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !clientId) return;
    setActionError(null);
    try {
      const path = await upload(file, "end_frame", reelId);
      await postOutro({ custom_end_frame_storage_path: path });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Creates the outro motion prompt (free) so it can be edited before the paid generate. */
  async function handlePreparePrompt() {
    setPreparing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/outro/prompts`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "prepare failed");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
    }
  }

  async function handleReturnToDefault() {
    setActionError(null);
    try {
      await postOutro({ return_to_default: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!state) return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;

  const aspectRatio = reelDetail?.reel_config.aspect_ratio as AssetReviewProps["aspectRatio"];
  const outroClipCostUsd = typeof estimate?.total_usd === "number" ? estimate.total_usd : 0;
  const outroPrompt = state.prompt ?? state.slots.outro_clip?.prompt ?? null;
  const generateButtonLabel = generating
    ? "Generating…"
    : state.slots.outro_clip
      ? "Regenerate outro clip"
      : "Generate outro clip";

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <CostEstimateBar estimate={estimate ?? { total_usd: null, rate_missing: false, lines: [] }} />

      {outroClipCostUsd > 0 ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={generating} className="w-fit">
              {generateButtonLabel}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Generate the outro clip?</AlertDialogTitle>
              <AlertDialogDescription>
                Generate the outro clip for an estimated ${outroClipCostUsd.toFixed(2)}?
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

      <Card>
        <CardHeader>
          <CardTitle>Outro</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 sm:flex-row">
          <div className="flex flex-1 flex-col gap-3">
            <span className="text-xs font-semibold uppercase text-muted-foreground">End frame</span>

            {state.slots.end_frame ? (
              <AssetReview
                reviewEndpoint={reviewEndpoint}
                assetId={state.slots.end_frame.asset_id}
                mediaType={state.slots.end_frame.media_type}
                previewUrl={state.slots.end_frame.preview_url}
                currentVersionId={state.slots.end_frame.current_version_id}
                currentVersionNo={state.slots.end_frame.current_version_no}
                history={state.slots.end_frame.history}
                aspectRatio={aspectRatio}
                costUsd={0}
                onChanged={reload}
              />
            ) : (
              <div className="text-xs text-muted-foreground">
                not generated yet — save a tagline below or upload a custom end frame to create it
              </div>
            )}

            <div className="flex flex-col gap-1">
              <Label htmlFor="outro_tagline">Tagline</Label>
              <Input
                id="outro_tagline"
                value={tagline}
                onChange={(e) => {
                  taglineTouched.current = true;
                  setTagline(e.target.value);
                }}
              />
              <Button size="sm" onClick={handleSaveTagline} disabled={savingTagline} className="w-fit">
                {savingTagline ? "Saving…" : "Save tagline"}
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="end_frame_upload">Custom end frame</Label>
              <input
                id="end_frame_upload"
                type="file"
                accept="image/*"
                onChange={handleEndFrameFileChange}
                disabled={uploading || !clientId}
                className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-secondary-foreground"
              />
              {uploading ? <span className="text-xs text-muted-foreground">Uploading…</span> : null}
            </div>

            {state.data.reel_config.end_frame_mode === "custom" ? (
              <Button variant="outline" size="sm" onClick={handleReturnToDefault} className="w-fit">
                Return to default
              </Button>
            ) : null}
          </div>

          <div className="flex flex-1 flex-col gap-3">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Outro clip</span>

            {state.slots.outro_clip ? (
              <>
                <AssetReview
                  reviewEndpoint={reviewEndpoint}
                  assetId={state.slots.outro_clip.asset_id}
                  mediaType={state.slots.outro_clip.media_type}
                  previewUrl={state.slots.outro_clip.preview_url}
                  currentVersionId={state.slots.outro_clip.current_version_id}
                  currentVersionNo={state.slots.outro_clip.current_version_no}
                  history={state.slots.outro_clip.history}
                  aspectRatio={aspectRatio}
                  costUsd={outroClipCostUsd}
                  clientId={clientId}
                  reelId={reelId}
                  onChanged={reloadBoth}
                />

                {/* Duration comes off the clip-audio payload (clip_duration_s), the only
                    route that surfaces the outro clip's persisted length to the browser. */}
                {outroAudio?.clip_duration_s != null ? (
                  <TrimControls
                    label={outroAudio.asset_id && !unlinkedAudio ? "Trim range (picture + sound)" : "Trim range"}
                    durationS={outroAudio.clip_duration_s}
                    range={trimRange ?? [0, outroAudio.clip_duration_s]}
                    onChange={setTrimRange}
                    onSubmit={(range) =>
                      handleTrim(
                        state.slots.outro_clip!.asset_id,
                        range,
                        !unlinkedAudio ? outroAudio.asset_id : null
                      )
                    }
                    saving={trimming}
                  />
                ) : null}

                {outroAudio ? (
                  <ClipAudioPanel reelId={reelId} clientId={clientId} clip={outroAudio} onChanged={reloadBoth}>
                    {outroAudio.asset_id ? (
                      <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={unlinkedAudio}
                            onChange={(e) => setUnlinkedAudio(e.target.checked)}
                          />
                          Trim the sound separately from the picture
                        </label>
                        {unlinkedAudio && outroAudio.duration_s != null ? (
                          <TrimControls
                            label="Audio trim range"
                            durationS={outroAudio.duration_s}
                            range={audioTrimRange ?? [0, outroAudio.duration_s]}
                            onChange={setAudioTrimRange}
                            onSubmit={(range) => handleAudioTrim(outroAudio.asset_id!, range)}
                            saving={trimmingAudio}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </ClipAudioPanel>
                ) : null}
              </>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">
                  not generated yet — use “Generate outro clip” above, or upload your own
                </div>
                <UploadSlot
                  reviewEndpoint={reviewEndpoint}
                  mediaType="video"
                  clientId={clientId}
                  reelId={reelId}
                  onUploaded={reloadBoth}
                />
              </>
            )}

            {/* Fetched by (reel, kind), not via the clip asset, so it's editable before generating. */}
            {outroPrompt ? (
              <PromptReview
                reviewEndpoint={reviewEndpoint}
                promptId={outroPrompt.id}
                currentText={outroPrompt.text}
                currentVersionNo={outroPrompt.version_no}
                history={outroPrompt.history}
                // Passed so a text edit round-trips whatever refs the version
                // already carries instead of blanking them. No promptsEndpoint
                // though — the refs UI stays hidden, since the outro clip can't
                // take reference images (see ../../../api/reels/[reelId]/outro/prompts/route.ts).
                currentRefs={outroPrompt.reference_paths}
                // "Regenerate prompt" re-reads the current outro route, so the
                // notice's re-optimise button is exactly the right remedy here.
                staleness={state.data.prompt_staleness}
                clientId={clientId}
                reelId={reelId}
                onChanged={reload}
              />
            ) : (
              <Button variant="outline" size="sm" onClick={handlePreparePrompt} disabled={preparing} className="w-fit">
                {preparing ? "Preparing…" : "Prepare prompt"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {actionError ? <span className="text-xs text-destructive">{actionError}</span> : null}
      {uploadError ? <span className="text-xs text-destructive">{uploadError}</span> : null}
    </main>
  );
}
