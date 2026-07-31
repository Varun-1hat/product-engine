/**
 * Stage 8 (music) prompt drafting — POST to write the music prompt from the
 * reel brief with the music-prompt skill, optimised for the selected music
 * model. Thin: delegates to src/stages/music's ensureMusicPrompt().
 *
 * `force: true` is the review UI's "re-optimise for <model>" action, used after
 * the music provider changed; without it an existing prompt is left alone so a
 * hand-edited one is never clobbered.
 *
 * Generation itself stays in ../generate/route.ts — drafting the prompt costs
 * only orchestrator tokens, so it is intentionally a separate, cheap call the
 * user can make before committing to a paid music generation.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildStageContext } from "@/src/lib/context";
import { ensureMusicPrompt } from "@/src/stages/music";

const inputSchema = z.object({ force: z.boolean().optional() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const reelConfig = await ensureMusicPrompt(ctx, { force: parsed.data.force });
    return NextResponse.json({ reel_config: reelConfig });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
