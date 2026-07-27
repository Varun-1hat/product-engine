# Spec — AI Product-Video Pipeline (greenfield build, branch `v1`)

Single source of truth for the Coder. The repo is empty (only `README.md`, `.claude/`, `.git`) plus provider skill files under `skills/providers/*` supplied by the coordinator. There are **no other existing files/patterns to copy from**; this spec defines the canonical patterns. Where one module is the reference for others, the spec names it (e.g. "copy `src/stages/image` for `src/stages/clip`").

Implements the brief at `C:\Users\vvaru\Downloads\pipeline-planning-brief.md`. Section tags like "(brief §5.4)" point back to it. The provider set and pricing are now fixed — see RESOLVED DECISIONS and the Provider Integration Appendix (§14). **This spec contains no unresolved gates; the Coder proceeds.**

---

## RESOLVED DECISIONS (formerly R1–R3 + routing rule — now settled)

**R1. Provider set is FIXED.**
- **Wave 1 (build live now):** **Nano Banana** (image, Google-direct per-client key), **Veo 3.1** (`video_broll`, Google-direct per-client key), **HeyGen** Cinematic Avatar (`video_avatar`, per-client key).
- **Wave 2 (adapter + config now, integrate after wave 1):** **Higgsfield** only (`video_broll`, per-client key; low-confidence facts — verify official docs before wiring).
- **Dropped — keep the registry/adapter SEAM so they slot in later, build NOTHING:** Seedance, OpenART (no public API), and "gemini omni" (= Veo; not a separate model). ElevenLabs remains a deferred `tts`/`music` stub.
- Enum: `provider_t = nano_banana | veo | higgsfield | heygen | elevenlabs`.

**R2. Model selection = reel-level default + per-clip override** (supersedes the brief's "one b-roll model per reel").
- `reel_config.broll_provider` = the reel **default** b-roll model. `reel_config.image_provider provider_t NOT NULL DEFAULT 'nano_banana'` (seam; only Nano Banana today). `reel_config.veo_variant text NOT NULL DEFAULT 'fast'` (`standard | fast`; drives Veo model id + rate — see §14). `reel_config.outro_provider_override provider_t NULL`.
- `scenes.broll_provider_override provider_t NULL`. **Effective b-roll model for a scene = `COALESCE(scenes.broll_provider_override, reel_config.broll_provider)`.** Effective outro model = `COALESCE(reel_config.outro_provider_override, reel_config.broll_provider)`.
- **Cost estimate is per-scene:** each scene priced by its effective model (§4, §7 Stage 4/5/7, routing table §8).

**R3. HeyGen Cinematic Avatar bills FLAT $7.00 per video** (any 4–15 s, 720p/1080p). `rate_card(provider=heygen, unit_type='video', unit_cost_usd=7.00)`, `units=1` per generate. Estimate UX must warn: **every avatar clip and every avatar redo = $7 flat** and typically dominates reel cost.

**Routing rule — capability-driven continuity.** Add `supports_end_frame: boolean` to `video_broll` adapter caps (Veo = **true**; Higgsfield = **false**, start-frame-only pending verification). A b-roll boundary N→N+1 may be `continuous` (shared end/start frame) **only if scene N's effective model has `supports_end_frame=true`**; otherwise it is forced to `hard_cut`. The outro clip needs an end-frame-capable effective model (last-scene end frame → branded end frame); if it lacks one (or no model / all-avatar), fall back to a deterministic **crossfade-to-endframe** (ties into brief §10.1). Per-clip override means two adjacent b-roll scenes may use different models — allowed; flag style-inconsistency risk (edge #14). Applied in §5 Stage 4/7, routing table §8, edge cases #6/#7/#14.

---

## ASSUMPTIONS / CONFIRMABLE DEFAULTS (decided here — objectable)

Infra choices the brief delegated or left silent, decided with low-risk defaults so the build proceeds. Stated openly (not buried); the human may override.

1. **Frontend/app framework:** Next.js 15 (App Router) + React + TypeScript + Tailwind CSS + shadcn/ui.
2. **Backend runtime:** Next.js Route Handlers (`app/api/**/route.ts`) + Server Components; core logic in framework-free modules under `src/**` (testable without HTTP). A separate **Node worker** (`worker/`) runs long jobs (ffmpeg assembly, async provider reconciliation, deterministic end-frame render). Provider webhooks land on Next Route Handlers.
3. **Async/queue:** Postgres `jobs` table claimed with `FOR UPDATE SKIP LOCKED` (no extra infra). UI live updates via **Supabase Realtime** on `jobs`/`assets`/`asset_versions`.
4. **Video assembly:** `fluent-ffmpeg` + `ffmpeg-static` in the worker. Output **mp4 / H.264 + AAC**.
5. **Branded end-frame render (Stage 7):** deterministic HTML/CSS → `satori` → `@resvg/resvg-js` PNG (brand fonts honored). No AI gen.
6. **Provider key storage:** Supabase **Vault**. `provider_keys` stores a `vault_secret_id`; raw keys decrypted **server/worker-side only** via service role, never sent to the browser (brief §4).
7. **Auth / tenancy:** single internal **agency workspace**. Supabase Auth (email magic-link) for agency staff; all authenticated staff access all clients. RLS: `authenticated` → full CRUD on domain tables; `service_role` (server/worker) bypasses; `provider_keys` raw secret never exposed to `authenticated`. No client-facing login.
8. **Runtime-skill LLM (brief §9 skills):** Anthropic Claude via `ANTHROPIC_API_KEY` (agency-level env, model id in env). LLM/skill calls are **agency overhead — NOT written to `cost_log`** (brief §7 bills only media providers).
9. **Output fps:** default **30 fps** (`reel_config.output_fps`, editable). Drives the 1-frame continuous-seam trim (1/30 s).
10. **Rate-card scope:** agency-level per `(provider, unit_type, variant, effective window)` with an **optional per-client override** row (`client_id` non-null) for credit/subscription providers (today: **Higgsfield**, whose $/credit derives from the account plan). HeyGen is flat per-video (agency-level; override allowed but not needed). Deterministic lookup in §2.
11. **Testing:** **Vitest**. Pure logic in `src/**` unit-tested; adapters tested against mocked provider SDK/HTTP; cost engine, effective-model routing, `supports_end_frame` continuity, shared-frame, and assembly-plan logic have dedicated tests.

---

## 1. Executive summary

An adapter-centric pipeline that turns a client config + a reel brief into a silent, music-bedded short-form ad video through nine fixed, human-reviewed stages. **Modularity** comes from a single **adapter contract** per model category (`image`, `video_broll`, `video_avatar`, + `tts`/`music` stubs); orchestration never names a concrete model — it resolves `(category, effective provider)` from the registry, where the effective b-roll provider is per-scene (`COALESCE(scene override, reel default)`). **Cost tracking** is cross-cutting: every `generate`/redo/billed-failure emits a `cost_log` row priced by `rate_card` (Nano Banana $0.039/image; Veo per-second by variant×resolution; HeyGen $7/video flat; Higgsfield credit-derived TBD). **Versioning/lineage** is first-class: every regen is a new immutable `asset_version`; revert re-points a pointer; a shared continuous-boundary frame is one asset referenced by two scenes — created only when scene N's effective model supports an end frame. **Async** video gen: HeyGen via webhook + poll fallback; Veo/Higgsfield via worker poll (no webhook) over a Postgres `jobs` queue. **Assembly** is a clean ordered ffmpeg concat that strips clip audio (Veo emits native audio), normalizes fps/codec/res, trims the 1-frame seam duplicate, and lays the music bed.

Stack: Next.js 15 + TS + Tailwind/shadcn (app), Supabase (Postgres + Auth + Storage + Realtime + Vault), a Node worker (ffmpeg + reconcile + end-frame render), Vitest. See ASSUMPTIONS for confirmable choices.

Build strategy: schema + cost/adapter/job spine first (critical-path root), then wave-1 adapters (Nano Banana, Veo, HeyGen), then stages 1→9 in dependency order, with review-UI primitives, dashboard, music, and runtime skills as parallel tracks; Higgsfield as a wave-2 fast-follow. Every phase begins by searching for and applying applicable skills — including `skills/providers/*` (brief §14).

---

## 2. Data model (Supabase / Postgres)

All domain tables carry `reel_id`/`client_id` FKs as relevant; **UI always shows `clients.display_name`, never id** (brief §4). Enable RLS on every table. Enable Realtime on `jobs`, `assets`, `asset_versions`, `cost_log`.

### 2.1 Enums
```
provider_t      = nano_banana | veo | higgsfield | heygen | elevenlabs
category_t      = image | video_broll | video_avatar | tts | music
stage_t         = config | reel_setup | scene | image | clip | trim | outro | music | assembly
scene_type_t    = avatar | broll
boundary_t      = continuous | hard_cut
slot_t          = start_image | end_image | broll_clip | avatar_clip | outro_clip | end_frame_image | final_render
media_type_t    = image | video | audio
version_source_t= generated | uploaded | derived | assembled | manual
prompt_kind_t   = image_start | image_end | broll_motion | avatar_shot | outro_motion
prompt_source_t = skill | manual | redo
job_type_t      = avatar_pull | image_gen | broll_gen | avatar_gen | outro_gen | endframe_render | trim | assembly
job_status_t    = queued | processing | awaiting_provider | succeeded | failed | canceled
call_type_t     = generate | redo | poll
call_status_t   = success | failed_billed | failed_unbilled
end_frame_mode_t= default | custom
reel_status_t   = draft | in_progress | assembled | archived
```
`aspect_ratio`/`resolution` are `text` with CHECK against supported values (`'9:16' | '1:1' | '16:9'`, `'720p' | '1080p'`); authoritative gate is `adapter.validate()`.

### 2.2 Tables (columns → type / key / note)

**clients** — `id uuid PK`, `display_name text NOT NULL`, `cloned_from uuid NULL→clients(id)`, `archived bool DEFAULT false`, `created_at`.

**client_config** (1:1) — `client_id uuid PK→clients ON DELETE CASCADE`, `brand_name text`, `logo_path text`, `default_tagline text`, `fonts jsonb`, `brand_colors jsonb NULL`, `default_aspect_ratio text`, `default_resolution text`, `updated_at`.

**provider_keys** (M) — `id uuid PK`, `client_id→clients ON DELETE CASCADE`, `provider provider_t`, `vault_secret_id uuid NOT NULL`, `account_label text NULL`, `created_at`; **UNIQUE(client_id, provider)**. Note: Nano Banana and Veo both use the client's **Google/Gemini** key — store one row per provider value (`nano_banana`, `veo`); each may reference the same underlying Google secret (KeyResolver maps both to the client's Google key).

