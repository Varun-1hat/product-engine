/**
 * Dashboard support route: reels for a client + spent-so-far per reel
 * (spec §4 costEngine.spentSoFar — actuals only, spent-so-far, never a
 * projection).
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/src/lib/supabase/service";
import { createCostEngine } from "@/src/lib/cost/engine";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supa = createServiceClient();
  const { data: reels, error } = await supa
    .from("reels")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const costEngine = createCostEngine(supa);
  const withSpend = await Promise.all(
    ((reels ?? []) as Array<{ id: string }>).map(async (reel) => ({
      ...reel,
      spent: await costEngine.spentSoFar(reel.id),
    }))
  );

  return NextResponse.json({ reels: withSpend });
}
