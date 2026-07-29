/**
 * Shared "upload an override" step for the Stage 4/5/7 review hooks. A
 * user-supplied file (already in Storage via
 * app/api/clients/[clientId]/uploads) is appended as an ordinary `uploaded`
 * version of the existing asset — same versioning bookkeeping as a
 * generated one (spec §2.4), so it becomes the current version, the
 * generated versions stay in history, and a later redo/revert still works.
 * One file per call; upload again for another version.
 */
import { getAsset, upsertAssetVersion } from "./versioning";
import type { StageContext } from "@/src/stages/types";
import type { AssetRow, AssetVersion } from "./db/types";
import type { MediaType, Slot } from "./db/enums";

/**
 * Same thing for a slot that was never generated: creates the `assets` row
 * and its first `uploaded` version in one go, so a user who already has the
 * file can skip the initial generation entirely. Callers link the new asset
 * into whatever column owns it (scenes.start_image_id, clip_asset_id, …).
 */
export async function createUploadedAsset(
  ctx: StageContext,
  params: { slot: Slot; mediaType: MediaType; storagePath: string; sceneId?: string | null }
): Promise<{ asset: AssetRow; version: AssetVersion }> {
  return upsertAssetVersion(ctx.supa, {
    reel_id: ctx.reelId,
    scene_id: params.sceneId ?? null,
    slot: params.slot,
    media_type: params.mediaType,
    storage_path: params.storagePath,
    source: "uploaded",
  });
}

export async function uploadAssetVersion(
  ctx: StageContext,
  assetId: string,
  storagePath: string
): Promise<AssetVersion> {
  const asset = await getAsset(ctx.supa, assetId);
  const { version } = await upsertAssetVersion(ctx.supa, {
    assetId,
    reel_id: asset.reel_id,
    scene_id: asset.scene_id,
    slot: asset.slot,
    media_type: asset.media_type,
    shared: asset.shared,
    storage_path: storagePath,
    source: "uploaded",
  });
  return version;
}
