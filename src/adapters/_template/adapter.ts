/**
 * ===========================================================================
 * TEMPLATE — copy this file to add a new provider adapter.
 * ===========================================================================
 *
 * Copy to `src/adapters/<category>/<provider>.ts` (one directory deep, same
 * as this file — so every `../` import below carries over unchanged), then
 * find/replace `Template`/`TEMPLATE`/`example_provider` and delete whichever
 * of the paired paths (async vs synchronous) does not apply.
 *
 * This file is real, compiled, tested code (see ./adapter.test.ts) — not a
 * comment block. Keeping it type-checked is the point: if the `Adapter`
 * contract in ../types.ts changes, this template breaks in CI along with the
 * real adapters, so it can never silently rot into bad advice.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ADAPTER IS (and the four rules that keep the architecture intact)
 * ---------------------------------------------------------------------------
 * An adapter is the ONLY place in the codebase allowed to know a provider's
 * API shape. Orchestration (src/stages/*) resolves an adapter by
 * `(category, effective provider)` through src/adapters/registry.ts and calls
 * this contract — it never names a concrete model.
 *
 *   1. NEVER price anything. Report `units` / `unit_type` / `variant`; the
 *      calling stage logs them via `ctx.costEngine.log(...)`, which resolves
 *      $ from `rate_card`. An adapter that computes dollars is a bug.
 *   2. NEVER read a `storage_path` off an AssetRef. The calling stage resolves
 *      refs to base64/url first — `resolveAssetRefBytes` enforces this.
 *   3. `estimate()` MUST be pure and synchronous. No provider call, ever: the
 *      cost preview runs on every page load.
 *   4. `capabilities()` is the single source of truth for what the model can
 *      do. The setup UI, `validate()`, and the continuity-routing rule in
 *      src/lib/routing.ts all read it. Do not mirror those facts anywhere else.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION CHECKLIST — an adapter file alone does nothing
 * ---------------------------------------------------------------------------
 * See docs/architecture.md § "Adding a new provider" for the ordered version
 * with the reasoning. The short list:
 *
 *   [ ] `PROVIDERS` in src/lib/db/enums.ts        + `alter type provider_t add value` migration
 *   [ ] `<PROVIDER>_CONFIG` in src/adapters/config.ts   (move the block below there)
 *   [ ] `getDefaultAdapterRegistry()` in src/adapters/registry.ts
 *   [ ] `src/skills/model-prompt/<model>.ts`      + `targetModelFor()` in model-prompt/guidance.ts
 *   [ ] `skills/providers/<provider>/SKILL.md`    (the researched provider facts)
 *   [ ] `rate_card` seed migration                (or deliberately leave it unseeded — see below)
 *   [ ] `GOOGLE_BACKED_PROVIDERS` in src/lib/crypto/vault.ts, only if it shares an existing key
 *   [ ] a `<provider>.test.ts` beside the adapter (copy ./adapter.test.ts)
 */
import type {
  Adapter,
  AdapterCapabilities,
  EstimateInput,
  GenerateInput,
  GenerateResult,
  ValidationResult,
  WebhookParseResult,
} from "../types";
import { dimensionsFor } from "../dimensions";
import { resolveAssetRefBytes } from "../assetRef";
import { modelPromptTemplate } from "@/src/skills/model-prompt/_template";
import { buildGeneratedPath, buildPollResultPath, type StorageClient } from "@/src/lib/storage";

/**
 * In a real adapter this block lives in `src/adapters/config.ts` as
 * `<PROVIDER>_CONFIG` and is imported — endpoints and model ids belong in one
 * file so they can be audited (and env-overridden for tests) in one place. It
 * is inlined here only so the template stays a single self-contained file.
 *
 * Use a getter for anything env-derived: a plain property is evaluated at
 * module load, which in Next can be before env vars exist.
 */
const TEMPLATE_CONFIG = {
  get baseUrl() {
    return process.env.TEMPLATE_BASE_URL ?? "https://api.example.com";
  },
  model: "example-model-v1",
  defaultDurationS: 8,
  pollIntervalMs: 10_000,
  pollTimeoutMs: 10 * 60 * 1000,
} as const;

/**
 * Declare the model's REAL limits, not a safe-looking subset — every field
 * here either unlocks a feature or costs the user money by omission.
 *
 * `supports_end_frame` in particular drives the continuity-routing rule
 * (src/lib/routing.ts): false means no end image is generated for scenes on
 * this model (a Nano Banana call saved per scene) and every boundary out of
 * them is forced to `hard_cut`.
 *
 * If one adapter fronts several models whose limits differ, do NOT flatten
 * them to a lowest common denominator — export a
 * `Record<Variant, AdapterCapabilities>` table from a sibling
 * `<provider>Capabilities.ts` and answer `capabilities(variant)` from it.
 * src/adapters/video_broll/veoCapabilities.ts is the worked example (four
 * Google models behind one adapter); keeping it free of SDK/storage imports is
 * what lets the setup UI read the same table the adapter validates against.
 */
