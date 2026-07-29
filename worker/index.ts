/**
 * worker/index.ts — claim jobs -> dispatch (spec §12, brief §10.19). Two
 * independent loops:
 *
 *  1. Main claim loop: claims 'queued' jobs (FOR UPDATE SKIP LOCKED via
 *     the claim_jobs RPC) and dispatches by job_type_t: avatar_pull
 *     (Stage 1 — HeyGen looks pull -> avatars, not billed), trim
 *     (worker/trim.ts), endframe_render (worker/endframe.ts), outro_gen
 *     (worker/outro.ts — finishes immediately for the crossfade route, or
 *     transitions to awaiting_provider for the model route), assembly
 *     (worker/assembly.ts). broll_gen/avatar_gen never appear here —
 *     src/stages/clip calls adapter.generate() inline and marks those jobs
 *     awaiting_provider directly.
 *  2. Reconcile loop (worker/reconcile.ts): polls awaiting_provider jobs
 *     (HeyGen fallback, Veo, Higgsfield, and outro_gen's model route) on
 *     its own interval.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/src/lib/supabase/service";
import { createStorageClient, type StorageClient } from "@/src/lib/storage";
import { createJobQueue, type Job, type JobQueue } from "@/src/lib/jobs/queue";
import { createCostEngine, type CostEngine } from "@/src/lib/cost/engine";
import { createKeyResolver, type KeyResolver } from "@/src/lib/crypto/vault";
import { getDefaultAdapterRegistry, type AdapterRegistry } from "@/src/adapters/registry";
import { pullAvatarLooks } from "@/src/adapters/video_avatar/heygen";
import type { ServiceClient } from "@/src/lib/supabase/service";
import { runTrimJob } from "./trim";
import { runEndframeRenderJob } from "./endframe";
import { runAssemblyJob } from "./assembly";
import { runOutroGenJob } from "./outro";
import { runReconcileTick } from "./reconcile";

const WORKER_ID = process.env.WORKER_ID ?? `worker-${randomUUID()}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const RECONCILE_INTERVAL_MS = Number(process.env.WORKER_RECONCILE_INTERVAL_MS ?? 15000);
const CLAIM_BATCH_SIZE = 5;

// N3: re-entrancy guard for the reconcile interval below — without it, a
// tick that runs longer than RECONCILE_INTERVAL_MS overlaps with the next
// one instead of skipping it.
let reconcileInFlight = false;

interface WorkerDeps {
  supa: ServiceClient;
  storage: StorageClient;
  jobs: JobQueue;
  costEngine: CostEngine;
  keys: KeyResolver;
  adapters: AdapterRegistry;
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

async function dispatchJob(deps: WorkerDeps, job: Job): Promise<void> {
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
      const outcome = await runOutroGenJob({
        supa: deps.supa,
        storage: deps.storage,
        jobs: deps.jobs,
        adapters: deps.adapters,
        keys: deps.keys,
        job,
      });
      if (outcome === "completed") await deps.jobs.complete(job.id);
      // 'awaiting_provider': runOutroGenJob already called markAwaitingProvider.
      return;
    }

    case "assembly":
      await runAssemblyJob(deps.supa, deps.storage, job);
      await deps.jobs.complete(job.id);
      return;

    case "broll_gen":
    case "avatar_gen":
      // src/stages/clip calls adapter.generate() inline and marks these
      // awaiting_provider directly — they should never be claimable as
      // 'queued'. Fail loudly rather than silently drop a job if one does.
      throw new Error(
        `job ${job.id} (${job.type}) reached the main claim loop unexpectedly — expected awaiting_provider`
      );

    case "image_gen":
      throw new Error(`job ${job.id}: image_gen is unused in this build — Nano Banana is synchronous (src/stages/image)`);

    default:
      throw new Error(`job ${job.id}: unhandled job type "${job.type}"`);
  }
}

async function claimLoopTick(deps: WorkerDeps): Promise<number> {
  console.log("[worker] polling for jobs...");
  const claimed = await deps.jobs.claim(WORKER_ID, undefined, CLAIM_BATCH_SIZE);
  console.log(`[worker] claimed ${claimed.length} jobs`);
  await Promise.all(
    claimed.map(async (job) => {
      try {
        await dispatchJob(deps, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker] job ${job.id} (${job.type}) failed:`, message);
        await deps.jobs.fail(job.id, message);
      }
    })
  );
  return claimed.length;
}

async function main(): Promise<void> {
  const supa = createServiceClient();
  const storage = createStorageClient(supa);
  const jobs = createJobQueue(supa);
  const costEngine = createCostEngine(supa);
  const keys = createKeyResolver(supa);
  const adapters = await getDefaultAdapterRegistry();

  const deps: WorkerDeps = { supa, storage, jobs, costEngine, keys, adapters };

  console.log(`[worker] ${WORKER_ID} started (claim every ${POLL_INTERVAL_MS}ms, reconcile every ${RECONCILE_INTERVAL_MS}ms)`);

  const claimTimer = setInterval(() => {
    claimLoopTick(deps).catch((err) => console.error("[worker] claim loop tick failed:", err));
  }, POLL_INTERVAL_MS);

  const reconcileTimer = setInterval(() => {
    if (reconcileInFlight) return;
    reconcileInFlight = true;
    runReconcileTick({ ...deps, workerId: WORKER_ID })
      .catch((err) => console.error("[worker] reconcile tick failed:", err))
      .finally(() => {
        reconcileInFlight = false;
      });
  }, RECONCILE_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(claimTimer);
    clearInterval(reconcileTimer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
