# Review — Stage 4 (final), AI Product-Video Pipeline, branch `v1`

# VERDICT: BLOCK

Independently verified this pass (not taken on report):
- `npx tsc --noEmit` — clean, 0 errors.
- `npx vitest run` — **128/128 passing, 12 files**. The reported green state is real.
- Reviewed the full changeset by reading source (182 untracked paths, ~12.6k lines of
  ts/tsx/sql). `git diff` is empty because nothing is tracked yet — this was read
  directly, not diffed.
- Spot-checked every wave-1 adapter field-by-field against `skills/providers/*/SKILL.md`.

The green suite is accurate and the tests that exist are good. They do not cover the
defects below. Two of these are security issues that make the app unsafe to expose, and
four are correctness defects in paths with zero test coverage.

---

## BLOCK-1 — No authentication on any `/api/**` route, against a service-role client

`src/lib/context.ts:20,28,47,59` — every context builder calls `createServiceClient()`,
which **bypasses RLS by design** (`src/lib/supabase/service.ts:27`). No route handler
checks a session; there is no `middleware.ts`; there is no `/login`. The RLS policies in
`supabase/migrations/0002_rls.sql` therefore protect nothing on the actual attack surface —
they only govern a browser session that does not exist yet.

Reachable today by any unauthenticated caller who can hit the host:
- `POST /api/reels/[reelId]/clip` -> `src/stages/clip/index.ts` -> `adapter.generate()` with
  the client's decrypted key. HeyGen is $7.00 flat per avatar scene; Veo standard@1080p is
  8s x $0.40 = $3.20 per b-roll scene. Loopable. Unbounded spend on the *client's* paid
  provider accounts, and `POST .../clip/review {action:"redoAsset"}` re-bills on demand.
- `PATCH /api/clients/[clientId]` (`app/api/clients/[clientId]/route.ts:17`) accepts
  `provider_keys:[{provider, api_key}]` -> `src/stages/config/index.ts:115` writes to Vault.
  Any caller can overwrite any client's Google/HeyGen key.
- `POST .../{image,clip,outro}/review {action:"download"}` -> signed URLs for every private
  asset in Storage.
- Full read of clients, reels, prompts, scenes, and `cost_log`.

`changes.md` gap #1 states this must be added before deployment. I agree, and I am not
willing to let a SHIP verdict carry it: this is the only control between the internet, a
service-role key, and third-party billing.

**Fix:** add a `middleware.ts` (or a shared `requireSession()` helper) that authenticates
every `/api/**` route except `/api/webhooks/**` via `src/lib/supabase/server.ts`, returning
401 on no session. Webhook routes keep their own token auth.

## BLOCK-2 — `jobs.callback_token` is serialized into API responses (webhook forgery + SSRF)

`src/stages/clip/index.ts:411` (`redoAsset` returns `{ job: outcome.job }`), and
`src/stages/outro/index.ts:299,315`, `src/stages/trim/index.ts:92,151` all return the raw
`jobs` row. `app/api/reels/[reelId]/clip/review/route.ts:22-23` (and the outro/trim
equivalents) `NextResponse.json()` it verbatim. `Job` includes `callback_token`
(`src/lib/jobs/queue.ts:30`).

That token is the *sole* authenticator for `/api/webhooks/heygen`
(`app/api/webhooks/heygen/route.ts:35-45`). Anyone holding it can POST a forged
`avatar_video.success` with an arbitrary `video_url`, which line 101 then fetches with no
scheme/host allowlist — SSRF from the app's network position (cloud metadata endpoints,
internal services) — and stores the response bytes as the scene's generated clip while
logging a $7 `cost_log` row. Fixing BLOCK-1 narrows this to authenticated staff browsers
but does not remove it: the token still lands in browser-reachable JSON.

**Fix:** redact before serializing — return `{id, status, type, provider_job_id}` from
review/trim handlers, never `callback_token`/`payload`. Separately, allowlist the download
host in `app/api/webhooks/heygen/route.ts:101`.

---

## NEEDS WORK (correctness — untested paths)

### N1 — A transient poll error permanently loses a paid generation *and* destroys its cost record

