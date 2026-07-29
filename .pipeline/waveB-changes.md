# Implementation changes — V2 Wave B: Navigation & IA restructure (spec §2)

Branch `v1`. Implements only `.pipeline/spec.md`'s section 2 (Navigation & IA restructure) —
this is **Wave B** per the spec's own "Execution waves" note. Wave A (§0-1, design foundation)
already landed and is verified clean (its changes.md is archived at
`.pipeline/waveA-changes.md` by the orchestrating session); this file supersedes it per
standing instructions. Sections 1, 3, 4, 5, 6, 7, 8 are separate waves and were **not**
touched — where later-wave sections reference a file this wave creates (e.g. §3.3 on the
reel-setup page, §7.5/§8.2 on the Config tabs), I left the corresponding new capability out
and noted where the seam is, per the spec's own explicit instructions to me.

## Verification performed

- `npx tsc --noEmit`: **clean, 0 errors** (baseline before starting was also 0 errors; re-ran
  after every batch of edits, most recently after the final `clients/page.tsx` edit).
- `npx vitest run`: **169/169 passing across 17 files**, identical to baseline — no test files
  were touched (this wave has no test-writing task; that's spec §3.2, a later wave). Same
  Windows-only `[vitest-pool]: Timeout/Failed to terminate forks worker` post-summary noise
  Wave A already documented — pass/fail counts match baseline exactly, not a regression.
- `npx next build`: attempted for extra confidence given this wave restructures routing
  (new layout, moved/deleted route segments), but blocked by a pre-existing environment issue
  unrelated to this change: `@next/swc-win32-x64-msvc`'s native binary fails to load ("not a
  valid Win32 application") on this box, then an `EPERM` writing `.next/trace` (this repo
  lives under OneDrive, which locks files during sync). Neither is code-related. `tsc
  --noEmit` + `vitest run` are the checks the spec's "Before finishing" section actually
  requires, and both are clean; I'm flagging the blocked build attempt for visibility rather
  than treating it as passing verification.

## Files changed, by spec subsection

### 2.1 Delete
- Deleted `app/(app)/dashboard/` (directory + `page.tsx`) entirely, after reading its
  `ClientReels` logic first (ported into §2.3 below).

### 2.2 Root redirect
- **`app/page.tsx`** — replaced the splash page with `redirect(routes.clients())` (server
  component). Used the routing helper rather than the spec's literal illustrative
  `redirect("/clients")` snippet, consistent with §1.3's "every page/link this spec touches
  uses `routes.*`" mandate — this file is squarely touched by this section.

### 2.3 Client Dashboard
- **`app/(app)/clients/[clientId]/page.tsx`** — rewritten. Now the reel-list + spend + actions
  view: header shows the client's `display_name` (via `useApiResource` on
  `GET /api/clients/{clientId}`), a `ghost`/`sm` "Config" link to `routes.clientConfig`, and a
  primary "New reel" button to `routes.newReel`. Below it, the ported `ClientReels` logic (a
  second independent `useApiResource` call on `GET /api/clients/{clientId}/reels`) renders
  each reel's name/stage badge/status badge/`SpendBar`, with loading and error states for both
  resources (the old dashboard had none — silent failure). All brand-kit/provider-key/avatar/
  product form fields are gone from this file, moved to Config (§2.4).

### 2.4 Config page
- **`app/(app)/clients/[clientId]/config/page.tsx`** (new) — thin shell: fetches only
  `client.display_name` for the header, renders `<Tabs>` with four triggers
  (Brand/Keys/Products/Avatars) wrapping the four tab components below, each given only
  `clientId`. Header is `"Config"` as a small eyebrow label above an `<h1>` that is itself the
  back-link (`← {display_name}` → `routes.client(clientId)`) — read the spec's "eyebrow above
  the display_name, plus a back-link styled `← {display_name}`" as one combined element rather
  than two separate pieces of text, since a page whose whole purpose is "settings for one
  client" reads most naturally that way; see deviation note below.
