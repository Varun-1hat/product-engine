/**
 * Builds an adapter `AssetRef` (base64) from something already in our
 * Storage — either an existing `assets` row's current version (start/end
 * frame chaining) or a raw bucket/path (e.g. a product photo). Adapters
 * never read storage_path directly (src/adapters/assetRef.ts) — resolving
 * it to base64 here, at the stage layer, is what keeps that true.
 */
import type { ServiceClient } from "./supabase/service";
import type { BucketName, StorageClient } from "./storage";
import type { AssetRef } from "@/src/adapters/types";
import { getAsset } from "./versioning";

export async function buildAssetRefFromAssetId(
  supa: ServiceClient,
  storage: StorageClient,
  assetId: string,
  bucket: BucketName = "assets"
): Promise<AssetRef> {
  const asset = await getAsset(supa, assetId);
  if (!asset.current_version_id) {
    throw new Error(`asset ${assetId} has no current version`);
  }

  const { data, error } = await supa
    .from("asset_versions")
    .select("storage_path, metadata")
    .eq("id", asset.current_version_id)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);

  const row = data as { storage_path: string | null; metadata: { mime?: string } | null };
  if (!row.storage_path) {
    throw new Error(`asset ${assetId}'s current version has no storage_path yet`);
  }

  const buffer = await storage.download(bucket, row.storage_path);
  return { base64: buffer.toString("base64"), mime_type: row.metadata?.mime ?? "image/png" };
}

export async function buildAssetRefFromStoragePath(
  storage: StorageClient,
  bucket: BucketName,
  path: string,
  mimeType?: string
): Promise<AssetRef> {
  const buffer = await storage.download(bucket, path);
  return { base64: buffer.toString("base64"), mime_type: mimeType };
}
