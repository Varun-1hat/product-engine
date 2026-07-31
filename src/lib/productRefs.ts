/**
 * The reel's product reference photos (Stage 2, reel_config.product_reference_paths)
 * as the default reference set for every gen-AI call.
 *
 * reel_config stays the source of truth — nothing is copied into a stage;
 * these paths are read fresh at generate time and merged behind whatever
 * stage-level references the prompt already carries, so the per-adapter
 * image-count cap drops the reel defaults before the user's own uploads.
 */
import type { ServiceClient } from "./supabase/service";
import type { ReelConfigRow } from "./db/types";

/** Empty when the reel has none, or when this one image/clip has opted out. */
export async function productRefPaths(
  supa: ServiceClient,
  reelConfig: ReelConfigRow,
  promptId: string
): Promise<string[]> {
  const paths = reelConfig.product_reference_paths ?? [];
  if (paths.length === 0) return [];

  const { data, error } = await supa.from("prompts").select("use_product_refs").eq("id", promptId).maybeSingle();
  if (error) throw new Error(`prompts lookup (use_product_refs) failed: ${error.message}`);
  return (data as { use_product_refs: boolean } | null)?.use_product_refs === false ? [] : paths;
}

/** Per-asset opt-out toggle — affects only this one image/clip. */
export async function setUseProductRefs(supa: ServiceClient, promptId: string, enabled: boolean): Promise<void> {
  const { error } = await supa.from("prompts").update({ use_product_refs: enabled }).eq("id", promptId);
  if (error) throw new Error(`prompts update (use_product_refs) failed: ${error.message}`);
}
