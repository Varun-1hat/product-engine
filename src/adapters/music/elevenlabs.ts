/**
 * ElevenLabs Music — music adapter (spec §3.4). Synchronous: POST /v1/music
 * returns the finished mp3 in one round trip, which we persist to the
 * `music/` bucket (Stage 8 reads reel_config.music_path from there).
 */
import type { Adapter, AdapterCapabilities, EstimateInput, GenerateInput, GenerateResult, ValidationResult } from "../types";
import { ELEVENLABS_CONFIG } from "../config";
import { buildGeneratedPath, type StorageClient } from "@/src/lib/storage";
import { modelPromptElevenLabs } from "@/src/skills/model-prompt/elevenlabs";

const CAPABILITIES: AdapterCapabilities = {
  category: "music",
  provider: "elevenlabs",
  min_duration_s: ELEVENLABS_CONFIG.minDurationS,
  max_duration_s: ELEVENLABS_CONFIG.maxDurationS,
  supported_aspect_ratios: [],
  supported_resolutions: [],
  accepted_inputs: ["prompt"],
  async: false,
  billing_unit: "second",
};

function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");
  const seconds = input.duration_s;
  if (seconds != null && (seconds < ELEVENLABS_CONFIG.minDurationS || seconds > ELEVENLABS_CONFIG.maxDurationS)) {
    violations.push(
      `duration_s ${seconds} is outside elevenlabs' ${ELEVENLABS_CONFIG.minDurationS}-${ELEVENLABS_CONFIG.maxDurationS}s range`
    );
  }
  return { ok: violations.length === 0, violations, warnings: [] };
}

export function createElevenLabsMusicAdapter(deps: { storage: StorageClient }): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`elevenlabs validate() failed: ${validation.violations.join("; ")}`);
    }

    const seconds = input.duration_s ?? ELEVENLABS_CONFIG.defaultDurationS;
    // Eleven Music produces vocals unless told not to, and a vocal track is
    // unusable under a product ad — enforced in code, not left to the prompt.
    const payload = modelPromptElevenLabs(input.prompt);
    const res = await fetch(`${ELEVENLABS_CONFIG.baseUrl}/v1/music`, {
      method: "POST",
      headers: { "xi-api-key": input.provider_key, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: payload.prompt,
        music_length_ms: Math.round(seconds * 1000),
        model_id: ELEVENLABS_CONFIG.model,
      }),
    });
    if (!res.ok) {
      throw new Error(`elevenlabs /v1/music failed (${res.status}): ${await res.text().catch(() => "")}`);
    }

    const path = buildGeneratedPath({
      client_id: input.client_id,
      reel_id: input.reel_id,
      idempotency_key: input.idempotency_key,
      ext: "mp3",
    });
    await storage.upload("music", path, Buffer.from(await res.arrayBuffer()), "audio/mpeg");

    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime: "audio/mpeg",
        metadata: { width: 0, height: 0, aspect: "", resolution: "", duration_s: seconds },
      },
      units: seconds,
      unit_type: "second",
      raw: { model: ELEVENLABS_CONFIG.model },
    };
  }

  return {
    id: "elevenlabs_music@1",
    category: "music",
    provider: "elevenlabs",
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    estimate(input: EstimateInput) {
      return { units: input.duration_s ?? ELEVENLABS_CONFIG.defaultDurationS, unit_type: "second" };
    },
    generate,
  };
}
