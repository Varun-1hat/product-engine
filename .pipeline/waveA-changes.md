# Implementation changes — V2 Wave A: Install + Design foundation (spec §0-1)

Branch `v1`. Implements only `.pipeline/spec.md`'s section 0 (Install) and section 1 (Design
foundation) — this is **Wave A** per the spec's own "Execution waves" note. Sections 2-8 are
separate later subagents (Waves B/C/D) and were **not** touched; none of those files exist
yet and none were created here.

This supersedes the prior `.pipeline/changes.md` (V2 Phase 0's security/correctness pass,
archived at `.pipeline/phase0-changes.md`) — that work already landed and is verified clean.
This file describes only Wave A's diff on top of it.

## Verification performed

- `npm install @radix-ui/react-slider @radix-ui/react-dialog @radix-ui/react-select @radix-ui/react-switch @radix-ui/react-tabs @radix-ui/react-alert-dialog sonner`
  — succeeded; `package.json`/`package-lock.json` updated.
- `npx tsc --noEmit`: **clean, 0 errors** (baseline before starting was also 0 errors).
- `npx vitest run`: **169/169 passing across 17 files**, identical to baseline — no test
  files were touched or added (the one new test the full spec calls for, §3.2, belongs to a
  later wave that rewrites the scene page). Note: on this Windows box, vitest prints a couple
  of `[vitest-pool]: Timeout/Failed to terminate forks worker` lines *after* the summary
  reports all-green; reproduced identically on a clean re-run with no code changes in
  between, so it's fork-teardown noise on this OS, not a regression — the pass/fail counts
  match baseline exactly both times.
- `npm audit` reports 3 high-severity advisories, all in `next`'s own nested `postcss`/`sharp`
  dependencies (`node_modules/next/node_modules/postcss`) — pre-existing, unrelated to the
  packages installed in this pass, and `npm audit fix --force`'s suggested remedy is
  downgrading `next` to a `9.x` canary, which is out of scope and not something I did.

## Files changed, by spec section

### 0. Install
- `package.json` / `package-lock.json` — added the seven packages listed in spec §0.

### 1.1 Dark palette
- **`app/globals.css`** — replaced the `:root` block under `@layer base` with the given dark
  HSL tokens verbatim, including the new `--warning`/`--warning-foreground` and
  `--success`/`--success-foreground` pairs.
- **`tailwind.config.ts`** — removed `darkMode: "class"` (no toggle, ever); added `warning`
  and `success` entries to `theme.extend.colors`, same `DEFAULT`/`foreground` shape as the
  existing `destructive` entry.
