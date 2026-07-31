/**
 * Stage 6 (trim) — enqueue a trim job for one asset ({asset_id, start_s,
 * end_s}). Thin: delegates to src/stages/trim. Human-managed reorder lives
 * at ./reorder/route.ts.
 *
 * GET is enriched beyond the bare `load()` snapshot the same way
 * app/api/reels/[reelId]/image/route.ts enriches its slots (spec §4/§5.1's
 * reference pattern): a signed preview URL + version history per scene, so
 * the trim review page (app/(app)/reels/[reelId]/trim) can render without a
 * live authenticated Supabase browser session. Trim has no asset kind of
 * its own — it appends `derived` versions to the same clip asset Stage 5
 * (clip) created (scenes.clip_asset_id) — so this keys slots off that
 * column instead of a trim-specific one, and (unlike image's slots) also
 * surfaces `duration_s` off the current version's metadata, since the trim
 * page needs it to bound its start_s/end_s sliders (src/lib/jobs/trim.ts persists
 * metadata.duration_s on every version, trimmed or not) and there's no
 * other route that exposes it. No `prompt` field — trim has none.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { trimStage, computeTrimHints } from "@/src/stages/trim";
import { reconcilePendingJobs } from "@/src/lib/jobs/run";
import { assetHistory, getAsset } from "@/src/lib/versioning";
import type { StageContext } from "@/src/stages/types";
import type { SceneRow } from "@/src/lib/db/types";

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface TrimSlotDetail {
  asset_id: string;
  media_type: string;
  current_version_id: string | null;
  current_version_no: number;
  duration_s: number | null;
  preview_url: string | null;
  history: VersionSummary[];
}

async function buildTrimSlotDetail(ctx: StageContext, assetId: string): Promise<TrimSlotDetail> {
  const asset = await getAsset(ctx.supa, assetId);
  const versions = await assetHistory(ctx.supa, assetId);
  const currentVersion = versions.find((v) => v.id === asset.current_version_id) ?? null;

  let previewUrl: string | null = null;
  if (currentVersion?.storage_path) {
    previewUrl = await ctx.storage.signedUrl("assets", currentVersion.storage_path);
  }

  return {
    asset_id: asset.id,
    media_type: asset.media_type,
    current_version_id: asset.current_version_id,
    current_version_no: currentVersion?.version_no ?? 0,
    duration_s: currentVersion?.metadata?.duration_s ?? null,
    preview_url: previewUrl,
    history: versions.map((v) => ({ id: v.id, version_no: v.version_no, created_at: v.created_at })),
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  // Stage 5 clips may still be awaiting_provider — finish any the provider
  // has completed before reading them (src/lib/jobs/run.ts). Never throws.
  await reconcilePendingJobs(ctx);
  const [state, hints] = await Promise.all([trimStage.load(ctx), computeTrimHints(ctx)]);
  const scenes = (state.data as { scenes: SceneRow[] }).scenes;

  const slots: Record<string, TrimSlotDetail> = {};
  for (const scene of scenes) {
    if (scene.clip_asset_id) {
      slots[scene.id] = await buildTrimSlotDetail(ctx, scene.clip_asset_id);
    }
  }

  return NextResponse.json({ ...state, hints, slots });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = trimStage.inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const result = await trimStage.process(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
