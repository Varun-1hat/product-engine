"use client";

import { useState } from "react";

export type UploadKind = "logo" | "music" | "end_frame" | "asset";

export interface UseFileUploadResult {
  upload: (file: File, kind: UploadKind, reelId?: string) => Promise<string>;
  uploading: boolean;
  error: string | null;
}

/**
 * Client hook for the generic upload endpoint (spec §7.2) —
 * POST /api/clients/{clientId}/uploads. Builds the FormData and resolves the
 * returned `storage_path`; callers (ConfigBrandTab's logo, Outro's custom
 * end-frame, Music's track) then PATCH/POST that path into the relevant
 * stage/config endpoint themselves — this hook only owns the upload step.
 */
export function useFileUpload(clientId: string): UseFileUploadResult {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File, kind: UploadKind, reelId?: string): Promise<string> {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", kind);
      if (reelId) formData.append("reel_id", reelId);

      const res = await fetch(`/api/clients/${clientId}/uploads`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "upload failed");
      return data.storage_path as string;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setUploading(false);
    }
  }

  return { upload, uploading, error };
}
