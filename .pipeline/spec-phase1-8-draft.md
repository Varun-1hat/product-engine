# Spec — V2 Phases 1-8: full frontend redesign (single pass, branch `v1`)

Staged as a draft; the orchestrating session copies this to `.pipeline/spec.md` only once
Phase 0 (security/correctness guardrails, run separately) is verified clean. By the time you
read this as `.pipeline/spec.md`, Phase 0 has already landed: `middleware.ts` gates every
route except `/login`, `/auth/**`, and `/api/webhooks/**`; `app/login/page.tsx`,
`app/auth/callback/route.ts`, and `app/auth/signout/route.ts` exist; `ReviewHooks.redoAsset`
implementations return a redacted `PublicJob` (no `callback_token`/`payload`) — reuse that
type, don't re-derive redaction logic; the Higgsfield/N6/rate-cache/etc. backend bugs are
fixed and out of scope here.

Full narrative rationale lives in `.pipeline/v2-plan.md` — read it once for context, but
**this file is what you implement.** It is long because the request was explicit: be very
thorough, leave nothing ambiguous, this is a real refactor and deserves the token budget.
No OPEN QUESTIONS — every judgment call is decided below.

**Execution waves** (the orchestrating session runs these as separate subagents — you may be
given only one wave's sections at a time; if so, treat sections outside your wave as already
done and read the actual current files rather than assuming): Wave A = section 1. Wave B =
section 2 (depends on A). Wave C = section 4 (depends on B, since the page it touches now
lives under the Wave B layout, and it changes `AssetReview.tsx` which Wave D's sections
consume). Wave D = sections 3, 5, 6, 7, 8, run in parallel against each other (each depends
on A+B+C but not on each other) — this is why section 2.4 below has each of Config's four
tabs living in its own file: sections 7 and 8 both add to the Config page, and without that
split they'd conflict on one shared file. If you are implementing more than one wave in a
single pass, still do them in this order (A, then B, then C, then D's sections in any order
within your batch) and never edit a file two sections both claim without re-reading it fresh
between them.

Baseline before you start: `npx tsc --noEmit` clean, `npx vitest run` green (Phase 0's tester
left it that way). Keep both clean throughout — run `npx tsc --noEmit` after each section,
not just once at the very end, so a mistake in section 2 doesn't silently compound by
section 7.

---

## 0. Install

```
npm install @radix-ui/react-slider @radix-ui/react-dialog @radix-ui/react-select @radix-ui/react-switch @radix-ui/react-tabs @radix-ui/react-alert-dialog sonner
```

---

## 1. Design foundation

### 1.1 Dark palette — `app/globals.css`

Replace the entire `:root { ... }` block under `@layer base` with these values (same
variable names already used everywhere in the codebase — every existing component picks
this up automatically, no per-component edits needed for the palette swap itself):

```css
:root {
  --background: 240 10% 6%;
  --foreground: 210 20% 96%;
  --card: 240 9% 9%;
  --card-foreground: 210 20% 96%;
  --primary: 217 91% 60%;
  --primary-foreground: 0 0% 100%;
  --secondary: 240 6% 16%;
  --secondary-foreground: 210 20% 96%;
  --muted: 240 6% 14%;
  --muted-foreground: 240 5% 65%;
  --accent: 240 6% 18%;
  --accent-foreground: 210 20% 96%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 98%;
  --warning: 38 92% 50%;
  --warning-foreground: 0 0% 9%;
  --success: 142 71% 45%;
  --success-foreground: 0 0% 100%;
  --border: 240 6% 20%;
  --input: 240 6% 20%;
  --ring: 217 91% 60%;
  --radius: 0.5rem;
}
```

In `tailwind.config.ts`: delete the `darkMode: "class"` line entirely (there will never be a
toggle). In the `theme.extend.colors` object, add `warning` and `success` entries following
the exact same shape as the existing `destructive` entry (`{ DEFAULT: "hsl(var(--warning))",
foreground: "hsl(var(--warning-foreground))" }`, same for `success`).

Fix the two hardcoded-color spots so they use the new tokens instead of raw Tailwind amber:
- `app/components/ui/badge.tsx`: the `warning` variant currently hardcodes
  `bg-amber-100 text-amber-900` (or similar). Replace with the same class *pattern* the
  `destructive` variant in that file already uses, substituting `warning` for `destructive`
  (e.g. if destructive is `border-transparent bg-destructive/15 text-destructive`, warning
  becomes `border-transparent bg-warning/15 text-warning`). Match whatever pattern is
  actually there — read the file first.
- `app/components/CapabilityGuard.tsx` line ~19: replace
  `border-amber-300 bg-amber-50 ... text-amber-900` with the token equivalent
  (`border-warning/40 bg-warning/10 text-warning`), keeping the violations block above it
  (which already correctly uses `destructive` tokens) as a style reference.
- `app/page.tsx`: this file is being replaced in section 2, so no fix needed here — its bare
  `border` class goes away with the file.

### 1.2 New UI primitives — `app/components/ui/`

All shadcn-style: thin wrappers around the Radix primitive, styled with the token classes
above, following the exact composition/CVA conventions already established in
`app/components/ui/button.tsx` and `badge.tsx` (read both before starting — match their
export shape: named exports, `React.forwardRef` where the existing components use it,
`cn()` from `src/lib/cn.ts` for class merging).

- **`slider.tsx`** — wraps `@radix-ui/react-slider`. Export `Slider` forwarding
  `value`/`defaultValue`/`min`/`max`/`step`/`onValueChange`/`className`. Track:
  `bg-secondary`; filled range: `bg-primary`; thumb: circular, `border-2 border-primary
  bg-background`, visible focus ring using `--ring` (`focus-visible:ring-2
  focus-visible:ring-ring focus-visible:ring-offset-2`).
- **`dialog.tsx`** — wraps `@radix-ui/react-dialog`: export `Dialog`, `DialogTrigger`,
  `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`,
  `DialogClose`. Overlay: `bg-background/80 backdrop-blur-sm`. Content: centered,
  `bg-card border border-border rounded-lg shadow-lg p-6`, max-width ~28rem.
