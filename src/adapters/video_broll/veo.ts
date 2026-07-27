/**
 * Veo 3.1 — video_broll adapter (spec §3.3, §14.2). WAVE 1, full. See
 * skills/providers/veo/SKILL.md.
 *
 * Async, no webhook — worker/reconcile.ts polls. Emits native audio
 * (stripped on ingest/assembly elsewhere); supports_end_frame=true is what
 * makes shared-boundary continuity possible (§2.4 routing rule).
 *
 * IMPORTANT contract-shape note (see also worker/reconcile.ts): the given
 * `poll(provider_job_id, provider_key)` signature (spec §3) carries no
 * client_id/reel_id/asset_id/aspect_ratio/resolution/duration_s/variant —
 * only what's needed to ask Google for status. So poll() persists the
 * finished video under a self-contained path keyed on provider+job id
 * (buildPollResultPath — nothing in this system parses paths back apart)
 * and reports BEST-EFFORT metadata/units/variant. The orchestrator
 * (worker/reconcile.ts), which already has the full `jobs` row (including
 * `payload` — the original GenerateInput), is the authoritative source for
 * the real aspect_ratio/resolution/duration_s/variant and MUST reconcile
 * poll()'s result against `job.payload` before writing asset_versions
 * metadata and calling costEngine.log(). generate() itself has the full
 * GenerateInput and returns the correct units/variant immediately.
 */
import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";
import type {
  Adapter,
  AdapterCapabilities,
  EstimateInput,
  GenerateInput,
  GenerateResult,
  ValidationResult,
} from "../types";
import { VEO_CONFIG } from "../config";
import { dimensionsFor } from "../dimensions";
import { resolveAssetRefBytes } from "../assetRef";
import { modelPromptVeo } from "@/src/skills/model-prompt/veo";
import { buildPollResultPath, type StorageClient } from "@/src/lib/storage";
import type { VeoVariant } from "@/src/lib/db/enums";

const CAPABILITIES: AdapterCapabilities = {
  category: "video_broll",
  provider: "veo",
  min_duration_s: 4,
  max_duration_s: 8,
  supported_durations_s: [4, 6, 8],
  supported_aspect_ratios: ["16:9", "9:16"],
  supported_resolutions: ["720p", "1080p"],
  max_reference_images: 2, // start + end frame
  supports_end_frame: true,
  emits_audio: true,
  accepted_inputs: ["prompt", "start_image", "end_image"],
  async: true,
  billing_unit: "second",
};

export interface VeoDeps {
  storage: StorageClient;
}

function isVeoVariant(value: string | undefined): value is VeoVariant {
  return value === "standard" || value === "fast";
}

/**
 * Veo generates ~8s clips; if a shorter scene.seconds is requested, this
 * requests the smallest of [4,6,8] that is >= requested (else the 8s max)
 * and Stage 6 trims to scene.seconds afterward. Billing uses this
 * *generated* duration, never the trimmed length (§3.3, §14.2). Exported so
 * the orchestrator can recompute the same billed units deterministically
 * from a job's stored payload when poll() completes.
 */
export function billableDurationS(requestedSeconds?: number): 4 | 6 | 8 {
  if (requestedSeconds == null) return VEO_CONFIG.defaultDurationS as 4 | 6 | 8;
  for (const option of VEO_CONFIG.supportedDurationsS) {
    if (option >= requestedSeconds) return option;
  }
  return 8;
}

/**
 * rate_card seeds Veo rows resolution-qualified (variant =
 * '<veo_variant>@<resolution>' — supabase/migrations/0004_seed_rate_card.sql,
 * whose own comment states this exact contract). validate()/generate() above
 * need the BARE veo_variant ("standard"/"fast") to pick a model id and to
 * pass the `isVeoVariant` check, so this composition must be used ONLY for
 * billing context (EstimateCall.variant, and the job.payload.variant a
 * completed job is cost-logged with) — never inside GenerateInput.variant
 * itself. Exported so src/stages/clip, src/stages/outro, and worker/outro.ts
 * all compose the exact same string.
 */
export function composeVeoVariant(bareVariant: string, resolution: string): string {
  return `${bareVariant}@${resolution}`;
}

