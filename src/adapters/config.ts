/**
 * Per-adapter integration config (base URLs / model ids / tuning knobs) —
 * sourced from skills/providers/* + env (§3, §14). Adapters read from here
 * instead of hardcoding endpoints/model ids inline, so provider facts stay
 * in one place and env can override base URLs (e.g. for testing).
 */

export const NANO_BANANA_CONFIG = {
  model: "gemini-2.5-flash-image",
} as const;

export const VEO_CONFIG = {
  // skills/providers/veo/SKILL.md: standard vs fast tier -> model id.
  models: {
    standard: "veo-3.1-generate-preview",
    fast: "veo-3.1-fast-generate-preview",
    lite: "veo-3.1-lite-generate-preview",
    // Gemini Omni Flash — same Gemini API key, but the Interactions API
    // (ai.interactions.*) rather than generateVideos. No last-frame
    // interpolation and no duration control (see the adapter's omni branch).
    omni: "gemini-omni-flash-preview",
  } as const,
  // Veo produces ~8s clips; default path requests 8s and Stage 6 trims to
  // scene.seconds. supported_durations_s is only used if/when the SDK is
  // confirmed to accept a discrete 4/6/8 durationSeconds selection.
  defaultDurationS: 8,
  supportedDurationsS: [4, 6, 8] as const,
  pollIntervalMs: 10_000,
  pollTimeoutMs: 10 * 60 * 1000,
} as const;

export const HEYGEN_CONFIG = {
  get baseUrl() {
    return process.env.HEYGEN_BASE_URL ?? "https://api.heygen.com";
  },
  minDurationS: 4,
  maxDurationS: 15,
  maxReferenceVideos: 3,
  maxReferenceImages: 9,
  minAvatarIds: 1,
  maxAvatarIds: 3,
  pollIntervalMs: 10_000,
  pollTimeoutMs: 10 * 60 * 1000,
} as const;

export const HIGGSFIELD_CONFIG = {
  // N7: no trailing /v1 here — src/adapters/video_broll/higgsfield.ts
  // already appends the full /v1/generations path(s) itself; keeping it in
  // both places doubled it (…/v1/v1/generations).
  get baseUrl() {
    return process.env.HIGGSFIELD_BASE_URL ?? "https://api.higgsfield.ai";
  },
  pollIntervalMs: 10_000,
  pollTimeoutMs: 10 * 60 * 1000,
} as const;

export const ELEVENLABS_CONFIG = {
  get baseUrl() {
    return process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
  },
  model: "music_v1",
  minDurationS: 10,
  maxDurationS: 300,
  defaultDurationS: 30,
} as const;

export const LYRIA_CONFIG = {
  // Lyria RealTime is only exposed on the v1alpha surface of the Gemini API.
  model: "models/lyria-realtime-exp",
  apiVersion: "v1alpha",
  // The stream's raw PCM format (16-bit little-endian) — needed to size the
  // capture and to write the WAV header.
  sampleRate: 48_000,
  channels: 2,
  defaultDurationS: 30,
  timeoutMs: 3 * 60 * 1000,
} as const;

/** Builds the callback_url HeyGen posts webhook events to, carrying the per-job callback_token. */
export function heygenCallbackUrl(callbackToken: string): string {
  const base =
    process.env.APP_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/webhooks/heygen?token=${encodeURIComponent(callbackToken)}`;
}
