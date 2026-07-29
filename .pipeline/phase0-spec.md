# Spec — V2 Phase 0: Security &amp; correctness guardrails (branch `v1`)

Source of truth for this phase: `.pipeline/v2-plan.md` (the full V2 plan) §03 and §09 Phase 0.
This phase is backend/security-only — no visual or navigation change. It implements every
outstanding item from the prior code review (`.pipeline/review.md`), which the project owner
has designated mandatory. All eleven items below were independently re-verified against
current code earlier in this session; none have been fixed yet.

No open questions — every judgment call below (SSRF allowlist shape, HeyGen budget
combination rule, retry semantics) is decided explicitly so you do not have to guess.

---

## 1. Session auth (BLOCK-1)

Currently every `/api/**` route is reachable with zero authentication, via context builders
that call `createServiceClient()` (bypasses RLS by design — that part is correct and must
stay: service-role is for the actual stage/adapter writes, per `src/lib/context.ts`). The
missing piece is a gate *before* any handler is reached. `src/lib/supabase/server.ts`
already exports an async `createClient()` that reads the session from cookies via
`@supabase/ssr` — it already exists and is already documented for exactly this purpose, but
has zero call sites today. Use it.

**Create `middleware.ts`** at the repo root (same level as `next.config.ts`):

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  const isWebhook = pathname.startsWith("/api/webhooks/");
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth/");
  if (isWebhook || isAuthRoute) return response;

  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

**Create `app/login/page.tsx`** (client component). Email input + "Send magic link" button,
using the existing `Input`/`Button`/`Label`/`Card` components from `app/components/ui/*`
(copy the form-state pattern from `app/(app)/clients/page.tsx`: local `useState` for the
field, a `busy`/`error` pair, a submit handler). On submit, call the **browser** client from
`src/lib/supabase/browser.ts`:

```ts
await supabase.auth.signInWithOtp({
  email,
  options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
});
```

where `next` is read from `useSearchParams().get("next") ?? "/clients"`. Wrap in `Suspense`
the same way `app/(app)/reels/new/page.tsx` already does for `useSearchParams`. After a
successful call, replace the form with a "Check your email for a sign-in link" message —
do not attempt to detect the click, the callback route handles that.