- **`alert-dialog.tsx`** — wraps `@radix-ui/react-alert-dialog`, same visual language as
  `dialog.tsx`. Export `AlertDialog`, `AlertDialogTrigger`, `AlertDialogContent`,
  `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`,
  `AlertDialogAction`, `AlertDialogCancel`. This is what every costly/destructive
  confirmation in this spec uses — `AlertDialogAction` gets `Button`'s `destructive` variant
  when the action is destructive (delete), the default/`primary` variant when it's just
  costly-but-intended (generate, redo-that-costs-money).
- **`select.tsx`** — wraps `@radix-ui/react-select`: `Select`, `SelectTrigger`,
  `SelectValue`, `SelectContent`, `SelectItem`. Replaces raw `<select>` elements used today
  in `reels/new/page.tsx`.
- **`switch.tsx`** — wraps `@radix-ui/react-switch`. Replaces raw `<input type="checkbox">`
  toggles (e.g. "Include an avatar").
- **`tabs.tsx`** — wraps `@radix-ui/react-tabs`: `Tabs`, `TabsList`, `TabsTrigger`,
  `TabsContent`. Used in the Config page (section 7) to separate Brand/Keys/Avatars/Products
  into tabs instead of one long scroll.
- **`skeleton.tsx`** — `export function Skeleton({ className }: { className?: string })`
  rendering `<div className={cn("animate-pulse rounded-md bg-muted", className)} />`.
  Respect `prefers-reduced-motion` by wrapping the `animate-pulse` utility only when the
  media query allows it is overkill here — Tailwind's `animate-pulse` is a subtle opacity
  pulse, acceptable to leave as-is.
- **`sonner.tsx`** — re-export `toast` from `"sonner"` and export a `Toaster` component that
  wraps `sonner`'s `<Toaster />` with `theme="dark"` (always — no system detection, this app
  is dark-only) and token-matched `toastOptions` (`className: "bg-card text-card-foreground
  border border-border"`). Mount `<Toaster />` once, in the root layout (section 1.4).
- **`progress-steps.tsx`** — hand-built, no Radix equivalent. This is the stage stepper.

```ts
export interface ProgressStep { id: string; label: string; href: string | null; }
export interface ProgressStepsProps {
  steps: ProgressStep[];
  currentIndex: number;   // which step the user is currently viewing
  reachedIndex: number;   // furthest index actually reached (reel.current_stage-derived)
}
```

Render: a thin filled progress bar (`width: ${(reachedIndex / (steps.length - 1)) * 100}%`
on a `bg-primary` bar inside a `bg-secondary` track) above a horizontal row of step labels
(wraps to multiple lines on narrow viewports — flex-wrap, not a scroll container). Each step
at `index <= reachedIndex` renders as a `Link` to `steps[index].href` (muted text, or
`text-foreground font-medium` when `index === currentIndex`); each step at
`index > reachedIndex` renders as a plain `<span>` (not a link), `text-muted-foreground/50`,
not interactive. Include a small `"Step {currentIndex + 1} of {steps.length}"` caption in
`font-mono text-xs text-muted-foreground` above or beside the bar.

### 1.3 Routing helper — `src/lib/routes.ts`

```ts
import type { StageId } from "@/src/lib/db/enums";

export const routes = {
  clients: () => "/clients",
  client: (clientId: string) => `/clients/${clientId}`,
  clientConfig: (clientId: string) => `/clients/${clientId}/config`,
  newReel: (clientId: string) => `/clients/${clientId}/reels/new`,
  reelStage: (reelId: string, stage: StageId) => `/reels/${reelId}/${stage}`,
  login: (next?: string) => (next ? `/login?next=${encodeURIComponent(next)}` : "/login"),
};
```

