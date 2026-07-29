"use client";

import { use as usePromise, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/app/components/ui/button";
import { ProgressSteps, type ProgressStep } from "@/app/components/ui/progress-steps";
import { useApiResource } from "@/app/hooks/useApiResource";
import { routes } from "@/src/lib/routes";
import { STAGE_ORDER } from "@/src/stages/types";
import type { StageId } from "@/src/lib/db/enums";
import type { Reel, ReelConfigRow } from "@/src/lib/db/types";

interface ReelResponse {
  reel: Reel;
  reel_config: ReelConfigRow;
}

/** Per-reel stages this layout covers — reel_setup isn't a page under here (spec §2.6). */
const REEL_STAGE_IDS = STAGE_ORDER.slice(1);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Reel-stage stepper shell (spec §2.6/§2.7). Wraps every /reels/{reelId}/{stage}
 * page with the ProgressSteps stepper and a strongly-weighted Previous/Next
 * row, and wires "Next" to POST /api/reels/{reelId}/advance the first time a
 * stage transition happens (never on every forward click through
 * already-reached stages — see handleNext below).
 *
 * currentIndex/reachedIndex below are STAGE_ORDER-relative (1-7, since
 * reel_setup at index 0 never has a page under this layout) for the
 * Previous/Next logic, matching spec §2.6/§2.7's own prose. ProgressSteps,
 * however, is given only the 7-entry scene..assembly slice, so its own
 * currentIndex/reachedIndex props are that same value shifted down by one
 * to stay in that array's index space (see the ProgressSteps call below).
 */
export default function ReelStageLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ reelId: string }>;
}) {
  const { reelId } = usePromise(params);
  const pathname = usePathname();
  const router = useRouter();
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  const { data, loading, error, reload } = useApiResource<ReelResponse>(`/api/reels/${reelId}`);
  const reel = data?.reel ?? null;

  /**
   * The way back OUT of the reel. The stepper only moves between stages, so
   * without this there is no route from any reel page to the client's reel
   * list — rendered on every branch below, including the error/loading ones.
   */
  const breadcrumb = (
    <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
      {reel ? (
        <Link href={routes.client(reel.client_id)} className="hover:underline">
          ← All reels
        </Link>
      ) : (
        <Link href={routes.clients()} className="hover:underline">
          ← Clients
        </Link>
      )}
      {reel ? <span className="truncate font-medium text-foreground">{reel.display_name}</span> : null}
    </div>
  );

  // The reel-setup edit page isn't a per-stage page (spec §2.6) — skip the
  // stepper/Previous-Next chrome here entirely so its own Next button below
  // never mistakes "just viewing setup" for "advance the current stage".
  if (pathname.split("/").filter(Boolean).pop() === "reel_setup") {
    return (
      <div className="mx-auto w-full max-w-4xl px-8 pt-8">
        {breadcrumb}
        {children}
      </div>
    );
  }

  if (loading && !reel) {
    return (
      <div className="mx-auto w-full max-w-4xl px-8 pt-8">
        {breadcrumb}
        <div className="h-16 w-full animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  if (error || !reel) {
    return (
      <div className="mx-auto w-full max-w-4xl px-8 pt-8">
        {breadcrumb}
        <p className="text-sm text-destructive">{error ?? "Reel not found."}</p>
      </div>
    );
  }

  const reachedIndex = STAGE_ORDER.indexOf(reel.current_stage);

  const lastSegment = pathname.split("/").filter(Boolean).pop() ?? "";
  const matchedIndex = STAGE_ORDER.indexOf(lastSegment as StageId);
  const currentIndex = matchedIndex >= 1 ? matchedIndex : reachedIndex;

  const steps: ProgressStep[] = REEL_STAGE_IDS.map((stage) => ({
    id: stage,
    label: capitalize(stage),
    href: STAGE_ORDER.indexOf(stage) <= reachedIndex ? routes.reelStage(reelId, stage) : null,
  }));

  const isLastStage = currentIndex === STAGE_ORDER.length - 1;
  const nextStage: StageId | null = isLastStage ? null : STAGE_ORDER[currentIndex + 1];
  // "Reached" only ever advances via the POST below (fired from this same
  // button), so currentIndex === reachedIndex is the normal, expected state
  // the very first time a stage's Next is clicked — not an edge case.
  const nextEnabled = !isLastStage && currentIndex <= reachedIndex;

  const isFirstStageUnderLayout = currentIndex === 1; // viewing "scene"
  const previousHref = isFirstStageUnderLayout
    ? routes.reelStage(reelId, "reel_setup")
    : routes.reelStage(reelId, STAGE_ORDER[currentIndex - 1]);
  const previousLabel = isFirstStageUnderLayout ? "← Reel setup" : `← ${capitalize(STAGE_ORDER[currentIndex - 1])}`;

  async function handleNext() {
    if (!nextEnabled || !nextStage) return;
    setAdvanceError(null);

    if (currentIndex === reachedIndex) {
      // Genuinely new territory — advance current_stage once, then navigate.
      setAdvancing(true);
      try {
        const res = await fetch(`/api/reels/${reelId}/advance`, { method: "POST" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "failed to advance");
        await reload();
      } catch (err) {
        setAdvanceError(err instanceof Error ? err.message : String(err));
        setAdvancing(false);
        return;
      }
      setAdvancing(false);
    }
    // currentIndex < reachedIndex: revisiting an already-reached stage —
    // just move forward, don't re-advance.
    router.push(routes.reelStage(reelId, nextStage));
  }

  return (
    <div className="flex flex-col">
      <div className="mx-auto w-full max-w-4xl px-8 pt-8">
        {breadcrumb}
        <ProgressSteps steps={steps} currentIndex={currentIndex - 1} reachedIndex={reachedIndex - 1} />

        <div className="mt-6 flex items-center justify-between gap-4 border-b border-border pb-6">
          <Link href={previousHref}>
            <Button variant="outline" size="lg">
              {previousLabel}
            </Button>
          </Link>

          {isLastStage ? null : (
            <div className="flex flex-col items-end gap-1">
              <Button size="lg" onClick={handleNext} disabled={!nextEnabled || advancing}>
                {advancing ? "Advancing…" : nextStage ? `${capitalize(nextStage)} →` : "Next"}
              </Button>
              {!nextEnabled ? (
                <span className="text-xs text-muted-foreground">Complete this stage to continue</span>
              ) : null}
              {advanceError ? <span className="text-xs text-destructive">{advanceError}</span> : null}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
