"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";

interface ConfigResponse {
  client: { id: string; display_name: string };
  client_config: { brand_name: string | null; default_tagline: string | null };
  avatars: Array<{ id: string; name: string; preview_image_url: string | null }>;
  products: Array<{ id: string; name: string }>;
}

export default function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = usePromise(params);
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [brandName, setBrandName] = useState("");
  const [tagline, setTagline] = useState("");
  const [heygenKey, setHeygenKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/clients/${clientId}`);
    if (!res.ok) return;
    const json = (await res.json()) as ConfigResponse;
    setData(json);
    setBrandName(json.client_config.brand_name ?? "");
    setTagline(json.client_config.default_tagline ?? "");
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function saveBrandKit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const provider_keys = [
        ...(googleKey ? [{ provider: "veo" as const, api_key: googleKey }] : []),
        ...(heygenKey ? [{ provider: "heygen" as const, api_key: heygenKey }] : []),
      ];
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_kit: { brand_name: brandName, default_tagline: tagline },
          ...(provider_keys.length ? { provider_keys } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      setHeygenKey("");
      setGoogleKey("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{data.client.display_name}</h1>
        <Link href={`/reels/new?client_id=${clientId}`}>
          <Button>New reel</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Brand kit &amp; provider keys</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveBrandKit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="brand_name">Brand name</Label>
              <Input id="brand_name" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="tagline">Default tagline (outro)</Label>
              <Input id="tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="google_key">Google/Gemini key (covers Nano Banana + Veo)</Label>
              <Input
                id="google_key"
                type="password"
                value={googleKey}
                onChange={(e) => setGoogleKey(e.target.value)}
                placeholder="leave blank to keep existing"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="heygen_key">HeyGen key</Label>
              <Input
                id="heygen_key"
                type="password"
                value={heygenKey}
                onChange={(e) => setHeygenKey(e.target.value)}
                placeholder="leave blank to keep existing"
              />
            </div>
            <Button type="submit" disabled={saving} className="w-fit">
              {saving ? "Saving…" : "Save"}
            </Button>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Avatars (HeyGen looks)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.avatars.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None pulled yet — save a HeyGen key above, then refresh in a few seconds (avatar_pull runs in the worker).
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {data.avatars.map((a) => (
                <Badge key={a.id} variant="secondary">
                  {a.name}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Products ({data.products.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.products.map((p) => (
            <Badge key={p.id} variant="outline">
              {p.name}
            </Badge>
          ))}
        </CardContent>
      </Card>
    </main>
  );
}
