/**
 * HeyGen Cinematic Avatar — video_avatar adapter (spec §3.1, §14.3). WAVE 1,
 * full. See skills/providers/heygen/SKILL.md. Silent (no script/voice).
 *
 * Async: webhook preferred (parseWebhook, verified via callback_token by
 * the route handler before this is called), poll() as fallback — both via
 * the `jobs` queue. Billing is FLAT $7.00/video (R3) regardless of
 * duration/resolution, so estimate()/generate()/poll() always report
 * units=1, unit_type='video' — no ambiguity like Veo's duration-dependent
 * billing.
 *
 * Contract-shape note (see also worker/reconcile.ts and
 * app/api/webhooks/heygen/route.ts): poll()'s given signature
 * (provider_job_id, provider_key) and parseWebhook()'s given signature
 * (payload only, SYNCHRONOUS — no I/O possible) carry no aspect_ratio/
 * resolution context, so both report best-effort placeholder metadata; the
 * orchestrator overwrites aspect/resolution from the job's stored payload.
 * parseWebhook() returns a passthrough `asset.url` (it cannot upload to
 * Storage itself, being synchronous) — the webhook route handler downloads
 * and persists it since that handler already has full job context.
 */
import type {
  Adapter,
  AdapterCapabilities,
  AssetRef,
  EstimateInput,
  GenerateInput,
  GenerateResult,
  ValidationResult,
  WebhookParseResult,
} from "../types";
import { HEYGEN_CONFIG } from "../config";
import { dimensionsFor } from "../dimensions";
import { resolveAssetRefBytes } from "../assetRef";
import { modelPromptHeygen } from "@/src/skills/model-prompt/heygen";
import { buildPollResultPath, type StorageClient } from "@/src/lib/storage";

const CAPABILITIES: AdapterCapabilities = {
  category: "video_avatar",
  provider: "heygen",
  min_duration_s: 4,
  max_duration_s: 15,
  supported_aspect_ratios: ["9:16", "1:1"],
  supported_resolutions: ["720p", "1080p"],
  min_avatar_ids: 1,
  max_avatar_ids: 3,
  max_reference_images: 9,
  max_reference_videos: 3,
  accepted_inputs: ["prompt", "avatar_ids", "references", "aspect_ratio", "resolution", "duration"],
  async: true,
  billing_unit: "video",
};

export interface HeyGenDeps {
  storage: StorageClient;
}

function classifyReference(ref: AssetRef): "image" | "video" {
  return ref.mime_type?.startsWith("video/") ? "video" : "image";
}

