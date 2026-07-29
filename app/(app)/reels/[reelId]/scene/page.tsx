"use client";

import { useEffect, useState, use as usePromise } from "react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import { Switch } from "@/app/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
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
import { useApiResource } from "@/app/hooks/useApiResource";

/**
 * Local, page-scoped scene shape — mirrors src/stages/scene/index.ts's
 * `sceneEntrySchema` fields exactly (id?, position, type, product_in_scene,
 * seconds, transition_to_next, broll_provider_override, description), the
 * set the backend actually accepts on save. `id` is optional: brand-new,
 * not-yet-saved rows added via "Add scene" omit it; every row that came
 * from the server keeps its real `id` for the lifetime of this page (never
 * regenerated/dropped — see the delete-by-omission contract note below).
 */
interface SceneRow {
  id?: string;
  position: number;
  type: "avatar" | "broll";
  product_in_scene: boolean;
  seconds: number;
  transition_to_next: "continuous" | "hard_cut" | null;
  broll_provider_override: string | null;
  end_frame_disabled: boolean;
  description: string | null;
}

interface SceneHint {
  scene_id: string;
  downgraded_to_hard_cut: boolean;
}

interface SceneLoadResponse {
  stage: string;
  data: {
    scenes: SceneRow[];
    /** The instruction scene-brain will run with — the stored override, or the built-in default. */
    scene_prompt: string;
    scene_prompt_is_default: boolean;
  };
}

interface SceneSaveResponse {
  scenes: SceneRow[];
  hints: SceneHint[];
}

/** Minimal projection of `GET /api/reels/{reelId}` — only avatar_enabled is needed here (spec §3.1). */
interface ReelConfigResponse {
  reel_config: { avatar_enabled: boolean };
}

function renumber(list: SceneRow[]): SceneRow[] {
  return list.map((s, i) => ({ ...s, position: i }));
}

/**
 * Stage 3 — Scene review/edit (spec §3.1). Full rewrite from the old
 * read-only display: this is the fix for the data-loss "Save" bug — the old
 * page's Save button had no inline-editing state at all and always POSTed
 * `{ regenerate: false }` with no `scenes` field, which src/stages/scene's
 * `process()` treats as "no desired list supplied" and silently re-runs
 * scene-brain instead of saving anything. This page keeps a real local
 * `scenes` array as the single source of truth for the editable table and
 * POSTs it verbatim on Save — a save that only saves.
 *
 * Lives under the reel-stage layout (spec §2.6) now: no own header/back-
 * forward links here, the shared ProgressSteps + Previous/Next replace them.
 */
