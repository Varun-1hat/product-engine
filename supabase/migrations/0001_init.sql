-- 0001_init.sql
-- AI Product-Video Pipeline — core schema (spec §2).
-- Enums, tables, keys/FKs, indexes, Vault helper functions.
-- RLS is enabled/authored in 0002_rls.sql; Storage buckets/policies in 0003_storage.sql;
-- rate_card seed values in 0004_seed_rate_card.sql.
--
-- Ordering note: several tables reference each other in both directions
-- (scenes <-> assets; assets <-> asset_versions <-> prompt_versions <-> prompts;
-- asset_versions <-> cost_log). To avoid forward-reference errors, every table
-- is created first with plain columns (no REFERENCES), and ALL foreign key
-- constraints are added afterward in one dependency-safe ALTER TABLE block.

-- ============================================================================
-- Extensions
-- ============================================================================
create extension if not exists pgcrypto;
-- Supabase Vault (secret storage for per-client provider API keys). Available
-- on the Supabase platform (hosted + local CLI). See "Vault helper functions"
-- at the end of this file.
create extension if not exists supabase_vault cascade;

-- ============================================================================
-- Enums (§2.1)
-- ============================================================================
do $$ begin
  create type provider_t as enum ('nano_banana','veo','higgsfield','heygen','elevenlabs');
exception when duplicate_object then null; end $$;

do $$ begin
  create type category_t as enum ('image','video_broll','video_avatar','tts','music');
exception when duplicate_object then null; end $$;

