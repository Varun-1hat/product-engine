# Implementation changes — V2 Phase 0: Security & correctness guardrails

Branch `v1`. Implements `.pipeline/spec.md` (V2 Phase 0) in full — all 10 items. This
supersedes the prior `.pipeline/changes.md` (the V1 greenfield build); that work is done
and this file now describes only this phase's diff on top of it.

## Verification performed

- `npx tsc --noEmit`: **clean, 0 errors.**
- `npx vitest run`: **126/128 passing**, 2 pre-existing failures — both are a **direct,
  expected** consequence of item 2's SSRF fix, not a regression elsewhere. See "Test
  fallout from the SSRF fix" below; the fix itself, not the tests, is correct per spec.
- Did not run `next build` or touch Supabase (no live project touched; the new migration
  is reviewed SQL only, consistent with how the prior phase treated migrations).

## Files changed, by spec item

### 1. Session auth (BLOCK-1)
- **`middleware.ts`** (new, repo root) — gates every route except `/api/webhooks/**` and
  `/login`/`/auth/**`. Unauthenticated `/api/**` requests get a 401 JSON body;
  unauthenticated page loads redirect to `/login?next=<path>`. Copied verbatim from the
  spec's given implementation (`@supabase/ssr`'s `createServerClient` cookie-forwarding
  pattern).
- **`app/login/page.tsx`** (new) — client component, email + "Send magic link" button
  (`supabase.auth.signInWithOtp`, browser client from `src/lib/supabase/browser.ts`),
  `next` read from `useSearchParams()` and wrapped in `Suspense` (mirrors
  `app/(app)/reels/new/page.tsx`'s pattern for the same reason — `useSearchParams` needs
  a Suspense boundary). After a successful call, the form is replaced with "Check your
  email for a sign-in link." — no click-detection attempted.
- **`app/auth/callback/route.ts`** (new) — exchanges the magic-link `code` for a session
  via `src/lib/supabase/server.ts`'s `createClient()`, then redirects to `next` (or
  `/login?error=auth` on failure). Copied verbatim from the spec.
- **`app/auth/signout/route.ts`** (new) — `POST` only; calls `supabase.auth.signOut()`,
  redirects to `/login`. Not wired into any UI yet (by design, per spec — a later phase
  adds a nav-shell control).
- Did **not** touch `src/lib/context.ts`, any `app/api/**/route.ts` handler body, or any
  `app/(app)/**` page, per spec.

