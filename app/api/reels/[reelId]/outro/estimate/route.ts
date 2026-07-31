/**
 * Stage 7 (outro) cost estimate — $0 if the deterministic crossfade route
 * applies, else the effective outro model's per-unit rate. No provider
 * call. Thin: delegates to src/stages/outro.estimate.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { outroStage } from "@/src/stages/outro";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const estimate = await outroStage.estimate!({}, ctx);
  return NextResponse.json(estimate);
}
