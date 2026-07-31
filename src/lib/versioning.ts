/**
 * Shared prompt/asset version bookkeeping (spec §2.4): a slot is one
 * `assets` row; redo/edit inserts a new immutable version and re-points
 * `current_version_id`; revert re-points to a prior version; nothing is
 * ever destroyed. src/stages/image is the reference implementation for
 * this pattern (spec §6) — src/stages/clip and src/stages/outro reuse
 * these same helpers rather than re-deriving the bookkeeping.
 */
import type { ServiceClient } from "./supabase/service";
import type { MediaType, PromptKind, PromptSource, Provider, Slot, VersionSource } from "./db/enums";
import type { AssetRow, AssetVersion, AssetVersionMetadata, PromptRow, PromptVersion } from "./db/types";

export interface UpsertPromptVersionInput {
  reel_id: string;
  scene_id?: string | null;
  asset_id?: string | null;
  kind: PromptKind;
  text: string;
  reference_paths?: string[] | null;
  source: PromptSource;
  metadata?: Record<string, unknown> | null;
  /** Append a version to this existing prompt; omit to create a new prompt row. */
  promptId?: string;
}

export async function upsertPromptVersion(
  supa: ServiceClient,
  input: UpsertPromptVersionInput
): Promise<{ prompt: PromptRow; version: PromptVersion }> {
  let prompt: PromptRow;

  if (input.promptId) {
    const { data, error } = await supa.from("prompts").select("*").eq("id", input.promptId).single();
    if (error) throw new Error(`prompts lookup failed: ${error.message}`);
    prompt = data as PromptRow;
  } else {
    const { data, error } = await supa
      .from("prompts")
      .insert({
        reel_id: input.reel_id,
        scene_id: input.scene_id ?? null,
        asset_id: input.asset_id ?? null,
        kind: input.kind,
      })
      .select("*")
      .single();
    if (error) throw new Error(`prompts insert failed: ${error.message}`);
    prompt = data as PromptRow;
  }

  const { data: maxRow, error: maxError } = await supa
    .from("prompt_versions")
    .select("version_no")
    .eq("prompt_id", prompt.id)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxError) throw new Error(`prompt_versions lookup failed: ${maxError.message}`);
  const nextVersionNo = ((maxRow as { version_no: number } | null)?.version_no ?? 0) + 1;

  const { data: versionData, error: versionError } = await supa
    .from("prompt_versions")
    .insert({
      prompt_id: prompt.id,
      version_no: nextVersionNo,
      text: input.text,
      reference_paths: input.reference_paths ?? null,
      source: input.source,
      metadata: input.metadata ?? null,
    })
    .select("*")
    .single();
  if (versionError) throw new Error(`prompt_versions insert failed: ${versionError.message}`);
  const version = versionData as PromptVersion;

  const { error: updateError } = await supa
    .from("prompts")
    .update({ current_version_id: version.id })
    .eq("id", prompt.id);
  if (updateError) throw new Error(`prompts update failed: ${updateError.message}`);

  return { prompt: { ...prompt, current_version_id: version.id }, version };
}

export async function revertPromptVersion(supa: ServiceClient, promptId: string, versionNo: number): Promise<void> {
  const { data, error } = await supa
    .from("prompt_versions")
    .select("id")
    .eq("prompt_id", promptId)
    .eq("version_no", versionNo)
    .single();
  if (error) throw new Error(`prompt_versions lookup failed: ${error.message}`);

  const { error: updateError } = await supa
    .from("prompts")
    .update({ current_version_id: (data as { id: string }).id })
    .eq("id", promptId);
  if (updateError) throw new Error(`prompts revert failed: ${updateError.message}`);
}

export async function promptHistory(supa: ServiceClient, promptId: string): Promise<PromptVersion[]> {
  const { data, error } = await supa
    .from("prompt_versions")
    .select("*")
    .eq("prompt_id", promptId)
    .order("version_no", { ascending: false });
  if (error) throw new Error(`prompt_versions history failed: ${error.message}`);
  return (data ?? []) as PromptVersion[];
}

export interface UpsertAssetVersionInput {
  reel_id: string;
  scene_id?: string | null;
  slot: Slot;
  media_type: MediaType;
  shared?: boolean;
  storage_path: string | null;
  source: VersionSource;
  prompt_version_id?: string | null;
  provider?: Provider | null;
  provider_asset_id?: string | null;
  metadata?: AssetVersionMetadata;
  units?: number | null;
  unit_type?: string | null;
  cost_log_id?: string | null;
  created_by?: string | null;
  /** Append a version to this existing asset; omit to create a new asset row. */
  assetId?: string;
}

