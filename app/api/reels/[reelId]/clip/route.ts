/**
 * Stage 5 (clip) — load current clips / generate clips for scenes not yet
 * materialized (routes by scene.type internally). Thin: delegates to
 * src/stages/clip. Async — process() returns immediately once each scene's
 * generate() call has been dispatched and its job marked awaiting_provider.
 *
 * GET is enriched beyond the bare `load()` snapshot (spec §5.1) the same
 * way app/api/reels/[reelId]/image/route.ts enriches Image's GET: a signed
 * preview URL, version history, and the associated prompt, per slot — via
 * the same buildSlotDetail-shaped helper/versioning calls that file uses.
 * Simpler than Image's enrichment though, since Clip has exactly **one**
 * clip asset + one motion/shot prompt per scene (no start/end pair, no
 * `shared` boundary-frame concept). This is read-only enrichment, not
 * stage business logic — process() below still delegates straight to
 * src/stages/clip, and the top-level `{ stage, data: { scenes } }` shape
 * from the bare load() snapshot is preserved (unlike image/route.ts, which
 * flattens it) since spec §5.1 spells out that exact response shape.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { clipStage } from "@/src/stages/clip";
import { assetHistory, getAsset, getCurrentPromptVersion, promptHistory } from "@/src/lib/versioning";
import type { StageContext } from "@/src/stages/types";
import type { SceneRow } from "@/src/lib/db/types";

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface SlotDetail {
  asset_id: string;
  media_type: "video";
  current_version_id: string | null;
  current_version_no: number;
  preview_url: string | null;
  history: VersionSummary[];
  prompt: { id: string; text: string; version_no: number; history: VersionSummary[] } | null;
}

type PromptDetail = NonNullable<SlotDetail["prompt"]>;

async function buildPromptDetail(ctx: StageContext, promptId: string): Promise<PromptDetail | null> {
  const [current, history] = await Promise.all([getCurrentPromptVersion(ctx.supa, promptId), promptHistory(ctx.supa, promptId)]);
  if (!current) return null;
  return {
    id: promptId,
    text: current.text,
    version_no: current.version_no,
    history: history.map((h) => ({ id: h.id, version_no: h.version_no, created_at: h.created_at })),
  };
}

/**
 * The scene's motion/shot prompt, looked up by scene (not by asset) so it's
 * available for editing BEFORE the clip asset exists — see the `prompts`
 * map in GET below.
 */
async function sceneMotionPrompt(ctx: StageContext, sceneId: string): Promise<PromptDetail | null> {
  const { data } = await ctx.supa
    .from("prompts")
    .select("id")
    .eq("scene_id", sceneId)
    .in("kind", ["broll_motion", "avatar_shot"])
    .maybeSingle();
  return data ? buildPromptDetail(ctx, (data as { id: string }).id) : null;
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
  const prompt = promptRow ? await buildPromptDetail(ctx, (promptRow as { id: string }).id) : null;

  return {
    asset_id: asset.id,
    media_type: "video",
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
  const state = await clipStage.load(ctx);
  const scenes = (state.data as { scenes: SceneRow[] }).scenes;

  const slots: Record<string, SlotDetail | undefined> = {};
  const prompts: Record<string, PromptDetail | null> = {};
  for (const scene of scenes) {
    if (scene.clip_asset_id) slots[scene.id] = await buildSlotDetail(ctx, scene.clip_asset_id);
    prompts[scene.id] = await sceneMotionPrompt(ctx, scene.id);
  }

  const estimate = await clipStage.estimate!({}, ctx);

  return NextResponse.json({ stage: "clip", data: { scenes }, slots, prompts, estimate });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = clipStage.inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const result = await clipStage.process(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
