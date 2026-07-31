/**
 * TypeScript row shapes mirroring the tables in supabase/migrations/0001_init.sql
 * (spec §2.2). Used across src/stages/* so every module agrees on the same
 * shape instead of re-declaring ad-hoc row types.
 */
import type {
  Provider,
  StageId,
  SceneType,
  Boundary,
  Slot,
  MediaType,
  VersionSource,
  PromptKind,
  PromptSource,
  EndFrameMode,
  ReelStatus,
} from "./enums";

export interface Client {
  id: string;
  display_name: string;
  cloned_from: string | null;
  archived: boolean;
  created_at: string;
}

export interface ClientConfigRow {
  client_id: string;
  brand_name: string | null;
  logo_path: string | null;
  default_tagline: string | null;
  fonts: Record<string, unknown> | null;
  brand_colors: Record<string, unknown> | null;
  default_aspect_ratio: string | null;
  default_resolution: string | null;
  updated_at: string;
}

export interface ProviderKeyRow {
  id: string;
  client_id: string;
  provider: Provider;
  vault_secret_id: string;
  account_label: string | null;
  created_at: string;
}

export interface AvatarRow {
  id: string;
  client_id: string;
  heygen_look_id: string;
  name: string;
  preview_image_url: string | null;
  preview_video_url: string | null;
  raw: unknown;
  created_at: string;
}

export interface Reel {
  id: string;
  client_id: string;
  display_name: string;
  current_stage: StageId;
  status: ReelStatus;
  created_at: string;
  updated_at: string;
}

export interface ReelConfigRow {
  reel_id: string;
  topic: string;
  /** Free-text brief giving scene-brain more context than the one-line topic. */
  topic_description: string | null;
  /** Per-reel override of scene-brain's instruction; null = the built-in default. */
  scene_prompt: string | null;
  total_seconds_target: number;
  avatar_enabled: boolean;
  broll_provider: Provider | null;
  image_provider: Provider;
  veo_variant: "standard" | "fast" | "lite";
  outro_provider_override: Provider | null;
  avatar_look_id: string | null;
  aspect_ratio: string;
  resolution: string;
  output_fps: number;
  /** Per-reel orchestrating LLM for the runtime skills; null = the built-in default. */
  orchestrator_model: string | null;
  end_frame_mode: EndFrameMode;
  end_frame_asset_id: string | null;
  outro_tagline: string | null;
  outro_seconds: number;
  music_path: string | null;
  music_trim: { start_s: number; end_s: number } | null;
  music_prompt: string | null;
  music_provider: Provider | null;
  /** Which music model `music_prompt` was optimised for; null = hand-typed or pre-dates the skill. */
  music_prompt_target_model: string | null;
  /** Product reference photos for this reel — auto-attached to every gen-AI call (see src/lib/productRefs.ts). */
  product_reference_paths: string[];
  updated_at: string;
}

export interface SceneRow {
  id: string;
  reel_id: string;
  position: number;
  type: SceneType;
  seconds: number;
  transition_to_next: Boundary | null;
  broll_provider_override: Provider | null;
  end_frame_disabled: boolean;
  description: string | null;
  start_image_id: string | null;
  end_image_id: string | null;
  clip_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetRow {
  id: string;
  reel_id: string;
  scene_id: string | null;
  slot: Slot;
  media_type: MediaType;
  current_version_id: string | null;
  shared: boolean;
  created_at: string;
  updated_at: string;
}

export interface AssetVersionMetadata {
  width?: number;
  height?: number;
  aspect?: string;
  resolution?: string;
  fps?: number;
  codec?: string;
  duration_s?: number;
  mime?: string;
  trim?: { start_s: number; end_s: number };
  base_version_id?: string;
}

export interface AssetVersion {
  id: string;
  asset_id: string;
  version_no: number;
  storage_path: string | null;
  source: VersionSource;
  prompt_version_id: string | null;
  provider: Provider | null;
  provider_asset_id: string | null;
  metadata: AssetVersionMetadata;
  units: number | null;
  unit_type: string | null;
  cost_log_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PromptRow {
  id: string;
  reel_id: string;
  scene_id: string | null;
  asset_id: string | null;
  kind: PromptKind;
  current_version_id: string | null;
  /** Per-asset opt-out for the reel's product reference photos (default on). */
  use_product_refs: boolean;
  created_at: string;
  updated_at: string;
}

export interface PromptVersion {
  id: string;
  prompt_id: string;
  version_no: number;
  text: string;
  reference_paths: string[] | null;
  source: PromptSource;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
