# Implementation changes — V2 Wave C: Image stage polish (spec §4)

Branch `v1`. Implements only `.pipeline/spec.md`'s section 4 ("Image stage polish") — this is
**Wave C** per the spec's own "Execution waves" note. Wave A (§0-1, design foundation) and
Wave B (§2, navigation/IA restructure) already landed and are verified clean (their
changes.md files are archived at `.pipeline/waveA-changes.md` and `.pipeline/waveB-changes.md`
by the orchestrating session); this file supersedes Wave B's per standing instructions.
Sections 1, 2, 3, 5, 6, 7, 8 are separate waves and were **not** touched.

Wave B left `app/(app)/reels/[reelId]/layout.tsx` in place (the shared stepper/Previous/Next
shell) and explicitly left `image/page.tsx` untouched, so before this wave the page rendered
the new shared layout chrome stacked directly above its own old inline `<h1>` + "← Scene" /
"Clip →" text links — Wave B's changes.md flagged this exact duplication as "expected and
temporary." This wave removes that duplication as part of its own explicit task.

## Verification performed

- `npx tsc --noEmit`: **clean, 0 errors** (baseline before starting was also 0 errors).
- `npx vitest run`: **169/169 passing across 17 files**, identical to baseline — this wave adds
  no new test files (spec §4 has no test-writing task; the codebase's only new-test task is
  §3.2, a different wave, out of scope here). Same Windows-only
  `[vitest-pool]: Timeout terminating forks worker` post-summary noise Wave A/B already
  documented — appears after the passing summary, doesn't change the 169/169 pass count, not a
  regression.
- `npx next build`: not attempted — per my task instructions this is a known, pre-existing,
  unrelated environment issue on this machine (bad native `@next/swc-win32-x64-msvc` binary +
  a OneDrive-locked `.next/trace` write), already documented by Wave B's changes.md, explicitly
  called out as out of scope for this wave too. `tsc --noEmit` + `vitest run` are the checks
  that matter here and both are clean.

## Files changed

### `app/components/AssetReview.tsx`