`worker/reconcile.ts:123-140`. Any throw inside the try block (Veo/HeyGen 429/5xx, the
video download in `veo.ts:137` / `heygen.ts:218`, a Storage upload, a DB hiccup) does two
damaging things:

1. Logs `failed_unbilled` **using `job.idempotency_key`**. That burns
   `UNIQUE(reel_id, provider, idempotency_key)`, so when the same generation is later
   confirmed successful, `engine.ts:198-213` returns the existing `cost_usd = 0` row. The
   real charge can never be recorded, and `asset_versions.cost_log_id` points at a $0 row.
2. Calls `jobs.fail(job.id, message)` with retry defaulted on
   (`src/lib/jobs/queue.ts:134-152`), which moves an `awaiting_provider` job to status
   **`queued`** — where `worker/index.ts:108-115` *deliberately throws*
   ("reached the main claim loop unexpectedly"). The job ping-pongs through the claim loop
   until `attempts` exhausts, then dies terminally. The clip the provider already generated
   and billed is orphaned with no recovery path but a full-price manual redo.

**Fix:** in the catch, return the job to `awaiting_provider` with a backoff for transient
errors (`jobs.fail(..., {retry:false})` plus an explicit re-arm), and do not consume the
generation's idempotency key on a non-terminal failure — use a distinct key, or only log
cost on terminal failure.

### N2 — Outro clip generation has no cost idempotency key at all

`src/stages/outro/index.ts:127-149` enqueues the `outro_gen` job with no
`idempotency_key`, unlike `src/stages/clip/index.ts:152`. `worker/reconcile.ts:103`
therefore passes `undefined`, so the double-charge guard is inert for every
outro-via-Veo generation. Combined with N3 this is a live double-charge path.
**Fix:** pass an `idempotency_key` on the outro enqueue, as Stage 5 does.

### N3 — `claim_awaiting_jobs` has no lock/lease filter; overlapping reconcile ticks duplicate completion

`supabase/migrations/0001_init.sql:579-586` selects on `status='awaiting_provider' AND
run_after <= now()` only. It sets `locked_by`/`locked_at` but never filters on them, and
never advances `run_after`. `worker/index.ts:157-161` fires `runReconcileTick` on a fixed
15s `setInterval` with no in-flight guard. The completion tick downloads a video and uploads
it to Storage — routinely over 15s — so tick N+1 re-claims the same row and re-runs the
whole completion path: a duplicate `asset_versions` row that becomes `current_version_id`,
a duplicate `jobs.complete`, and (for outro jobs, per N2) a duplicate `cost_log` row. Also
unsafe for more than one worker process.
**Fix:** add `and (j.locked_by is null or j.locked_at < now() - interval '5 minutes')` to
the RPC, and/or push `run_after` forward on claim; guard the interval against re-entry.

### N4 — Shared-boundary-frame lineage is never reconciled when the plan changes

`src/stages/image/index.ts:213-217`. `process()` short-circuits on the primary scene's
existing `start_image_id`/`end_image_id` and `continue`s **before** reaching the
scene-linking loop at lines 192-198. `planImageSlots` is recomputed from live DB state on
every run, but the *linking* is not — so the plan and the persisted lineage silently
diverge.

Concrete, reachable sequence (spec §7 Stage 3 explicitly permits editing boundaries and
per-scene overrides after Stage 4 has run):

- Run Stage 4 with A->B `hard_cut`. A gets its own end image, B its own start image.
- Change A's `transition_to_next` to `continuous`; re-run Stage 4.
- The plan now emits `A:end~shared~B:start`. `A.end_image_id` already exists -> reused ->
  `continue`. `B.start_image_id` is **never re-pointed** at it, and `assets.shared` on that
  row stays `false`.
- Result: the §2.4 invariant `scenes[N].end_image_id == scenes[N+1].start_image_id` is
  violated while `effectiveBoundary()` still reports `continuous`. Stage 5 hands Veo a
  mismatched start/end pair, and Stage 9 (`src/stages/assembly/plan.ts:100-105`) still drops
  a head frame at a seam whose frames do not match — a visible glitch. The UI shared badge
  and the Stage 6 seam hint both lie.
