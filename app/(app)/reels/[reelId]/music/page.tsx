"use client";

import { useEffect, useState, use as usePromise } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Label } from "@/app/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { ClipAudioPanel, useClipAudio } from "@/app/components/ClipAudioPanel";
import { useApiResource } from "@/app/hooks/useApiResource";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import type { Reel, ReelConfigRow } from "@/src/lib/db/types";

/** The two music adapters (spec §3.4) — the only provider_t values this page offers. */
type MusicProvider = "elevenlabs" | "lyria";

interface MusicVersion {
  version_no: number;
  source: string;
  provider: string | null;
  created_at: string;
  is_current: boolean;
  url: string | null;
}

interface PromptStaleness {
  written_for: string;
  will_run_on: string;
  message: string;
}

interface MusicStateResponse {
  stage: "music";
  data: { reel_config: ReelConfigRow; prompt_staleness: PromptStaleness | null };
  music_url: string | null;
  versions: MusicVersion[];
}

/** Minimal projection of `GET /api/reels/{reelId}` — only client_id is needed here (for useFileUpload). */
interface ReelDetailResponse {
  reel: Reel;
}

/**
 * Stage 8 (music) page (spec §7.4) — edit the prompt, generate/regenerate
 * with the chosen music model, or override it with your own upload. Bounds for the start/end trim
 * inputs come from the browser at runtime via the <audio> element's
 * `loadedmetadata` event (`duration` isn't known up front, unlike a Slider's
 * fixed min/max), so plain number inputs that clamp against the now-known
 * duration are used instead of a Slider, per spec.
 *
 * Two lengths of audio live here. The card above is the reel-length
 * background bed. The card below is the same models generating clip by clip,
 * writing into each clip's own audio slot beside whatever the video model
 * produced — so this page is where the whole soundtrack is settled: bed
 * underneath, per-clip audio on top, each clip switchable on or off. It is
 * also the one stage that lists the outro clip, which Clip and Trim don't
 * show.
 */
