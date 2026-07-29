"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { useApiResource } from "@/app/hooks/useApiResource";

interface ConfigResponse {
  products: Array<{ id: string; name: string }>;
}

/**
 * Config > Products tab (spec §2.4, enhanced per §7.5) — the products badge
 * list split out of the old client detail page, now with an inline
 * name+product_link "Add product" form above it. PATCH /api/clients/{clientId}'s
 * `products` field is a plain insert (src/stages/config/index.ts's
 * insertProducts), so adding is additive/safe — it never replaces the
 * existing list, only appends to it; refetches on success.
 */
export function ConfigProductsTab({ clientId }: { clientId: string }) {
  const { data, loading, error, reload } = useApiResource<ConfigResponse>(`/api/clients/${clientId}`);
  const [name, setName] = useState("");
  const [productLink, setProductLink] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products: [{ name, product_link: productLink || undefined }],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "add product failed");
      setName("");
      setProductLink("");
      await reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Products{data ? ` (${data.products.length})` : ""}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="product_name">Name</Label>
            <Input id="product_name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="product_link">Link (optional)</Label>
            <Input
              id="product_link"
              value={productLink}
              onChange={(e) => setProductLink(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <Button type="submit" disabled={adding} className="w-fit">
            {adding ? "Adding…" : "Add product"}
          </Button>
        </form>
        {addError ? <span className="text-xs text-destructive">{addError}</span> : null}

        <div className="flex flex-wrap gap-2">
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {data && data.products.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products yet.</p>
          ) : null}
          {data?.products.map((p) => (
            <Badge key={p.id} variant="outline">
              {p.name}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
