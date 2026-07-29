/**
 * Stage 4 (image) — prepare the per-slot image prompts without generating
 * any images, so they can be reviewed/edited before the paid Nano Banana
 * call. Idempotent: existing prompts are left untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { ensureImagePrompts } from "@/src/stages/image";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  try {
    await ensureImagePrompts(ctx);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
