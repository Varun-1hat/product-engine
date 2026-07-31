/**
 * Stage 8 (music) revert — POST { version_no } to make an earlier generated/
 * uploaded track current again. Thin: delegates to src/stages/music's
 * revertMusic(), the audio equivalent of the image/clip 'revertAsset' review
 * action.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildStageContext } from "@/src/lib/context";
import { revertMusic } from "@/src/stages/music";

const bodySchema = z.object({ version_no: z.number().int().positive() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    return NextResponse.json(await revertMusic(ctx, parsed.data.version_no));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
