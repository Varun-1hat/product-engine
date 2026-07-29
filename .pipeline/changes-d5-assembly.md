# Wave D — Section 8: Assembly page + avatar management

Resumed from a prior attempt that was cut off at final verification. All implementation work
was already complete in the working tree; this pass only re-verified it against spec section 8
and ran the final checks. No code changes were made in this pass.

## Files (owned by this task)

- `app/(app)/reels/[reelId]/assembly/page.tsx` (new) — Assembly stage page per §8.1.
  - "Start assembly" / "Re-assemble" button POSTs `{}` to `/api/reels/{reelId}/assembly`.
  - Polls `GET /api/reels/{reelId}/assembly` every 3s via `useApiResource`'s `reload()`,
    only while a `pending` flag is true; interval is cleared on unmount and once the flag
    clears.
  - Deviation (documented in-file): spec's "Processing…" derivation is
    `!final_render && status !== "assembled"`, but the GET response carries no job-status
    field, so read literally that leaves "Start assembly" permanently disabled on a reel's
    very first visit (no render yet, but nothing "pending" either). Narrowed the condition to
    a page-local `pending` flag set right after this page's own POST and cleared once
    `final_render.current_version_id` changes to a value different from the one captured at
    trigger-time. This preserves the spec's intent (poll + show "Processing…" while a
    triggered job is in flight; never poll forever) while still allowing first-time starts.
  - On render available: `<video controls>` with a signed preview URL fetched via the
    existing `assembly/review` route's `download` action, plus the existing `DownloadButton`
    component.
  - No fabricated failure UI — matches spec's explicit instruction not to invent a
    job-failure state the backend can't report.
  - No "Next" control — this is the last stage, already excluded by §2.6's layout logic.

- `app/api/clients/[clientId]/avatars/[avatarId]/route.ts` (new) — `PATCH` (rename, body
  `{ name }`) and `DELETE` per §8.2. Thin dispatch to `src/stages/config/avatars.ts`.

- `src/stages/config/avatars.ts` (new) — `renameAvatar`/`removeAvatar`, plain
  `ServiceClient`-scoped `.update()`/`.delete()` calls scoped by `client_id` + `id`, matching
  the convention in `src/stages/config/index.ts` (not imported from there, per spec's
  isolation requirement). No cascade handling added — `reel_config.avatar_look_id` already
  has `on delete set null` at the DB level (confirmed in
  `supabase/migrations/0001_init.sql`), so no application-level cleanup is needed.

- `app/components/config/ConfigAvatarsTab.tsx` (edited) — replaced the plain badge list with
  preview cards (image or placeholder box + name), inline rename (pencil icon -> `Input` +
  Save/Cancel calling `PATCH`), and remove via `AlertDialog` (destructive-styled "Remove"
  action calling `DELETE`), each with per-row busy/error state. No "add avatar" control, per
  spec — avatars are still populated only via the HeyGen key -> `avatar_pull` flow.

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — 18 files / 171 tests passed.
- `next build` intentionally skipped (broken on this machine for an unrelated, pre-existing
  environment reason, per task instructions).

## Notes for reviewer/tester

- Focus on the `pending`-flag deviation in the assembly page (documented above and in the
  file's own header comment) — it's the one place behavior was adapted from a literal reading
  of the spec because the GET response shape doesn't support the literal derivation.
- Avatar rename/remove routes and `src/stages/config/avatars.ts` are new, additive files with
  no interaction with concurrently-edited files (`src/stages/config/index.ts` untouched, per
  spec's isolation requirement for this section).
- `ConfigAvatarsTab.tsx` is the only file touched inside `app/components/config/` by this
  task; `ConfigBrandTab.tsx`/`ConfigKeysTab.tsx`/`ConfigProductsTab.tsx` were left untouched
  (owned by a different concurrent agent).
