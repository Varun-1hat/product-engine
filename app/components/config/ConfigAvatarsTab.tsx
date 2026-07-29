"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/app/components/ui/alert-dialog";
import { useApiResource } from "@/app/hooks/useApiResource";

interface ConfigAvatar {
  id: string;
  name: string;
  preview_image_url: string | null;
}

interface ConfigResponse {
  avatars: ConfigAvatar[];
}

/**
 * Config > Avatars tab (spec §2.4/§8.2). Upgrades the plain Badge-per-avatar
 * list into real preview cards: a pencil affordance turns the name into an
 * inline rename form (PATCH /api/clients/{clientId}/avatars/{avatarId}),
 * and a remove affordance opens an AlertDialog confirmation before DELETEing
 * the same route. No "add avatar" control — avatars are only ever populated
 * via the existing HeyGen key -> avatar_pull job flow (Keys tab).
 */
export function ConfigAvatarsTab({ clientId }: { clientId: string }) {
  const { data, loading, error, reload } = useApiResource<ConfigResponse>(`/api/clients/${clientId}`);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  function startEdit(avatar: ConfigAvatar) {
    setEditingId(avatar.id);
    setDraftName(avatar.name);
    setRowError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftName("");
  }

  async function saveEdit(avatarId: string) {
    setBusyId(avatarId);
    setRowError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/avatars/${avatarId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draftName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "rename failed");
      setEditingId(null);
      setDraftName("");
      await reload();
    } catch (err) {
      setRowError({ id: avatarId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function removeAvatar(avatarId: string) {
    setBusyId(avatarId);
    setRowError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/avatars/${avatarId}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "remove failed");
      await reload();
    } catch (err) {
      setRowError({ id: avatarId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Avatars (HeyGen looks)</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {data && data.avatars.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None pulled yet — save a HeyGen key in the Keys tab, then refresh in a few seconds (avatar_pull runs in
            the worker).
          </p>
        ) : null}

        {data && data.avatars.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {data.avatars.map((avatar) => (
              <div key={avatar.id} className="flex w-48 flex-col gap-2 rounded-md border border-border p-3">
                {avatar.preview_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed/external Storage URL, not a static asset
                  <img
                    src={avatar.preview_image_url}
                    alt={avatar.name}
                    className="h-32 w-full rounded-md border border-border object-cover"
                  />
                ) : (
                  <div className="flex h-32 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted p-2 text-center text-xs text-muted-foreground">
                    {avatar.name}
                  </div>
                )}

                {editingId === avatar.id ? (
                  <div className="flex flex-col gap-2">
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      disabled={busyId === avatar.id}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => saveEdit(avatar.id)}
                        disabled={busyId === avatar.id || draftName.trim().length === 0}
                      >
                        {busyId === avatar.id ? "Saving…" : "Save"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={cancelEdit} disabled={busyId === avatar.id}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium" title={avatar.name}>
                      {avatar.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEdit(avatar)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Rename ${avatar.name}`}
                      title="Rename"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" disabled={busyId === avatar.id}>
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {avatar.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Reels already using this avatar keep working, but it won&apos;t be selectable for new ones.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => removeAvatar(avatar.id)}>
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                {rowError && rowError.id === avatar.id ? (
                  <span className="text-xs text-destructive">{rowError.message}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
