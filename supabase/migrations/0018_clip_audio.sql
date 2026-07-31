-- 0018_clip_audio.sql
-- Video-gen models (Veo) emit a native audio track. Until now it was carried
-- inside the clip mp4 and dropped at assembly (normalizeClip's -an). It is now
-- retained as an asset in its own right: one 'clip_audio' slot per clip (per
-- scene, plus one reel-level row with scene_id null for the outro clip), with
-- the same immutable asset_versions history as every other asset — so the
-- model's take, a user upload and a music-model generation are all just
-- versions of the same slot and any of them can be reverted to.
--
-- Adding the enum value and the column in one file is safe: a new enum value
-- may not be USED in the transaction that adds it (see 0008/0010), and nothing
-- here references 'clip_audio' — the column addition is independent of it.
alter type slot_t add value if not exists 'clip_audio';

-- Whether this clip's audio is used in the final render. Slot-specific in the
-- same way `assets.shared` is (only meaningful for boundary-frame images):
-- only 'clip_audio' rows consult it. Default true — audio a model produced is
-- used unless the user switches it off, which is the whole point of keeping it.
alter table assets
  add column if not exists audio_enabled boolean not null default true;
