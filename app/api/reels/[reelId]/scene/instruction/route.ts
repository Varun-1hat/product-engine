/**
 * Stage 3 (scene) — rewrite scene-brain's own instruction for this reel. Thin:
 * delegates to src/stages/scene's regenerateScenePrompt().
 *
 * Separate from ../route.ts, which saves the instruction the USER typed. This
 * one writes a fresh instruction with the scene-instruction skill and persists
 * it, the same split as Stage 8's ../music/prompt (draft with AI) versus the
 * stage POST (save what was typed). Costs orchestrator tokens only; it
 * generates nothing and leaves every existing scene untouched — it changes how
 * the NEXT scene-brain run will write them.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { regenerateScenePrompt } from "@/src/stages/scene";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  try {
    return NextResponse.json(await regenerateScenePrompt(ctx));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
