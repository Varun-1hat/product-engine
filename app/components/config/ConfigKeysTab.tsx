"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { useApiResource } from "@/app/hooks/useApiResource";
import type { Provider } from "@/src/lib/db/enums";

interface MaskedProviderKey {
  provider: Provider;
  masked_key: string;
  account_label: string | null;
}

/** Minimal projection of `GET /api/clients/{clientId}` — only the masked keys are needed here. */
interface ConfigResponse {
  provider_keys: MaskedProviderKey[];
}

/**
 * Config > Keys tab (spec §2.4) — one key per client per provider, so
 * cost_log rows tie back to the account that was actually billed. Saved keys
 * are shown masked (last 5 characters only, masked server-side in
 * loadConfig — the raw secret never reaches the browser); typing a new value
 * and saving replaces it.
 */
export function ConfigKeysTab({ clientId }: { clientId: string }) {
  const { data: config, reload } = useApiResource<ConfigResponse>(`/api/clients/${clientId}`);
  const [heygenKey, setHeygenKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The Google key is stored once per google-backed provider — any of its rows shows the same masked value. */
  function saved(provider: Provider): string | null {
    return config?.provider_keys.find((k) => k.provider === provider)?.masked_key ?? null;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const provider_keys = [
        ...(googleKey ? [{ provider: "veo" as const, api_key: googleKey }] : []),
        ...(heygenKey ? [{ provider: "heygen" as const, api_key: heygenKey }] : []),
        ...(elevenLabsKey ? [{ provider: "elevenlabs" as const, api_key: elevenLabsKey }] : []),
      ];
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider_keys.length ? { provider_keys } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      setHeygenKey("");
      setGoogleKey("");
      setElevenLabsKey("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function currentLabel(provider: Provider) {
    const masked = saved(provider);
    return (
      <span className="text-xs text-muted-foreground">
        {masked ? `current: ${masked}` : "no key saved yet"}
      </span>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider keys</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="google_key">Google/Gemini key (covers Nano Banana + Veo + Lyria music)</Label>
            {currentLabel("veo")}
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
            {currentLabel("heygen")}
            <Input
              id="heygen_key"
              type="password"
              value={heygenKey}
              onChange={(e) => setHeygenKey(e.target.value)}
              placeholder="leave blank to keep existing"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="elevenlabs_key">ElevenLabs key (music)</Label>
            {currentLabel("elevenlabs")}
            <Input
              id="elevenlabs_key"
              type="password"
              value={elevenLabsKey}
              onChange={(e) => setElevenLabsKey(e.target.value)}
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
  );
}