**avatars** (M, HeyGen looks) — `id uuid PK`, `client_id→clients ON DELETE CASCADE`, `heygen_look_id text`, `name text`, `preview_image_url text`, `preview_video_url text`, `raw jsonb`, `created_at`; **UNIQUE(client_id, heygen_look_id)**.

**products** (M) — `id uuid PK`, `client_id→clients ON DELETE CASCADE`, `name text`, `product_link text NULL`, `created_at`.
**product_media** (M) — `id uuid PK`, `product_id→products ON DELETE CASCADE`, `media_type media_type_t`, `storage_path text`, `created_at`.

**reels** — `id uuid PK`, `client_id→clients ON DELETE CASCADE`, `display_name text NOT NULL`, `current_stage stage_t DEFAULT 'reel_setup'`, `status reel_status_t DEFAULT 'draft'`, `created_at`, `updated_at`.

**reel_config** (1:1) — `reel_id uuid PK→reels ON DELETE CASCADE`, `topic text`, `total_seconds_target numeric`, `avatar_enabled bool DEFAULT false`, `broll_provider provider_t NULL` (**reel default** b-roll model), `image_provider provider_t NOT NULL DEFAULT 'nano_banana'`, `veo_variant text NOT NULL DEFAULT 'fast'` (`standard|fast`), `outro_provider_override provider_t NULL`, `avatar_look_id uuid NULL→avatars(id)`, `aspect_ratio text NOT NULL`, `resolution text NOT NULL`, `output_fps int NOT NULL DEFAULT 30`, `end_frame_mode end_frame_mode_t DEFAULT 'default'`, `end_frame_asset_id uuid NULL→assets(id)`, `outro_tagline text NULL`, `outro_seconds numeric DEFAULT 2`, `music_path text NULL`, `music_trim jsonb NULL`, `updated_at`.

**scenes** — `id uuid PK`, `reel_id→reels ON DELETE CASCADE`, `position int NOT NULL`, `type scene_type_t`, `product_in_scene bool DEFAULT false`, `seconds numeric NOT NULL`, `transition_to_next boundary_t NULL` (user intent; NULL on last scene; avatar forced `hard_cut`), `broll_provider_override provider_t NULL`, `description text`, `start_image_id uuid NULL→assets(id)`, `end_image_id uuid NULL→assets(id)`, `clip_asset_id uuid NULL→assets(id)`, `created_at`, `updated_at`. Order by `position`. **Effective b-roll model** = `COALESCE(broll_provider_override, reel_config.broll_provider)`. Shared frame materializes only when the effective boundary (§2.4) is `continuous`.

**assets** — `id uuid PK`, `reel_id→reels ON DELETE CASCADE`, `scene_id uuid NULL→scenes ON DELETE SET NULL`, `slot slot_t`, `media_type media_type_t`, `current_version_id uuid NULL→asset_versions(id)`, `shared bool DEFAULT false`, `created_at`, `updated_at`.

**asset_versions** (immutable) — `id uuid PK`, `asset_id→assets ON DELETE CASCADE`, `version_no int`, `storage_path text NULL`, `source version_source_t`, `prompt_version_id uuid NULL→prompt_versions(id)`, `provider provider_t NULL`, `provider_asset_id text NULL`, `metadata jsonb` `{width,height,aspect,resolution,fps,codec,duration_s,mime,trim?:{start_s,end_s},base_version_id?}`, `units numeric NULL`, `unit_type text NULL`, `cost_log_id uuid NULL→cost_log(id)`, `created_by text NULL`, `created_at`; **UNIQUE(asset_id, version_no)**. **Revert = re-point `assets.current_version_id`; never delete.**

**prompts** — `id uuid PK`, `reel_id→reels ON DELETE CASCADE`, `scene_id uuid NULL→scenes ON DELETE CASCADE`, `asset_id uuid NULL→assets ON DELETE CASCADE`, `kind prompt_kind_t`, `current_version_id uuid NULL→prompt_versions(id)`, `created_at`, `updated_at`.
**prompt_versions** (immutable) — `id uuid PK`, `prompt_id→prompts ON DELETE CASCADE`, `version_no int`, `text text NOT NULL`, `reference_paths jsonb NULL`, `source prompt_source_t`, `metadata jsonb NULL`, `created_at`; **UNIQUE(prompt_id, version_no)**.

