-- 0002_rls.sql
-- Row Level Security (Assumption 7 / brief §4): single internal agency
-- workspace. Supabase Auth (email magic-link) for agency staff; all
-- authenticated staff access all clients — no per-row ownership predicate,
-- no client-facing login. `service_role` (server/worker code, incl.
-- src/stages/* via the ServiceClient) bypasses RLS by default in Supabase
-- and needs no policy here. Enabling RLS with an explicit `TO authenticated`
-- policy still default-denies the `anon` role (defense in depth).
--
-- The one exception is the raw provider secret itself: `provider_keys` only
-- ever stores a `vault_secret_id` pointer (harmless to read); the actual
-- decrypted key is reachable exclusively through the `vault_read_secret`
-- SECURITY DEFINER RPC in 0001_init.sql, whose EXECUTE grant is restricted
-- to `service_role` — `authenticated` has no path to the raw secret even
-- though it can read/write the `provider_keys` row like any other domain
-- table.

alter table clients enable row level security;
alter table client_config enable row level security;
alter table provider_keys enable row level security;
alter table avatars enable row level security;
alter table products enable row level security;
alter table product_media enable row level security;
alter table reels enable row level security;
alter table reel_config enable row level security;
alter table scenes enable row level security;
alter table assets enable row level security;
alter table asset_versions enable row level security;
alter table prompts enable row level security;
alter table prompt_versions enable row level security;
alter table cost_log enable row level security;
alter table rate_card enable row level security;
alter table jobs enable row level security;

drop policy if exists staff_full_access on clients;
create policy staff_full_access on clients
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on client_config;
create policy staff_full_access on client_config
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on provider_keys;
create policy staff_full_access on provider_keys
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on avatars;
create policy staff_full_access on avatars
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on products;
create policy staff_full_access on products
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on product_media;
create policy staff_full_access on product_media
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on reels;
create policy staff_full_access on reels
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on reel_config;
create policy staff_full_access on reel_config
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on scenes;
create policy staff_full_access on scenes
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on assets;
create policy staff_full_access on assets
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on asset_versions;
create policy staff_full_access on asset_versions
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on prompts;
create policy staff_full_access on prompts
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on prompt_versions;
create policy staff_full_access on prompt_versions
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on cost_log;
create policy staff_full_access on cost_log
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on rate_card;
create policy staff_full_access on rate_card
  for all to authenticated using (true) with check (true);

drop policy if exists staff_full_access on jobs;
create policy staff_full_access on jobs
  for all to authenticated using (true) with check (true);

-- ============================================================================
-- Realtime (brief: UI live updates via Supabase Realtime on jobs/assets/
-- asset_versions; §2 also lists cost_log). postgres_changes payloads still
-- respect the RLS policies above.
-- ============================================================================
alter publication supabase_realtime add table jobs;
alter publication supabase_realtime add table assets;
alter publication supabase_realtime add table asset_versions;
alter publication supabase_realtime add table cost_log;
