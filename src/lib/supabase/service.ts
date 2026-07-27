/**
 * Service-role Supabase client — server/worker code ONLY (bypasses RLS).
 * This is the `ServiceClient` referenced throughout src/stages/* (see
 * StageContext.supa) and src/lib/{cost,jobs,crypto,storage}/*. It must
 * never be imported by a Client Component or any code shipped to the
 * browser — this is a code-organization rule enforced by review, not the
 * `server-only` package: that marker only no-ops under Next's webpack/RSC
 * bundler (a `react-server` export condition) and throws unconditionally
 * under plain Node, which would break both Vitest and the tsx-run worker
 * (worker/*.ts) that also imports this same module directly.
 */
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function createServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (service client is server/worker-only)."
    );
  }

  cached = createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

export type ServiceClient = SupabaseClient;
