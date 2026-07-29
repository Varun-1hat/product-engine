/**
 * Stage 8 (music) — manual upload only (brief §11). Thin: delegates to
 * src/stages/music. The actual file upload lands in the `music/` bucket via
 * app/api/clients/[clientId]/uploads (spec §7.1, kind="music") before
 * calling this with the resulting storage path.
 *
 * GET is enriched beyond the bare `load()` snapshot with a signed URL for
 * the current track (spec §7.4's `<audio>` preview needs a renderable URL,
 * not the bare private-bucket path) — read-only enrichment, mirrors
 * app/api/reels/[reelId]/image/route.ts's pattern. process() below still
 * delegates straight to src/stages/music.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { musicStage, musicHistory } from "@/src/stages/music";
import type { ReelConfigRow } from "@/src/lib/db/types";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const state = await musicStage.load(ctx);
  const reelConfig = (state.data as { reel_config: ReelConfigRow }).reel_config;

  let music_url: string | null = null;
  if (reelConfig.music_path) {
    music_url = await ctx.storage.signedUrl("music", reelConfig.music_path);
  }

  // Version history for the music slot (same model as images/clips), each with
  // a signed URL so every past take is playable, not just the current one.
  const history = await musicHistory(ctx);
  const versions = await Promise.all(
    history.map(async (v) => ({
      version_no: v.version_no,
      source: v.source,
      provider: v.provider,
      created_at: v.created_at,
      is_current: v.storage_path === reelConfig.music_path,
      url: v.storage_path ? await ctx.storage.signedUrl("music", v.storage_path) : null,
    }))
  );

  return NextResponse.json({ ...state, music_url, versions });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = musicStage.inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildStageContext(reelId);
  try {
    const result = await musicStage.process(parsed.data, ctx);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
