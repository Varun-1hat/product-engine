-- Per-scene override to skip the end-frame image entirely (start-frame-only
-- generation): cheaper/faster for simple shots; leave false for scenes that
-- benefit from start+end interpolation (§2.4 continuity routing).
alter table scenes add column if not exists end_frame_disabled boolean not null default false;
