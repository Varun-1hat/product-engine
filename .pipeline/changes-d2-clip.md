# Wave D2 — Section 5 ("Clip stage — new page")

Scope: only spec section 5 (5.1 GET enrichment + 5.2 new page). Both files listed below are
exclusively owned by this wave — nothing else was touched.

## Files changed

### `app/api/reels/[reelId]/clip/route.ts` (modified — GET only, POST untouched)

Enriched `GET` beyond the bare `clipStage.load(ctx)` snapshot, following the same pattern as
`app/api/reels/[reelId]/image/route.ts`'s `buildSlotDetail` helper:

- Added a `buildSlotDetail(ctx, assetId)` helper that resolves the asset's current version,
  a signed preview URL (`ctx.storage.signedUrl("assets", ...)`), full version history, and the
  associated prompt (with its own version + history) — reusing `src/lib/versioning.ts`'s
  `getAsset`/`assetHistory`/`getCurrentPromptVersion`/`promptHistory` exactly as image/route.ts
  does. No `shared` field (clip assets are never shared between scenes, unlike Image's boundary
  frame), and `media_type` is hardcoded to the literal `"video"` since every clip asset is one.
- For every scene with a `clip_asset_id`, populates `slots[scene.id]` via that helper (scenes
  without a materialized clip are simply absent from `slots`).
- `estimate` is computed by calling `clipStage.estimate!({}, ctx)` directly — the exact same
  function `clip/estimate/route.ts` already exposes as its own endpoint — so no pricing logic
  is duplicated.
- Response shape is now `{ stage: "clip", data: { scenes }, slots, estimate }`, matching spec
  §5.1's literal TypeScript block verbatim.

### `app/(app)/reels/[reelId]/clip/page.tsx` (new)

Mirrors `image/page.tsx`'s structure: `CostEstimateBar`, an `AlertDialog`-wrapped "Generate
missing clips" button (POSTs `{}` to `/api/reels/{reelId}/clip`, following the existing route's
`{ scene_ids?: uuid[] }` contract — omitted means "all") when the total is a positive number,
plain immediate button otherwise. Then one `Card` per scene (position order): scene number +
description in the header; for `avatar`-type scenes, a read-only "Avatar look: {name}" line
(resolved by cross-referencing `reel_config.avatar_look_id` against `GET
/api/clients/{clientId}`'s `avatars` list) plus a "uses product photos as reference" badge when
`product_in_scene` is true; then a single `AssetReview` + `PromptReview` pair (not a start/end
pair — Clip has one slot per scene) bound to `/api/reels/{reelId}/clip/review`, fed from
`slots[scene.id]`. `aspectRatio` is fetched via a second `useApiResource("/api/reels/{reelId}")`
call and passed to every `AssetReview`, same as `image/page.tsx`. `costUsd` is `7` flat
(`AVATAR_CLIP_COST_USD`) for every avatar scene, and for b-roll scenes is the real per-scene
value read off the estimate response (see `brollCostUsdByScene` below).

## Judgment calls / things flagged for Reviewer + Tester

1. **GET response shape deliberately differs from `image/route.ts`'s own convention.** Image's
   GET flattens its response to `{ scenes, slots, estimate }` (no `stage`/`data` wrapper), but
   spec §5.1 spells out Clip's target shape explicitly as `{ stage: "clip", data: { scenes },
   slots, estimate }` — I followed that literal block rather than copying Image's flattened
   shape, since §5.1's intro text ("replicate the same enrichment... except simpler") is about
   the *method* (the buildSlotDetail-style helper), and the code block immediately after is an
   explicit contract for the resulting JSON. Flagging so nobody "fixes" this into matching
   Image's flat shape thinking it's an inconsistency — it's intentional, spec'd that way.

2. **Per-scene b-roll cost has no direct scene-id key from the API.** `EstimateLine` (in
   `src/lib/cost/engine.ts`, re-exported via `app/components/CostEstimateBar.tsx`) carries no
   `scene_id` — it's a flat list of `{ provider, category, unit_type, variant, units,
   unit_cost_usd, cost_usd }`. Spec §5.2 requires the *real* per-scene value for b-roll (unlike
   Image, where every line is economically identical and any line will do), so I paired b-roll
   scenes (already in position order) with `estimate.lines` filtered to `category ===
   "video_broll"`, index-for-index — correct as long as `clipStage.estimate()` (in
   `src/stages/clip/index.ts`, untouched by this wave) never skips a b-roll scene via its
   `continue` branches (only happens when no b-roll model/adapter resolves for that scene — the
   same condition that blocks generation for it anyway). If that mismatch ever occurs in
   practice, the trailing scene(s) past it simply get `costUsd={undefined}` (AssetReview's
   already-established "free action, no confirmation" fallback) rather than a wrong number.
   Documented in the `brollCostUsdByScene` doc comment in the page file. Worth a second look if
   real b-roll pricing ever looks off for a reel with a mix of blocked/unblocked b-roll scenes.

3. **Added a small "No scenes configured yet." empty state** (`scenes.length === 0`) — not
   explicitly requested by §5.2, but mirrors `image/page.tsx`'s analogous "No b-roll scenes —
   Stage 4 is a no-op for this reel." message (the file I was told to mirror closely), and
   avoids rendering a blank page for an edge case that shouldn't normally occur post-Scene-stage.

4. **Did not touch `src/stages/clip/index.ts`** (or any other stage/adapter file) — the GET
   enrichment only calls already-exported functions (`clipStage.load`, `clipStage.estimate`,
   `src/lib/versioning.ts` helpers). Consistent with the spec's "do not duplicate the pricing
   logic" instruction and the top-level "Do not touch `src/adapters/**`, `src/skills/**`..."
   guardrail.

## Verification

- `npx tsc --noEmit` — clean, exit code 0, repo-wide (includes the other in-flight parallel
  waves' files as of this run; no errors anywhere).
- `next build` not attempted per instructions (broken on this machine for an unrelated
  pre-existing environment reason).
- No test file exercises `app/api/reels/[reelId]/clip/route.ts` today, and this wave wasn't
  asked to add one (the one new-test requirement in the spec is §3.2, owned by Wave D1/Scene) —
  `npx vitest run` was not run for this wave since it wasn't part of the delegated checklist and
  the repo has four other agents mid-edit right now (would likely surface unrelated,
  transient failures from concurrently-edited files rather than anything from these two files).

## Tester focus

- `GET /api/reels/{reelId}/clip` returns `{ stage, data: { scenes }, slots, estimate }`; `slots`
  has an entry only for scenes with a materialized `clip_asset_id`, each with a working signed
  `preview_url`, correct `history`, and (when a motion/shot prompt exists) a populated `prompt`.
- Clip page: "Generate missing clips" AlertDialog only appears when `estimate.total_usd > 0`;
  falls back to an immediate (non-dialog) button when `0`/`null`/`rate_missing`.
- Avatar-type scene Cards show the correct avatar look name (or "none selected" when
  `avatar_look_id` is null) and the product-photos badge only when `product_in_scene` is true.
- Redo cost: avatar scenes always show `Redo · $7.00`; b-roll scenes show the real per-scene Veo
  estimate (varies with `seconds`/`veo_variant`), confirmed via an `AlertDialog` before redoing.
- Single `AssetReview` + `PromptReview` pair per scene (never two, unlike Image's start/end).
