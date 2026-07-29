/**
 * Magic-link callback (BLOCK-1 — .pipeline/review.md). app/login/page.tsx's
 * signInWithOtp() points emailRedirectTo here with the original `next`
 * destination attached; this exchanges the emailed `code` for a session
 * (cookies set via src/lib/supabase/server.ts's createClient()) and sends
 * the user on to `next`, or back to /login on failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/src/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/clients";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