**cost_log** — `id uuid PK`, `reel_id→reels ON DELETE CASCADE`, `client_id→clients`, `scene_id uuid NULL`, `stage stage_t`, `provider provider_t`, `adapter text`, `call_type call_type_t`, `call_status call_status_t`, `units numeric NULL`, `unit_type text NULL`, `variant text NULL`, `unit_cost_usd numeric NULL`, `cost_usd numeric NULL` (NULL when rate missing), `rate_card_id uuid NULL→rate_card(id)`, `rate_missing bool DEFAULT false`, `provider_asset_id text NULL`, `asset_version_id uuid NULL→asset_versions(id)`, `idempotency_key text NULL`, `created_at`. **Partial UNIQUE(reel_id, provider, idempotency_key) WHERE idempotency_key IS NOT NULL** (prevents double-charge on retries). Log **every** paid call incl. redos + billed failures (brief §7).

**rate_card** — `id uuid PK`, `provider provider_t`, `unit_type text` (`image|second|video|credit|character`), `variant text NULL` (e.g. Veo `standard@1080p`), `unit_cost_usd numeric NOT NULL`, `currency text DEFAULT 'USD'`, `client_id uuid NULL→clients(id)` (NULL=agency; non-null=per-client override), `effective_from timestamptz DEFAULT now()`, `effective_to timestamptz NULL`, `source_note text`, `created_at`. Deterministic `resolveRate(provider, unit_type, variant, client_id, at=now())`: match `(provider, unit_type)` and `variant` (NULL matches when the call has no variant) where `at ∈ [effective_from, effective_to)`, preferring `client_id=<client>` over NULL; none → `rate_missing`. Seed values in §14.4.

**jobs** — `id uuid PK`, `reel_id→reels ON DELETE CASCADE`, `scene_id uuid NULL`, `asset_id uuid NULL`, `type job_type_t`, `provider provider_t NULL`, `status job_status_t DEFAULT 'queued'`, `provider_job_id text NULL`, `attempts int DEFAULT 0`, `max_attempts int DEFAULT 3`, `idempotency_key text NULL`, `payload jsonb`, `result jsonb NULL`, `error text NULL`, `callback_token text NULL`, `locked_by text NULL`, `locked_at timestamptz NULL`, `run_after timestamptz DEFAULT now()`, `created_at`, `updated_at`. Index `(status, run_after)`.

### 2.3 Storage buckets (private; signed-URL download)
`brand/`, `products/`, `assets/`, `music/`, `renders/`. Path: `{client_id}/{reel_id}/{slot}/{asset_id}/v{version_no}.{ext}`.

### 2.4 Asset lineage, versioning & effective boundary (brief §4, §8; R2 routing rule)
- A **slot** = one `assets` row. **Redo** inserts a new `asset_versions` row and re-points `current_version_id`; nothing destroyed. **Revert** re-points to a prior version. Prompt edit + gen ⇒ new `prompt_versions` then new `asset_versions`.
- **Effective boundary** helper `effectiveBoundary(sceneN)` = `continuous` **iff** `sceneN.type='broll' AND sceneN.transition_to_next='continuous' AND scene N+1 is broll AND capabilities(effectiveModel(sceneN)).supports_end_frame=true`; else `hard_cut`. Avatar boundaries are always `hard_cut`. Stored `transition_to_next` is user intent; the effective value is derived here and used by Stage 4, routing, and assembly. UI shows when an intended `continuous` is downgraded to `hard_cut` because the effective model lacks end-frame support.
- **Shared boundary frame:** when `effectiveBoundary(sceneN)=continuous`, `scenes[N].end_image_id == scenes[N+1].start_image_id` (one `assets` row, `shared=true`), generated once, referenced twice. Redo/revert affects both scenes inherently.
- **Prompt→asset lineage:** `asset_versions.prompt_version_id` records the producing prompt version.
- **Trim (Stage 6)** ⇒ new `derived` version with `metadata {base_version_id, trim}` (materialized file).

---

## 3. Adapter contract (the spine — brief §3)

`src/adapters/types.ts`. Orchestration references only `category` + the resolved effective `provider`. All model specifics live in the adapter + its per-model skill + `skills/providers/<x>/SKILL.md`. Cost is priced by the cost engine, not the adapter.

```ts
export interface AdapterCapabilities {
  category: 'image'|'video_broll'|'video_avatar'|'tts'|'music';
  provider: string;                       // provider_t value
  min_duration_s?: number; max_duration_s?: number;
  supported_durations_s?: number[];       // discrete options if any (e.g. Veo [4,6,8] when confirmed)
  supported_aspect_ratios: string[];
  supported_resolutions: string[];
  max_reference_images?: number; max_reference_videos?: number;
  min_avatar_ids?: number; max_avatar_ids?: number;
  supports_end_frame?: boolean;           // video_broll: can it target a last frame? (Veo true, Higgsfield false)
  emits_audio?: boolean;                  // video_broll: strip on ingest if true (Veo true)
  accepted_inputs: string[];
  async: boolean;
  billing_unit: 'image'|'second'|'video'|'credit'|'character';
}
export interface AssetRef { url?:string; asset_id?:string; base64?:string; storage_path?:string; }
export interface GenerateInput {
  client_id:string; reel_id:string; scene_id?:string; asset_id?:string;
  prompt:string; start_image?:AssetRef; end_image?:AssetRef; references?:AssetRef[];
  avatar_ids?:string[]; aspect_ratio:string; resolution:string; duration_s?:number;
  variant?:string;                        // e.g. Veo 'standard'|'fast'
  provider_key:string; callback_url?:string; idempotency_key:string;
}
export interface GenerateResult {
  status:'succeeded'|'pending';
  asset?:{ storage_path?:string; url?:string; mime:string;
           metadata:{ width:number;height:number;aspect:string;resolution:string;fps?:number;codec?:string;duration_s?:number } };
  provider_job_id?:string;
  units:number; unit_type:string; variant?:string;
  raw:unknown;
}
export interface EstimateInput { aspect_ratio:string; resolution:string; duration_s?:number; count?:number; references_count?:number; variant?:string; }
export interface ValidationResult { ok:boolean; violations:string[]; warnings:string[]; }
export interface Adapter {
  id:string; category:AdapterCapabilities['category']; provider:string;
  capabilities():AdapterCapabilities;
  validate(input:Partial<GenerateInput>):ValidationResult;
  estimate(input:EstimateInput):{ units:number; unit_type:string; variant?:string };  // NO provider call
  generate(input:GenerateInput):Promise<GenerateResult>;
  poll?(provider_job_id:string, provider_key:string):Promise<GenerateResult>;
  parseWebhook?(payload:unknown):{ provider_job_id:string; status:'succeeded'|'failed'; asset?:GenerateResult['asset']; units?:number; unit_type?:string; billed?:boolean };
}
```
**Registry** `src/adapters/registry.ts`: `getAdapter(category, provider)`. **Capabilities drive the UI**; `validate()` blocks/warns at the boundary. **Cost is cross-cutting**: orchestrator wraps every `generate`/`poll`/webhook completion and calls `costEngine.log(...)` (incl. redos, billed failures). **Per-adapter integration config** `src/adapters/config.ts` (base URL/auth/mapping) is sourced from `skills/providers/*` + env; §14 has the facts.

