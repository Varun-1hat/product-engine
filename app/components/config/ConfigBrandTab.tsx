"use client";

import { useEffect, useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { useApiResource } from "@/app/hooks/useApiResource";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import { ASPECT_RATIOS, RESOLUTIONS } from "@/src/lib/db/enums";
import type { ClientConfigRow } from "@/src/lib/db/types";

interface ConfigResponse {
  client_config: ClientConfigRow;
  /** Signed URL for client_config.logo_path (spec §7.5) — added by the route handler, since Storage buckets are private. */
  logo_url: string | null;
}

/**
 * Config > Brand tab (spec §2.4, enhanced per §7.5) — brand-kit fields split
 * out of the old client detail page's combined form. Owns its own fetch
 * against GET /api/clients/{clientId} (duplicated across the four tabs by
 * design — see spec §2.4).
 *
 * §7.5 additions: brand_colors/fonts as free-text JSON (this app has no
 * color/font picker anywhere, parsed on submit with a try/catch),
 * default_aspect_ratio/default_resolution Selects, and a logo upload that
 * persists immediately on successful upload via its own PATCH (decoupled
 * from the rest-of-form "Save" button below, which still covers
 * brand_name/tagline/colors/fonts/aspect/resolution together).
 */
export function ConfigBrandTab({ clientId }: { clientId: string }) {
  const { data, reload } = useApiResource<ConfigResponse>(`/api/clients/${clientId}`);
  const { upload, uploading, error: uploadError } = useFileUpload(clientId);

  const [brandName, setBrandName] = useState("");
  const [tagline, setTagline] = useState("");
  const [brandColorsText, setBrandColorsText] = useState("");
  const [fontsText, setFontsText] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setBrandName(data.client_config.brand_name ?? "");
    setTagline(data.client_config.default_tagline ?? "");
    setBrandColorsText(data.client_config.brand_colors ? JSON.stringify(data.client_config.brand_colors, null, 2) : "");
    setFontsText(data.client_config.fonts ? JSON.stringify(data.client_config.fonts, null, 2) : "");
    setAspectRatio(data.client_config.default_aspect_ratio ?? "");
    setResolution(data.client_config.default_resolution ?? "");
  }, [data]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Blank textarea -> omit the field (leave existing value untouched), not "clear it" — this
    // avoids a spurious "not valid JSON" error for users who never touch brand_colors/fonts.
    let brandColors: Record<string, unknown> | undefined;
    let fonts: Record<string, unknown> | undefined;
    try {
      brandColors = brandColorsText.trim() ? JSON.parse(brandColorsText) : undefined;
    } catch {
      setError("Brand colors must be valid JSON (or left blank).");
      return;
    }
    try {
      fonts = fontsText.trim() ? JSON.parse(fontsText) : undefined;
    } catch {
      setError("Fonts must be valid JSON (or left blank).");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_kit: {
            brand_name: brandName,
            default_tagline: tagline,
            brand_colors: brandColors,
            fonts,
            default_aspect_ratio: aspectRatio || undefined,
            default_resolution: resolution || undefined,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const path = await upload(file, "logo");
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_kit: { logo_path: path } }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "logo save failed");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Brand kit</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label>Logo</Label>
          {data?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed Storage URL, not a static asset
            <img
              src={data.logo_url}
              alt="Brand logo"
              className="h-16 w-auto rounded-md border border-border bg-muted object-contain p-2"
            />
          ) : (
            <p className="text-xs text-muted-foreground">No logo uploaded yet.</p>
          )}
          <input
            type="file"
            accept="image/*"
            onChange={handleLogoChange}
            disabled={uploading}
            className="text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-secondary file:px-2 file:py-1 file:text-xs file:text-secondary-foreground"
          />
          {uploading ? <span className="text-xs text-muted-foreground">Uploading…</span> : null}
          {uploadError ? <span className="text-xs text-destructive">{uploadError}</span> : null}
        </div>

        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="brand_name">Brand name</Label>
            <Input id="brand_name" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="tagline">Default tagline (outro)</Label>
            <Input id="tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="default_aspect_ratio">Default aspect ratio</Label>
              <Select value={aspectRatio || undefined} onValueChange={setAspectRatio}>
                <SelectTrigger id="default_aspect_ratio">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  {ASPECT_RATIOS.map((ar) => (
                    <SelectItem key={ar} value={ar}>
                      {ar}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="default_resolution">Default resolution</Label>
              <Select value={resolution || undefined} onValueChange={setResolution}>
                <SelectTrigger id="default_resolution">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  {RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="brand_colors">Brand colors (JSON)</Label>
            <Textarea
              id="brand_colors"
              value={brandColorsText}
              onChange={(e) => setBrandColorsText(e.target.value)}
              placeholder='{ "primary": "#0047FF" }'
              rows={3}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="fonts">Fonts (JSON)</Label>
            <Textarea
              id="fonts"
              value={fontsText}
              onChange={(e) => setFontsText(e.target.value)}
              placeholder='{ "heading": "Inter" }'
              rows={3}
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