- **`app/components/config/ConfigBrandTab.tsx`** (new) — `brand_name` + `default_tagline`
  fields (moved from the old client detail page's combined form), independent
  `useApiResource(GET /api/clients/{clientId})` + PATCH `{ brand_kit: {...} }` on save. No new
  fields (logo upload, colors/fonts, aspect/resolution selects) — that's §7.5, a later wave.
- **`app/components/config/ConfigKeysTab.tsx`** (new) — the two provider-key password inputs
  (Google/Gemini, HeyGen), PATCH `{ provider_keys: [...] }` on save. Moved as-is per spec
  ("gets no new capability in this pass"); see deviation note on why this one doesn't call
  `useApiResource` unlike the other three.
- **`app/components/config/ConfigProductsTab.tsx`** (new) — the read-only products badge list,
  independent fetch. No add-product form — that's §7.5.
- **`app/components/config/ConfigAvatarsTab.tsx`** (new) — the read-only avatars badge list,
  independent fetch. No rename/remove/preview-card CRUD — that's §8.2. Copy fix: "save a
  HeyGen key above" → "save a HeyGen key in the Keys tab" (see deviation note).

### 2.5 Reel creation moves
- **`app/(app)/clients/[clientId]/reels/new/page.tsx`** (new) — moved from
  `app/(app)/reels/new/page.tsx` (now deleted, along with the emptied `app/(app)/reels/new/`
  directory). `clientId` now comes from route `params` (`use()` pattern, matching
  `clients/[clientId]/page.tsx`/`scene/page.tsx`) instead of `useSearchParams().get("client_id")`
  — dropped the `Suspense` wrapper and the "Missing ?client_id=" error branch, both now
  structurally impossible. Post-create navigation changed from a hardcoded template string to
  `routes.reelStage(data.reel.id, "scene")`. Everything else (fields, the raw `<select>`s, the
  avatar `<input type="checkbox">`) is untouched — the slider/avatar-picker/Switch/Higgsfield-
  hiding rework is spec §3.3, a later wave; this pass is file-move + param-source only.

### 2.6 Reel-stage stepper shell
- **`app/(app)/reels/[reelId]/layout.tsx`** (new) — fetches `GET /api/reels/{reelId}` via
  `useApiResource` once; derives `reachedIndex`/`currentIndex` from `STAGE_ORDER`
  (`@/src/stages/types`) and `usePathname()`'s last segment. Renders `ProgressSteps` (built
  from `STAGE_ORDER.slice(1)`, 7 entries scene→assembly, each `href` set when
  `STAGE_ORDER.indexOf(stage) <= reachedIndex`, else `null`), then a strongly-weighted
  Previous/Next row (`size="lg"`, Next = primary variant, Previous = `outline`), then
  `{children}`. Previous always renders: `← Back to {client display_name}` → `routes.client(...)`
  when viewing `scene` (fetches the client's `display_name` via a second, dependent
  `useApiResource`), otherwise `← {PreviousStageLabel}` → `routes.reelStage(reelId,
  previousStage)`. Next doesn't render at all on `assembly` (the last stage); otherwise it's a
  `Button` (never a plain `Link`, since it sometimes has to `await` a POST before navigating —
  see §2.7) that's disabled with a permanently-visible "Complete this stage to continue"
  caption when not clickable. See the deviation note below — this is the section where I had
  to resolve a real internal inconsistency between §2.6's and §2.7's prose.

