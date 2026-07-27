/**
 * Stage 2 (reel-setup) — get/edit an existing reel's setup. Thin:
 * delegates to src/stages/reel-setup.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/src/lib/supabase/service";
import { buildReelSetupContext } from "@/src/lib/context";
import { reelSetupInputSchema, processReelSetup, loadReelSetup } from "@/src/stages/reel-setup";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const supa = createServiceClient();
  const { data: reel, error } = await supa.from("reels").select("*").eq("id", reelId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!reel) return NextResponse.json({ error: "not found" }, { status: 404 });

  const ctx = await buildReelSetupContext((reel as { client_id: string }).client_id, reelId);
  const setup = await loadReelSetup(ctx);
  return NextResponse.json({ reel, ...setup });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const supa = createServiceClient();
  const { data: reel, error } = await supa.from("reels").select("client_id").eq("id", reelId).single();
  if (error) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = reelSetupInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = await buildReelSetupContext((reel as { client_id: string }).client_id, reelId);
  try {
    const result = await processReelSetup(ctx, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
