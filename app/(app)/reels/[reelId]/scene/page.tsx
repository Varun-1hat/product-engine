"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";

interface SceneRow {
  id: string;
  position: number;
  type: "avatar" | "broll";
  seconds: number;
  transition_to_next: "continuous" | "hard_cut" | null;
  description: string | null;
}

interface SceneHint {
  scene_id: string;
  downgraded_to_hard_cut: boolean;
}

export default function ScenePage({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = usePromise(params);
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [hints, setHints] = useState<SceneHint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/reels/${reelId}/scene`);
    const data = await res.json();
    if (res.ok) setScenes((data.data?.scenes ?? []) as SceneRow[]);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelId]);

  async function handleGenerate(regenerate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reels/${reelId}/scene`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      setScenes(data.scenes ?? []);
      setHints(data.hints ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const downgraded = new Set(hints.filter((h) => h.downgraded_to_hard_cut).map((h) => h.scene_id));

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Stage 3 — Scenes</h1>
        <Link href={`/reels/${reelId}/image`} className="text-sm text-muted-foreground underline">
          Images →
        </Link>
      </div>

      <div className="flex gap-2">
        <Button onClick={() => handleGenerate(scenes.length === 0)} disabled={busy}>
          {busy ? "Working…" : scenes.length === 0 ? "Generate scenes" : "Save"}
        </Button>
        {scenes.length > 0 ? (
          <Button variant="outline" onClick={() => handleGenerate(true)} disabled={busy}>
            Re-run scene-brain
          </Button>
        ) : null}
      </div>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}

      <div className="flex flex-col gap-2">
        {scenes.map((scene) => (
          <Card key={scene.id}>
            <CardContent className="flex items-center justify-between gap-3 p-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    #{scene.position + 1} · {scene.type} · {scene.seconds}s
                  </span>
                  {scene.transition_to_next ? <Badge variant="outline">{scene.transition_to_next}</Badge> : null}
                  {downgraded.has(scene.id) ? (
                    <Badge variant="warning">downgraded to hard_cut (model lacks end-frame support)</Badge>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">{scene.description}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