### 2. Stop leaking `callback_token`; SSRF-allowlist the HeyGen download (BLOCK-2)
- **`src/lib/jobs/queue.ts`** — added `PublicJob` (`{ id, status, type, provider_job_id }`)
  and `toPublicJob(job)`. This is the shared narrowing helper the spec asked for ("do this
  at the point each hook builds its return value").
- **`src/stages/types.ts`** — `ReviewHooks.redoAsset`'s return type changed from
  `{ job?: Job; ... }` to `{ job?: PublicJob; ... }`, so the narrower shape is enforced at
  the type level, not just by convention.
- **`src/stages/clip/index.ts`** — `redoAsset` now returns
  `{ job: outcome.job ? toPublicJob(outcome.job) : undefined }` instead of the raw job.
- **`src/stages/outro/index.ts`** — both `redoAsset` return sites (end-frame branch,
  outro-clip branch) now return `{ job: toPublicJob(job) }`.
- **`src/stages/trim/index.ts`** — `redoAsset` now returns `{ job: toPublicJob(job) }`.
  Checked `revertAsset` per the spec's explicit instruction — it returns `Promise<void>`
  (no job), identical to every other stage's `revertAsset`, so no change was needed there.
- **`app/api/webhooks/heygen/route.ts`** — added `ALLOWED_HEYGEN_HOSTS` +
  `isAllowedDownloadUrl()` (verbatim from the spec: https-only, hostname matches
  `heygen.com` or `amazonaws.com`). Guards the `fetch(parsed.asset.url)` call for the
  rendered video: on a disallowed host, the job is failed with
  `"heygen webhook: refusing to download from disallowed host <hostname>"` and the route
  returns 400 without fetching. **Per spec, flagging here too:** the exact HeyGen CDN
  hostname should be confirmed and this allowlist tightened at integration time —
  `amazonaws.com` is a defensive default (HeyGen render URLs are commonly S3-backed), not
  a verified fact.
- **Related, but intentionally left alone (out of spec scope):** `clipStage.process()`
  already stripped `job` before returning (pre-existing `const { job: _job, ...rest }`),
  so it was never vulnerable. `outroStage.process()` and `trimStage.process()` still
  return a full `Job` (via `OutroOutput.end_frame_job`/`outro_clip_job` and
  `TrimOutput.job`), echoed verbatim by their non-review `route.ts` POST handlers — but
  neither `outro_gen` nor `trim` jobs are ever enqueued with a non-null `callback_token`
  (only `avatar_gen` is), so there's no real secret in that path today. The spec's item 2
  names exactly three `redoAsset` implementations and nothing else; I fixed exactly those
  and did not expand scope to `process()`'s return shapes.

### 3. Reconcile failure path (N1) — `worker/reconcile.ts`
- Added `retryLater(jobId, runAfter, error?)` to `JobQueue` (`src/lib/jobs/queue.ts`):
  re-arms a job to `awaiting_provider` with a new `run_after`, bumps `attempts` by one
  (the only "an attempt was spent" signal available here, since
  `claim_awaiting_jobs` deliberately never touches `attempts`), stores the message in
  `error`, and clears the lock — all without ever touching `status: 'queued'`/`'failed'`.
- Rewrote `reconcileJob`'s `catch` block: on any caught error, if
  `job.attempts < job.max_attempts`, it now calls `jobs.retryLater(...)` with a capped
  linear backoff (`30s * (attempts+1)`, capped at `RECONCILE_RETRY_BACKOFF_CAP_MS` = 5
  min) and returns — **no `cost_log` row is written on this path**, so the generation's
  real `idempotency_key` is never burned prematurely. Only once retries are exhausted does
  it log the (conservatively unbilled) outcome under the real `idempotency_key` and call
  `jobs.fail(job.id, message, { retry: false })` for a genuine terminal failure.
- Did not touch the surrounding poll/success logic, `categoryForJob`/`stageForJob`, or
  `runReconcileTick`.

### 4. Outro job idempotency key (N2) — `src/stages/outro/index.ts`
- `enqueueOutroClip`'s `ctx.jobs.enqueue({...})` call now includes
  `idempotency_key: randomUUID()` (new `node:crypto` import), mirroring
  `src/stages/clip/index.ts`'s b-roll enqueue. This makes the `cost_log` partial-unique
  double-charge guard non-inert for outro-via-Veo generations, and is what item 3's fix
  above actually protects for outro jobs specifically.

### 5. Job-claim lock + reconcile re-entrancy guard (N3)
- **`supabase/migrations/0005_fix_claim_lock.sql`** (new) — `CREATE OR REPLACE FUNCTION
  claim_awaiting_jobs(...)`, same signature/return shape as `0001_init.sql`'s version,
  reproduced exactly except: (a) `WHERE` gains
  `AND (locked_by IS NULL OR locked_at < now() - interval '5 minutes')`, and (b) claim now
  sets `run_after = now() + interval '1 minute'`. Also reissues the function's
  `revoke`/`grant` (service_role only) as cheap insurance — a no-op if unchanged.
  `0001_init.sql` itself was **not** edited.
- **`worker/index.ts`** — added module-level `let reconcileInFlight = false`; the
  reconcile `setInterval` callback now returns early if a tick is already in flight, sets
  the flag before calling `runReconcileTick`, and resets it in `.finally()`.

### 6. Shared-frame lineage on the image-stage reuse branch (N4) — `src/stages/image/index.ts`
- Extracted the existing scene-linking loop (previously inline in
  `generateAndPersistImage`, only reachable via fresh generation) into
  `linkSlotAsset(ctx, slotPlan, scene, assetId)`. It now also reconciles
  `assets.shared = slotPlan.shared` (previously only ever set once, at `assets` INSERT
  time), in addition to the original scene-pointer attach logic.
- Added `detachStaleSiblingLinks(ctx, scenesForReel, slotPlan, assetId)`: clears any
  *other* scene's `start_image_id`/`end_image_id` that still points at `assetId` but the
  current plan no longer links there (e.g. `transition_to_next` was turned off after the
  asset was generated as a shared boundary). Implemented with plain `.eq()` updates over
  the already-fetched `scenes` array (no `.or()` — `src/testUtils/fakeSupabase.ts`'s fake
  Postgrest client explicitly doesn't support it, and this keeps the code testable against
  it).
- `process()`'s reuse branch (`if (existingAssetId) { ... }`) now calls both
  `linkSlotAsset` and `detachStaleSiblingLinks` before reusing and `continue`-ing, instead
  of skipping straight to reuse.
- **Note for the Tester:** because `process()` fetches `scenes` once per call, a
  freshly-detached sibling's own slot is corrected in the *database* within the same
  `process()` call, but that sibling won't itself regenerate a fresh image until the
  *next* `process()` call (the in-memory `scenes` array used for that sibling's own turn
  in the same pass is the pre-detach snapshot). This matches the codebase's existing
  idiom of "the plan is recomputed from live DB state on every run" (i.e. idempotent,
  call-again-to-converge) rather than same-pass self-healing, and the spec's fix
  description (persisted-lineage correction) doesn't ask for same-pass regeneration — but
  it's worth an explicit test of the "call `process()` twice after flipping
  `transition_to_next`" scenario.

### 7. Veo variant leakage into non-Veo billing (N6) — `src/stages/clip/index.ts`
- `generateClipForScene`'s b-roll `generateInput.variant` is now
  `model === "veo" ? reelConfig.veo_variant : undefined` instead of being stamped
  unconditionally, mirroring the same `model === "veo" ? ... : ...` gate already present
  in `estimate()`'s adapter-input `variant` field in this file. Downstream,
  `enqueueClip`'s `payload.variant` (billing context) can no longer fall back to a stray
  Veo variant for non-Veo providers via `result.variant ?? generateInput.variant ?? null`.
- Scope note: the spec named only `src/stages/clip/index.ts`. `src/stages/outro/index.ts`
  has a structurally similar unconditional `variant: reelConfig.veo_variant` in
  `enqueueOutroClip`'s payload (consumed by `worker/outro.ts`'s billing-variant
  composition) that looks like the same bug pattern, but it isn't named in the spec, so I
  left it untouched — flagging it here for awareness in case a future phase wants it.

