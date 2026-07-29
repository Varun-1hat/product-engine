# Test results — V2 Phase 0 (Tester)

Branch `v1`. Read `.pipeline/changes.md` and `.pipeline/spec.md` in full, plus every changed
file. This supersedes the prior `.pipeline/test-results.md` (the V1 greenfield build's Tester
pass, 128/128) — that content is preserved in git history; this file now covers only this
phase's (V2 Phase 0: security & correctness guardrails) testing.

**Status: PASSING. 169/169 tests, 0 failures, 0 regressions.**

## Bottom line

- Combined suite (`npx vitest run`): **169/169 passing** (up from the Coder's reported
  126/128 — see "The 2 known failures" below for the 2, and "New tests added" for the +41).
  Re-ran 3 times in a row for stability; consistently 169/169, exit code 0 every time.
- `npx tsc --noEmit`: **clean, 0 errors** (re-verified after my own test files — one of my
  first drafts had a type error, fixed before this report; see below).
- New tests added by me: **41**, across 5 new test files + additions to 3 pre-existing ones.
- No product/application code was modified — only test files and two pieces of test
  infrastructure (`vitest.config.ts`'s `include` glob, and the stale fixture inside an
  existing test file — see below for why that's test-maintenance, not a product fix).
- `npx next build` was not run (out of scope for this pass's instructions; `npx tsc --noEmit`
  + the full vitest suite are the verification gates I own).

## The 2 known (pre-existing) failures — fixed as test-maintenance, not a code bug

Exactly as the Coder's `.pipeline/changes.md` predicted: `app/api/webhooks/heygen/route.test.ts`
had 2 failures, both because the `avatar_video.success` fixtures pointed `video_url` at
`https://cdn.heygen.example/...`. `.example` is a reserved, deliberately-fake TLD; once
`app/api/webhooks/heygen/route.ts` started validating the download host against
`ALLOWED_HEYGEN_HOSTS` (`/(^|\.)heygen\.com$/i`, `/(^|\.)amazonaws\.com$/i`, https-only — spec
item 2 / BLOCK-2), that fixture correctly failed the allowlist and the route 400'd instead of
downloading. **This is the SSRF fix working as intended, not a regression** — confirmed by
reading `app/api/webhooks/heygen/route.ts`'s `isAllowedDownloadUrl()` myself before touching
anything. Fixed both fixtures to `https://cdn.heygen.com/...` (an actually-allowlisted host);
both pass again and once more exercise the success path they were written for. I did not touch
any production code to make this pass.

Having fixed the fixture, I judged the allowlist itself — the actual security mechanism —
still had zero test coverage (the two fixed tests only ever incidentally exercised the *allow*
path, never the *reject* path), so I added a dedicated `describe` block for it (see below).

## What I prioritized, and why

Per the coordinator's instructions and `.pipeline/changes.md`'s own closing section
("What the Tester should prioritize"), `worker/**` had **zero** test files before this pass.
Two items were explicitly named as needing new coverage:

### 1. Item 3 / N1 — `worker/reconcile.ts` retry-vs-terminate logic (highest priority)

New file **`worker/reconcile.test.ts`** (7 tests). Exercises `reconcileJob()` and
`runReconcileTick()` end-to-end against `src/testUtils/fakeSupabase.ts` + the REAL
`createJobQueue`/`createCostEngine` (only `adapter.poll()` and the key resolver are stubbed —
the two genuine external-I/O boundaries). Covers:
- **Happy path**: `poll()` still `"pending"` → job untouched, no cost_log row.
- **Happy path**: `poll()` `"succeeded"` → real cost logged under the job's real
  `idempotency_key`, `asset_version` persisted, job completes.
- **The core N1 fix**: a transient `poll()` error with `attempts < max_attempts` re-arms via
  `jobs.retryLater` — status stays `awaiting_provider` (never `'queued'`, which
  `worker/index.ts`'s main claim loop treats as fatal for these job types), `attempts` bumps
  by exactly one, `run_after` moves forward, lock is released, and **no `cost_log` row is
  written** (verified directly against the fake table, not just a mock-call assertion).
- **Edge case named by the spec**: the linear backoff (`30s * (attempts+1)`) is capped at
  `RECONCILE_RETRY_BACKOFF_CAP_MS` (5 min) rather than growing unbounded — tested at
  `attempts=20` where the uncapped value would be 10.5 minutes.
- **Terminal failure**: once `attempts >= max_attempts`, logs `failed_unbilled` under the real
  `idempotency_key` (cost_usd forced to 0) and calls `jobs.fail(..., {retry:false})` — status
  `failed`, not `'queued'`.
- Defensive early-return guard (a crossfade-route `outro_gen` row, which should never actually
  reach `awaiting_provider`, is a no-op rather than throwing).
- `runReconcileTick`'s claim-then-fan-out wiring (2 claimed jobs → 2 `poll()` calls → returns 2).

All 7 passed on the first real run — `worker/reconcile.ts`'s N1 fix is correct.

Also added **`src/lib/jobs/queue.test.ts`** (9 tests, also zero coverage before this pass):
`toPublicJob()` strips `callback_token`/`payload` down to exactly
`{id, status, type, provider_job_id}` (BLOCK-2's actual mechanism); `retryLater()`'s
attempts/run_after/error/lock-release behavior in isolation; `fail()`'s existing
retry-vs-terminal branching for direct contrast (why `reconcile.ts` needed a new primitive
instead of reusing `fail()`).

### 2. Item 9 — HeyGen combined reference-budget validation

Extended **`src/adapters/video_avatar/heygen.test.ts`** (+4 tests, 11→15). The two pre-existing
"combined reference budget" tests only ever exercised the image budget or `avatar_ids` alone —
nothing combined avatar looks with reference videos. Added:
- 2 avatars + 2 reference videos (sum=4 > `max_reference_videos`=3) is now correctly rejected,
  even though each is within its own standalone limit — the exact edge case the spec named.
- 3 avatars + 3 reference videos: confirms only the new combined-budget violation fires (the
  standalone checks individually pass), i.e. the two checks are additive, not duplicative.
- 1 avatar + 2 reference videos (sum=3, exactly at the cap) is allowed — boundary case.
- The pre-existing standalone `avatar_ids` `[1,3]` check still fires independently (4 avatars,
  0 references) — confirms the new check is in addition to, not instead of, the old one.

All 15 passed on the first real run — the combined-budget fix matches the spec exactly.

## What I verified beyond the two priority items

### Session-auth middleware (item 1 / BLOCK-1)

New **`middleware.test.ts`** (10 tests) + a one-line addition to `vitest.config.ts`'s
`include` (middleware.ts lives at the repo root, outside `src/**`/`worker/**`/`app/**`, so
none of the existing globs would discover a test for it). Mocks only `@supabase/ssr`'s
`createServerClient`; the real routing logic runs unmocked. Confirms, calling `middleware()`
directly:
- An unauthenticated `/api/**` request (both a top-level and a nested path) gets a 401 JSON
  `{error: "unauthorized"}` body, no redirect.
- An unauthenticated page load redirects (307) to `/login?next=<original path>`, including
  when the original path carries its own segments.
- `/api/webhooks/**` passes through with no session at all (status 200,
  `x-middleware-next: 1`) — both signed out and signed in.
- `/login` and `/auth/**` pass through while signed out (otherwise no one could ever sign in).
- An authenticated request/page load passes through cleanly (no 401, no redirect, no stray
  `Location` header) for both `/api/**` and a page route.

All 10 passed on the first real run.

### Outro job idempotency key (item 4 / N2)

New **`src/stages/outro/index.test.ts`** (3 tests, `src/stages/outro/index.ts` also had zero
coverage before this pass). Runs `outroStage.process()` and
`createOutroReviewHooks(ctx).redoAsset()` for real against `fakeSupabase` + the real job queue
(adapters faked to force the crossfade route, keeping the test independent of the LLM skill
call that only happens on the model route — N2's fix applies to the enqueue unconditionally).
Confirms the `outro_gen` job's `idempotency_key` is non-null, persisted to the DB row (not just
the in-memory return value), and different across separate reels/calls (never a shared/static
value) — both on the initial `process()` path and the `redoAsset` review-hook path. The
`redoAsset` test also doubles as BLOCK-2 coverage for outro's second `redoAsset` return site:
confirms the returned job is exactly the 4-key `PublicJob` shape with no `callback_token`/
`payload` leak.

### Higgsfield base-URL doubling (item 8 / N7)

New **`src/adapters/config.test.ts`** (3 tests) plus one test added to
**`src/adapters/video_broll/higgsfield.test.ts`** (+1, 4→5). Confirms
`HIGGSFIELD_CONFIG.baseUrl` defaults to `https://api.higgsfield.ai` (no trailing `/v1`) when
`HIGGSFIELD_BASE_URL` is unset, and — more importantly — that `generate()`'s actual `fetch()`
call hits exactly `https://api.higgsfield.ai/v1/generations`, not a doubled
`.../v1/v1/generations`. Each test explicitly stubs/clears the env var via `vi.stubEnv`/
`vi.unstubAllEnvs` rather than relying on ambient state.

**Worth flagging (not a test failure, an operational note):** I checked empirically (a
throwaway diagnostic test, since deleted) that `npx vitest run` does **not** load
`.env`/`.env.local` into `process.env` in this repo — so this was never at risk of masking the
fix under test. However, this machine's actual `.env` and `.env.local` (gitignored, real local
files) both still contain `HIGGSFIELD_BASE_URL=https://api.higgsfield.ai/v1` — the **old,
buggy** value. `.pipeline/changes.md` already correctly scoped touching those files as out of
bounds for this phase ("gitignored, real local values, not requested by spec"), so this isn't
a code defect to send back — but since an env var always overrides the code default, the N7 fix
will not actually take effect in *this* developer's local runtime until `.env`/`.env.local` are
updated by hand. Worth a one-line callout to whoever owns local dev environments.

### SSRF host allowlist (item 2 / BLOCK-2) — the reject path

Added a new `describe` block to `app/api/webhooks/heygen/route.test.ts` (part of the +4 there,
7→11) specifically for the allowlist's *reject* behavior, which the two pre-existing (fixed)
tests never actually exercised:
- A disallowed host (`https://evil-actor.example/...`) is refused before `fetch()` is ever
  called, the job is failed with the spec's exact message pattern, and neither `cost_log` nor
  storage is touched.
- A domain-spoofing attempt (`https://heygen.com.attacker-controlled-cdn.com/...`, which
  contains `"heygen.com"` as a substring but doesn't end with it) is correctly rejected —
  confirms the regex is anchored (`(^|\.)heygen\.com$`), not a naive `.includes()` check.
- A plain-`http://` URL to an otherwise-allowlisted host is rejected (https-only).
- An S3-shaped `amazonaws.com` host (the spec's defensive second allowlist entry) is allowed
  and completes normally, end-to-end.

## A type error I introduced and fixed before this report

My first draft of `src/lib/jobs/queue.test.ts` typed a table-seeding helper's return value as
the full `Job` interface, then pushed it directly into `fakeSupabase`'s `FakeRow[]` table
array — `tsc --noEmit` correctly rejected this (`Job` has no index signature, so it isn't
structurally assignable to `Record<string, unknown>`). Fixed by typing that helper as
`FakeRow` (matching every other test file's `baseJob()` convention in this repo) and casting
only where an actual `Job`-typed value was needed (the `toPublicJob()` unit test). Re-ran
`npx tsc --noEmit`: clean.

## Consciously out of scope for this pass

Per `.pipeline/changes.md`'s own framing, these are real gaps but explicitly lower priority
than items 3/9, and were not named in this pass's instructions:
- **Item 5 (N3)**: `supabase/migrations/0005_fix_claim_lock.sql`'s lock/lease filter is
  reviewed SQL only (no live Supabase project in this environment, consistent with how the V1
  phase treated migrations) — not exercised by any test, same as every other migration in this
  repo. `worker/index.ts`'s `reconcileInFlight` re-entrancy guard is private state inside the
  un-exported `main()` function — not testable without either refactoring production code
  (out of scope for the Tester role) or a heavier end-to-end process harness.
- **Item 6 (N4)**: `src/stages/image/index.ts`'s reuse-branch lineage reconciliation
  (`linkSlotAsset`/`detachStaleSiblingLinks`) is untested. `.pipeline/changes.md` explicitly
  flags this as testable against `fakeSupabase` and worth a look, but lower priority than
  items 3/9 — left for a follow-up pass given the scope of this one.
- **Item 7 (N6)**: the Veo-variant-leakage-into-non-Veo-billing fix in
  `src/stages/clip/index.ts` is a one-line conditional change already covered indirectly by
  `app/api/reels/[reelId]/clip/estimate/route.test.ts`'s existing Veo-vs-Higgsfield estimate
  assertions (from the V1 pass) demonstrating Higgsfield never receives a Veo variant; I did
  not add a dedicated new test for it this round.
- **Item 10**: the rate-card cache TTL (`src/lib/cost/engine.ts`) is a straightforward
  time-based cache expiry; not covered by a dedicated test this round (would need
  `vi.useFakeTimers()` to exercise the 5-minute boundary meaningfully) — flagging as a
  reasonable follow-up, not a blocker.
- `app/login/page.tsx` (client component) is untested — `vitest.config.ts` has no `jsdom`/
  component-testing library installed, consistent with the V1 phase's same limitation for
  `app/components/**`. `app/auth/callback/route.ts` and `app/auth/signout/route.ts` are plain
  Request/Response route handlers and *could* be tested the same way as the webhook route, but
  weren't named in this pass's instructions and were skipped to stay in scope.

## Full suite result

```
Test Files  17 passed (17)
     Tests  169 passed (169)
```

Re-run 3 times consecutively for stability; identical result every time, exit code 0.

Note: on 2 of the 3 runs, vitest printed non-fatal `[vitest-pool]: Failed to terminate forks
worker ... Error: kill EPERM` warnings during teardown, naming a *different* pre-existing test
file each time (once `assembly/plan.test.ts` + `cost/engine.test.ts`, once
`reviewAction.test.ts` + `image/plan.test.ts` — files I never touched). This is a known
Windows-specific quirk in vitest's forked-process pool cleanup, unrelated to test content or
outcome (exit code stayed 0 throughout; the reported pass/fail counts were unaffected). Not
something I attempted to fix — doing so would mean touching `vitest.config.ts`'s pool
configuration, which is beyond a test-maintenance change.

## Files touched this pass

New:
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\worker\reconcile.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\lib\jobs\queue.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\middleware.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\stages\outro\index.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\adapters\config.test.ts`

Modified:
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\app\api\webhooks\heygen\route.test.ts`
  — fixed the 2 stale `.example` fixtures (test-maintenance, not a product fix) and added a
  new `describe` block covering the SSRF allowlist's reject path (+4 tests net, 7→11).
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\adapters\video_avatar\heygen.test.ts`
  — added the combined avatar+reference-video budget coverage (item 9) (+4, 11→15).
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\adapters\video_broll\higgsfield.test.ts`
  — added the base-URL-doubling regression guard (item 8) (+1, 4→5).
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\vitest.config.ts` — added
  `middleware.test.ts` to `test.include` (a root-level file outside every existing glob).

Not modified, ever, by me: no application code under `src/**` (outside `*.test.ts`),
`app/**` (outside `*.test.ts`), `worker/**` (outside `*.test.ts`), or `middleware.ts` itself
was changed — only test files and the two pieces of test infrastructure named above.
