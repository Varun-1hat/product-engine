/**
 * ===========================================================================
 * TEMPLATE — copy this file to add or rebuild a pipeline stage.
 * ===========================================================================
 *
 * Copy to `src/stages/<stage>/index.ts` (one directory deep, same as this
 * file, so `../types` carries over), then find/replace `template`/`Template`.
 *
 * ---------------------------------------------------------------------------
 * WHAT A STAGE OWNS
 * ---------------------------------------------------------------------------
 * A stage is the orchestration layer: it decides WHAT to generate and in what
 * order, reads and writes the DB, and bills. It is the only layer allowed to
 * do all three. In exchange it gives up one thing:
 *
 *   A STAGE MUST NEVER NAME A CONCRETE MODEL.
 *
 * It resolves `(category, effective provider)` through `ctx.adapters` and
 * calls the contract. `effective provider` comes from src/lib/routing.ts
 * (scene override -> reel default), never from an if-chain here. The moment a
 * stage says `if (provider === "veo")`, the seam that lets a new model drop in
 * without touching orchestration is gone.
 *
 * The fixed order is reel_setup -> scene -> image -> clip -> trim -> outro ->
 * music -> assembly. Which scenes and clip types are included varies by
 * config; the order never does.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE MEMBERS
 * ---------------------------------------------------------------------------
 *   load()      Rehydrate for a page render. Read-only, no side effects, no
 *               paid calls — it runs on every refresh.
 *   process()   Apply user input. Idempotent where it can be.
 *   estimate()  Priced preview via ctx.costEngine. NO provider call.
 *   review      The redo/edit/revert/history hooks (optional — see below).
 *   advance()   Move `reels.current_stage` forward. Nothing else.
 *
 * A generation entry point (`generate`, `ensureXPrompts`) is a plain exported
 * function, not a StageModule member — stages differ too much in how they
 * trigger work for a common signature to be worth anything.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CostEstimate, StageContext, StageModule, StageState } from "../types";
import { nextStage } from "../types";
import type { StageId } from "@/src/lib/db/enums";
import type { ReelConfigRow } from "@/src/lib/db/types";
import { upsertAssetVersion } from "@/src/lib/versioning";

/**
 * PLACEHOLDER. A stage id must exist in `STAGES` (src/lib/db/enums.ts) and in
 * the `stage_t` Postgres enum, and be positioned in `STAGE_ORDER`
 * (src/stages/types.ts) — the enum is the DB's own type, so adding a stage is
 * a migration, not just a TS edit. Replace this with your real id.
 */
const STAGE_ID: StageId = "music";

/**
 * The zod schema IS the API contract: route handlers parse the request body
 * with it, so anything not declared here cannot reach the stage. Keep fields
 * optional and apply them individually in process() — a partial update ("just
 * change the trim") must not blank out everything the caller omitted.
 */
export const templateInputSchema = z.object({
  /** Already-uploaded storage path — the upload itself happens in the route. */
  storage_path: z.string().optional(),
  prompt: z.string().optional(),
  /** Constrain to the enum, not to `string`, so a bad value fails at the boundary. */
  source: z.enum(["generated", "uploaded"]).optional(),
});
export type TemplateInput = z.infer<typeof templateInputSchema>;

export interface TemplateOutput {
  reel_config: ReelConfigRow;
}

/**
 * Everything the page needs in one snapshot — the UI must not have to make
 * follow-up calls to render. Include advisory state the user should act on
 * (e.g. `promptStaleness(...)` when a stored prompt was optimised for a model
 * the reel no longer uses).
 *
 * Read-only on purpose: this runs on every page load, so a write here would
 * fire on refresh, and a paid call here would fire on refresh too.
 */
async function load(ctx: StageContext): Promise<StageState> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  // Supabase returns errors in-band rather than throwing — an unchecked
  // `error` is the single most common bug in this layer.
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);

  return {
    stage: STAGE_ID,
    data: { reel_config: data as ReelConfigRow },
  };
}

/**
 * Applies user input. Build the patch field-by-field from what was actually
 * supplied (`!== undefined`, not truthiness — `0` and `""` are real values),
 * so an absent field is left alone rather than nulled.
 */
async function process(input: TemplateInput, ctx: StageContext): Promise<TemplateOutput> {
  const patch: Record<string, unknown> = {};
  if (input.prompt !== undefined) patch.template_prompt = input.prompt;
  if (input.storage_path !== undefined) patch.template_path = input.storage_path;

  // Assets are append-only: a new file is a new immutable version, never an
  // overwrite, so every earlier take stays playable and revertable. Omit
  // `assetId` to create the asset row on first use.
  if (input.storage_path !== undefined) {
    await upsertAssetVersion(ctx.supa, {
      reel_id: ctx.reelId,
      slot: "music_track",
      media_type: "audio",
      storage_path: input.storage_path,
      source: input.source ?? "uploaded",
    });
  }

  const { data, error } = await ctx.supa
    .from("reel_config")
    .update(patch)
    .eq("reel_id", ctx.reelId)
    .select("*")
    .single();
  if (error) throw new Error(`reel_config update failed: ${error.message}`);

  return { reel_config: data as ReelConfigRow };
}

/**
 * Cost preview. The split is strict and worth internalising:
 *
 *   adapter.estimate()  -> units + unit_type + variant   (pure, no network)
 *   ctx.costEngine      -> dollars, from rate_card
 *
 * Neither side does the other's job. `variant` must match how the rate_card
 * rows were seeded — Veo's are resolution-qualified (`fast@1080p`) via
 * `composeVeoVariant()`, which is why that helper is exported rather than
 * inlined. A mismatch does not throw; it silently reports `rate_missing`.
 */
