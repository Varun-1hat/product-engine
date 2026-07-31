/**
 * Brand context shared by the runtime skills (scene-brain, image-prompt)
 * across stages — one place to build the `BrandContext` from client_config.
 */
import type { ServiceClient } from "./supabase/service";
import type { BrandContext } from "@/src/skills/types";
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
