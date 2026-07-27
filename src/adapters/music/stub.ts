/**
 * ElevenLabs Music — STUB adapter (spec §3.4, §13). Deferred (brief §3,
 * §11): automated music generation is a future seam, NOT built — Stage 8
 * is manual upload only. Registered so the adapter registry is complete.
 * Build nothing else.
 */
import type { Adapter, AdapterCapabilities, EstimateInput, GenerateInput, ValidationResult } from "../types";
import { NotImplementedError } from "../types";

const CAPABILITIES: AdapterCapabilities = {
  category: "music",
  provider: "elevenlabs",
  supported_aspect_ratios: [],
  supported_resolutions: [],
  accepted_inputs: ["prompt"],
  async: false,
  billing_unit: "second",
};

export function createMusicStubAdapter(): Adapter {
  return {
    id: "elevenlabs_music@0",
    category: "music",
    provider: "elevenlabs",
    capabilities: () => CAPABILITIES,
    validate(_input: Partial<GenerateInput>): ValidationResult {
      return { ok: false, violations: ["music generation is deferred — not implemented in this build"], warnings: [] };
    },
    estimate(_input: EstimateInput) {
      return { units: 0, unit_type: "second" };
    },
    async generate(): Promise<never> {
      throw new NotImplementedError("deferred");
    },
  };
}
