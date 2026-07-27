-- 0004_seed_rate_card.sql
-- Agency-level rate_card seeds (§14.4). client_id = NULL means "agency
-- default"; resolveRate() prefers a client-specific override row (if any)
-- over these. effective_from defaults to now(); effective_to stays NULL
-- (open-ended) until a rate changes.

-- Nano Banana — per image, flat.
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values (
  'nano_banana', 'image', null, 0.039, null,
  'Gemini API pricing 2026-07 (~$30/1M output tokens, ~1290 tok/image <=1024px, ~$0.039/image)'
);

-- HeyGen Cinematic Avatar — FLAT per video regardless of duration/resolution (R3).
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values (
  'heygen', 'video', null, 7.00, null,
  'HeyGen API Cinematic Avatar flat per-video 2026-07'
);

-- Veo 3.1 — per generated second, by variant x resolution (the adapter emits
-- variant = '<veo_variant>@<reel resolution>'; resolveRate matches it).
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values
  ('veo', 'second', 'standard@720p', 0.40, null,
    'Veo 3.1 standard tier 2026-07 - verify against skills/providers/veo/SKILL.md at integration'),
  ('veo', 'second', 'standard@1080p', 0.40, null,
    'Veo 3.1 standard tier 2026-07 - verify against skills/providers/veo/SKILL.md at integration'),
  ('veo', 'second', 'fast@720p', 0.10, null,
    'Veo 3.1 fast tier 2026-07 - verify against skills/providers/veo/SKILL.md at integration'),
  ('veo', 'second', 'fast@1080p', 0.12, null,
    'Veo 3.1 fast tier 2026-07 - verify against skills/providers/veo/SKILL.md at integration');

-- NOT seeded (seam, not selectable until a model id is confirmed):
--   veo | second | lite@720p  | 0.05
--   veo | second | lite@1080p | 0.08
--   veo | second | standard@4k| 0.60
--   veo | second | fast@4k    | 0.30
-- Add these as their own rows (new effective_from, do not edit the rows
-- above) once the lite/4k model ids are confirmed.

-- Higgsfield (wave 2) — INTENTIONALLY NOT SEEDED. $/unit is credit-plan
-- derived and not public; resolveRate() will report rate_missing=true /
-- cost_usd=NULL ("rate not configured") until a row is entered from the
-- cloud.higgsfield.ai dashboard at wave-2 integration time, e.g.:
--   insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
--   values ('higgsfield', 'credit', null, <observed $/credit>, null, 'higgsfield plan-derived');
-- (optionally add a client_id-scoped override row if a client's plan differs).
