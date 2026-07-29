/**
 * Postgres `jobs` queue (Assumption 3 / brief §10.19): claimed with
 * `FOR UPDATE SKIP LOCKED` via the `claim_jobs`/`claim_awaiting_jobs` RPCs
 * in supabase/migrations/0001_init.sql — no extra infra (no Redis/SQS).
 * enqueue/complete/fail/get are plain table operations (service_role
 * bypasses RLS); claiming needs the atomic RPC so concurrent workers never
 * grab the same row. Server/worker-only by code-organization convention
 * (see src/lib/supabase/service.ts for why `server-only` is not used here
 * — this module must also run under Vitest and the tsx-run worker).
 */
import type { ServiceClient } from "@/src/lib/supabase/service";
import type { JobStatus, JobType, Provider } from "@/src/lib/db/enums";

export interface Job {
  id: string;
  /** Nullable: job_type_t 'avatar_pull' is a client-level Stage-1 operation with no reel yet. */
  reel_id: string | null;
  scene_id: string | null;
  asset_id: string | null;
  type: JobType;
  provider: Provider | null;
  status: JobStatus;
  provider_job_id: string | null;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  callback_token: string | null;
  locked_by: string | null;
  locked_at: string | null;
  run_after: string;
  created_at: string;
  updated_at: string;
}

/**
 * Public-safe subset of Job — review-hook `redoAsset` return values (echoed
 * verbatim by app/api/reels/[reelId]/{image,clip,outro}/review/route.ts
 * handlers via NextResponse.json()) must never leak `callback_token` or
 * `payload` (BLOCK-2 — .pipeline/review.md).
 */
export interface PublicJob {
  id: string;
  status: JobStatus;
  type: JobType;
  provider_job_id: string | null;
}

export function toPublicJob(job: Job): PublicJob {
  return { id: job.id, status: job.status, type: job.type, provider_job_id: job.provider_job_id };
}

export interface EnqueueInput {
  reel_id: string | null;
  scene_id?: string | null;
  asset_id?: string | null;
  type: JobType;
  provider?: Provider | null;
  payload?: Record<string, unknown>;
  idempotency_key?: string | null;
  callback_token?: string | null;
  run_after?: Date;
  max_attempts?: number;
}

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<Job>;
  /** Claim `limit` queued jobs (status queued -> processing, bumps attempts). */
  claim(workerId: string, types?: JobType[], limit?: number): Promise<Job[]>;
  /** Claim `limit` awaiting_provider jobs for polling (status/attempts untouched). */
  claimAwaitingProvider(workerId: string, limit?: number): Promise<Job[]>;
  markAwaitingProvider(jobId: string, providerJobId: string): Promise<Job>;
  complete(jobId: string, result?: Record<string, unknown>): Promise<Job>;
  fail(jobId: string, error: string, opts?: { retry?: boolean }): Promise<Job>;
  /**
   * Re-arms an awaiting_provider job for another poll attempt WITHOUT
   * transitioning it to a terminal/queued state (unlike fail(), which moves
   * a retryable job to 'queued' — a status worker/index.ts's main claim
   * loop treats as fatal for broll_gen/avatar_gen/outro_gen, since those
   * job types never pass through it). Bumps `attempts` by one (this queue
   * has no other "an attempt was just spent" signal for awaiting_provider
   * jobs — claim_awaiting_jobs deliberately leaves attempts untouched,
   * since a poll isn't a generate attempt) so a caller-side
   * `attempts >= max_attempts` cap still eventually terminates. Used by
   * worker/reconcile.ts's transient-error path (N1).
   */
  retryLater(jobId: string, runAfter: Date, error?: string): Promise<Job>;
  release(jobId: string): Promise<void>;
  get(jobId: string): Promise<Job | null>;
}

