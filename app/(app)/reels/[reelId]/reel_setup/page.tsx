"use client";

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Slider } from "@/app/components/ui/slider";
import { Switch } from "@/app/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select";
import { CapabilityGuard } from "@/app/components/CapabilityGuard";
import { ModelConstraintsPanel } from "@/app/components/ModelConstraintsPanel";
import { reelConstraintSets } from "@/src/lib/modelConstraints";
import { useApiResource } from "@/app/hooks/useApiResource";
import { useFileUpload } from "@/app/hooks/useFileUpload";
import { routes } from "@/src/lib/routes";
import { VEO_VARIANT_LABELS, allowedAspectRatios, allowedResolutions } from "@/src/lib/brollModels";
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  ORCHESTRATOR_MODEL_LABELS,
} from "@/src/lib/orchestratorModels";
import type { Reel, ReelConfigRow } from "@/src/lib/db/types";
import type { ValidationResult } from "@/src/adapters/types";

interface ReelResponse {
  reel: Reel;
  reel_config: ReelConfigRow;
}

interface ConfigAvatar {
  id: string;
  name: string;
  preview_image_url: string | null;
}

interface ClientAvatarsResponse {
  avatars: ConfigAvatar[];
}

/**
 * Reel setup — edit an already-created reel's config (spec §7 Stage 2's
 * edit path, PATCH /api/reels/{reelId}). Previously only settable once at
 * creation time (app/(app)/clients/[clientId]/reels/new); this page reuses
 * that same form, prefilled from the current config, so the "← Reel setup"
 * link on the scene page (see reels/[reelId]/layout.tsx) has somewhere to go.
 */
