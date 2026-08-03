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

/*
 * No PATCH ("use reel product references") counterpart to ../../clip/prompts
 * here, deliberately: the outro clip can't take reference images. Every model
 * resolveOutroRoute can pick declares accepted_inputs of prompt + start_image
 * + end_image and max_reference_images 2 (src/adapters/video_broll/
 * veoCapabilities.ts, higgsfield.ts) — a budget the last scene's end frame and
 * the branded end card consume in full. src/lib/jobs/outro.ts's runModelRoute
 * therefore reads only the prompt text. A toggle here would be inert.
 */
