-- Gemini as the orchestrating LLM — priced per token, logged as two cost_log
-- rows per call (input + output), same as the 'anthropic' rows in 0009.
--
-- variant is NULL so these apply to whichever Gemini model a reel selects; the
-- rates below are Gemini 2.5 Flash's. If a reel uses 2.5 Pro, add
-- model-specific rows (variant = the model id) rather than editing these, and
-- have src/lib/context.ts pass that model id as the variant.
insert into rate_card (provider, unit_type, variant, unit_cost_usd, client_id, source_note)
values
  ('gemini', 'input_token', null, 0.0000003, null,
    'Gemini 2.5 Flash input $0.30/1M tokens (2026-07)'),
  ('gemini', 'output_token', null, 0.0000025, null,
    'Gemini 2.5 Flash output $2.50/1M tokens (2026-07)');
