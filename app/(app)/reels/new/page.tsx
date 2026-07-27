"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";

function NewReelForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientId = searchParams.get("client_id") ?? "";

  const [topic, setTopic] = useState("");
  const [totalSeconds, setTotalSeconds] = useState(20);
  const [avatarEnabled, setAvatarEnabled] = useState(false);
  const [brollProvider, setBrollProvider] = useState<"veo" | "higgsfield" | "">("veo");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [resolution, setResolution] = useState("1080p");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          topic,
          total_seconds_target: totalSeconds,
          avatar_enabled: avatarEnabled,
          broll_provider: avatarEnabled ? (brollProvider || undefined) : brollProvider,
          image_provider: "nano_banana",
          veo_variant: "fast",
          aspect_ratio: aspectRatio,
          resolution,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to create reel");
      router.push(`/reels/${data.reel.id}/scene`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!clientId) {
    return <p className="p-8 text-sm text-destructive">Missing ?client_id= — start from a client's page.</p>;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">New reel</h1>
      <Card>
        <CardHeader>
          <CardTitle>Setup (Stage 2)</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="topic">Topic</Label>
              <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="seconds">Total seconds (target)</Label>
              <Input
                id="seconds"
                type="number"
                min={1}
                value={totalSeconds}
                onChange={(e) => setTotalSeconds(Number(e.target.value))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={avatarEnabled} onChange={(e) => setAvatarEnabled(e.target.checked)} />
              Include an avatar
            </label>
            <div className="flex flex-col gap-1">
              <Label htmlFor="broll">B-roll model {avatarEnabled ? "(optional — all-avatar allowed)" : ""}</Label>
              <select
                id="broll"
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                value={brollProvider}
                onChange={(e) => setBrollProvider(e.target.value as typeof brollProvider)}
              >
                {avatarEnabled ? <option value="">none (all-avatar)</option> : null}
                <option value="veo">Veo 3.1</option>
                <option value="higgsfield">Higgsfield (wave 2 — verify docs)</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="aspect">Aspect ratio</Label>
                <select
                  id="aspect"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                >
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="resolution">Resolution</Label>
                <select
                  id="resolution"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                >
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                </select>
              </div>
            </div>
            <Button type="submit" disabled={busy} className="w-fit">
              {busy ? "Creating…" : "Create reel"}
            </Button>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default function NewReelPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted-foreground">Loading…</p>}>
      <NewReelForm />
    </Suspense>
  );
}
