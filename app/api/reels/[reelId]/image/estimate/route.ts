/**
 * Stage 4 (image) cost estimate — count(distinct image slots) x $0.039,
 * no provider call. Thin: delegates to src/stages/image.estimate.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { imageStage } from "@/src/stages/image";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const estimate = await imageStage.estimate!({}, ctx);
  return NextResponse.json(estimate);
}