Every page/link touched by this spec must import and use `routes.*` instead of an inline
template string. Grep the whole `app/**` tree once you're done and confirm no hardcoded
`"/dashboard"`, `"/clients/"`, `"/reels/"` string literals remain in JSX/`router.push`/`Link
href` (route-handler internals like `NextResponse.redirect` can still build URLs directly
since those aren't client-side navigation).

### 1.4 Shared data-fetch hook — `app/hooks/useApiResource.ts`

```ts
export function useApiResource<T>(url: string | null): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}
```

Implements fetch-on-mount-and-on-url-change with proper `try/catch` around both the network
call and a non-ok response (unlike today's Dashboard, which has zero error handling and
silently swallows failures — every caller of this hook gets error handling for free).
`url === null` means "don't fetch yet" (loading stays `false`, data stays `null`) — used for
cases where a dependent id isn't available yet. Every page rebuilt or created by this spec
uses this hook instead of a local `useEffect` + `fetch` + three `useState` calls.

### 1.5 App shell — `app/(app)/layout.tsx`

```tsx
"use client";
```

Thin top bar: product name (plain text, e.g. "Product Engine" — no logo asset exists, don't
invent one), right-aligned a small "Sign out" `Button` (variant `outline`, `size="sm"`) that
POSTs to `/auth/signout` then does `window.location.href = "/login"` (a full navigation, not
a client-side route push, since signing out should drop all client-side state). Renders
`{children}` below in the existing page container pattern (reuse the `mx-auto max-w-*`
wrapper convention from the current pages — the top bar itself spans full width with its own
`border-b border-border` separator, content below still gets the centered max-width
treatment per-page). Also mount `<Toaster />` (from `app/components/ui/sonner.tsx`) once
here.

### 1.6 Next.js fallback files

- `app/loading.tsx` — centered `Skeleton` blocks approximating a page of cards (3-4 skeleton
  rectangles stacked with gaps), not just "Loading…" text.
- `app/error.tsx` (must be a Client Component, `"use client"`, accepts `{ error, reset }`
  props per Next's convention) — a centered message ("Something went wrong") + the error
  message in `text-muted-foreground` + a "Try again" `Button` calling `reset()`.
- `app/not-found.tsx` — centered message + a `Link` back to `routes.clients()`.

---

## 2. Navigation & IA restructure

### 2.1 Delete

Delete `app/(app)/dashboard/` entirely (the whole directory, `page.tsx` and all).

### 2.2 Root redirect — `app/page.tsx`

Replace the splash content with a server-side redirect:

```tsx
import { redirect } from "next/navigation";
export default function RootPage() {
  redirect("/clients");
}
```

### 2.3 Client Dashboard — `app/(app)/clients/[clientId]/page.tsx`

This becomes the reel list + spend + actions view. Port the `ClientReels` logic (fetch
`/api/clients/{clientId}/reels`, render each reel's name/status/stage badges/`SpendBar`)
from the now-deleted dashboard page — read it from git history if needed
(`git show HEAD:app/\(app\)/dashboard/page.tsx`) before deleting it in 2.1, or read it first
and keep the logic in memory/a scratch note before removing the file. Header: client's
`display_name` as the page title, a primary `Button` "New reel" linking to
`routes.newReel(clientId)`, and a secondary (smaller, less visually weighted — `variant
="ghost"` or `"outline"`) "Config" link to `routes.clientConfig(clientId)`. Remove every
brand-kit/provider-key/avatar/product form field from this file — all of that moves to 2.4.
Use `useApiResource` for both the client fetch and the reels-with-spend fetch.

### 2.4 Config page — `app/(app)/clients/[clientId]/config/page.tsx` (new)

This page must be a thin shell only — all real tab content lives in four separate files so
later sections can be implemented in parallel without touching the same file:

- `app/components/config/ConfigBrandTab.tsx`
- `app/components/config/ConfigKeysTab.tsx`
- `app/components/config/ConfigProductsTab.tsx`
- `app/components/config/ConfigAvatarsTab.tsx`

Move the current `app/(app)/clients/[clientId]/page.tsx` body (brand kit form, provider-key
form, avatars section, products section) into these four files, splitting it along those
lines (brand-kit fields → `ConfigBrandTab`; the two provider-key inputs → `ConfigKeysTab`;
the products badge list → `ConfigProductsTab`; the avatars badge list → `ConfigAvatarsTab`).
Each component owns its own data fetching for now (simplest: each calls `useApiResource`
against `GET /api/clients/{clientId}` independently and reads the slice it needs — some
duplicate fetching across tabs is an acceptable, deliberate tradeoff here in exchange for
each file being fully independent; do not try to share one fetch across all four via context
or prop-drilling). `config/page.tsx` itself just fetches the client's `display_name` for the
header, renders the back-link, and wires up `<Tabs><TabsList>...four triggers...</TabsList>
<TabsContent value="brand"><ConfigBrandTab clientId={clientId} /></TabsContent>...</Tabs>`.

The specific new fields/actions added to `ConfigBrandTab`/`ConfigProductsTab` (logo upload,
brand colors/fonts, product-add form) are specified in section 7.5. Clone-from lives on the
clients list page, not here (also section 7.5). `ConfigAvatarsTab`'s CRUD upgrade is
specified in section 8.2. `ConfigKeysTab` gets no new capability in this pass — move its
existing content as-is. Header: "Config" as a small eyebrow label above the client's
`display_name`, and a link back to `routes.client(clientId)` (styled as a back-link, e.g.
"← {display_name}").

### 2.5 Reel creation moves — `app/(app)/clients/[clientId]/reels/new/page.tsx` (new)

Move `app/(app)/reels/new/page.tsx`'s content here, then delete the old file and its now-empty
`app/(app)/reels/new/` directory. Read `clientId` from the route's `params` (the same
`params: Promise<{...}>` + `use()` pattern already used in `clients/[clientId]/page.tsx` and
`scene/page.tsx`) instead of `useSearchParams().get("client_id")` — this also means you can
delete the `Suspense`-wrapped-for-`useSearchParams` structure and the "Missing ?client_id="
error state, since the id is now guaranteed by the route itself. The slider/avatar-picker/
Higgsfield-hiding changes to this page are specified in section 3.2 below — do the file-move
and param-source change here.

### 2.6 Reel-stage stepper shell — `app/(app)/reels/[reelId]/layout.tsx` (new)

```tsx
"use client";
```

Fetches `GET /api/reels/{reelId}` once via `useApiResource` (this endpoint already returns
`{ reel, reel_config }` per the existing route). Derive:

- `STAGE_ORDER` — import from `@/src/stages/types` (already exists: `["reel_setup", "scene",
  "image", "clip", "trim", "outro", "music", "assembly"]`).
- `reachedIndex = STAGE_ORDER.indexOf(reel.current_stage)`.
- `currentIndex` — derive from `usePathname()`: the path is `/reels/{reelId}/{stage}`, so
  match the last path segment against `STAGE_ORDER`. (`reel_setup` has no page under this
  layout — reel creation lives at `routes.newReel(clientId)`, outside this layout entirely —
  so `currentIndex` here only ever resolves to indices 1-7; index 0 is handled by the
  creation page having its own lightweight, non-interactive step indicator, see 2.7.)

Render, in order: the `ProgressSteps` component (steps built from `STAGE_ORDER.slice(1)` —
i.e. `scene` through `assembly`, 7 entries, since `reel_setup` isn't a page under this
layout — each step's `href` is `routes.reelStage(reelId, stage)` when
`STAGE_ORDER.indexOf(stage) <= reachedIndex`, else `null`); a Previous/Next control row; then
`{children}`.

**Previous**: always rendered. If `currentIndex === 1` (viewing `scene`, the first page under
this layout), Previous links to `routes.client(reel.client_id)` (there is no reel-setup edit
page in this pass — treat reel setup as a one-time creation step, not independently
revisitable; label this Previous button "← Back to {client display name}" in that specific
case). Otherwise Previous links to `routes.reelStage(reelId, STAGE_ORDER[currentIndex - 1])`.

**Next**: enabled (rendered as a `Link`/`Button`) only when
`STAGE_ORDER.indexOf(STAGE_ORDER[currentIndex + 1]) <= reachedIndex` — i.e. the next stage
has already been reached. When the next stage has NOT yet been reached, render Next as a
disabled-looking button (not a link) with a tooltip-less inline caption underneath like
"Complete this stage to continue" (`text-xs text-muted-foreground`) — never hide it entirely,
per the "next-stage CTA must never be hard to notice" requirement; a disabled-but-visible
button communicates "there's a next step, you're not there yet" better than an absent one.
When `currentIndex === STAGE_ORDER.length - 1` (viewing `assembly`, the last stage), Next
does not render at all (there is nothing after it).

Give the whole Previous/Next row strong visual weight — this is explicitly the most-called-out
navigation complaint in the source plan (buttons must never be easy to miss). Use `size="lg"`
on both, Next as the `primary` button variant, Previous as `outline`.

### 2.7 Wiring `advance()`

Every stage module already implements `advance(ctx): Promise<StageId>` (moves
`reels.current_stage` forward) and it is currently never called from anywhere. Add:

**New `app/api/reels/[reelId]/advance/route.ts`**, `POST`, no body:

```ts
import { NextRequest, NextResponse } from "next/server";
import { buildStageContext } from "@/src/lib/context";
import { sceneStage } from "@/src/stages/scene";
import { imageStage } from "@/src/stages/image"; // adjust names to match each module's actual export
// ...import each stage module's exported StageModule the same way it's already imported
// elsewhere (e.g. app/api/reels/[reelId]/scene/route.ts imports `sceneStage` — copy that
// import style for each of scene/image/clip/trim/outro/music/assembly). reel_setup has no
// StageModule (it's handled separately per src/stages/reel-setup) and is never the current
// stage by the time this route is reachable (a reel is created with current_stage='scene').

const STAGE_MODULES: Record<string, { advance(ctx: unknown): Promise<string> }> = {
  scene: sceneStage,
  image: imageStage,
  // ...clip, trim, outro, music, assembly
};

export async function POST(_req: NextRequest, { params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  const ctx = await buildStageContext(reelId);
  const mod = STAGE_MODULES[ctx.reel?.current_stage ?? ""]; // fetch current_stage from the reel row first if ctx doesn't already carry it — check buildStageContext's return shape and adapt
  // ... call mod.advance(ctx), return { current_stage: <new stage> }
}
```

Read `src/lib/context.ts` and each stage's route handler first to get the exact import names
and context shape right — the sketch above is illustrative, not literal; match this repo's
actual exports. Do not add any new validation/gating logic inside the stage modules'
existing `advance()` implementations themselves — call them exactly as they are.

**Wire the "Next" button**: when Next is enabled (per 2.6) and the user clicks it, if
`currentIndex === reachedIndex` (i.e. clicking Next would move into genuinely new territory),
first `POST` to `/api/reels/{reelId}/advance`, then navigate. If `currentIndex < reachedIndex`
(user is revisiting an earlier-than-furthest stage and clicking Next just to move forward
through already-reached stages), skip the advance call and navigate directly — advancing
should only fire once per stage transition, not on every forward click.

---

## 3. Scene stage rebuild + reel setup enhancements

### 3.1 Scene page rewrite — `app/(app)/reels/[reelId]/scene/page.tsx`

This fixes the data-loss "Save" bug. The current page is read-only display; this is a full
rewrite to real inline editing.

**State**: `const [scenes, setScenes] = useState<SceneRow[]>([])`, initialized from the GET
response and kept as the single source of truth for the editable table. Each scene object in
this array must retain its original `id` field for every scene that came from the server —
**never regenerate or drop an existing scene's `id`**, even when only one field on that scene
changes. This is the exact contract `src/stages/scene/index.ts`'s `process()` depends on:
delete-by-omission means any existing scene whose `id` is missing from the submitted array
gets deleted (and cascades: `prompts` for that scene are hard-deleted, its generated
`assets` are orphaned) — so the submitted array must always contain every currently-visible
scene, existing ones keyed by their real `id`, only brand-new scenes omitting `id`.

**Per-row editable fields** (each a plain controlled input/select bound to that scene's index
in local state, updating via `setScenes(prev => prev.map((s, i) => i === idx ? {...s, field:
value} : s))`):
- `type` — `Select` with options `avatar`/`broll`, rendered **only if** the reel's
  `avatar_enabled` is true (fetch `reel_config.avatar_enabled` via `GET
  /api/reels/{reelId}` — call `useApiResource` a second time for this, or thread it down if
  the layout already fetched it and can pass it via context/prop; simplest is a second
  `useApiResource` call in this page, duplication here is acceptable). If `avatar_enabled` is
  false, don't render the field at all and force `type: "broll"` when building each row.
- `seconds` — plain number input (`type="number" min={1} step={0.5}`), not the Slider —
  per-scene duration doesn't have the same friction complaint as the top-level reel-length
  input; keep it simple and consistent with other numeric fields on this page.
- `description` — `Textarea` (existing component), multi-line.
- `transition_to_next` — `Select`, options `continuous`/`hard_cut`, **disabled** (rendered
  but not interactive, showing the forced value) when `type === "avatar"` or the scene is the
  last one in the list (matches the backend's `enforceRules`, which forces these regardless
  of what's submitted — don't let the UI imply a choice that doesn't exist).
- Do **not** add a `broll_provider_override` control in this pass — with Higgsfield hidden
  (section 3.2) there is currently only one visible b-roll provider, so overriding to a
  different one is not a meaningful UI action yet. Leave that field untouched (always sent as
  whatever it already was, typically `null`) rather than building a single-option dropdown.
  Note this simplification in `.pipeline/changes.md`.

**Row actions**: an "Add scene" button (appends `{ position: scenes.length, type: "broll",
seconds: 5, transition_to_next: null, description: "" }`, no `id`, to the end of the array —
renumber all `position` values to match array index after any add/delete/reorder, since
`position` must stay contiguous); a delete button per row (removes that index, then
renumbers `position` for the rest); up/down move buttons per row (swap with the
adjacent element, then renumber `position`) — no drag-and-drop library, keep it to simple
buttons.

**Save** button: always visible once at least one scene exists. On click, `POST` to
`/api/reels/{reelId}/scene` with body `{ scenes: <local state array, each entry limited to
the fields sceneEntrySchema accepts: id?, position, type, product_in_scene?, seconds,
transition_to_next, broll_provider_override, description> }` — **never** include
`regenerate: true` here, and do not omit `scenes`. This is the entire fix: a save that only
saves.

**"Re-run scene-brain"** button: separate, visually secondary (`variant="outline"`), and
wrapped in an `AlertDialog` confirmation ("This replaces every scene below with a freshly
generated list — any edits you've made will be lost. Continue?" / Cancel / "Regenerate"
using the destructive-ish button styling since it's data-losing). Only on confirm does it
`POST` `{ regenerate: true }` (no `scenes` field).

**Initial empty state**: when the GET response has zero scenes (brand-new reel), render only
a single prominent "Generate scenes" primary action (calls the same regenerate flow) instead
of an empty editable table — the full editing UI (table + Save + Re-run) only appears once at
least one scene exists.

Keep the existing downgraded-to-`hard_cut` badge logic (from `hints`), adapted to render
per-row in the new editable layout instead of the old read-only cards.

This page lives under the section 2.6 layout now — remove its own inline "Stage 3 — Scenes"
header and the ad hoc "Images →" link entirely; the shared layout's `ProgressSteps` +
Previous/Next replace them.

### 3.2 New regression test — `src/stages/scene/index.test.ts` (new file)

Follow this repo's existing direct-injection test convention (see
`src/lib/reviewAction.test.ts` for the pattern of passing fakes straight to the function
under test, and `src/testUtils/fakeSupabase.ts` for the in-memory Supabase fake). Two cases:

1. Seed a fake reel_config + one existing scene. Build a `StageContext`-shaped object using
   the fake Supabase client and real, synchronous factories for `costEngine`/`jobs`/
   `storage`/`keys`/`adapters` where those are needed by the function's type signature (check
   what `process()` actually touches — it may not need all of `StageContext`, only build what
   compiles). Set `skills.sceneBrain = vi.fn().mockRejectedValue(new Error("must not be
   called"))`. Call `sceneStage.process({ regenerate: false, scenes: [<the existing scene,
   with one field changed, id preserved>] }, ctx)`. Assert `skills.sceneBrain` was never
   called, and that the fake table's row reflects the edited field, not the original.
2. Same setup, call `process({ regenerate: true }, ctx)` (no `scenes`). Assert
   `sceneBrain` **was** called once. This pins both branches of the
   `if (input.regenerate || !desired)` condition so a future edit can't silently reintroduce
   the bug.

### 3.3 Reel-setup page enhancements — `app/(app)/clients/[clientId]/reels/new/page.tsx`

(Continuing from the file move in section 2.5.)

**Seconds slider**: replace the numeric `total_seconds` input with the new `Slider`:
`min={6} max={180} step={1}`, `defaultValue={[30]}`. Show the live value next to it as text
(e.g. `"{value}s"`, updating on `onValueChange`). This range is a product default (no backend
maximum exists — the field is just `z.number().positive()`), trivially adjustable later; do
not add backend validation for these bounds.

**Avatar picker**: when the avatar `Switch` (replaces the current raw checkbox) is on, fetch
the client's avatars (`GET /api/clients/{clientId}` already returns `avatars: Array<{ id,
name, preview_image_url }>` — reuse that shape) and render them as a row of selectable
preview cards: each card shows the `preview_image_url` (an `<img>`, with a plain
placeholder box + the avatar's `name` when the URL is null) and the `name`, single-select
(clicking one sets `avatar_look_id` in local state and visually highlights the selected
card with a `ring-2 ring-primary`). If the client has zero avatars, show inline text "No
avatars configured yet." with a `Link` to `routes.clientConfig(clientId)`, and disable the
submit button while avatar mode is on and no avatar is selected (client-side guard only —
the backend's existing validation is the real backstop).

**B-roll provider — remove the dropdown**: delete the `<select>` for `brollProvider`
entirely (Higgsfield must not be selectable anywhere). Behavior: when the avatar `Switch` is
**off**, always send `broll_provider: "veo"` with no UI control shown (there is currently
only one visible b-roll model, no choice to present). When the avatar `Switch` is **on**, show
a small `Switch` labeled "Include b-roll scenes (Veo)" defaulting to checked; when the user
turns it off, send `broll_provider: undefined` (all-avatar reel), matching the existing
validation's allowance for that combination.

**CapabilityGuard wiring**: this requires a small, additive backend change so violations are
structured on the failure path too (today only success responses carry a structured
`validation` object; a failed `validateReelSetup` currently surfaces as a flat error
string). In `src/stages/reel-setup/index.ts`:

```ts
export class ReelSetupValidationError extends Error {
  constructor(public validation: ValidationResult) {
    super(validation.violations.join("; "));
  }
}
```

In `processReelSetup`, replace `throw new Error(...)` on `!validation.ok` with
`throw new ReelSetupValidationError(validation)`. In `app/api/reels/route.ts`'s `POST`
catch block, check `if (err instanceof ReelSetupValidationError)` first and return
`NextResponse.json({ error: err.message, validation: err.validation }, { status: 400 })`;
keep the existing generic fallback for any other error type.

On the frontend: after any submit attempt (success — `res.ok` with a `validation` field in
the body — or the new structured 400), if the response includes a `validation` object, render
`<CapabilityGuard validation={validation} />` (no `children` needed — it's being used purely
for its violations/warnings display here, not to gate a nested action) below the form, above
the submit button. On a successful create you'll show it briefly with only warnings present
(since creation only proceeds when there are zero violations) right before navigating away —
that's fine, it's still useful information (e.g. "no b-roll model selected — this will be an
all-avatar reel").

**Header**: remove the old page's `<h1>` — this page now renders under a lightweight,
non-interactive version of the stepper (reuse `ProgressSteps` with `currentIndex={0}`,
`reachedIndex={0}`, and every step's `href` set to `null` — since there's no `reelId` yet,
nothing is clickable, this is purely the visual "step 1 of 8" orientation cue). On successful
creation, `router.push(routes.reelStage(newReelId, "scene"))`, unchanged from today.

---

## 4. Image stage polish — `app/(app)/reels/[reelId]/image/page.tsx`, `app/components/AssetReview.tsx`

**Aspect-ratio-aware preview**: `AssetReview.tsx` currently hardcodes `aspect-video` (16:9)
on the preview container (~line 70). Add a new prop `aspectRatio?: "9:16" | "1:1" | "16:9"`
(default to `"16:9"` if omitted, preserving current behavior for any caller that doesn't pass
it) and map it to a Tailwind aspect class (`"9:16"` → `aspect-[9/16]`, `"1:1"` →
`aspect-square`, `"16:9"` → `aspect-video`). In `image/page.tsx`, fetch the reel's
`aspect_ratio` via a second `useApiResource("/api/reels/{reelId}")` call (or lift it if a
shared layout context already exposes it — check whether section 2.6's layout provides any
React context; if not, an extra fetch here is fine) and pass it to every `AssetReview`
instance on the page.

**Cost confirmation**: add a `costUsd?: number` prop to `AssetReviewProps`. When present and
`> 0`, wrap the "Redo" button's click handler: instead of calling `handleRedo` directly,
open an `AlertDialog` ("Regenerate this image for ${costUsd.toFixed(2)}?") and only call
`handleRedo` from the dialog's confirm action. When `costUsd` is `0`/undefined, keep today's
immediate-redo behavior unchanged (no dialog for free actions — don't add friction where
there's no cost). Also render the amount inline on the button itself when nonzero: `"Redo ·
${costUsd.toFixed(2)}"` vs plain `"Redo"`. In `image/page.tsx`, compute each slot's per-item
cost from the page's existing `estimate.lines` (if the estimate response includes a per-line
breakdown — check its actual shape; if it's only a `total_usd` with no per-line detail, pass
$0.039 as a reasonable constant for Nano Banana image redos rather than leaving `costUsd`
unset, since the real per-image rate is fixed and known) and pass it to each `AssetReview`.

