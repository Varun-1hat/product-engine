/**
 * Stage 1 (config) — list/create clients. Thin: delegates to
 * src/stages/config. See that module for clone/brand-kit/provider-key
 * semantics.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/src/lib/supabase/service";
import { buildConfigContext } from "@/src/lib/context";
import { configInputSchema, processConfig } from "@/src/stages/config";

export async function GET() {
  const supa = createServiceClient();
  const { data, error } = await supa.from("clients").select("*").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clients: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = configInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const ctx = buildConfigContext(parsed.data.client_id ?? "");
  try {
    const result = await processConfig(ctx, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
