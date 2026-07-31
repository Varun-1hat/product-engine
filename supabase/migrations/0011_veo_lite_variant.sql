-- 0011_veo_lite_variant.sql
-- Veo 3.1 Lite becomes a selectable b-roll model (reel_config.veo_variant).

alter table reel_config drop constraint reel_config_veo_variant_check;
alter table reel_config
  add constraint reel_config_veo_variant_check check (veo_variant in ('standard','fast','lite'));

-- Rate card rows the 0004 seed left as a seam, now that the model id is confirmed.
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values
  ('veo', 'second', 'lite@720p', 0.05, null, 'Veo 3.1 Lite - Gemini API pricing 2026-07'),
  ('veo', 'second', 'lite@1080p', 0.08, null, 'Veo 3.1 Lite - Gemini API pricing 2026-07');
