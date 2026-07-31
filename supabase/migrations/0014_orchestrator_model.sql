-- The orchestrating LLM (runtime skills: scene-brain, image-prompt,
-- brand-style-lock, brief-judge) becomes a per-reel choice in Stage 2 instead
-- of a single agency-wide ANTHROPIC_MODEL env. Null = use the built-in default
-- (DEFAULT_ORCHESTRATOR_MODEL, src/lib/orchestratorModels.ts).
alter table reel_config add column if not exists orchestrator_model text null;

-- Gemini can now be that orchestrator, so its token usage needs its own
-- cost_log provider. Its own migration because Postgres won't let a new enum
-- value be USED in the same transaction that adds it (see 0015, which seeds
-- its rate_card rows) — same reason 0008/0009 are split.
alter type provider_t add value if not exists 'gemini';