export default function ReelSetupPage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const router = useRouter();

  const { data, loading, error: loadError } = useApiResource<ReelResponse>(`/api/reels/${reelId}`);
  const clientId = data?.reel.client_id ?? null;

  const [displayName, setDisplayName] = useState("");
  const [topic, setTopic] = useState("");
  const [topicDescription, setTopicDescription] = useState("");
  const [totalSeconds, setTotalSeconds] = useState(30);
  const [avatarEnabled, setAvatarEnabled] = useState(false);
  const [avatarLookId, setAvatarLookId] = useState<string | undefined>(undefined);
  const [includeBroll, setIncludeBroll] = useState(true);
  const [veoVariant, setVeoVariant] = useState("fast");
  const [orchestratorModel, setOrchestratorModel] = useState<string>(DEFAULT_ORCHESTRATOR_MODEL);
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [resolution, setResolution] = useState("1080p");
  const [productRefs, setProductRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  // Seed the form once the current config loads.
  useEffect(() => {
    if (!data) return;
    const cfg = data.reel_config;
    setDisplayName(data.reel.display_name);
    setTopic(cfg.topic);
    setTopicDescription(cfg.topic_description ?? "");
    setTotalSeconds(cfg.total_seconds_target);
    setAvatarEnabled(cfg.avatar_enabled);
    setAvatarLookId(cfg.avatar_look_id ?? undefined);
    setIncludeBroll(!!cfg.broll_provider);
    setVeoVariant(cfg.veo_variant);
    setOrchestratorModel(cfg.orchestrator_model ?? DEFAULT_ORCHESTRATOR_MODEL);
    setAspectRatio(cfg.aspect_ratio);
    setResolution(cfg.resolution);
    setProductRefs(cfg.product_reference_paths ?? []);
  }, [data]);

  const { upload, uploading } = useFileUpload(clientId ?? "");

  async function handleAddProductRefs(files: FileList) {
    const uploaded: string[] = [];
    for (const file of Array.from(files)) uploaded.push(await upload(file, "asset", reelId));
    setProductRefs((prev) => [...prev, ...uploaded]);
  }

  const { data: avatarsData } = useApiResource<ClientAvatarsResponse>(
    avatarEnabled && clientId ? `/api/clients/${clientId}` : null
  );
  const avatars = avatarsData?.avatars ?? [];

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

  // Resolved from live form state, not from the saved row, so the limits update
  // as the model/resolution dropdowns change rather than only after a save —
  // the choice and its consequences are on screen at the same moment.
  // music_provider is omitted: it is chosen later, on the music page.
  const constraintSets = reelConstraintSets({
    broll_provider: brollProvider ?? null,
    veo_variant: veoVariant,
    avatar_enabled: avatarEnabled,
    image_provider: "nano_banana",
    music_provider: null,
    aspect_ratio: aspectRatio,
    resolution,
    has_product_references: productRefs.length > 0,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (avatarSelectionMissing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: displayName || undefined,
          topic,
          topic_description: topicDescription || undefined,
          total_seconds_target: totalSeconds,
          avatar_enabled: avatarEnabled,
          avatar_look_id: avatarEnabled ? avatarLookId : undefined,
          broll_provider: brollProvider,
          image_provider: "nano_banana",
          veo_variant: veoVariant,
          orchestrator_model: orchestratorModel,
          aspect_ratio: aspectRatio,
          resolution,
          product_reference_paths: productRefs,
        }),
      });
      const resData = await res.json();
      if (resData.validation) setValidation(resData.validation as ValidationResult);
      if (!res.ok) throw new Error(resData.error ?? "failed to save setup");
      router.push(routes.reelStage(reelId, "scene"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return <main className="mx-auto flex max-w-xl flex-col gap-6 p-8 text-sm text-muted-foreground">Loading…</main>;
  }

  if (loadError || !data) {
    return <main className="mx-auto flex max-w-xl flex-col gap-6 p-8 text-sm text-destructive">{loadError ?? "Reel not found."}</main>;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Reel setup</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="display_name">Reel name</Label>
              <Input
                id="display_name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How this reel is listed on the dashboard"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="topic">Topic</Label>
              <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)} required />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="topic_description">Topic description</Label>
              <Textarea
                id="topic_description"
                value={topicDescription}
                onChange={(e) => setTopicDescription(e.target.value)}
                rows={4}
                placeholder="What content to keep and how to treat it — extra context for scene generation"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="seconds">Total seconds (target)</Label>
              <div className="flex items-center gap-3">
                <Slider
                  id="seconds"
                  min={6}
                  max={180}
                  step={1}
                  value={[totalSeconds]}
                  onValueChange={([v]) => setTotalSeconds(v)}
                  className="flex-1"
                />
                <span className="w-12 shrink-0 text-right text-sm text-muted-foreground">{totalSeconds}s</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="product_refs">Product reference photos</Label>
              <input
                id="product_refs"
                type="file"
                accept="image/*"
                multiple
                disabled={uploading || !clientId}
                onChange={(e) => {
                  if (e.target.files?.length) handleAddProductRefs(e.target.files);
                  e.target.value = "";
                }}
                className="text-sm"
              />
              <span className="text-xs text-muted-foreground">
                {uploading
                  ? "Uploading…"
                  : `${productRefs.length} attached — sent as reference images with every image and clip generated for this reel.`}
              </span>
              {productRefs.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {productRefs.map((path) => (
                    <li key={path} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{path.split("/").pop()}</span>
                      <button
                        type="button"
                        className="text-destructive underline"
                        onClick={() => setProductRefs((prev) => prev.filter((p) => p !== path))}
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
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
                    {clientId ? (
                      <Link href={routes.clientConfig(clientId)} className="text-primary underline">
                        Go to Config
                      </Link>
                    ) : null}
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

            <div className="flex flex-col gap-1">
              <Label htmlFor="orchestrator_model">Orchestrating LLM</Label>
              <Select value={orchestratorModel} onValueChange={setOrchestratorModel}>
                <SelectTrigger id="orchestrator_model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ORCHESTRATOR_MODEL_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                Writes this reel&apos;s scenes and prompts. Applies to the whole reel.
              </span>
            </div>

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

            <div className="rounded-md border border-border p-3">
              <ModelConstraintsPanel
                sets={constraintSets}
                description="The scene script is written against these, so they shape the reel before anything is generated. Most produce no error — the model quietly renders something other than what was asked for."
              />
            </div>

            {validation ? <CapabilityGuard validation={validation} /> : null}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy || avatarSelectionMissing} className="w-fit">
                {busy ? "Saving…" : "Save"}
              </Button>
              <Link href={routes.reelStage(reelId, "scene")}>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
            </div>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