- **`app/components/ui/badge.tsx`** — `warning` variant was `bg-amber-100 text-amber-900`;
  replaced with `border-transparent bg-warning text-warning-foreground` (mirroring this
  file's *actual* `destructive` line — `border-transparent bg-destructive
  text-destructive-foreground` — rather than the spec's illustrative `/15`-opacity example,
  since that's not the pattern actually in this file; see deviation note below).
- **`app/components/CapabilityGuard.tsx`** — the warnings block's
  `border-amber-300 bg-amber-50 ... text-amber-900` replaced with
  `border-warning/40 bg-warning/10 text-warning` per the spec's literal instruction. Left the
  violations block (already using `destructive` tokens) untouched, as instructed.
- Confirmed via grep: no other `amber` references remain under `app/`. `app/page.tsx`'s
  hardcoded `border` class is untouched, as instructed (that file is replaced wholesale in
  §2, out of this wave's scope).

### 1.2 New UI primitives — `app/components/ui/`
All new files, "shadcn-style" thin wrappers per the spec's umbrella instruction, following
`button.tsx`/`badge.tsx`'s conventions (named exports, `cn()` from `src/lib/cn.ts`, no
`React.forwardRef` — matching Button/Badge, neither of which uses it either):

- **`slider.tsx`** — `Slider`. Renders one `Thumb` per entry in `value ?? defaultValue ??
  [min]` (Radix requires one thumb per value), so it's correct for both a single reel-length
  slider (§3.3) and a future dual-handle trim slider (§6.2) without further edits.
- **`dialog.tsx`** — `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`,
  `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`. `DialogContent` includes
  a small "X" close affordance in the corner (lucide-react's `X`, already a project
  dependency) in addition to exporting `DialogClose` separately for footer-placed cancel
  buttons.
- **`alert-dialog.tsx`** — `AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`,
  `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`,
  `AlertDialogAction`, `AlertDialogCancel`. `AlertDialogAction`/`Cancel` are styled via
  `button.tsx`'s own `buttonVariants` (see deviation note) so `AlertDialogAction` can take
  `variant="destructive"` for delete flows or the default (primary) variant for
  costly-but-intended actions, per spec; `AlertDialogCancel` is hardcoded to the `outline`
  variant.
- **`select.tsx`** — `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`
  (exactly the five named in spec — no `SelectGroup`/`SelectLabel`/`SelectSeparator`, not
  requested).
- **`switch.tsx`** — `Switch`.
- **`tabs.tsx`** — `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`.
- **`skeleton.tsx`** — `Skeleton`, exactly the one-liner the spec gives.
- **`sonner.tsx`** — re-exports `toast`, exports `Toaster` (`theme="dark"` always,
  `toastOptions={{ className: "bg-card text-card-foreground border border-border" }}` —
  matches sonner's actual `ToastOptions.className` field, confirmed against its `.d.ts`).
- **`progress-steps.tsx`** — `ProgressStep`/`ProgressStepsProps` types and `ProgressSteps`
  component per spec: progress-bar width = `reachedIndex/(steps.length-1)` (guarded against
  divide-by-zero when `steps.length <= 1`, clamped to `[0,100]`); "Step X of Y" caption in
  `font-mono text-xs text-muted-foreground` beside the bar; each step renders as a `Link`
  when `index <= reachedIndex` **and** `step.href` is non-null, else a plain non-interactive
  `span` (see deviation note on the href-null handling).

**Deviation**: `button.tsx`'s `buttonVariants` const was changed to `export const
buttonVariants` (previously module-private) so `alert-dialog.tsx` could reuse Button's exact
variant classes instead of duplicating the `cva()` call. This is the only edit to an existing
file inside §1.2's scope; everything else in this section is new files.

### 1.3 Routing helper
- **`src/lib/routes.ts`** — new file, exact contract from the spec (`clients`/`client`/
  `clientConfig`/`newReel`/`reelStage`/`login` builders). Not wired into any *existing* page
  yet — those pages (`app/(app)/clients/**`, `app/(app)/dashboard/**`, `app/(app)/reels/**`)
  are edited in later waves' own sections, and I left them untouched per this wave's scope.
  The new files I did create that link elsewhere (`app/(app)/layout.tsx`, `app/not-found.tsx`)
  already use `routes.*`.

### 1.4 Shared data-fetch hook
- **`app/hooks/useApiResource.ts`** — new file/directory. `useApiResource<T>(url)` with
  try/catch around both the fetch call and a non-ok response (extracts an `error` string
  field from the JSON body when present, else falls back to `Request failed (<status>)`);
  `url === null` short-circuits to `{ data: null, loading: false, error: null }`; `reload` is
  the same internal `load` function exposed for manual re-fetch. `loading` initializes to
  `true` synchronously when `url` is non-null on first render (`useState(url !== null)`) to
  avoid a one-frame "empty" flash before the fetch effect fires.

### 1.5 App shell
- **`app/(app)/layout.tsx`** — new file. `"use client"`; full-width header
  (`border-b border-border`) with a `container`-classed inner row (Tailwind's already
  -configured `container` utility — `center: true, padding: "1.5rem"`, set in
  `tailwind.config.ts`) holding the plain-text "Product Engine" title and an
  `outline`/`sm` "Sign out" `Button`; the sign-out handler POSTs to `/auth/signout` then
  forces `window.location.href = routes.login()` (full navigation, not a client-side push).
  `{children}` renders directly below with **no** additional wrapper — each page keeps its
  own `mx-auto max-w-*` container, per the spec's "content below still gets the centered
  max-width treatment per-page." `<Toaster />` is mounted once, after `{children}`.
- Note: this automatically wraps every *existing* page under `app/(app)/**` (dashboard,
  clients, reels/new) with the new top bar immediately, since Next.js layouts apply to the
  whole route-group subtree regardless of whether individual pages have been redesigned yet.
  This matches your framing ("some existing pages won't use the new primitives/hook/shell yet
  ... that's expected and fine") — it doesn't break any existing page's functionality, it
  just adds a header above it.

### 1.6 Next.js fallback files
- **`app/loading.tsx`** — 4 stacked `Skeleton` rectangles in a centered `max-w-3xl` column
  (no `"use client"` — pure presentational, same non-client convention as `Badge`/`Card`).
- **`app/error.tsx`** — `"use client"`; default export named `ErrorPage` (not `Error`, to
  avoid shadowing the global `Error` constructor — Next only cares about the file's default
  export, not its name) accepting `{ error, reset }`; centered "Something went wrong" +
  `error.message` in `text-muted-foreground` + a "Try again" `Button` calling `reset()`.
- **`app/not-found.tsx`** — centered message + `Link` to `routes.clients()`.

## Deviations / judgment calls

1. **`badge.tsx` warning-variant pattern**: the spec's own illustrative example
   (`bg-destructive/15 text-destructive`) doesn't match what's actually in this file
   (`bg-destructive text-destructive-foreground`, no opacity, uses the `-foreground` token).
   Per the spec's own "match whatever pattern is actually there — read the file first"
   instruction, I mirrored the real `destructive` line, not the illustrative example.
2. **`sonner.tsx` mount-location cross-reference typo**: §1.2 says "Mount `<Toaster />` once,
   in the root layout (section 1.4)" — but §1.4 is the `useApiResource` hook, not a layout.
   §1.5 ("App shell") is the section that actually specifies the layout and explicitly says
   to mount `<Toaster />` there. I mounted it in `app/(app)/layout.tsx` per §1.5's explicit
   text, treating §1.2's "(section 1.4)" as an off-by-one typo for "(section 1.5)". Toaster is
   therefore not available on `/login` or `/auth/**` (outside the `(app)` group) — consistent
   with §1.5 being the explicit, unambiguous instruction and those routes being outside this
   redesign's scope.
3. **`buttonVariants` export**: added `export` to `button.tsx`'s existing `const
   buttonVariants = cva(...)` (previously module-private) so `alert-dialog.tsx` could reuse
   it, per §1.2's requirement that `AlertDialogAction` "gets Button's destructive variant ...
   default/primary variant." This is the one existing-file edit inside §1.2's nominally
   "new files only" scope; it's additive (no behavior change to `Button` itself) and the only
   way to satisfy that requirement without duplicating the `cva()` call.
4. **`progress-steps.tsx` href-null handling**: the spec's prose ties "Link vs. span" to
   "reached vs not-reached," but `ProgressStep.href` is typed `string | null`, and Next's
   `<Link>` requires a non-null `href` — so a step that's "reached" but has `href: null` (the
   exact case §3.3, a later wave, deliberately constructs by setting every `href` to `null`)
   can't literally render as a `Link`. I render as a `Link` only when `isReached && href`
   both hold; otherwise a `span`, keeping the current-step highlight
   (`text-foreground font-medium`) even when it's a non-linkable span. This completes an
   edge case the spec's own later section relies on rather than deviating from anything
   explicitly asked.
5. **Dialog's built-in close "X"**: not explicitly itemized in the spec's `dialog.tsx` bullet
   (which only lists exports + Overlay/Content styling), but it's standard "shadcn-style"
   (the spec's own umbrella instruction for §1.2), and `DialogClose` is still separately
   exported for callers who want a custom close button elsewhere (e.g. in a footer). Did
   *not* add the equivalent to `alert-dialog.tsx` — matches the shadcn convention that alert
   dialogs force an explicit Action/Cancel choice, no stray close affordance.

## Explicitly out of scope for this wave (confirmed not touched)

- Sections 2-8 of the spec (navigation restructure, scene/image/clip/trim/outro/music/
  assembly pages, config tabs, avatar management, upload infra) — none of those files exist
  yet and none were created.
- Existing pages that still have hardcoded route strings / raw `<select>`/
  `<input type="checkbox">` (`app/(app)/clients/**`, `app/(app)/dashboard/**`,
  `app/(app)/reels/**`, `app/page.tsx`) — untouched, per instruction that this wave only
  builds the building blocks. The spec §1.3 closing paragraph's project-wide "grep for
  hardcoded route literals" cleanup only makes sense once the pages that use them are
  themselves rewritten in later waves, so it wasn't attempted here.

## What the Tester should focus on

- Visual smoke-check of the dark palette against every existing page (clients list, client
  detail, dashboard, reels/new) — the CSS variable swap applies automatically with no
  per-component changes, so it's worth confirming nothing renders illegibly (e.g. any place
  that assumed a light background via a non-token raw color that isn't one of the two spots
  fixed here).
- `app/(app)/layout.tsx`'s Sign-out button: POST to `/auth/signout` then a hard navigation —
  no automated test covers this (client-side `fetch` + `window.location.href`); worth a
  manual check that it actually clears the session (Phase 0's middleware should then redirect
  back to `/login` on the next request).
- The new Radix primitives have **zero usages yet** (by design — wiring happens in Waves
  B/C/D), so nothing exercises them at runtime in this pass. Worth a first-usage smoke test
  once a later wave's pages start consuming them (Select/Dialog/AlertDialog/Switch/Tabs/
  Slider), particularly the `AlertDialogAction` variant plumbing (deviation 3 above) since
  that's the one place this wave reached into another component file's export.
