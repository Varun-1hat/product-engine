-- Product reference photos as a per-reel asset (Stage 2, Reel setup).
--
-- reel_config.product_reference_paths is the single source of truth: nothing
-- is copied into stages — every gen-AI call (image + clip) reads these paths
-- fresh at generate time and attaches them as reference images.
--
-- prompts.use_product_refs is the per-asset opt-out. Prompts are 1:1 with an
-- image slot / a scene's clip, and exist before generation, so the toggle
-- lives here rather than on `assets` (which only exists post-generate).
alter table reel_config
  add column if not exists product_reference_paths jsonb not null default '[]'::jsonb;

alter table prompts
  add column if not exists use_product_refs boolean not null default true;
