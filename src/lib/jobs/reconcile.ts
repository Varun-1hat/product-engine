/**
 * src/lib/jobs/reconcile.ts — polls awaiting_provider jobs (HeyGen fallback,
 * Veo, Higgsfield — spec §7 Stage 5/7, brief §10.19). Claims via
 * jobs.claimAwaitingProvider (SKIP LOCKED), calls adapter.poll(), and on
 * completion logs cost + persists the asset_version. On failure, marks the
 * job failed and logs a (conservatively unbilled) cost_log row.
 *
 * Cost-logging note (see src/adapters/video_broll/veo.ts and
 * src/adapters/video_avatar/heygen.ts header notes): poll()'s given
 * signature (provider_job_id, provider_key) carries no aspect_ratio/
 * resolution/units/variant, so it returns best-effort metadata. This is
 * the authoritative reconciliation point — it overwrites poll()'s
 * placeholders with what src/stages/clip and src/stages/outro recorded in
 * `jobs.payload` at request time (the real values, known from the full
 * GenerateInput at that point).
 */
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import type { CostEngine } from "@/src/lib/cost/engine";
import type { JobQueue, Job } from "@/src/lib/jobs/queue";
import type { AdapterRegistry } from "@/src/adapters/registry";
import type { KeyResolver } from "@/src/lib/crypto/vault";
import { getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import type { Category, Provider, StageId } from "@/src/lib/db/enums";

/** Cap on the linear per-attempt backoff used when re-arming a transiently-failed poll (N1). */
const RECONCILE_RETRY_BACKOFF_CAP_MS = 5 * 60_000;

interface AsyncGenJobPayload {
  call_type?: "generate" | "redo";
  provider?: string;
  variant?: string | null;
  units?: number;
  unit_type?: string;
  aspect_ratio?: string;
  resolution?: string;
  duration_s?: number | null;
  route?: "model" | "crossfade";
}

function categoryForJob(job: Job, payload: AsyncGenJobPayload): Category | null {
  if (job.type === "broll_gen") return "video_broll";
  if (job.type === "avatar_gen") return "video_avatar";
  if (job.type === "outro_gen") return payload.route === "model" ? "video_broll" : null;
  return null;
}

function stageForJob(job: Job): StageId {
  if (job.type === "outro_gen") return "outro";
  return "clip";
}

/**
 * `payload.variant` carries Veo's billing form ('fast@1080p' — composeVeoVariant),
 * but capabilities() keys on the bare model variant. Strip the resolution
 * qualifier rather than let the lookup silently fall back to the default tier.
 */
function bareVariant(variant: string | null | undefined): string | undefined {
  return variant ? variant.split("@")[0] : undefined;
}

export async function reconcileJob(deps: {
  supa: ServiceClient;
  costEngine: CostEngine;
  jobs: JobQueue;
  adapters: AdapterRegistry;
  keys: KeyResolver;
  /** Only needed to demux a finished clip's native audio; omit and that step is skipped. */
  storage?: StorageClient;
  job: Job;
}): Promise<void> {
  const { supa, costEngine, jobs, adapters, keys, storage, job } = deps;
  const payload = (job.payload ?? {}) as AsyncGenJobPayload;

  const category = categoryForJob(job, payload);
  if (!category || !job.provider || !job.provider_job_id || !job.reel_id) {
    return; // not a pollable async-provider job (shouldn't normally happen for awaiting_provider rows)
  }

  const { data: reelRow, error: reelError } = await supa.from("reels").select("client_id").eq("id", job.reel_id).single();
  if (reelError) throw new Error(`reels lookup failed: ${reelError.message}`);
  const clientId = (reelRow as { client_id: string }).client_id;

  const adapter = adapters.get(category, job.provider);
  const callType = payload.call_type ?? "generate";

  try {
    const providerKey = await keys.forProvider(clientId, job.provider as Provider);
    const result = await adapter.poll!(job.provider_job_id, providerKey);

    if (result.status === "pending") return; // still running — left as awaiting_provider for the next tick

    if (!job.asset_id) throw new Error(`job ${job.id} succeeded but has no asset_id to attach the result to`);

    const asset = await getAsset(supa, job.asset_id);
    const metadata = {
      ...(result.asset?.metadata ?? {}),
      aspect: payload.aspect_ratio ?? result.asset?.metadata.aspect,
      resolution: payload.resolution ?? result.asset?.metadata.resolution,
      duration_s: payload.duration_s ?? result.asset?.metadata.duration_s,
      mime: result.asset?.mime,
    };

    const costLog = await costEngine.log({
      reel_id: job.reel_id,
      client_id: clientId,
      scene_id: job.scene_id ?? undefined,
      stage: stageForJob(job),
      provider: job.provider as Provider,
      adapter: adapter.id,
      call_type: callType,
      call_status: "success",
      units: payload.units ?? result.units,
      unit_type: payload.unit_type ?? result.unit_type,
      variant: payload.variant ?? result.variant ?? undefined,
      provider_asset_id: job.provider_job_id,
      idempotency_key: job.idempotency_key ?? undefined,
    });

    const { version } = await upsertAssetVersion(supa, {
      assetId: job.asset_id,
      reel_id: job.reel_id,
      scene_id: job.scene_id,
      slot: asset.slot,
      media_type: "video",
      shared: asset.shared,
      storage_path: result.asset?.storage_path ?? null,
      source: "generated",
      provider: job.provider as Provider,
      metadata,
      units: payload.units ?? result.units,
      unit_type: payload.unit_type ?? result.unit_type,
      cost_log_id: costLog.id,
    });

    await jobs.complete(job.id, { asset_version_id: version.id });

    // Keep the model's native audio as an asset of its own (see
    // ./clipAudio.ts). Deliberately after complete() and swallowed on
    // failure: the clip is the paid artifact and is now safely persisted,
    // whereas the audio is a free local derivation that the clip-audio GET
    // re-attempts on the next read. Letting a demux failure fall into the
    // catch below would re-arm a poll for a generation that already
    // succeeded — and eventually log it as failed_unbilled.
    if (storage && adapter.capabilities(bareVariant(payload.variant)).emits_audio) {
      try {
        // Imported here, not at module scope: ./clipAudio.ts pulls in
        // ffmpeg-static, and this module loads on every stage GET.
        const { ensureClipAudio } = await import("@/src/lib/jobs/clipAudio");
        await ensureClipAudio(supa, storage, job.asset_id);
      } catch (audioErr) {
        console.error(`[jobs] clip audio extraction failed for asset ${job.asset_id}:`, audioErr);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // N1: on any caught error here (429/5xx from the provider, a Storage
    // upload failure, a DB hiccup), treat it as TRANSIENT by default and
    // re-arm for another poll rather than routing through jobs.fail()'s
    // default retry, which moves the job to 'queued' — a status nothing
    // picks up, since broll_gen/avatar_gen/outro_gen never pass through the
    // inline dispatcher (src/lib/jobs/run.ts). Deliberately do NOT log a
    // failed_unbilled cost_log row under the generation's real
    // idempotency_key here — that key is the double-charge guard for this
    // generation's eventual real (billed or terminal-unbilled) outcome, and
    // logging a row under it now would burn it before that outcome exists.
    if (job.attempts < job.max_attempts) {
      const backoffMs = Math.min(30_000 * (job.attempts + 1), RECONCILE_RETRY_BACKOFF_CAP_MS);
      await jobs.retryLater(job.id, new Date(Date.now() + backoffMs), message);
      return;
    }

    // Retries exhausted — this is a genuine terminal outcome now: log the
    // (conservatively unbilled — none of the wave-1/2 adapters currently
    // signal a distinct billed-on-failure case; spec §4/§9 edge #13) result
    // under the real idempotency_key, and fail the job for good.
    await costEngine.log({
      reel_id: job.reel_id,
      client_id: clientId,
      scene_id: job.scene_id ?? undefined,
      stage: stageForJob(job),
      provider: job.provider as Provider,
      adapter: adapter.id,
      call_type: callType,
      call_status: "failed_unbilled",
      idempotency_key: job.idempotency_key ?? undefined,
    });
    await jobs.fail(job.id, message, { retry: false });
  }
}

export async function runReconcileTick(deps: {
  supa: ServiceClient;
  storage: StorageClient;
  costEngine: CostEngine;
  jobs: JobQueue;
  adapters: AdapterRegistry;
  keys: KeyResolver;
  workerId: string;
  limit?: number;
}): Promise<number> {
  const claimed = await deps.jobs.claimAwaitingProvider(deps.workerId, deps.limit ?? 10);
  await Promise.all(
    claimed.map((job) =>
      reconcileJob({
        supa: deps.supa,
        costEngine: deps.costEngine,
        jobs: deps.jobs,
        adapters: deps.adapters,
        keys: deps.keys,
        storage: deps.storage,
        job,
      })
    )
  );
  return claimed.length;
}
