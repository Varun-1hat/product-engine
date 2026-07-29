/**
 * Stage 7 (outro) — prepare the outro motion prompt without generating the
 * outro clip, so it can be reviewed/edited before the expensive provider
 * call. Idempotent: an existing prompt is left untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { ensureOutroPrompt } from "@/src/stages/outro";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  try {
    await ensureOutroPrompt(ctx);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