### 2.7 Wiring `advance()`
- **`app/api/reels/[reelId]/advance/route.ts`** (new) — `POST`, no body. Looks up
  `reel.current_stage` via `getReel()` (`src/lib/context.ts`, already exported, not itself
  carried on `StageContext`), dispatches to a `STAGE_MODULES` map (`scene`/`image`/`clip`/
  `trim`/`outro`/`music`/`assembly` → `sceneStage`/`imageStage`/.../`assemblyStage`, matching
  each existing route's own import), builds the full `StageContext` via `buildStageContext`,
  calls `mod.advance(ctx)` exactly as written (no new gating logic added inside any stage
  module, per spec), returns `{ current_stage }`. 400 + `{error}` on an unrecognized
  `current_stage` or a thrown error, matching every other stage route's error-handling shape.
- **Next-button wiring** (in `app/(app)/reels/[reelId]/layout.tsx`'s `handleNext`): when
  `currentIndex === reachedIndex` (about to move into genuinely new territory), `POST`s
  `/advance`, `await reload()`s the layout's own `/api/reels/{reelId}` resource (so
  `reachedIndex` is fresh before navigating — without this the Next button would incorrectly
  show disabled immediately after landing on the newly-reached stage; see deviation note), then
  `router.push`es. When `currentIndex < reachedIndex` (revisiting an earlier, already-reached
  stage), skips the POST and navigates directly, so advancing only ever fires once per
  transition. Errors surface inline (`text-destructive`, next to the button) rather than via a
  toast — no other page in this wave (or Wave A) uses `sonner`'s toast yet, and nothing in §2's
  text calls for introducing it here, so I stayed with the repo's existing inline-error
  convention instead.

### Necessary side-fix (direct consequence of §2.1)
- **`app/(app)/clients/page.tsx`** — this page had a `"Dashboard"` header link to `/dashboard`,
  which §2.1 deletes. Removed the dead link (Clients is now effectively the app's landing page,
  there's no dashboard concept left to link to) and switched the per-client list link from a
  hardcoded `` `/clients/${c.id}` `` template string to `routes.client(c.id)`, since I was
  already touching this exact line and §1.3 asks every touched page to use `routes.*`. No other
  changes to this file (its "New client" create form is untouched, and clone-from is §7.5, a
  later wave).

## Deviations / judgment calls

1. **Next-button enablement — resolved a real contradiction between §2.6 and §2.7, not just an
   ambiguity.** §2.6 says Next is enabled "only when `STAGE_ORDER.indexOf(STAGE_ORDER[currentIndex
   + 1]) <= reachedIndex`" — i.e. only when the *next* stage has already been reached
   (`reachedIndex > currentIndex`, strictly). But `current_stage` (and therefore `reachedIndex`)
   only ever changes via a stage module's `advance()`, and the *only* caller of `advance()` is
   this same Next button (confirmed by grepping every `current_stage` write site under `src/`:
   the sole non-`advance()` writer is reel creation, which sets it to `"scene"`). Taken
   literally, §2.6's formula means Next is disabled the very first time a user is on any stage
   (`currentIndex === reachedIndex`, the normal/common case) — which makes §2.7's entire
   "if `currentIndex === reachedIndex`, POST `/advance` first" branch permanently unreachable
   from the UI, i.e. dead code, directly contradicting §2.7's own explicit purpose ("wire the
   Next button" to actually call `advance()`) and my own task instructions ("Section 2.7's
   `advance()` wiring is part of this wave — implement it"). I resolved this by implementing
   Next as enabled whenever `currentIndex <= reachedIndex` (dropping the `+1`), which is what
   makes §2.7's two branches exhaustive and actually reachable: the common case
   (`currentIndex === reachedIndex`, viewing your current frontier stage for the first time)
   advances-then-navigates; the less common case (`currentIndex < reachedIndex`, you clicked
   back to an earlier stage and are clicking Next to return forward) just navigates. Under this
   reading, §2.6's "disabled, `Complete this stage to continue`" branch still has real (if
   rare) meaning: it covers `currentIndex > reachedIndex`, e.g. someone manually navigates to a
   stage URL beyond what the reel has actually reached — never hidden, per spec, just
   genuinely disabled in that one case. **Flagging this prominently since it's a substantive
   reinterpretation of explicit spec prose, not a "read the file, match reality" cleanup** —
   worth the Reviewer double-checking my reasoning (laid out in full in the layout file's
   top-of-component comment) against the intended design.
2. **`reload()` after a successful advance.** Because `app/(app)/reels/[reelId]/layout.tsx`
   persists as the same component instance across sibling-page navigations (Next.js reuses a
   layout across routes under the same dynamic segment), its fetched `reel.current_stage`
   would otherwise go stale the instant `advance()` changes it server-side — which would make
   the Next button on the *newly arrived* stage incorrectly render as disabled (comparing the
   new page's `currentIndex` against a `reachedIndex` that hasn't caught up yet). Not spelled
   out explicitly in §2.7's sketch, but required for the feature to actually work; I `await
   reload()` (the hook's built-in re-fetch) right after a successful `/advance` POST, before
   navigating.
3. **`ConfigKeysTab` doesn't call `useApiResource`.** §2.4 says "each [tab] calls
   `useApiResource` against `GET /api/clients/{clientId}` independently and reads the slice it
   needs." Provider keys are write-only (`ConfigOutput`/`GET /api/clients/{clientId}` never
   returns them, by design — vault-backed secrets aren't re-exposed), so there is no slice for
   this specific tab to read; the other three tabs (Brand/Products/Avatars) do each call the
   hook as instructed. I left this one as local-state-only, matching "gets no new capability in
   this pass — move its existing content as-is" (the original combined form never displayed
   existing key values either, only "leave blank to keep existing" placeholders).
4. **Config page header — read as one combined element.** §2.4 lists two things ("`Config` as
   a small eyebrow label above the client's `display_name`" and "a link back to
   `routes.client(clientId)` ... styled as a back-link, e.g. `← {display_name}`") that would
   otherwise imply *both* a separate `<h1>{display_name}</h1>` *and* a separately-styled back
   link repeating the same name. I rendered it as one: an eyebrow `"Config"` label, then a
   single `<h1>` whose content *is* the `← {display_name}` back-link. This is the only reading
   that doesn't show the client's name twice back-to-back for a page whose only job is
   "settings for this one client."
5. **`ClientDashboardPage`'s reel links go to `routes.reelStage(reel.id, reel.current_stage)`,
   not a hardcoded `"scene"`.** The ported dashboard logic originally linked every reel
   unconditionally to `/reels/{id}/scene` regardless of progress. Since `current_stage` is
   already present on the exact object used one line below for the stage badge, and
   `routes.reelStage` takes a `stage` parameter for precisely this purpose, sending users back
   to Scene even after they've reached Assembly seemed like the pre-existing shortcut this
   whole IA restructure exists to fix, not a behavior worth preserving byte-for-byte. Flagging
   in case the Reviewer wants the literal old behavior instead.
6. **Spec cross-reference typo, same shape as Wave A's §1.2→§1.4/1.5 note.** §2.5 says "The
   slider/avatar-picker/Higgsfield-hiding changes to this page are specified in section 3.2
   below" — section 3.2 is actually "New regression test"; the enhancements described are in
   §3.3 ("Reel-setup page enhancements"). Doesn't change what I did (§2.5 is explicit that only
   the file-move + param-source change belongs to this wave regardless of which subsection
   number is correct), just noting it for whoever implements §3 next.
7. **`ConfigProductsTab`/`ConfigAvatarsTab` gained a one-line loading state and (Products only)
   an empty-state message** that the pre-split combined page didn't need (it gated its *entire*
   body behind one `if (!data) return <Loading/>`). Now that each tab fetches independently,
   each needs its own minimal loading/error handling — this is structural fallout from the
   split itself, not new capability.

## What the Tester should focus on

- **The Next-button logic above (deviation 1) is the highest-risk area in this wave** — walk a
  fresh reel through all 7 stages (`scene → image → clip → trim → outro → music → assembly`)
  clicking only "Next" each time, confirming: (a) Next is clickable on first arrival at every
  stage, (b) each click actually calls `POST /advance` exactly once (check `reels.current_stage`
  server-side after each click, or watch the network tab), (c) after arriving at a new stage,
  Next is enabled again (not stuck disabled from stale `reachedIndex`), (d) Next never renders
  on Assembly. Then click "← {stage}" back a couple of stages and click Next forward again —
  confirm it navigates without re-POSTing `/advance` (e.g. `current_stage` doesn't regress or
  get redundantly re-set).
- `scene/page.tsx` and `image/page.tsx` are now wrapped by the new stepper layout but were
  **not** edited by this wave (that's §3/§4's job) — expect to see the *new* ProgressSteps/
  Previous/Next chrome stacked directly above each page's *old*, still-present inline "Stage 3
  — Scenes" header and "← Scene"/"Images →"/"Clip →" text links. This visual duplication is
  expected and temporary, not a bug in this wave.
- `app/(app)/clients/[clientId]/reels/new/page.tsx`: confirm creating a reel from a client's
  page still works end-to-end (topic/seconds/avatar-checkbox/broll-select/aspect/resolution →
  `POST /api/reels` → redirect to `/reels/{id}/scene`) — the only change here is where
  `clientId` comes from, but it's worth confirming the route param actually threads through.
- Config page: confirm all four tabs load independently (Brand/Keys/Products/Avatars), that
  Brand's save round-trips correctly, and that switching tabs doesn't carry stale state from a
  previous tab visit (each tab re-fetches on mount since Radix unmounts inactive `TabsContent`
  by default — verified by reading `node_modules/@radix-ui/react-tabs`, not just assumed).
- `app/api/reels/[reelId]/advance/route.ts` has no automated test (this wave adds no tests —
  §3.2's regression test is a later wave and out of scope here per my instructions); worth a
  manual/integration check that each of the 7 `STAGE_MODULES` entries' `advance()` actually
  flips `reels.current_stage` to the expected next value against a real Supabase instance.
