/**
 * Stage 1 (config) — get/update a single client (brand kit, provider keys,
 * products, avatar pull). Thin: delegates to src/stages/config.
 *
 * GET is enriched beyond loadConfig()'s bare snapshot with a signed URL for
 * the brand logo (spec §7.5 — ConfigBrandTab needs a renderable URL, not the
 * bare private "brand" bucket path `client_config.logo_path` holds). This is
 * read-only enrichment done here in the route handler (mirrors
 * app/api/reels/[reelId]/image/route.ts's pattern) rather than in
 * src/stages/config/index.ts, which this wave doesn't touch. PATCH is
 * unchanged — still delegates straight to processConfig.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildConfigContext } from "@/src/lib/context";
import { configInputSchema, loadConfig, processConfig } from "@/src/stages/config";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const ctx = buildConfigContext(clientId);
  const result = await loadConfig(ctx);
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });

  let logo_url: string | null = null;
  if (result.client_config.logo_path) {
    logo_url = await ctx.storage.signedUrl("brand", result.client_config.logo_path);
  }

  return NextResponse.json({ ...result, logo_url });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = configInputSchema.safeParse({ ...body, client_id: clientId });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = buildConfigContext(clientId);
  try {
    const result = await processConfig(ctx, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