do $$ begin
  create type stage_t as enum ('config','reel_setup','scene','image','clip','trim','outro','music','assembly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type scene_type_t as enum ('avatar','broll');
exception when duplicate_object then null; end $$;

do $$ begin
  create type boundary_t as enum ('continuous','hard_cut');
exception when duplicate_object then null; end $$;

do $$ begin
  create type slot_t as enum ('start_image','end_image','broll_clip','avatar_clip','outro_clip','end_frame_image','final_render');
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_type_t as enum ('image','video','audio');
exception when duplicate_object then null; end $$;

do $$ begin
  create type version_source_t as enum ('generated','uploaded','derived','assembled','manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type prompt_kind_t as enum ('image_start','image_end','broll_motion','avatar_shot','outro_motion');
exception when duplicate_object then null; end $$;

do $$ begin
  create type prompt_source_t as enum ('skill','manual','redo');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_type_t as enum ('avatar_pull','image_gen','broll_gen','avatar_gen','outro_gen','endframe_render','trim','assembly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status_t as enum ('queued','processing','awaiting_provider','succeeded','failed','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_type_t as enum ('generate','redo','poll');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_status_t as enum ('success','failed_billed','failed_unbilled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type end_frame_mode_t as enum ('default','custom');
exception when duplicate_object then null; end $$;

do $$ begin
  create type reel_status_t as enum ('draft','in_progress','assembled','archived');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- Tables (§2.2) — columns only; FKs added in the "Foreign keys" block below.
-- ============================================================================

create table if not exists clients (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  cloned_from   uuid null,
  archived      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- 1:1 with clients. Brand-kit fields are filled progressively during Stage 1
-- onboarding (upserted one field at a time), so they are nullable; only the
-- PK/FK and updated_at are required.
create table if not exists client_config (
  client_id            uuid primary key,
  brand_name           text null,
  logo_path            text null,
  default_tagline      text null,
  fonts                jsonb null,
  brand_colors         jsonb null,
  default_aspect_ratio text null,
  default_resolution   text null,
  updated_at           timestamptz not null default now(),
  constraint client_config_default_aspect_ratio_check
    check (default_aspect_ratio is null or default_aspect_ratio in ('9:16','1:1','16:9')),
  constraint client_config_default_resolution_check
    check (default_resolution is null or default_resolution in ('720p','1080p'))
);

-- Per-client provider API keys (raw secret lives in Vault; only the pointer
-- is stored here). Nano Banana + Veo both resolve to the client's Google key
-- (KeyResolver maps both provider rows to the same underlying secret).
create table if not exists provider_keys (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null,
  provider        provider_t not null,
  vault_secret_id uuid not null,
  account_label   text null,
  created_at      timestamptz not null default now(),
  constraint provider_keys_client_provider_unique unique (client_id, provider)
);

-- HeyGen "looks" pulled during Stage 1 onboarding.
create table if not exists avatars (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null,
  heygen_look_id     text not null,
  name               text not null,
  preview_image_url  text null,
  preview_video_url  text null,
  raw                jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint avatars_client_look_unique unique (client_id, heygen_look_id)
);

create table if not exists products (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,
  name          text not null,
  product_link  text null,
  created_at    timestamptz not null default now()
);

create table if not exists product_media (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null,
  media_type    media_type_t not null,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

create table if not exists reels (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null,
  display_name   text not null,
  current_stage  stage_t not null default 'reel_setup',
  status         reel_status_t not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Scenes reference assets (start/end/clip) — assets is created further below,
-- so those FKs are added later. position ordering is app-managed (no unique
-- constraint, to allow simple UPDATE-based reordering).
create table if not exists scenes (
  id                       uuid primary key default gen_random_uuid(),
  reel_id                  uuid not null,
  position                 int not null,
  type                     scene_type_t not null,
  product_in_scene         boolean not null default false,
  seconds                  numeric not null,
  transition_to_next       boundary_t null,
  broll_provider_override  provider_t null,
  description              text null,
  start_image_id           uuid null,
  end_image_id             uuid null,
  clip_asset_id            uuid null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- assets.current_version_id -> asset_versions is added later (asset_versions
-- is created after this table).
create table if not exists assets (
  id                  uuid primary key default gen_random_uuid(),
  reel_id             uuid not null,
  scene_id            uuid null,
  slot                slot_t not null,
  media_type          media_type_t not null,
  current_version_id  uuid null,
  shared              boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 1:1 with reels. topic/total_seconds_target are the Stage-2 required inputs;
-- everything else is a per-reel choice/override with sensible defaults.
create table if not exists reel_config (
  reel_id                  uuid primary key,
  topic                    text not null,
  total_seconds_target     numeric not null,
  avatar_enabled           boolean not null default false,
  broll_provider           provider_t null,
  image_provider           provider_t not null default 'nano_banana',
  veo_variant              text not null default 'fast',
  outro_provider_override  provider_t null,
  avatar_look_id           uuid null,
  aspect_ratio             text not null,
  resolution               text not null,
  output_fps               int not null default 30,
  end_frame_mode           end_frame_mode_t not null default 'default',
  end_frame_asset_id       uuid null,
  outro_tagline            text null,
  outro_seconds            numeric not null default 2,
  music_path               text null,
  music_trim               jsonb null,
  updated_at               timestamptz not null default now(),
  constraint reel_config_veo_variant_check check (veo_variant in ('standard','fast')),
  constraint reel_config_aspect_ratio_check check (aspect_ratio in ('9:16','1:1','16:9')),
  constraint reel_config_resolution_check check (resolution in ('720p','1080p'))
);

-- prompts.current_version_id -> prompt_versions is added later.
create table if not exists prompts (
  id                  uuid primary key default gen_random_uuid(),
  reel_id             uuid not null,
  scene_id            uuid null,
  asset_id            uuid null,
  kind                prompt_kind_t not null,
  current_version_id  uuid null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists prompt_versions (
  id                 uuid primary key default gen_random_uuid(),
  prompt_id          uuid not null,
  version_no         int not null,
  text               text not null,
  reference_paths    jsonb null,
  source             prompt_source_t not null,
  metadata           jsonb null,
  created_at         timestamptz not null default now(),
  constraint prompt_versions_prompt_version_unique unique (prompt_id, version_no)
);

-- asset_versions.cost_log_id -> cost_log is added later (cost_log created below).
create table if not exists asset_versions (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null,
  version_no          int not null,
  storage_path        text null,
  source              version_source_t not null,
  prompt_version_id   uuid null,
  provider            provider_t null,
  provider_asset_id   text null,
  metadata            jsonb not null default '{}'::jsonb,
  units               numeric null,
  unit_type           text null,
  cost_log_id         uuid null,
  created_by          text null,
  created_at          timestamptz not null default now(),
  constraint asset_versions_asset_version_unique unique (asset_id, version_no)
);

create table if not exists rate_card (
  id                uuid primary key default gen_random_uuid(),
  provider          provider_t not null,
  unit_type         text not null,
  variant           text null,
  unit_cost_usd     numeric not null,
  currency          text not null default 'USD',
  client_id         uuid null,
  effective_from    timestamptz not null default now(),
  effective_to      timestamptz null,
  source_note       text null,
  created_at        timestamptz not null default now(),
  constraint rate_card_unit_type_check check (unit_type in ('image','second','video','credit','character'))
);

-- asset_versions.cost_log_id -> cost_log FK is added below now that this exists.
create table if not exists cost_log (
  id                 uuid primary key default gen_random_uuid(),
  reel_id            uuid not null,
  client_id          uuid not null,
  scene_id           uuid null,
  stage              stage_t not null,
  provider           provider_t not null,
  adapter            text not null,
  call_type          call_type_t not null,
  call_status        call_status_t not null,
  units              numeric null,
  unit_type          text null,
  variant            text null,
  unit_cost_usd      numeric null,
  cost_usd           numeric null,
  rate_card_id       uuid null,
  rate_missing       boolean not null default false,
  provider_asset_id  text null,
  asset_version_id   uuid null,
  idempotency_key    text null,
  created_at         timestamptz not null default now(),
  constraint cost_log_reel_provider_idem_unique
    unique (reel_id, provider, idempotency_key)
);

-- jobs.scene_id / jobs.asset_id intentionally carry no FK (spec §2.2 lists
-- them as plain "uuid NULL" with no "-> table" target, unlike every other
-- cross-table column in this schema). They are still indexed for lookups.
--
-- reel_id is nullable (deliberate exception to this file's usual "FK
-- without an explicit NULL marker => NOT NULL" convention): job_type_t
-- (§2.1) includes `avatar_pull`, a CLIENT-level operation (Stage 1
-- onboarding, before any reel exists) that has no reel to attach to, unlike
-- every other job_type_t value which is inherently reel-scoped. NULL
-- reel_id means "not tied to a reel" (e.g. avatar_pull); ON DELETE CASCADE
-- still applies normally to every reel-scoped job.
create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  reel_id         uuid null,
  scene_id        uuid null,
  asset_id        uuid null,
  type            job_type_t not null,
  provider        provider_t null,
  status          job_status_t not null default 'queued',
  provider_job_id text null,
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  idempotency_key text null,
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb null,
  error           text null,
  callback_token  text null,
  locked_by       text null,
  locked_at       timestamptz null,
  run_after       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ============================================================================
-- Foreign keys (added after all tables exist — see ordering note at top).
-- ============================================================================

alter table client_config
  add constraint client_config_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table clients
  add constraint clients_cloned_from_fkey
  foreign key (cloned_from) references clients (id) on delete set null;

alter table provider_keys
  add constraint provider_keys_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table avatars
  add constraint avatars_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table products
  add constraint products_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table product_media
  add constraint product_media_product_id_fkey
  foreign key (product_id) references products (id) on delete cascade;

alter table reels
  add constraint reels_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table scenes
  add constraint scenes_reel_id_fkey
  foreign key (reel_id) references reels (id) on delete cascade;

alter table scenes
  add constraint scenes_start_image_id_fkey
  foreign key (start_image_id) references assets (id) on delete set null;

alter table scenes
  add constraint scenes_end_image_id_fkey
  foreign key (end_image_id) references assets (id) on delete set null;

alter table scenes
  add constraint scenes_clip_asset_id_fkey
  foreign key (clip_asset_id) references assets (id) on delete set null;

alter table assets
  add constraint assets_reel_id_fkey
  foreign key (reel_id) references reels (id) on delete cascade;

alter table assets
  add constraint assets_scene_id_fkey
  foreign key (scene_id) references scenes (id) on delete set null;

alter table assets
  add constraint assets_current_version_id_fkey
  foreign key (current_version_id) references asset_versions (id) on delete set null;

alter table reel_config
  add constraint reel_config_reel_id_fkey
  foreign key (reel_id) references reels (id) on delete cascade;

alter table reel_config
  add constraint reel_config_avatar_look_id_fkey
  foreign key (avatar_look_id) references avatars (id) on delete set null;

alter table reel_config
  add constraint reel_config_end_frame_asset_id_fkey
  foreign key (end_frame_asset_id) references assets (id) on delete set null;

alter table prompts
  add constraint prompts_reel_id_fkey
  foreign key (reel_id) references reels (id) on delete cascade;

alter table prompts
  add constraint prompts_scene_id_fkey
  foreign key (scene_id) references scenes (id) on delete cascade;

alter table prompts
  add constraint prompts_asset_id_fkey
  foreign key (asset_id) references assets (id) on delete cascade;

alter table prompts
  add constraint prompts_current_version_id_fkey
  foreign key (current_version_id) references prompt_versions (id) on delete set null;

alter table prompt_versions
  add constraint prompt_versions_prompt_id_fkey
  foreign key (prompt_id) references prompts (id) on delete cascade;

alter table asset_versions
  add constraint asset_versions_asset_id_fkey
  foreign key (asset_id) references assets (id) on delete cascade;

alter table asset_versions
  add constraint asset_versions_prompt_version_id_fkey
  foreign key (prompt_version_id) references prompt_versions (id) on delete set null;

alter table asset_versions
  add constraint asset_versions_cost_log_id_fkey
  foreign key (cost_log_id) references cost_log (id) on delete set null;

alter table rate_card
  add constraint rate_card_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table cost_log
  add constraint cost_log_reel_id_fkey
  foreign key (reel_id) references reels (id) on delete cascade;

alter table cost_log
  add constraint cost_log_client_id_fkey
  foreign key (client_id) references clients (id) on delete cascade;

alter table cost_log
  add constraint cost_log_rate_card_id_fkey
  foreign key (rate_card_id) references rate_card (id) on delete set null;

alter table cost_log
  add constraint cost_log_asset_version_id_fkey
  foreign key (asset_version_id) references asset_versions (id) on delete set null;

alter table jobs
  add constraint jobs_reel_id_fkey
  foreign key (reel_id) references reels (id) on delete cascade;

-- ============================================================================
-- Indexes — every FK column (10-100x faster JOINs/CASCADE per Postgres best
-- practice), plus the explicitly-named jobs(status, run_after) queue index
-- and scenes(reel_id, position) ordering index.
-- ============================================================================

create index if not exists clients_cloned_from_idx on clients (cloned_from);

create index if not exists provider_keys_client_id_idx on provider_keys (client_id);
create index if not exists avatars_client_id_idx on avatars (client_id);
create index if not exists products_client_id_idx on products (client_id);
create index if not exists product_media_product_id_idx on product_media (product_id);
create index if not exists reels_client_id_idx on reels (client_id);

create index if not exists scenes_reel_id_idx on scenes (reel_id);
create index if not exists scenes_reel_id_position_idx on scenes (reel_id, position);
create index if not exists scenes_start_image_id_idx on scenes (start_image_id);
create index if not exists scenes_end_image_id_idx on scenes (end_image_id);
create index if not exists scenes_clip_asset_id_idx on scenes (clip_asset_id);

create index if not exists assets_reel_id_idx on assets (reel_id);
create index if not exists assets_reel_id_slot_idx on assets (reel_id, slot);
create index if not exists assets_scene_id_idx on assets (scene_id);
create index if not exists assets_current_version_id_idx on assets (current_version_id);

create index if not exists reel_config_avatar_look_id_idx on reel_config (avatar_look_id);
create index if not exists reel_config_end_frame_asset_id_idx on reel_config (end_frame_asset_id);

create index if not exists prompts_reel_id_idx on prompts (reel_id);
create index if not exists prompts_scene_id_idx on prompts (scene_id);
create index if not exists prompts_asset_id_idx on prompts (asset_id);
create index if not exists prompts_current_version_id_idx on prompts (current_version_id);

create index if not exists prompt_versions_prompt_id_idx on prompt_versions (prompt_id);

create index if not exists asset_versions_asset_id_idx on asset_versions (asset_id);
create index if not exists asset_versions_prompt_version_id_idx on asset_versions (prompt_version_id);
create index if not exists asset_versions_cost_log_id_idx on asset_versions (cost_log_id);

create index if not exists rate_card_client_id_idx on rate_card (client_id);
create index if not exists rate_card_provider_unit_type_idx on rate_card (provider, unit_type);

create index if not exists cost_log_reel_id_idx on cost_log (reel_id);
create index if not exists cost_log_client_id_idx on cost_log (client_id);
create index if not exists cost_log_scene_id_idx on cost_log (scene_id);
create index if not exists cost_log_rate_card_id_idx on cost_log (rate_card_id);
create index if not exists cost_log_asset_version_id_idx on cost_log (asset_version_id);
create index if not exists cost_log_provider_idx on cost_log (provider);

create index if not exists jobs_reel_id_idx on jobs (reel_id);
create index if not exists jobs_scene_id_idx on jobs (scene_id);
create index if not exists jobs_asset_id_idx on jobs (asset_id);
create index if not exists jobs_status_run_after_idx on jobs (status, run_after);

-- ============================================================================
-- Job queue claim functions (Assumption 3 / brief §10.19): Postgres `jobs`
-- claimed with `FOR UPDATE SKIP LOCKED`, no extra infra. Two variants:
--  - claim_jobs: dispatch new work (status queued -> processing, bumps
--    attempts) for worker/index.ts.
--  - claim_awaiting_jobs: lock awaiting_provider rows for polling without
--    changing status or attempts (a poll is not a generate attempt) for
--    worker/reconcile.ts. Both restricted to service_role (workers only).
-- ============================================================================

create or replace function claim_jobs(p_worker_id text, p_types job_type_t[] default null, p_limit int default 1)
returns setof jobs
language plpgsql
as $$
begin
  return query
  update jobs
  set status = 'processing',
      locked_by = p_worker_id,
      locked_at = now(),
      attempts = attempts + 1,
      updated_at = now()
  where id in (
    select j.id
    from jobs j
    where j.status = 'queued'
      and j.run_after <= now()
      and (p_types is null or j.type = any(p_types))
    order by j.run_after
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

create or replace function claim_awaiting_jobs(p_worker_id text, p_limit int default 10)
returns setof jobs
language plpgsql
as $$
begin
  return query
  update jobs
  set locked_by = p_worker_id,
      locked_at = now(),
      updated_at = now()
  where id in (
    select j.id
    from jobs j
    where j.status = 'awaiting_provider'
      and j.run_after <= now()
    order by j.run_after
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

revoke all on function claim_jobs(text, job_type_t[], int) from public, anon, authenticated;
grant execute on function claim_jobs(text, job_type_t[], int) to service_role;

revoke all on function claim_awaiting_jobs(text, int) from public, anon, authenticated;
grant execute on function claim_awaiting_jobs(text, int) to service_role;

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on client_config;
create trigger set_updated_at before update on client_config
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on reels;
create trigger set_updated_at before update on reels
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on reel_config;
create trigger set_updated_at before update on reel_config
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on scenes;
create trigger set_updated_at before update on scenes
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on assets;
create trigger set_updated_at before update on assets
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on prompts;
create trigger set_updated_at before update on prompts
  for each row execute function set_updated_at();

drop trigger if exists set_updated_at on jobs;
create trigger set_updated_at before update on jobs
  for each row execute function set_updated_at();

-- ============================================================================
-- Vault helper functions (Assumption 6 / brief §4): raw provider keys are
-- decrypted server/worker-side only, via service_role, never in the browser.
-- These SECURITY DEFINER wrappers are the only way to reach the `vault`
-- schema from PostgREST/RPC; EXECUTE is revoked from anon/authenticated and
-- granted only to service_role.
-- ============================================================================

create or replace function vault_create_secret(p_secret text, p_name text, p_description text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := vault.create_secret(p_secret, p_name, p_description);
  return v_id;
end;
$$;

create or replace function vault_read_secret(p_secret_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  select decrypted_secret into v_value
  from vault.decrypted_secrets
  where id = p_secret_id;
  return v_value;
end;
$$;

revoke all on function vault_create_secret(text, text, text) from public, anon, authenticated;
grant execute on function vault_create_secret(text, text, text) to service_role;

revoke all on function vault_read_secret(uuid) from public, anon, authenticated;
grant execute on function vault_read_secret(uuid) to service_role;
