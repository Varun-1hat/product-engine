/**
 * Sign-out (BLOCK-1 — .pipeline/review.md). POST-only; clears the session
 * cookies via src/lib/supabase/server.ts's createClient() and sends the
 * user back to /login. No UI wiring yet — a later phase adds a sign-out
 * control to the nav shell that POSTs here; this route just needs to exist
 * and work when POSTed to directly.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/src/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url));
}
