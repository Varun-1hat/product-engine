/**
 * ElevenLabs TTS — STUB adapter (spec §3.4, §13). Deferred (brief §3, §11):
 * VO/TTS generation is a future seam, NOT built. Registered so the adapter
 * registry is complete (one new enum value + adapter + model-prompt skill
 * later, no orchestration change). Build nothing else.
 */
import type { Adapter, AdapterCapabilities, EstimateInput, GenerateInput, ValidationResult } from "../types";
import { NotImplementedError } from "../types";

const CAPABILITIES: AdapterCapabilities = {
  category: "tts",
  provider: "elevenlabs",
  supported_aspect_ratios: [],
  supported_resolutions: [],
  accepted_inputs: ["prompt"],
  async: false,
  billing_unit: "character",
};

export function createTtsStubAdapter(): Adapter {
  return {
    id: "elevenlabs_tts@0",
    category: "tts",
    provider: "elevenlabs",
    capabilities: () => CAPABILITIES,
    validate(_input: Partial<GenerateInput>): ValidationResult {
      return { ok: false, violations: ["tts is deferred — not implemented in this build"], warnings: [] };
    },
    estimate(_input: EstimateInput) {
      return { units: 0, unit_type: "character" };
    },
    async generate(): Promise<never> {
      throw new NotImplementedError("deferred");
    },
  };
}
