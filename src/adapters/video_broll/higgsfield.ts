/**
 * Higgsfield — video_broll adapter (spec §3.3, §14.5). WAVE 2, LOW
 * CONFIDENCE — third-party-sourced endpoint/field/pricing details, NOT
 * official docs. See skills/providers/higgsfield/SKILL.md: "verify every
 * endpoint, field, and price against the official Higgsfield developer
 * docs (cloud.higgsfield.ai) before wiring live; do a smoke test."
 *
 * Built here as the wave-2 fast-follow adapter + config seam (per the
 * phased build order) so the registry/routing is complete, but treat
 * every field below marked PLACEHOLDER/UNCONFIRMED as needing a live
 * verification pass before this is used for a real reel.
 *
 * supports_end_frame=false is the one fact the routing rule depends on:
 * it forces every Higgsfield boundary to hard_cut and skips end-image
 * generation entirely (§2.4, §8).
 */
import type {
  Adapter,
  AdapterCapabilities,
  EstimateInput,
  GenerateInput,
  GenerateResult,
  ValidationResult,
} from "../types";
import { HIGGSFIELD_CONFIG } from "../config";
import { dimensionsFor } from "../dimensions";
import { resolveAssetRefBytes } from "../assetRef";
import { modelPromptHiggsfield } from "@/src/skills/model-prompt/higgsfield";
import { buildPollResultPath, type StorageClient } from "@/src/lib/storage";

const CAPABILITIES: AdapterCapabilities = {
  category: "video_broll",
  provider: "higgsfield",
  // PLACEHOLDER: reel-supported values reused pending official docs (spec
  // §3.3: "aspect/res/duration per docs" — not yet confirmed).
  supported_aspect_ratios: ["16:9", "9:16"],
  supported_resolutions: ["720p", "1080p"],
  min_duration_s: 4,
  max_duration_s: 8,
  max_reference_images: 1, // start frame only
  supports_end_frame: false,
  emits_audio: false, // verify
  accepted_inputs: ["prompt", "start_image"],
  async: true,
  billing_unit: "credit",
};

export interface HiggsfieldDeps {
  storage: StorageClient;
}

function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = ["higgsfield is a WAVE 2 / low-confidence integration — verify against official docs before relying on this in production"];

  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");
  if (!input.start_image) violations.push("start_image is required for higgsfield generate()");
  if (input.end_image) {
    warnings.push("higgsfield has no confirmed end-frame support — end_image will be ignored");
  }
  if (input.aspect_ratio && !CAPABILITIES.supported_aspect_ratios.includes(input.aspect_ratio)) {
    violations.push(`aspect_ratio "${input.aspect_ratio}" is not in higgsfield's (placeholder) supported set`);
  }
  if (input.resolution && !CAPABILITIES.supported_resolutions.includes(input.resolution)) {
    violations.push(`resolution "${input.resolution}" is not in higgsfield's (placeholder) supported set`);
  }

  return { ok: violations.length === 0, violations, warnings };
}

/** UNCONFIRMED: credit cost per generation is not public; using duration_s as the closest proxy until confirmed (see rate_card §14.4 — no seed row, rate_missing=true until set). */
function estimatedUnits(durationS?: number): number {
  return durationS ?? 8;
}

interface HiggsfieldGenerationEnvelope {
  generation_id?: string;
  id?: string;
  status?: string;
  output_url?: string;
  url?: string;
  error?: string;
  data?: { generation_id?: string; status?: string; output_url?: string; url?: string; error?: string };
}

function extractGenerationId(json: HiggsfieldGenerationEnvelope): string | undefined {
  return json.generation_id ?? json.id ?? json.data?.generation_id ?? undefined;
}
function extractStatus(json: HiggsfieldGenerationEnvelope): string | undefined {
  return json.status ?? json.data?.status ?? undefined;
}
function extractOutputUrl(json: HiggsfieldGenerationEnvelope): string | undefined {
  return json.output_url ?? json.url ?? json.data?.output_url ?? json.data?.url ?? undefined;
}

export function createHiggsfieldAdapter(deps: HiggsfieldDeps): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`higgsfield validate() failed: ${validation.violations.join("; ")}`);
    }

    const durationS = input.duration_s ?? CAPABILITIES.max_duration_s ?? 8;
    const payload = modelPromptHiggsfield(input.prompt);
    const startImage = await resolveAssetRefBytes(input.start_image!);

    const res = await fetch(`${HIGGSFIELD_CONFIG.baseUrl}/v1/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.provider_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "image-to-video",
        input_image: `data:${startImage.mimeType};base64,${startImage.data}`,
        prompt: payload.prompt,
        duration: durationS,
        fps: 30,
        motion_intensity: payload.motion_intensity,
      }),
    });

    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      throw new Error(`higgsfield: POST /v1/generations failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as HiggsfieldGenerationEnvelope;
    const generationId = extractGenerationId(json);
    if (!generationId) {
      throw new Error("higgsfield: POST /v1/generations response had no generation_id");
    }

    return {
      status: "pending",
      provider_job_id: generationId,
      units: estimatedUnits(durationS),
      unit_type: "credit",
      raw: json,
    };
  }

  async function poll(providerJobId: string, providerKey: string): Promise<GenerateResult> {
    const res = await fetch(`${HIGGSFIELD_CONFIG.baseUrl}/v1/generations/${providerJobId}`, {
      headers: { Authorization: `Bearer ${providerKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`higgsfield: GET /v1/generations/${providerJobId} failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as HiggsfieldGenerationEnvelope;
    const status = extractStatus(json);

    if (status === "failed" || status === "error") {
      throw new Error(`higgsfield: generation ${providerJobId} failed (${json.error ?? "unknown error"})`);
    }
    if (status !== "completed") {
      return { status: "pending", provider_job_id: providerJobId, units: estimatedUnits(), unit_type: "credit", raw: json };
    }

    const outputUrl = extractOutputUrl(json);
    if (!outputUrl) {
      throw new Error(`higgsfield: generation ${providerJobId} completed with no output URL`);
    }

    const downloaded = await fetch(outputUrl);
    if (!downloaded.ok) {
      throw new Error(`higgsfield: failed to download generated video (${downloaded.status})`);
    }
    const buf = Buffer.from(await downloaded.arrayBuffer());
    const mimeType = downloaded.headers.get("content-type") ?? "video/mp4";
    const ext = mimeType.split("/")[1] ?? "mp4";
    const path = buildPollResultPath({ provider: "higgsfield", provider_job_id: providerJobId, ext });
    await storage.upload("assets", path, buf, mimeType);

    // Placeholder aspect/resolution — the orchestrator overwrites these
    // from the job's stored payload (same pattern as Veo/HeyGen).
    const { width, height } = dimensionsFor("9:16", "720p");

    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime: mimeType,
        metadata: { width, height, aspect: "9:16", resolution: "720p" },
      },
      units: estimatedUnits(),
      unit_type: "credit",
      raw: json,
    };
  }

  return {
    id: "higgsfield@1",
    category: "video_broll",
    provider: "higgsfield",
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    estimate(input: EstimateInput) {
      return { units: estimatedUnits(input.duration_s), unit_type: "credit" };
    },
    generate,
    poll,
  };
}
