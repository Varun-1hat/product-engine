/**
 * Stage 3 (scene) — re-roll ONE scene's description. Thin: delegates to
 * src/stages/scene's regenerateSceneDescription().
 *
 * Separate from ../route.ts on purpose. That endpoint owns the
 * save-vs-regenerate contract for the whole scene list (and a regression test
 * pins it, because an ambiguous extra path there once discarded user edits);
 * this one rewrites a single row's description and can never delete a scene.
 * Same split as Stage 8's ../music/prompt vs ../music/generate: drafting text
 * costs only orchestrator tokens, so it stays a cheap call the user can repeat
 * before committing to any paid generation.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildStageContext } from "@/src/lib/context";
import { regenerateSceneDescription } from "@/src/stages/scene";

const inputSchema = z.object({ scene_id: z.string().uuid() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const scene = await regenerateSceneDescription(ctx, parsed.data.scene_id);
    return NextResponse.json({ scene });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
