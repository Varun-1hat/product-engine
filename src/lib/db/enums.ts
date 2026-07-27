/**
 * Canonical mirror of the Postgres enums defined in
 * `supabase/migrations/0001_init.sql` (spec §2.1). Single source of truth
 * for the TS-side literal unions so adapters/skills/stages/cost-engine all
 * agree on the same value sets (and zod schemas can be built from the same
 * arrays used for UI dropdowns / validation).
 */

export const PROVIDERS = ["nano_banana", "veo", "higgsfield", "heygen", "elevenlabs"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const CATEGORIES = ["image", "video_broll", "video_avatar", "tts", "music"] as const;
export type Category = (typeof CATEGORIES)[number];

export const STAGES = [
  "config",
  "reel_setup",
  "scene",
  "image",
  "clip",
  "trim",
  "outro",
  "music",
  "assembly",
] as const;
export type StageId = (typeof STAGES)[number];

export const SCENE_TYPES = ["avatar", "broll"] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

export const BOUNDARIES = ["continuous", "hard_cut"] as const;
export type Boundary = (typeof BOUNDARIES)[number];

export const SLOTS = [
  "start_image",
  "end_image",
  "broll_clip",
  "avatar_clip",
  "outro_clip",
  "end_frame_image",
  "final_render",
] as const;
export type Slot = (typeof SLOTS)[number];

export const MEDIA_TYPES = ["image", "video", "audio"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const VERSION_SOURCES = ["generated", "uploaded", "derived", "assembled", "manual"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

export const PROMPT_KINDS = [
  "image_start",
  "image_end",
  "broll_motion",
  "avatar_shot",
  "outro_motion",
] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const PROMPT_SOURCES = ["skill", "manual", "redo"] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

export const JOB_TYPES = [
  "avatar_pull",
  "image_gen",
  "broll_gen",
  "avatar_gen",
  "outro_gen",
  "endframe_render",
  "trim",
  "assembly",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued",
  "processing",
  "awaiting_provider",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const CALL_TYPES = ["generate", "redo", "poll"] as const;
export type CallType = (typeof CALL_TYPES)[number];

export const CALL_STATUSES = ["success", "failed_billed", "failed_unbilled"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const END_FRAME_MODES = ["default", "custom"] as const;
export type EndFrameMode = (typeof END_FRAME_MODES)[number];

export const REEL_STATUSES = ["draft", "in_progress", "assembled", "archived"] as const;
export type ReelStatus = (typeof REEL_STATUSES)[number];

export const ASPECT_RATIOS = ["9:16", "1:1", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTIONS = ["720p", "1080p"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const VEO_VARIANTS = ["standard", "fast"] as const;
export type VeoVariant = (typeof VEO_VARIANTS)[number];

export const UNIT_TYPES = ["image", "second", "video", "credit", "character"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];
