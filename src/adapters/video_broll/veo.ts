/**
 * Veo 3.1 — video_broll adapter (spec §3.3, §14.2). WAVE 1, full. See
 * skills/providers/veo/SKILL.md.
 *
 * Async, no webhook — src/lib/jobs/reconcile.ts polls. Emits native audio
 * (stripped on ingest/assembly elsewhere); supports_end_frame=true is what
 * makes shared-boundary continuity possible (§2.4 routing rule).
 *
 * IMPORTANT contract-shape note (see also src/lib/jobs/reconcile.ts): the given
 * `poll(provider_job_id, provider_key)` signature (spec §3) carries no
 * client_id/reel_id/asset_id/aspect_ratio/resolution/duration_s/variant —
 * only what's needed to ask Google for status. So poll() persists the
 * finished video under a self-contained path keyed on provider+job id
 * (buildPollResultPath — nothing in this system parses paths back apart)
 * and reports BEST-EFFORT metadata/units/variant. The orchestrator
 * (src/lib/jobs/reconcile.ts), which already has the full `jobs` row (including
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
import { VEO_VARIANTS, type VeoVariant } from "@/src/lib/db/enums";
import { isVeoVariant, veoCapabilitiesFor, VEO_VARIANT_CAPABILITIES as VARIANT_CAPABILITIES } from "./veoCapabilities";

export interface VeoDeps {
  storage: StorageClient;
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
 * itself. Exported so src/stages/clip, src/stages/outro, and src/lib/jobs/outro.ts
 * all compose the exact same string.
 */
export function composeVeoVariant(bareVariant: string, resolution: string): string {
  return `${bareVariant}@${resolution}`;
}

