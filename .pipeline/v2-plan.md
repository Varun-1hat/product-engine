# Product-Engine V2 — Implementation Plan

Status: approved for implementation via the coder/tester/reviewer pipeline. Branch `v1`.
Full narrative version (same content, designed): see the published artifact linked in the
originating chat session. This file is the version pipeline subagents read.

Baseline before this work started: 128/128 Vitest tests passing, 0 TypeScript errors
(verified live, not assumed).

## Summary

The backend (adapters, stage modules, cost engine, review-hook system) is well-architected
and mostly matches `.pipeline/spec.md`'s original build spec. The frontend covers 4 of 9
pipeline stages (splash/dashboard/clients/client-detail count as the "4"; the actual
per-reel pipeline pages are Scene and Image only — Clip, Trim, Outro, Music, and Assembly
have complete backends and zero UI). There is no dark mode anywhere (nor any theme code to
remove — it never existed). Every item in the prior `.pipeline/review.md` code review
(2 BLOCK security findings, 7 correctness bugs, 2 minor notes) is still outstanding, verified
by re-reading current code in this session, not by trusting the old report.

## Confirmed, most important findings

- **BLOCK-1**: no authentication on any `/api/**` route; a service-role Supabase client
  bypasses RLS everywhere; the session-aware client (`src/lib/supabase/server.ts`) exists
  but has zero call sites.
