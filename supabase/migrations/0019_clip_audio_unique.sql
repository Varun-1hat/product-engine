-- 0019_clip_audio_unique.sql
-- One clip_audio slot per clip, enforced.
--
-- Separate file from 0018 because this one USES the 'clip_audio' enum value
-- (in the partial index predicate), which Postgres will not allow in the same
-- transaction that added it — the same rule 0008/0010 call out.
--
-- Worth enforcing here specifically: unlike every other slot, a clip_audio row
-- is created lazily during a GET (src/lib/clipAudio.ts backfills clips whose
-- audio was never extracted). Three stage pages read that endpoint and can
-- fetch concurrently, so without this two requests could each insert a row and
-- leave the slot permanently ambiguous. With it, the loser's insert fails, its
-- caller logs and moves on, and the next read finds the winner's row.
--
-- scene_id is nullable (the reel-level row is the outro clip's) and NULLs are
-- never equal in a plain unique index, so coalesce to a fixed sentinel to make
-- "one outro audio per reel" a real constraint too.
create unique index if not exists assets_one_clip_audio_per_clip
  on assets (reel_id, coalesce(scene_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where slot = 'clip_audio';