Wrap the page's "Generate missing images" button the same way: `AlertDialog` showing the
current `CostEstimateBar` total before calling the existing generate handler, when that total
is nonzero.

Move this page under the section 2.6 shared layout: remove its own `<h1>`/back/forward
`Link`s (the "← Scene" / "Clip →" text links, including the dead one) — the shared layout's
stepper and Previous/Next fully replace them.

---

## 5. Clip stage — new page

### 5.1 Enrich the GET — `app/api/reels/[reelId]/clip/route.ts`

Today's GET returns only `{ stage, data: { scenes } }` (bare). Read
`app/api/reels/[reelId]/image/route.ts`'s GET handler in full — it already enriches each
slot with asset/prompt/preview_url/history (a `buildSlotDetail`-shaped helper or inline
logic; read it to see exactly how it's built, including how it gets a signed `preview_url`
via the storage client). Replicate the same enrichment for Clip's GET, except simpler: each
scene has exactly **one** clip asset and **one** motion/shot prompt (not a start/end pair
like Image), so the response shape becomes:

```ts
{
  stage: "clip",
  data: { scenes: SceneRow[] },
  slots: Record<string /* scene_id */, {
    asset_id: string; media_type: "video";
    current_version_id: string | null; current_version_no: number;
    preview_url: string | null; history: VersionSummary[];
    prompt: { id: string; text: string; version_no: number; history: VersionSummary[] } | null;
  } | undefined>,
  estimate: CostEstimate,
}
```

