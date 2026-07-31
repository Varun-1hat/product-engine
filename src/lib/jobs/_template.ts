/**
 * ===========================================================================
 * TEMPLATE — copy this file to add a new job handler.
 * ===========================================================================
 *
 * Copy to `src/lib/jobs/<job>.ts` (same directory, so imports carry over),
 * then find/replace `template`/`Template`.
 *
 * ---------------------------------------------------------------------------
 * WHAT A JOB IS HERE — read this before adding one
 * ---------------------------------------------------------------------------
 * There is no worker process. Jobs run INLINE, inside the request that
 * enqueues them (src/lib/jobs/run.ts). The `jobs` table is the record of what
 * ran — status, attempts, idempotency, cost trail — not a work queue anything
 * polls. This volume does not justify a standing poller.
 *
 * So a job is worth creating for exactly two reasons:
 *
 *   A. LOCAL WORK WORTH RECORDING — ffmpeg trim, end-frame render, assembly.
 *      Runs to completion inline; the row exists so a failure is inspectable
 *      and a retry is bounded. This template shows that shape.
 *
 *   B. WORK THAT LEAVES THE PROCESS — a provider render taking minutes. The
 *      job is parked in `awaiting_provider` and finished later by
 *      src/lib/jobs/reconcile.ts on a subsequent read. See the note at the
 *      bottom; you usually do NOT write a new handler for this case.
 *
 * If the work is fast, synchronous, and not worth an audit row, do not create
 * a job — call it directly from the stage. `image_gen` exists in the enum and
 * is deliberately unimplemented for exactly that reason: Nano Banana is
 * synchronous, so a job would be pure overhead.
 *
 * ---------------------------------------------------------------------------
 * THE HANDLER CONTRACT
 * ---------------------------------------------------------------------------
 *   - Signature `(supa, storage, job)`, plus whatever else the work needs
 *     (`adapters`/`keys`/`jobs` — pass them as one object once the list grows,
 *     as runOutroGenJob does).
 *   - Do the work. THROW on failure; do not swallow and do not mark the job
 *     yourself. runJobInline() records the failure via jobs.fail() and
 *     re-throws so the route surfaces it.
 *   - Do NOT call jobs.complete() in here either — the dispatcher does it, so
 *     that "the work finished" and "the row says finished" cannot diverge.
 *     The one exception is a handler that transitions to `awaiting_provider`,
 *     which must say so by returning a status the dispatcher understands.
 */
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { StorageClient } from "@/src/lib/storage";
import type { AssetVersionMetadata } from "@/src/lib/db/types";
import { getAsset, upsertAssetVersion } from "@/src/lib/versioning";
import type { Job } from "./queue";
import { withTempDir, writeTempFile, readTempFile } from "./tempFiles";

/**
 * `job.payload` is `Record<string, unknown>` — untyped by the time it comes
 * back out of Postgres. Declare the shape you enqueued, cast once at the top
 * of the handler, and guard the fields you actually depend on. A job row can
 * outlive the code that wrote it, so treat the payload as untrusted input.
 */
export interface TemplateJobPayload {
  base_version_id: string;
  /** Whatever parameters the operation needs. Keep it small — it is stored as jsonb. */
  intensity?: number;
}

/**
 * Local media work runs in a temp dir that is always cleaned up, even on
 * throw. Never write to the repo or to a path derived from user input.
 */
async function transformMedia(inputPath: string, outputPath: string, _intensity: number): Promise<void> {
  // ffmpeg work goes here — see ./trim.ts (re-encode a slice) and
  // ./assembly.ts (concat + audio bed) for the two real shapes. Import the
  // shared binary setup from ./ffmpegSetup, never `fluent-ffmpeg` directly:
  // it is what points at the bundled ffmpeg-static binary.
  void inputPath;
  void outputPath;
  throw new Error("template job: replace transformMedia() with the real operation");
}

