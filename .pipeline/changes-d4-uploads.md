# Section 7 — Upload infrastructure + Outro, Music, Config uploads

## Status
Resumed from a prior attempt that was cut off by an infrastructure error, not a
found defect. On inspection, all owned files were already complete and correct
per spec §7. This pass verified each piece against the spec, confirmed the one
open item (Radix `Select` controlled-value handling) was already handled
correctly, and re-ran `tsc`/`vitest` to confirm the whole tree is green. No
code changes were made in this session.

## Files verified (all pre-existing from the prior attempt, no edits needed)

- `app/api/clients/[clientId]/uploads/route.ts` — generic multipart upload
  endpoint. Validates `kind` (`logo | product_photo | music | end_frame`),
  requires `reel_id` for `music`/`end_frame`, derives bucket+path via the
  existing `buildClientPath`/`buildGeneratedPath` helpers in
  `src/lib/storage/index.ts` (no new path scheme), uploads via
  `buildConfigContext(clientId).storage.upload`, returns `{ storage_path }`.
  Matches spec §7.1 exactly.

- `app/hooks/useFileUpload.ts` — client hook, builds `FormData`, POSTs to the
  above route, resolves `storage_path`, exposes `uploading`/`error`. Matches
  spec §7.2.

- `app/(app)/reels/[reelId]/outro/page.tsx` — dual-slot layout (end-frame
  `AssetReview`-only + tagline input/save + custom-upload + "Return to
  default"; outro-clip `AssetReview`+`PromptReview`), both slots bound to
  `/api/reels/{reelId}/outro/review`, `CostEstimateBar` from
  `/outro/estimate`. Matches spec §7.3.

- `app/(app)/reels/[reelId]/music/page.tsx` — no AssetReview/PromptReview
  (Music has no ReviewHooks), file upload via `useFileUpload(..., "music")`,
  `<audio controls>` with `onLoadedMetadata` driving clamped start/end number
  inputs, "Save trim" POST, static informational line about automatic
  fade/loop (no fake controls built). Matches spec §7.4.

- `app/components/config/ConfigBrandTab.tsx` — added (already present):
  `brand_colors`/`fonts` as free-text JSON `Textarea`s parsed on submit with
  try/catch, `default_aspect_ratio`/`default_resolution` `Select`s using
  `ASPECT_RATIOS`/`RESOLUTIONS`, logo upload via `useFileUpload(..., "logo")`
  that PATCHes `brand_kit.logo_path` immediately on success, and displays the
  current logo using the `logo_url` signed URL the GET route already returns
  (see below). Matches spec §7.5.

- `app/components/config/ConfigProductsTab.tsx` — inline name+`product_link`
  "Add product" form POSTing `{ products: [...] }` to the existing
  `PATCH /api/clients/{clientId}` (confirmed additive via
  `insertProducts`/plain insert in `src/stages/config/index.ts`), refetches on
  success, existing read-only badge list preserved. Matches spec §7.5.

- `app/(app)/clients/page.tsx` — clone-from `Select` of existing clients + a
  required new-name `Input` + "Clone" button, POSTing
  `{ clone_from, display_name }` to `POST /api/clients`. Confirmed
  `configInputSchema` (`src/stages/config/index.ts`) and
  `app/api/clients/route.ts` already accept/forward `clone_from` — no backend
  change was needed or made.

- `app/api/clients/[clientId]/route.ts` — GET already enriched with a signed
  `logo_url` (derived from `client_config.logo_path` via
  `ctx.storage.signedUrl("brand", ...)`) for `ConfigBrandTab` to render; PATCH
  unchanged, delegates straight to `processConfig`.

## Specific check requested by the resume brief: Radix `Select` controlled value

Confirmed all three usages already use the `value={x || undefined}` pattern,
which keeps the Radix `Select` uncontrolled (shows its placeholder) until a
real string value exists, then becomes controlled once one is set — this is
correct and required (Radix throws/misbehaves if `value` starts as `""` and
transitions between controlled/uncontrolled states inconsistently):

- `ConfigBrandTab.tsx`: `<Select value={aspectRatio || undefined} onValueChange={setAspectRatio}>` and `<Select value={resolution || undefined} onValueChange={setResolution}>`
- `app/(app)/clients/page.tsx`: `<Select value={cloneFromId || undefined} onValueChange={setCloneFromId}>`

No changes were needed here.

## Verification

- `npx tsc --noEmit` — clean, no errors anywhere in the repo.
- `npx vitest run` — 18 test files, 171 tests, all passing.
- Did not run `next build` per instructions (broken on this machine for an
  unrelated pre-existing environment reason).

## Notes for Tester

- Section 7 is functionally complete; nothing outstanding in this wave's
  ownership. Focus manual/E2E testing (if any) on: the outro dual-slot
  upload/tagline/return-to-default flow, music upload+trim with real audio
  files (duration arrives async via `loadedmetadata`), config logo upload +
  signed URL rendering, product add-form additivity, and client cloning
  end-to-end (new client appears in the list, brand kit/products/avatars
  copied, no provider keys copied).
- Did not touch `ConfigAvatarsTab.tsx`, `ConfigKeysTab.tsx`, or
  `src/stages/config/index.ts` per instructions — those belong to the
  concurrent Assembly/Avatars agent.