### 3.1 `video_avatar` — HeyGen Cinematic Avatar (`heygen@1`) — WAVE 1, full. See `skills/providers/heygen/SKILL.md` + §14.3.
- **capabilities:** `min_duration_s 4`, `max_duration_s 15`, `supported_aspect_ratios ['9:16','1:1']`, `supported_resolutions ['720p','1080p']`, `min_avatar_ids 1`, `max_avatar_ids 3`, `max_reference_images 9`, `max_reference_videos 3` (combined budget), `accepted_inputs ['prompt','avatar_ids','references','aspect_ratio','resolution','duration']`, `async true`, `billing_unit 'video'`.
- **validate():** duration∈[4,15]; aspect/res∈caps; `avatar_ids.length∈[1,3]`; combined references ≤3 videos AND ≤9 images (looks+refs); block on violation.
- **generate():** `POST {HEYGEN_BASE}/v3/videos` header `x-api-key: <client heygen key>`, body `{ type:'cinematic_avatar', prompt, avatar_id:[...1..3], references?:[{type:'image'|'video', url|asset_id|base64}], aspect_ratio, resolution, duration, callback_url }` → `{ video_id }` → `{ status:'pending', provider_job_id:video_id, units:1, unit_type:'video' }`. Silent (no script/voice).
- **poll():** `GET {HEYGEN_BASE}/v3/videos/{id}`; `completed`→download to Storage. **parseWebhook():** `avatar_video.success|fail` → `/api/webhooks/heygen` (verify `callback_token`). Webhook preferred; poll fallback.
- **Avatar pull (Stage 1):** `GET {HEYGEN_BASE}/v3/avatars/looks` → upsert `avatars`.
- **Cost:** flat **$7.00/video** (R3). Estimate UX warns each avatar clip/redo is $7 flat.

### 3.2 `image` — Nano Banana (`nano_banana@1`) — WAVE 1, full. See `skills/providers/nano-banana/SKILL.md` + §14.1.
- **capabilities:** `supported_aspect_ratios` = reel set, `supported_resolutions` per model, `max_reference_images` (product photos), `accepted_inputs ['prompt','references']`, `async false` (synchronous — no job), `billing_unit 'image'`.
- **generate():** apply `modelPrompt.nano_banana`; call `@google/genai` `ai.models.generateContent({ model:'gemini-2.5-flash-image', contents:[{role:'user', parts:[{text}, {inlineData:{mimeType,data:base64}} ...refs] }], config:{ imageConfig:{ aspectRatio } } })` with the client's Google key; read image at `res.candidates[0].content.parts[].inlineData.{data,mimeType}`; upload to Storage → `{ status:'succeeded', asset, units:1, unit_type:'image' }`.
- **Cost:** **$0.039/image** (`unit_type='image'`).

### 3.3 `video_broll` — Veo 3.1 (`veo@1`, WAVE 1) & Higgsfield (`higgsfield@1`, WAVE 2)

**Veo 3.1 — full. See `skills/providers/veo/SKILL.md` + §14.2.**
- **capabilities:** `supported_aspect_ratios ['16:9','9:16']`, `supported_resolutions ['720p','1080p']`, `max_duration_s 8` (`supported_durations_s [4,6,8]` only if the skill confirms selection; else generate 8 and trim), `supports_end_frame true`, `emits_audio true`, `accepted_inputs ['prompt','start_image','end_image']`, `async true`, `billing_unit 'second'`, `variant ∈ {standard, fast}`.
- **generate():** apply `modelPrompt.veo`; `@google/genai` `op = await ai.models.generateVideos({ model: variant==='standard'?'veo-3.1-generate-preview':'veo-3.1-fast-generate-preview', prompt, image:startFrame, config:{ lastFrame:endFrame, aspectRatio, resolution, negativePrompt, numberOfVideos:1 } })` with the client's Google key → `{ status:'pending', provider_job_id: op handle, units: generatedDuration, unit_type:'second', variant }`.
- **poll():** `op = await ai.operations.getVideosOperation({operation:op})` until `op.done`; video at `op.response.generatedVideos[0].video` — **download to Storage immediately** (URI short-lived). **No webhook** → worker poll only.
- **Audio:** Veo emits native audio → **strip on ingest and at assembly (`-an`)**; all clips silent in this build.
- **Duration:** default generate **8 s** and trim to `scene.seconds` in Stage 6; if skill confirms 4/6/8 selection, request smallest option ≥ `scene.seconds`. **Bill the generated duration** (not trimmed).
- **Cost:** per generated second by variant×resolution (§14.4). `estimate.units = generatedDuration`.

**Higgsfield — WAVE 2, low confidence (verify `cloud.higgsfield.ai` docs before wiring). See `skills/providers/higgsfield/SKILL.md` + §14.5.**
- **capabilities:** `supports_end_frame false` (start-frame-only → forces `hard_cut`), `emits_audio false` (verify), `accepted_inputs ['prompt','start_image']`, `async true`, `billing_unit 'credit'`, aspect/res/duration per docs.
- **generate():** base `https://api.higgsfield.ai/v1`, `Authorization: Bearer <client key>`, `POST /v1/generations {task:'image-to-video', model, input_image, prompt, duration, fps, motion_intensity}` → `202 + generation_id` → `{ status:'pending', provider_job_id:generation_id, units:?, unit_type:'credit' }`.
- **poll():** `GET /v1/generations/{id}` until `completed`; download to Storage. **No webhook** → worker poll.
- **Cost:** credit-derived, $/unit **not public** → enter at integration from the dashboard (`rate_card` row, `source_note='higgsfield plan-derived'`, optional per-client override); until set, `rate_missing=true`.

### 3.4 `tts` / `music` — STUB adapters (`elevenlabs_tts@0`, `elevenlabs_music@0`) — deferred (brief §3, §11)
Implement the contract; `generate()` throws `NotImplementedError('deferred')`. Registered so the registry is complete. **Build nothing else.**

---

## 4. Cost engine (`src/lib/cost/`) — cross-cutting

`engine.ts`:
```ts
interface EstimateCall { provider:string; category:Category; unit_type:string; variant?:string; units:number; client_id:string; }
interface CostEngine {
  estimate(calls:EstimateCall[], at?:Date):
    Promise<{ total_usd:number|null; rate_missing:boolean; lines:Array<EstimateCall & {unit_cost_usd:number|null; cost_usd:number|null}> }>;
  log(entry:{ reel_id:string; client_id:string; scene_id?:string; stage:StageId; provider:string; adapter:string;
              call_type:'generate'|'redo'|'poll'; call_status:'success'|'failed_billed'|'failed_unbilled';
              units?:number; unit_type?:string; variant?:string; provider_asset_id?:string; asset_version_id?:string; idempotency_key?:string; }):Promise<CostLogRow>;
  spentSoFar(reel_id:string):Promise<{ total_usd:number; by_stage:Record<StageId,number> }>;
}
```
- **Per-scene estimate (R2):** gen stages build one `EstimateCall` per scene using its **effective model** + variant, then `estimate()` sums via `resolveRate`. No provider call (brief §13). Nano Banana: `units=1`, `unit_type='image'`. Veo: `units=generatedDuration`, `unit_type='second'`, `variant`. HeyGen: `units=1`, `unit_type='video'`.
- `log()` wraps every adapter call incl. redos; **billed failures** → `failed_billed` (only when the provider indicates a billed attempt; else `failed_unbilled`, `cost_usd=0`). Idempotency uniqueness prevents duplicate charges.
- `resolveRate` miss → `rate_missing=true`, `cost_usd=NULL` (today only Higgsfield until its rate is entered; UI shows "rate not configured").
- **Dashboard** uses `spentSoFar` (spent-so-far only). **Estimate UX** warns HeyGen $7/video flat dominates; Veo standard is ~4–8× fast.