export default function MusicStagePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);

  const { data: state, reload } = useApiResource<MusicStateResponse>(`/api/reels/${reelId}/music`);
  const { data: reelDetail } = useApiResource<ReelDetailResponse>(`/api/reels/${reelId}`);
  const clientId = reelDetail?.reel.client_id ?? null;
  const { upload, uploading, error: uploadError } = useFileUpload(clientId ?? "");

  const [duration, setDuration] = useState<number | null>(null);
  const [startS, setStartS] = useState(0);
  const [endS, setEndS] = useState(0);
  const [savingTrim, setSavingTrim] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<MusicProvider>("elevenlabs");
  const [generating, setGenerating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  // Clip-wise generation: per-clip prompt overrides (blank = use the reel
  // prompt above) and which clip is currently generating.
  const { clips: clipAudio, reloadClipAudio } = useClipAudio(reelId);
  const [clipPrompts, setClipPrompts] = useState<Record<string, string>>({});
  const [generatingClipKey, setGeneratingClipKey] = useState<string | null>(null);
  // Session-only: "leave as is" writes nothing, so the mismatch re-surfaces on
  // reload until the prompt or the selected model actually changes.
  const [stalenessDismissed, setStalenessDismissed] = useState(false);

  function clamp(n: number): number {
    if (!Number.isFinite(n)) return 0;
    const max = duration ?? Number.POSITIVE_INFINITY;
    return Math.min(Math.max(n, 0), max);
  }

  // Seed start/end from the server's saved trim whenever `state` (re)loads — this page only
  // ever reloads in response to this same page's own upload/save-trim actions, both of which
  // are legitimate points to resync from server truth (matches ConfigBrandTab's data-sync
  // convention: useEffect keyed on the fetched resource, not a per-keystroke controlled loop).
  useEffect(() => {
    if (!state) return;
    const trim = state.data.reel_config.music_trim;
    if (trim) {
      setStartS(trim.start_s);
      setEndS(trim.end_s);
    }
    setPrompt(state.data.reel_config.music_prompt ?? "");
    const savedProvider = state.data.reel_config.music_provider;
    if (savedProvider === "elevenlabs" || savedProvider === "lyria") setProvider(savedProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function handleLoadedMetadata(e: React.SyntheticEvent<HTMLAudioElement>) {
    const d = e.currentTarget.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    setDuration(d);
    setStartS((prev) => Math.min(Math.max(prev, 0), d));
    setEndS((prev) => (prev > 0 ? Math.min(prev, d) : d));
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !clientId) return;
    setActionError(null);
    try {
      const path = await upload(file, "music", reelId);
      const res = await fetch(`/api/reels/${reelId}/music`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ music_storage_path: path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "save failed");
      setDuration(null);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Saves the prompt without generating, so it can be reviewed/edited first. */
  async function handleSavePrompt() {
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/music`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ music_prompt: prompt, music_provider: provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "save failed");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Drafts the prompt with the music-prompt skill, written for the selected
   * model. `force` is the "re-optimise" action after a provider switch; without
   * it an existing prompt is left alone. Costs orchestrator tokens only — no
   * music is generated here.
   */
  async function handleDraftPrompt(force: boolean) {
    setDrafting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/music/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "draft failed");
      setStalenessDismissed(false);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrafting(false);
    }
  }

  /** Generate (or regenerate — same call) the track from the current prompt. */
  async function handleGenerate() {
    setGenerating(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/music/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "generate failed");
      setDuration(null);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Same models, same prompt, one clip's length instead of the reel's. The
   * track lands as a new version of that clip's audio slot, so the model's
   * own audio stays in its history and either can be restored.
   */
  async function handleGenerateForClip(clipKey: string) {
    setGeneratingClipKey(clipKey);
    setActionError(null);
    try {
      const clipPrompt = clipPrompts[clipKey]?.trim() || prompt;
      const res = await fetch(`/api/reels/${reelId}/music/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: clipPrompt, provider, target_clip: clipKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "generate failed");
      await reloadClipAudio();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingClipKey(null);
    }
  }

  /** Make an earlier take current again — nothing generated is ever lost. */
  async function handleRevert(versionNo: number) {
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/music/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_no: versionNo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "revert failed");
      setDuration(null);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveTrim() {
    setSavingTrim(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/music`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ music_trim: { start_s: startS, end_s: endS } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "save failed");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTrim(false);
    }
  }

  if (!state) return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;

  const hasTrack = Boolean(state.data.reel_config.music_path);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Music</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {state.data.prompt_staleness && !stalenessDismissed ? (
            <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              <span className="text-xs">{state.data.prompt_staleness.message}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => handleDraftPrompt(true)} disabled={drafting || generating}>
                  {drafting ? "Re-optimising…" : `Re-optimise for ${state.data.prompt_staleness.will_run_on}`}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setStalenessDismissed(true)} disabled={drafting}>
                  Leave as is
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <Label htmlFor="music_prompt">Prompt</Label>
            <Textarea
              id="music_prompt"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. upbeat lo-fi hip hop, warm keys, relaxed groove"
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="music_provider">Model</Label>
              <Select value={provider} onValueChange={(v) => setProvider(v as MusicProvider)}>
                <SelectTrigger id="music_provider" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="elevenlabs">ElevenLabs Music</SelectItem>
                  <SelectItem value="lyria">Lyria (Google)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => handleDraftPrompt(Boolean(prompt.trim()))} disabled={drafting || generating}>
              {drafting ? "Writing…" : prompt.trim() ? "Rewrite with AI" : "Write with AI"}
            </Button>
            <Button variant="outline" onClick={handleSavePrompt} disabled={generating || drafting}>
              Save prompt
            </Button>
            <Button onClick={handleGenerate} disabled={generating || !prompt.trim()}>
              {generating ? "Generating…" : hasTrack ? "Regenerate" : "Generate"}
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="music_upload">{hasTrack ? "Replace track (upload your own)" : "Upload track instead"}</Label>
            <input
              id="music_upload"
              type="file"
              accept="audio/*"
              onChange={handleFileChange}
              disabled={uploading || !clientId}
              className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-secondary-foreground"
            />
            {uploading ? <span className="text-xs text-muted-foreground">Uploading…</span> : null}
          </div>

          {hasTrack ? (
            <>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- background music track, no captions applicable */}
              <audio controls src={state.music_url ?? undefined} onLoadedMetadata={handleLoadedMetadata} className="w-full" />

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="start_s">Start (s)</Label>
                  <Input
                    id="start_s"
                    type="number"
                    min={0}
                    max={duration ?? undefined}
                    step={0.1}
                    value={startS}
                    onChange={(e) => setStartS(clamp(Number(e.target.value)))}
                    className="w-28"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="end_s">End (s)</Label>
                  <Input
                    id="end_s"
                    type="number"
                    min={0}
                    max={duration ?? undefined}
                    step={0.1}
                    value={endS}
                    onChange={(e) => setEndS(clamp(Number(e.target.value)))}
                    className="w-28"
                  />
                </div>
                <Button onClick={handleSaveTrim} disabled={savingTrim}>
                  {savingTrim ? "Saving…" : "Save trim"}
                </Button>
              </div>
              {duration === null ? (
                <span className="text-xs text-muted-foreground">Waiting for the track to load to determine its length…</span>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No track uploaded yet.</p>
          )}

          {state.versions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <Label>Versions</Label>
              {state.versions.map((v) => (
                <div key={v.version_no} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2">
                  <span className="text-xs text-muted-foreground">
                    v{v.version_no} · {v.provider ?? v.source}
                    {v.is_current ? " · current" : ""}
                  </span>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption -- background music track, no captions applicable */}
                  <audio controls src={v.url ?? undefined} className="h-8 flex-1" />
                  {v.is_current ? null : (
                    <Button variant="outline" size="sm" onClick={() => handleRevert(v.version_no)}>
                      Use this
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Fade-in/out and looping to fill the reel&apos;s length are applied automatically during assembly. This
            track plays underneath any clip audio you keep, not instead of it.
          </p>

          {actionError ? <span className="text-xs text-destructive">{actionError}</span> : null}
          {uploadError ? <span className="text-xs text-destructive">{uploadError}</span> : null}
        </CardContent>
      </Card>

      {clipAudio && clipAudio.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Clip audio</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="text-xs text-muted-foreground">
              Each clip&apos;s own audio — what the video model produced, or your own upload, or a track generated
              here for that clip alone. Switch any of them off to leave that clip carried by the background music.
            </p>

            {clipAudio.map((clip) => (
              <div key={clip.key} className="flex flex-col gap-2">
                <span className="text-sm font-medium">{clip.label}</span>
                <ClipAudioPanel reelId={reelId} clientId={clientId} clip={clip} onChanged={reloadClipAudio}>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`clip-prompt-${clip.key}`} className="text-xs text-muted-foreground">
                      Generate for this clip {clip.clip_duration_s != null ? `(${clip.clip_duration_s.toFixed(1)}s)` : ""}
                    </Label>
                    <div className="flex flex-wrap items-end gap-2">
                      <Input
                        id={`clip-prompt-${clip.key}`}
                        value={clipPrompts[clip.key] ?? ""}
                        onChange={(e) => setClipPrompts((prev) => ({ ...prev, [clip.key]: e.target.value }))}
                        placeholder={prompt || "e.g. a single warm swell under the reveal"}
                        className="min-w-48 flex-1"
                      />
                      <Button
                        variant="outline"
                        onClick={() => handleGenerateForClip(clip.key)}
                        disabled={generatingClipKey !== null || generating}
                      >
                        {generatingClipKey === clip.key ? "Generating…" : "Generate"}
                      </Button>
                    </div>
                  </div>
                </ClipAudioPanel>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
