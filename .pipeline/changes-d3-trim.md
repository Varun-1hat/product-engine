# Wave D3 — Section 6 ("Trim stage — new page + new route")

Scope: only spec section 6 (6.1 new review route + 6.2 new page). No other section implemented.

## Files changed

### `app/api/reels/[reelId]/trim/review/route.ts` (new)

Mirrors `app/api/reels/[reelId]/clip/review/route.ts` exactly: parse `reviewActionSchema`, build
a `StageContext` via `buildStageContext`, build hooks via `createTrimReviewHooks(ctx)` (already
implemented in `src/stages/trim/index.ts`, just previously unreachable — no route pointed at
it), dispatch via `src/lib/reviewAction.ts`'s `dispatchReviewAction`. No prompt-specific
handling added — trim's hooks already throw on `redoPrompt`/`editPrompt`/`revertPrompt` ("trim
has no prompts"), and `dispatchReviewAction` doesn't need per-route changes to accommodate that.

### `app/api/reels/[reelId]/trim/route.ts` (modified — GET only, POST untouched)

Not explicitly called for by section 6.1/6.2, but necessary plumbing — see judgment call #1
below. Enriched `GET` beyond the bare `trimStage.load(ctx)` snapshot (`{ stage, data: { scenes
}, hints }`) with a new `slots` field, following the same `buildSlotDetail`-style pattern
`app/api/reels/[reelId]/image/route.ts` established and `app/api/reels/[reelId]/clip/route.ts`
(Wave D2) also just used:

