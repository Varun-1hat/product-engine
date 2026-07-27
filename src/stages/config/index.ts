/**
 * Stage 1 — Config (client-level) (spec §7 Stage 1).
 *
 * Deliberately does NOT implement the generic `StageModule<In,Out>` shape
 * (src/stages/types.ts): that scaffold's `StageContext.reelId` and
 * `advance(): Promise<StageId>` (walking reel_setup -> ... -> assembly) are
 * built for the 8 PER-REEL stages. Stage 1 is explicitly "(client-level)"
 * — one client_config is reused across many reels, so there is no reel or
 * fixed-order position here. This module exposes its own small,
 * appropriately-shaped context/functions instead of force-fitting one that
 * doesn't apply.
 *
 * Process: upsert clients+client_config; keys -> vault.create_secret ->
 * provider_keys (Google key covers Nano Banana + Veo — see
 * src/lib/crypto/vault.ts); HeyGen key -> enqueue an `avatar_pull` job
 * (worker/index.ts pulls looks -> upserts avatars). Clone copies brand kit,
 * defaults, products/media, avatar selections — never provider keys
 * (brief §16). Cost: avatar-pull is not billed.
 */
import { z } from "zod";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { JobQueue } from "@/src/lib/jobs/queue";
import type { StorageClient } from "@/src/lib/storage";
import type { KeyResolver } from "@/src/lib/crypto/vault";
import { createSecret } from "@/src/lib/crypto/vault";
import { ASPECT_RATIOS, RESOLUTIONS, PROVIDERS } from "@/src/lib/db/enums";
import type { AvatarRow, Client, ClientConfigRow, ProductRow } from "@/src/lib/db/types";

export interface ConfigStageContext {
  clientId: string;
  supa: ServiceClient;
  jobs: JobQueue;
  storage: StorageClient;
  keys: KeyResolver;
}

const brandKitSchema = z.object({
  brand_name: z.string().min(1).optional(),
  logo_path: z.string().min(1).optional(),
  default_tagline: z.string().optional(),
  fonts: z.record(z.string(), z.unknown()).optional(),
  brand_colors: z.record(z.string(), z.unknown()).optional(),
  default_aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
  default_resolution: z.enum(RESOLUTIONS).optional(),
});

const providerKeyInputSchema = z.object({
  provider: z.enum(PROVIDERS),
  api_key: z.string().min(1),
  account_label: z.string().optional(),
});

const productInputSchema = z.object({
  name: z.string().min(1),
  product_link: z.string().optional(),
});

export const configInputSchema = z.object({
  /** Existing client to update; omit (with clone_from unset) to create a brand-new client. */
  client_id: z.string().uuid().optional(),
  /** Prefill a NEW client from an existing one — keys are never copied (brief §16). */
  clone_from: z.string().uuid().optional(),
  display_name: z.string().min(1).optional(),
  brand_kit: brandKitSchema.optional(),
  provider_keys: z.array(providerKeyInputSchema).optional(),
  products: z.array(productInputSchema).optional(),
});
export type ConfigInput = z.infer<typeof configInputSchema>;

export interface ConfigOutput {
  client: Client;
  client_config: ClientConfigRow;
  avatars: AvatarRow[];
  products: ProductRow[];
}

/** Google/Gemini key backs both nano_banana and veo — write both provider_keys rows (spec §2.2). */
const GOOGLE_BACKED_PROVIDERS = ["nano_banana", "veo"] as const;

