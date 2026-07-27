/**
 * Nano Banana (Gemini 2.5 Flash Image) — image adapter (spec §3.2, §14.1).
 * WAVE 1, full. See skills/providers/nano-banana/SKILL.md.
 *
 * Synchronous (no job): generate() calls Gemini directly and returns the
 * uploaded asset in one round trip.
 */
import { GoogleGenAI } from "@google/genai";
import type {
  Adapter,
  AdapterCapabilities,
  EstimateInput,
  GenerateInput,
  GenerateResult,
  ValidationResult,
} from "../types";
import { NANO_BANANA_CONFIG } from "../config";
import { dimensionsFor } from "../dimensions";
import { resolveAssetRefBytes } from "../assetRef";
import { modelPromptNanoBanana } from "@/src/skills/model-prompt/nano_banana";
import { buildGeneratedPath, type StorageClient } from "@/src/lib/storage";

const CAPABILITIES: AdapterCapabilities = {
  category: "image",
  provider: "nano_banana",
  supported_aspect_ratios: ["1:1", "9:16", "16:9"],
  supported_resolutions: ["720p", "1080p"],
  max_reference_images: 8,
  accepted_inputs: ["prompt", "references"],
  async: false,
  billing_unit: "image",
};

export interface NanoBananaDeps {
  storage: StorageClient;
}

function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");
  if (input.aspect_ratio && !CAPABILITIES.supported_aspect_ratios.includes(input.aspect_ratio)) {
    violations.push(`aspect_ratio "${input.aspect_ratio}" is not supported by nano_banana`);
  }
  if (input.resolution && !CAPABILITIES.supported_resolutions.includes(input.resolution)) {
    violations.push(`resolution "${input.resolution}" is not supported by nano_banana`);
  }
  const refCount = input.references?.length ?? 0;
  if (CAPABILITIES.max_reference_images != null && refCount > CAPABILITIES.max_reference_images) {
    violations.push(
      `too many reference images (${refCount} > ${CAPABILITIES.max_reference_images})`
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}

type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function isInlineImagePart(
  part: unknown
): part is { inlineData: { data: string; mimeType: string } } {
  const inlineData = (part as { inlineData?: { data?: unknown; mimeType?: unknown } } | undefined)
    ?.inlineData;
  return typeof inlineData?.data === "string" && typeof inlineData?.mimeType === "string";
}

export function createNanoBananaAdapter(deps: NanoBananaDeps): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`nano_banana validate() failed: ${validation.violations.join("; ")}`);
    }

    const payload = modelPromptNanoBanana(input.prompt, { aspectRatio: input.aspect_ratio });

    const parts: ContentPart[] = [{ text: payload.prompt }];
    for (const ref of input.references ?? []) {
      const resolved = await resolveAssetRefBytes(ref);
      parts.push({ inlineData: { mimeType: resolved.mimeType, data: resolved.data } });
    }

    const ai = new GoogleGenAI({ apiKey: input.provider_key });
    const res = await ai.models.generateContent({
      model: NANO_BANANA_CONFIG.model,
      contents: [{ role: "user", parts }],
      config: { imageConfig: { aspectRatio: payload.aspectRatio } },
    });

    const candidateParts = res.candidates?.[0]?.content?.parts ?? [];
    const imagePart = candidateParts.find(isInlineImagePart);
    if (!imagePart) {
      throw new Error("nano_banana: generateContent returned no image (no inlineData part)");
    }

    const { data: base64, mimeType } = imagePart.inlineData;
    const ext = mimeType.split("/")[1] ?? "png";
    const path = buildGeneratedPath({
      client_id: input.client_id,
      reel_id: input.reel_id,
      asset_id: input.asset_id,
      idempotency_key: input.idempotency_key,
      ext,
    });
    await storage.upload("assets", path, base64, mimeType);

    const { width, height } = dimensionsFor(input.aspect_ratio, input.resolution);

    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime: mimeType,
        metadata: { width, height, aspect: input.aspect_ratio, resolution: input.resolution },
      },
      units: 1,
      unit_type: "image",
      raw: { model: NANO_BANANA_CONFIG.model },
    };
  }

  return {
    id: "nano_banana@1",
    category: "image",
    provider: "nano_banana",
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    estimate(input: EstimateInput) {
      return { units: input.count ?? 1, unit_type: "image" };
    },
    generate,
  };
}