function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");
  if (input.aspect_ratio && !CAPABILITIES.supported_aspect_ratios.includes(input.aspect_ratio)) {
    violations.push(`aspect_ratio "${input.aspect_ratio}" is not supported by veo`);
  }
  if (input.resolution && !CAPABILITIES.supported_resolutions.includes(input.resolution)) {
    violations.push(`resolution "${input.resolution}" is not supported by veo`);
  }
  if (input.variant && !isVeoVariant(input.variant)) {
    violations.push(`variant "${input.variant}" must be one of standard|fast`);
  }
  if (!input.start_image) {
    violations.push("start_image is required for veo generate()");
  }
  if (input.duration_s != null && input.duration_s > (CAPABILITIES.max_duration_s ?? 8)) {
    warnings.push(
      `requested duration_s (${input.duration_s}) exceeds Veo's ~${CAPABILITIES.max_duration_s}s max — will generate at ${CAPABILITIES.max_duration_s}s and Stage 6 must trim`
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}

interface VeoVideo {
  uri?: string;
  videoBytes?: string;
  mimeType?: string;
}

async function resolveVideoBytes(
  video: VeoVideo,
  providerKey: string
): Promise<{ data: string; mimeType: string }> {
  const mimeType = video.mimeType ?? "video/mp4";
  if (video.videoBytes) {
    return { data: video.videoBytes, mimeType };
  }
  if (video.uri) {
    // Gemini-hosted result URIs are short-lived (~2 days per the skill) and
    // gated the same way as other Generative Language API calls.
    const res = await fetch(video.uri, { headers: { "x-goog-api-key": providerKey } });
    if (!res.ok) {
      throw new Error(`veo: failed to download generated video (${res.status} ${res.statusText})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType: res.headers.get("content-type") ?? mimeType };
  }
  throw new Error("veo: generated video has neither videoBytes nor uri");
}

export function createVeoAdapter(deps: VeoDeps): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`veo validate() failed: ${validation.violations.join("; ")}`);
    }

    const variant: VeoVariant = isVeoVariant(input.variant) ? input.variant : "fast";
    const generatedDurationS = billableDurationS(input.duration_s);
    const payload = modelPromptVeo(input.prompt, {
      aspectRatio: input.aspect_ratio,
      resolution: input.resolution,
    });

    const startImage = await resolveAssetRefBytes(input.start_image!);
    const endImage = input.end_image ? await resolveAssetRefBytes(input.end_image) : null;

    const ai = new GoogleGenAI({ apiKey: input.provider_key });
    const op = await ai.models.generateVideos({
      model: VEO_CONFIG.models[variant],
      prompt: payload.prompt,
      image: { imageBytes: startImage.data, mimeType: startImage.mimeType },
      config: {
        lastFrame: endImage ? { imageBytes: endImage.data, mimeType: endImage.mimeType } : undefined,
        aspectRatio: payload.aspectRatio,
        resolution: payload.resolution,
        negativePrompt: payload.negativePrompt,
        numberOfVideos: 1,
        durationSeconds: generatedDurationS,
      },
    });

    if (!op.name) {
      throw new Error("veo: generateVideos operation has no name to poll later");
    }

    return {
      status: "pending",
      provider_job_id: op.name,
      units: generatedDurationS,
      unit_type: "second",
      variant,
      raw: { name: op.name, model: VEO_CONFIG.models[variant] },
    };
  }

  async function poll(providerJobId: string, providerKey: string): Promise<GenerateResult> {
    const ai = new GoogleGenAI({ apiKey: providerKey });
    const handle = new GenerateVideosOperation();
    handle.name = providerJobId;
    const op = await ai.operations.getVideosOperation({ operation: handle });

    if (!op.done) {
      return {
        status: "pending",
        provider_job_id: providerJobId,
        units: VEO_CONFIG.defaultDurationS,
        unit_type: "second",
        raw: op,
      };
    }

    const video = op.response?.generatedVideos?.[0]?.video;
    if (!video) {
      throw new Error(
        `veo: operation ${providerJobId} completed with no generated video (error=${JSON.stringify(op.error ?? null)})`
      );
    }

    const { data, mimeType } = await resolveVideoBytes(video, providerKey);
    const ext = mimeType.split("/")[1] ?? "mp4";
    const path = buildPollResultPath({ provider: "veo", provider_job_id: providerJobId, ext });
    await storage.upload("assets", path, data, mimeType);

    // Placeholder aspect/resolution/duration — the orchestrator overwrites
    // these from the job's stored payload (see file header note).
    const { width, height } = dimensionsFor("9:16", "1080p");

    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime: mimeType,
        metadata: {
          width,
          height,
          aspect: "9:16",
          resolution: "1080p",
          duration_s: VEO_CONFIG.defaultDurationS,
          codec: "h264",
        },
      },
      units: VEO_CONFIG.defaultDurationS,
      unit_type: "second",
      raw: op,
    };
  }

  return {
    id: "veo@1",
    category: "video_broll",
    provider: "veo",
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    estimate(input: EstimateInput) {
      const units = billableDurationS(input.duration_s);
      return { units, unit_type: "second", variant: input.variant };
    },
    generate,
    poll,
  };
}
