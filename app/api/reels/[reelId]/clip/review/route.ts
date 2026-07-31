/**
 * Stage 5 (clip) two-granularity review: redo/edit the motion prompt, or
 * redoAsset to regenerate the clip itself. HeyGen redoAsset = $7 flat,
 * surfaced by the estimate/spend endpoints, not blocked here.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { createClipReviewHooks } from "@/src/stages/clip";
import { reviewActionSchema, dispatchReviewAction } from "@/src/lib/reviewAction";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = reviewActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  const hooks = createClipReviewHooks(ctx);
  try {
    const result = await dispatchReviewAction(hooks, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
