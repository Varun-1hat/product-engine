/**
 * Server Supabase client — Server Components / Route Handlers. Carries the
 * signed-in staff member's session (magic-link auth, Assumption 7) via
 * cookies and is subject to RLS as `authenticated`. Use this to gate pages
 * on auth state; use src/lib/supabase/service.ts (service_role, bypasses
 * RLS) for the actual stage/adapter/cost-engine writes.
 *
 * Not marked with the `server-only` package: that marker only no-ops under
 * Next's webpack/RSC bundler (via a `react-server` export condition) and
 * throws unconditionally under plain Node (Vitest), so
 * it's a poor fit for framework-free src/** modules that must also run
 * there. This file is Next-only anyway by construction (`next/headers`
 * only works inside Next's request handling) — never import it from a
 * Client Component.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component (no mutable response available).
          // Safe to ignore as long as middleware refreshes the session.
        }
      },
    },
  });
}