Include `estimate` inline (call the same cost-estimate logic `clip/estimate/route.ts` already
exposes as a separate endpoint — either import and call its underlying function directly, or
`fetch`-equivalent server-side reuse; do not duplicate the pricing logic).

### 5.2 Build `app/(app)/reels/[reelId]/clip/page.tsx`

Mirror `image/page.tsx`'s structure closely: header removed (shared layout), a
`CostEstimateBar`, a "Generate missing clips" button (`AlertDialog`-wrapped per section 4's
pattern when nonzero) POSTing to `/api/reels/{reelId}/clip` with `{}` (all scenes) per the
existing route's documented `{ scene_ids?: uuid[] }` body (omit for "all"). Then, for each
scene in `position` order, a `Card`: scene number + description in the header; for
**avatar**-type scenes, a small read-only line showing which avatar look is in use (look up
the name from the reel's `avatar_look_id` against the client's avatars list — fetch via
`GET /api/clients/{clientId}`) and, if `product_in_scene`, a "uses product photos as
reference" badge; then **one** `AssetReview` + `PromptReview` pair (not two — unlike Image,
Clip has a single slot per scene) bound to `reviewEndpoint =
/api/reels/{reelId}/clip/review`, using the enriched `slots[scene.id]` data from 5.1.

**Avatar-clip cost is $7 flat** — pass `costUsd={7}` explicitly to every avatar-scene's
`AssetReview` (don't try to derive it from the estimate response for these; HeyGen's price is
a known constant per the adapter). For b-roll scenes, pass whatever the estimate response's
per-scene line shows (Veo's cost varies by duration/variant — use the real computed value,
not a guess).

