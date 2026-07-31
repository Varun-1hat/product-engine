/**
 * Inline job execution (spec §12, brief §10.19). Jobs are still recorded in
 * the `jobs` table — for status, attempts, retry bookkeeping and the
 * cost/idempotency trail — but they run synchronously inside the request
 * that creates them instead of being picked up by a separate long-lived
 * process. This app's volume doesn't justify a standing poller.
 *
 * runJobInline() is the dispatcher: avatar_pull (Stage 1 — HeyGen looks pull
 * -> avatars, not billed), trim (./trim.ts), endframe_render
 * (./endframe.ts), outro_gen (./outro.ts — finishes immediately for the
 * crossfade route, or transitions to awaiting_provider for the model route),
 * assembly (./assembly.ts). broll_gen/avatar_gen never come through here —
 * src/stages/clip calls adapter.generate() inline and marks those jobs
 * awaiting_provider directly.
 *
 * Provider-async jobs (awaiting_provider) can't be finished inline: the
 * provider takes minutes. Those are reconciled on read — see
 * reconcilePendingJobs() below, called from the stage GET handlers.
 */
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import type { CostEngine } from "@/src/lib/cost/engine";
import type { KeyResolver } from "@/src/lib/crypto/vault";
import type { AdapterRegistry } from "@/src/adapters/registry";
import { pullAvatarLooks } from "@/src/adapters/video_avatar/heygen";
import { createCostEngine } from "@/src/lib/cost/engine";
import { getDefaultAdapterRegistry } from "@/src/adapters/registry";
import type { Job, JobQueue } from "./queue";
import { runTrimJob } from "./trim";
import { runEndframeRenderJob } from "./endframe";
import { runAssemblyJob } from "./assembly";
import { runOutroGenJob } from "./outro";
import { runReconcileTick } from "./reconcile";

/**
 * The subset of a stage context runJobInline needs. `adapters` is optional
 * because ConfigStageContext (Stage 1, avatar_pull) has no adapter registry —
 * and avatar_pull doesn't need one.
 */
export interface InlineJobDeps {
  supa: ServiceClient;
  storage: StorageClient;
  jobs: JobQueue;
  keys: KeyResolver;
  adapters?: AdapterRegistry;
}

async function handleAvatarPull(supa: ServiceClient, keys: KeyResolver, job: Job): Promise<void> {
  const payload = job.payload as { client_id?: string };
  const clientId = payload.client_id;
  if (!clientId) throw new Error(`avatar_pull job ${job.id} has no client_id in payload`);

  const providerKey = await keys.forProvider(clientId, "heygen");
  const looks = await pullAvatarLooks(providerKey);

  for (const look of looks) {
    const { error } = await supa.from("avatars").upsert(
      {
        client_id: clientId,
        heygen_look_id: look.heygen_look_id,
        name: look.name,
        preview_image_url: look.preview_image_url,
        preview_video_url: look.preview_video_url,
        raw: look.raw,
      },
      { onConflict: "client_id,heygen_look_id" }
    );
    if (error) throw new Error(`avatars upsert failed: ${error.message}`);
  }
}

async function dispatchJob(deps: InlineJobDeps, job: Job): Promise<void> {
  switch (job.type) {
    case "avatar_pull":
      await handleAvatarPull(deps.supa, deps.keys, job);
      await deps.jobs.complete(job.id);
      return;

    case "trim":
      await runTrimJob(deps.supa, deps.storage, job);
      await deps.jobs.complete(job.id);
      return;

    case "endframe_render":
      await runEndframeRenderJob(deps.supa, deps.storage, job);
      await deps.jobs.complete(job.id);
      return;

    case "outro_gen": {
      if (!deps.adapters) throw new Error(`job ${job.id}: outro_gen needs an adapter registry`);
      const outcome = await runOutroGenJob({
        supa: deps.supa,
        storage: deps.storage,
        jobs: deps.jobs,
        adapters: deps.adapters,
        keys: deps.keys,
        job,
      });
      if (outcome === "completed") await deps.jobs.complete(job.id);
      // 'awaiting_provider': runOutroGenJob already called markAwaitingProvider,
      // and reconcilePendingJobs() finishes it on a later read.
      return;
    }

    case "assembly":
      await runAssemblyJob(deps.supa, deps.storage, job);
      await deps.jobs.complete(job.id);
      return;

    case "broll_gen":
    case "avatar_gen":
      // src/stages/clip calls adapter.generate() inline and marks these
      // awaiting_provider directly — they never reach this dispatcher.
      // Fail loudly rather than silently drop a job if one does.
      throw new Error(
        `job ${job.id} (${job.type}) reached the inline dispatcher unexpectedly — expected awaiting_provider`
      );

    case "image_gen":
      throw new Error(`job ${job.id}: image_gen is unused in this build — Nano Banana is synchronous (src/stages/image)`);

    default:
      throw new Error(`job ${job.id}: unhandled job type "${job.type}"`);
  }
}

/**
 * Runs a just-enqueued job to completion and returns its final row (the same
 * shape enqueue() returned, refreshed). Failures are recorded on the job via
 * jobs.fail() and re-thrown, so the calling route surfaces them instead of
 * returning a "queued" job that nothing will ever pick up.
 */
export async function runJobInline(deps: InlineJobDeps, job: Job): Promise<Job> {
  try {
    await dispatchJob(deps, job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jobs] job ${job.id} (${job.type}) failed:`, message);
    // Never let a bookkeeping failure mask the real error the caller needs.
    await deps.jobs.fail(job.id, message, { retry: false }).catch((failErr) => {
      console.error(`[jobs] job ${job.id}: recording the failure also failed:`, failErr);
    });
    throw err;
  }
  // The work succeeded — a refetch failure must not turn that into an error
  // for the caller; fall back to the row we already have.
  return await deps.jobs.get(job.id).then((fresh) => fresh ?? job).catch(() => job);
}

/**
 * Polls any awaiting_provider jobs (Veo/Higgsfield b-roll, HeyGen without a
 * webhook, outro via the model route) and finishes the ones the provider has
 * completed. Replaces the standing reconcile loop: called from the stage GET
 * handlers, so a page load/refresh is what advances an in-flight generation.
 *
 * Claiming still goes through claim_awaiting_jobs (SKIP LOCKED + a 1-minute
 * lease) so concurrent requests never poll — or complete — the same job
 * twice. Errors are swallowed: reconciliation must never break a read.
 */
export async function reconcilePendingJobs(deps: {
  supa: ServiceClient;
  storage: StorageClient;
  jobs: JobQueue;
  keys: KeyResolver;
  adapters?: AdapterRegistry;
  costEngine?: CostEngine;
}): Promise<void> {
  try {
    await runReconcileTick({
      supa: deps.supa,
      storage: deps.storage,
      costEngine: deps.costEngine ?? createCostEngine(deps.supa),
      jobs: deps.jobs,
      adapters: deps.adapters ?? (await getDefaultAdapterRegistry()),
      keys: deps.keys,
      workerId: "inline",
    });
  } catch (err) {
    console.error("[jobs] reconcile pass failed:", err);
  }
}
