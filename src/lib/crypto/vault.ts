/**
 * Supabase Vault wrapper (Assumption 6 / brief §4): provider_keys stores a
 * `vault_secret_id`; the raw key is decrypted server/worker-side only, via
 * the `vault_create_secret`/`vault_read_secret` SECURITY DEFINER RPCs
 * defined in supabase/migrations/0001_init.sql (EXECUTE granted to
 * service_role only). Never call these from a browser-facing code path
 * (enforced by code organization/review — see src/lib/supabase/service.ts
 * for why the `server-only` package isn't used here: it's incompatible
 * with the plain-Node contexts this module must also run in, Vitest and
 * the tsx-run worker).
 */
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { Provider } from "@/src/lib/db/enums";

/** Creates a new Vault secret and returns its id (for provider_keys.vault_secret_id). */
export async function createSecret(
  supa: ServiceClient,
  secret: string,
  name: string,
  description = ""
): Promise<string> {
  const { data, error } = await supa.rpc("vault_create_secret", {
    p_secret: secret,
    p_name: name,
    p_description: description,
  });
  if (error) throw new Error(`vault_create_secret failed: ${error.message}`);
  return data as string;
}

async function readSecret(supa: ServiceClient, vaultSecretId: string): Promise<string> {
  const { data, error } = await supa.rpc("vault_read_secret", { p_secret_id: vaultSecretId });
  if (error) throw new Error(`vault_read_secret failed: ${error.message}`);
  if (!data) throw new Error(`Vault secret ${vaultSecretId} not found or empty`);
  return data as string;
}

/**
 * Nano Banana and Veo are both Google-direct and share the client's one
 * Google/Gemini key (spec §2.2 provider_keys note): Stage 1 writes both
 * provider_keys rows when a client enters a single Google key, and
 * KeyResolver falls back to the sibling row if only one was ever written —
 * so adapters never need to know about the duplication.
 */
const GOOGLE_BACKED_PROVIDERS: readonly Provider[] = ["nano_banana", "veo"];

/** `StageContext.keys` (spec §6) — resolves a client's decrypted provider key. */
export interface KeyResolver {
  forProvider(clientId: string, provider: Provider): Promise<string>;
  decrypt(vaultSecretId: string): Promise<string>;
}

export function createKeyResolver(supa: ServiceClient): KeyResolver {
  return {
    async forProvider(clientId, provider) {
      const { data, error } = await supa
        .from("provider_keys")
        .select("vault_secret_id")
        .eq("client_id", clientId)
        .eq("provider", provider)
        .maybeSingle();
      if (error) throw new Error(`provider_keys lookup failed: ${error.message}`);

      if (data) return readSecret(supa, (data as { vault_secret_id: string }).vault_secret_id);

      if (GOOGLE_BACKED_PROVIDERS.includes(provider)) {
        const sibling = GOOGLE_BACKED_PROVIDERS.find((p) => p !== provider);
        if (sibling) {
          const { data: siblingRow, error: siblingError } = await supa
            .from("provider_keys")
            .select("vault_secret_id")
            .eq("client_id", clientId)
            .eq("provider", sibling)
            .maybeSingle();
          if (siblingError) throw new Error(`provider_keys lookup failed: ${siblingError.message}`);
          if (siblingRow) {
            return readSecret(supa, (siblingRow as { vault_secret_id: string }).vault_secret_id);
          }
        }
      }

      throw new Error(`No ${provider} API key configured for client ${clientId}`);
    },

    async decrypt(vaultSecretId) {
      return readSecret(supa, vaultSecretId);
    },
  };
}
