/**
 * Avatar rename/remove (spec §8.2). Thin: delegates to
 * src/stages/config/avatars.ts (kept out of src/stages/config/index.ts so
 * this section never touches a file Wave D4's concurrent Config work might
 * also be editing).
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/src/lib/supabase/service";
import { renameAvatarInputSchema, renameAvatar, removeAvatar } from "@/src/stages/config/avatars";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; avatarId: string }> }
) {
  const { clientId, avatarId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = renameAvatarInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const supa = createServiceClient();
  try {
    const avatar = await renameAvatar(supa, clientId, avatarId, parsed.data.name);
    return NextResponse.json({ avatar });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string; avatarId: string }> }
) {
  const { clientId, avatarId } = await params;
  const supa = createServiceClient();
  try {
    await removeAvatar(supa, clientId, avatarId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
