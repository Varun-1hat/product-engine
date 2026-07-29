"use client";

import { use as usePromise } from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { ConfigBrandTab } from "@/app/components/config/ConfigBrandTab";
import { ConfigKeysTab } from "@/app/components/config/ConfigKeysTab";
import { ConfigProductsTab } from "@/app/components/config/ConfigProductsTab";
import { ConfigAvatarsTab } from "@/app/components/config/ConfigAvatarsTab";
import { useApiResource } from "@/app/hooks/useApiResource";
import { routes } from "@/src/lib/routes";

interface ClientResponse {
  client: { id: string; display_name: string };
}

/**
 * Config page (spec §2.4) — thin shell only. All real tab content lives in
 * app/components/config/Config*Tab.tsx so later waves can extend each tab
 * independently without touching this file or each other.
 */
export default function ClientConfigPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = usePromise(params);
  const { data } = useApiResource<ClientResponse>(`/api/clients/${clientId}`);
  const displayName = data?.client.display_name ?? "…";

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Config</span>
        <h1 className="text-2xl font-semibold">
          <Link href={routes.client(clientId)} className="hover:underline">
            ← {displayName}
          </Link>
        </h1>
      </div>

      <Tabs defaultValue="brand">
        <TabsList>
          <TabsTrigger value="brand">Brand</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="avatars">Avatars</TabsTrigger>
        </TabsList>
        <TabsContent value="brand">
          <ConfigBrandTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="keys">
          <ConfigKeysTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="products">
          <ConfigProductsTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="avatars">
          <ConfigAvatarsTab clientId={clientId} />
        </TabsContent>
      </Tabs>
    </main>
  );
}
