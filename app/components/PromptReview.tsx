"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
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
  onChanged?: () => void;
}

/**
 * Prompt-level review (spec §7 Stage 4/5/7, two-granularity review, brief
 * §8): edit the prompt text directly, or "redo" to re-run the producing
 * skill. Both create a new prompt_version and re-point current_version_id
 * (spec §2.4) — nothing is destroyed.
 */
export function PromptReview({
  reviewEndpoint,
  promptId,
  currentText,
  currentVersionNo,
  history = [],
  shared,
  onChanged,
}: PromptReviewProps) {
  const [text, setText] = useState(currentText);
  const [busy, setBusy] = useState<"redo" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: "redoPrompt" | "editPrompt", extra: Record<string, unknown> = {}) {
    const res = await fetch(reviewEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, promptId, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `${action} failed`);
    return data as { text: string };
  }

  async function handleRedo() {
    setBusy("redo");
    setError(null);
    try {
      const version = await call("redoPrompt");
      setText(version.text);
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
      await call("editPrompt", { text });
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

      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save edit"}
        </Button>
        <Button size="sm" variant="outline" onClick={handleRedo} disabled={busy !== null}>
          {busy === "redo" ? "Redoing…" : "Redo (re-run skill)"}
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
