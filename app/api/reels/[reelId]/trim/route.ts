/**
 * Stage 6 (trim) — enqueue a trim job for one asset ({asset_id, start_s,
 * end_s}). Thin: delegates to src/stages/trim. Human-managed reorder lives
 * at ./reorder/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { trimStage, computeTrimHints } from "@/src/stages/trim";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const [state, hints] = await Promise.all([trimStage.load(ctx), computeTrimHints(ctx)]);
  return NextResponse.json({ ...state, hints });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = trimStage.inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const result = await trimStage.process(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
