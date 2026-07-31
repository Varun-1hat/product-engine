/**
 * Avatar rename/remove (spec §8.2). Deliberately a separate file from
 * src/stages/config/index.ts — kept out of that shared module so this
 * section never touches a file Wave D4's concurrent Config work (brand
 * kit/keys) might also be editing. Mirrors that file's plain
 * ServiceClient-scoped upsert/delete convention exactly (read it for the
 * pattern; not imported from here).
 *
 * Both operations are simple single-row mutations scoped by client_id + id
 * — no cascading concerns to handle here: `reel_config.avatar_look_id`
 * already carries `on delete set null` (supabase/migrations/0001_init.sql),
 * so removing an avatar that's referenced by an existing reel's config is
 * handled entirely by the DB's own FK constraint, not application code.
 */
import { z } from "zod";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { AvatarRow } from "@/src/lib/db/types";

export const renameAvatarInputSchema = z.object({ name: z.string().min(1) });
export type RenameAvatarInput = z.infer<typeof renameAvatarInputSchema>;

export async function renameAvatar(
  supa: ServiceClient,
  clientId: string,
  avatarId: string,
  name: string
): Promise<AvatarRow> {
  const { data, error } = await supa
    .from("avatars")
    .update({ name })
    .eq("id", avatarId)
    .eq("client_id", clientId)
    .select("*")
    .single();
  if (error) throw new Error(`avatars rename failed: ${error.message}`);
  return data as AvatarRow;
}

export async function removeAvatar(supa: ServiceClient, clientId: string, avatarId: string): Promise<void> {
  const { error } = await supa.from("avatars").delete().eq("id", avatarId).eq("client_id", clientId);
  if (error) throw new Error(`avatars remove failed: ${error.message}`);
}