const CAPABILITIES: AdapterCapabilities = {
  category: "video_broll",
  provider: "example_provider",
  min_duration_s: 4,
  max_duration_s: 8,
  supported_durations_s: [4, 6, 8],
  supported_aspect_ratios: ["9:16", "16:9"],
  supported_resolutions: ["720p", "1080p"],
  max_reference_images: 1,
  supports_end_frame: false,
  supports_duration_control: true,
  emits_audio: false,
  accepted_inputs: ["prompt", "start_image"],
  async: true,
  billing_unit: "second",
};

export interface TemplateAdapterDeps {
  storage: StorageClient;
}

/**
 * Split violations (hard block — generate() throws) from warnings (proceed,
 * but the UI surfaces the compromise). The rule of thumb: if the provider
 * would reject the request, it is a violation; if the provider accepts it but
 * quietly does something other than what was asked, it is a warning.
 *
 * Takes `Partial<GenerateInput>` because the stage calls it before it has
 * assembled a full request, and generate() calls it again on the real one.
 */
function validateInput(input: Partial<GenerateInput>): ValidationResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!input.prompt || !input.prompt.trim()) violations.push("prompt is required");

  if (input.aspect_ratio && !CAPABILITIES.supported_aspect_ratios.includes(input.aspect_ratio)) {
    violations.push(`aspect_ratio "${input.aspect_ratio}" is not supported by ${TEMPLATE_CONFIG.model}`);
  }
  if (input.resolution && !CAPABILITIES.supported_resolutions.includes(input.resolution)) {
    violations.push(`resolution "${input.resolution}" is not supported by ${TEMPLATE_CONFIG.model}`);
  }

  const refCount = input.references?.length ?? 0;
  if (CAPABILITIES.max_reference_images != null && refCount > CAPABILITIES.max_reference_images) {
    violations.push(`too many reference images (${refCount} > ${CAPABILITIES.max_reference_images})`);
  }

  // Warning, not a violation: the clip still generates, it is just longer than
  // asked for and Stage 6 trims it. Say what will actually happen.
  if (input.duration_s != null && CAPABILITIES.max_duration_s != null && input.duration_s > CAPABILITIES.max_duration_s) {
    warnings.push(
      `requested duration_s (${input.duration_s}) exceeds ${TEMPLATE_CONFIG.model}'s ${CAPABILITIES.max_duration_s}s max — will generate at ${CAPABILITIES.max_duration_s}s and Stage 6 must trim`
    );
  }
  if (input.end_image && !CAPABILITIES.supports_end_frame) {
    warnings.push(
      `${TEMPLATE_CONFIG.model} has no last-frame interpolation — the end frame is ignored and the boundary is a hard cut`
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}

/**
 * Billable units are what the PROVIDER charges for, which is often not what
 * the user asked for: a model that only emits 8s clips bills 8s even when the
 * scene is 5s and Stage 6 trims the rest. Export the rule so the reconcile
 * pass can recompute the same number from a stored job payload.
 */
export function templateBillableDurationS(requestedSeconds?: number): number {
  if (requestedSeconds == null) return TEMPLATE_CONFIG.defaultDurationS;
  for (const option of CAPABILITIES.supported_durations_s ?? []) {
    if (option >= requestedSeconds) return option;
  }
  return TEMPLATE_CONFIG.defaultDurationS;
}

interface TemplateCreateResponse {
  job_id?: string;
  /** Present only when the provider answers synchronously. */
  output_url?: string;
}

/** One place that knows the wire format — keep response shaping out of generate(). */
async function createRemoteJob(
  providerKey: string,
  body: Record<string, unknown>
): Promise<TemplateCreateResponse> {
  const res = await fetch(`${TEMPLATE_CONFIG.baseUrl}/v1/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${providerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Include the body: a bare status code turns a 30-second fix into an hour.
    throw new Error(`example_provider: POST /v1/generations failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as TemplateCreateResponse;
}

export function createTemplateAdapter(deps: TemplateAdapterDeps): Adapter {
  const { storage } = deps;

  /**
   * ASYNC PATH (this one) — the provider returns a job id in seconds and the
   * render finishes minutes later. Return `status: "pending"` with a
   * `provider_job_id`; src/lib/jobs/reconcile.ts polls it on the next read and
   * finishes the asset. Delete `generateSynchronous`/`poll` below if unused.
   */
  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`example_provider validate() failed: ${validation.violations.join("; ")}`);
    }

    // Model-specific prompt shaping belongs in the model-prompt skill, not
    // here — see src/skills/model-prompt/_template.ts.
    const payload = modelPromptTemplate(input.prompt, {
      aspectRatio: input.aspect_ratio,
      resolution: input.resolution,
    });
    const durationS = templateBillableDurationS(input.duration_s);

    // Rule 2: refs arrive as base64/url, never as a storage_path.
    const startImage = input.start_image ? await resolveAssetRefBytes(input.start_image) : null;

    const created = await createRemoteJob(input.provider_key, {
      model: TEMPLATE_CONFIG.model,
      prompt: payload.prompt,
      negative_prompt: payload.negativePrompt,
      aspect_ratio: payload.aspectRatio,
      resolution: payload.resolution,
      duration_seconds: durationS,
      image: startImage ? { data: startImage.data, mime_type: startImage.mimeType } : undefined,
      // Only for providers that call back. The token is per-job and is what the
      // webhook route authenticates on — see heygenCallbackUrl in adapters/config.ts.
      callback_url: input.callback_url,
    });

    if (!created.job_id) {
      throw new Error("example_provider: create returned no job_id to poll later");
    }

    return {
      status: "pending",
      provider_job_id: created.job_id,
      units: durationS,
      unit_type: "second",
      variant: input.variant,
      raw: { job_id: created.job_id, model: TEMPLATE_CONFIG.model },
    };
  }

  /**
   * Implement only for `async: true` providers without a webhook (or as the
   * fallback for ones that have one).
   *
   * CONTRACT TRAP, read before writing this: the signature carries ONLY
   * `(provider_job_id, provider_key)` — no client_id / reel_id / asset_id /
   * aspect_ratio / resolution / duration_s / variant. So poll() cannot know
   * where the file belongs or what was really requested. Two consequences:
   *
   *   - Persist under `buildPollResultPath` (keyed on provider + job id). That
   *     is a permanent home, not a temp one; nothing in this system parses
   *     storage paths back apart — asset_versions is the source of truth.
   *   - Report BEST-EFFORT metadata/units. src/lib/jobs/reconcile.ts holds the
   *     original GenerateInput in `job.payload` and overwrites aspect /
   *     resolution / duration / variant from it before writing asset_versions
   *     and calling costEngine.log(). Do not try to guess them accurately here.
   *
   * Return `status: "pending"` (not an error) while the job is still running —
   * the next read polls again.
   */
  async function poll(providerJobId: string, providerKey: string): Promise<GenerateResult> {
    const res = await fetch(`${TEMPLATE_CONFIG.baseUrl}/v1/generations/${providerJobId}`, {
      headers: { Authorization: `Bearer ${providerKey}` },
    });
    if (!res.ok) {
      throw new Error(`example_provider: poll ${providerJobId} failed (${res.status})`);
    }
    const body = (await res.json()) as { status?: string; output_url?: string; error?: unknown };

    if (body.status === "failed" || body.status === "canceled") {
      throw new Error(`example_provider: job ${providerJobId} ended as "${body.status}" (${JSON.stringify(body.error ?? null)})`);
    }
    if (body.status !== "completed" || !body.output_url) {
      return {
        status: "pending",
        provider_job_id: providerJobId,
        units: TEMPLATE_CONFIG.defaultDurationS,
        unit_type: "second",
        raw: body,
      };
    }

    const download = await fetch(body.output_url);
    if (!download.ok) {
      throw new Error(`example_provider: failed to download result (${download.status})`);
    }
    const mime = download.headers.get("content-type") ?? "video/mp4";
    const ext = mime.split("/")[1] ?? "mp4";
    const path = buildPollResultPath({ provider: "example_provider", provider_job_id: providerJobId, ext });
    await storage.upload("assets", path, Buffer.from(await download.arrayBuffer()), mime);

    // Placeholder aspect/resolution/duration — reconcile.ts overwrites these
    // from job.payload. See the contract trap above.
    const { width, height } = dimensionsFor("9:16", "1080p");
    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime,
        metadata: {
          width,
          height,
          aspect: "9:16",
          resolution: "1080p",
          duration_s: TEMPLATE_CONFIG.defaultDurationS,
          codec: "h264",
        },
      },
      units: TEMPLATE_CONFIG.defaultDurationS,
      unit_type: "second",
      raw: body,
    };
  }

  /**
   * Implement only if the provider posts back. Note the shape: SYNCHRONOUS, so
   * no I/O is possible here — it cannot download, cannot upload, cannot read
   * the DB. Parse the payload into the common shape and return a passthrough
   * `asset.url`; the webhook route handler (app/api/webhooks/<provider>/route.ts)
   * authenticates the callback_token, downloads, persists, and cost-logs,
   * because it already has the full job row.
   */
  function parseWebhook(payload: unknown): WebhookParseResult {
    const event = payload as { id?: string; state?: string; url?: string };
    if (!event?.id) throw new Error("example_provider webhook: payload has no job id");

    return {
      provider_job_id: event.id,
      status: event.state === "completed" ? "succeeded" : "failed",
      asset: event.url
        ? {
            url: event.url,
            mime: "video/mp4",
            metadata: { width: 1080, height: 1920, aspect: "9:16", resolution: "1080p" },
          }
        : undefined,
      units: TEMPLATE_CONFIG.defaultDurationS,
      unit_type: "second",
      // `billed: true` on a failure means the provider charged anyway — the
      // route logs it as call_status 'failed_billed' instead of swallowing it.
      billed: event.state === "completed",
    };
  }

  return {
    // `<provider>@<n>` — bump the suffix when behaviour changes in a way that
    // makes old cost_log/asset_versions rows non-comparable. It is recorded on
    // every cost_log row as `adapter`.
    id: "example_provider@1",
    category: "video_broll",
    provider: "example_provider",
    // Takes `variant` so multi-model adapters answer per model. Ignore the arg
    // when the adapter fronts exactly one model, as here.
    capabilities: () => CAPABILITIES,
    validate: validateInput,
    // Rule 3: pure, synchronous, no provider call. Runs on every page load.
    estimate(input: EstimateInput) {
      return { units: templateBillableDurationS(input.duration_s), unit_type: "second", variant: input.variant };
    },
    generate,
    poll,
    parseWebhook,
  };
}

