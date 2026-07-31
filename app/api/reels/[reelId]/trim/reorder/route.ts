/**
 * Stage 6 (trim) reorder — plain scenes.position update, human-managed, no
 * enforcement (brief §10.6). Thin: delegates to src/stages/trim.reorderScenes.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildStageContext } from "@/src/lib/context";
import { reorderScenes } from "@/src/stages/trim";

const reorderSchema = z.object({ scene_ids: z.array(z.string().uuid()).min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const scenes = await reorderScenes(ctx, parsed.data.scene_ids);
    return NextResponse.json({ scenes });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
