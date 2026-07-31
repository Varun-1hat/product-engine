"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Switch } from "./ui/switch";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import { VersionHistory, type VersionHistoryEntry } from "./VersionHistory";

export interface PromptReviewProps {
  /** The stage's review endpoint, e.g. `/api/reels/{reelId}/image/review`. */
  reviewEndpoint: string;
  promptId: string;
  currentText: string;
  currentVersionNo: number;
  history?: VersionHistoryEntry[];
  /** Shared boundary-frame prompt (spec §2.4) — editing/reverting affects both scenes. */
  shared?: boolean;
  /** Reference images already attached to the current version. */
  currentRefs?: string[];
  /**
   * Set when this prompt was optimised for a different model than the one that
   * will now run it (src/skills/model-prompt/guidance.ts). Advisory — the
   * prompt still generates; re-optimising is just the redo, which rewrites it
   * for the current model.
   */
  staleness?: PromptStalenessInfo | null;
  /**
   * The stage's prompts endpoint, e.g. `/api/reels/{reelId}/image/prompts` —
   * where the per-asset "use reel product references" toggle is persisted.
   * Together with clientId/reelId it also enables adding stage-level
   * reference images on top of the reel's product references.
   */
  promptsEndpoint?: string;
  /** Current per-asset state of the product-references toggle (default on). */
  useProductRefs?: boolean;
  clientId?: string | null;
  reelId?: string;
  onChanged?: () => void;
}

export interface PromptStalenessInfo {
  written_for: string;
  will_run_on: string;
  message: string;
}

/**
 * Prompt-level review (spec §7 Stage 4/5/7, two-granularity review, brief
 * §8): edit the prompt text directly, or "redo" to re-run the producing
 * skill. Both create a new prompt_version and re-point current_version_id
 * (spec §2.4) — nothing is destroyed.
 *
 * `currentRefs` (the version's reference_paths) are this asset's own
 * stage-level reference images — added here, and sent alongside the reel's
 * product references unless this asset opts out of them.
 */
export function PromptReview({
  reviewEndpoint,
  promptId,
  currentText,
  currentVersionNo,
  history = [],
  shared,
  currentRefs = [],
  staleness,
  promptsEndpoint,
  useProductRefs = true,
  clientId,
  reelId,
  onChanged,
}: PromptReviewProps) {
  const [text, setText] = useState(currentText);
  const [refs, setRefs] = useState<string[]>(currentRefs);
  const [useProduct, setUseProduct] = useState(useProductRefs);
  const [busy, setBusy] = useState<"redo" | "save" | "refs" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { upload } = useFileUpload(clientId ?? "");
  // "Leave as is" only hides the notice for this session — it deliberately does
  // not write anything, so the mismatch is re-surfaced on reload until the
  // prompt or the model actually changes.
  const [dismissed, setDismissed] = useState(false);

  async function call(action: "redoPrompt" | "editPrompt", extra: Record<string, unknown> = {}) {
    const res = await fetch(reviewEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, promptId, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `${action} failed`);
    return data as { text: string; reference_paths?: string[] };
  }

  async function handleRedo() {
    setBusy("redo");
    setError(null);
    try {
      const version = await call("redoPrompt");
      setText(version.text);
      setRefs(version.reference_paths ?? []);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Per-asset only — never touches the reel's product references or any other asset. */
  async function handleToggleProduct(checked: boolean) {
    setUseProduct(checked);
    setError(null);
    try {
      const res = await fetch(promptsEndpoint!, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: promptId, use_product_refs: checked }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "toggle failed");
    } catch (err) {
      setUseProduct(!checked);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Stage-level additions — stored on this prompt, sent alongside the reel defaults. */
  async function handleAddRefs(files: FileList) {
    setBusy("refs");
    setError(null);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) uploaded.push(await upload(file, "asset", reelId));
      const next = [...refs, ...uploaded];
      await call("editPrompt", { text, refs: next });
      setRefs(next);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    setBusy("save");
    setError(null);
    try {
      await call("editPrompt", { text, refs });
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Prompt</span>
        {shared ? (
          <span className="text-xs text-muted-foreground">shared frame — editing/reverting affects both scenes</span>
        ) : null}
      </div>

      {staleness && !dismissed ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
          <span className="text-xs">{staleness.message}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleRedo} disabled={busy !== null}>
              {busy === "redo" ? "Re-optimising…" : `Re-optimise for ${staleness.will_run_on}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)} disabled={busy !== null}>
              Leave as is
            </Button>
          </div>
        </div>
      ) : null}

      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />

      {promptsEndpoint ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={useProduct} onCheckedChange={handleToggleProduct} disabled={busy !== null} />
            Use reel product references
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {refs.length > 0 ? `${refs.length} extra reference image(s)` : "no extra reference images"} —
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={busy !== null || !clientId}
              onChange={(e) => {
                if (e.target.files?.length) handleAddRefs(e.target.files);
                e.target.value = "";
              }}
              className="text-xs"
            />
          </label>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save edit"}
        </Button>
        {/* Named for what it does, not for how it does it: "Redo (re-run
            skill)" read as an internal action and users did not realise this
            regenerates the prompt itself rather than the asset. */}
        <Button size="sm" variant="outline" onClick={handleRedo} disabled={busy !== null}>
          {busy === "redo" ? "Regenerating…" : "Regenerate prompt"}
        </Button>
      </div>

      {error ? <span className="text-xs text-destructive">{error}</span> : null}

      {history.length > 0 ? (
        <VersionHistory
          reviewEndpoint={reviewEndpoint}
          kind="prompt"
          targetId={promptId}
          currentVersionNo={currentVersionNo}
          versions={history}
          onReverted={onChanged}
        />
      ) : null}
    </div>
  );
}