export async function upsertAssetVersion(
  supa: ServiceClient,
  input: UpsertAssetVersionInput
): Promise<{ asset: AssetRow; version: AssetVersion }> {
  let asset: AssetRow;

  if (input.assetId) {
    const { data, error } = await supa.from("assets").select("*").eq("id", input.assetId).single();
    if (error) throw new Error(`assets lookup failed: ${error.message}`);
    asset = data as AssetRow;
  } else {
    const { data, error } = await supa
      .from("assets")
      .insert({
        reel_id: input.reel_id,
        scene_id: input.scene_id ?? null,
        slot: input.slot,
        media_type: input.media_type,
        shared: input.shared ?? false,
      })
      .select("*")
      .single();
    if (error) throw new Error(`assets insert failed: ${error.message}`);
    asset = data as AssetRow;
  }

  const { data: maxRow, error: maxError } = await supa
    .from("asset_versions")
    .select("version_no")
    .eq("asset_id", asset.id)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (maxError) throw new Error(`asset_versions lookup failed: ${maxError.message}`);
  const nextVersionNo = ((maxRow as { version_no: number } | null)?.version_no ?? 0) + 1;

  const { data: versionData, error: versionError } = await supa
    .from("asset_versions")
    .insert({
      asset_id: asset.id,
      version_no: nextVersionNo,
      storage_path: input.storage_path,
      source: input.source,
      prompt_version_id: input.prompt_version_id ?? null,
      provider: input.provider ?? null,
      provider_asset_id: input.provider_asset_id ?? null,
      metadata: input.metadata ?? {},
      units: input.units ?? null,
      unit_type: input.unit_type ?? null,
      cost_log_id: input.cost_log_id ?? null,
      created_by: input.created_by ?? null,
    })
    .select("*")
    .single();
  if (versionError) throw new Error(`asset_versions insert failed: ${versionError.message}`);
  const version = versionData as AssetVersion;

  const { error: updateError } = await supa
    .from("assets")
    .update({ current_version_id: version.id })
    .eq("id", asset.id);
  if (updateError) throw new Error(`assets update failed: ${updateError.message}`);

  return { asset: { ...asset, current_version_id: version.id }, version };
}

export async function revertAssetVersion(supa: ServiceClient, assetId: string, versionNo: number): Promise<void> {
  const { data, error } = await supa
    .from("asset_versions")
    .select("id")
    .eq("asset_id", assetId)
    .eq("version_no", versionNo)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);

  const { error: updateError } = await supa
    .from("assets")
    .update({ current_version_id: (data as { id: string }).id })
    .eq("id", assetId);
  if (updateError) throw new Error(`assets revert failed: ${updateError.message}`);
}

export async function assetHistory(supa: ServiceClient, assetId: string): Promise<AssetVersion[]> {
  const { data, error } = await supa
    .from("asset_versions")
    .select("*")
    .eq("asset_id", assetId)
    .order("version_no", { ascending: false });
  if (error) throw new Error(`asset_versions history failed: ${error.message}`);
  return (data ?? []) as AssetVersion[];
}

export async function getAsset(supa: ServiceClient, assetId: string): Promise<AssetRow> {
  const { data, error } = await supa.from("assets").select("*").eq("id", assetId).single();
  if (error) throw new Error(`assets lookup failed: ${error.message}`);
  return data as AssetRow;
}

export async function getPrompt(supa: ServiceClient, promptId: string): Promise<PromptRow> {
  const { data, error } = await supa.from("prompts").select("*").eq("id", promptId).single();
  if (error) throw new Error(`prompts lookup failed: ${error.message}`);
  return data as PromptRow;
}

export async function getCurrentPromptVersion(supa: ServiceClient, promptId: string): Promise<PromptVersion | null> {
  const prompt = await getPrompt(supa, promptId);
  if (!prompt.current_version_id) return null;
  const { data, error } = await supa.from("prompt_versions").select("*").eq("id", prompt.current_version_id).single();
  if (error) throw new Error(`prompt_versions lookup failed: ${error.message}`);
  return data as PromptVersion;
}