---

## 5. Runtime skills (brief §9 — product-internal, versioned, swappable)

`src/skills/` (distinct from executing-agent skills of §14). LLM = Claude (`src/skills/llm.ts`, `ANTHROPIC_API_KEY`), **not** logged to `cost_log`. Zod-validated output; retry ≤3 then surface.
- **scene-brain** `sceneBrain({topic,total_seconds_target,avatar_enabled,has_products,brand}) → { scenes[] }` (`{type,product_in_scene,seconds,transition_to_next,description}`). Rules: avatar only if `avatar_enabled`; product only if `has_products`; avatar boundaries `hard_cut`; sum(seconds) aims at target (soft). (VO seam: future immutable script — not built.)
- **image-prompt** `imagePrompt({scene,boundary_context,brand,products}) → { prompt, reference_paths[] }` per **distinct image slot**; picks product photos where the scene features the product.
- **model-prompt (one per model):** `modelPrompt.{nano_banana,veo,higgsfield,heygen}(genericPrompt, opts) → payloadFields` (negatives, motion tokens, aspect/res syntax, ref handling, Veo `negativePrompt`). Called **inside** the adapter. Swap a model ⇒ swap adapter + this skill.
- **brand/style-lock** `brandStyleLock(prompt,brand,refs) → prompt'`.
- **brief-judge (optional, advisory, non-blocking)** `briefJudge(assetRef,brief,brand) → {score,notes}`; surfaced in review UI, never blocks. Build last.

---

## 6. Standard stage module scaffold (`src/stages/`)

`src/stages/image` is the **reference implementation** for two-granularity review; copy it for `clip` and `outro`.
```ts
export interface StageContext { reelId:string; clientId:string; supa:ServiceClient; costEngine:CostEngine; adapters:AdapterRegistry; skills:SkillRegistry; jobs:JobQueue; storage:StorageClient; keys:KeyResolver; }
export interface ReviewHooks {
  redoPrompt(promptId:string):Promise<PromptVersion>;
  editPrompt(promptId:string,text:string,refs?:string[]):Promise<PromptVersion>;
  redoAsset(assetId:string):Promise<{ job?:Job; version?:AssetVersion }>;
  revertPrompt(promptId:string,versionNo:number):Promise<void>;
  revertAsset(assetId:string,versionNo:number):Promise<void>;
  download(assetVersionId:string):Promise<string>;
  history(target:{promptId?:string;assetId?:string}):Promise<Array<PromptVersion|AssetVersion>>;
}
export interface StageModule<In,Out> {
  id:StageId; inputSchema:ZodType<In>;
  load(ctx:StageContext):Promise<StageState>;           // resumable rehydrate
  process(input:In,ctx:StageContext):Promise<Out>;      // may enqueue jobs
  estimate?(input:In,ctx:StageContext):Promise<CostEstimate>;  // per-scene, gen stages 4/5/7
  review?:ReviewHooks;                                  // stages 4–7
  advance(ctx:StageContext):Promise<StageId>;           // fixed order
}
```
Fixed order `reel_setup→scene→image→clip→trim→outro→music→assembly`; which scenes/clip-types are included varies by config, never the order (brief §2).

---

## 7. Per-stage specs (Stages 1–9)

### Stage 1 — Config (client-level) — `src/stages/config`, `app/(app)/clients/**`
- **Inputs:** brand kit (name, logo→`brand/`, tagline, fonts, colors); optional avatar setup (client HeyGen key→Vault→pull looks); product library→`products/`; defaults (aspect+res); per-provider keys→Vault (Google key covers Nano Banana + Veo). Clone-from optional.
- **Process:** upsert `clients`+`client_config`; keys→`vault.create_secret`→`provider_keys`; `avatar_pull` job via HeyGen → `avatars`. **Clone (brief §16):** copy brand kit, defaults, products/media, avatar selections; **do NOT copy provider keys**. Display name in UI, backend id (brief §4).
- **Review UI:** standard forms; avatar looks as preview cards; multiple avatars allowed. **Cost:** avatar-pull not billed. **Errors/async:** invalid key surfaced from pull job; upload errors per file.

### Stage 2 — Reel setup — `src/stages/reel-setup`, `app/(app)/reels/new`
- **Inputs:** `topic`, `total_seconds_target`, avatar toggle. **Choices:** reel **default** `broll_provider` (from `{veo, higgsfield}`; Higgsfield selectable only once wave-2 wired), `veo_variant` (standard|fast) when Veo, `image_provider` (nano_banana), `aspect_ratio`+`resolution` (default from config, overridable — one per reel), and one `avatar_look_id` if avatar on.
- **Validation:** `avatar_enabled=true` ⇒ `avatar_look_id` required. `broll_provider` **required if `avatar_enabled=false`**; optional if avatar on (all-avatar allowed) — but any b-roll scene or outro-as-clip requires an effective b-roll model, blocked at Stage 4/7 with a "select a b-roll model" prompt (settable retroactively, incl. per-scene override). aspect/res constrained to the intersection of chosen adapters' caps.
- **Process:** create `reels`+`reel_config`; `current_stage='scene'`. **Cost:** none.

### Stage 3 — Scene / script — `src/stages/scene`, `app/(app)/reels/[id]/scene`
- **Process:** `sceneBrain` → ordered scenes (visual shot-list, no dialogue). Persist `scenes`; enforce avatar⇒`transition_to_next='hard_cut'`, last scene NULL, product only if products exist.
- **Review UI:** edit any field; **add/delete/reorder**; adjust seconds/type (avatar type only if `avatar_enabled`); set **per-scene `broll_provider_override`** (effective-model selector); "re-run scene-brain". Total seconds is a target — drift is informational (brief §3, §10.21). UI shows when an intended `continuous` boundary will be downgraded to `hard_cut` because the effective model lacks `supports_end_frame` (§2.4). **Cost:** none.

### Stage 4 — Start & End images (b-roll only) — `src/stages/image` (**reference impl**), `app/(app)/reels/[id]/image`
- **Inputs:** b-roll scenes. Avatar scenes skip; no b-roll scenes ⇒ no-op.
- **Process — capability-driven image slots:** for each b-roll scene create a **start** slot always; create an **end** slot **only if** its effective model `supports_end_frame` (start-frame-only models like Higgsfield need no end image → cost saved). At a boundary where `effectiveBoundary(sceneN)=continuous`, `scenes[N].end_image_id == scenes[N+1].start_image_id` (one shared `assets` row) — generate once (§2.4, brief §13). Run `imagePrompt` per distinct slot → `prompt_versions` (+ product refs); use `reel_config.image_provider` (Nano Banana). **Estimate** = `count(distinct image slots) × $0.039`. On generate: per slot call `nano_banana` (synchronous) → `asset_versions` + `costEngine.log`.
- **Review UI (two-level, brief §8):** *Prompt level* — show/edit prompt; single-redo re-runs `imagePrompt` for this slot only. *Image level* — image beside prompt; edit prompt; single-redo regenerates this image only. Versioned + revertible + downloadable. UI hints **shared** frames (edit/revert affects both scenes). **Cost:** log each Nano Banana call incl. redos.

