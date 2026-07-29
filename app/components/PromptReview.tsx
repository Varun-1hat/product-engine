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
  /** Reference images already attached to the current version. */
  currentRefs?: string[];
  /** Product photos offered for attaching; omit to hide the reference picker entirely. */
  referenceOptions?: ReferenceOption[];
  onChanged?: () => void;
}

export interface ReferenceOption {
  path: string;
  url: string | null;
  product_name: string;
}

/**
 * Prompt-level review (spec §7 Stage 4/5/7, two-granularity review, brief
 * §8): edit the prompt text directly, or "redo" to re-run the producing
 * skill. Both create a new prompt_version and re-point current_version_id
 * (spec §2.4) — nothing is destroyed.
 *
 * When `referenceOptions` is supplied, product photos can also be attached
 * to the prompt: they're saved alongside the text as the version's
 * reference_paths, and the image stage passes exactly those to the provider
 * as visual references, so the generation has the real product to work from.
 */
export function PromptReview({
  reviewEndpoint,
  promptId,
  currentText,
  currentVersionNo,
  history = [],
  shared,
  currentRefs = [],
  referenceOptions,
  onChanged,
}: PromptReviewProps) {
  const [text, setText] = useState(currentText);
  const [refs, setRefs] = useState<string[]>(currentRefs);
  const [busy, setBusy] = useState<"redo" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleRef(path: string) {
    setRefs((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  }

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

      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />

      {referenceOptions && referenceOptions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Attach product photos as references ({refs.length} selected) — saved with the prompt
          </span>
          <div className="flex flex-wrap gap-2">
            {referenceOptions.map((option) => {
              const selected = refs.includes(option.path);
              return (
                <button
                  key={option.path}
                  type="button"
                  onClick={() => toggleRef(option.path)}
                  title={option.product_name}
                  className={`h-16 w-16 overflow-hidden rounded-md border border-border ${selected ? "ring-2 ring-primary" : ""}`}
                >
                  {option.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not a static asset
                    <img src={option.url} alt={option.product_name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-muted-foreground">
                      {option.product_name}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

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
