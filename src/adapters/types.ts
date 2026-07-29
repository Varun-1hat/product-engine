/**
 * The adapter contract — spec §3 (the spine).
 *
 * Orchestration (src/stages/*) references only `category` + the resolved
 * *effective* `provider` (see routing.ts for the effective-model helpers).
 * All model specifics live in the adapter implementation + its per-model
 * `src/skills/model-prompt/*` skill + `skills/providers/<x>/SKILL.md`.
 * Cost is priced by the cost engine (src/lib/cost/engine.ts), never by the
 * adapter itself — an adapter reports `units`/`unit_type`/`variant`, the
 * calling stage logs it via `costEngine.log(...)`.
 */
import type { Category } from "@/src/lib/db/enums";

export interface AdapterCapabilities {
  category: Category;
  provider: string; // provider_t value
  min_duration_s?: number;
  max_duration_s?: number;
  supported_durations_s?: number[]; // discrete options if any (e.g. Veo [4,6,8] when confirmed)
  supported_aspect_ratios: string[];
  supported_resolutions: string[];
  max_reference_images?: number;
  max_reference_videos?: number;
  min_avatar_ids?: number;
  max_avatar_ids?: number;
  supports_end_frame?: boolean; // video_broll: can it target a last frame? (Veo true, Higgsfield false)
  supports_duration_control?: boolean; // false = clip length is whatever the model returns (Gemini Omni)
  /** Resolutions the model only renders at its maximum duration (Veo: 1080p/4k are 8s-only). */
  full_duration_only_resolutions?: string[];
  emits_audio?: boolean; // video_broll: strip on ingest if true (Veo true)
  accepted_inputs: string[];
  async: boolean;
  billing_unit: "image" | "second" | "video" | "credit" | "character";
}

export interface AssetRef {
  url?: string;
  asset_id?: string;
  base64?: string;
  storage_path?: string;
  mime_type?: string;
}

export interface GenerateInput {
  client_id: string;
  reel_id: string;
  scene_id?: string;
  asset_id?: string;
  prompt: string;
  start_image?: AssetRef;
  end_image?: AssetRef;
  references?: AssetRef[];
  avatar_ids?: string[];
  aspect_ratio: string;
  resolution: string;
  duration_s?: number;
  variant?: string; // e.g. Veo 'standard'|'fast'
  provider_key: string;
  callback_url?: string;
  idempotency_key: string;
}

export interface GenerateResultAsset {
  storage_path?: string;
  url?: string;
  mime: string;
  metadata: {
    width: number;
    height: number;
    aspect: string;
    resolution: string;
    fps?: number;
    codec?: string;
    duration_s?: number;
  };
}

export interface GenerateResult {
  status: "succeeded" | "pending";
  asset?: GenerateResultAsset;
  provider_job_id?: string;
  units: number;
  unit_type: string;
  variant?: string;
  raw: unknown;
}

export interface EstimateInput {
  aspect_ratio: string;
  resolution: string;
  duration_s?: number;
  count?: number;
  references_count?: number;
  variant?: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: string[];
  warnings: string[];
}

export interface WebhookParseResult {
  provider_job_id: string;
  status: "succeeded" | "failed";
  asset?: GenerateResult["asset"];
  units?: number;
  unit_type?: string;
  billed?: boolean;
}

export interface Adapter {
  id: string;
  category: AdapterCapabilities["category"];
  provider: string;
  /**
   * Constraints for one concrete model. Adapters that front several models
   * (video_broll/veo covers the three Veo 3.1 tiers + Gemini Omni Flash)
   * answer per `variant`, so callers get that model's real limits rather than
   * a lowest-common-denominator set. Omit `variant` for the adapter's default.
   */
  capabilities(variant?: string): AdapterCapabilities;
  validate(input: Partial<GenerateInput>): ValidationResult;
  estimate(input: EstimateInput): { units: number; unit_type: string; variant?: string }; // NO provider call
  generate(input: GenerateInput): Promise<GenerateResult>;
  poll?(provider_job_id: string, provider_key: string): Promise<GenerateResult>;
  parseWebhook?(payload: unknown): WebhookParseResult;
}

/** Thrown by the tts/music stub adapters (spec §3.4) — deferred, build nothing else. */
export class NotImplementedError extends Error {
  constructor(reason = "deferred") {
    super(reason);
    this.name = "NotImplementedError";
  }
}
