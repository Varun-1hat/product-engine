-- 0013_omni_variant.sql
-- Gemini Omni Flash (preview) becomes a selectable b-roll model. It runs on
-- the same Gemini API key as Veo (video_broll/veo.ts routes it to the
-- Interactions API), so it's a veo_variant rather than a new provider.

alter table reel_config drop constraint reel_config_veo_variant_check;
alter table reel_config
  add constraint reel_config_veo_variant_check check (veo_variant in ('standard','fast','lite','omni'));

-- Billed per second of generated video like the Veo tiers (Omni bills output
-- tokens: ~5,792 tokens/s of 720p video ~= $0.10/s at Gemini API pricing).
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values
  ('veo', 'second', 'omni@720p', 0.10, null, 'Gemini Omni Flash preview - Gemini API pricing 2026-07'),
  ('veo', 'second', 'omni@1080p', 0.10, null, 'Gemini Omni Flash preview - Gemini API pricing 2026-07');