### 8. Higgsfield base-URL doubling (N7)
- **`src/adapters/config.ts`** — `HIGGSFIELD_CONFIG.baseUrl` default changed from
  `https://api.higgsfield.ai/v1` to `https://api.higgsfield.ai`. The adapter's own
  `/v1/generations` and `/v1/generations/{id}` paths (`src/adapters/video_broll/higgsfield.ts`)
  were left untouched, per spec.
- **`.env.example`** — `HIGGSFIELD_BASE_URL` updated to match (no trailing `/v1`). Did not
  touch `.env`/`.env.local` (gitignored, real local values, not requested by spec).

### 9. HeyGen combined reference budget (minor, confirmed live) — `src/adapters/video_avatar/heygen.ts`
- `validateInput()` now also checks `avatar_ids.length + videoRefCount <=
  CAPABILITIES.max_reference_videos`, in addition to (not instead of) the existing
  standalone `min_avatar_ids`/`max_avatar_ids` check on `avatar_ids.length`. The image
  budget check (`imageRefCount <= max_reference_images`) is unchanged.
- **Flagging per the spec's closing instruction: this needs new test coverage.** The
  existing `src/adapters/video_avatar/heygen.test.ts` only covers avatar-count-alone and
  image-budget cases; nothing exercises `avatar_ids.length + videoRefCount` together (e.g.
  2 avatars + 2 reference videos = 4 > max_reference_videos(3), which the old code
  allowed and the new code correctly rejects).