### Stage 5 — Clip generation — `src/stages/clip`, `app/(app)/reels/[id]/clip`
- **Routes by `scene.type`:**
  - **b-roll:** `getAdapter('video_broll', effectiveModel(scene))`. Veo `generate({ start_image, end_image (only if supports_end_frame), duration_s:generatedDuration, aspect, res, prompt:broll_motion, variant:reel_config.veo_variant })`; Higgsfield `generate({ start_image, prompt, ... })`.
  - **avatar (silent):** `getAdapter('video_avatar','heygen').generate({ prompt:avatar_shot, avatar_ids:[look], references:(product photos if product_in_scene), aspect, res, duration_s })`. Avatar-only ⇒ no refs; avatar+product ⇒ product photos as `references` (no Nano Banana composite — brief §5.5, §10.5).
- **Process:** per-scene `estimate` by effective model (§4); on generate **enqueue all scene jobs (parallel)** (brief §13); async for Veo/Higgsfield/HeyGen.
- **Review UI (two-level):** edit **motion/shot prompt** (manual + single-redo) → regenerate this clip; **or** swap the underlying **image prompt** (b-roll) → regenerate Stage-4 image → regenerate clip. Versioned + revertible + downloadable.
- **Caps:** `validate()` enforced (HeyGen 4–15s/720–1080/ref budget; Veo aspect/res/duration; Higgsfield per docs). **Cost:** log each gen incl. redos + billed failures. HeyGen redo = $7 flat — surfaced in UI.
- **Async (brief §10.19):** `process` returns immediately; `jobs` `awaiting_provider`; HeyGen via `/api/webhooks/heygen` (verify token) or poll fallback; Veo/Higgsfield via worker poll. Veo audio stripped on ingest. Realtime updates UI.

### Stage 6 — Trim / reorder — `src/stages/trim`, `app/(app)/reels/[id]/trim`
- **Trim/crop:** `trim` worker job re-encodes current version → new `derived` `asset_version` (`metadata.trim`, `base_version_id`). Veo clips are generated at native duration (≈8s) → trimming to a shorter `scene.seconds` happens here.
- **Reorder:** UPDATE `scenes.position`. **Human-managed, no enforcement (brief §6, §10.6):** UI **shows shared b-roll frames**; editing/reordering/trimming a shared boundary (or trimming below the end frame) may break the seam — hint only, blocks nothing. **Cost:** none.

