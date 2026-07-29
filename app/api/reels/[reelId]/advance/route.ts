/**
 * Advances a reel's current_stage forward (spec §2.7). Every per-reel stage
 * module already implements advance(ctx): Promise<StageId>
 * (src/stages/types.ts) but nothing called it before this route existed —
 * the "Next" control in app/(app)/reels/[reelId]/layout.tsx is the only
 * caller. reel_setup has no StageModule/advance() (src/stages/reel-setup is
 * shaped differently — see that file) and is never a reel's current_stage
 * once it exists (processReelSetup creates every reel with
 * current_stage: "scene"), so it's intentionally absent from STAGE_MODULES.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext, getReel } from "@/src/lib/context";
import { sceneStage } from "@/src/stages/scene";
import { imageStage } from "@/src/stages/image";
import { clipStage } from "@/src/stages/clip";
import { trimStage } from "@/src/stages/trim";
import { outroStage } from "@/src/stages/outro";
import { musicStage } from "@/src/stages/music";
import { assemblyStage } from "@/src/stages/assembly";
import type { StageContext } from "@/src/stages/types";
import type { StageId } from "@/src/lib/db/enums";

const STAGE_MODULES: Record<string, { advance(ctx: StageContext): Promise<StageId> }> = {
  scene: sceneStage,
  image: imageStage,
  clip: clipStage,
  trim: trimStage,
  outro: outroStage,
  music: musicStage,
  assembly: assemblyStage,
};

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;

  // buildStageContext() doesn't carry current_stage on StageContext itself
  // (it only needs client_id off the reel row to build the context), so
  // fetch the reel row separately to know which module's advance() to call.
  const reel = await getReel(reelId);
  const mod = STAGE_MODULES[reel.current_stage];
  if (!mod) {
    return NextResponse.json(
      { error: `no stage module for current_stage "${reel.current_stage}"` },
      { status: 400 }
    );
  }

  const ctx = await buildStageContext(reelId);
  try {
    const current_stage = await mod.advance(ctx);
    return NextResponse.json({ current_stage });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