export async function runTemplateJob(supa: ServiceClient, storage: StorageClient, job: Job): Promise<void> {
  const payload = job.payload as unknown as TemplateJobPayload;

  // Guard first, and name the job id in every message — these errors are read
  // later, out of context, off a failed row.
  if (!job.asset_id) throw new Error(`template job ${job.id} has no asset_id`);
  if (!payload?.base_version_id) throw new Error(`template job ${job.id} payload missing base_version_id`);

  const { data: versionData, error } = await supa
    .from("asset_versions")
    .select("storage_path, metadata")
    .eq("id", payload.base_version_id)
    .single();
  if (error) throw new Error(`asset_versions lookup failed: ${error.message}`);

  const baseVersion = versionData as { storage_path: string | null; metadata: AssetVersionMetadata };
  if (!baseVersion.storage_path) throw new Error(`base version ${payload.base_version_id} has no storage_path`);

  const asset = await getAsset(supa, job.asset_id);

  await withTempDir(async (dir) => {
    const inputBuffer = await storage.download("assets", baseVersion.storage_path!);
    const inputPath = await writeTempFile(dir, "input.mp4", inputBuffer);
    const outputPath = `${dir}/output.mp4`;

    await transformMedia(inputPath, outputPath, payload.intensity ?? 1);

    // Never overwrite the source object — versions are immutable, and the old
    // file must stay playable for revert.
    const destPath = baseVersion.storage_path!.replace(/\.[a-z0-9]+$/i, "") + `-template-${Date.now()}.mp4`;
    await storage.upload("assets", destPath, await readTempFile(outputPath), "video/mp4");

    // `source: "derived"` marks output computed from another version, as
    // opposed to "generated" (a provider call) or "uploaded" (a human).
    // Carrying `base_version_id` in metadata is what makes the lineage
    // readable in the history UI.
    await upsertAssetVersion(supa, {
      assetId: asset.id,
      reel_id: asset.reel_id,
      scene_id: asset.scene_id,
      slot: asset.slot,
      media_type: asset.media_type,
      shared: asset.shared,
      storage_path: destPath,
      source: "derived",
      metadata: { ...baseVersion.metadata, base_version_id: payload.base_version_id },
    });
  });
}

/**
 * ---------------------------------------------------------------------------
 * REGISTER IT
 * ---------------------------------------------------------------------------
 *   [ ] `JOB_TYPES` in src/lib/db/enums.ts + a `job_type_t` enum migration
 *       (a new enum value cannot be USED in the same transaction that adds it
 *       — see supabase/migrations/0008 for why; keep the alter in its own file)
 *   [ ] a `case` in `dispatchJob()` in ./run.ts, calling this handler and then
 *       `deps.jobs.complete(job.id)`
 *   [ ] enqueue it from the stage: `ctx.jobs.enqueue({ reel_id, asset_id, type, payload })`,
 *       then `runJobInline(deps, job)` to execute it in that same request
 *
 * A `case` that is unreachable should still exist and THROW with an
 * explanation, rather than fall through to `default` — ./run.ts does this for
 * broll_gen/avatar_gen (handled inline by src/stages/clip) and image_gen
 * (synchronous provider). A silently dropped job is invisible; a loud one is a
 * bug report.
 *
 * ---------------------------------------------------------------------------
 * THE PROVIDER-ASYNC CASE (B) — usually NOT a new handler
 * ---------------------------------------------------------------------------
 * When the work is a provider render, there is nothing to run inline. The
 * stage calls `adapter.generate()`, gets `status: "pending"`, and calls
 * `jobs.markAwaitingProvider(job.id, provider_job_id)`. The job then sits
 * until `reconcilePendingJobs()` — called from the stage GET handlers, so a
 * page load is what advances it — claims it via `claim_awaiting_jobs`
 * (FOR UPDATE SKIP LOCKED, 1-minute lease, so two concurrent requests can
 * never poll or complete the same job twice), calls `adapter.poll()`, and on
 * success writes the asset_versions row and the cost_log row.
 *
 * reconcile.ts is generic over the adapter contract, so A NEW PROVIDER IN AN
 * EXISTING CATEGORY NEEDS NO CHANGE HERE — implement `poll()` (or
 * `parseWebhook()`) on the adapter and it is handled. The one thing that is
 * not generic is `categoryForJob()`, which maps job.type -> category; a new
 * async job TYPE needs a case added there, or its cost is logged against no
 * category. Read reconcile.ts before adding a handler for this case; you
 * almost certainly do not need one.
 */