- The mirror case (continuous -> hard_cut, or an override to Higgsfield) leaves B with
  **no** start image and no way to generate one — `planImageSlots` keeps skipping B's own
  start slot in favour of the reused shared frame, so Stage 5 blocks that scene permanently.

This entire persistence path has zero coverage: `src/stages/image/plan.test.ts` tests only
the pure planner.
**Fix:** on the reuse branch, still run the linking loop and reconcile `assets.shared` plus
the sibling scene's pointer against the current plan (and detach a now-unshared frame).

### N5 — The Veo variant fix is correct, but only its estimate half is tested

I read the fix rather than trusting the green suite. It is **well designed**: composition
lives in exactly one place (`src/adapters/video_broll/veo.ts:90`), the bare variant is
preserved everywhere the SDK needs it (`VEO_CONFIG.models[variant]`, `isVeoVariant`), and
`worker/outro.ts:229-232` correctly takes precedence over Veo's echoed-back bare
`result.variant`. `worker/reconcile.ts:101` (`payload.variant ?? result.variant`) picks it
up. **No defect found in the fix itself.**

But the coverage is lopsided. `app/api/reels/[reelId]/clip/estimate/route.test.ts:145-189`
is a genuinely strong regression guard — real route, real adapter, real cost engine, seeded
with the exact migration shape — and it covers `estimate()` only. The path that produces
**real money rows** has no test anywhere:

- `src/stages/clip/index.ts:161-164` writing `job.payload.variant`
- `worker/reconcile.ts:101` reading it into `costEngine.log`
- `worker/outro.ts:229-232` — the one the Coder describes as "required a real fix, not just
  verification", i.e. the highest-risk line in the change

`worker/**` has no test file at all. "The code reads correctly" is precisely the standard
that let the original bug through.
**Fix:** add a reconcile-level test asserting `cost_log.variant === "fast@1080p"` and
`cost_usd` approx `units * 0.12` after a Veo `broll_gen` job completes, and one asserting
`worker/outro.ts` rewrites `job.payload.variant` to the composed form.

### N6 — Higgsfield billing will be permanently rate_missing, even after its rate is entered

