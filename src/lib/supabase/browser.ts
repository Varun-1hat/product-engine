/**
 * Browser Supabase client — Client Components only. Uses the public anon
 * key and is subject to RLS (0002_rls.sql: `authenticated` full CRUD on
 * domain tables). Used for Supabase Realtime subscriptions on
 * jobs/assets/asset_versions/cost_log (brief: UI live updates). Never import
 * the service-role client (src/lib/supabase/service.ts) here.
 */
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createBrowserClient(url, anonKey);
}
