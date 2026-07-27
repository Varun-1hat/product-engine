-- 0003_storage.sql
-- Storage buckets (§2.3): private; all downloads go through signed URLs
-- (src/lib/storage/index.ts), never public URLs.
-- Path convention: {client_id}/{reel_id}/{slot}/{asset_id}/v{version_no}.{ext}
-- (client-level assets such as brand/products adapt the same prefix using a
-- constant in place of reel_id — see src/lib/storage/index.ts).

insert into storage.buckets (id, name, public)
values
  ('brand', 'brand', false),
  ('products', 'products', false),
  ('assets', 'assets', false),
  ('music', 'music', false),
  ('renders', 'renders', false)
on conflict (id) do nothing;

-- Same access model as the domain tables (Assumption 7): all authenticated
-- agency staff get full CRUD on these 5 private buckets; service_role
-- (server/worker) bypasses RLS entirely. Storage upserts need INSERT +
-- SELECT + UPDATE at minimum, so all four commands are granted together.
drop policy if exists staff_full_access on storage.objects;
create policy staff_full_access on storage.objects
  for all to authenticated
  using (bucket_id in ('brand', 'products', 'assets', 'music', 'renders'))
  with check (bucket_id in ('brand', 'products', 'assets', 'music', 'renders'));
