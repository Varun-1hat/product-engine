/**
 * Stage 9 (assembly) — build the deterministic AssemblyPlan and enqueue the
 * ffmpeg job (worker/assembly.ts). Thin: delegates to src/stages/assembly.
 * Re-POSTing re-assembles -> a new final_render asset_version.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/src/lib/supabase/service";
import { buildStageContext } from "@/src/lib/context";
import { assemblyStage } from "@/src/stages/assembly";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const state = await assemblyStage.load(ctx);

  const supa = createServiceClient();
  const { data: finalAsset } = await supa
    .from("assets")
    .select("*, current_version:asset_versions!assets_current_version_id_fkey(*)")
    .eq("reel_id", reelId)
    .eq("slot", "final_render")
    .maybeSingle();

  return NextResponse.json({ ...state, final_render: finalAsset ?? null });
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  try {
    const result = await assemblyStage.process({}, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
