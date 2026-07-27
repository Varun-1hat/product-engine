# Test results — Stage 3 (Tester)

Branch `v1`. Read `.pipeline/changes.md` and `.pipeline/spec.md` in full. Added new tests
targeting the gaps the Coder flagged in "What the Tester should focus on" (priority order
1–8) and cross-checked against spec §9's 22 edge cases.

**Status: RESOLVED. Final result: 128/128 passing, 0 regressions.** This pass found one
genuine product bug (Veo cost/estimate rate resolution), stopped and reported it without
fixing it, the Coder fixed it, and I independently re-verified the fix and found — then
fixed — a small gap in my own test's fixture that was masking a clean pass. See "Timeline"
below for the full sequence; the original bug report is preserved further down for the
record.

## Bottom line (current)

- Combined suite: **128/128 passing, 0 failing.**
- `npx tsc --noEmit`: **clean, 0 errors.**
- `npx next build`: **succeeds**, same route list as the Coder's baseline.
- New tests added by me: **40**, across 4 new test files (plus 1 shared test-infra helper).
- No product code (`src/**` outside `*.test.ts`, `app/api/**` route handlers, `worker/**`)
  was ever modified by me — only test files and `vitest.config.ts`'s include glob.

---

## Timeline

1. **First pass**: wrote 40 new tests across 4 files (see "What I added, and why" below).
   Ran the full suite: 127/128 passing. The 1 failure was a real, reproducible product bug —
   Veo's `variant` was never composed with `resolution` anywhere in the runtime path before
   being matched against `rate_card`, so every Veo cost estimate/log call silently came back
   `rate_missing=true`/`cost_usd=NULL` despite a fully seeded rate card. Root-caused with
   exact file/line citations (preserved verbatim below). Per protocol — "if any fail... write
   the failures to `.pipeline/test-results.md` and STOP; do not fix the code yourself" — I
   stopped there without touching `src/adapters/video_broll/veo.ts`,
   `src/stages/clip/index.ts`, `src/stages/outro/index.ts`, `worker/reconcile.ts`, or
   `worker/outro.ts`.
2. **The Coder fixed it**: composed `` `${veo_variant}@${resolution}` `` in
   `src/adapters/video_broll/veo.ts`, `src/stages/clip/index.ts`, and
   `src/stages/outro/index.ts`, plus a related clobbering fix in `worker/outro.ts`.
3. **The coordinator re-ran the suite** and reported 127/128 — but with the failure now on a
   *different* assertion (`body.rate_missing` instead of `brollLine.unit_cost_usd`/
   `cost_usd`), and diagnosed that this remaining failure was a gap in my own test's fixture,
   not a remaining product defect.
4. **I independently verified this before changing anything**: re-read
   `app/api/reels/[reelId]/clip/estimate/route.test.ts` myself and re-ran just that file.
   Confirmed exactly what was reported: `brollLine.unit_cost_usd` (0.12) and
   `brollLine.cost_usd` (≈0.72) now passed — proving the Veo fix works — and the only
   remaining failure was `expect(body.rate_missing).toBe(false)` returning `true`. Traced
   this myself to the shared `seed()` helper in that test file always including two avatar
   (HeyGen) scenes regardless of which `rate_card` rows are passed in, and the specific
   `seed(VEO_RATE_CARD_SEED)` call for that test omitting the `heygen-flat` rate row that
   every sibling test in the same file already includes for exactly this reason — so the two
   HeyGen lines legitimately had no rate in that test's own incomplete fake DB, and the
   aggregate `rate_missing=true` was a correct reflection of that incomplete fixture, not a
   real defect. **I agreed with the diagnosis.**
5. **I fixed my own test's fixture** (not product code): added the same `heygen-flat` rate
   row to that seed call, matching its siblings, and updated the test's now-stale "BUG:"
   framing/comments to reflect that the underlying defect is fixed and this is now a
   regression guard rather than a live bug report. Added one extra assertion
   (`body.total_usd`) for a slightly stronger regression guard.
6. **Re-ran everything**: `npx tsc --noEmit` clean; full suite **128/128 passing** (confirmed
   twice in a row for stability); `npx next build` still succeeds with the same route list.

