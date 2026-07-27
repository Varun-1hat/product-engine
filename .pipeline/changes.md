# Implementation changes — AI Product-Video Pipeline

Branch `v1`. Implements `.pipeline/spec.md` for the framework-free core
(`src/**`), the worker, the Next.js app/API layer, and a first pass of the
review UI. This file was written in two passes: an early checkpoint (after
`src/**`/`worker/**` were complete but `app/` was still empty), then updated
to its final state below once the API layer, review components, and a
handful of reference pages were added. It is accurate as of now.

**Skills read first (non-negotiable per brief §14):** `skills/providers/{nano-banana,veo,heygen,higgsfield}/SKILL.md` (provided), plus `supabase/agent-skills` (`supabase` + `supabase-postgres-best-practices`, installed via `npx skills add` into `.claude/skills/` — read in full: RLS basics/performance, schema conventions, FK indexing, partial indexes, SKIP LOCKED, primary keys, data types). Next.js/React/Tailwind/Vitest are well-trodden ground already in training data, so no extra skill fetches were made there beyond a deliberate search (found only unverified third-party community skills, not worth the injection-risk trade-off).

## Verification performed (real, not just typecheck)

- `npx tsc --noEmit`: **clean, 0 errors** (re-verified after every phase below).
- `npx vitest run`: **88/88 tests passing**, 8 test files (cost/rate-card resolution, effective-model routing + continuity, Stage-4 shared-frame-lineage planning, Stage-9 assembly-plan construction, and all 4 wave-1/2 adapters with mocked SDK/HTTP).
- `npx next build`: **succeeds** (re-run 3 times as files were added, always clean), producing every API route + every page below as registered Next.js routes (dynamic `ƒ` for all `/api/**` and the two `[id]`-param pages, static `○` for `/`, `/clients`, `/dashboard`, `/reels/new`). One benign environment warning (`@next/swc-win32-x64-msvc` binary invalid on this sandbox's Windows build; Next transparently falls back to the wasm SWC build and still compiles) — not a code issue. A dummy `.env.local` (gitignored) was created solely to give the build real-looking env vars; it holds no real credentials.
- **Real, non-mocked smoke tests** (not part of the vitest suite, run manually with `tsx` against the actual installed `ffmpeg-static`/`satori`/`@resvg/resvg-js` binaries this session downloaded/verified):
  - `worker/endframe.ts` `renderEndFramePng()` — produced a real, visually-correct branded PNG (verified by viewing the image).
  - `worker/assembly.ts` `normalizeClip/concatClips/buildMusicTrack/muxFinal` — ran against two synthetic ffmpeg-generated test clips (different resolutions/framerates) + a synthetic sine-wave audio track. Confirmed: 1-frame head-trim produces the exact expected duration (2s + 3s − 1/30s = 4.97s), correct 1080×1920/30fps/yuv420p/H.264 normalization, correct AAC mux with music, and correct video-only output (no audio stream) when there's no music bed.
- Supabase migrations were **not** applied to any live project (per instructions) — they are reviewed SQL only, not execution-verified against a real Postgres.

## Phase status

| Phase | Status |
|---|---|
| P0 Scaffold | **DONE** — Next 15 + TS + Tailwind v3 + Vitest, `worker/` present, `.env.example` |
| P1 Schema + spine | **DONE** — migrations, cost engine, jobs queue, adapter contract/registry/config, Vault |
| P2 Wave-1 adapters | **DONE** — Nano Banana, Veo, HeyGen, all full; tts/music stubs |
| P2 Wave-2 Higgsfield | **DONE** (adapter + config, clearly flagged low-confidence/verify-docs-first) |
| P3–P9 stage modules (`src/stages/*`) | **DONE** — all 9 stages implemented with real logic |
| Worker (`worker/*`) | **DONE** — index/reconcile/assembly/endframe/trim + outro.ts (added, see below) |
| App shell (`app/layout.tsx`, `app/page.tsx`, globals) | **DONE** |
| API routes (`app/api/**`) | **DONE for the core flow**: clients(+reels listing), reels, scene, image(+estimate+review), clip(+estimate+review), trim(+reorder), outro(+estimate+review), music, assembly, HeyGen webhook |
| Review-UI components (`PromptReview`, `AssetReview`, `VersionHistory`, `DownloadButton`, `CostEstimateBar`, `CapabilityGuard`, `SpendBar`) | **DONE** — all 7 built, functional, wired to the review-action API |
| UI primitives (`app/components/ui/{button,input,textarea,label,card,badge}.tsx`) | **DONE** — minimal shadcn-style (cva + tailwind-merge), no Radix |
| Stage pages (`app/(app)/**`) | **PARTIAL** — clients list+detail, reel-new, scene, and image (the full reference pattern) are built; clip/trim/outro/music/assembly pages are NOT built (their APIs are ready; only the UI is missing) |
| Auth/login | **NOT STARTED** — no login page; API routes are not session-gated yet (see Known gaps) |
| Dashboard | **DONE (minimal)** — clients → reels → `SpendBar`, via a small `spentSoFar`-backed API route |
| Runtime-skill polish / brief-judge wiring beyond the base call | **base only** — brief-judge implemented but not called from any stage (it's explicitly optional/advisory/build-last per spec) |

**Honest summary:** the entire framework-free engine (`src/**`), the worker, and the full HTTP surface (`app/api/**`, including the HeyGen webhook) are complete and verified (typecheck + 88 tests + a real `next build` + real ffmpeg/satori smoke tests). The UI is a genuine first pass, not a full implementation: all 7 named components exist and work, and Stage 4 (image) has the complete reference page the spec calls for (§7: "reference implementation for two-granularity review") — but Stage 5/6/7/8/9 pages were not built due to time, and there is no auth. A developer continuing this would: (1) add a login page + session gate using the already-scaffolded `src/lib/supabase/server.ts`, then (2) copy `app/(app)/reels/[reelId]/image/page.tsx` for clip/outro (same two-asset-slot shape) and trim/music/assembly (simpler, single-asset shape) — the APIs they'd call already exist and are exercised by the image page's pattern.

---

## Files created, by area

### Supabase migrations (`supabase/migrations/`) — P1
- `0001_init.sql` — all 16 enums (§2.1), all 16 tables (§2.2) with columns exactly as specified, FKs added in a dependency-safe second pass (scenes⇄assets and assets⇄asset_versions⇄prompt_versions⇄prompts⇄assets and asset_versions⇄cost_log are mutually referential — see the file's ordering note), FK indexes on every FK column (Postgres doesn't auto-index these — from the `supabase-postgres-best-practices` skill), `updated_at` triggers, the `claim_jobs`/`claim_awaiting_jobs` SKIP LOCKED RPCs (per the `lock-skip-locked` skill reference), and the `vault_create_secret`/`vault_read_secret` SECURITY DEFINER RPCs (EXECUTE restricted to `service_role`).
  - **Deliberate deviation from spec's literal "no NULL marker ⇒ NOT NULL" pattern**: `jobs.reel_id` is nullable (spec's plain reading would make it NOT NULL like every other reel_id column) — because `job_type_t` includes `avatar_pull`, a client-level Stage-1 job with no reel to attach to. Documented inline in the migration.
- `0002_rls.sql` — RLS enabled on every domain table; one `staff_full_access` policy per table (`FOR ALL TO authenticated USING (true) WITH CHECK (true)` — Assumption 7's "all authenticated staff access all clients," single internal workspace, no per-row predicate needed); `service_role` bypasses by Supabase default. Realtime enabled on `jobs`, `assets`, `asset_versions`, `cost_log`.
- `0003_storage.sql` — 5 private buckets (`brand`, `products`, `assets`, `music`, `renders`); one `storage.objects` policy for `authenticated` scoped to those 5 bucket ids.
- `0004_seed_rate_card.sql` — Nano Banana ($0.039/image), HeyGen ($7.00/video flat), Veo 4 tiers (`standard@720p/1080p` $0.40, `fast@720p` $0.10, `fast@1080p` $0.12). Higgsfield **intentionally not seeded** (rate_missing=true until entered at wave-2 integration, per spec). Lite/4k tiers documented in a comment, not seeded (spec: "not selectable until a model id is confirmed").
- `supabase/config.toml` — local dev config (ports, auth, storage, realtime).

### Core lib (`src/lib/`) — P1
- `db/enums.ts` — every Postgres enum mirrored as a TS union + const array (single source of truth for zod schemas/UI dropdowns).
- `db/types.ts` — TS row types for every table (`Client`, `SceneRow`, `AssetVersion`, etc.), shared across all stage modules.
- `supabase/{browser,server,service}.ts` — three clients per Assumption 7: browser (anon key, RLS), server (cookie-session, RLS, Next-only via `next/headers`), service (service-role, bypasses RLS, used by all stage/worker code). **Note:** none of these use the `server-only` npm package — it only no-ops under Next's webpack/RSC bundler and throws unconditionally under plain Node, which broke both Vitest and the tsx-run worker when tried; the "never import service.ts from a client component" rule is enforced by code organization/review instead, documented in each file.
- `crypto/vault.ts` — `createSecret()` + `createKeyResolver(supa): KeyResolver` (`.forProvider(clientId, provider)`, `.decrypt(vaultSecretId)`). Implements the Google-key-covers-nano_banana+veo fallback from spec §2.2.
- `storage/index.ts` — `createStorageClient(supa)` (upload/download/signedUrl/remove), `buildAssetPath` (canonical `{client}/{reel}/{slot}/{asset}/v{n}.{ext}` convention), `buildClientPath` (client-scoped, no reel_id), `buildGeneratedPath` (adapter `generate()`-time uploads, keyed on idempotency_key since adapters don't have version_no yet), `buildPollResultPath` (adapter `poll()`/webhook-time uploads, keyed on provider+provider_job_id only — see the contract-shape note below).
- `jobs/queue.ts` — `createJobQueue(supa)`: `enqueue/claim/claimAwaitingProvider/markAwaitingProvider/complete/fail/release/get`. `claim`/`claimAwaitingProvider` call the SKIP LOCKED RPCs.
- `cost/rateCard.ts` + `cost/engine.ts` — **pure** `resolveRateFromRows()` (provider+unit_type+variant+effective-window+client-override matching) split from the Supabase-touching `createCostEngine(supa)` (`estimate`/`log`/`spentSoFar`) specifically so the resolution logic is unit-testable without a DB. Idempotency-key unique-violation on `log()` returns the existing row instead of throwing (no double-charge on retry).
- `routing.ts` — **pure**: `effectiveBrollModel`, `effectiveOutroModel`, `effectiveBoundary` (the capability-driven continuity rule), `isDowngradedToHardCut`, `needsEndImage`, `resolveOutroRoute`, `withNextScene`.
- `versioning.ts` — shared prompt/asset version bookkeeping (`upsertPromptVersion`, `upsertAssetVersion`, `revert*Version`, `*History`, `getAsset`, `getPrompt`, `getCurrentPromptVersion`) used identically by Stages 4/5/7.
- `rows.ts`, `brandContext.ts`, `assetRefs.ts` — small shared getters (reel_config/scenes/client_config), brand+product-photo context for the skills, and `AssetRef` construction from an existing `assets` row or a raw storage path (adapters never read `storage_path` directly — only `base64`/`url` — this is what keeps that boundary honest).
- `context.ts` — **(added post-checkpoint-warning, for the app layer)** composition root: `buildStageContext(reelId)`, `buildConfigContext(clientId)`, `buildReelSetupContext(clientId, reelId?)` — used by every `app/api/**` route so route handlers stay thin.
- `reviewAction.ts` — **(added for the app layer)** shared `{action, promptId?, assetId?, ...}` POST-body schema + dispatcher used by the image/clip/outro `review/route.ts` handlers, so the 7-method `ReviewHooks` switch isn't triplicated.

### Adapters (`src/adapters/`) — P2
- `types.ts` — the §3 contract, copied verbatim (`AdapterCapabilities`, `AssetRef`, `GenerateInput/Result`, `EstimateInput`, `ValidationResult`, `Adapter`, `NotImplementedError`).
- `registry.ts` — `createAdapterRegistry()` (generic, DI-friendly) + `getDefaultAdapterRegistry()` (lazily wires all 6 real adapters with a shared `StorageClient`).
- `config.ts` — per-provider model ids/base URLs/tuning (Veo model-id-by-variant, HeyGen/Higgsfield base URLs from env, `heygenCallbackUrl()`).
- `dimensions.ts`, `assetRef.ts` — shared aspect×resolution→pixel-dims table; shared `AssetRef`→bytes resolver (base64 passthrough or `fetch(url)` — deliberately **not** storage_path, see below).
- `image/nano_banana.ts` — full, sync. Verified against the actual installed `@google/genai` `.d.ts` (`ai.models.generateContent`, `Part.inlineData: {data, mimeType}`).
- `video_broll/veo.ts` — full, async. `billableDurationS()` (exported pure helper — smallest of `[4,6,8]` ≥ requested, else 8) drives both `estimate()` and `generate()`'s `durationSeconds`. `poll()` reconstructs a real `GenerateVideosOperation` instance (verified in the SDK source that `getVideosOperation` calls `operation._fromAPIResponse(...)`, a prototype method — a plain object literal would not work here). Verified against the actual `@google/genai` source that `generateVideos({model, prompt, image, config:{lastFrame,...}})` matches the skill file's flat shape (not the JSDoc's alternate `source:{}` shape).
- `video_avatar/heygen.ts` — full: `generate/poll/parseWebhook` + `pullAvatarLooks()` (Stage 1). `parseWebhook` is synchronous/no-I/O per the given contract shape — it returns a passthrough `asset.url`; the webhook route handler (which has full job context) does the actual download+persist.
- `video_broll/higgsfield.ts` — wave 2, built and registered, capabilities/URLs marked PLACEHOLDER/UNCONFIRMED throughout with inline comments pointing at `skills/providers/higgsfield/SKILL.md`'s "verify before real use" warning. `supports_end_frame: false` is the one fact the routing rule depends on and is asserted.
- `tts/stub.ts`, `music/stub.ts` — registered, `generate()` throws `NotImplementedError`, nothing else built (spec §3.4).
- Tests: `image/nano_banana.test.ts`, `video_broll/veo.test.ts`, `video_avatar/heygen.test.ts`, `video_broll/higgsfield.test.ts` — capabilities/validate/estimate pure-logic tests plus mocked-SDK/HTTP `generate()`/`poll()`/`parseWebhook()` round trips (see Tester-focus section).

**Contract-shape gap I resolved and want flagged for review:** `Adapter.poll(provider_job_id, provider_key)` and `parseWebhook(payload)` (spec §3, given verbatim) carry **no** `client_id/reel_id/asset_id/aspect_ratio/resolution/duration_s/variant` — only enough to ask the provider for status. So poll()/parseWebhook() return **best-effort placeholder metadata/units/variant**, and the actual authoritative reconciliation happens in the caller (`worker/reconcile.ts`, `app/api/webhooks/heygen/route.ts`), which already has the full `jobs` row including `payload` (what `src/stages/clip`/`src/stages/outro` recorded when they called `generate()`). This is documented in every file it touches. **Tester: please specifically check this handoff (job.payload → cost_log/asset_versions.metadata) for correctness**, since it's the least spec-literal part of the adapter layer.

### Runtime skills (`src/skills/`) — parallel to P2
- `llm.ts` — Claude client (`@anthropic-ai/sdk`), zod-validated JSON output, retry ≤3.
- `scene-brain.ts`, `image-prompt.ts`, `brand-style-lock.ts`, `brief-judge.ts`, `model-prompt/{nano_banana,veo,higgsfield,heygen}.ts`, `types.ts` (incl. `createSkillRegistry()`).
- **Judgment call**: spec doesn't name a skill that produces the *generic* `broll_motion`/`avatar_shot`/`outro_motion` prompt text (only `image-prompt` for image slots is named). This build derives it from `scene.description` (already written by scene-brain in Stage 3) run through `brandStyleLock()` — giving that named skill a concrete call site. Documented in `src/stages/clip/index.ts` and `src/stages/outro/index.ts`.

### Stage modules (`src/stages/`) — P3–P9, all with real logic (no stubs)
- `types.ts` — `StageContext`/`ReviewHooks`/`StageModule<In,Out>` copied verbatim from §6, plus `STAGE_ORDER`/`nextStage()`.
- `config/index.ts` (Stage 1) — **does not implement `StageModule`** (it's client-level, no `reelId`; see file header). `processConfig`/`loadConfig` with its own `ConfigStageContext`. Clone copies brand kit/products+media/avatars, never provider_keys.
- `reel-setup/index.ts` (Stage 2) — same reasoning, own context (`reelId` optional — absent when creating). Validates aspect/resolution against the intersection of every chosen adapter's capabilities.
- `scene/index.ts` (Stage 3) — full `StageModule`. `computeSceneHints()` (exported, pure-ish) surfaces the "downgraded to hard_cut" hint per scene.
- `image/index.ts` + `image/plan.ts` (Stage 4, **the reference implementation**) — `planImageSlots()` is the pure shared-frame-lineage planner (dedicated tests, see below); `index.ts` wires it to `imagePrompt`, Nano Banana, and `src/lib/versioning`. `createImageReviewHooks(ctx)` — see the "review isn't a static field" note below.
- `clip/index.ts` (Stage 5) — routes by `scene.type`; async — calls `adapter.generate()` inline and marks the job `awaiting_provider` directly (no `queued` state for `broll_gen`/`avatar_gen`). `createClipReviewHooks(ctx)`.
- `trim/index.ts` (Stage 6) — enqueues a `trim` job; `reorderScenes()`; `computeTrimHints()`. `redoPrompt`/`editPrompt` throw (trim has no prompts) rather than silently no-op.
- `outro/index.ts` (Stage 7) — end-frame render/upload/return-to-default + outro-clip job dispatch via `resolveOutroRoute()`. **Design choice**: unlike Stage 5, this stage does *not* call `adapter.generate()` inline — it enqueues an `outro_gen` job in `queued` state and lets `worker/outro.ts` do the prep (possibly ffmpeg last-frame extraction) + the generate() call, because that prep step is itself worker-appropriate work. `createOutroReviewHooks(ctx)` disambiguates the end-frame-image asset vs the outro-clip asset by which id is passed.
- `music/index.ts` (Stage 8) — manual upload only, trivial.
- `assembly/index.ts` + `assembly/plan.ts` (Stage 9) — `buildAssemblyPlan()` is the pure, dedicated-tested plan builder (ordering, 1-frame seam trims via `effectiveBoundary`, music loop/fade math); `index.ts` gathers real storage paths/durations and enqueues the `assembly` job.
- **`review` is never a static field** on any `StageModule` object across image/clip/outro/trim: `ReviewHooks`' 7 methods (spec §6, given verbatim) take no `ctx` parameter, yet every one needs Supabase/adapter/skill access. Rather than fight that, each stage exports a `create{X}ReviewHooks(ctx): ReviewHooks` factory (used by the corresponding `review/route.ts`), and leaves the static `.review` field unset (it's optional in the type). Documented identically in each affected file.

### Worker (`worker/`)
- `ffmpegSetup.ts`, `tempFiles.ts` — shared fluent-ffmpeg binary config + temp-dir/file helpers.
- `trim.ts` — Stage 6 job: re-encode to `[start_s,end_s)`, new `derived` version.
- `endframe.ts` — Stage 7 default render: satori→resvg PNG. **Bundles a real font** (`worker/assets/fonts/NotoSans-Regular.ttf`, Apache/SIL-OFL — copied from Next.js's own `@vercel/og` bundled font in `node_modules`, not fetched over the network, so it's committed and stable) since satori cannot shape text with zero fonts loaded. "Brand fonts honored" (Assumption 5) is structured as a seam (swap the `fonts` array) but not implemented beyond this default.
- `assembly.ts` — Stage 9: per-clip normalize (strip audio, scale/pad/fps/yuv420p/h264, 1-frame head-drop via `select`), concat-demuxer concat, music trim/loop/fade, final mux (H.264+AAC, or video-only if no music). Consumes `AssemblyPlan` from `src/stages/assembly/plan.ts` — no business logic duplicated here.
- `outro.ts` — **added, not one of the 5 files spec §12 names verbatim.** Stage 7's `outro_gen` job handler: crossfade route (ffmpeg fade between two looped stills, no provider call, completes in one call) or model route (resolve start frame — reusing Stage 4's `end_image` or ffmpeg-extracting the clip's last frame — then `generate()` + `markAwaitingProvider`). Justified in the file's own header comment; flagging here too since it's a deviation from the literal file list.
- `reconcile.ts` — polls `awaiting_provider` jobs, reconciles `poll()`'s best-effort result against `jobs.payload`, logs cost, persists the asset version, completes/fails the job. Conservative default: unconfirmed failures are logged `failed_unbilled` (no adapter currently signals a billed-failure distinctly — flagged as a possible future enhancement).
- `index.ts` — two `setInterval` loops: claim (`queued` → dispatch to trim/endframe_render/outro_gen/assembly/avatar_pull) and reconcile. `broll_gen`/`avatar_gen`/`image_gen` intentionally throw if ever claimed here (they should never reach `queued`; `image_gen` is unused since Nano Banana is synchronous).

### App layer (`app/`) — added this session

**API routes** (all thin: parse+zod-validate the body, build context via `src/lib/context.ts`, call straight into the already-implemented — and unit-tested where pure — `src/stages/*` function; no stage logic duplicated in a route handler):
- `layout.tsx`, `globals.css` (Tailwind v3 + shadcn-style CSS vars), `page.tsx` — minimal shell, **verified via a real `next build`**.
- `src/lib/context.ts` — composition root (`buildStageContext(reelId)`, `buildConfigContext(clientId)`, `buildReelSetupContext(clientId, reelId?)`).
- `src/lib/reviewAction.ts` — shared `{action, promptId?, assetId?, ...}` POST-body schema + dispatcher used by every `review/route.ts`, so the 7-method `ReviewHooks` switch isn't triplicated.
- `src/lib/cn.ts` — the standard shadcn `clsx`+`tailwind-merge` class combinator.
- `app/api/clients/route.ts` + `[clientId]/route.ts` — Stage 1 list/create/get/update.
- `app/api/clients/[clientId]/reels/route.ts` — **(added for the dashboard)** reels for a client + `costEngine.spentSoFar()` per reel.
- `app/api/reels/route.ts` + `[reelId]/route.ts` — Stage 2 create/get/edit.
- `app/api/reels/[reelId]/scene/route.ts` — Stage 3 load/process.
- `app/api/reels/[reelId]/image/route.ts` (**enriched GET** — see note below) + `estimate/route.ts` + `review/route.ts` — Stage 4.
- `app/api/reels/[reelId]/clip/route.ts` + `estimate/route.ts` + `review/route.ts` — Stage 5.
- `app/api/reels/[reelId]/trim/route.ts` + `reorder/route.ts` — Stage 6.
- `app/api/reels/[reelId]/outro/route.ts` + `estimate/route.ts` + `review/route.ts` — Stage 7.
- `app/api/reels/[reelId]/music/route.ts` — Stage 8.
- `app/api/reels/[reelId]/assembly/route.ts` — Stage 9 (its GET also joins the current `final_render` asset+version).
- `app/api/webhooks/heygen/route.ts` — the HeyGen webhook receiver (see header comment in the file; mirrors `worker/reconcile.ts`'s reconciliation pattern since `parseWebhook()` can't do I/O).

**`app/api/reels/[reelId]/image/route.ts`'s GET is the one route that isn't purely thin**: since there's no login/RLS session yet (see Known gaps), a browser-side page can't query Supabase directly with `authenticated` privileges, so this GET is enriched with everything the reference page needs per slot (signed preview URL, prompt text + version, both version histories) via straightforward read-only queries — no stage business logic is added, only response shaping for the UI. This is the one pattern a future clip/outro page would need to replicate (or better: replace once real auth + a client-side Supabase session exists, letting pages query Storage/Postgres directly under RLS instead).

**UI primitives** (`app/components/ui/`) — minimal shadcn-style (`class-variance-authority` + `tailwind-merge`, no Radix, to keep the dependency/risk footprint small): `button.tsx`, `input.tsx`, `textarea.tsx`, `label.tsx`, `card.tsx`, `badge.tsx`.

**The 7 named review components** (`app/components/`), all functional, all calling a stage's `review` endpoint via `src/lib/reviewAction.ts`'s shared action shape:
- `DownloadButton.tsx` — calls `download`, opens the returned signed URL.
- `VersionHistory.tsx` — lists versions with per-row "Revert" (calls `revertPrompt`/`revertAsset`).
- `CostEstimateBar.tsx` — renders an `EstimateResult`; flags HeyGen's flat $7 and Veo standard-vs-fast, and "rate not configured" for `rate_missing`.
- `SpendBar.tsx` — renders a `spentSoFar()` result as a stacked bar + per-stage breakdown (dashboard).
- `CapabilityGuard.tsx` — renders a `ValidationResult`'s violations (blocking) and warnings, only rendering its `children` (the guarded action) when `ok`.
- `PromptReview.tsx` — prompt-level review: editable textarea (`editPrompt`) + "Redo" (`redoPrompt`) + embeds `VersionHistory`.
- `AssetReview.tsx` — asset-level review: media preview (image/video/audio), "Redo" (`redoAsset`), embeds `DownloadButton` + `VersionHistory`.

**Pages** (`app/(app)/`) — a genuine first pass, not full coverage:
- `clients/page.tsx` — list + create-client form.
- `clients/[clientId]/page.tsx` — brand kit form, provider-key entry (Google covers Nano Banana+Veo, HeyGen separately), avatars list, products list, link to create a reel.
- `reels/new/page.tsx` — Stage 2 form (topic, seconds, avatar toggle, b-roll model, aspect/resolution) reading `?client_id=`.
- `reels/[reelId]/scene/page.tsx` — Stage 3: generate/re-run scene-brain, list scenes, shows the "downgraded to hard_cut" hint per scene from `computeSceneHints()`.
- `reels/[reelId]/image/page.tsx` — **Stage 4, the full reference pattern the spec calls for**: per b-roll scene, a start-slot and (if applicable) end-slot each rendering `AssetReview` + `PromptReview`, a shared-frame badge, a `CostEstimateBar`, and a "Generate missing images" action.
- `dashboard/page.tsx` — clients → reels (via the new `reels` sub-route) → `SpendBar`.
- **NOT built**: `reels/[reelId]/{clip,trim,outro,music,assembly}/page.tsx` — the directories exist (created empty this session) but have no `page.tsx`. Their APIs are complete; only the UI is missing. The image page + its enriched GET route is the pattern to copy (clip/outro are the same two-asset-slot shape; trim/music/assembly are simpler single-asset/global-settings shapes).

## Known gaps / honest scope cuts

1. **No login page / no session gating on API routes.** Assumption 7 calls for Supabase Auth magic-link + RLS; the RLS policies exist (0002_rls.sql) and `src/lib/supabase/server.ts` (cookie-session client) exists, but no route handler currently calls it to reject unauthenticated requests, and there's no `/login` page. All pages built this session call the app's own `/api/**` routes (server-side, service-role) rather than querying Supabase directly from the browser, so they still work today — but there is currently no access control at all. **This must be added before any real deployment.**
2. **UI coverage is partial** — Stage 4 (image) has the full reference page; Stages 5/6/7/8/9 (clip/trim/outro/music/assembly) have working APIs but no pages yet. This is the newest and least-tested part of the build — see "What the Tester should focus on" below.
3. `image_gen` job type exists in the enum (schema completeness / symmetry with the other categories) but is never enqueued — Nano Banana is synchronous, called directly from `src/stages/image`.
4. Reconcile's billed-vs-unbilled-failure distinction (spec edge #13) defaults conservatively to unbilled; no adapter currently signals a confirmed billed failure.
5. Supabase migrations are unapplied/unexecuted against a live Postgres (by instruction) — reviewed and internally consistent, but the very first real `supabase db reset` against them is the actual proof.
6. No automated tests exist for anything under `app/**` (route handlers or pages) — only `tsc`/`next build` verification. All Vitest coverage remains in `src/**` (88 tests, unchanged by the app-layer work).

## What the Tester should focus on

In priority order:

1. **Cost engine** (`src/lib/cost/rateCard.test.ts` + `engine.ts`): rate resolution (provider+unit_type+variant+window+client-override), `failed_unbilled`→`cost_usd=0` vs `rate_missing`→`cost_usd=NULL` distinction, idempotency-key double-charge prevention.
2. **Effective-model routing / `supports_end_frame` continuity** (`src/lib/routing.ts` + `routing.test.ts`): the full truth table in `effectiveBoundary` — especially per-scene override breaking an otherwise-continuous run, and boundaries into/out of avatar scenes.
3. **Shared-frame lineage** (`src/stages/image/plan.ts` + `plan.test.ts`): a run of 3+ continuous Veo scenes should produce exactly `scenes+1` distinct slots (not `2×scenes`), and no scene should ever get a duplicate "own start" slot when it's covered by a shared one.
4. **Assembly plan** (`src/stages/assembly/plan.ts` + `plan.test.ts`, and the real ffmpeg smoke test described above): seam-trim placement, music loop/no-loop threshold, fade-duration capping on very short reels.
5. **The route handlers / webhook auth**: `app/api/webhooks/heygen/route.ts`'s callback_token lookup (401 on missing/unknown token), and that every `app/api/reels/[reelId]/**` route correctly threads `reelId`→`clientId` via `src/lib/context.ts`. These are build-verified (`next build` succeeded) but have **no request-level tests** — this is genuinely untested territory.
6. HeyGen's flat $7/video billing surfacing correctly through `clip/estimate` regardless of duration/resolution (adapter-level test exists; not yet re-verified end-to-end through the route).
7. **The review-action dispatcher** (`src/lib/reviewAction.ts`) and the 7 UI components — these were hand-tested only by reading the code + a successful `next build`, never by clicking through a running app against a real Supabase project (no project was provisioned, per instructions). Specifically worth checking: `AssetReview`/`PromptReview`'s `shared` badge actually reflects `assets.shared`/boundary sharing, and that redoing a shared asset from either scene's page would affect both (inherent from the DB model — `assets.shared` — but not visually cross-checked from two different scene cards).

---

## Post-Tester fix: Veo variant/rate_card mismatch (cost engine never resolves a Veo rate)

**Bug (found by the Tester, reproduced independently):** every Veo b-roll cost estimate/log came back `rate_missing=true`/`cost_usd=NULL` in both Stage 5 (clip) and Stage 7 (outro-via-Veo), even though `0004_seed_rate_card.sql` seeds Veo rates. Root cause: that migration seeds Veo rows keyed on a resolution-qualified `variant` (`"standard@720p"`, `"standard@1080p"`, `"fast@720p"`, `"fast@1080p"`) with its own comment stating "the adapter emits `variant = '<veo_variant>@<reel resolution>'`" — but nothing in the runtime path actually composed that string. `src/adapters/video_broll/veo.ts`'s `estimate()`/`generate()` both only ever handled the bare `veo_variant` ("standard"/"fast"), and `src/stages/clip/index.ts`/`src/stages/outro/index.ts` passed `reelConfig.veo_variant` straight through, bare, to both the estimate call and the billing-context (`job.payload.variant`) recorded at enqueue time. Since `resolveRateFromRows()` requires an exact string match, `"fast"` never matched a `"fast@1080p"` row.

**Fix — composes the resolution-qualified variant in exactly one place (the Veo adapter module), used everywhere billing context is built, while leaving the adapter's own `generate()`/`validate()` untouched (they still need the BARE variant for Veo model-id selection):**

- `src/adapters/video_broll/veo.ts` — added `export function composeVeoVariant(bareVariant, resolution)` returning `` `${bareVariant}@${resolution}` ``, co-located with the existing `billableDurationS` pure-helper pattern other stages already import from this module.
- `src/stages/clip/index.ts` — `estimate()` now passes `composeVeoVariant(reelConfig.veo_variant, reelConfig.resolution)` as the adapter-estimate `variant` (only when the effective model is `"veo"`; unchanged for Higgsfield). `enqueueClip()`'s `job.payload.variant` (the billing context read later by `worker/reconcile.ts`) is now computed the same way for Veo, instead of the old `result.variant ?? generateInput.variant ?? null` (both bare). `generateInput.variant` itself (what actually reaches `adapter.generate()`/`validate()`) is **untouched** — still bare — since Veo's model-id lookup (`VEO_CONFIG.models[variant]`) and `isVeoVariant()` check both require the bare form.
- `src/stages/outro/index.ts` — same fix in `estimate()`. The job-enqueue payload (`enqueueOutroClip`) is deliberately **left bare**, because for outro the actual `adapter.generate()` call happens later, inside `worker/outro.ts`, which still needs the bare variant at that point.
- `worker/outro.ts` — **this one required a real fix, not just verification**, exactly per the coordinator's instruction to check rather than assume. After `runModelRoute()` calls `adapter.generate()`, it re-writes the job's payload with the now-known billing units; that line was `variant: result.variant ?? payload.variant ?? null` — since Veo's `generate()` always returns a truthy *bare* `result.variant`, this unconditionally clobbered whatever composed value might otherwise have been present, silently re-introducing the exact same bug for the outro-via-Veo path. Fixed to compose `composeVeoVariant(payload.variant, payload.resolution)` when the effective outro provider is `"veo"`, taking precedence over `result.variant`.
- `worker/reconcile.ts` — verified, **no change needed**: it already reads `payload.variant ?? result.variant ?? undefined`, i.e. payload wins — so once the stage/worker code above stores a composed value in `job.payload.variant`, this file picks it up correctly with zero changes.
- `src/lib/cost/rateCard.ts`, `src/lib/cost/engine.ts`, and `supabase/migrations/0004_seed_rate_card.sql` — **untouched**, per the Tester's explicit recommendation (composing the variant, not flattening the rate_card seed, preserves the real per-resolution pricing the seed data encodes).

**Verification:**
- `npm run typecheck` — clean, 0 errors.
- `npm test` — **127/128 passing** (not 128/128 — see honest caveat immediately below), zero regressions in any previously-passing test (the original 88 plus the Tester's other 39 new tests are all still green).

**The one still-failing assertion is a separate, pre-existing gap in the Tester's own test data, not a production defect, and not something I'm able to fix without editing a file I was explicitly told not to touch.** Concretely, in `app/api/reels/[reelId]/clip/estimate/route.test.ts`'s "BUG" describe block (line ~143), `seed(VEO_RATE_CARD_SEED)` is called with *only* the four Veo rows — unlike the other three `seed([...])` calls in the exact same file (lines 83–85, 107–109, 125–126), which all additionally include a `{ id: "heygen-flat", provider: "heygen", ... }` row. The shared `seed()` fixture always creates a reel with 2 avatar-type scenes regardless of which rate_card rows are passed in, so with no HeyGen rate seeded, those 2 scenes' HeyGen `EstimateCall`s legitimately fail to resolve a rate — and `createCostEngine().estimate()` correctly (per its own already-passing tests, e.g. `engine.test.ts`'s "a single rate_missing line... suppresses the overall total_usd to null") sets the top-level `rate_missing: true` whenever *any* line is unresolved. I confirmed this by temporarily running the exact seed data through the route by hand (outside the test file, then deleted): the Veo line itself now resolves exactly as the bug report expects (`unit_cost_usd: 0.12`, `cost_usd: 0.72`) — it's only the two unrelated, unseeded HeyGen lines dragging the top-level flag to `true`. This is very likely why the Tester didn't catch it themselves: `expect().toBe()` throws on the first failure, so their original (pre-fix) run never got past the `unit_cost_usd`/`cost_usd` assertions on lines 175–176 to reach line 177 at all. **Recommended one-line fix for whoever owns that test file:** add the same `{ id: "heygen-flat", ... }` row used in the other three `seed()` calls in this file to the `seed(VEO_RATE_CARD_SEED)` call at line 143 (or seed `VEO_RATE_CARD_SEED` alongside it, matching the sibling blocks) — that assertion isn't testing anything Veo/variant-related, so it should pass immediately once HeyGen has a resolvable rate in that scenario too.
8. Given no auth exists, **do not point this at a real Supabase project with real provider keys without first adding session gating** — as built, anyone who can reach the app can call any `/api/**` route.
