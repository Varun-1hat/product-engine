-- Stage 8 music is no longer upload-only: it can be generated from a prompt
-- (ElevenLabs Music, or Google's Lyria). `lyria` is a new provider_t value;
-- adding the value here is safe because nothing in this file USES it (see
-- 0008 for why a new enum value can't be used in its own transaction).
alter type provider_t add value if not exists 'lyria';

alter table reel_config
  add column if not exists music_prompt   text null,
  add column if not exists music_provider provider_t null;
