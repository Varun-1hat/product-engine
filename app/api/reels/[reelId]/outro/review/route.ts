/**
 * Stage 7 (outro) two-granularity review, covering BOTH the end-frame
 * image asset and the outro-clip asset (disambiguated by which assetId/
 * promptId is passed — see src/stages/outro.createOutroReviewHooks).
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { createOutroReviewHooks } from "@/src/stages/outro";
import { reviewActionSchema, dispatchReviewAction } from "@/src/lib/reviewAction";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = reviewActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  const hooks = createOutroReviewHooks(ctx);
  try {
    const result = await dispatchReviewAction(hooks, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