### Stage 7 — End frame (branded outro) — `src/stages/outro`, `app/(app)/reels/[id]/outro`
- **Branded end-frame image:** `endframe_render` job (satori→resvg) from logo + `outro_tagline` (defaults from `client_config.default_tagline`, editable). User may **upload custom** (→ `uploaded` version, `end_frame_mode='custom'`). **"Return to default"** re-points/re-renders default.
- **Outro clip:** effective outro model = `COALESCE(reel_config.outro_provider_override, reel_config.broll_provider)`.
  - If that model exists **and** `supports_end_frame` ⇒ generate clip: start = last scene's end frame (b-roll last: its `end_image`; avatar last: extract last frame of last clip via ffmpeg → `derived` image), end = branded end-frame image; via the effective outro model.
  - Else (no model / model lacks end-frame / all-avatar opted out) ⇒ **deterministic crossfade-to-endframe:** ffmpeg fade from [last clip's final frame] → branded end-frame image over `outro_seconds`; no provider call; cost $0 (brief §10.1, R2 routing rule).
- **Review UI (two-level):** end-frame image (upload / return-to-default / edit tagline + re-render) + outro clip (motion prompt edit + redo, trim). Versioned + revertible + downloadable. **Cost:** outro gen logged or $0 (crossfade).

### Stage 8 — Music — `src/stages/music`, `app/(app)/reels/[id]/music`
- **Manual upload only** (brief §11). One track→`music/`→`reel_config.music_path`+`music_trim`. Applied at assembly: under the whole reel; **trim + fade to length; loop if shorter** (brief §10.20). **Review UI:** waveform trim + fade + loop + replace. **Cost:** none.

### Stage 9 — Assembly — `src/stages/assembly` + `worker/assembly.ts`, `app/(app)/reels/[id]/assembly`
- **Process (worker ffmpeg, deterministic):**
  1. Ordered clip list = scenes by `position` → `clip_asset_id` current (trimmed) version; append outro clip.
  2. **Strip audio (`-an`)** from every clip (Veo emits native audio; all clips silent) and **normalize** to reel `resolution`/`aspect_ratio`/`output_fps`/`yuv420p`/H.264 (brief §5.9, §10.9/10.10).
  3. **Continuous-seam 1-frame trim:** for each adjacent pair with `effectiveBoundary(sceneN)=continuous`, drop **1 frame** from the head of incoming clip N+1 (brief §10.11). Hard-cut: no trim.
  4. **Concat** normalized clips.
  5. **Music bed:** trim/loop to total duration + fade in/out; single audio track.
  6. Output **mp4 (H.264 + AAC)** → `renders/` → `assets(slot=final_render)` new version. Downloadable; `reels.status='assembled'`.
- **Async:** `assembly` job; Realtime status; re-assembly ⇒ new `final_render` version. **Cost:** none.

---

## 8. Routing table (deterministic — brief §6, updated for R1/R2 + routing rule)

| Clip type | Scene attrs | Image stage (Stage 4) | Generator (Stage 5) | Boundary | Audio | Impl notes |
|---|---|---|---|---|---|---|
| **B-roll (Veo)** | `type=broll`, effective model Veo | start image; **end image + shared frame only if `effectiveBoundary=continuous`** | `getAdapter('video_broll','veo')` start(+end)→clip, `variant`, generate 8s + Stage-6 trim | `continuous` (Veo `supports_end_frame`) or `hard_cut` | music bed (Veo audio stripped) | bill generated seconds; poll (no webhook) |
| **B-roll (Higgsfield, wave 2)** | `type=broll`, effective model Higgsfield | start image only (`supports_end_frame=false`) | `getAdapter('video_broll','higgsfield')` start→clip | **forced `hard_cut`** | music bed | credit rate TBD; poll |
| **Avatar-only (silent)** | `type=avatar, product=no` | skipped | `getAdapter('video_avatar','heygen')` prompt+look | always `hard_cut` | music bed | $7 flat; webhook/poll |
| **Avatar+product (silent)** | `type=avatar, product=yes` | skipped (product=reference) | HeyGen prompt+look+product refs | always `hard_cut` | music bed | ref budget ≤3vid/9img |
| **Outro** | derived | last scene's end frame (or extracted last frame) + branded end-frame image | effective outro model start+end→clip **if `supports_end_frame`** | tail | music bed | else deterministic crossfade-to-endframe ($0) |

Effective b-roll model per scene = `COALESCE(scene.broll_provider_override, reel_config.broll_provider)`; adjacent scenes may differ (style risk, edge #14). Reel shapes: all-b-roll, all-avatar (outro needs an end-frame-capable model or crossfade fallback), mixed — all resolve through the rows above with no branching outside them.

---

## 9. Edge-case handling (brief §10 — all 22)

1. **All-avatar reel** — Stage 4 no-op; outro via effective model if `supports_end_frame` else crossfade-to-endframe.
2. **All-b-roll reel** — no HeyGen; music-only.
3. **Mixed** — per-`scene.type` routing (§8).
4. **Silent vs talking avatar** — Cinematic Avatar now; `tts`/`music` stubs + seams for later (one adapter swap). Build nothing.
5. **Avatar+product** — product photos as HeyGen `references`; no Nano Banana composite.
6. **Continuous b-roll run** — shared frame **only when scene N's effective model `supports_end_frame` and boundary is continuous** (§2.4); else forced `hard_cut`. Edit/revert affects both; reorder/trim (or trimming below the end frame) may break the seam — UI hints, no enforcement.
7. **Avatar boundaries** — always `hard_cut`. **B-roll boundaries** also forced `hard_cut` when scene N's effective model lacks `supports_end_frame` (e.g. Higgsfield).
8. **Per-scene seconds vs model max** — `validate()` warns/blocks; Veo generates native ≈8s and Stage-6 trims; **billing uses generated duration** (edge #22).
9. **Aspect/res mismatch** — one-per-reel; assembly normalizes.
10. **fps/codec differences** — assembly normalizes to `output_fps`/H.264; Veo audio stripped.
11. **1-frame duplicate at continuous seams** — trim 1 head frame of incoming clip (Stage 9.3).
12. **Redo cost** — every redo a `cost_log` row (`call_type='redo'`); HeyGen redo = $7 flat.
13. **Billed failures** — `failed_billed` logged; else `failed_unbilled`.
14. **Model swap mid-reel / adjacent different b-roll models** — allowed; UI **warns** of style-inconsistency with already-generated assets; no block; versioning preserves assets.
15. **Reel resumability** — `current_stage` + persisted assets/prompts/jobs; `load()` rehydrates.
16. **Client cloning** — Stage 1 prefill from clone (keys excluded).
17. **Multiple avatars per client** — pull+pick; one per reel now; `avatar_ids` array allows per-clip later.
18. **Per-client key across accounts** — `provider_keys` UNIQUE(client_id,provider); `KeyResolver` injects the client's decrypted key (Google key serves Nano Banana + Veo); scopes pull+billing.
19. **Async video gen** — `jobs` + HeyGen webhook + worker poll (Veo/Higgsfield poll-only); states `queued|processing|awaiting_provider|succeeded|failed`.
20. **Music shorter/longer** — trim/loop + fade at assembly.
21. **Total seconds drift** — allowed, informational.
22. **Estimate vs actual divergence** — estimate single-pass per-scene by effective model; actuals accumulate incl. redos and full Veo generated duration; dashboard shows spent-so-far only.

---

## 10. Phased build order (dependencies, critical path, parallel tracks)

**STANDING STEP FOR EVERY PHASE (brief §14, non-negotiable):** *Before writing any code, scaffolding, creating any file, or integrating any API, first search for and read all applicable skills — Anthropic-provided skills, the Supabase agent skill (`npx skills add supabase/agent-skills`, per the Supabase MCP guidance), the supplied `skills/providers/{nano-banana,veo,heygen,higgsfield}/SKILL.md`, and any other project/user `SKILL.md` — and follow them. More than one may apply; check all. Reading the relevant `SKILL.md` is a required first step, never optional. If none matches, proceed with best practices — but the search comes first.*

**Critical path:** P1 → P2(wave 1) → P5(scene) → P6(image) → P7(clip) → P9(outro) → P10(assembly).

- **P0 — Scaffold & tooling.** Next.js 15+TS+Tailwind+shadcn; Vitest; worker package; `.env.example`; Supabase local; Supabase clients. *Deps:* none.
- **P1 — Schema + spine (critical root).** All migrations (§2, incl. `variant`, `image_provider`, `broll_provider_override`, `veo_variant`, `outro_provider_override`), enums, indexes, RLS, buckets, Vault helpers; `jobs` queue; `rate_card`+`cost_log`+cost engine (per-scene estimate, `resolveRate` with variant); adapter contract types (+`supports_end_frame`,`emits_audio`,`variant`) + registry + `adapters/config.ts`; seed `rate_card` (§14.4). *Deps:* P0.
- **P2 — Adapters, WAVE 1 (critical).** **Nano Banana** (`@google/genai`, sync), **Veo 3.1** (`@google/genai` generateVideos + poll, audio-strip, variant→model id+rate, generate-8s+trim), **HeyGen** (full + avatar pull + webhook). `tts`/`music` stubs. *Deps:* P1. *Parallel:* model-prompt skills. **WAVE 2 (fast-follow, non-blocking):** **Higgsfield** adapter + config + rate entry — verify docs first; `supports_end_frame=false`.
- **P3 — Config/onboarding (Stage 1)** incl. keys→Vault, avatar pull, products, clone. *Deps:* P1, P2(HeyGen).
- **P4 — Reel setup (Stage 2)** incl. reel default + `veo_variant` + per-scene override seam. *Deps:* P3.
- **P5 — Scene (Stage 3) + scene-brain + per-scene override + effective-boundary display.** *Deps:* P4.
- **P6 — Image (Stage 4) + image-prompt + capability-driven slots/shared frame + review-UI primitives** (`PromptReview`,`AssetReview`,`VersionHistory`,`DownloadButton`,`CostEstimateBar`(HeyGen $7 + Veo tier warnings),`CapabilityGuard`). *Deps:* P2(Nano Banana), P5. Reused by P7/P9.
- **P7 — Clip (Stage 5) + async jobs + HeyGen webhook route + Veo/Higgsfield poll + review.** *Deps:* P2(video), P6.
- **P8 — Trim/reorder (Stage 6)** incl. Veo native-duration trim. *Deps:* P7.
- **P9 — Outro (Stage 7) + branded end-frame render + outro routing (end-frame-capable else crossfade).** *Deps:* P7, P2(video), worker.
- **P10 — Assembly (Stage 9) worker ffmpeg** (audio-strip/normalize/concat/seam-trim/music bed). *Deps:* P7, P9, P11, worker.
- **P11 — Music (Stage 8).** *Parallel* after P1/Storage.
- **P12 — Cost dashboard + runtime-skill polish + brief-judge (advisory).** Dashboard *parallel* after P1.

**Parallel tracks:** review-UI primitives (with P6), music (P11), dashboard (P12) after P1, runtime skills alongside their consuming stage, config/onboarding (P3) after P1+HeyGen, Higgsfield wave-2 anytime after P2.

---

## 11. Optimization notes (brief §13 applied)

- **Asset reuse:** shared continuous-boundary frame generated once, referenced twice (§2.4) — and end images are **skipped entirely** for start-frame-only models (Higgsfield), avoiding needless Nano Banana calls.
- **Batch/parallel gen:** Stage 4 slots and Stage 5 clip jobs enqueued together; worker runs concurrently.
- **Async over blocking:** HeyGen webhook + poll fallback; Veo/Higgsfield worker poll; `process` never blocks.
- **Cheap estimates:** per-scene `estimate()` + `rate_card` only, no provider call.
- **Model-agnostic orchestration:** all specifics in adapters + per-model skills + `skills/providers/*`; orchestration uses `(category, effective provider)`.
- **Efficient version storage:** revert re-points pointers; shared frames not duplicated; trim stores `base_version_id`+range.
- **Cost awareness:** estimator flags HeyGen $7-flat (redo-expensive) and Veo standard vs fast (4–8×); Veo billed on full generated duration.

---

## 12. File tree + key entry points (create these)

```
package.json / tsconfig.json / next.config.ts / tailwind.config.ts / vitest.config.ts / .env.example
supabase/
  config.toml
  migrations/0001_init.sql   # enums, tables, indexes, FKs (§2)
  migrations/0002_rls.sql    # RLS (Assumption 7)
  migrations/0003_storage.sql# buckets + policies (§2.3)
  migrations/0004_seed_rate_card.sql  # §14.4 seeds
src/
  lib/supabase/{browser,server,service}.ts
  lib/crypto/vault.ts            # createSecret(), KeyResolver.decrypt() (Google key → nano_banana+veo)
  lib/storage/index.ts
  lib/cost/engine.ts             # estimate() per-scene, log(), spentSoFar(), resolveRate(variant)
  lib/jobs/queue.ts              # enqueue/claim(SKIP LOCKED)/complete/fail
  adapters/types.ts              # §3 contract (+supports_end_frame, emits_audio, variant)
  adapters/registry.ts
  adapters/config.ts             # per-provider endpoint/auth/mapping (from skills/providers/*)
  adapters/video_avatar/heygen.ts
  adapters/image/nano_banana.ts
  adapters/video_broll/veo.ts
  adapters/video_broll/higgsfield.ts        # wave 2
  adapters/tts/stub.ts  adapters/music/stub.ts
  skills/llm.ts  skills/scene-brain.ts  skills/image-prompt.ts
  skills/model-prompt/{nano_banana,veo,higgsfield,heygen}.ts
  skills/brand-style-lock.ts  skills/brief-judge.ts  skills/types.ts
  # skills/providers/{nano-banana,veo,heygen,higgsfield}/SKILL.md  (PROVIDED by coordinator — read, do not recreate)
  stages/types.ts
  stages/{config,reel-setup,scene,image,clip,trim,outro,music,assembly}/index.ts
app/
  (app)/clients/**                # Stage 1 + clone
  (app)/reels/new/**              # Stage 2
  (app)/reels/[id]/{scene,image,clip,trim,outro,music,assembly}/page.tsx
  (app)/dashboard/**              # client → reel → spent-so-far
  api/webhooks/heygen/route.ts    # avatar_video.success|fail; verify callback_token
  api/**                          # thin mutations → src/stages/*
  components/{PromptReview,AssetReview,VersionHistory,DownloadButton,CostEstimateBar,CapabilityGuard,SpendBar}.tsx
worker/
  index.ts        # claim jobs → dispatch
  reconcile.ts    # poll awaiting_provider (HeyGen fallback, Veo, Higgsfield)
  assembly.ts     # ffmpeg audio-strip/normalize/concat/seam-trim/music bed
  endframe.ts     # satori→resvg branded render
  trim.ts         # ffmpeg trim
```
Key signatures inline in §3 (adapter), §4 (cost), §6 (stage/review). Thin handlers delegate to `src/stages/*` + `src/lib/*` for testability.

---

## 13. Deferred / dropped — DESIGN SEAM ONLY, BUILD NOTHING (brief §11; R1)

- **VO/TTS + auto-music:** `tts`/`music` ElevenLabs stubs registered; scene-brain reserved for a future immutable script; assembly audio graph structured (music-only today) for later per-clip VO + lipsync. No dialogue fields, no TTS calls.
- **Captions:** none.
- **Enforced continuity:** Stage 6 hints only, blocks nothing.
- **Dropped providers (Seedance, OpenART, "gemini omni"):** the adapter contract + registry **is** the seam — adding one later = new enum value + adapter + model-prompt skill + `skills/providers/<x>/SKILL.md`, no orchestration change. Build nothing now.

---

## 14. Provider Integration Appendix (verified facts — the Coder reads only this spec)

Read alongside `skills/providers/*`. Per-client keys unless noted.

### 14.1 Nano Banana (image) — Google direct
SDK `@google/genai`. `ai.models.generateContent({ model:'gemini-2.5-flash-image', contents:[{ role:'user', parts:[{text}, {inlineData:{mimeType,data:base64}} ...references] }], config:{ imageConfig:{ aspectRatio } } })`. Output image bytes at `res.candidates[0].content.parts[].inlineData.{data,mimeType}`. **Synchronous** (no job). **Pricing $0.039/image** (`unit_type='image'`, `units=1`). Client Gemini key.

### 14.2 Veo 3.1 (video_broll, wave 1) — Google direct
SDK `@google/genai`. `let op = await ai.models.generateVideos({ model: 'veo-3.1-generate-preview' | 'veo-3.1-fast-generate-preview', prompt, image:firstFrame, config:{ lastFrame:lastFrame, aspectRatio, resolution, negativePrompt, numberOfVideos:1 } });` then poll `op = await ai.operations.getVideosOperation({ operation: op })` until `op.done`; video at `op.response.generatedVideos[0].video` — **download to Storage immediately (URI short-lived)**. `supports_end_frame=true`. Aspect 16:9/9:16; res 720p/1080p (4k exists but reel res is 720p/1080p here). Duration ≈8s (verify 4/6/8 selection; else generate 8s and trim in Stage 6). **Emits native audio → strip (`-an`).** **Async, no webhook → jobs queue + worker poll.** Bill per SECOND of **generated** video (full generated duration, not trimmed). Client Gemini key.

### 14.3 HeyGen (video_avatar, wave 1)
As brief §5.5. `POST /v3/videos { type:'cinematic_avatar', prompt, avatar_id:[1-3], references?:[{type:url|asset_id|base64}], aspect_ratio:'9:16'|'1:1', resolution:'720p'|'1080p', duration:4-15, callback_url }`. Auth `x-api-key`. Async: webhook `avatar_video.success|fail` (preferred) or poll `GET /v3/videos/{id}`. Combined budget 3 videos/9 images. Looks: `GET /v3/avatars/looks`. **Pricing FLAT $7.00/video** (`unit_type='video'`, `units=1`).

### 14.4 rate_card seeds (migration `0004_seed_rate_card.sql`, agency-level)
- `nano_banana | image | variant NULL | 0.039`
- `heygen | video | variant NULL | 7.00`
- Veo (`unit_type='second'`, variant `= '{standard|fast}@{720p|1080p}'`; verify exact tier table vs `skills/providers/veo/SKILL.md` at integration):
  - `veo | second | standard@720p | 0.40`
  - `veo | second | standard@1080p | 0.40`
  - `veo | second | fast@720p | 0.10`
  - `veo | second | fast@1080p | 0.12`
  - (seam, not selectable until a model id is confirmed: `lite@720p 0.05`, `lite@1080p 0.08`; 4k: `standard 0.60`, `fast 0.30`)
  The Veo adapter emits `variant = '<veo_variant>@<reel resolution>'`; `resolveRate` matches it.
- `higgsfield | credit | variant NULL | <TBD>` — **do not seed a value**; enter from `cloud.higgsfield.ai` dashboard at wave-2 integration (`source_note='higgsfield plan-derived'`, optional per-client override); until set, `rate_missing=true`, `cost_usd=NULL`, UI shows "rate not configured".

### 14.5 Higgsfield (video_broll, WAVE 2 — LOW confidence; verify official docs before building)
Base `https://api.higgsfield.ai/v1`, `Authorization: Bearer`. `POST /v1/generations { task:'image-to-video', model, input_image, prompt, duration, fps, motion_intensity }` → `202 + generation_id`; poll `GET /v1/generations/{id}` until `completed`; download to Storage. **Async → jobs queue.** **`supports_end_frame=false`** (start-frame-only) unless docs prove otherwise → forces `hard_cut` and skips end-image generation. Pricing pay-as-you-go/credit — exact $/unit not public (see 14.4).