function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");

  if (input.aspect_ratio && !CAPABILITIES.supported_aspect_ratios.includes(input.aspect_ratio)) {
    violations.push(`aspect_ratio "${input.aspect_ratio}" is not supported by heygen`);
  }
  if (input.resolution && !CAPABILITIES.supported_resolutions.includes(input.resolution)) {
    violations.push(`resolution "${input.resolution}" is not supported by heygen`);
  }

  if (input.duration_s != null) {
    if (input.duration_s < CAPABILITIES.min_duration_s! || input.duration_s > CAPABILITIES.max_duration_s!) {
      violations.push(
        `duration_s ${input.duration_s} must be within [${CAPABILITIES.min_duration_s}, ${CAPABILITIES.max_duration_s}]`
      );
    }
  }

  const avatarCount = input.avatar_ids?.length ?? 0;
  if (avatarCount < CAPABILITIES.min_avatar_ids! || avatarCount > CAPABILITIES.max_avatar_ids!) {
    violations.push(
      `avatar_ids length ${avatarCount} must be within [${CAPABILITIES.min_avatar_ids}, ${CAPABILITIES.max_avatar_ids}]`
    );
  }

  const refs = input.references ?? [];
  const videoRefCount = refs.filter((ref) => classifyReference(ref) === "video").length;
  const imageRefCount = refs.length - videoRefCount;
  if (videoRefCount > CAPABILITIES.max_reference_videos!) {
    violations.push(`too many reference videos (${videoRefCount} > ${CAPABILITIES.max_reference_videos})`);
  }
  if (imageRefCount > CAPABILITIES.max_reference_images!) {
    violations.push(`too many reference images (${imageRefCount} > ${CAPABILITIES.max_reference_images})`);
  }

  // HeyGen's actual API enforces one COMBINED "video-like" slot budget:
  // avatar looks occupy the same budget as reference videos. This is in
  // addition to (not instead of) the min/max_avatar_ids check on
  // avatar_ids.length alone above.
  const combinedVideoSlots = avatarCount + videoRefCount;
  if (combinedVideoSlots > CAPABILITIES.max_reference_videos!) {
    violations.push(
      `avatar_ids + reference videos (${avatarCount} + ${videoRefCount} = ${combinedVideoSlots}) exceeds the combined video-slot budget of ${CAPABILITIES.max_reference_videos}`
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}

interface HeyGenApiEnvelope {
  video_id?: string;
  data?: { video_id?: string; status?: string; video_url?: string; url?: string; error?: string } | null;
  status?: string;
  video_url?: string;
  url?: string;
  error?: string;
  event?: string;
  event_type?: string;
}

function extractVideoId(json: HeyGenApiEnvelope): string | undefined {
  return json.video_id ?? json.data?.video_id ?? undefined;
}
function extractStatus(json: HeyGenApiEnvelope): string | undefined {
  return json.status ?? json.data?.status ?? undefined;
}
function extractVideoUrl(json: HeyGenApiEnvelope): string | undefined {
  return json.video_url ?? json.data?.video_url ?? json.url ?? json.data?.url ?? undefined;
}
function extractErrorMessage(json: HeyGenApiEnvelope): string | undefined {
  return json.error ?? json.data?.error ?? undefined;
}
function extractEvent(json: HeyGenApiEnvelope): string | undefined {
  return json.event ?? json.event_type ?? undefined;
}

async function toHeygenReference(ref: AssetRef): Promise<Record<string, string>> {
  const type = classifyReference(ref);
  if (ref.url) return { type: "url", url: ref.url };
  if (ref.asset_id) return { type: "asset_id", asset_id: ref.asset_id };
  if (ref.base64) return { type: "base64", data: ref.base64 };
  // storage_path should not reach the adapter directly — resolve defensively.
  const resolved = await resolveAssetRefBytes(ref);
  return { type: type === "video" ? "base64" : "base64", data: resolved.data };
}

export function createHeygenAdapter(deps: HeyGenDeps): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`heygen validate() failed: ${validation.violations.join("; ")}`);
    }

    const durationS = input.duration_s ?? CAPABILITIES.min_duration_s!;
    const payload = modelPromptHeygen(input.prompt, {
      aspectRatio: input.aspect_ratio,
      resolution: input.resolution,
      durationS,
    });

    const references = await Promise.all((input.references ?? []).map(toHeygenReference));

    const res = await fetch(`${HEYGEN_CONFIG.baseUrl}/v3/videos`, {
      method: "POST",
      headers: { "x-api-key": input.provider_key, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "cinematic_avatar",
        prompt: payload.prompt,
        avatar_id: input.avatar_ids ?? [],
        references: references.length > 0 ? references : undefined,
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
        duration: durationS,
        callback_url: input.callback_url,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`heygen: POST /v3/videos failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as HeyGenApiEnvelope;
    const videoId = extractVideoId(json);
    if (!videoId) {
      throw new Error("heygen: POST /v3/videos response had no video_id");
    }

    return {
      status: "pending",
      provider_job_id: videoId,
      units: 1,
      unit_type: "video",
      raw: json,
    };
  }

  async function poll(providerJobId: string, providerKey: string): Promise<GenerateResult> {
    const res = await fetch(`${HEYGEN_CONFIG.baseUrl}/v3/videos/${providerJobId}`, {
      headers: { "x-api-key": providerKey },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`heygen: GET /v3/videos/${providerJobId} failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as HeyGenApiEnvelope;
    const status = extractStatus(json);

    if (status === "failed") {
      throw new Error(`heygen: video ${providerJobId} failed: ${extractErrorMessage(json) ?? "unknown error"}`);
    }

    if (status !== "completed") {
      return { status: "pending", provider_job_id: providerJobId, units: 1, unit_type: "video", raw: json };
    }

    const videoUrl = extractVideoUrl(json);
    if (!videoUrl) {
      throw new Error(`heygen: video ${providerJobId} completed with no video URL in response`);
    }

    const downloaded = await fetch(videoUrl);
    if (!downloaded.ok) {
      throw new Error(`heygen: failed to download rendered video (${downloaded.status})`);
    }
    const buf = Buffer.from(await downloaded.arrayBuffer());
    const mimeType = downloaded.headers.get("content-type") ?? "video/mp4";
    const ext = mimeType.split("/")[1] ?? "mp4";
    const path = buildPollResultPath({ provider: "heygen", provider_job_id: providerJobId, ext });
    await storage.upload("assets", path, buf, mimeType);

    // Placeholder aspect/resolution — the orchestrator overwrites these
    // from the job's stored payload (see file header note).
    const { width, height } = dimensionsFor("9:16", "1080p");

    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime: mimeType,
        metadata: { width, height, aspect: "9:16", resolution: "1080p" },
      },
      units: 1,
      unit_type: "video",
      raw: json,
    };
  }

  function parseWebhook(payload: unknown): WebhookParseResult {
    const json = payload as HeyGenApiEnvelope;
    const providerJobId = extractVideoId(json);
    if (!providerJobId) {
      throw new Error("heygen: webhook payload had no video_id");
    }

    const event = extractEvent(json);
    const failed = event === "avatar_video.fail" || extractStatus(json) === "failed";
    if (failed) {
      return { provider_job_id: providerJobId, status: "failed", billed: false };
    }

    const videoUrl = extractVideoUrl(json);
    return {
      provider_job_id: providerJobId,
      status: "succeeded",
      asset: videoUrl
        ? {
            url: videoUrl,
            mime: "video/mp4",
            // Placeholder — the webhook route handler (which already looked
            // up the job via callback_token) fills in the real aspect/
            // resolution from job.payload before persisting.
            metadata: { width: 1080, height: 1920, aspect: "9:16", resolution: "1080p" },
          }
        : undefined,
      units: 1,
      unit_type: "video",
      billed: true,
    };
  }

  return {
    id: "heygen@1",
    category: "video_avatar",
    provider: "heygen",
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    estimate(_input: EstimateInput) {
      // FLAT per video regardless of duration/resolution (R3).
      return { units: 1, unit_type: "video" };
    },
    generate,
    poll,
    parseWebhook,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 onboarding: pull avatar "looks" for a client (spec §3.1, §7 Stage 1)
// ---------------------------------------------------------------------------

export interface HeyGenLook {
  heygen_look_id: string;
  name: string;
  preview_image_url: string | null;
  preview_video_url: string | null;
  raw: unknown;
}

interface HeyGenAvatarGroup {
  group_id?: string;
  id?: string;
  name: string;
}

interface HeyGenAvatarLook {
  id?: string;
  look_id?: string;
  avatar_id?: string;
  name?: string;
  preview_image_url?: string;
  image_url?: string;
  preview_video_url?: string;
  video_url?: string;
  [key: string]: unknown;
}

/**
 * Both /v3/avatars (groups) and /v3/avatars/looks return a cursor-paginated
 * `{ data: [...], has_more, next_token }` envelope with a default page size of
 * 20, so every listing has to be walked to the end or entries go missing.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAllPages<T>(providerKey: string, path: string, params: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;

  do {
    const query = new URLSearchParams({ ...params, limit: "50" });
    if (token) query.set("token", token);

    const url = `${HEYGEN_CONFIG.baseUrl}${path}?${query.toString()}`;
    const headers = { "x-api-key": providerKey, "Content-Type": "application/json" };

    // HeyGen rate-limits listing endpoints; back off and retry on 429.
    let res = await fetch(url, { headers });
    for (let attempt = 0; res.status === 429 && attempt < 5; attempt++) {
      await sleep(1000 * 2 ** attempt);
      res = await fetch(url, { headers });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`heygen: GET ${path} failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as { data?: T[]; next_token?: string | null };
    out.push(...(json.data ?? []));
    token = json.next_token ?? undefined;
  } while (token);

  return out;
}

export async function pullAvatarLooks(providerKey: string): Promise<HeyGenLook[]> {
  // Step 1 - Fetch the client's OWN avatar groups (GET /v3/avatars). Without
  // ownership=private this also returns HeyGen's hundreds of public stock
  // groups, which aren't the client's avatars and whose per-group look calls
  // blow straight through HeyGen's rate limit.
  const groups = await fetchAllPages<HeyGenAvatarGroup>(providerKey, "/v3/avatars", {
    ownership: "private",
  });

  // Step 2 - Fetch looks per group, sequentially: firing every group at once
  // trips HeyGen's rate limit. The look-level `id` is what POST /v3/videos
  // wants as avatar_id.
  const allLooks: HeyGenLook[] = [];

  for (const group of groups) {
    const groupId = group.group_id ?? group.id;
    if (!groupId) continue;

    const looks = await fetchAllPages<HeyGenAvatarLook>(providerKey, "/v3/avatars/looks", {
      group_id: groupId,
    });

    for (const look of looks) {
      const avatarId = look.id ?? look.look_id ?? look.avatar_id;
      if (!avatarId) continue;

      allLooks.push({
        heygen_look_id: avatarId,
        name: look.name ?? group.name ?? "Untitled look",
        preview_image_url: look.preview_image_url ?? look.image_url ?? null,
        preview_video_url: look.preview_video_url ?? look.video_url ?? null,
        raw: { group, look },
      });
    }
  }

  return allLooks;
}
