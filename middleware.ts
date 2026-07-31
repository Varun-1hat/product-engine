/**
 * Session-auth gate (BLOCK-1 — .pipeline/review.md). Every route reaches
 * app/api/**'s handlers today with zero authentication (the handlers'
 * context builders use createServiceClient(), which deliberately bypasses
 * RLS for stage/adapter writes — that stays; the missing piece is a gate
 * *before* any handler is reached). This middleware is that gate: it reads
 * the session from cookies via @supabase/ssr (the same pattern
 * src/lib/supabase/server.ts documents for Server Components/Route
 * Handlers), and either lets the request through, 401s API calls, or
 * redirects page loads to /login.
 *
 * Exempt: /api/webhooks/** (provider callbacks, authenticated separately by
 * their own per-job callback_token — see app/api/webhooks/heygen/route.ts)
 * and /login + /auth/** (the sign-in flow itself, which must be reachable
 * while signed out).
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  const isWebhook = pathname.startsWith("/api/webhooks/");
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth/");
  if (isWebhook || isAuthRoute) return response;

  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