export function createJobQueue(supa: ServiceClient): JobQueue {
  const queue: JobQueue = {
    async enqueue(input) {
      const { data, error } = await supa
        .from("jobs")
        .insert({
          reel_id: input.reel_id,
          scene_id: input.scene_id ?? null,
          asset_id: input.asset_id ?? null,
          type: input.type,
          provider: input.provider ?? null,
          payload: input.payload ?? {},
          idempotency_key: input.idempotency_key ?? null,
          callback_token: input.callback_token ?? null,
          run_after: (input.run_after ?? new Date()).toISOString(),
          max_attempts: input.max_attempts ?? 3,
        })
        .select("*")
        .single();
      if (error) throw new Error(`jobs.enqueue failed: ${error.message}`);
      return data as Job;
    },

    async claim(workerId, types, limit = 1) {
      const { data, error } = await supa.rpc("claim_jobs", {
        p_worker_id: workerId,
        p_types: types ?? null,
        p_limit: limit,
      });
      if (error) throw new Error(`jobs.claim failed: ${error.message}`);
      return (data ?? []) as Job[];
    },

    async claimAwaitingProvider(workerId, limit = 10) {
      const { data, error } = await supa.rpc("claim_awaiting_jobs", {
        p_worker_id: workerId,
        p_limit: limit,
      });
      if (error) throw new Error(`jobs.claimAwaitingProvider failed: ${error.message}`);
      return (data ?? []) as Job[];
    },

    async markAwaitingProvider(jobId, providerJobId) {
      const { data, error } = await supa
        .from("jobs")
        .update({ status: "awaiting_provider", provider_job_id: providerJobId })
        .eq("id", jobId)
        .select("*")
        .single();
      if (error) throw new Error(`jobs.markAwaitingProvider failed: ${error.message}`);
      return data as Job;
    },

    async complete(jobId, result) {
      const { data, error } = await supa
        .from("jobs")
        .update({
          status: "succeeded",
          result: result ?? null,
          locked_by: null,
          locked_at: null,
          error: null,
        })
        .eq("id", jobId)
        .select("*")
        .single();
      if (error) throw new Error(`jobs.complete failed: ${error.message}`);
      return data as Job;
    },

    async fail(jobId, errorMessage, opts) {
      const current = await queue.get(jobId);
      const canRetry = opts?.retry !== false && !!current && current.attempts < current.max_attempts;

      const update: Record<string, unknown> = {
        status: canRetry ? "queued" : "failed",
        error: errorMessage,
        locked_by: null,
        locked_at: null,
      };
      if (canRetry) {
        // Simple linear backoff: 30s * attempts already made.
        update.run_after = new Date(Date.now() + 30_000 * (current?.attempts ?? 1)).toISOString();
      }

      const { data, error } = await supa.from("jobs").update(update).eq("id", jobId).select("*").single();
      if (error) throw new Error(`jobs.fail failed: ${error.message}`);
      return data as Job;
    },

    async retryLater(jobId, runAfter, error) {
      const current = await queue.get(jobId);
      const update: Record<string, unknown> = {
        status: "awaiting_provider",
        attempts: (current?.attempts ?? 0) + 1,
        run_after: runAfter.toISOString(),
        error: error ?? null,
        locked_by: null,
        locked_at: null,
      };

      const { data, error: updateError } = await supa.from("jobs").update(update).eq("id", jobId).select("*").single();
      if (updateError) throw new Error(`jobs.retryLater failed: ${updateError.message}`);
      return data as Job;
    },

    async release(jobId) {
      const { error } = await supa
        .from("jobs")
        .update({ status: "queued", locked_by: null, locked_at: null })
        .eq("id", jobId);
      if (error) throw new Error(`jobs.release failed: ${error.message}`);
    },

    async get(jobId) {
      const { data, error } = await supa.from("jobs").select("*").eq("id", jobId).maybeSingle();
      if (error) throw new Error(`jobs.get failed: ${error.message}`);
      return (data as Job) ?? null;
    },
  };

  return queue;
}
