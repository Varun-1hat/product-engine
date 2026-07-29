-- 0005_fix_claim_lock.sql
-- Fixes N3 (.pipeline/review.md): claim_awaiting_jobs (0001_init.sql) sets
-- locked_by/locked_at on every claim but never FILTERS on them, and never
-- advances run_after — so a second worker's tick, running before the first
-- worker's poll finishes, can re-claim (and double-poll/double-process) the
-- exact same awaiting_provider row. 0001_init.sql is an applied migration
-- and is treated as immutable, so this creates a new function version
-- instead of editing it in place.
--
-- Reproduces claim_awaiting_jobs's body exactly (same signature, same
-- return shape) except:
--   1. WHERE clause gains a lock/lease filter: only claim rows that are
--      unlocked OR whose lock has gone stale (>5 minutes — a crashed/hung
--      worker shouldn't be able to wedge a row forever).
--   2. run_after is advanced by 1 minute on claim, so a slow in-flight poll
--      isn't immediately re-claimable by the same worker's own next tick
--      under the (unchanged) `run_after <= now()` condition.
create or replace function claim_awaiting_jobs(p_worker_id text, p_limit int default 10)
returns setof jobs
language plpgsql
as $$
begin
  return query
  update jobs
  set locked_by = p_worker_id,
      locked_at = now(),
      run_after = now() + interval '1 minute',
      updated_at = now()
  where id in (
    select j.id
    from jobs j
    where j.status = 'awaiting_provider'
      and j.run_after <= now()
      and (j.locked_by is null or j.locked_at < now() - interval '5 minutes')
    order by j.run_after
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

-- CREATE OR REPLACE preserves grants for an unchanged signature, but
-- reissuing these is a no-op if already correct and cheap insurance
-- otherwise (mirrors 0001_init.sql's grant for this exact function).
revoke all on function claim_awaiting_jobs(text, int) from public, anon, authenticated;
grant execute on function claim_awaiting_jobs(text, int) to service_role;