---

## What I added, and why

Per the Coder's priority list, cross-checked against which spec §9 edge cases already had
dedicated tests (cost double-charge, continuity/hard-cut forcing, shared-frame lineage,
assembly seam-trim — all genuinely well covered already) versus which had none. I did not
duplicate existing coverage in `src/lib/cost/rateCard.test.ts`, `src/lib/routing.test.ts`,
`src/stages/image/plan.test.ts`, or `src/stages/assembly/plan.test.ts` — those are thorough
already (I read them in full before deciding what to add).

### 1. `src/testUtils/fakeSupabase.ts` (new — shared test infrastructure, not a test file)

A minimal in-memory fake of the Supabase JS client's Postgrest/storage/rpc surface
(`.from().select()/.insert()/.update()/.upsert()`, `.eq()`, `.order()`, `.limit()`,
`.single()`, `.maybeSingle()`, a bare-awaited builder, `.storage.from().upload()` etc.),
supporting a registrable partial-unique-constraint check (to mirror
`cost_log`'s real `UNIQUE(reel_id, provider, idempotency_key) WHERE idempotency_key IS NOT
NULL`). This follows the instruction to mock at the `src/lib/supabase/service.ts` module
boundary — the same "mock the SDK boundary, run the real logic" pattern the Coder used for
`@google/genai`/fetch in the adapter tests — rather than mocking each `src/lib/*` helper
individually. Everything downstream of the swapped `createServiceClient()` (job queue, cost
engine, versioning, storage, the real adapter registry, real stage modules) runs
**unmocked**, so these are genuine integration tests of the wiring, not just unit tests of
isolated pieces.

### 2. `src/lib/cost/engine.test.ts` (new — 13 tests) — priority #1

`src/lib/cost/rateCard.test.ts` only tests the pure `resolveRateFromRows` matcher; nothing
exercised `createCostEngine()`'s actual Supabase-touching `log()`/`estimate()`/`spentSoFar()`
code. Added:
- `log()` resolves the matching rate and computes `cost_usd` (Nano Banana, HeyGen).
- **Idempotency double-charge prevention**: calling `log()` twice with the same
  `(reel_id, provider, idempotency_key)` returns the *same* row, not a second insert —
  exercises the actual unique-violation catch-and-refetch path in `engine.ts`, not just the
  pure resolver.
- A different `idempotency_key` on the same reel/provider is *not* deduped (a genuinely
  separate billable call); calls with no `idempotency_key` at all are never deduped either.
- `failed_unbilled` forces `cost_usd=0` even when units/rate are present (edge #13's "a
  known zero, not rate-missing" distinction) vs `rate_missing` forcing `cost_usd=NULL` when
  no rate row matches (Higgsfield, intentionally unseeded per spec §14.4) vs `failed_billed`
  still pricing against the rate card.
- `estimate()`: sums correctly when every rate resolves; resolves the correct Veo
  variant×resolution tier; a single `rate_missing` line correctly suppresses the *aggregate*
  `total_usd` to `null` while still reporting the resolved per-line costs (verifies UI can
  show "$0.039" next to a resolved line and "rate not configured" next to the missing one);
  empty-calls edge case.
- `spentSoFar()` aggregates by stage, treats `cost_usd=NULL` rows as $0 spent-so-far
  (distinct from an error), and doesn't leak another reel's cost_log rows in.

### 3. `src/lib/reviewAction.test.ts` (new — 16 tests) — priority #7

Pure dispatcher tests (no Supabase needed) against a fake `ReviewHooks` spy: all 7 actions
(`redoPrompt`, `editPrompt`, `redoAsset`, `revertPrompt`, `revertAsset`, `download`,
`history`) dispatch to the right hook with the right arguments and response shape; each
action's "required field" guard throws *before* touching hooks when that field is missing;
an explicit empty-string `text` for `editPrompt` is correctly treated as provided (only
`undefined` is rejected); `versionNo: 0` is correctly treated as provided (guards use
`=== undefined`, not truthiness — a real footgun this specifically pins down); zod schema
rejects an unknown action and non-UUID ids.

### 4. `app/api/webhooks/heygen/route.test.ts` (new — 7 tests) — priority #5, explicitly flagged as having ZERO coverage

Mocks only `createServiceClient`; the real `getDefaultAdapterRegistry()` (real HeyGen
adapter, real `parseWebhook()`), real job queue, real cost engine, real versioning helpers
all run for real. Global `fetch` is stubbed only for the video-download step.
- `callback_token` auth: 401 with no token at all; 401 on an unknown/expired token (never
  trusts the payload body alone, per spec §3.1); 500 defensively when a looked-up job has no
  `reel_id`.
- `avatar_video.fail`: logs a `failed_unbilled` cost row (HeyGen's real `parseWebhook`
  reports `billed:false` on failure) and terminally fails the job.
- `avatar_video.success` (the main path): downloads the video, uploads it to the expected
  `buildPollResultPath`, logs the real $7 cost row, and **persists an asset_version whose
  metadata comes from `job.payload` (aspect `"1:1"`, resolution `"720p"`, `duration_s: 11`),
  not from the adapter's hardcoded placeholder (`"9:16"`/`"1080p"`, no duration)** — this was
  chosen deliberately to catch a regression in exactly the "job.payload → cost_log/
  asset_versions.metadata handoff" the Coder flagged as the least spec-literal, highest-risk
  part of the adapter contract. It passed — the handoff is correct.
- A success webhook with no `video_url` 400s and touches neither `cost_log` nor the job row.
- A resent webhook (simulating a provider retry) with the same `idempotency_key` does not
  double-charge `cost_log`, proving the double-charge guard holds at the route/webhook
  layer too, not just inside the cost engine unit tests.

All 7 passed on the first real run — this route's wiring is correct.

### 5. `app/api/reels/[reelId]/clip/estimate/route.test.ts` (new — 4 tests) — priorities #5/#6, and where the real bug was found

Mocks only `createServiceClient`; the real `buildStageContext`, real adapter registry (real
Veo + HeyGen adapters), and real cost engine all run unmocked. Proves:
- **Context threading** (priority #5): `reelId → reel.client_id → ctx.clientId` really does
  reach every `EstimateCall.client_id` through `buildStageContext` — PASSED (this held true
  throughout, in both the first and current versions of the file).
- **HeyGen's flat $7/video, isolated from b-roll billing** (priority #6): a 15s avatar scene
  and a 4s avatar scene cost exactly the same `$7.00` each, end-to-end through the real route
  — PASSED.
- A b-roll scene with no effective model (all-avatar reel, `broll_provider` unset) is skipped
  rather than blocking the whole estimate — PASSED.
- **Veo `variant@resolution` rate resolution** — originally failed (the real bug); now
  **PASSES** after the Coder's fix + my own fixture correction (see "Timeline" above and the
  historical record below).

---

## Historical record: the original bug report (preserved verbatim from the first pass)

This is kept for the audit trail. The underlying product defect it describes **is now
fixed** — see "Timeline" above. Only the "current state" framing at the very end of this
section has been updated; the failure output and root-cause analysis are exactly as
originally reported.

### The failure, as originally observed

```
FAIL  app/api/reels/[reelId]/clip/estimate/route.test.ts > GET /api/reels/[reelId]/clip/estimate — BUG: Veo per-scene estimates never resolve a rate against the seeded rate_card > [documents a real defect, not a test-setup issue — see .pipeline/test-results.md] a Veo b-roll line comes back rate_missing against the EXACT rate_card seed shape from supabase/migrations/0004_seed_rate_card.sql
AssertionError: expected null to be 0.12 // Object.is equality

- Expected:
0.12

+ Received:
null

 ❯ app/api/reels/[reelId]/clip/estimate/route.test.ts:175:37
    173|     // billing... not yet re-verified end-to-end through the route" — …
    174|     // route-level check of the OTHER b-roll biller, Veo, is what surf…
    175|     expect(brollLine.unit_cost_usd).toBe(0.12); // EXPECTED (spec §14.…
       |                                     ^
    176|     expect(brollLine.cost_usd).toBeCloseTo(0.72, 6); // 6s billed * $0…
    177|     expect(body.rate_missing).toBe(false);

Test Files  1 failed | 11 passed (12)
     Tests  1 failed | 127 passed (128)
```

### Root cause (confirmed by reading source, independent of the test)

**Every Veo cost call — both `estimate()` and the real `costEngine.log()` call once a Veo
clip actually finishes generating — silently resolved `rate_missing=true`/`cost_usd=NULL` in
production, for both Stage 5 (clip) and Stage 7 (outro-via-Veo), even though `rate_card` was
fully seeded for Veo.** This was a cost-engine rate-resolution defect (the exact area named
priority #1), and it meant the "Veo standard-vs-fast cost warning" the Coder's
`CostEstimateBar` is supposed to surface (per `changes.md` line 136) could never actually
render a dollar figure for Veo — every Veo line would show "rate not configured" instead.

The chain, with exact citations (as they stood before the Coder's fix):

1. **`supabase/migrations/0004_seed_rate_card.sql`** (lines 21–32) seeds Veo `rate_card` rows
   with `variant` values `"standard@720p"`, `"standard@1080p"`, `"fast@720p"`,
   `"fast@1080p"` — and says so explicitly in its own comment: *"the adapter emits
   variant = '\<veo_variant\>@\<reel resolution\>'; resolveRate matches it."*
2. **`src/adapters/video_broll/veo.ts`**: `estimate()` and `generate()` both emitted the
   **bare** `veo_variant` (`"standard"` or `"fast"`) — never a resolution-qualified string.
3. **`src/stages/clip/index.ts`** passed `variant: reelConfig.veo_variant` straight through
   in both the generate path and the `estimate()` path — bare, no composition.
   **`src/stages/outro/index.ts`** did the same.
4. **`worker/reconcile.ts`** and **`worker/outro.ts`** just forwarded whatever was stored in
   `job.payload.variant` — which was already bare, from step 3 — into the real
   `costEngine.log()` call once the clip actually finished.
5. **`src/lib/cost/rateCard.ts`**'s `resolveRateFromRows()` requires an **exact string match**
   on `variant` (`if (row.variant !== variant) return false;`), so `"fast"` never matched
   `"fast@1080p"`.

Nothing in the runtime path performed the `"<veo_variant>@<resolution>"` composition the
migration's own comment promised. `src/lib/cost/rateCard.test.ts` and my own
`engine.test.ts` both passed at the time only because they hand-feed an already-composed
`"fast@1080p"` string directly into `resolveRateFromRows`/`costEngine.estimate()` — bypassing
the actual stage/adapter code that would have produced the (uncomposed) real value. That's
exactly the kind of seam a pure unit test can't catch on its own; it took a route-level test
using a rate_card seed that mirrors the real migration to surface it.

**Impact (before the fix):** every reel using Veo (the primary wave-1 b-roll provider, and
the reel default per `reel_config.broll_provider`) would show "rate not configured" for
every b-roll estimate and would log `rate_missing=true`/`cost_usd=NULL` for every real Veo
generation, in both Stage 5 and Stage 7. HeyGen was unaffected (its rate_card row has
`variant=NULL`, matching HeyGen's own `variant` being unset). Nano Banana was unaffected
(also `variant=NULL`). This was not listed in `changes.md`'s "Known gaps" — it appeared to
be a genuinely new discovery, not a previously-scoped cut.

### Current state — CONFIRMED FIXED

The Coder composed `` `${veo_variant}@${resolution}` `` in `src/adapters/video_broll/veo.ts`,
`src/stages/clip/index.ts`, and `src/stages/outro/index.ts`, plus a related fix in
`worker/outro.ts`. I independently re-ran `app/api/reels/[reelId]/clip/estimate/route.test.ts`
myself (not just trusting the coordinator's report) and confirmed: `brollLine.unit_cost_usd`
now resolves to `0.12` (the `fast@1080p` tier) and `brollLine.cost_usd` to `≈0.72` (6 billed
seconds × $0.12) — exactly the values the original failing assertions expected. The one
remaining failure at that point (`body.rate_missing`) was, on inspection, a gap in my own
test's fixture (see "Timeline" step 4/5 above), not a further product defect. After fixing
that fixture gap, the full suite is **128/128 passing**.

---

## Failure-case coverage note (so this isn't confused with the bug above)

Per my instructions to cover "at least one failure case" — that requirement is satisfied
many times over by tests that are **supposed to fail gracefully and do**: the webhook's
401s/500/400 paths, `reviewAction`'s required-field guards throwing before touching hooks,
`buildAssemblyPlan`'s thrown error on a missing clip (pre-existing test), etc. All of those
passed from the start (correct error handling verified). The Veo rate-resolution issue was
the only case where a test failed because the *code*, not the test, was wrong — and that is
now fixed and independently re-verified.

## Spec §9 edge-case cross-check (22 total)

Edge cases already covered by dedicated existing tests (verified by reading them, not
re-tested here to avoid duplication): #1 (all-avatar no-op), #3 (mixed routing), #6/#7
(continuity/hard-cut forcing incl. per-scene override and avatar boundaries), #8/#22 (Veo
generates-8s-bills-generated-duration), #10/#11 (fps normalize + 1-frame seam trim), #12/#13
(redo cost, failed_billed/unbilled — now also covered at the engine-integration level by my
new tests), #14 (model swap style-risk, no block), #19 (async job states), #20 (music
loop/fade).

Edge cases with **no dedicated test found, old or new** (flagged for a future pass): #5
(avatar+product → HeyGen references, no Nano Banana composite —
`src/stages/clip/index.ts`'s `product_in_scene` branch), #9 (aspect/res-per-reel validation
blocking), #15 (reel resumability / `load()` rehydration for any stage), #16 (client cloning
excludes provider keys — `src/stages/config`'s clone path), #17 (multiple avatars per
client, beyond `pullAvatarLooks`'s parsing, which *is* tested), #18 (the
Google-key-covers-nano_banana+veo fallback in `src/lib/crypto/vault.ts`'s `KeyResolver` —
this file has **zero** test coverage today), #21 (total-seconds drift, informational only,
low risk). None of these are known to be broken — they are simply untested, and out of scope
for this pass now that it has reached a clean, verified state.

## Known limitations of this pass

- Genuine end-to-end integration testing against a **live** Supabase project remains
  impossible in this environment (none is provisioned, by design — migrations were never
  applied). Everything above is verified by mocking `src/lib/supabase/service.ts`'s
  `createServiceClient()` at the module boundary with an in-memory fake
  (`src/testUtils/fakeSupabase.ts`) and running the real production code against it — this
  is the most realistic testing achievable without a live backend, but it is not a substitute
  for a real `supabase db reset` + integration run against actual Postgres/RLS/Storage.
- React components under `app/components/**` (the 7 named review components) are still
  untested — they'd need `jsdom` + a component-testing library, neither of which is
  installed.
- I did not chase every edge case in the "no dedicated test" list above — per my
  instructions, once a failing test is found and resolved, further scope expansion is a
  judgment call for a later pass, not something to chase indefinitely in this one.

## Files touched this pass

New:
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\testUtils\fakeSupabase.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\lib\cost\engine.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\src\lib\reviewAction.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\app\api\webhooks\heygen\route.test.ts`
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\app\api\reels\[reelId]\clip\estimate\route.test.ts`
  (revised a second time after the Coder's fix — see "Timeline" step 5: added the
  `heygen-flat` rate row to the previously-"BUG"-labeled test's fixture and relabeled it as a
  regression guard, since the underlying product bug it targeted is now fixed)

Modified:
- `C:\Users\vvaru\OneDrive\Desktop\1hat\product-engine\vitest.config.ts` — broadened
  `test.include` to add `app/**/*.test.ts` (previously only `src/**` and `worker/**` were
  discovered; route handlers are plain Node Request/Response code so the existing `node`
  environment covers them with no other config changes).

Not modified, ever, by me: no product/source code under `src/**` (outside `*.test.ts`),
`app/api/**` route handlers, or `worker/**` was changed — only test files and the vitest
include glob, per my role. The Veo variant-composition fix in `src/adapters/video_broll/veo.ts`,
`src/stages/clip/index.ts`, `src/stages/outro/index.ts`, and `worker/outro.ts` was made by
the Coder, not by me.
