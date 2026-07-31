"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { routes } from "@/src/lib/routes";

interface ClientRow {
  id: string;
  display_name: string;
  archived: boolean;
  created_at: string;
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cloneFromId, setCloneFromId] = useState("");
  const [cloneDisplayName, setCloneDisplayName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      setClients(data.clients ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to create client");
      setDisplayName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  /**
   * Clone-from (spec §7.5) — creates a NEW client prefilled from an existing
   * one's brand kit/avatars (never provider keys — src/stages/config's
   * cloneClient never copies those). Lives here, not Config, since cloning
   * creates a new client rather than editing the one you're viewing.
   * POST /api/clients already forwards `clone_from` through to processConfig
   * via configInputSchema (confirmed by reading app/api/clients/route.ts) —
   * no backend change needed.
   */
  async function handleClone(e: React.FormEvent) {
    e.preventDefault();
    if (!cloneFromId) return;
    setCloning(true);
    setCloneError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clone_from: cloneFromId, display_name: cloneDisplayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to clone client");
      setCloneFromId("");
      setCloneDisplayName("");
      await load();
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloning(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">Clients</h1>

      <div className="flex flex-col gap-6 sm:flex-row">
        <Card className="flex-1">
          <CardHeader>
            <CardTitle>New client</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="display_name">Display name</Label>
                <Input
                  id="display_name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Acme Co"
                  required
                />
              </div>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </form>
            {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
          </CardContent>
        </Card>

        <Card className="flex-1">
          <CardHeader>
            <CardTitle>Clone an existing client</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleClone} className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="clone_from">Clone from</Label>
                <Select value={cloneFromId || undefined} onValueChange={setCloneFromId}>
                  <SelectTrigger id="clone_from">
                    <SelectValue placeholder={clients.length === 0 ? "No clients yet" : "Select a client…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="clone_display_name">New client&apos;s display name</Label>
                <Input
                  id="clone_display_name"
                  value={cloneDisplayName}
                  onChange={(e) => setCloneDisplayName(e.target.value)}
                  placeholder="Acme Co (copy)"
                  required
                />
              </div>
              <Button type="submit" disabled={cloning || !cloneFromId} className="w-fit">
                {cloning ? "Cloning…" : "Clone"}
              </Button>
            </form>
            {cloneError ? <p className="mt-2 text-xs text-destructive">{cloneError}</p> : null}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {!loading && clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No clients yet.</p>
        ) : null}
        {clients.map((c) => (
          <Link
            key={c.id}
            href={routes.client(c.id)}
            className="flex items-center justify-between rounded-md border border-border p-3 text-sm hover:bg-accent"
          >
            <span className="font-medium">{c.display_name}</span>
            <span className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