async function upsertClientConfig(
  supa: ServiceClient,
  clientId: string,
  brandKit: ConfigInput["brand_kit"]
): Promise<ClientConfigRow> {
  const patch: Record<string, unknown> = { client_id: clientId };
  if (brandKit?.brand_name !== undefined) patch.brand_name = brandKit.brand_name;
  if (brandKit?.logo_path !== undefined) patch.logo_path = brandKit.logo_path;
  if (brandKit?.default_tagline !== undefined) patch.default_tagline = brandKit.default_tagline;
  if (brandKit?.fonts !== undefined) patch.fonts = brandKit.fonts;
  if (brandKit?.brand_colors !== undefined) patch.brand_colors = brandKit.brand_colors;
  if (brandKit?.default_aspect_ratio !== undefined) patch.default_aspect_ratio = brandKit.default_aspect_ratio;
  if (brandKit?.default_resolution !== undefined) patch.default_resolution = brandKit.default_resolution;

  const { data, error } = await supa.from("client_config").upsert(patch, { onConflict: "client_id" }).select("*").single();
  if (error) throw new Error(`client_config upsert failed: ${error.message}`);
  return data as ClientConfigRow;
}

async function upsertProviderKey(
  ctx: ConfigStageContext,
  clientId: string,
  provider: string,
  vaultSecretId: string,
  accountLabel?: string
): Promise<void> {
  const { error } = await ctx.supa
    .from("provider_keys")
    .upsert(
      { client_id: clientId, provider, vault_secret_id: vaultSecretId, account_label: accountLabel ?? null },
      { onConflict: "client_id,provider" }
    );
  if (error) throw new Error(`provider_keys upsert failed: ${error.message}`);
}

async function handleProviderKeys(ctx: ConfigStageContext, clientId: string, keys: ConfigInput["provider_keys"]) {
  if (!keys || keys.length === 0) return;

  for (const entry of keys) {
    const vaultSecretId = await createSecret(
      ctx.supa,
      entry.api_key,
      `${clientId}:${entry.provider}`,
      entry.account_label ?? ""
    );

    if ((GOOGLE_BACKED_PROVIDERS as readonly string[]).includes(entry.provider)) {
      // One Google key covers both nano_banana and veo — write both rows
      // pointing at the same secret (KeyResolver also falls back, but this
      // is the primary mechanism per spec §2.2).
      for (const googleProvider of GOOGLE_BACKED_PROVIDERS) {
        await upsertProviderKey(ctx, clientId, googleProvider, vaultSecretId, entry.account_label);
      }
    } else {
      await upsertProviderKey(ctx, clientId, entry.provider, vaultSecretId, entry.account_label);
    }

    if (entry.provider === "heygen") {
      // Async avatar pull (job_type_t 'avatar_pull' — client-level, no reel
      // yet, hence jobs.reel_id is nullable). worker/index.ts processes it.
      await ctx.jobs.enqueue({
        reel_id: null,
        type: "avatar_pull",
        provider: "heygen",
        payload: { client_id: clientId },
      });
    }
  }
}

async function insertProducts(supa: ServiceClient, clientId: string, products: ConfigInput["products"]) {
  if (!products || products.length === 0) return;
  const { error } = await supa
    .from("products")
    .insert(products.map((p) => ({ client_id: clientId, name: p.name, product_link: p.product_link ?? null })));
  if (error) throw new Error(`products insert failed: ${error.message}`);
}