**Create `app/auth/callback/route.ts`**:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/src/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/clients";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
```

**Create `app/auth/signout/route.ts`** (`POST`): build the server client, call
`supabase.auth.signOut()`, redirect to `/login`. No UI wiring in this phase — a later phase
wires a sign-out control into the nav shell; this route just needs to exist and work when
POSTed to directly.

Do not touch `src/lib/context.ts`, any `app/api/**/route.ts` handler bodies, or any existing
page under `app/(app)/**` for this item — the middleware is the entire gate. Do not add a
`requireSession()` helper; the middleware covers every route uniformly.

---

## 2. Stop leaking `callback_token`, and allowlist the webhook download host (BLOCK-2)

`Job` (`src/lib/jobs/queue.ts`) includes `callback_token` and `payload`. Three review-hook
`redoAsset` implementations return the raw job row, which their route handlers then
`NextResponse.json()` verbatim:

- `src/stages/clip/index.ts` (`redoAsset`, returns `{ job: outcome.job }`)
- `src/stages/outro/index.ts` (two `redoAsset` return sites — end-frame and outro-clip)
- `src/stages/trim/index.ts` (`redoAsset` and `revertAsset` — check both)

In each case, before returning, narrow the job object to
`{ id: job.id, status: job.status, type: job.type, provider_job_id: job.provider_job_id }` —
never pass through `callback_token` or `payload`. Do this at the point each hook builds its
return value (not by editing the route handlers, so every caller is covered uniformly).

**SSRF fix**, `app/api/webhooks/heygen/route.ts` (around the `fetch(parsed.asset.url)` call
that downloads the completed video): before fetching, validate the URL:

```ts
const ALLOWED_HEYGEN_HOSTS = [/(^|\.)heygen\.com$/i, /(^|\.)amazonaws\.com$/i];

function isAllowedDownloadUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:") return false;
  return ALLOWED_HEYGEN_HOSTS.some((re) => re.test(url.hostname));
}
```

If the check fails, do not fetch — fail the job with a clear error message instead
(`"heygen webhook: refusing to download from disallowed host <hostname>"`). Note in
`.pipeline/changes.md` that the exact HeyGen CDN hostname should be confirmed and the
allowlist tightened at integration time — `amazonaws.com` is included because HeyGen's
rendered-video URLs are commonly S3-backed, but this is a defensive default, not a verified
fact.

---

## 3. Reconcile failure path must not burn the idempotency key or fatally misroute the job (N1)

`worker/reconcile.ts`, the `catch` block around the provider-poll/download/upload logic
(roughly lines 123-140 as of the last review — re-locate by reading the file, the shape is
unique). Today, on **any** thrown error (429/5xx from the provider, a Storage upload
failure, a DB hiccup), it logs a `failed_unbilled` cost row using `job.idempotency_key` and
calls `jobs.fail(job.id, message)` with retry defaulted on, which moves the job to status
`queued` — a status that `worker/index.ts`'s claim loop deliberately treats as an
unreachable/fatal state for this job type ("reached the main claim loop unexpectedly").

Fix: on a caught error in this path, treat it as **transient** by default —

1. Do **not** call `costEngine.log(...)` / write a `failed_unbilled` row using the
   generation's real `idempotency_key` in this catch block. If reconcile.ts needs to log
   something for observability, use a key that cannot collide with the real generation's
   key (e.g. suffix it, or omit `idempotency_key` from that log entry entirely).
2. Re-arm the job for another poll attempt: set it back to (or leave it at)
   `awaiting_provider` with `run_after` pushed forward by a backoff (e.g.
   `now() + interval based on job.attempts`, capping like the rest of the queue does),
   instead of calling `jobs.fail()` with its default retry behavior. Look at
   `src/lib/jobs/queue.ts`'s exported functions for the right primitive — if one already
   supports "re-arm without transitioning to a terminal/queued state," use it; if the only
   options are `complete`/`fail`, add a minimal one (e.g. `jobs.retryLater(jobId, runAfter)`)
   rather than repurposing `fail()`.
3. Only once `job.attempts >= job.max_attempts` should the job actually terminate — at that
   point it's fine to call `jobs.fail()` (terminal) and log the billed/unbilled outcome for
   real, since no further recovery will be attempted.

Match the existing code's style in this file; do not restructure the surrounding poll logic.

---

## 4. Outro job needs an idempotency key (N2)

`src/stages/outro/index.ts`, the `outro_gen` job enqueue (function that builds the job
payload for the outro clip, roughly lines 127-149). It has no `idempotency_key`. Copy the
pattern from `src/stages/clip/index.ts`'s b-roll enqueue (roughly line 152,
`idempotency_key: generateInput.idempotency_key`) — construct and pass an equivalent
idempotency key for the outro generation so `worker/reconcile.ts`'s double-charge guard is
no longer inert for outro-via-Veo generations.

---

## 5. Job claim needs a lock/lease filter; reconcile tick needs a re-entrancy guard (N3)

`supabase/migrations/0001_init.sql`'s `claim_awaiting_jobs` function selects on
`status='awaiting_provider' AND run_after <= now()` only — it sets `locked_by`/`locked_at`
but never filters on them, and never advances `run_after` on claim.

**Do not edit `0001_init.sql` in place** (treat applied migrations as immutable). Instead
**create `supabase/migrations/0005_fix_claim_lock.sql`** that does
`CREATE OR REPLACE FUNCTION claim_awaiting_jobs(...)` with the same signature, adding to the
`WHERE` clause: `AND (locked_by IS NULL OR locked_at < now() - interval '5 minutes')`, and
setting `run_after` forward on claim (e.g. `+ interval '1 minute'`) so a slow in-flight claim
isn't immediately re-claimable by the same stale filter. Read `0001_init.sql`'s current
function body first and reproduce it exactly except for this change — do not alter its
return shape or any other behavior.

**`worker/index.ts`**: the reconcile `setInterval` (roughly lines 157-161) has no in-flight
guard. Add a module-level boolean (e.g. `let reconcileInFlight = false`) checked and set at
the top of the interval callback, reset in a `finally`, so an overlapping tick skips instead
of re-running concurrently.

---

## 6. Shared-frame lineage must be reconciled on the image-stage reuse branch (N4)

`src/stages/image/index.ts`, `process()` (roughly lines 213-217): when a scene's
`start_image_id`/`end_image_id` already exists, the code currently pushes the existing asset
and `continue`s **before** reaching the scene-linking loop (the loop that reconciles
`assets.shared` and points the sibling scene's boundary asset id, roughly lines 192-198,
reached today only via the fresh-generation path).

Fix: on the reuse branch, still run the same linking/reconciliation logic against the
**current** plan (which is recomputed from live DB state on every run) before `continue`-ing
— i.e. don't skip the reconciliation just because generation itself isn't needed. This means:
if the current plan says this boundary is shared with the next scene, but the sibling
scene's pointer doesn't yet point at this asset, update it and set `assets.shared = true`;
if the current plan says this boundary is *no longer* shared (the user changed
`transition_to_next`), detach the sibling's pointer and set `shared = false`. Read the full
function first — the linking loop's existing logic already knows how to do this for the
fresh-generation path; reuse the same logic/helper for the reuse path rather than
duplicating it inline.

---

## 7. Stop stamping Veo's variant onto non-Veo billing (N6)

`src/stages/clip/index.ts`, around line 220: `generateInput.variant = reelConfig.veo_variant`
is set unconditionally for every b-roll scene regardless of the scene's effective provider.
Gate it: only set `variant` when the effective b-roll provider for this scene/job is `"veo"`.
Leave it `undefined`/unset for any other provider (e.g. `higgsfield`), matching how
`estimate()` in the same file already handles this correctly (mirror that conditional).

---

## 8. Fix the Higgsfield base-URL doubling (N7)

`src/adapters/config.ts` (`HIGGSFIELD_CONFIG.baseUrl` default, around line 43) currently
defaults to `https://api.higgsfield.ai/v1`, while `src/adapters/video_broll/higgsfield.ts`
(around lines 109 and 143) separately appends `/v1/generations` and `/v1/generations/{id}`.
Fix by dropping the trailing `/v1` from the **config default only** (leave the adapter's
`/v1/generations` paths as-is, since those match Higgsfield's documented shape). Also update
`.env.example`'s `HIGGSFIELD_BASE_URL` value to match (no trailing `/v1`).

---

## 9. HeyGen's reference budget must be combined with avatar looks (minor, confirmed live)

`src/adapters/video_avatar/heygen.ts`, `validateInput()` (roughly lines 83-98): today
`avatar_ids.length` is checked against `[min_avatar_ids, max_avatar_ids]` (1–3) completely
independently from `references` (split into video/image counts, checked against
`max_reference_videos`/`max_reference_images`, 3/9). HeyGen's actual API enforces one
**combined** budget: avatar looks occupy the same "video-like" slot budget as reference
videos. Change the check to:

```
(avatar_ids.length + videoRefCount) <= max_reference_videos   // still also enforce avatar_ids.length within [min_avatar_ids, max_avatar_ids] separately, both must hold
imageRefCount <= max_reference_images
```

i.e. add a new violation when `avatar_ids.length + videoRefCount > CAPABILITIES.max_reference_videos`,
in addition to (not instead of) the existing `min_avatar_ids`/`max_avatar_ids` check on
`avatar_ids.length` alone.

---

## 10. Rate-card cache needs a TTL (minor)

`src/lib/cost/engine.ts`, the `rateCache` (roughly line 106, a `Map` with no expiry, built
once per worker process lifetime). Add a simple time-based expiry: store `{ rows, fetchedAt }`
per cache key instead of bare rows, and re-fetch when `Date.now() - fetchedAt` exceeds a
constant (5 minutes is reasonable — add it as a named constant near the top of the file, not
a magic number inline).

---

## Do not touch

No `app/(app)/**` page files, no `app/globals.css`, no `tailwind.config.ts`, no component
files under `app/components/**` (beyond nothing — this phase touches zero UI files except
the two new `app/login/page.tsx` and the two new `app/auth/**/route.ts` files listed above).
Those are later phases.

## Before finishing

Run `npx tsc --noEmit` and fix anything this phase's changes broke. Do not run the full test
suite yourself beyond that — the Tester stage does that next. Write `.pipeline/changes.md`
per your standing instructions, and call out explicitly which of the 10 items above you
completed, and flag in it that item 3 (N1 reconcile) and item 9 (HeyGen budget) need test
coverage the Tester should prioritize, since `worker/**` currently has zero tests.
