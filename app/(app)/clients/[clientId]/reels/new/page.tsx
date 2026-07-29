"use client";

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Slider } from "@/app/components/ui/slider";
import { Switch } from "@/app/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { CapabilityGuard } from "@/app/components/CapabilityGuard";
import { ProgressSteps, type ProgressStep } from "@/app/components/ui/progress-steps";
import { useApiResource } from "@/app/hooks/useApiResource";
import { routes } from "@/src/lib/routes";
import { VEO_VARIANT_LABELS, allowedAspectRatios, allowedResolutions } from "@/src/lib/brollModels";
import { STAGE_ORDER } from "@/src/stages/types";
import type { ValidationResult } from "@/src/adapters/types";

interface ConfigAvatar {
  id: string;
  name: string;
  preview_image_url: string | null;
}

interface ClientAvatarsResponse {
  avatars: ConfigAvatar[];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Reel creation (spec §2.5 file move + §3.3 enhancements).
 *
 * clientId comes from the route itself instead of ?client_id=, so the old
 * Suspense-for-useSearchParams wrapper and "missing client_id" error state
 * are gone (§2.5).
 *
 * §3.3 additions: the seconds Slider, the avatar look-picker (preview
 * cards, single-select), the removal of the Higgsfield-including b-roll
 * dropdown (Veo is implicit when avatar mode is off; a plain Switch toggles
 * b-roll scenes on/off when avatar mode is on), and CapabilityGuard wiring
 * against the now-structured 400 validation payload.
 */
export default function NewReelPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = usePromise(params);
  const router = useRouter();

  const [topic, setTopic] = useState("");
  const [totalSeconds, setTotalSeconds] = useState(30);
  const [avatarEnabled, setAvatarEnabled] = useState(false);
  const [avatarLookId, setAvatarLookId] = useState<string | undefined>(undefined);
  const [includeBroll, setIncludeBroll] = useState(true);
  const [veoVariant, setVeoVariant] = useState("fast");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [resolution, setResolution] = useState("1080p");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  const { data: avatarsData } = useApiResource<ClientAvatarsResponse>(
    avatarEnabled ? `/api/clients/${clientId}` : null
  );
  const avatars = avatarsData?.avatars ?? [];

  // No b-roll UI at all when avatar mode is off — Veo is the only visible
  // model and there's nothing to choose (Higgsfield must never be
  // selectable, spec §3.2/"Do not do").
  const brollProvider: "veo" | undefined = avatarEnabled ? (includeBroll ? "veo" : undefined) : "veo";

  const avatarSelectionMissing = avatarEnabled && !avatarLookId;

  // Only offer what the selected b-roll model can actually render, and keep
  // the current choice legal when the model changes (Omni is 720p-only).
  const aspectOptions = allowedAspectRatios(brollProvider ? veoVariant : null);
  const resolutionOptions = allowedResolutions(brollProvider ? veoVariant : null);
  useEffect(() => {
    if (!aspectOptions.includes(aspectRatio)) setAspectRatio(aspectOptions[0]);
    if (!resolutionOptions.includes(resolution)) setResolution(resolutionOptions[0]);
  }, [aspectOptions, resolutionOptions, aspectRatio, resolution]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (avatarSelectionMissing) return;
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
          avatar_look_id: avatarEnabled ? avatarLookId : undefined,
          broll_provider: brollProvider,
          image_provider: "nano_banana",
          veo_variant: veoVariant,
          aspect_ratio: aspectRatio,
          resolution,
        }),
      });
      const data = await res.json();
      if (data.validation) setValidation(data.validation as ValidationResult);
      if (!res.ok) throw new Error(data.error ?? "failed to create reel");
      router.push(routes.reelStage(data.reel.id, "scene"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Lightweight, non-interactive step indicator (spec §3.3 "Header") — no
  // reelId exists yet, so nothing here is clickable.
  const steps: ProgressStep[] = STAGE_ORDER.map((stage) => ({
    id: stage,
    label: capitalize(stage),
    href: null,
  }));

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <Link href={routes.client(clientId)} className="text-sm text-muted-foreground hover:underline">
        ← Back to reels
      </Link>
      <ProgressSteps steps={steps} currentIndex={0} reachedIndex={0} />

      <Card>
        <CardHeader>
          <CardTitle>New reel</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="topic">Topic</Label>
              <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} required />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="seconds">Total seconds (target)</Label>
              <div className="flex items-center gap-3">
                <Slider
                  id="seconds"
                  min={6}
                  max={180}
                  step={1}
                  defaultValue={[totalSeconds]}
                  onValueChange={([v]) => setTotalSeconds(v)}
                  className="flex-1"
                />
                <span className="w-12 shrink-0 text-right text-sm text-muted-foreground">{totalSeconds}s</span>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={avatarEnabled}
                onCheckedChange={(checked) => {
                  setAvatarEnabled(checked);
                  if (!checked) setAvatarLookId(undefined);
                }}
              />
              Include an avatar
            </label>

            {avatarEnabled ? (
              <div className="flex flex-col gap-2">
                <Label>Avatar look</Label>
                {avatars.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No avatars configured yet.{" "}
                    <Link href={routes.clientConfig(clientId)} className="text-primary underline">
                      Go to Config
                    </Link>
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    {avatars.map((avatar) => {
                      const selected = avatarLookId === avatar.id;
                      return (
                        <button
                          key={avatar.id}
                          type="button"
                          onClick={() => setAvatarLookId(avatar.id)}
                          className={`flex w-28 flex-col gap-2 rounded-md border border-border p-2 text-left transition-colors ${
                            selected ? "ring-2 ring-primary" : ""
                          }`}
                        >
                          {avatar.preview_image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element -- signed/external Storage URL, not a static asset
                            <img
                              src={avatar.preview_image_url}
                              alt={avatar.name}
                              className="h-20 w-full rounded-md border border-border object-cover"
                            />
                          ) : (
                            <div className="flex h-20 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted p-1 text-center text-xs text-muted-foreground">
                              {avatar.name}
                            </div>
                          )}
                          <span className="truncate text-xs font-medium" title={avatar.name}>
                            {avatar.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {avatarEnabled ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={includeBroll} onCheckedChange={setIncludeBroll} />
                Include b-roll scenes
              </label>
            ) : null}

            {brollProvider ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="broll_model">B-roll model</Label>
                <Select value={veoVariant} onValueChange={setVeoVariant}>
                  <SelectTrigger id="broll_model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(VEO_VARIANT_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="aspect">Aspect ratio</Label>
                <Select value={aspectRatio} onValueChange={setAspectRatio}>
                  <SelectTrigger id="aspect">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {aspectOptions.map((ar) => (
                      <SelectItem key={ar} value={ar}>
                        {ar}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="resolution">Resolution</Label>
                <Select value={resolution} onValueChange={setResolution}>
                  <SelectTrigger id="resolution">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {resolutionOptions.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {validation ? <CapabilityGuard validation={validation} /> : null}

            <Button type="submit" disabled={busy || avatarSelectionMissing} className="w-fit">
              {busy ? "Creating…" : "Create reel"}
            </Button>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
