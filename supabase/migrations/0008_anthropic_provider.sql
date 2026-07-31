-- The runtime skills' LLM (prompt generation + orchestration) is a real,
-- billable cost and belongs in cost_log alongside the media providers —
-- Assumption 8 ("agency overhead, never logged") is retired. Its own
-- migration because Postgres won't let a new enum value be USED in the same
-- transaction that adds it (see 0009, which seeds its rate_card rows).
alter type provider_t add value if not exists 'anthropic';