### 10. Rate-card cache TTL (minor) — `src/lib/cost/engine.ts`
- `rateCache` now stores `{ rows, fetchedAt }` per `provider::unit_type` key instead of
  bare rows; `ratesFor()` re-fetches once `Date.now() - fetchedAt` exceeds the new named
  constant `RATE_CACHE_TTL_MS` (5 minutes).

## Bug found and fixed along the way

While writing the `PublicJob` doc comment in `src/lib/jobs/queue.ts`, a literal `**/`
inside a path fragment (`app/api/**/review/route.ts`) inside a `/** ... */` block comment
closed the comment early and broke the file's syntax. Caught immediately by
`tsc --noEmit`; fixed by rewording the comment to avoid the `**/` substring
(`app/api/reels/[reelId]/{image,clip,outro}/review/route.ts`). Mentioning this only
because it's exactly the kind of thing worth a second look if any other comment in this
diff mentions a `**/`-shaped glob.

## Test fallout from the SSRF fix (item 2) — what the Tester will see

`npx vitest run` → 2 failures, both in `app/api/webhooks/heygen/route.test.ts`:
- `"downloads the video, uploads it, logs the real $7 flat cost, ..."`
- `"a resent webhook (same idempotency_key) does NOT double-charge cost_log, ..."`

Both mock the HeyGen webhook's `video_url` as `https://cdn.heygen.example/...` (lines 208,
213, 280). `.example` is a reserved non-routable TLD used precisely because it's fake — but
that also means it correctly fails the new `isAllowedDownloadUrl()` allowlist (neither
`heygen.com` nor `amazonaws.com`), so the route now 400s instead of downloading. This is
the SSRF fix working as intended, not a regression. Fix: update those two tests' mock
`video_url` (and the `fetchMock`/`toHaveBeenCalledWith` assertions that check it) to a host
that matches the allowlist, e.g. `https://cdn.heygen.com/...` or an S3-shaped
`https://heygen-videos.s3.amazonaws.com/...`. I did not make this change myself — per my
instructions, the test suite is the Tester's stage, not mine; `npx tsc --noEmit` (the only
verification gate I own) is clean.

## What the Tester should prioritize (per spec's closing instruction)

`worker/**` has **zero** existing test files (confirmed: `find . -name "*.test.ts"` has no
hits under `worker/`). Two items in this phase specifically need coverage there / adjacent
to it, called out explicitly by the spec:

1. **Item 3 (N1, `worker/reconcile.ts`)** — the entire re-arm-vs-terminate branch is new
   and untested: (a) a transient poll error with `attempts < max_attempts` re-arms via
   `jobs.retryLater` (status stays/returns to `awaiting_provider`, `attempts` bumps by
   exactly 1, `run_after` moves forward, no `cost_log` row is written); (b) a transient
   error once `attempts >= max_attempts` logs `failed_unbilled` under the real
   `idempotency_key` and calls `jobs.fail(..., { retry: false })` (status `failed`,
   non-retryable). Also worth a `src/lib/jobs/queue.ts`-level unit test for the new
   `retryLater` primitive itself (attempts increment, `run_after`/`error`/lock fields).
2. **Item 9 (HeyGen combined budget, `src/adapters/video_avatar/heygen.ts`)** — a case
   where `avatar_ids.length` alone is within `[1,3]` and `videoRefCount` alone is within
   the video-reference cap, but their **sum** exceeds `max_reference_videos` (e.g. 2
   avatars + 2 reference videos), which must now fail validation.

Also worth a look, lower priority: item 5's new `claim_awaiting_jobs` lock/lease filter and
item 6's `detachStaleSiblingLinks` (both are pure-SQL / pure-DB-state logic without direct
unit coverage today — item 6 can be tested against `fakeSupabase` since it deliberately
avoids `.or()`).
