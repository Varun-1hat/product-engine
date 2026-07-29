/**
 * worker/endframe.ts — Stage 7 branded end-frame render (job_type_t
 * 'endframe_render', spec §7 Stage 7, Assumption 5). Deterministic
 * HTML/CSS -> satori -> @resvg/resvg-js PNG. No AI generation.
 *
 * Fonts: satori requires at least one real font file to shape text. This
 * build bundles Noto Sans (Apache/SIL-OFL, the same font Next.js's own
 * @vercel/og ships) as the working default at worker/assets/fonts —
 * copied into this repo rather than read out of next's internal dist path
 * so the worker doesn't depend on Next's internals. "Brand fonts honored"
 * (Assumption 5) is a seam: client_config.fonts can carry a brand font
 * reference to fetch/embed here later — swapping the `fonts` array below
 * is the only change needed; no other code changes.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import { dimensionsFor } from "@/src/adapters/dimensions";
import { getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import type { Job } from "@/src/lib/jobs/queue";
import { fileURLToPath } from "node:url";

export interface EndframeRenderPayload {
  tagline: string | null;
}

interface BrandColors {
  background?: string;
  text?: string;
  accent?: string;
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_FONT_PATH = path.join(__dirname, "assets", "fonts", "NotoSans-Regular.ttf");
let cachedFontData: Buffer | null = null;

async function loadDefaultFont(): Promise<Buffer> {
  if (!cachedFontData) {
    cachedFontData = await readFile(DEFAULT_FONT_PATH);
  }
  return cachedFontData;
}

/**
 * satori accepts plain object literals shaped like React elements at
 * runtime (no JSX/React needed) — its .d.ts types the param as `ReactNode`
 * though, so this helper's return value is cast at the call site rather
 * than pulling a JSX toolchain into a plain .ts worker file.
 */
function buildEndFrameNode(params: {
  height: number;
  brandName: string | null;
  tagline: string | null;
  background: string;
  textColor: string;
  accent: string;
}) {
  const children: unknown[] = [];

  if (params.brandName) {
    children.push({
      type: "div",
      props: {
        style: {
          fontSize: Math.round(params.height * 0.08),
          fontWeight: 700,
          color: params.accent,
          marginBottom: Math.round(params.height * 0.03),
        },
        children: params.brandName,
      },
    });
  }

  if (params.tagline) {
    children.push({
      type: "div",
      props: {
        style: { fontSize: Math.round(params.height * 0.045), opacity: 0.92 },
        children: params.tagline,
      },
    });
  }

  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: params.background,
        color: params.textColor,
        textAlign: "center",
        padding: Math.round(params.height * 0.08),
        fontFamily: "Noto Sans",
      },
      children,
    },
  };
}

export async function renderEndFramePng(params: {
  width: number;
  height: number;
  brandName: string | null;
  tagline: string | null;
  colors: BrandColors | null;
}): Promise<Buffer> {
  const fontData = await loadDefaultFont();
  const background = params.colors?.background ?? "#0B0B0C";
  const textColor = params.colors?.text ?? "#FFFFFF";
  const accent = params.colors?.accent ?? textColor;

  const node = buildEndFrameNode({
    height: params.height,
    brandName: params.brandName,
    tagline: params.tagline,
    background,
    textColor,
    accent,
  });

  const svg = await satori(node as unknown as Parameters<typeof satori>[0], {
    width: params.width,
    height: params.height,
    fonts: [{ name: "Noto Sans", data: fontData, weight: 400, style: "normal" }],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: params.width } });
  return Buffer.from(resvg.render().asPng());
}

export async function runEndframeRenderJob(supa: ServiceClient, storage: StorageClient, job: Job): Promise<void> {
  if (!job.asset_id) throw new Error(`endframe_render job ${job.id} has no asset_id`);
  if (!job.reel_id) throw new Error(`endframe_render job ${job.id} has no reel_id`);
  const payload = (job.payload as unknown as EndframeRenderPayload) ?? { tagline: null };

  const asset = await getAsset(supa, job.asset_id);

  const { data: reelRow, error: reelError } = await supa.from("reels").select("client_id").eq("id", job.reel_id).single();
  if (reelError) throw new Error(`reels lookup failed: ${reelError.message}`);
  const clientId = (reelRow as { client_id: string }).client_id;

  const { data: reelConfigRow, error: reelConfigError } = await supa
    .from("reel_config")
    .select("aspect_ratio, resolution")
    .eq("reel_id", job.reel_id)
    .single();
  if (reelConfigError) throw new Error(`reel_config lookup failed: ${reelConfigError.message}`);
  const { aspect_ratio, resolution } = reelConfigRow as { aspect_ratio: string; resolution: string };

  const { data: clientConfigRow } = await supa
    .from("client_config")
    .select("brand_name, brand_colors")
    .eq("client_id", clientId)
    .maybeSingle();
  const clientConfig = clientConfigRow as { brand_name: string | null; brand_colors: BrandColors | null } | null;

  const { width, height } = dimensionsFor(aspect_ratio, resolution);
  const png = await renderEndFramePng({
    width,
    height,
    brandName: clientConfig?.brand_name ?? null,
    tagline: payload.tagline,
    colors: clientConfig?.brand_colors ?? null,
  });

  const destPath = `${clientId}/${job.reel_id}/generated/endframe/${asset.id}-${Date.now()}.png`;
  await storage.upload("assets", destPath, png, "image/png");

  await upsertAssetVersion(supa, {
    assetId: asset.id,
    reel_id: job.reel_id,
    slot: "end_frame_image",
    media_type: "image",
    storage_path: destPath,
    source: "generated",
    provider: null,
    metadata: { width, height, aspect: aspect_ratio, resolution, mime: "image/png" },
  });
}