/**
 * ===========================================================================
 * SYNCHRONOUS VARIANT — delete whichever factory does not apply.
 * ===========================================================================
 *
 * When the provider returns the finished bytes in one round trip (Nano Banana,
 * ElevenLabs Music, Lyria) there is no job, no poll and no webhook: persist
 * immediately and return `succeeded`. `capabilities().async` is `false`, and
 * the calling stage writes the asset_versions row straight from the result
 * instead of parking a job in `awaiting_provider`.
 *
 * Everything else — validate, estimate, the no-pricing rule, model-prompt
 * shaping — is identical; only `generate` and the absent `poll`/`parseWebhook`
 * differ, which is why they are shown as two whole factories rather than one
 * branching mess.
 */
export function createTemplateSynchronousAdapter(deps: TemplateAdapterDeps): Adapter {
  const { storage } = deps;

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const validation = validateInput(input);
    if (!validation.ok) {
      throw new Error(`example_provider validate() failed: ${validation.violations.join("; ")}`);
    }

    const payload = modelPromptTemplate(input.prompt, {
      aspectRatio: input.aspect_ratio,
      resolution: input.resolution,
    });
    const created = await createRemoteJob(input.provider_key, {
      model: TEMPLATE_CONFIG.model,
      prompt: payload.prompt,
      aspect_ratio: payload.aspectRatio,
    });
    if (!created.output_url) throw new Error("example_provider: response carried no output_url");

    const res = await fetch(created.output_url);
    if (!res.ok) throw new Error(`example_provider: failed to download output (${res.status})`);
    const mime = res.headers.get("content-type") ?? "image/png";
    const ext = mime.split("/")[1] ?? "png";

    // Unlike poll(), generate() holds the full GenerateInput — so it keys the
    // file on the real client/reel/asset and reports REAL metadata that the
    // caller can trust. buildGeneratedPath keys on idempotency_key (unique per
    // generate/redo) because version_no is not assigned until the calling stage
    // inserts the asset_versions row.
    const path = buildGeneratedPath({
      client_id: input.client_id,
      reel_id: input.reel_id,
      asset_id: input.asset_id,
      idempotency_key: input.idempotency_key,
      ext,
    });
    await storage.upload("assets", path, Buffer.from(await res.arrayBuffer()), mime);

    const { width, height } = dimensionsFor(input.aspect_ratio, input.resolution);
    return {
      status: "succeeded",
      asset: {
        storage_path: path,
        mime,
        metadata: { width, height, aspect: input.aspect_ratio, resolution: input.resolution },
      },
      units: 1,
      unit_type: "image",
      raw: { model: TEMPLATE_CONFIG.model },
    };
  }

  return {
    id: "example_provider_sync@1",
    category: "image",
    provider: "example_provider",
    capabilities: () => ({ ...CAPABILITIES, category: "image", async: false, billing_unit: "image" }),
    validate: validateInput,
    estimate(input: EstimateInput) {
      return { units: input.count ?? 1, unit_type: "image" };
    },
    generate,
    // No poll / no parseWebhook — there is nothing to wait for.
  };
}
