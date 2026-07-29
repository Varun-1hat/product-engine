/**
 * Adapter registry (§3): `getAdapter(category, provider)`. Orchestration
 * (src/stages/*) never names a concrete model — it resolves
 * (category, effective provider) here. Capabilities drive the UI;
 * validate() blocks/warns at the boundary.
 */
import type { Category } from "@/src/lib/db/enums";
import type { Adapter } from "./types";

export interface AdapterRegistry {
  get(category: Category, provider: string): Adapter;
  tryGet(category: Category, provider: string): Adapter | undefined;
  list(category?: Category): Adapter[];
  register(adapter: Adapter): void;
}

function key(category: string, provider: string): string {
  return `${category}::${provider}`;
}

export function createAdapterRegistry(adapters: Adapter[] = []): AdapterRegistry {
  const byKey = new Map<string, Adapter>();

  const registry: AdapterRegistry = {
    register(adapter) {
      byKey.set(key(adapter.category, adapter.provider), adapter);
    },
    tryGet(category, provider) {
      return byKey.get(key(category, provider));
    },
    get(category, provider) {
      const adapter = byKey.get(key(category, provider));
      if (!adapter) {
        throw new Error(`No adapter registered for category="${category}" provider="${provider}"`);
      }
      return adapter;
    },
    list(category) {
      const all = Array.from(byKey.values());
      return category ? all.filter((a) => a.category === category) : all;
    },
  };

  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

let defaultRegistry: AdapterRegistry | null = null;

/**
 * The registry wired with every adapter this build ships (wave 1 full,
 * Higgsfield wave-2, music via ElevenLabs/Lyria, tts stub — spec §3.4/§13:
 * the seam exists so dropped providers slot in later with no
 * orchestration change). Each
 * adapter factory takes a `{ storage: StorageClient }` dependency (used to
 * persist provider output — see §3.1-§3.3 "download/upload to Storage").
 * Lazily built + cached so importing this module doesn't eagerly construct
 * SDK/Supabase clients before env vars are available.
 */
export async function getDefaultAdapterRegistry(): Promise<AdapterRegistry> {
  if (defaultRegistry) return defaultRegistry;

  const [{ createServiceClient }, { createStorageClient }] = await Promise.all([
    import("@/src/lib/supabase/service"),
    import("@/src/lib/storage"),
  ]);
  const storage = createStorageClient(createServiceClient());

  const [
    { createNanoBananaAdapter },
    { createVeoAdapter },
    { createHeygenAdapter },
    { createHiggsfieldAdapter },
    { createTtsStubAdapter },
    { createElevenLabsMusicAdapter },
    { createLyriaAdapter },
  ] = await Promise.all([
    import("./image/nano_banana"),
    import("./video_broll/veo"),
    import("./video_avatar/heygen"),
    import("./video_broll/higgsfield"),
    import("./tts/stub"),
    import("./music/elevenlabs"),
    import("./music/lyria"),
  ]);

  defaultRegistry = createAdapterRegistry([
    createNanoBananaAdapter({ storage }),
    createVeoAdapter({ storage }),
    createHeygenAdapter({ storage }),
    createHiggsfieldAdapter({ storage }),
    createTtsStubAdapter(),
    createElevenLabsMusicAdapter({ storage }),
    createLyriaAdapter({ storage }),
  ]);
  return defaultRegistry;
}
