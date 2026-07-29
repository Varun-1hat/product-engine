/**
 * Stage 4 (image) — load current image slots / generate capability-driven
 * start & end images. Thin: delegates to src/stages/image (reference
 * implementation for two-granularity review).
 *
 * GET is enriched beyond the bare `load()` snapshot with everything the
 * reference review page (app/(app)/reels/[reelId]/image) needs to render
 * without a live authenticated Supabase browser session (no login/RLS
 * session exists yet — see .pipeline/changes.md "Known gaps"): a signed
 * preview URL, version history, and the associated prompt, per slot. This
 * is read-only enrichment, not stage business logic — process()/estimate()
 * below still delegate straight to src/stages/image.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { imageStage } from "@/src/stages/image";
import { assetHistory, getAsset, getCurrentPromptVersion, promptHistory } from "@/src/lib/versioning";
import { getProductsWithPhotos } from "@/src/lib/brandContext";
import type { StageContext } from "@/src/stages/types";
import type { SceneRow } from "@/src/lib/db/types";

interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
}

interface SlotDetail {
  asset_id: string;
  media_type: string;
  shared: boolean;
  current_version_id: string | null;
  current_version_no: number;
  preview_url: string | null;
  history: VersionSummary[];
  prompt: {
    id: string;
    text: string;
    version_no: number;
    history: VersionSummary[];
    /** Product photos attached to this prompt as generation references. */
    reference_paths: string[];
  } | null;
}

/** A product photo the user can attach to any image prompt as a reference. */
interface ProductPhotoOption {
  path: string;
  url: string | null;
  product_name: string;
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
    reference_paths: current.reference_paths ?? [],
  };
}

/**
 * Every product photo on this client, with a signed preview URL — the pool
 * the page offers for attaching to a prompt. Paths are `products`-bucket
 * paths, which is exactly what generateAndPersistImage downloads references
 * from, so an attached path flows straight through to the provider call.
 */
async function productPhotoOptions(ctx: StageContext): Promise<ProductPhotoOption[]> {
  const products = await getProductsWithPhotos(ctx.supa, ctx.clientId);
  const options: ProductPhotoOption[] = [];
  for (const product of products) {
    for (const path of product.photo_paths) {
      const url = await ctx.storage.signedUrl("products", path).catch(() => null);
      options.push({ path, url, product_name: product.name });
    }
  }
  return options;
}

/**
 * A scene's start/end image prompt, looked up by (scene, kind) rather than
 * via the asset, so it's available for editing BEFORE the image exists —
 * see the `prompts` map in GET below.
 */
async function scenePrompt(ctx: StageContext, sceneId: string, kind: "image_start" | "image_end"): Promise<PromptDetail | null> {
  const { data } = await ctx.supa.from("prompts").select("id").eq("scene_id", sceneId).eq("kind", kind).maybeSingle();
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
    media_type: asset.media_type,
    shared: asset.shared,
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
  const state = await imageStage.load(ctx);
  const scenes = (state.data as { scenes: SceneRow[] }).scenes;

  const slots: Record<string, { start?: SlotDetail; end?: SlotDetail }> = {};
  const prompts: Record<string, { start: PromptDetail | null; end: PromptDetail | null }> = {};
  for (const scene of scenes) {
    const entry: { start?: SlotDetail; end?: SlotDetail } = {};
    if (scene.start_image_id) entry.start = await buildSlotDetail(ctx, scene.start_image_id);
    if (scene.end_image_id) entry.end = await buildSlotDetail(ctx, scene.end_image_id);
    if (entry.start || entry.end) slots[scene.id] = entry;
    prompts[scene.id] = {
      start: await scenePrompt(ctx, scene.id, "image_start"),
      end: await scenePrompt(ctx, scene.id, "image_end"),
    };
  }

  const estimate = await imageStage.estimate!({}, ctx);
  const product_photos = await productPhotoOptions(ctx);

  return NextResponse.json({ scenes, slots, prompts, product_photos, estimate });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = imageStage.inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const result = await imageStage.process(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
