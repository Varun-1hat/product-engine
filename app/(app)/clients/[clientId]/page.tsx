"use client";

import { use as usePromise } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { SpendBar } from "@/app/components/SpendBar";
import { useApiResource } from "@/app/hooks/useApiResource";
import { routes } from "@/src/lib/routes";
import type { StageId } from "@/src/lib/db/enums";

interface ClientResponse {
  client: { id: string; display_name: string };
}

interface ReelWithSpend {
  id: string;
  display_name: string;
  status: string;
  current_stage: StageId;
  spent: { total_usd: number; by_stage: Record<string, number> };
}

interface ReelsResponse {
  reels: ReelWithSpend[];
}

/**
 * Client dashboard (spec §2.3) — reel list + spend + actions. Replaces the
 * deleted app/(app)/dashboard page's ClientReels logic (ported below) plus
 * this page's own former brand-kit/keys/avatars forms, which now
 * live under Config (§2.4).
 */
export default function ClientDashboardPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = usePromise(params);

  const { data: clientData, loading: clientLoading, error: clientError } = useApiResource<ClientResponse>(
    `/api/clients/${clientId}`
  );
  const { data: reelsData, loading: reelsLoading, error: reelsError } = useApiResource<ReelsResponse>(
    `/api/clients/${clientId}/reels`
  );

  const reels = reelsData?.reels ?? [];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <Link href={routes.clients()} className="text-sm text-muted-foreground hover:underline">
        ← All clients
      </Link>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {clientLoading ? "Loading…" : clientData?.client.display_name ?? "Client"}
        </h1>
        <div className="flex items-center gap-2">
          <Link href={routes.clientConfig(clientId)}>
            <Button variant="ghost" size="sm">
              Config
            </Button>
          </Link>
          <Link href={routes.newReel(clientId)}>
            <Button>New reel</Button>
          </Link>
        </div>
      </div>
      {clientError ? <p className="text-sm text-destructive">{clientError}</p> : null}

      <div className="flex flex-col gap-3">
        {reelsLoading ? <p className="text-sm text-muted-foreground">Loading reels…</p> : null}
        {reelsError ? <p className="text-sm text-destructive">{reelsError}</p> : null}
        {!reelsLoading && !reelsError && reels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reels yet.</p>
        ) : null}
        {reels.map((reel) => (
          <div key={reel.id} className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <Link href={routes.reelStage(reel.id, reel.current_stage)} className="text-sm font-medium underline">
                {reel.display_name}
              </Link>
              <div className="flex gap-1">
                <Badge variant="outline">{reel.current_stage}</Badge>
                <Badge variant={reel.status === "assembled" ? "default" : "secondary"}>{reel.status}</Badge>
              </div>
            </div>
            <SpendBar spent={reel.spent} />
          </div>
        ))}
      </div>
    </main>
  );
}
