/**
 * Stage 6 (trim) review — redoAsset/revertAsset/download/history against the
 * same clip asset Stage 5 (clip) created (scenes.clip_asset_id); Trim never
 * owns a separate asset kind, it just appends `derived` versions to that
 * asset. No prompts exist for trim (redoPrompt/editPrompt/revertPrompt throw
 * — see src/stages/trim/index.ts's createTrimReviewHooks), so this route
 * doesn't add any prompt-specific handling; it dispatches exactly like
 * app/api/reels/[reelId]/clip/review/route.ts, just pointed at trimStage's
 * hooks. Cost: none (redoAsset just re-enqueues a local ffmpeg re-encode of
 * the last-applied start_s/end_s — no adapter/provider call), so nothing
 * here needs cost gating.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { createTrimReviewHooks } from "@/src/stages/trim";
import { reviewActionSchema, dispatchReviewAction } from "@/src/lib/reviewAction";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = reviewActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  const hooks = createTrimReviewHooks(ctx);
  try {
    const result = await dispatchReviewAction(hooks, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