`src/stages/clip/index.ts:220` sets `generateInput.variant = reelConfig.veo_variant` for
**every** b-roll provider, not just Veo. Line 164's fallback
(`result.variant ?? generateInput.variant ?? null`) then stores `"fast"` as
`job.payload.variant` for a Higgsfield job. `worker/reconcile.ts:101` feeds that to
`costEngine.log`, and `src/lib/cost/rateCard.ts:41` requires an exact `variant` match — so
it will never match the `higgsfield | credit | variant NULL` row that
`0004_seed_rate_card.sql:46-47` instructs the operator to insert at wave-2 integration.
The estimate path is unaffected (Higgsfield's `estimate()` omits `variant`), which is what
makes this easy to miss — it is the same class of bug the Tester just found for Veo, one
wave later.
**Fix:** only set `variant` on `GenerateInput` / the job payload when the provider actually
uses one.

### N7 — Higgsfield base URL is doubled

`src/adapters/config.ts:43` defaults to `https://api.higgsfield.ai/v1` (and `.env.example`
sets the same), while `src/adapters/video_broll/higgsfield.ts:109,143` append
`/v1/generations`, producing `https://api.higgsfield.ai/v1/v1/generations`.
`higgsfield.test.ts` never asserts the URL. Wave-2 only, but definite.
**Fix:** drop `/v1` from the config default, or from the adapter's paths.

---

## Minor / notes (not blocking)

- `cost_log` uses a plain `UNIQUE(reel_id, provider, idempotency_key)`
  (`0001_init.sql:313-314`) rather than the spec's partial unique
  `WHERE idempotency_key IS NOT NULL`. Under Postgres' default NULLS-DISTINCT semantics
  this is behaviourally equivalent — noting it as a safe deviation, not a gap.
- `createCostEngine`'s `rateCache` (`engine.ts:106`) has no TTL, and `worker/index.ts:145`
  builds one engine at process start that lives forever. A `rate_card` edit — exactly the
  Higgsfield wave-2 flow — requires a worker restart to take effect.
- HeyGen `validate()` (`heygen.ts:90-98`) counts only `references` toward the reference
  budget; spec §3.1 and the skill file say the 3-video/9-image budget is "looks + refs"
  combined. 3 looks + 9 image refs would pass validation and exceed it.
- `worker/trim.ts:28` re-encodes with `.audioCodec("aac")`, carrying Veo's native audio
  through Stage 6. Assembly's `-an` still strips it so the final render is correct, but the
  spec says strip on ingest *and* at assembly.
- Stage 4 generates start images for b-roll scenes that have no effective b-roll model
  (`plan.ts:45-56` uses `model ?? ""`), spending $0.039/image; spec §7 Stage 2 says Stage
  4/7 should block with "select a b-roll model".
- Migrations have never run against a real Postgres. The `supabase_vault` extension name,
  the `vault.create_secret` signature, and the mutually-referential FK ordering are all
  plausible but unproven — the first `supabase db reset` is the real test.
- Untested areas I agree are lower priority than the above: `app/components/**`,
  `src/lib/crypto/vault.ts` (the Google-key fallback), `src/stages/config`'s clone path.

---

## What is genuinely good (so this is not read as a rejection of the build)

- **Adapters match their skill files.** Verified field-by-field: Veo's
  `generateVideos({model, prompt, image, config:{lastFrame,...}})` plus
  `getVideosOperation` polling and the $0.40 / $0.10 / $0.12 tiers; Nano Banana's
  `gemini-2.5-flash-image` with `contents[].parts[].inlineData` at $0.039; HeyGen's
  `x-api-key`, `POST /v3/videos` cinematic_avatar body, `GET /v3/avatars/looks`, flat $7.
  Higgsfield matches too, modulo N7 and its own documented low confidence.
- **The Veo fix is architecturally right**, not a patch: one composition point, bare variant
  preserved where the SDK needs it, correct precedence in the worker.
- **The idempotency guard itself is sound** (`engine.ts:198-213`: catch 23505, refetch,
  return existing). The problems (N1, N2) are in what feeds it, not in the guard.
- **`resolveRateFromRows`** correctly implements client-override precedence and the
  half-open `[effective_from, effective_to)` window.
- **Vault design is sound.** Raw keys only via SECURITY DEFINER RPCs with `search_path=''`,
  EXECUTE revoked from `public/anon/authenticated` and granted to `service_role` only; no
  code path returns a decrypted key in a response; `loadConfig` never selects
  `provider_keys`; clone correctly omits them.
- **The tests that exist are meaningful, not superficial.** `routing.test.ts` walks the real
  `effectiveBoundary` truth table including per-scene-override and avatar-adjacent
  boundaries; `image/plan.test.ts` asserts a 3-scene continuous run yields 4 slots not 6;
  `assembly/plan.test.ts` pins seam-trim placement and the music loop / fade-cap math; the
  webhook route test exercises the real adapter and real cost engine and proves the
  `job.payload -> asset_versions.metadata` handoff. The Tester's route-level test that
  caught the Veo bug was the right instinct — seeding the fixture from the actual migration
  rather than from what the code happens to emit.

---

## To clear this review

1. BLOCK-1: session-gate every `/api/**` route except webhooks.
2. BLOCK-2: stop serializing `jobs.callback_token`; allowlist the webhook download host.
3. N1: fix reconcile's failure path (retry semantics, and do not burn the idempotency key).
4. N2: give the outro job an `idempotency_key`.
5. N3: add a lock/lease filter to `claim_awaiting_jobs`; guard reconcile re-entry.
6. N4: reconcile shared-frame linkage on the Stage-4 reuse branch.
7. N5: test the billing half of the Veo variant fix (reconcile + worker/outro).
8. N6/N7: stop leaking `veo_variant` into non-Veo providers; fix the Higgsfield URL.

Items 1-6 are required. Items 7-8 are required before Higgsfield goes live and strongly
recommended now.
