-- Stage 2 gains a free-text brief alongside the short `topic` line: extra
-- context on what content to keep and how to treat it, fed to scene-brain.
alter table reel_config add column if not exists topic_description text null;

-- The scene-brain instruction itself, editable per reel from the scene page
-- (before the first generation and on any re-run). Null = use the built-in
-- default (SCENE_BRAIN_SYSTEM_PROMPT, src/skills/scene-brain.ts).
alter table reel_config add column if not exists scene_prompt text null;
