/**
 * Shared `AssetRef` -> raw bytes resolution for adapters. Adapters only
 * ever consume an already-resolved `base64` payload or a fetchable `url` —
 * they never read `storage_path` directly (that would require knowing our
 * internal bucket-naming scheme, which is an orchestration/storage-layer
 * concern). The calling stage is responsible for resolving any
 * `storage_path` reference (via src/lib/storage) into `base64` before
 * building a GenerateInput.
 */
import type { AssetRef } from "./types";

export interface ResolvedBytes {
  data: string; // base64
  mimeType: string;
}

export async function resolveAssetRefBytes(ref: AssetRef): Promise<ResolvedBytes> {
  if (ref.base64) {
    return { data: ref.base64, mimeType: ref.mime_type ?? "image/png" };
  }

  if (ref.url) {
    const res = await fetch(ref.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch reference url (${res.status} ${res.statusText}): ${ref.url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const mimeType = ref.mime_type ?? res.headers.get("content-type") ?? "image/png";
    return { data: Buffer.from(arrayBuffer).toString("base64"), mimeType };
  }

  if (ref.storage_path) {
    throw new Error(
      `AssetRef.storage_path ("${ref.storage_path}") was not resolved to base64/url before reaching the adapter — the calling stage must resolve storage refs first.`
    );
  }

  throw new Error("AssetRef has none of base64/url/storage_path set");
}