- **BLOCK-2**: `jobs.callback_token` (the webhook's sole authenticator) is serialized into
  API responses; the HeyGen webhook handler fetches an attacker-suppliable URL with no host
  allowlist (SSRF).
- **N1–N7, two minor notes**: reconcile failure path burns the cost idempotency key and
  fatally misroutes jobs; outro jobs have no idempotency key (double-charge exposure); the
  job-claim SQL function has no lock/lease filter; Stage-4 image reuse silently desyncs
  shared-frame lineage; `worker/**` has zero test coverage; Veo's variant leaks into
  non-Veo (Higgsfield) billing; Higgsfield's base URL is doubled (`/v1/v1/generations`);
  the rate-card cache never expires; HeyGen's reference-budget validation checks avatar
  looks and references independently when HeyGen's real API enforces one combined budget
  (confirmed against HeyGen's live docs, not just internal inconsistency).
- **Scene "Save" bug is a data-loss bug, not cosmetic.** The Scene page never builds a
  `scenes[]` payload, so every save falls through to a full AI regeneration
  (`src/stages/scene/index.ts:122`, `if (input.regenerate || !desired)`). Because
  `prompts.scene_id` is `ON DELETE CASCADE` and `assets.scene_id` is `ON DELETE SET NULL`,
  a naive fix that doesn't preserve every existing scene's original `id` on every save would
  cascade-delete prompt history or orphan generated assets instead of just wasting an AI call.
- **Avatar reels cannot be created today.** The "Include an avatar" checkbox never renders a
  look-picker and never sends the `avatar_look_id` the backend requires — every submission
  with it checked returns a 400.
- **HeyGen's core integration is correct**, verified against HeyGen's live documentation:
  endpoint shape, `$7.00/video` flat pricing, and the avatar-id mapping all check out. Two
  confirmed bugs: the reference-budget item above, and Higgsfield's URL doubling / variant
  leak (also review.md items). `reel_config.avatar_look_id` being a single UUID (so the
  adapter's 1–3-avatar capability is unreachable) is a *deliberate* spec'd seam, not a
  defect — out of scope for this pass.
- Dead link: Image stage's "Clip →" points at a page that doesn't exist.
- `advance()` is implemented on every stage module to move `reels.current_stage` forward,
  and is never called from anywhere — the stage pointer has been frozen since build.
  A stage-progress stepper needs this wired in.
- Trim stage's review hooks (redo/revert/download/history) are fully implemented but
  unreachable — no `/trim/review` route exists.
- No file-upload endpoint exists anywhere in the app — blocks Outro's custom end-frame
  upload, Music's track upload, and Config's logo/product-photo upload.
- Supabase Realtime is spec'd (and partially scaffolded — `src/lib/supabase/browser.ts`
  exists specifically for it) but never wired up; also blocked on BLOCK-1's auth landing,
  since Realtime's RLS is `TO authenticated`.
- `CapabilityGuard.tsx` (built to surface reel-setup validation warnings) is imported
  nowhere — warnings are silently dropped.
- No way to add a product, upload a logo, set brand colors/fonts, or clone a client from the
  UI, despite full backend support for all four.
- Only two lines in the whole frontend hardcode colors outside the CSS-variable system
  (`app/components/ui/badge.tsx`'s `warning` variant, `app/components/CapabilityGuard.tsx`)
  — everything else will inherit a new dark palette automatically.
- `AssetReview.tsx` hardcodes 16:9 preview sizing — will letterbox the product's default
  9:16 vertical reels. The component otherwise already branches on media type (img/video/
  audio) and the backend's review-action dispatch is already generic across stages, so
  mirroring Image's pattern for Clip/Outro is realistic.

## Target design

- **Dark palette only.** Replace `globals.css`'s single light `:root` block with a single
  dark one; delete the unused `darkMode:"class"` Tailwind config — there will never be a
  toggle. Add `--warning`/`--warning-foreground` tokens (Badge already has an unstyled
  `warning` variant waiting for them).
- **Component kit**: install Radix primitives, wrap shadcn-style matching the existing CVA
  convention: `@radix-ui/react-{slider,dialog,select,switch,tabs,alert-dialog}` + `sonner`
  for toasts. Hand-build the stage-progress stepper (no Radix equivalent).
- **Navigation**: Clients is the sole top-level entry point (Dashboard deleted, its reel-list
  logic moves into the client page). Client Dashboard (`/clients/[clientId]`) = reels + spend
  + "New reel" primary action + a secondary Config link. Config moves to its own route
  (`/clients/[clientId]/config`) — full page, not a dialog, since the form is long and wants
  deep-linking. Every reel stage renders inside one shared layout with a persistent stepper:
  current stage, overall progress, Previous always available, Next gated on whether the next
  stage has actually been reached (via `advance()` finally being wired in).

## Route map

| Before | After | Change |
|---|---|---|
| `/`, `/dashboard` | `/clients` | Merged — one entry point |
| `/clients/[clientId]` | `/clients/[clientId]` | Becomes reel list + spend + actions |
| — (embedded in client page) | `/clients/[clientId]/config` | Brand kit/keys/avatars/products, split out |
| `/reels/new?client_id=` | `/clients/[clientId]/reels/new` | Path param, not query string; step 1 of the stepper |
| `/reels/[reelId]/scene` | `/reels/[reelId]/scene` | Rebuilt: real editing, inside shared stepper layout |
| `/reels/[reelId]/image` | `/reels/[reelId]/image` | Kept, moved into shared layout, aspect-ratio + confirm fixes |
| — (API only) | `/reels/[reelId]/{clip,trim,outro,music,assembly}` | Five new pages |

## Roadmap (10 phases, each independently reviewable, each gated by typecheck + tests + manual smoke check)

0. **Guardrails** — all review.md items (BLOCK-1/2, N1–N7, two minor notes) + session auth.
   Backend/security only, no visual change. *(This phase's detailed spec:
   `.pipeline/spec.md` as of this pipeline run.)*
1. **Design foundation** — dark palette, new component kit, `src/lib/routes.ts`, shared
   data-fetch hook, `app/(app)/layout.tsx` shell, `loading.tsx`/`error.tsx`.
2. **Navigation & IA restructure** — delete Dashboard, split client page into
   dashboard+Config, move reel creation off the query string, build the reel-stage stepper
   layout, wire `advance()` into stage actions.
3. **Scene rebuild + reel setup** — real scene editing (add/delete/reorder/edit), a Save
   action that only saves, an explicit confirm-gated "Re-run scene-brain," the seconds
   Slider (6–180s, step 1, default 30s — no backend max exists, this is a product default),
   avatar look-picker, Higgsfield hidden from selection, `CapabilityGuard` wired in. Includes
   a new regression test proving Save never calls scene-brain.
4. **Image stage polish** — aspect-ratio-aware preview sizing, confirm-before-costly-action,
   visually distinct free-vs-billed redo.
5. **Clip stage (new page)** — enrich the Clip GET to match Image's shape; build the page
   mirroring Image, branching by scene type; surface the $7 HeyGen cost per avatar clip.
6. **Trim stage (new page + new route)** — add the missing review route; trim in/out
   controls (reusing the Slider); reordering; shared-boundary hints.
7. **Upload infra + Outro, Music, Config uploads** — one generic signed-upload endpoint;
   Outro page (dual-slot: end-frame + clip); Music page (upload + trim, fade/loop labeled as
   automatic-at-assembly, not faked as controls); logo + product-photo upload in Config.
8. **Assembly page + avatar management** — trigger + status polling + download; new avatar
   rename/remove routes; Config gets real avatar preview cards with add/remove/rename/select.
9. **Holistic pass & final report** — full click-through, consistency sweep, re-check every
   item in this document and review.md against final state. This is the Reviewer stage's job
   at the end of the pipeline, not a separate coder phase.

## Explicitly deferred (do not build)

- Higgsfield UI exposure (code + its two bug fixes stay; selection stays hidden).
- Multi-avatar-per-reel (deliberate future seam per the original spec; client-level avatar
  CRUD only in this pass).
- Music fade/loop as user controls (stays automatic-at-assembly; label it, don't fake it).
- Automated frontend/component test suite (manual per-phase verification instead — no
  jsdom/RTL/Playwright exists today and this redesign is CSS/layout-heavy, low signal under
  a DOM-less test runner).
- Realtime-driven live updates (blocked on Phase 0's auth landing; revisit after).