---

## 6. Trim stage — new page + new route

### 6.1 New route — `app/api/reels/[reelId]/trim/review/route.ts`

`src/stages/trim/index.ts` already implements `redoAsset`/`revertAsset`/`download`/`history`
on its `ReviewHooks` — they're just unreachable (no route). Create this route mirroring
`app/api/reels/[reelId]/clip/review/route.ts`'s exact shape (same dispatch to
`src/lib/reviewAction.ts`'s handler, same request/response contract), pointed at
`trimStage.review` instead of the clip stage's. Do not add prompt-action support — Trim's
`redoPrompt`/`editPrompt`/`revertPrompt` deliberately throw ("trim has no prompts"); if
`reviewAction.ts`'s dispatcher requires all seven hook methods to be present to type-check,
that's already handled by the trim stage module providing throwing stubs for the prompt
methods — don't change that.

### 6.2 Build `app/(app)/reels/[reelId]/trim/page.tsx`

For each scene: video preview of the current clip (reuse `AssetReview` in a read-only-ish
mode, or a plain `<video>` tag with controls if `AssetReview`'s redo/prompt affordances don't
make sense here — Trim has no prompt and redo means "regenerate the underlying clip," which
IS still valid to expose via the same component pointed at `/clip/review`, but the PRIMARY
action on this page is trimming, not redoing; use `AssetReview` bound to `/trim/review` so
its Download/History/Revert affordances work, and accept that its "Redo" button here calls
`trim`'s `redoAsset` which — check what that actually does for a `trim`-slot asset before
assuming; if it doesn't make sense for this asset type, read the module and adjust rather
than guessing). Below the preview: two `Slider`s (or a dual-handle range if you build one —
a simpler two-single-sliders layout is acceptable) for `start_s`/`end_s`, bounded
`[0, duration_s]` where `duration_s` comes from the current version's
`metadata.duration_s` (already persisted by the generating adapter). A "Trim" button POSTs
`{ asset_id, start_s, end_s }` to `/api/reels/{reelId}/trim` (all three fields required per
the existing route). Reordering: up/down move buttons per scene (same pattern as section
3.1), calling `POST /api/reels/{reelId}/trim/reorder` with `{ scene_ids: <full reordered
array> }` on each move (or batch behind a "Save order" button if that reads more naturally —
either is acceptable, pick one and be consistent). Surface the GET response's `hints` (shared
-boundary-frame warnings) as inline badges using the same visual pattern as Scene's
downgraded-to-hard-cut badges.

