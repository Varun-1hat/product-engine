/**
 * Stage 4 (image) two-granularity review (prompt-level + image-level):
 * redoPrompt/editPrompt/redoAsset/revertPrompt/revertAsset/download/
 * history. See src/lib/reviewAction.ts for the shared action dispatcher.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { createImageReviewHooks } from "@/src/stages/image";
import { reviewActionSchema, dispatchReviewAction } from "@/src/lib/reviewAction";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = reviewActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  const hooks = createImageReviewHooks(ctx);
  try {
    const result = await dispatchReviewAction(hooks, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
