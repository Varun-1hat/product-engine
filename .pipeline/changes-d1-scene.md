# Wave D — Section 3: Scene stage rebuild + reel-setup enhancements

Resumed from a prior attempt that was cut off mid-work by an infra error (not a problem
with the work). Everything below except "3.3 completed this pass" was already correctly in
place from that prior attempt; I verified it, left it untouched, and finished the one
remaining piece.

## 3.1 — Scene page rewrite (already done, verified only)

`app/(app)/reels/[reelId]/scene/page.tsx` — full rewrite already in place from the prior
attempt:
- Local `scenes` state seeded from GET, single source of truth, existing-scene `id`s never
  regenerated/dropped.
- Per-row `type` (only when `avatar_enabled`), `seconds` (number input), `description`
  (Textarea), `transition_to_next` (Select, disabled + forced value for avatar-type/last
  scene rows, matching backend `enforceRules`).
- `broll_provider_override` intentionally left uncontrolled — only one visible b-roll
  provider (Higgsfield hidden), so a single-option dropdown isn't a meaningful UI action.
  This simplification is noted here per spec §3.1 (the prior attempt's version of
  `.pipeline/changes.md` isn't mine to edit in this parallel run, so recording it in this
  file instead).
- Add/Delete/Move-up/Move-down row actions, renumbering `position` after each.
- Save button POSTs `{ scenes }` only (never `regenerate: true`) — this is the actual data-
  loss bug fix.
- "Re-run scene-brain" is a separate, `variant="outline"` button behind an `AlertDialog`
  confirmation; only posts `{ regenerate: true }` on confirm.
- Empty state (zero scenes) renders a single "Generate scenes" primary action instead of the
  table.
- Downgraded-to-hard_cut hint badges render per-row.
- No own header/back-forward links — lives under the §2.6 shared layout.

No edits made to this file this pass; read it in full, confirmed it matches spec §3.1
exactly, ran it through `tsc`/`vitest` alongside everything else.

## 3.2 — Regression test (already done, verified only)

`src/stages/scene/index.test.ts` — already in place from the prior attempt. Two cases per
spec: (1) `regenerate: false` + `scenes` supplied edits in place, `sceneBrain` never called,
edited field reflected in the fake table, existing `id` preserved; (2) `regenerate: true` (no
`scenes`) calls `sceneBrain` exactly once and exercises delete-by-omission (stale scene
removed). Ran standalone (`npx vitest run src/stages/scene/index.test.ts`) — both pass.

## 3.3 — Reel-setup page enhancements (completed this pass)

`app/(app)/clients/[clientId]/reels/new/page.tsx` — the file existed only in its post-§2.5
"file move" state (param source from route params, no Suspense/`useSearchParams` — that part
was already correct); none of the §3.3 UI work had landed yet. Implemented all of it:

- **Seconds slider**: replaced the numeric `total_seconds` input with `Slider`
  (`min={6} max={180} step={1}`, default `30`), live `"{value}s"` text next to it.
- **Avatar picker**: raw checkbox replaced with `Switch`. When on, fetches
  `GET /api/clients/{clientId}` (via `useApiResource`, url gated to `null` when avatar mode
  is off, so no fetch happens until needed) and renders each avatar as a single-select
  preview card (`<img>` when `preview_image_url` is set, placeholder box + name otherwise;
  `ring-2 ring-primary` on the selected card). Zero avatars → inline text + `Link` to
  `routes.clientConfig(clientId)`. Submit button disabled whenever avatar mode is on and no
  avatar is selected (`avatarSelectionMissing`), in addition to `busy`.
- **B-roll provider**: the old `<select>` (which listed Higgsfield) is gone entirely. Avatar
  mode off → always sends `broll_provider: "veo"`, no UI shown. Avatar mode on → a `Switch`
  "Include b-roll scenes (Veo)" defaulting to checked; unchecking it sends
  `broll_provider: undefined` (all-avatar reel).
- **Aspect ratio / resolution**: also converted from raw `<select>` to the shadcn `Select`
  primitive (`ASPECT_RATIOS`/`RESOLUTIONS` from `src/lib/db/enums`) — spec §1.2 explicitly
  names this file as the raw-`<select>` replacement target ("Replaces raw `<select>` elements
  used today in `reels/new/page.tsx`"), and since I was already touching every other control
  on this page it was in scope to finish rather than leave two stray native selects sitting
  next to the new primitives.
- **CapabilityGuard wiring**: no backend changes were needed — `ReelSetupValidationError` in
  `src/stages/reel-setup/index.ts` and the `err instanceof ReelSetupValidationError` branch in
  `app/api/reels/route.ts`'s `POST` catch block were already in place from the prior attempt
  (verified by reading both files fresh; they match spec §3.3 exactly, structured `validation`
  returned on both the success body and the new 400 failure body). Frontend: added
  `validation` state, set from `data.validation` on any response that carries it (success or
  the structured 400), rendered via `<CapabilityGuard validation={validation} />` just above
  the submit button when non-null.
- **Header**: removed the old `<h1>New reel</h1>`; replaced with a non-interactive
  `ProgressSteps` built from the full `STAGE_ORDER` (8 entries, `reel_setup` through
  `assembly`), `currentIndex={0}`, `reachedIndex={0}`, every step's `href: null` (no `reelId`
  exists yet). On successful creation, unchanged: `router.push(routes.reelStage(newReelId,
  "scene"))`.

No changes were needed to `src/stages/reel-setup/index.ts` or `app/api/reels/route.ts` — both
already had the exact §3.3-specified `ReelSetupValidationError` plumbing from the prior
attempt.

## Verification

- `npx tsc --noEmit` — clean, exit 0, whole repo.
- `npx vitest run` — 18 files / 171 tests, all green (including the 2 new scene tests run
  standalone too).
- Did not run `next build` (broken on this machine for an unrelated pre-existing environment
  reason, per instructions).
- Did not run/attempt ESLint directly (no `eslint.config.js` present for a bare `npx eslint`
  invocation in this repo as configured — not part of the standard verification path here);
  matched the existing `<img>` + `eslint-disable-next-line @next/next/no-img-element` comment
  convention already used in `AssetReview.tsx`/`ConfigAvatarsTab.tsx`/`ConfigBrandTab.tsx` for
  the new avatar preview-card `<img>` tags.

## Files touched this pass

- `app/(app)/clients/[clientId]/reels/new/page.tsx` — rewritten (§3.3 additions on top of the
  already-landed §2.5 file-move).

## Files verified as already correct (no edits)

- `app/(app)/reels/[reelId]/scene/page.tsx` (§3.1)
- `src/stages/scene/index.test.ts` (§3.2)
- `src/stages/scene/index.ts` (pre-existing `process()` contract the above two depend on —
  out of my section's edit scope, only read to confirm the test's assumptions hold)
- `src/stages/reel-setup/index.ts` (§3.3 `ReelSetupValidationError`)
- `app/api/reels/route.ts` (§3.3 route-level structured-400 handling)

## Nothing for the Tester to worry about outside this page

Sections 2.6/2.7 (the reel-stage layout + `advance()` wiring that the Scene page now lives
under) were not part of my section and were already in place — read only for context, not
modified.