- New `buildTrimSlotDetail(ctx, assetId)` helper: resolves the asset's current version, a
  signed preview URL (`ctx.storage.signedUrl("assets", ...)`), and full version history, via
  `src/lib/versioning.ts`'s `getAsset`/`assetHistory` — same helpers image/clip's routes use.
  No `prompt` field (trim has none). Unlike image/clip, also returns `duration_s` — read off
  the current version's `metadata.duration_s` — since the page needs it and nothing else
  exposes it (see judgment call #1).
- Trim has no asset kind of its own: it appends `derived` versions to the same clip asset Stage
  5 (Clip) already created, so slots are keyed off `scenes.clip_asset_id` (not a trim-specific
  column) — scenes without a materialized clip are simply absent from `slots`.
- Response shape is now `{ stage: "trim", data: { scenes }, hints, slots }` — purely additive,
  the pre-existing `stage`/`data`/`hints` fields are untouched.

### `app/(app)/reels/[reelId]/trim/page.tsx` (new)

One `Card` per scene, in `position` order:

- **Header**: scene number + description; any `hints` for that scene (from the GET response,
  computed by `computeTrimHints` — shared-boundary warnings) rendered as `Badge
  variant="warning"`, the same visual pattern Scene's downgraded-to-hard-cut badge uses; up/down
  move buttons that swap the scene with its neighbor and immediately POST the full reordered
  `scene_ids` array to `/api/reels/{reelId}/trim/reorder` (see judgment call #4).
- **Body**: if the scene has a clip (`slots[scene.id]` present), an `AssetReview` bound to
  `/api/reels/{reelId}/trim/review` (so Download/History/Revert all work against the clip's
  version history; Redo calls `trimStage`'s `redoAsset` — see judgment call #2 for why it's
  wired with no cost/confirmation), passed the reel's `aspectRatio` (fetched the same secondary
  `useApiResource` way `image/page.tsx` does). Below it, if `duration_s` is known, a single
  dual-handle range `Slider` (one `Slider`, two thumbs via its `value` array) for
  `start_s`/`end_s` bounded `[0, duration_s]` with a live text readout, and a "Trim" button that
  POSTs `{ asset_id, start_s, end_s }` to `/api/reels/{reelId}/trim`. If the scene has no clip
  yet, or the clip has no known duration, an explanatory inline message instead (mirrors
  image/page.tsx's "start image not generated yet" style placeholders).
- No `CostEstimateBar` anywhere on this page — trim has no `estimate()` (module header comment:
  "Cost: none"), so there's nothing to estimate.

## Judgment calls / things flagged for Reviewer + Tester

1. **Enriched the existing `trim/route.ts` GET, even though it isn't in my stated
   exclusive-ownership list and section 6.1/6.2's text never says "enrich the GET" the way
   section 5.1 explicitly does for Clip.** The page (6.2) requires, per scene, the current
   clip's preview/version/history (for `AssetReview`) and the current version's persisted
   `metadata.duration_s` (to bound the sliders — spec's own words: "duration_s comes from the
   current version's metadata.duration_s"). Neither existed anywhere: `trimStage.load()` only
   ever returned bare `scenes`, and trim has no asset kind of its own to enrich a slot from
   other than `scenes.clip_asset_id`. I confirmed Clip's GET enrichment (section 5.1, Wave D2)
   *deliberately excludes* `duration_s` from its documented `SlotDetail` shape, and I verified
   against Wave D2's actual delivered `.pipeline/changes-d2-clip.md` that this is exactly what
   they built — so even a finished Clip page wouldn't have solved this, and depending on
   another wave's route for core Trim functionality (across a parallel run where waves don't
   see each other's work-in-progress) seemed fragile regardless. `trim/route.ts` is
   trim-domain-exclusive (no other wave section touches Trim), the change is purely additive,
   and nothing else in the repo reads this route today, so there's no collision risk — but
   flagging clearly since the file wasn't in my stated file list. Notably, Wave D2 made the
   same call for Clip's own GET route (also "existing", also not literally "new"), which
   reinforces this was the intended shape of the work even though section 6 doesn't spell it
   out as its own numbered subsection the way section 5 does.

2. **Redo cost: left as free** — no `costUsd` passed to `AssetReview`, so its "Redo" button
   stays a plain, immediate, undialoged action (consistent with `AssetReview`'s existing
   "0/undefined = no added friction" behavior from spec §4). Read `src/stages/trim/index.ts`'s
   `redoAsset` per the task's explicit instruction to verify rather than assume: it re-enqueues
   a `trim` worker job using the *same* `start_s`/`end_s` already recorded in the current
   version's `metadata.trim` (throwing `"...has no prior trim to redo..."` if the clip has never
   been trimmed yet) — no adapter/provider call, just a local ffmpeg re-encode
   (`worker/trim.ts`). The module's own header comment states "Cost: none," confirming $0 is
   correct, not just an assumption. One accepted rough edge: clicking "Redo" before ever
   trimming a clip will surface that "no prior trim" error inline via `AssetReview`'s own
   built-in error `<span>` — not a crash, just a slightly unpolished first-touch message. Per
   the task's framing ("accept that its Redo button... calls trim's redoAsset"), I did not build
   a workaround (e.g. hiding Redo pre-trim), since `AssetReview.tsx` isn't mine to modify and
   already degrades gracefully.

3. **Slider shape: one dual-handle range `Slider`, not two independent single-value sliders.**
   Spec allows either. `app/components/ui/slider.tsx` already renders one `Thumb` per entry in
   its `value` array, so `value={[start_s, end_s]}` gives a single connected range control where
   Radix keeps the two thumbs from crossing (so `start_s <= end_s` holds structurally, not just
   by convention). Added a defensive "End must be after start" guard disabling the Trim button
   regardless, as a backstop.

4. **Reorder: POST on each move, not batched behind a "Save order" button.** Spec explicitly
   allows either. Picked immediate-POST because `hints` (shared-boundary warnings) depend on
   scene adjacency and must be recomputed after any reorder — firing the existing
   `/trim/reorder` endpoint immediately and then reloading keeps the hint badges accurate
   without extra "has the order changed since last save" bookkeeping.

5. **Slider default resets to the full `[0, duration_s]` range after every successful trim**,
   rather than pre-populating from the just-applied `metadata.trim` bounds. A version's
   `metadata.trim.start_s/end_s` describes the cut applied *to produce* that version (relative
   to the previous/base version's timeline) — it is not a valid window within the new, now
   shorter, current version's own `[0, duration_s]` range, so reusing those numbers verbatim as
   the next slider's starting position would often be out of bounds. Full range is the only
   value that's always valid, so each new trim starts from "no cut yet" on the current clip.

6. **Slider `step={0.1}`** (100ms) — spec doesn't specify one for Trim's sliders (unlike the
   `total_seconds` slider in §3.3, which is `step={1}`); whole-second steps are too coarse for
   trimming a ~4-8s clip.

## Not changed

- `src/stages/trim/index.ts`, `worker/trim.ts`, `app/api/reels/[reelId]/trim/reorder/route.ts`
  — read only, used exactly as they already behave.
- `app/components/AssetReview.tsx` — read only (Wave C's `aspectRatio`/`costUsd` props consumed
  as documented, `costUsd` deliberately left unset per judgment call #2).

## Verification

- `npx tsc --noEmit` — clean, exit code 0, repo-wide (includes the other four in-flight
  parallel waves' files as of this run; no errors anywhere, including outside my two owned
  files).
- `npx vitest run` — 171/171 tests passing across 18 files. (A Windows-only `EPERM`/timeout
  message from vitest's fork-pool trying to tear down `worker/reconcile.test.ts`'s worker
  process appears after the summary — that's a pre-existing environment quirk unrelated to any
  change here, not a test failure; the summary line above it already reports full green.)
- `next build` intentionally not attempted per instructions (broken on this machine for an
  unrelated pre-existing environment reason).

## Tester focus

- `GET /api/reels/{reelId}/trim` now returns `{ stage, data: { scenes }, hints, slots }`;
  `slots` has an entry only for scenes with a materialized `clip_asset_id`, each with a working
  signed `preview_url`, correct `current_version_id`/`current_version_no`/`history`, and
  `duration_s` matching the current version's `metadata.duration_s`.
  - Please double check `duration_s` in particular against a real trimmed clip: after one trim,
    the *new* current version's `duration_s` should equal `end_s - start_s` from that trim (per
    `worker/trim.ts`), and the page's slider max should shrink to match on next load.
  - `slots[scene.id]` is `undefined` for scenes before Clip has generated anything for them —
    page shows "clip not generated yet — visit the Clip stage first" for those.
- Trim page: dual-handle slider drag behavior (thumbs shouldn't be able to cross), "Trim" POSTs
  the exact `{asset_id, start_s, end_s}` shown in the live readout, and the range resets to full
  width against the new (shorter) duration after a successful trim.
- Move up/down: disabled at the top/bottom of the list; POSTs the full reordered `scene_ids`
  array; hint badges should update after a reorder if it changes which scenes are adjacent.
- Redo (via `AssetReview`, no confirmation dialog): on a clip that's never been trimmed, expect
  an inline error ("...has no prior trim to redo...") rather than a crash — this is
  `trimStage.redoAsset`'s existing behavior, not a bug introduced here. On an already-trimmed
  clip, Redo should re-run the same trim and succeed.
- Download/History/Revert on the `AssetReview` all hit `/trim/review`'s `download`/`history`/
  `revertAsset` actions — should work identically to Clip/Image's equivalents.