async function cloneClient(supa: ServiceClient, fromClientId: string, displayName: string): Promise<string> {
  const { data: source, error: sourceError } = await supa
    .from("clients")
    .select("*")
    .eq("id", fromClientId)
    .single();
  if (sourceError) throw new Error(`clients lookup (clone_from) failed: ${sourceError.message}`);

  const { data: newClient, error: newClientError } = await supa
    .from("clients")
    .insert({ display_name: displayName, cloned_from: (source as Client).id })
    .select("*")
    .single();
  if (newClientError) throw new Error(`clients insert (clone) failed: ${newClientError.message}`);
  const newClientId = (newClient as Client).id;

  const { data: sourceConfig } = await supa.from("client_config").select("*").eq("client_id", fromClientId).maybeSingle();
  if (sourceConfig) {
    const cfg = sourceConfig as ClientConfigRow;
    await supa.from("client_config").upsert(
      {
        client_id: newClientId,
        brand_name: cfg.brand_name,
        logo_path: cfg.logo_path,
        default_tagline: cfg.default_tagline,
        fonts: cfg.fonts,
        brand_colors: cfg.brand_colors,
        default_aspect_ratio: cfg.default_aspect_ratio,
        default_resolution: cfg.default_resolution,
      },
      { onConflict: "client_id" }
    );
  }

  const { data: sourceProducts } = await supa.from("products").select("*").eq("client_id", fromClientId);
  for (const product of (sourceProducts ?? []) as ProductRow[]) {
    const { data: newProduct } = await supa
      .from("products")
      .insert({ client_id: newClientId, name: product.name, product_link: product.product_link })
      .select("*")
      .single();
    if (newProduct) {
      const { data: media } = await supa.from("product_media").select("*").eq("product_id", product.id);
      for (const m of media ?? []) {
        await supa.from("product_media").insert({
          product_id: (newProduct as ProductRow).id,
          media_type: (m as { media_type: string }).media_type,
          storage_path: (m as { storage_path: string }).storage_path,
        });
      }
    }
  }

  const { data: sourceAvatars } = await supa.from("avatars").select("*").eq("client_id", fromClientId);
  for (const avatar of (sourceAvatars ?? []) as AvatarRow[]) {
    await supa.from("avatars").insert({
      client_id: newClientId,
      heygen_look_id: avatar.heygen_look_id,
      name: avatar.name,
      preview_image_url: avatar.preview_image_url,
      preview_video_url: avatar.preview_video_url,
      raw: avatar.raw,
    });
  }
  // provider_keys are NEVER copied (brief §16).

  return newClientId;
}

export async function loadConfig(ctx: ConfigStageContext): Promise<ConfigOutput | null> {
  const { data: client, error } = await ctx.supa.from("clients").select("*").eq("id", ctx.clientId).maybeSingle();
  if (error) throw new Error(`clients lookup failed: ${error.message}`);
  if (!client) return null;

  const [{ data: clientConfig }, { data: avatars }, { data: products }] = await Promise.all([
    ctx.supa.from("client_config").select("*").eq("client_id", ctx.clientId).maybeSingle(),
    ctx.supa.from("avatars").select("*").eq("client_id", ctx.clientId).order("created_at", { ascending: true }),
    ctx.supa.from("products").select("*").eq("client_id", ctx.clientId).order("created_at", { ascending: true }),
  ]);

  return {
    client: client as Client,
    client_config: (clientConfig as ClientConfigRow) ?? { client_id: ctx.clientId } as ClientConfigRow,
    avatars: (avatars ?? []) as AvatarRow[],
    products: (products ?? []) as ProductRow[],
  };
}

export async function processConfig(ctx: ConfigStageContext, input: ConfigInput): Promise<ConfigOutput> {
  let clientId = ctx.clientId;

  if (input.clone_from) {
    clientId = await cloneClient(ctx.supa, input.clone_from, input.display_name ?? "Cloned client");
  } else if (!input.client_id) {
    const { data, error } = await ctx.supa
      .from("clients")
      .insert({ display_name: input.display_name ?? "Untitled client" })
      .select("*")
      .single();
    if (error) throw new Error(`clients insert failed: ${error.message}`);
    clientId = (data as Client).id;
  } else if (input.display_name) {
    const { error } = await ctx.supa.from("clients").update({ display_name: input.display_name }).eq("id", clientId);
    if (error) throw new Error(`clients update failed: ${error.message}`);
  }

  const scopedCtx: ConfigStageContext = { ...ctx, clientId };

  await upsertClientConfig(scopedCtx.supa, clientId, input.brand_kit);
  await handleProviderKeys(scopedCtx, clientId, input.provider_keys);
  await insertProducts(scopedCtx.supa, clientId, input.products);

  const result = await loadConfig(scopedCtx);
  if (!result) throw new Error(`config: client ${clientId} not found after processing`);
  return result;
}