---

## 7. Upload infrastructure + Outro, Music, Config uploads

### 7.1 Generic upload endpoint — `app/api/clients/[clientId]/uploads/route.ts` (new)

`POST`, `multipart/form-data` with fields `file` (the binary) and `kind`
(`"logo" | "product_photo" | "music" | "end_frame"`), plus `reel_id` (required only for
`"music"`/`"end_frame"`, since those are reel-scoped). Use the existing
`createStorageClient`/`createServiceClient` pattern (same as every other route in this app —
read `src/lib/context.ts`'s `buildConfigContext` for the client-scoped pattern). Derive the
bucket + path using the **already-existing** helpers in `src/lib/storage/index.ts` — do not
invent a new path scheme:

- `kind: "logo"` → bucket `"brand"`, path `buildClientPath({ client_id: clientId, category:
  "logo", file_id: crypto.randomUUID(), ext })`.
- `kind: "product_photo"` → bucket `"products"`, path `buildClientPath({ client_id: clientId,
  category: "products", file_id: crypto.randomUUID(), ext })`.
- `kind: "music"` → bucket `"music"`, path `buildClientPath({ client_id: clientId, category:
  \`reels/${reelId}/music\`, file_id: crypto.randomUUID(), ext })`.
- `kind: "end_frame"` → bucket `"assets"`, path `buildGeneratedPath({ client_id: clientId,
  reel_id: reelId, idempotency_key: crypto.randomUUID(), ext })`.

Derive `ext` from the uploaded file's name/mime type. Return `{ storage_path: string }`.
Validate `kind` is one of the four values and reject anything else with 400. This route sits
behind Phase 0's middleware like everything else — no extra auth logic needed here.

### 7.2 Client hook — `app/hooks/useFileUpload.ts` (new)

```ts
export function useFileUpload(clientId: string): {
  upload: (file: File, kind: "logo" | "product_photo" | "music" | "end_frame", reelId?: string) => Promise<string>; // resolves storage_path
  uploading: boolean;
  error: string | null;
}
```

Builds a `FormData`, POSTs to `/api/clients/{clientId}/uploads`, returns the resulting
`storage_path`.

### 7.3 Outro page — `app/(app)/reels/[reelId]/outro/page.tsx` (new)

Dual-slot layout, same visual pattern as Image's start/end split (side-by-side on wide
viewports, stacked on narrow). **Slot 1 — end-frame image**: `AssetReview` only (no
`PromptReview` — the default branded end-frame is a deterministic render, not
AI-prompted, so it has no prompt to edit), bound to `/api/reels/{reelId}/outro/review`; below
it, a tagline text `Input` (defaults from the current `reel_config.outro_tagline` or the
client's `default_tagline`, editable, with a "Save tagline" button posting `{ outro_tagline }`
to `/api/reels/{reelId}/outro`); a file input using `useFileUpload(clientId)` with
`kind="end_frame"`, `reelId` — on successful upload, POST `{ custom_end_frame_storage_path:
storage_path }` to `/api/reels/{reelId}/outro`; a "Return to default" `Button` (only shown
when `end_frame_mode === "custom"`) posting `{ return_to_default: true }`. **Slot 2 — outro
clip**: `AssetReview` + `PromptReview` pair (this one has a real motion prompt), bound to the
same `/outro/review` endpoint, distinguished from slot 1 by which `assetId`/`promptId` you
pass (per the existing route's dispatch-by-id design — read
`app/api/reels/[reelId]/outro/review/route.ts` to confirm exactly how it tells the two slots
apart). `CostEstimateBar` from `/api/reels/{reelId}/outro/estimate`. Wrap the same
cost-confirmation pattern from section 4 on both slots' redo actions.

### 7.4 Music page — `app/(app)/reels/[reelId]/music/page.tsx` (new)

No `AssetReview`/`PromptReview` (Music has no `ReviewHooks` — confirmed nothing to wire
here). A file input using `useFileUpload(clientId)` with `kind="music"`, `reelId` — on
success, POST `{ music_storage_path: storage_path }` to `/api/reels/{reelId}/music`. Below
it, once a track exists, an HTML5 `<audio controls src={signedUrlFromGET} />` for preview,
and two number inputs (not Sliders — bounds come from the browser at runtime via the
`<audio>` element's `loadedmetadata` event giving `duration`, which arrives asynchronously
after the file loads; a Slider needs a known max up front, so plain bounded number inputs
that clamp against the now-known duration are simpler here) for `start_s`/`end_s`. A "Save
trim" button POSTs `{ music_trim: { start_s, end_s } }` to `/api/reels/{reelId}/music`. Add a
clearly visible informational line (not a form control): "Fade-in/out and looping to fill the
reel's length are applied automatically during assembly." — do not build fake fade/loop
controls; the backend doesn't support them and building UI for them would be misleading.

### 7.5 Config page additions

You are editing `app/components/config/ConfigBrandTab.tsx` and
`app/components/config/ConfigProductsTab.tsx` (created by section 2.4 — read them as they
exist now, do not recreate `config/page.tsx` or touch `ConfigKeysTab.tsx`/
`ConfigAvatarsTab.tsx`, which section 8 owns):

