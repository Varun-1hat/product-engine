"use client";

import { useEffect, useState, use as usePromise } from "react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Skeleton } from "@/app/components/ui/skeleton";
import { DownloadButton } from "@/app/components/DownloadButton";
import { useApiResource } from "@/app/hooks/useApiResource";
import type { AssetRow, AssetVersion, Reel } from "@/src/lib/db/types";

const POLL_INTERVAL_MS = 3000;

type FinalRenderAsset = AssetRow & { current_version: AssetVersion | null };

interface AssemblyGetResponse {
  stage: "assembly";
  data: { reel: Reel };
  final_render: FinalRenderAsset | null;
}

/**
 * Assembly page (spec §8.1) — the last stage, no "Next" control applies
 * here (spec §2.6 already stops rendering Next past the last stage).
 * "Start assembly"/"Re-assemble" POST {} to /api/reels/{reelId}/assembly
 * (cost: none — no provider calls at this stage); this page then polls the
 * same endpoint's GET every 3s until the newly-triggered render lands
 * (see the `pending` state below for exactly what "processing" means here
 * and why). No job-failure UI — the backend has nothing to report beyond
 * "not assembled yet" today, so this deliberately never fabricates one.
 */
export default function AssemblyStagePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const reviewEndpoint = `/api/reels/${reelId}/assembly/review`;

  const { data, loading, error, reload } = useApiResource<AssemblyGetResponse>(`/api/reels/${reelId}/assembly`);
  const reel = data?.data.reel ?? null;
  const finalRender = data?.final_render ?? null;
  const hasRender = Boolean(finalRender?.current_version_id && finalRender?.current_version);

  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  // `pending` is the page's own "a job we triggered this session is still
  // running" flag — set right after a successful Start/Re-assemble POST,
  // cleared once a final_render version different from the one at
  // trigger-time shows up. This (not just `!hasRender`) is what drives the
  // "Processing…" state/polling/button-disable: the GET response has no
  // job-status field, so there's no way to distinguish "never started" from
  // "already running" on a fresh page load (spec §8.1 derives "Processing…"
  // from `!final_render`+`status`, which is correct *while a job we know
  // about is in flight*, but read literally would leave "Start assembly"
  // permanently disabled on every reel's very first visit — the disable
  // condition is intentionally narrowed to what this page can actually
  // observe; see .pipeline/changes-d5-assembly.md).
  const [pending, setPending] = useState(false);
  const [pendingFromVersionId, setPendingFromVersionId] = useState<string | null>(null);

  useEffect(() => {
    if (pending && finalRender?.current_version_id && finalRender.current_version_id !== pendingFromVersionId) {
      setPending(false);
    }
  }, [pending, pendingFromVersionId, finalRender?.current_version_id]);

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => {
      reload();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  async function handleAssemble() {
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/assembly`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "failed to start assembly");
      setPendingFromVersionId(finalRender?.current_version_id ?? null);
      setPending(true);
      await reload();
    } catch (err) {
      setPostError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  if (loading && !data) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-10 w-40" />
      </main>
    );
  }

  if (error || !reel) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <p className="text-sm text-destructive">{error ?? "Reel not found."}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Final render</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasRender && finalRender ? (
            <FinalRenderPreview reviewEndpoint={reviewEndpoint} finalRender={finalRender} pending={pending} />
          ) : (
            <div className="flex flex-col gap-3">
              <Skeleton className="aspect-video w-full" />
              <p className="text-sm text-muted-foreground">
                {pending ? "Processing…" : "Nothing rendered yet — start assembly below."}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={handleAssemble} disabled={posting || pending}>
              {posting ? "Starting…" : hasRender ? "Re-assemble" : "Start assembly"}
            </Button>
            {postError ? <span className="text-xs text-destructive">{postError}</span> : null}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function FinalRenderPreview({
  reviewEndpoint,
  finalRender,
  pending,
}: {
  reviewEndpoint: string;
  finalRender: FinalRenderAsset;
  pending: boolean;
}) {
  const assetVersionId = finalRender.current_version_id;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setPreviewError(null);
    if (!assetVersionId) return undefined;

    (async () => {
      try {
        const res = await fetch(reviewEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "download", assetVersionId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "failed to load preview");
        if (!cancelled) setPreviewUrl(body.url as string);
      } catch (err) {
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reviewEndpoint, assetVersionId]);

  if (!assetVersionId) return null;

  return (
    <div className="flex flex-col gap-3">
      {previewUrl ? (
        <video controls src={previewUrl} className="aspect-video w-full rounded-md border border-border bg-muted" />
      ) : (
        <Skeleton className="aspect-video w-full" />
      )}
      {previewError ? <span className="text-xs text-destructive">{previewError}</span> : null}

      <div className="flex flex-wrap items-center gap-3">
        <DownloadButton reviewEndpoint={reviewEndpoint} assetVersionId={assetVersionId} label="Download final render" />
        {pending ? (
          <span className="text-xs text-muted-foreground">Re-assembling — this preview may be stale until it finishes…</span>
        ) : null}
      </div>
    </div>
  );
}