/** Validated against the selected model's own limits, not against all four. */
function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (input.variant && !isVeoVariant(input.variant)) {
    return {
      ok: false,
      violations: [`variant "${input.variant}" must be one of ${VEO_VARIANTS.join("|")}`],
      warnings,
    };
  }
  const variant: VeoVariant = isVeoVariant(input.variant) ? input.variant : "fast";
  const caps = VARIANT_CAPABILITIES[variant];
  const model = VEO_CONFIG.models[variant];

  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");
  if (input.aspect_ratio && !caps.supported_aspect_ratios.includes(input.aspect_ratio)) {
    violations.push(`aspect_ratio "${input.aspect_ratio}" is not supported by ${model}`);
  }
  if (input.resolution && !caps.supported_resolutions.includes(input.resolution)) {
    violations.push(`resolution "${input.resolution}" is not supported by ${model}`);
  }
  if (!input.start_image) {
    violations.push("start_image is required for veo generate()");
  }
  if (input.end_image && !caps.supports_end_frame) {
    warnings.push(`${model} has no last-frame interpolation — the end frame is ignored and the boundary is a hard cut`);
  }
  if (input.duration_s != null && caps.supports_duration_control === false) {
    warnings.push(`${model} has no duration control — the clip comes back at the model's own length and Stage 6 trims it`);
  }
  if (input.duration_s != null && caps.max_duration_s != null && input.duration_s > caps.max_duration_s) {
    warnings.push(
      `requested duration_s (${input.duration_s}) exceeds ${model}'s ~${caps.max_duration_s}s max — will generate at ${caps.max_duration_s}s and Stage 6 must trim`
    );
  }
  if (
    input.resolution &&
    caps.full_duration_only_resolutions?.includes(input.resolution) &&
    input.duration_s != null &&
    caps.max_duration_s != null &&
    input.duration_s < caps.max_duration_s
  ) {
    warnings.push(
      `${model} only renders ${input.resolution} at ${caps.max_duration_s}s — generating at ${caps.max_duration_s}s and Stage 6 trims to ${input.duration_s}s`
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

/**
 * Omni interactions aren't Veo operations, so poll() (which only gets a
 * provider_job_id) needs to tell the two apart — omni ids are stored prefixed.
 */
const OMNI_JOB_PREFIX = "omni:";

/**
 * Gemini Omni Flash (preview) — image-to-video over the Interactions API.
 * `<FIRST_FRAME>` binds the scene's start image as the opening frame; there is
 * no last-frame interpolation and no duration control (docs "Limitations"), so
 * the clip is billed/trimmed against the requested duration like any other.
 * background+store so the result is retrievable later by the existing
 * reconcile pass instead of blocking the request.
 */
async function generateOmni(
  input: GenerateInput,
  startImage: { data: string; mimeType: string },
  prompt: string,
  durationS: number
): Promise<GenerateResult> {
  const ai = new GoogleGenAI({ apiKey: input.provider_key });
  const interaction = await ai.interactions.create({
    model: VEO_CONFIG.models.omni,
    input: [
      { type: "image", data: startImage.data, mime_type: startImage.mimeType },
      { type: "text", text: `<FIRST_FRAME> ${prompt}` },
    ],
    response_format: { type: "video", aspect_ratio: input.aspect_ratio, delivery: "uri" },
    generation_config: { video_config: { task: "image_to_video" } },
    background: true,
    store: true,
  } as never);

  const id = (interaction as { id?: string }).id;
  if (!id) throw new Error("omni: interactions.create returned no id to poll later");

  return {
    status: "pending",
    provider_job_id: `${OMNI_JOB_PREFIX}${id}`,
    units: durationS,
    unit_type: "second",
    variant: "omni",
    raw: { id, model: VEO_CONFIG.models.omni },
  };
}

async function pollOmni(
  interactionId: string,
  providerKey: string,
  storage: StorageClient
): Promise<GenerateResult> {
  const ai = new GoogleGenAI({ apiKey: providerKey });
  const interaction = await ai.interactions.get(interactionId);
  const status = (interaction as { status?: string }).status;
  const video = interaction.output_video;

  if (status === "failed" || status === "cancelled") {
    throw new Error(`omni: interaction ${interactionId} ended with status "${status}"`);
  }
  if (status !== "completed" || !video) {
    return {
      status: "pending",
      provider_job_id: `${OMNI_JOB_PREFIX}${interactionId}`,
      units: VEO_CONFIG.defaultDurationS,
      unit_type: "second",
      raw: interaction,
    };
  }

  const { data, mimeType } = await resolveVideoBytes(
    { videoBytes: video.data, uri: video.uri, mimeType: video.mime_type },
    providerKey
  );
  const ext = mimeType.split("/")[1] ?? "mp4";
  const path = buildPollResultPath({ provider: "veo", provider_job_id: interactionId, ext });
  await storage.upload("assets", path, data, mimeType);

  // Placeholder metadata — the orchestrator overwrites it from job.payload
  // (same contract as the Veo poll path below).
  const { width, height } = dimensionsFor("9:16", "1080p");
  return {
    status: "succeeded",
    asset: {
      storage_path: path,
      mime: mimeType,
      metadata: { width, height, aspect: "9:16", resolution: "1080p", duration_s: VEO_CONFIG.defaultDurationS, codec: "h264" },
    },
    units: VEO_CONFIG.defaultDurationS,
    unit_type: "second",
    raw: interaction,
  };
}

export function createVeoAdapter(deps: VeoDeps): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`veo validate() failed: ${validation.violations.join("; ")}`);
    }

    const variant: VeoVariant = isVeoVariant(input.variant) ? input.variant : "fast";
    const caps = VARIANT_CAPABILITIES[variant];
    const useEndFrame = Boolean(input.end_image) && Boolean(caps.supports_end_frame);
    // This model's own duration rule: 8s whenever it interpolates to a last
    // frame or renders a resolution it only offers at full length.
    const generatedDurationS =
      useEndFrame || caps.full_duration_only_resolutions?.includes(input.resolution)
        ? caps.max_duration_s ?? 8
        : billableDurationS(input.duration_s);
    const payload = modelPromptVeo(input.prompt, {
      aspectRatio: input.aspect_ratio,
      resolution: input.resolution,
    });

    const startImage = await resolveAssetRefBytes(input.start_image!);
    const endImage = useEndFrame ? await resolveAssetRefBytes(input.end_image!) : null;

    if (variant === "omni") {
      return generateOmni(input, startImage, payload.prompt, generatedDurationS);
    }

    const ai = new GoogleGenAI({ apiKey: input.provider_key });
    console.log({
      model: VEO_CONFIG.models[variant],
      prompt: payload.prompt,
      imageMime: startImage.mimeType,
      imageSize: startImage.data.length,
      hasEndFrame: !!endImage,
      aspect: payload.aspectRatio,
      resolution: payload.resolution,
      duration: generatedDurationS,
      negativePrompt: payload.negativePrompt,
    });
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
    if (providerJobId.startsWith(OMNI_JOB_PREFIX)) {
      return pollOmni(providerJobId.slice(OMNI_JOB_PREFIX.length), providerKey, storage);
    }

    const ai = new GoogleGenAI({ apiKey: providerKey });
    const handle = new GenerateVideosOperation();
    handle.name = providerJobId;
    const op = await ai.operations.getVideosOperation({ operation: handle });
    console.log("op", op);
    console.dir(op, { depth: null });
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
    capabilities: (variant?: string) => veoCapabilitiesFor(variant),
    validate: validateInput,
    estimate(input: EstimateInput) {
      const units = billableDurationS(input.duration_s);
      return { units, unit_type: "second", variant: input.variant };
    },
    generate,
    poll,
  };
}
