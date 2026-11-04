-- The canton backfill and pin resolution ran at the end of the cron, after the
-- source fetches had used up the free plan's 50 external subrequests. Their
-- geo.admin calls failed, and a failure was stored like "no canton found" ("")
-- or as a 6-hour location miss. Clear both so the lookups, now run at the start
-- of each cron invocation and no longer persisting transport failures, retry.
UPDATE outage_events SET canton = NULL WHERE canton = '';

DELETE FROM event_public_location_misses
WHERE attempted_at >= '2026-11-04';
