/**
 * Per-clip audio — the one endpoint the Clip, Trim and Music pages all read
 * and write, which is what keeps a clip's on/off choice identical in all
 * three (there is no per-stage copy of it to drift). Reel-scoped rather than
 * stage-scoped for the same reason: the audio is a property of the clip, not
 * of the stage you happen to be looking at it from.
 *
 * GET returns every clip's track (scenes in order, then the outro) with a
 * signed preview URL and version history — the same enrichment
 * app/api/reels/[reelId]/clip/route.ts does for clips, so the pages render
 * without a live authenticated Supabase browser session.
 *
 * POST is the standard review-action dispatch (src/lib/reviewAction.ts), so
 * upload/download/revert/history behave exactly as they do for every other
 * asset, plus `setAudioEnabled` for the toggle.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { loadClipAudioState, createClipAudioReviewHooks } from "@/src/lib/clipAudio";
import { reconcilePendingJobs } from "@/src/lib/jobs/run";
import { reviewActionSchema, dispatchReviewAction } from "@/src/lib/reviewAction";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  // A clip that finished at the provider since the last read has no audio
  // extracted yet — finish it first so this response isn't a step behind.
  await reconcilePendingJobs(ctx);
  const clips = await loadClipAudioState(ctx);
  return NextResponse.json({ clips });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = reviewActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  const hooks = createClipAudioReviewHooks(ctx);
  try {
    const result = await dispatchReviewAction(hooks, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
