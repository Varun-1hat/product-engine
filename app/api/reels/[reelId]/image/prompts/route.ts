/**
 * Stage 4 (image) — prepare the per-slot image prompts without generating
 * any images, so they can be reviewed/edited before the paid Nano Banana
 * call. Idempotent: existing prompts are left untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { ensureImagePrompts } from "@/src/stages/image";
import { setUseProductRefs } from "@/src/lib/productRefs";

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

/** Per-asset "use reel product references" toggle (spec: per image, not global). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const { prompt_id, use_product_refs } = body as { prompt_id?: string; use_product_refs?: boolean };
  if (!prompt_id || typeof use_product_refs !== "boolean") {
    return NextResponse.json({ error: "prompt_id and use_product_refs are required" }, { status: 400 });
  }
  const ctx = await buildStageContext(reelId);
  try {
    await setUseProductRefs(ctx.supa, prompt_id, use_product_refs);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
