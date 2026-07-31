"use client";

import { Toaster as SonnerToaster } from "sonner";

export { toast } from "sonner";

/** Dark-only — no system/light theme detection, this app has no theme toggle. */
export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      toastOptions={{ className: "bg-card text-card-foreground border border-border" }}
    />
  );
}
