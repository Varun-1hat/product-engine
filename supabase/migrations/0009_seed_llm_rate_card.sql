-- Token-priced units are new (every rate so far was per image/second/video).
alter table rate_card drop constraint if exists rate_card_unit_type_check;
alter table rate_card add constraint rate_card_unit_type_check
  check (unit_type in ('image','second','video','credit','character','input_token','output_token'));

-- Claude (runtime skills: scene-brain, image-prompt, brand-style-lock,
-- brief-judge) — priced per token, logged as two cost_log rows per call
-- (input + output), same as any other provider.
--
-- variant is NULL so these apply to whatever ANTHROPIC_MODEL is set to; the
-- rates below are Claude Sonnet 4.5's. If you switch models, add
-- model-specific rows (variant = the model id) rather than editing these,
-- and have src/lib/context.ts pass that model id as the variant.
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values
  ('anthropic', 'input_token', null, 0.000003, null,
    'Claude Sonnet 4.5 input $3/1M tokens (2026-07)'),
  ('anthropic', 'output_token', null, 0.000015, null,
    'Claude Sonnet 4.5 output $15/1M tokens (2026-07)');