- **`ConfigBrandTab`**: add fields for `brand_colors`, `fonts` (both `jsonb` — keep these as simple
  free-text/JSON `Textarea` inputs for now, this app has no color-picker/font-picker built
  anywhere and inventing one is out of scope; parse-on-submit with a try/catch showing a
  validation error if the JSON is malformed), `default_aspect_ratio`/`default_resolution`
  (`Select`s using the existing `ASPECT_RATIOS`/`RESOLUTIONS` constants). Add a logo upload
  control using `useFileUpload(clientId)` with `kind="logo"` (no `reelId`) — on success,
  include the resulting `storage_path` as `brand_kit.logo_path` in the existing PATCH call.
  Show the current logo (if `logo_path` is set — fetch a signed URL for it; check whether the
  client GET response already includes a signed logo URL, and if not, whether there's a
  reusable helper to get one, before adding new plumbing) above the upload control.
- **`ConfigProductsTab`**: add a small inline form (name + optional `product_link`) with an "Add
  product" button, `POST`ing `{ products: [{ name, product_link }] }` to the existing
  `PATCH /api/clients/{clientId}` (confirm the existing handler appends rather than replaces
  the product list — per `src/stages/config/index.ts`'s `insertProducts`, it does a plain
  insert, so this is additive and safe). Keep the existing read-only product badge list below
  the form, refetching after a successful add.

You are also editing `app/(app)/clients/page.tsx` for clone-from (cloning creates a **new**
client, so it belongs where clients are created, not in Config): add a
  `Select` of existing clients + a "Clone" button next to the existing "New client" form,
  POSTing `{ clone_from: <selected id>, display_name: <a required new-name input> }` to
  `POST /api/clients` (confirm this route already forwards `clone_from` through to
  `processConfig` — read `app/api/clients/route.ts` first; if it currently only accepts
  `display_name`, extend its zod schema to also accept an optional `clone_from` field and
  pass it through).

Do not touch `ConfigAvatarsTab.tsx` or `ConfigKeysTab.tsx` — section 8 owns the former, the
latter gets no changes in this pass.

---

## 8. Assembly page + avatar management

### 8.1 Assembly page — `app/(app)/reels/[reelId]/assembly/page.tsx` (new)

A "Start assembly" primary `Button` POSTing `{}` to `/api/reels/{reelId}/assembly` (existing
route already returns `{ job, plan }`). After starting (or on initial load if a render is
already in flight), poll `GET /api/reels/{reelId}/assembly` every 3 seconds using a simple
`useEffect` + `setInterval` (clear it on unmount, and stop polling once a terminal state is
reached — don't poll forever) — this endpoint returns `{ stage, data: { reel }, final_render
}`. Derive displayed state from `reel.status` (`draft|in_progress|assembled|archived`) and
`final_render`'s presence: no `final_render` + status not `assembled` → "Processing…" with a
`Skeleton`/spinner-ish indicator; `final_render` present → show a `<video controls>` preview
of its signed URL plus the existing `DownloadButton` component; if the poll ever surfaces an
error state from the underlying job (check what the response actually exposes for a failed
assembly job — there may be nothing today beyond the reel not reaching `assembled`; if so,
just show "Still processing" indefinitely rather than fabricating a failure UI the backend
can't actually report). A "Re-assemble" button (same POST) is available once a
`final_render` already exists, for re-running after upstream changes.

This is the last stage — no "Next" control from section 2.6 applies here (already specified
to not render past the last stage).

### 8.2 Avatar management — new routes + Config UI

**New `app/api/clients/[clientId]/avatars/[avatarId]/route.ts`**: `PATCH` (body `{ name:
string }`, updates just the name) and `DELETE` (removes the avatar row). Add the two
corresponding functions in a **new file**, `src/stages/config/avatars.ts` — do not add them
to `src/stages/config/index.ts` itself, so this section never touches a file section 7 might
be editing concurrently. Match the exact same `ServiceClient`-based upsert/delete pattern
already used for every mutation in `src/stages/config/index.ts` (read that file first for the
convention, just don't edit it). Both operations are simple single-row updates scoped by
`client_id` + `id` — no cascading concerns (an avatar being deleted doesn't need to touch
`reel_config.avatar_look_id` rows that reference it; leave a dangling FK reference exactly as
`ON DELETE` behavior on that column already dictates — check the migration, don't add new
constraint-handling logic).

You are editing `app/components/config/ConfigAvatarsTab.tsx` (created by section 2.4 — read
it as it exists now; do not touch `ConfigBrandTab.tsx`/`ConfigKeysTab.tsx`/
`ConfigProductsTab.tsx`, which section 7 owns, and do not recreate `config/page.tsx`).
Replace the current plain
`Badge`-per-avatar list with real preview cards: each shows `preview_image_url` (placeholder
box if null) and `name`; a small pencil/edit affordance turns the name into an inline text
input with Save/Cancel, calling the new `PATCH` route; a remove affordance opens an
`AlertDialog` ("Remove {name}? Reels already using this avatar keep working, but it won't be
selectable for new ones." / Cancel / destructive-styled "Remove") calling the new `DELETE`
route on confirm. No new "add avatar" control is needed here — avatars are still populated
via the existing HeyGen key → `avatar_pull` job flow; this tab only adds rename/remove/browse
on top of what's already pulled.

---

## Do not do

- Do not touch anything under `src/adapters/**`, `src/skills/**`, `worker/**`, or any
  `supabase/migrations/**` file beyond what's explicitly listed above (the upload endpoint
  and avatar routes are additive `app/api/**` + small `src/stages/config/index.ts` additions
  only).
- Do not add Higgsfield back to any dropdown or selector.
- Do not build multi-avatar-per-reel selection (`reel_config.avatar_look_id` stays a single
  value in this pass).
- Do not add automated component/RTL tests — this codebase has no jsdom/testing-library
  installed and none should be added in this pass; the one new test is the plain
  Vitest-on-`src/**` regression test in section 3.2.

## Before finishing

Run `npx tsc --noEmit` and resolve everything. Then write `.pipeline/changes.md` per your
standing instructions: list every file created/changed, grouped by the section numbers above
(1 through 8), and flag anything you deviated from this spec on and why (a deviation is fine
when the actual code you found didn't match this spec's assumptions — say so explicitly
rather than silently improvising) — the Tester and Reviewer both need that list to know where
to look first.
