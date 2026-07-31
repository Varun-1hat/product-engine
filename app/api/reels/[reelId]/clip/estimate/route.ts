/**
 * Stage 5 (clip) cost estimate — per-scene by effective model (HeyGen
 * $7/video flat, Veo per-second by variant, Higgsfield credit), no
 * provider call. Thin: delegates to src/stages/clip.estimate.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { clipStage } from "@/src/stages/clip";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const estimate = await clipStage.estimate!({}, ctx);
  return NextResponse.json(estimate);
}
