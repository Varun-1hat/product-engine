/**
 * Storage helper (§2.3): 5 private buckets, signed-URL download only. Path
 * convention `{client_id}/{reel_id}/{slot}/{asset_id}/v{version_no}.{ext}`
 * for reel-scoped assets; client-scoped assets (brand kit, product photos)
 * use buildClientPath instead, since they have no reel_id.
 *
 * Server/worker-only by code-organization convention (see
 * src/lib/supabase/service.ts for why the `server-only` package is not
 * used across src/lib/**): it must also run under Vitest and the tsx-run
 * worker, neither of which is Next's webpack/RSC bundler.
 */
import type { ServiceClient } from "@/src/lib/supabase/service";

export const BUCKETS = ["brand", "products", "assets", "music", "renders"] as const;
export type BucketName = (typeof BUCKETS)[number];

export function buildAssetPath(params: {
  client_id: string;
  reel_id: string;
  slot: string;
  asset_id: string;
  version_no: number;
  ext: string;
}): string {
  const ext = params.ext.replace(/^\./, "");
  return `${params.client_id}/${params.reel_id}/${params.slot}/${params.asset_id}/v${params.version_no}.${ext}`;
}

/** Client-level (not reel-scoped) paths — brand logo, product photos (Stage 1). */
export function buildClientPath(params: { client_id: string; category: string; file_id: string; ext: string }): string {
  const ext = params.ext.replace(/^\./, "");
  return `${params.client_id}/${params.category}/${params.file_id}.${ext}`;
}

/**
 * Path adapters (Nano Banana/Veo/HeyGen/Higgsfield generate()/poll()) use to
 * stage their raw provider output. Adapters know client_id/reel_id/asset_id/
 * idempotency_key (from GenerateInput) but not the eventual DB version_no —
 * that's assigned when the calling stage inserts the asset_versions row, so
 * this scheme keys on idempotency_key (unique per generate/redo attempt)
 * instead. The DB (asset_versions), not the storage key, is the source of
 * truth for version ordering.
 */
export function buildGeneratedPath(params: {
  client_id: string;
  reel_id: string;
  asset_id?: string;
  idempotency_key: string;
  ext: string;
}): string {
  const ext = params.ext.replace(/^\./, "");
  const assetSegment = params.asset_id ?? "unassigned";
  return `${params.client_id}/${params.reel_id}/generated/${assetSegment}/${params.idempotency_key}.${ext}`;
}

/**
 * Path used when an adapter's poll()/webhook-parse completion persists a
 * result and only has `provider` + `provider_job_id` to key on (the
 * Adapter.poll signature — spec §3 — does not carry the original
 * client_id/reel_id/asset_id). Perfectly fine as a permanent home: nothing
 * in this system parses storage paths back apart, the DB row (asset_versions)
 * is the source of truth for which asset/scene/reel a file belongs to.
 */
export function buildPollResultPath(params: { provider: string; provider_job_id: string; ext: string }): string {
  const ext = params.ext.replace(/^\./, "");
  const safeId = params.provider_job_id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `_provider_results/${params.provider}/${safeId}.${ext}`;
}

export interface StorageClient {
  /** Upload a Buffer or base64 string; upserts (overwrites) at `path`. */
  upload(bucket: BucketName, path: string, data: Buffer | string, contentType: string): Promise<{ path: string }>;
  download(bucket: BucketName, path: string): Promise<Buffer>;
  signedUrl(bucket: BucketName, path: string, expiresInSeconds?: number): Promise<string>;
  remove(bucket: BucketName, path: string): Promise<void>;
}

export function createStorageClient(supa: ServiceClient): StorageClient {
  return {
    async upload(bucket, path, data, contentType) {
      const buffer = typeof data === "string" ? Buffer.from(data, "base64") : data;
      const { error } = await supa.storage.from(bucket).upload(path, buffer, {
        contentType,
        upsert: true,
      });
      if (error) throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`);
      return { path };
    },

    async download(bucket, path) {
      const { data, error } = await supa.storage.from(bucket).download(path);
      if (error) throw new Error(`Storage download failed (${bucket}/${path}): ${error.message}`);
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },

    async signedUrl(bucket, path, expiresInSeconds = 3600) {
      const { data, error } = await supa.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      if (error) throw new Error(`Signed URL failed (${bucket}/${path}): ${error.message}`);
      return data.signedUrl;
    },

    async remove(bucket, path) {
      const { error } = await supa.storage.from(bucket).remove([path]);
      if (error) throw new Error(`Storage remove failed (${bucket}/${path}): ${error.message}`);
    },
  };
}
