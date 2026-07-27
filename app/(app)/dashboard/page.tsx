"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { SpendBar } from "@/app/components/SpendBar";

interface ClientRow {
  id: string;
  display_name: string;
}

interface ReelWithSpend {
  id: string;
  display_name: string;
  status: string;
  current_stage: string;
  spent: { total_usd: number; by_stage: Record<string, number> };
}

function ClientReels({ clientId }: { clientId: string }) {
  const [reels, setReels] = useState<ReelWithSpend[] | null>(null);

  useEffect(() => {
    fetch(`/api/clients/${clientId}/reels`)
      .then((r) => r.json())
      .then((data) => setReels(data.reels ?? []));
  }, [clientId]);

  if (!reels) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (reels.length === 0) return <p className="text-xs text-muted-foreground">No reels yet.</p>;

  return (
    <div className="flex flex-col gap-3">
      {reels.map((reel) => (
        <div key={reel.id} className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <Link href={`/reels/${reel.id}/scene`} className="text-sm font-medium underline">
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
  );
}

export default function DashboardPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);

  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then((data) => setClients(data.clients ?? []));
  }, []);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Link href="/clients" className="text-sm text-muted-foreground underline">
          Clients
        </Link>
      </div>

      {clients.length === 0 ? <p className="text-sm text-muted-foreground">No clients yet.</p> : null}

      {clients.map((client) => (
        <Card key={client.id}>
          <CardHeader>
            <CardTitle>{client.display_name}</CardTitle>
          </CardHeader>
          <CardContent>
            <ClientReels clientId={client.id} />
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