export default function ScenePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);

  const {
    data: sceneData,
    loading: sceneLoading,
    error: sceneLoadError,
    reload: reloadScenes,
  } = useApiResource<SceneLoadResponse>(`/api/reels/${reelId}/scene`);
  const { data: reelConfigData } = useApiResource<ReelConfigResponse>(`/api/reels/${reelId}`);
  const avatarEnabled = reelConfigData?.reel_config.avatar_enabled ?? false;

  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [hints, setHints] = useState<SceneHint[]>([]);
  const [scenePrompt, setScenePrompt] = useState("");
  const [promptIsDefault, setPromptIsDefault] = useState(true);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed local editable state from the GET response once it arrives. reelId
  // never changes for the lifetime of this page, so sceneData only ever
  // transitions once from null -> a value.
  useEffect(() => {
    if (!sceneData) return;
    setScenes(sceneData.data.scenes);
    setScenePrompt(sceneData.data.scene_prompt);
    setPromptIsDefault(sceneData.data.scene_prompt_is_default);
  }, [sceneData]);

  function updateScene(idx: number, patch: Partial<SceneRow>) {
    setScenes((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function handleAddScene() {
    setScenes((prev) =>
      renumber([
        ...prev,
        {
          position: prev.length,
          type: "broll",
          product_in_scene: false,
          seconds: 5,
          transition_to_next: null,
          broll_provider_override: null,
          end_frame_disabled: false,
          description: "",
        },
      ])
    );
  }

  function handleDeleteScene(idx: number) {
    setScenes((prev) => renumber(prev.filter((_, i) => i !== idx)));
  }

  function handleMove(idx: number, direction: -1 | 1) {
    setScenes((prev) => {
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return renumber(next);
    });
  }

  async function postScene(body: { scenes: SceneRow[] } | { regenerate: true }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/scene`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as SceneSaveResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "failed to save scenes");
      setScenes(data.scenes ?? []);
      setHints(data.hints ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Persists the instruction only — the backend deliberately does NOT
   * regenerate on a prompt-only save, so this is safe both before the first
   * generation and between re-runs.
   */
  async function handleSavePrompt(text: string) {
    setSavingPrompt(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/scene`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene_prompt: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to save prompt");
      setPromptIsDefault(text.trim() === "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPrompt(false);
    }
  }

  function handleSave() {
    // Renumbered defensively (already kept contiguous by every add/delete/move above) and
    // `type` re-forced to "broll" when avatar mode is off, matching the backend's own
    // enforceRules() re-assertion — never send a stale "avatar" type the UI can't produce.
    const payload: SceneRow[] = scenes.map((s, i) => ({
      ...s,
      position: i,
      type: avatarEnabled ? s.type : "broll",
    }));
    void postScene({ scenes: payload });
  }

  function handleRegenerate() {
    void postScene({ regenerate: true });
  }

  const downgraded = new Set(hints.filter((h) => h.downgraded_to_hard_cut).map((h) => h.scene_id));

  if (sceneLoading && !sceneData) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (sceneLoadError) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
        <p className="text-sm text-destructive">{sceneLoadError}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      {error ? <span className="text-xs text-destructive">{error}</span> : null}

      {/* Editable up front (before any scenes exist) and again between re-runs. */}
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <div className="flex items-center justify-between">
            <Label htmlFor="scene_prompt">Scene-brain prompt</Label>
            <span className="text-xs text-muted-foreground">{promptIsDefault ? "using the default" : "customised"}</span>
          </div>
          <Textarea
            id="scene_prompt"
            value={scenePrompt}
            onChange={(e) => setScenePrompt(e.target.value)}
            rows={10}
            className="font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void handleSavePrompt(scenePrompt)} disabled={savingPrompt} className="w-fit">
              {savingPrompt ? "Saving…" : "Save prompt"}
            </Button>
            {promptIsDefault ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={savingPrompt}
                onClick={async () => {
                  await handleSavePrompt("");
                  await reloadScenes();
                }}
                className="w-fit"
              >
                Reset to default
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {sceneData && scenes.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-sm text-muted-foreground">No scenes yet.</p>
          <Button size="lg" onClick={handleRegenerate} disabled={busy}>
            {busy ? "Generating…" : "Generate scenes"}
          </Button>
        </div>
      ) : null}

      {scenes.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={busy}>
                  Re-run scene-brain
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Re-run scene-brain?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This replaces every scene below with a freshly generated list — any edits you&apos;ve made will
                    be lost. Continue?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={handleRegenerate}>
                    Regenerate
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex flex-col gap-3">
            {scenes.map((scene, idx) => {
              const isLast = idx === scenes.length - 1;
              const effectiveType: "avatar" | "broll" = avatarEnabled ? scene.type : "broll";
              const transitionDisabled = isLast || effectiveType === "avatar";
              const transitionValue: "continuous" | "hard_cut" | null = isLast
                ? null
                : effectiveType === "avatar"
                  ? "hard_cut"
                  : scene.transition_to_next ?? null;
              const rowKey = scene.id ?? `new-${idx}`;

              return (
                <Card key={rowKey}>
                  <CardContent className="flex flex-col gap-3 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-muted-foreground">Scene #{idx + 1}</span>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label="Move scene up"
                          onClick={() => handleMove(idx, -1)}
                          disabled={busy || idx === 0}
                        >
                          ↑
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label="Move scene down"
                          onClick={() => handleMove(idx, 1)}
                          disabled={busy || isLast}
                        >
                          ↓
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDeleteScene(idx)}
                          disabled={busy}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3">
                      {avatarEnabled ? (
                        <div className="flex flex-col gap-1">
                          <Label>Type</Label>
                          <Select
                            value={scene.type}
                            onValueChange={(v) => updateScene(idx, { type: v as "avatar" | "broll" })}
                          >
                            <SelectTrigger className="w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="avatar">avatar</SelectItem>
                              <SelectItem value="broll">broll</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}

                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`seconds-${rowKey}`}>Seconds</Label>
                        <Input
                          id={`seconds-${rowKey}`}
                          type="number"
                          min={1}
                          step={0.5}
                          value={scene.seconds}
                          onChange={(e) => updateScene(idx, { seconds: Number(e.target.value) })}
                          className="w-24"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <Label>Transition to next</Label>
                        <Select
                          value={transitionValue ?? undefined}
                          onValueChange={(v) =>
                            updateScene(idx, { transition_to_next: v as "continuous" | "hard_cut" })
                          }
                          disabled={transitionDisabled}
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue placeholder={isLast ? "— (last scene)" : "Select…"} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="continuous">continuous</SelectItem>
                            <SelectItem value="hard_cut">hard_cut</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {effectiveType === "broll" ? (
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`end-frame-${rowKey}`}>Start+end frame</Label>
                          <div className="flex h-9 items-center">
                            <Switch
                              id={`end-frame-${rowKey}`}
                              checked={!scene.end_frame_disabled}
                              onCheckedChange={(checked) => updateScene(idx, { end_frame_disabled: !checked })}
                            />
                          </div>
                        </div>
                      ) : null}

                      {scene.id && downgraded.has(scene.id) ? (
                        <Badge variant="warning">downgraded to hard_cut (model lacks end-frame support)</Badge>
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`description-${rowKey}`}>Description</Label>
                      <Textarea
                        id={`description-${rowKey}`}
                        value={scene.description ?? ""}
                        onChange={(e) => updateScene(idx, { description: e.target.value })}
                        rows={2}
                      />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Button type="button" variant="outline" onClick={handleAddScene} disabled={busy} className="w-fit">
            + Add scene
          </Button>
        </>
      ) : null}
    </main>
  );
}