- **Aspect-ratio-aware preview.** Added `aspectRatio?: "9:16" | "1:1" | "16:9"` to
  `AssetReviewProps`, defaulting to `"16:9"` via a destructured default parameter (preserves
  today's behavior for any caller that omits it). A new `ASPECT_RATIO_CLASS` lookup maps it to
  `aspect-[9/16]` / `aspect-square` / `aspect-video`; the preview container's previously
  hardcoded `aspect-video` class is now `cn(..., ASPECT_RATIO_CLASS[aspectRatio])` (added the
  `cn` import from `@/src/lib/cn`, matching every other class-merging call site in
  `app/components/ui/**`).
- **Cost-confirmation on Redo.** Added `costUsd?: number`. When `costUsd > 0`, the "Redo"
  button becomes an `AlertDialogTrigger` (`asChild`, wrapping the same styled `Button`) instead
  of firing `handleRedo` directly; confirming inside the dialog (`AlertDialogAction
  onClick={handleRedo}`) is what actually calls it. When `costUsd` is `0`/`undefined`, the
  original single-click `<Button onClick={handleRedo}>` path is unchanged. The button label is
  `` `Redo · $${costUsd.toFixed(2)}` `` when nonzero, plain `"Redo"` otherwise (both still show
  `"Redoing…"` while `busy`, unchanged). See deviation 1 below on the dialog copy.

### `app/(app)/reels/[reelId]/image/page.tsx`

- **Removed the redundant header/nav.** Deleted the page's own `<h1>Stage 4 — Images</h1>` and
  its "← Scene" / "Clip →" text `Link`s (one of which — "Clip →" — pointed at a stage page that
  doesn't exist yet in this branch, i.e. the "dead" link the spec calls out) — the shared
  `app/(app)/reels/[reelId]/layout.tsx` stepper + Previous/Next (Wave B) fully replace them. The
  now-unused `next/link` import was removed with it.
- **Aspect ratio plumbing.** Added a second, independent `useApiResource<ReelDetailResponse>("/api/reels/{reelId}")`
  call (confirmed first that Wave B's layout exposes no React context — it's a plain
  fetch-and-render component — so per the spec's own fallback instruction, an extra fetch here
  is correct). `ReelDetailResponse` is a minimal projection (`{ reel_config: ReelConfigRow }`)
  of that endpoint's actual `{ reel, reel_config }` response, matching the same
  minimal-projection convention `layout.tsx` itself already uses for its own second
  (client-detail) fetch. `reel_config.aspect_ratio` (typed `string` at the `ReelConfigRow`
  level, always one of the three literal values at runtime per `reel-setup`'s
  `z.enum(ASPECT_RATIOS)` validation on write) is cast to `AssetReviewProps["aspectRatio"]` and
  passed to every `AssetReview` instance (both `start` and `end` slots).
- **Per-slot redo cost.** Added `perImageCostUsd()`, which reads `state.estimate.lines[0]?.cost_usd`
  with a `$0.039` (`FALLBACK_IMAGE_COST_USD`) fallback, and passes the result as `costUsd` to
  every `AssetReview` instance (both slots) uniformly. See deviation 2 below for why every slot
  gets the same value and why that's correct, not a shortcut.
- **Cost-confirmation on "Generate missing images."** The button is now conditionally wrapped
  in an `AlertDialog` (`AlertDialogTrigger asChild` around the same `Button`) showing
  `state.estimate.total_usd` when it's a positive number; confirming calls the existing
  `handleGenerate`. When `total_usd` is `null` (rate not configured) or `0`, the button stays a
  plain immediate click, matching the same "no friction when there's no known cost" rule the
  spec states for the per-asset Redo case.
- Updated the local `ImageStateResponse.estimate.lines` type from a placeholder `never[]` (this
  field was never read before) to the real `EstimateLine[]` (imported from
  `CostEstimateBar.tsx`, which already exported it) so `perImageCostUsd` type-checks against the
  actual shape.

## Deviations / judgment calls

1. **Redo confirmation copy is `mediaType`-driven, not the literal hardcoded word "image."**
   Spec §4 gives the dialog text as `"Regenerate this image for ${costUsd.toFixed(2)}?"`
   verbatim. `AssetReview.tsx` is a shared, generic component (`mediaType: "image" | "video" |
   "audio"` was already a prop before this wave) that spec §5.2 and §7.3 both say later waves
   (Clip, Outro) will reuse **as-is**, including passing non-image `costUsd` values (e.g. a $7
   flat HeyGen video redo) through this exact same cost-confirmation feature I'm building now.
   Hardcoding the word "image" into a component two other stages' video assets will flow
   through would produce a wrong, confusing dialog ("Regenerate this image…" for a video clip)
   that neither §5 nor §7's text gives me any reason to think is intentional — they only say
   "wrap the same cost-confirmation pattern from section 4," not "and also fix the copy." I
   used `` `Regenerate this ${mediaType} for $${costUsd.toFixed(2)}?` `` instead. This is a
   **zero-behavior-change** substitution for everything this wave actually touches: every
   `AssetReview` instance rendered by `image/page.tsx` is passed `mediaType={slot.*.media_type}`,
   which is always `"image"` for Image-stage assets (`src/stages/image/index.ts` hardcodes
   `media_type: "image"` on every asset it creates) — so the rendered text is byte-identical to
   the spec's literal quote today. The only effect is forward-compatibility for the two waves
   that inherit this file verbatim. Flagging prominently since it's a deliberate rewording of
   spec-quoted copy, not a "matched reality" cleanup — worth the Reviewer confirming this
   reasoning holds once Clip/Outro actually land.
2. **`estimate.lines` has per-line `cost_usd` detail but no per-slot identity — resolved by
   using line 0's live cost with the spec's own constant as fallback, not by positionally
   matching lines to slots.** I read `src/stages/image/index.ts`'s `estimate()`: it builds one
   `EstimateCall` per planned slot via `plan.map(() => ({ provider: reelConfig.image_provider,
   category: "image", unit_type: "image", units: 1, client_id }))` — no `variant`, no
   scene/asset id anywhere in the call or in `EstimateLine`'s shape (`CostEstimateBar.tsx`:
   `{ provider, category, unit_type, variant?, units, unit_cost_usd, cost_usd }`). Since every
   call in that array is structurally identical, `resolveRateFromRows` (keyed on
   `provider`+`unit_type`+`variant`+`client_id`, none of which vary across lines here) resolves
   the *same* rate for every line — meaning every slot's true cost is provably identical for
   this stage, even though there's no field to address "which line is scene X's start image."
   Rather than the fragile alternative (assuming `estimate.lines` array order lines up with the
   render order of `brollScenes`/`start`+`end` sub-slots, which isn't guaranteed since one is
   built server-side from `planImageSlots()` and the other client-side by iterating fetched
   `scenes`, and a shared/continuous boundary asset renders as **two** `AssetReview` instances —
   one scene's "end" and the next scene's "start" — for what is only **one** `estimate` line), I
   take `estimate.lines[0]?.cost_usd` (correct for every slot, since all lines are equal) with
   the spec's own explicitly-sanctioned `$0.039` constant as fallback for when there's no line
   to read at all (zero b-roll scenes) or the resolved cost is `null` (`rate_missing`). This
   reads as satisfying spec §4's "if it includes a per-line breakdown, compute each slot's cost
   from it; if not, use the constant" instruction on its actual terms, rather than picking
   one branch wholesale — flagging since it required reading `src/lib/cost/engine.ts` and
   `src/stages/image/index.ts`'s `estimate()` to establish the "all lines are equal" fact this
   relies on, not something visible from the frontend types alone.
3. **Left `image/page.tsx`'s primary state fetch (`state`, via local `useState` +
   `useEffect` + `fetch`) untouched — did not migrate it to `useApiResource`.** Spec §4 only
   explicitly asks for the *new* aspect-ratio fetch to use `useApiResource` ("fetch the reel's
   aspect_ratio via a second `useApiResource(...)` call"); §1.4's broader "every page this spec
   rebuilds or creates uses this hook" statement is about pages Wave A/B/D actually rebuild, and
   my task instructions describe this wave as small and specifically scoped to the
   `aspectRatio` prop, the `costUsd` dialog, and header/nav removal. Rewriting the page's
   already-working primary load loop wasn't asked for by §4's text and isn't necessary for
   anything §4 requires, so I left it as-is rather than expanding scope.

## What the Tester should focus on

- **AlertDialog interactions** (the highest-risk new surface this wave adds, since this is the
  first real consumer of `alert-dialog.tsx` anywhere in the app): for a scene with a generated
  start/end image, click "Redo · $0.0X" — confirm Cancel closes the dialog with **no** network
  call (asset/version unchanged), and confirm the primary action button actually triggers the
  redo (check the asset's version count increments) and the dialog closes immediately on click
  (busy/error state then surfaces on the now-revealed trigger button underneath, same as
  before). Same check for "Generate missing images" when its estimated total is nonzero.
- **Aspect ratio rendering**: view the Image stage for reels created with each of the three
  `aspect_ratio` values (9:16, 1:1, 16:9 — set at reel-creation time, not editable after) and
  confirm the Start/End preview boxes render in the matching proportions instead of always
  16:9.
- **Visual duplication is now resolved**: confirm the Image stage page shows *only* the shared
  layout's `ProgressSteps` + Previous/Next chrome at the top — no more stacked old `<h1>Stage 4
  — Images</h1>` or "← Scene"/"Clip →" text links (Wave B's changes.md flagged this exact
  duplication as expected-but-temporary for this page specifically; this wave is what resolves
  it). `scene/page.tsx` still has its own old header/links stacked under the shared layout —
  that's intentionally a different, later wave's job, not a regression here.
- **Cost figures**: confirm the dollar amount shown on each Redo button and inside its
  confirmation dialog matches the per-line amount `CostEstimateBar` shows above (both should
  track the live `rate_card` row for nano-banana/image, not a hardcoded figure, in the normal
  case). Separately — if useful for edge-case coverage — temporarily removing the matching
  `rate_card` row (so `rate_missing` is true) should still show `Redo · $0.039` rather than a
  bare "Redo" with no dialog; that's the deliberate constant fallback from deviation 2, not a
  bug.
- `AssetReview.tsx`'s two new props are additive/optional and this page is currently the only
  caller in the app (grepped for `<AssetReview` repo-wide to confirm), so nothing else could
  have regressed from this change — but flagging for the Reviewer that deviation 1's
  `mediaType`-driven dialog copy is worth a second look once Clip (§5) and Outro (§7.3) land and
  actually exercise the `video` branch of that template string for the first time.
