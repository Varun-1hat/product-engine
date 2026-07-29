-- 0012_music_versions.sql
-- Music tracks get the same assets/asset_versions history as images/clips:
-- one 'music_track' slot per reel, one immutable version per generate/upload,
-- reel_config.music_path always points at the current version.

alter type slot_t add value if not exists 'music_track';
