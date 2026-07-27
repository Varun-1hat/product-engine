/**
 * Stage 1 (config) — get/update a single client (brand kit, provider keys,
 * products, avatar pull). Thin: delegates to src/stages/config.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildConfigContext } from "@/src/lib/context";
import { configInputSchema, loadConfig, processConfig } from "@/src/stages/config";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const ctx = buildConfigContext(clientId);
  const result = await loadConfig(ctx);
  if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(result);
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
