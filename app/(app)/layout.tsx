"use client";

import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Toaster } from "@/app/components/ui/sonner";
import { routes } from "@/src/lib/routes";

async function handleSignOut() {
  try {
    await fetch("/auth/signout", { method: "POST" });
  } finally {
    // Full navigation (not a client-side route push) — signing out should drop all
    // client-side state, not just swap the rendered route.
    window.location.href = routes.login();
  }
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="container flex h-14 items-center justify-between">
          {/* Always-available way home — every page sits under this layout. */}
          <Link href={routes.clients()} className="text-sm font-semibold hover:underline">
            Product Engine
          </Link>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      {children}
      <Toaster />
    </div>
  );
}
