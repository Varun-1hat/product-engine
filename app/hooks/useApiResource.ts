"use client";

import { useCallback, useEffect, useState } from "react";

export interface UseApiResourceResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Shared fetch-on-mount-and-on-url-change hook (spec §1.4). Wraps both the network call and a
 * non-ok response in try/catch — every caller gets error handling for free instead of the
 * silent-failure pattern the old Dashboard used. `url === null` means "don't fetch yet" (e.g.
 * a dependent id isn't available yet): loading stays false, data stays null.
 */
export function useApiResource<T>(url: string | null): UseApiResourceResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(url !== null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (url === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Request failed (${res.status})`;
        throw new Error(message);
      }
      const json = (await res.json()) as T;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { data, loading, error, reload: load };
}
