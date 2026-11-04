-- Bounded D1 reads for the cron's recurring lookups.
--
-- On 2026-11-04 the account ran out of the free plan's 5M rows read/day. The
-- cron's pickers scanned whole tables on every run (every 15 minutes) and
-- mostly returned nothing. Each index below lets one picker walk only the
-- rows it can return. Most are partial indexes: their WHERE must stay
-- identical to the query's WHERE (test/query-plans.test.ts checks the plans).

-- createWorkflowRun: the overlap guard looked at every run ever recorded.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_running
ON workflow_runs(workflow_name, status, started_at);

-- getPendingOutageEventEmails: only events that still qualify for a mail.
CREATE INDEX IF NOT EXISTS idx_outage_events_email_pending
ON outage_events(first_seen_at)
WHERE email_sent = 0
  AND status != 'dismissed' AND origin != 'operator'
  AND (
    COALESCE(event_score, 0) >= 80
    OR (COALESCE(event_score, 0) >= 70 AND evidence_level = 'official')
  );

-- getEventsNeedingIntelligence: only events without score, fact sheet or evidence level.
CREATE INDEX IF NOT EXISTS idx_outage_events_needs_intelligence
ON outage_events(last_seen_at)
WHERE status != 'dismissed' AND origin != 'operator'
  AND (
    COALESCE(event_score, 0) = 0
    OR fact_sheet_json IS NULL
    OR evidence_level IS NULL
  );

-- getHistoricalBackfillTargets: media events in queue order, and a direct
-- probe for "already backfilled" instead of reading every fact of the event.
CREATE INDEX IF NOT EXISTS idx_outage_events_backfill_queue
ON outage_events(COALESCE(received_at, first_seen_at), id)
WHERE country = 'CH' AND status != 'dismissed' AND origin != 'operator';

CREATE INDEX IF NOT EXISTS idx_outage_facts_event_extractor
ON outage_facts(outage_event_id, extractor_version);

-- getUnplannedEventsDueForResearchRefresh: open, unplanned media events of
-- the last day, and the "two research runs per day" counter.
CREATE INDEX IF NOT EXISTS idx_outage_events_open_unplanned
ON outage_events(COALESCE(started_at_estimate, received_at, first_seen_at))
WHERE country = 'CH' AND status NOT IN ('dismissed', 'resolved')
  AND origin != 'operator' AND outage_nature = 'unplanned';

CREATE INDEX IF NOT EXISTS idx_outage_events_research_finished
ON outage_events(research_finished_at);

-- getUnlinkedRelevantItems: relevant items that never got an event, newest
-- first. is_relevant leads so the planner prefers this over idx_alert_items_relevant.
CREATE INDEX IF NOT EXISTS idx_alert_items_unlinked_relevant
ON alert_items(is_relevant, COALESCE(published_at, fetched_at))
WHERE outage_event_id IS NULL
  AND confidence >= 0.65
  AND country IN ('CH', 'unknown');
