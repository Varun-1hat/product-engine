/**
 * Stage 8 (music) generation — POST to generate/regenerate the reel's track
 * from its (editable) prompt. Thin: delegates to src/stages/music's
 * generate(). The upload override still goes to ../route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { generate, musicGenerateInputSchema } from "@/src/stages/music";

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = musicGenerateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    return NextResponse.json(await generate(parsed.data, ctx));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
