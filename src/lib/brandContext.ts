/**
 * Brand/product context shared by the runtime skills (scene-brain,
 * image-prompt) across stages — one place to build the `BrandContext` /
 * product-photo list from client_config + products + product_media.
 */
import type { ServiceClient } from "./supabase/service";
import type { BrandContext, ImagePromptProductRef } from "@/src/skills/types";
import { getClientConfigRow } from "./rows";

export async function getBrandContext(supa: ServiceClient, clientId: string): Promise<BrandContext> {
  const cfg = await getClientConfigRow(supa, clientId);
  return {
    brand_name: cfg?.brand_name ?? null,
    default_tagline: cfg?.default_tagline ?? null,
    brand_colors: cfg?.brand_colors ?? null,
    fonts: cfg?.fonts ?? null,
  };
}

export async function hasAnyProducts(supa: ServiceClient, clientId: string): Promise<boolean> {
  const { count, error } = await supa
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (error) throw new Error(`products count failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function getProductsWithPhotos(supa: ServiceClient, clientId: string): Promise<ImagePromptProductRef[]> {
  const { data: products, error } = await supa.from("products").select("*").eq("client_id", clientId);
  if (error) throw new Error(`products lookup failed: ${error.message}`);

  const result: ImagePromptProductRef[] = [];
  for (const product of (products ?? []) as Array<{ id: string; name: string }>) {
    const { data: media, error: mediaError } = await supa
      .from("product_media")
      .select("storage_path, media_type")
      .eq("product_id", product.id)
      .eq("media_type", "image");
    if (mediaError) throw new Error(`product_media lookup failed: ${mediaError.message}`);
    result.push({
      id: product.id,
      name: product.name,
      photo_paths: ((media ?? []) as Array<{ storage_path: string }>).map((m) => m.storage_path),
    });
  }
  return result;
}

export function guessMimeFromExt(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}
