/**
 * Stage 7 (outro) — branded end-frame (default render / custom upload /
 * return-to-default) + outro clip (model route or deterministic
 * crossfade). Thin: delegates to src/stages/outro.
 *
 * GET is enriched beyond the bare `load()` snapshot (`{ reelConfig }`) with
 * everything the Outro page (app/(app)/reels/[reelId]/outro, spec §7.3)
 * needs to render its two AssetReview/PromptReview slots without a live
 * authenticated Supabase browser session: a signed preview URL, version
 * history, and the associated prompt, per slot — mirrors
 * app/api/reels/[reelId]/image/route.ts's buildSlotDetail. This is
 * read-only enrichment, not stage business logic — process() below still
 * delegates straight to src/stages/outro.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { outroStage } from "@/src/stages/outro";
import { reconcilePendingJobs } from "@/src/lib/jobs/run";
import { assetHistory, getAsset, getCurrentPromptVersion, promptHistory } from "@/src/lib/versioning";
import type { StageContext } from "@/src/stages/types";
import type { ReelConfigRow } from "@/src/lib/db/types";

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface SlotDetail {
  asset_id: string;
  media_type: string;
  current_version_id: string | null;
  current_version_no: number;
  preview_url: string | null;
  history: VersionSummary[];
  prompt: { id: string; text: string; version_no: number; history: VersionSummary[] } | null;
}

async function buildSlotDetail(ctx: StageContext, assetId: string): Promise<SlotDetail> {
  const asset = await getAsset(ctx.supa, assetId);
  const versions = await assetHistory(ctx.supa, assetId);
  const currentVersion = versions.find((v) => v.id === asset.current_version_id) ?? null;

  let previewUrl: string | null = null;
  if (currentVersion?.storage_path) {
    previewUrl = await ctx.storage.signedUrl("assets", currentVersion.storage_path);
  }

  const { data: promptRow } = await ctx.supa.from("prompts").select("id").eq("asset_id", assetId).maybeSingle();
  let prompt: SlotDetail["prompt"] = null;
  if (promptRow) {
    const promptId = (promptRow as { id: string }).id;
    const [current, history] = await Promise.all([getCurrentPromptVersion(ctx.supa, promptId), promptHistory(ctx.supa, promptId)]);
    if (current) {
      prompt = {
        id: promptId,
        text: current.text,
        version_no: current.version_no,
        history: history.map((h) => ({ id: h.id, version_no: h.version_no, created_at: h.created_at })),
      };
    }
  }

  return {
    asset_id: asset.id,
    media_type: asset.media_type,
    current_version_id: asset.current_version_id,
    current_version_no: currentVersion?.version_no ?? 0,
    preview_url: previewUrl,
    history: versions.map((v) => ({ id: v.id, version_no: v.version_no, created_at: v.created_at })),
    prompt,
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  // Finish any provider generations that completed since the last read
  // (src/lib/jobs/run.ts) — this is what advances an awaiting_provider outro
  // clip now that there's no standing poller. Never throws.
  await reconcilePendingJobs(ctx);
  const state = await outroStage.load(ctx);
  const reelConfig = (state.data as { reelConfig: ReelConfigRow }).reelConfig;

  // Slot 1 — end-frame image (no prompt: it's a deterministic satori/resvg render, never
  // AI-prompted, so buildSlotDetail's prompt lookup naturally resolves to null for it).
  const slots: { end_frame?: SlotDetail; outro_clip?: SlotDetail } = {};
  if (reelConfig.end_frame_asset_id) {
    slots.end_frame = await buildSlotDetail(ctx, reelConfig.end_frame_asset_id);
  }

  // Slot 2 — outro clip. Looked up read-only by (reel_id, slot) rather than via
  // ensureOutroClipAsset (which inserts a row) — GET must not have side effects.
  const { data: outroClipAsset } = await ctx.supa
    .from("assets")
    .select("id")
    .eq("reel_id", reelId)
    .eq("slot", "outro_clip")
    .maybeSingle();
  if (outroClipAsset) {
    slots.outro_clip = await buildSlotDetail(ctx, (outroClipAsset as { id: string }).id);
  }

  // Outro motion prompt, looked up by (reel, kind) rather than via the clip
  // asset, so it's available for editing BEFORE the clip is generated.
  let outroPrompt: SlotDetail["prompt"] = null;
  const { data: outroPromptRow } = await ctx.supa
    .from("prompts")
    .select("id")
    .eq("reel_id", reelId)
    .eq("kind", "outro_motion")
    .maybeSingle();
  if (outroPromptRow) {
    const promptId = (outroPromptRow as { id: string }).id;
    const [current, history] = await Promise.all([getCurrentPromptVersion(ctx.supa, promptId), promptHistory(ctx.supa, promptId)]);
    if (current) {
      outroPrompt = {
        id: promptId,
        text: current.text,
        version_no: current.version_no,
        history: history.map((h) => ({ id: h.id, version_no: h.version_no, created_at: h.created_at })),
      };
    }
  }

  return NextResponse.json({ stage: "outro", data: { reel_config: reelConfig }, slots, prompt: outroPrompt });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = outroStage.inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const result = await outroStage.process(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
