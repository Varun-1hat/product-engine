/**
 * Stage 5 (clip) — prepare the per-scene motion/shot prompts without
 * generating any clips, so they can be reviewed/edited before the expensive
 * provider call. Idempotent: existing prompts are left untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { ensureClipPrompts } from "@/src/stages/clip";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  try {
    await ensureClipPrompts(ctx);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
