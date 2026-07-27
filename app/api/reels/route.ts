/**
 * Stage 2 (reel-setup) — create a new reel. Thin: delegates to
 * src/stages/reel-setup.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildReelSetupContext } from "@/src/lib/context";
import { reelSetupInputSchema, processReelSetup } from "@/src/stages/reel-setup";

const createReelSchema = reelSetupInputSchema.and(z.object({ client_id: z.string().uuid() }));

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = createReelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const { client_id, ...input } = parsed.data;
  const ctx = await buildReelSetupContext(client_id);
  try {
    const result = await processReelSetup(ctx, input);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