async function estimate(_input: TemplateInput, ctx: StageContext): Promise<CostEstimate> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  const reelConfig = data as ReelConfigRow;

  const provider = reelConfig.music_provider ?? "elevenlabs";
  const adapter = ctx.adapters.get("music", provider);
  const { units, unit_type, variant } = adapter.estimate({
    aspect_ratio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    duration_s: Number(reelConfig.total_seconds_target),
  });

  return ctx.costEngine.estimate([
    { provider, category: "music", unit_type, variant, units, client_id: ctx.clientId },
  ]);
}

/**
 * The paid path. Order matters — validate before spending, log after the call
 * returns, persist last:
 *
 *   1. Resolve the effective provider (routing.ts), never a hardcoded one.
 *   2. `adapter.validate()` and throw on violations. This is the last cheap
 *      gate before real money.
 *   3. Clamp to `adapter.capabilities()` rather than to a generic rule — each
 *      model has its own window.
 *   4. Mint an idempotency_key per attempt (a redo is a new attempt, not the
 *      same one) and pass it to both generate() and costEngine.log().
 *   5. Fetch the key through `ctx.keys` — raw keys are never held in app state.
 *   6. Log the cost. An adapter never prices; the stage always logs.
 *
 * For an async adapter (`status: "pending"`), do NOT log the cost here: park
 * the job with `ctx.jobs.markAwaitingProvider(...)` and let
 * src/lib/jobs/reconcile.ts log it on completion, reconciled against
 * job.payload. Billing twice is worse than billing late.
 */
export async function generate(ctx: StageContext): Promise<TemplateOutput> {
  const { data, error } = await ctx.supa.from("reel_config").select("*").eq("reel_id", ctx.reelId).single();
  if (error) throw new Error(`reel_config lookup failed: ${error.message}`);
  const reelConfig = data as ReelConfigRow;

  const prompt = reelConfig.music_prompt;
  if (!prompt?.trim()) throw new Error("a prompt is required before generating");

  const provider = reelConfig.music_provider ?? "elevenlabs";
  const adapter = ctx.adapters.get("music", provider);

  const caps = adapter.capabilities();
  const requestedDurationS = Number(reelConfig.total_seconds_target);
  const durationS = Math.min(
    Math.max(requestedDurationS, caps.min_duration_s ?? requestedDurationS),
    caps.max_duration_s ?? requestedDurationS
  );

  const validation = adapter.validate({ prompt, duration_s: durationS });
  if (!validation.ok) {
    throw new Error(`${provider} cannot generate this: ${validation.violations.join("; ")}`);
  }

  const idempotencyKey = randomUUID();
  const result = await adapter.generate({
    client_id: ctx.clientId,
    reel_id: ctx.reelId,
    prompt,
    aspect_ratio: reelConfig.aspect_ratio,
    resolution: reelConfig.resolution,
    duration_s: durationS,
    provider_key: await ctx.keys.forProvider(ctx.clientId, provider),
    idempotency_key: idempotencyKey,
  });

  await ctx.costEngine.log({
    reel_id: ctx.reelId,
    client_id: ctx.clientId,
    stage: STAGE_ID,
    provider,
    // The adapter's versioned id, so old rows stay comparable after a rewrite.
    adapter: adapter.id,
    call_type: "generate",
    call_status: "success",
    units: result.units,
    unit_type: result.unit_type,
    idempotency_key: idempotencyKey,
  });

  return process({ storage_path: result.asset?.storage_path, source: "generated" }, ctx);
}

/** Advances `reels.current_stage`. Never skip ahead, never do work here. */
async function advance(ctx: StageContext): Promise<StageId> {
  const next = nextStage(STAGE_ID);
  const { error } = await ctx.supa.from("reels").update({ current_stage: next }).eq("id", ctx.reelId);
  if (error) throw new Error(`reels advance failed: ${error.message}`);
  return next;
}

export const templateStage: StageModule<TemplateInput, TemplateOutput> = {
  id: STAGE_ID,
  inputSchema: templateInputSchema,
  load,
  process,
  estimate,
  advance,
  /**
   * `review` is omitted here because it is long and highly stage-specific, not
   * because it is optional in spirit — any stage a human iterates on needs it.
   *
   * Copy it from `src/stages/image/index.ts`, the reference implementation for
   * two-granularity review (prompt level + asset level); clip and outro follow
   * it. Two things to preserve when you do:
   *   - `redoAsset` must return a redacted `PublicJob` (toPublicJob), never a
   *     raw Job row — route handlers echo it straight to the browser and a Job
   *     carries `callback_token` and `payload`.
   *   - revert is a pointer move over immutable versions, never a delete.
   */
};

/**
 * ---------------------------------------------------------------------------
 * WIRING A STAGE UP
 * ---------------------------------------------------------------------------
 *   [ ] `STAGES` in src/lib/db/enums.ts + the `stage_t` enum migration
 *   [ ] `STAGE_ORDER` in src/stages/types.ts (position = pipeline order)
 *   [ ] `app/api/reels/[reelId]/<stage>/route.ts` — parse, build ctx via
 *       buildStageContext(reelId), call the stage. Keep handlers thin: no
 *       business logic in a route.
 *   [ ] `app/(app)/reels/[reelId]/<stage>/page.tsx`
 *   [ ] a GET handler that calls `reconcilePendingJobs(...)` if this stage can
 *       leave provider jobs in flight — a page load is what advances them.
 */
