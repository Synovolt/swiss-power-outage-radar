import type {
  AiClassification,
  CandidateAssessment,
  CandidateFactInput,
  EventPlace,
  EventMergeSuggestion,
  EvidenceLevel,
  FactSheet,
  FeedLanguage,
  GeoAliasCatalogRow,
  GeoPlace,
  GeoPlaceType,
  EventPlaceRole,
  NormalizedRssItem,
  OutageCandidate,
  OutageEvent,
  OutageFact,
  OutageSource,
  PublicationDecision,
  PublicFeedItem,
  ResearchAssessment,
  ResearchStatus,
  SourcePublicDigest,
  SourceRegistryEntry,
  SourceHealthStatus,
  SourceObservation,
  SourceObservationInput,
  SourceSnapshot,
  StoredAlertItem
} from "./types";
import { canonicalSourceUrl, classifySource } from "./intelligence";
import { attachPublicMapCoords, parsePublicFeedCursor, publicFeedCursor, toPublicFeedItem } from "./publication";
import type { HistoricalBackfillTarget } from "./historical-backfill";

function changes(result: D1Result<unknown>): number {
  const meta = result.meta as { changes?: number } | undefined;
  return meta?.changes ?? 0;
}

export async function createWorkflowRun(db: D1Database, now: string): Promise<number | null> {
  const staleBefore = new Date(new Date(now).getTime() - 20 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO workflow_runs (workflow_name, started_at, status)
       SELECT ?, ?, 'running'
       WHERE NOT EXISTS (
         SELECT 1 FROM workflow_runs
         WHERE workflow_name = ? AND status = 'running' AND started_at >= ?
       )`
    )
    .bind("check-alert-feeds", now, "check-alert-feeds", staleBefore)
    .run();
  if (changes(result) === 0) return null;
  const meta = result.meta as { last_row_id?: number } | undefined;
  if (typeof meta?.last_row_id === "number") return meta.last_row_id;

  const row = await db
    .prepare("SELECT id FROM workflow_runs WHERE started_at = ? ORDER BY id DESC LIMIT 1")
    .bind(now)
    .first<{ id: number }>();
  if (!row) throw new Error("Could not create workflow run");
  return row.id;
}

export async function finishWorkflowRun(
  db: D1Database,
  runId: number,
  status: "success" | "partial_error" | "error",
  stats: {
    itemsSeen: number;
    itemsNew: number;
    itemsFiltered: number;
    itemsClassified: number;
    emailsSent: number;
    error: string | null;
  },
  now: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE workflow_runs
       SET finished_at = ?, status = ?, items_seen = ?, items_new = ?, items_filtered = ?,
           items_classified = ?, emails_sent = ?, error = ?
       WHERE id = ?`
    )
    .bind(
      now,
      status,
      stats.itemsSeen,
      stats.itemsNew,
      stats.itemsFiltered,
      stats.itemsClassified,
      stats.emailsSent,
      stats.error,
      runId
    )
    .run();
}

export async function upsertFeedHealth(
  db: D1Database,
  feedLanguage: FeedLanguage,
  patch: {
    checkedAt: string;
    successAt?: string | null;
    error?: string | null;
    itemsSeen: number;
    itemsNew: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO feed_health (
         feed_language, last_checked_at, last_success_at, last_error,
         items_seen_last_run, items_new_last_run
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(feed_language) DO UPDATE SET
         last_checked_at = excluded.last_checked_at,
         last_success_at = COALESCE(excluded.last_success_at, feed_health.last_success_at),
         last_error = excluded.last_error,
         items_seen_last_run = excluded.items_seen_last_run,
         items_new_last_run = excluded.items_new_last_run`
    )
    .bind(
      feedLanguage,
      patch.checkedAt,
      patch.successAt ?? null,
      patch.error ?? null,
      patch.itemsSeen,
      patch.itemsNew
    )
    .run();
}

export async function insertAlertItem(
  db: D1Database,
  item: NormalizedRssItem,
  hash: string,
  fetchedAt: string
): Promise<{ inserted: boolean; item: StoredAlertItem }> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO alert_items (
         feed_language, title, url, source, snippet, published_at, fetched_at, item_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      item.feed_language,
      item.title,
      item.url,
      item.source,
      item.snippet,
      item.published_at,
      fetchedAt,
      hash
    )
    .run();

  const stored = await getAlertItemByHash(db, hash);
  if (!stored) throw new Error("Inserted alert item could not be loaded");
  return { inserted: changes(result) > 0, item: stored };
}

export async function getAlertItemByHash(
  db: D1Database,
  hash: string
): Promise<StoredAlertItem | null> {
  return await db.prepare("SELECT * FROM alert_items WHERE item_hash = ?").bind(hash).first<StoredAlertItem>();
}

export async function getAlertItemById(
  db: D1Database,
  id: number
): Promise<StoredAlertItem | null> {
  return await db.prepare("SELECT * FROM alert_items WHERE id = ?").bind(id).first<StoredAlertItem>();
}

export async function markFiltered(db: D1Database, id: number, reason: string): Promise<void> {
  await db
    .prepare("UPDATE alert_items SET status = 'filtered', reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(reason, id)
    .run();
}

export async function updateClassification(
  db: D1Database,
  id: number,
  classification: AiClassification,
  raw: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE alert_items
       SET status = 'classified',
           is_relevant = ?,
           confidence = ?,
           country = ?,
           location_text = ?,
           event_type = ?,
           summary = ?,
           reason = ?,
           ai_raw = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      classification.is_relevant ? 1 : 0,
      classification.confidence,
      classification.country,
      classification.location_text,
      classification.event_type,
      classification.summary,
      classification.reason,
      raw,
      id
    )
    .run();
}

export async function markAiError(db: D1Database, id: number, raw: string): Promise<void> {
  await db
    .prepare(
      "UPDATE alert_items SET status = 'ai_error', ai_raw = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .bind(raw, id)
    .run();
}

export async function markEmailSent(db: D1Database, id: number, sentAt: string): Promise<void> {
  await db
    .prepare(
      "UPDATE alert_items SET status = 'email_sent', email_sent = 1, email_sent_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .bind(sentAt, id)
    .run();
}

export async function markAlertLinkedToEvent(
  db: D1Database,
  alertItemId: number,
  outageEventId: number,
  linkedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE alert_items
       SET outage_event_id = ?, event_linked_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(outageEventId, linkedAt, alertItemId)
    .run();
}

export async function markEmailError(db: D1Database, id: number, error: string): Promise<void> {
  await db
    .prepare(
      "UPDATE alert_items SET status = 'email_error', reason = COALESCE(reason, '') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    )
    .bind(` Email error: ${error}`, id)
    .run();
}

export async function getPublicStatus(db: D1Database) {
  const [lastRun, feedHealth, totals, statusCounts, activity, runs, events] = await Promise.all([
    db.prepare("SELECT * FROM workflow_runs ORDER BY id DESC LIMIT 1").first(),
    db.prepare("SELECT * FROM feed_health ORDER BY feed_language").all(),
    db
      .prepare(
        `SELECT
           COUNT(*) AS items_last_24h,
           SUM(CASE WHEN is_relevant = 1 THEN 1 ELSE 0 END) AS relevant_last_24h,
           (
             SELECT COUNT(*)
             FROM outage_events
             WHERE email_sent_at >= datetime('now', '-24 hours')
                OR update_email_sent_at >= datetime('now', '-24 hours')
           ) AS emails_last_24h,
           (SELECT COUNT(*) FROM outage_events WHERE first_seen_at >= datetime('now', '-24 hours')) AS events_last_24h
         FROM alert_items
         WHERE fetched_at >= datetime('now', '-24 hours')`
      )
      .first(),
    db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM outage_events
         GROUP BY status`
      )
      .all(),
    db
      .prepare(
        `WITH RECURSIVE days(day) AS (
           SELECT date('now', '-27 days')
           UNION ALL
           SELECT date(day, '+1 day') FROM days WHERE day < date('now')
         )
         SELECT
           days.day,
           (SELECT COUNT(*) FROM outage_events WHERE date(first_seen_at) = days.day) AS events,
           (SELECT COUNT(*) FROM alert_items WHERE date(fetched_at) = days.day) AS items,
           (SELECT COUNT(*) FROM alert_items WHERE date(fetched_at) = days.day AND is_relevant = 1) AS relevant,
           (
             SELECT COUNT(*)
             FROM outage_events
             WHERE date(email_sent_at) = days.day
                OR date(update_email_sent_at) = days.day
           ) AS emails
         FROM days
         ORDER BY days.day`
      )
      .all(),
    db
      .prepare(
        `SELECT id, started_at, finished_at, status, items_seen, items_new,
                items_filtered, items_classified, emails_sent, error
         FROM workflow_runs
         ORDER BY id DESC
         LIMIT 12`
      )
      .all(),
    db
      .prepare(
        `SELECT id, title, status, event_type, location_text, first_seen_at, last_seen_at,
                started_at_estimate, resolved_at_estimate,
                confidence, source_count, primary_source_title, primary_source_url,
                email_sent_at, update_email_sent_at, merged_into_event_id,
                outage_nature, cause_category, cause_text, research_status,
                research_summary_de, fact_confidence, event_score, evidence_level,
                fact_sheet_json, fact_sheet_updated_at, auto_research_started_at,
                mail_decision_reason, public_status, verification_level,
                location_granularity, event_quality_state, country
         FROM outage_events
         WHERE status != 'dismissed'
           AND country = 'CH'
           AND COALESCE(public_status, 'hidden') != 'hidden'
           AND COALESCE(event_quality_state, 'candidate_only') = 'publishable'
         ORDER BY COALESCE(started_at_estimate, first_seen_at, last_seen_at) DESC
         LIMIT 200`
      )
      .all()
  ]);

  return {
    lastRun,
    feedHealth: feedHealth.results,
    totals,
    statusCounts: statusCounts.results,
    activity: activity.results,
    runs: runs.results,
    events: events.results
  };
}

export async function getDebugStatus(db: D1Database) {
  const [
    runLogs,
    feedHealth,
    eventStats,
    snapshotStats,
    researchStats,
    researchErrors,
    sourceRegistry,
    observationStats,
    qaMetrics,
    recentEvents,
    relevant
  ] = await Promise.all([
    db.prepare("SELECT * FROM workflow_runs ORDER BY id DESC LIMIT 20").all(),
    db.prepare("SELECT * FROM feed_health ORDER BY feed_language").all(),
    db
      .prepare(
        `SELECT
           COUNT(*) AS events_last_24h,
           SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
           SUM(CASE WHEN status = 'corroborated' THEN 1 ELSE 0 END) AS corroborated
         FROM outage_events
         WHERE first_seen_at >= datetime('now', '-24 hours')`
      )
      .first(),
    db
      .prepare(
        `SELECT
           COUNT(*) AS snapshots_total,
           SUM(CASE WHEN fetch_status = 'success' THEN 1 ELSE 0 END) AS snapshots_success,
           SUM(CASE WHEN fetch_status = 'failed' THEN 1 ELSE 0 END) AS snapshots_failed
         FROM source_snapshots`
      )
      .first(),
    db
      .prepare(
        `SELECT COALESCE(research_status, 'not_started') AS research_status, COUNT(*) AS count
         FROM outage_events
         GROUP BY COALESCE(research_status, 'not_started')`
      )
      .all(),
    db
      .prepare(
        `SELECT id, title, location_text, research_status, admin_note, research_finished_at
         FROM outage_events
         WHERE research_status = 'failed'
         ORDER BY research_finished_at DESC, updated_at DESC
         LIMIT 10`
      )
      .all(),
    db
      .prepare(
        `SELECT source_key, operator_name, source_type, COALESCE(source_category, 'live_status') AS source_category,
                area_text, trust_level,
                check_interval_minutes, priority, firecrawl_enabled, last_checked_at,
                last_success_at, last_error, health_status, consecutive_failures
         FROM source_registry
         ORDER BY priority DESC, source_key ASC`
      )
      .all(),
    db
      .prepare(
        `SELECT canonical_status, COUNT(*) AS count, MAX(observed_at) AS latest_observed_at
         FROM source_observations
         GROUP BY canonical_status
         ORDER BY canonical_status`
      )
      .all(),
    db
      .prepare(
        `SELECT metric_date, metric_name, metric_value, numerator, denominator,
                dimension_key, notes, calculated_at
         FROM qa_metrics
         ORDER BY calculated_at DESC, metric_name ASC
         LIMIT 50`
      )
      .all(),
    db
      .prepare(
        `SELECT id, title, status, event_type, location_text, first_seen_at, last_seen_at,
                confidence, source_count, primary_source_title, primary_source_url,
                outage_nature, cause_category, research_status, fact_confidence,
                event_score, evidence_level, mail_decision_reason
         FROM outage_events
         ORDER BY last_seen_at DESC
         LIMIT 20`
      )
      .all(),
    db
      .prepare(
        `SELECT *
         FROM alert_items
         WHERE is_relevant = 1
         ORDER BY COALESCE(published_at, fetched_at) DESC
         LIMIT 20`
      )
      .all()
  ]);

  return {
    run_logs: runLogs.results,
    feed_health: feedHealth.results,
    event_stats: eventStats,
    snapshot_stats: snapshotStats,
    research_status_counts: researchStats.results,
    last_research_errors: researchErrors.results,
    source_registry: sourceRegistry.results,
    source_observation_status_counts: observationStats.results,
    qa_metrics: qaMetrics.results,
    recent_events: recentEvents.results,
    relevant_items: relevant.results
  };
}

export async function getRecentItems(db: D1Database) {
  const result = await db
    .prepare("SELECT * FROM alert_items ORDER BY id DESC LIMIT 20")
    .all();
  return result.results;
}

export async function getPendingEmailItems(db: D1Database): Promise<StoredAlertItem[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM alert_items
       WHERE email_sent = 0
         AND is_relevant = 1
         AND status = 'email_error'
         AND confidence >= 0.65
         AND country IN ('CH', 'unknown')
       ORDER BY COALESCE(published_at, fetched_at) DESC
       LIMIT 20`
    )
    .all<StoredAlertItem>();
  return result.results;
}

export async function getUnlinkedRelevantItems(db: D1Database): Promise<StoredAlertItem[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM alert_items
       WHERE outage_event_id IS NULL
         AND is_relevant = 1
         AND confidence >= 0.65
         AND country IN ('CH', 'unknown')
       ORDER BY COALESCE(published_at, fetched_at) DESC
       LIMIT 20`
    )
    .all<StoredAlertItem>();
  return result.results;
}

export async function getLinkedRelevantItemsNeedingCandidate(
  db: D1Database,
  limit = 20
): Promise<StoredAlertItem[]> {
  const result = await db
    .prepare(
      `SELECT ai.*
       FROM alert_items ai
       WHERE ai.outage_event_id IS NOT NULL
         AND ai.is_relevant = 1
         AND ai.confidence >= 0.65
         AND ai.country IN ('CH', 'unknown')
         AND NOT EXISTS (
           SELECT 1 FROM outage_candidates candidate
           WHERE candidate.alert_item_id = ai.id
         )
       ORDER BY COALESCE(ai.published_at, ai.fetched_at) DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<StoredAlertItem>();
  return result.results;
}

export async function getLatestAlertSnapshot(
  db: D1Database,
  alertItemId: number
): Promise<SourceSnapshot | null> {
  return await db
    .prepare(
      `SELECT *
       FROM source_snapshots
       WHERE alert_item_id = ?
         AND fetch_status = 'success'
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`
    )
    .bind(alertItemId)
    .first<SourceSnapshot>();
}

export async function findCandidateEvents(
  db: D1Database,
  sinceIso: string
): Promise<OutageEvent[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM outage_events
       WHERE status != 'dismissed' AND origin != 'operator'
         AND country = 'CH'
         AND last_seen_at >= ?
       ORDER BY COALESCE(started_at_estimate, first_seen_at, last_seen_at) DESC
       LIMIT 50`
    )
    .bind(sinceIso)
    .all<OutageEvent>();
  return result.results;
}

export async function createOutageEvent(
  db: D1Database,
  input: {
    title: string;
    eventType: string;
    locationText: string;
    normalizedLocation: string;
    canton: string | null;
    country: string;
    seenAt: string;
    receivedAt?: string;
    summary: string;
    reason: string;
    confidence: number;
    primarySourceUrl: string;
    primarySourceTitle: string;
    startedAtEstimate?: string | null;
    resolvedAtEstimate?: string | null;
    publicStatus?: string;
    verificationLevel?: string;
    locationGranularity?: string;
    eventQualityState?: string;
    outageNature?: string;
  }
): Promise<OutageEvent> {
  const result = await db
    .prepare(
      `INSERT INTO outage_events (
         title, status, event_type, location_text, normalized_location, canton, country,
         first_seen_at, last_seen_at, received_at, started_at_estimate, resolved_at_estimate,
         summary, reason, confidence,
         source_count, primary_source_url, primary_source_title,
         public_status, verification_level, location_granularity, event_quality_state,
         outage_nature
       ) VALUES (?, 'needs_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.title,
      input.eventType,
      input.locationText,
      input.normalizedLocation,
      input.canton,
      input.country,
      input.seenAt,
      input.seenAt,
      input.receivedAt ?? new Date().toISOString(),
      input.startedAtEstimate ?? null,
      input.resolvedAtEstimate ?? null,
      input.summary,
      input.reason,
      input.confidence,
      input.primarySourceUrl,
      input.primarySourceTitle,
      input.publicStatus ?? "hidden",
      input.verificationLevel ?? "auto_analyzed",
      input.locationGranularity ?? "unknown",
      input.eventQualityState ?? "candidate_only",
      input.outageNature ?? "unknown"
    )
    .run();

  const meta = result.meta as { last_row_id?: number } | undefined;
  const id = meta?.last_row_id;
  if (typeof id !== "number") throw new Error("Could not create outage event");

  const event = await getOutageEvent(db, id);
  if (!event) throw new Error("Created outage event could not be loaded");
  return event;
}

export async function insertOutageCandidate(
  db: D1Database,
  input: {
    alertItemId: number;
    snapshotId: number | null;
    assessment: CandidateAssessment;
  }
): Promise<OutageCandidate> {
  const status = input.assessment.publishable
    ? "extracted"
    : input.assessment.needs_admin
      ? "needs_admin"
      : "rejected";
  const result = await db
    .prepare(
      `INSERT INTO outage_candidates (
         alert_item_id, snapshot_id, status, location_text, location_granularity,
         is_ch_incident, event_type, relevance_role, quality_score,
         quality_reasons_json, rejection_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.alertItemId,
      input.snapshotId,
      status,
      input.assessment.location_text,
      input.assessment.location_granularity,
      input.assessment.is_ch_incident ? 1 : 0,
      input.assessment.event_type,
      input.assessment.relevance_role,
      input.assessment.quality_score,
      JSON.stringify(input.assessment.quality_reasons),
      input.assessment.rejection_reason
    )
    .run();

  const id = (result.meta as { last_row_id?: number } | undefined)?.last_row_id;
  if (typeof id !== "number") throw new Error("Could not create outage candidate");
  const row = await db.prepare("SELECT * FROM outage_candidates WHERE id = ?").bind(id).first<OutageCandidate>();
  if (!row) throw new Error("Created outage candidate could not be loaded");
  return row;
}

export async function insertOutageFacts(
  db: D1Database,
  input: {
    candidateId: number | null;
    eventId: number | null;
    sourceId: number | null;
    snapshotId: number | null;
    facts: CandidateFactInput[];
  }
): Promise<void> {
  for (const fact of input.facts) {
    await db
      .prepare(
        `INSERT INTO outage_facts (
           candidate_id, outage_event_id, outage_source_id, snapshot_id,
           fact_type, value_text, value_json, confidence, evidence_excerpt,
           source_role, verified_by, source_observation_id, observed_at, extractor_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.candidateId,
        input.eventId,
        input.sourceId,
        input.snapshotId,
        fact.fact_type,
        fact.value_text,
        fact.value_json ?? null,
        fact.confidence,
        fact.evidence_excerpt,
        fact.source_role ?? null,
        fact.verified_by ?? "auto",
        fact.source_observation_id ?? null,
        fact.observed_at ?? null,
        fact.extractor_version ?? null
      )
      .run();
  }
}

export async function getHistoricalBackfillTargets(
  db: D1Database,
  olderThan: string,
  limit = 3
): Promise<HistoricalBackfillTarget[]> {
  const result = await db.prepare(
    `SELECT event.*,
            source.id AS backfill_source_id,
            source.source_url AS backfill_source_url
     FROM outage_events event
     INNER JOIN publication_decisions decision
       ON decision.outage_event_id = event.id AND decision.publishable = 1
     INNER JOIN outage_sources source ON source.id = (
       SELECT candidate.id
       FROM outage_sources candidate
       WHERE candidate.outage_event_id = event.id
       ORDER BY candidate.is_primary DESC, candidate.relation_score DESC, candidate.id ASC
       LIMIT 1
     )
     WHERE event.country = 'CH'
       AND event.status != 'dismissed' AND event.origin != 'operator'
       AND COALESCE(event.received_at, event.first_seen_at) < ?
       AND NOT EXISTS (
         SELECT 1 FROM outage_facts fact
         WHERE fact.outage_event_id = event.id
           AND fact.extractor_version = ?
       )
     ORDER BY COALESCE(event.received_at, event.first_seen_at) ASC, event.id ASC
     LIMIT ?`
  ).bind(olderThan, "historical-backfill/v1", Math.max(1, Math.min(5, limit))).all<HistoricalBackfillTarget>();
  return result.results;
}

export async function insertHistoricalBackfillFacts(
  db: D1Database,
  target: HistoricalBackfillTarget,
  facts: CandidateFactInput[]
): Promise<number> {
  if (facts.length === 0) return 0;
  const statements = facts.map((fact) => db.prepare(
    `INSERT INTO outage_facts (
       candidate_id, outage_event_id, outage_source_id, snapshot_id,
       fact_type, value_text, value_json, confidence, evidence_excerpt,
       source_role, verified_by, source_observation_id, observed_at, extractor_version
     )
     SELECT NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM outage_facts
       WHERE outage_event_id = ?
         AND fact_type = ?
         AND value_text = ?
         AND extractor_version = ?
     )`
  ).bind(
    target.id,
    target.backfill_source_id,
    fact.fact_type,
    fact.value_text,
    fact.value_json ?? null,
    fact.confidence,
    fact.evidence_excerpt,
    fact.source_role ?? null,
    fact.verified_by ?? "auto",
    fact.observed_at ?? null,
    fact.extractor_version ?? null,
    target.id,
    fact.fact_type,
    fact.value_text,
    fact.extractor_version ?? null
  ));
  const results = await db.batch([
    ...statements,
    db.prepare("UPDATE outage_events SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(target.id)
  ]);
  return results.slice(0, statements.length).reduce((total, result) => total + changes(result), 0);
}

export async function linkCandidateToEvent(
  db: D1Database,
  candidateId: number,
  eventId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE outage_candidates
       SET status = 'event_linked',
           outage_event_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(eventId, candidateId)
    .run();
}

export async function attachSourceToEvent(
  db: D1Database,
  input: {
    eventId: number;
    alertItem: StoredAlertItem;
    relationScore: number;
    isPrimary: boolean;
  }
): Promise<OutageSource> {
  const canonicalUrl = canonicalSourceUrl(input.alertItem.url) ?? input.alertItem.url;
  const registrySource = await getSourceRegistryEntryByUrl(db, canonicalUrl);
  const sourceIntel = classifySource({
    url: canonicalUrl,
    title: input.alertItem.title,
    sourceName: input.alertItem.source
  });
  await db
    .prepare(
      `INSERT OR IGNORE INTO outage_sources (
         outage_event_id, alert_item_id, source_url, source_title, source_name,
         published_at, relation_score, is_primary, source_kind, source_weight,
         is_official, independence_key, source_registry_id, source_observation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.eventId,
      input.alertItem.id,
      canonicalUrl,
      input.alertItem.title,
      input.alertItem.source,
      input.alertItem.published_at,
      input.relationScore,
      input.isPrimary ? 1 : 0,
      sourceIntel.source_kind,
      sourceIntel.source_weight,
      sourceIntel.is_official,
      sourceIntel.independence_key,
      registrySource?.id ?? null,
      input.alertItem.source_observation_id ?? null
    )
    .run();

  const source = await db
    .prepare(
      `SELECT *
       FROM outage_sources
       WHERE outage_event_id = ? AND alert_item_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(input.eventId, input.alertItem.id)
    .first<OutageSource>();
  if (!source) throw new Error("Outage source could not be loaded after attach");
  return source;
}

export async function refreshOutageEventAfterSource(
  db: D1Database,
  eventId: number,
  patch: {
    lastSeenAt: string;
    confidence: number;
    summary: string;
    reason: string;
    resolvedAtEstimate?: string | null;
    candidateStatus?: "active" | "resolved" | "unknown";
    lastConfirmedActiveAt?: string | null;
    expectedRestoreAt?: string | null;
  }
): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET first_seen_at = CASE
             WHEN ? < first_seen_at THEN ? ELSE first_seen_at
           END,
           last_seen_at = CASE
             WHEN ? > last_seen_at THEN ? ELSE last_seen_at
           END,
           source_count = (SELECT COUNT(*) FROM outage_sources WHERE outage_event_id = ?),
           status = CASE
             WHEN ? = 'resolved' AND status != 'dismissed'
             THEN 'resolved'
             WHEN (SELECT COUNT(*) FROM outage_sources WHERE outage_event_id = ?) >= 2
                  AND status = 'needs_review'
             THEN 'corroborated'
             ELSE status
           END,
           resolved_at_estimate = COALESCE(resolved_at_estimate, ?),
           last_confirmed_active_at = CASE
             WHEN ? IS NOT NULL AND (last_confirmed_active_at IS NULL OR ? > last_confirmed_active_at)
             THEN ? ELSE last_confirmed_active_at
           END,
           expected_restore_at = COALESCE(?, expected_restore_at),
           time_confidence = CASE
             WHEN ? = 'resolved' AND ? IS NOT NULL THEN 'reported'
             WHEN ? IS NOT NULL THEN 'reported'
             ELSE time_confidence
           END,
           confidence = MAX(confidence, ?),
           summary = CASE WHEN LENGTH(COALESCE(summary, '')) = 0 THEN ? ELSE summary END,
           reason = CASE WHEN LENGTH(COALESCE(reason, '')) = 0 THEN ? ELSE reason END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      patch.lastSeenAt,
      patch.lastSeenAt,
      patch.lastSeenAt,
      patch.lastSeenAt,
      eventId,
      patch.candidateStatus ?? "unknown",
      eventId,
      patch.resolvedAtEstimate ?? null,
      patch.lastConfirmedActiveAt ?? null,
      patch.lastConfirmedActiveAt ?? null,
      patch.lastConfirmedActiveAt ?? null,
      patch.expectedRestoreAt ?? null,
      patch.candidateStatus ?? "unknown",
      patch.resolvedAtEstimate ?? null,
      patch.lastConfirmedActiveAt ?? null,
      patch.confidence,
      patch.summary,
      patch.reason,
      eventId
    )
    .run();

  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Updated outage event could not be loaded");
  return event;
}

export async function recordEventSourcePresence(
  db: D1Database,
  eventId: number,
  sourceRegistryId: number,
  observedAt: string
): Promise<void> {
  await db.prepare(
    `INSERT INTO outage_event_source_presence (
       outage_event_id, source_registry_id, last_confirmed_at,
       first_missing_at, consecutive_missing_checks, updated_at
     ) VALUES (?, ?, ?, NULL, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(outage_event_id, source_registry_id) DO UPDATE SET
       last_confirmed_at = excluded.last_confirmed_at,
       first_missing_at = NULL,
       consecutive_missing_checks = 0,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(eventId, sourceRegistryId, observedAt).run();
  await db.prepare(
    `UPDATE outage_events
     SET last_confirmed_active_at = CASE
           WHEN last_confirmed_active_at IS NULL OR ? > last_confirmed_active_at THEN ?
           ELSE last_confirmed_active_at
         END,
         status = CASE WHEN status = 'resolved' AND time_confidence = 'inferred' THEN 'corroborated' ELSE status END,
         resolution_earliest_at = CASE WHEN time_confidence = 'inferred' THEN NULL ELSE resolution_earliest_at END,
         resolution_latest_at = CASE WHEN time_confidence = 'inferred' THEN NULL ELSE resolution_latest_at END,
         -- A routine "still listed" confirmation is not a change of the event:
         -- bump updated_at only when the state flips back from an inferred close.
         updated_at = CASE WHEN time_confidence = 'inferred' THEN CURRENT_TIMESTAMP ELSE updated_at END,
         time_confidence = CASE WHEN time_confidence = 'inferred' THEN 'reported' ELSE time_confidence END
     WHERE id = ?`
  ).bind(observedAt, observedAt, eventId).run();
}

export async function reconcileSourcePresence(
  db: D1Database,
  sourceRegistryId: number,
  checkedAt: string,
  presentEventIds: number[]
): Promise<void> {
  // The present ids travel as one JSON parameter (D1 allows only 100 bound
  // parameters), and rows stop counting once they reached the closing
  // threshold of 2, so long-gone events are not rewritten on every run.
  await db.prepare(
    `UPDATE outage_event_source_presence
     SET first_missing_at = COALESCE(first_missing_at, ?),
         consecutive_missing_checks = consecutive_missing_checks + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE source_registry_id = ?
       AND consecutive_missing_checks < 2
       AND outage_event_id NOT IN (SELECT value FROM json_each(?))`
  ).bind(checkedAt, sourceRegistryId, JSON.stringify(presentEventIds)).run();

  // The end of an auto-closed outage is bracketed by the polling cadence: it was
  // still listed at the last confirmation and gone at the first missing check.
  // Keeping that window (instead of NULL) is what makes duration statistics possible.
  await db.prepare(
    `UPDATE outage_events
     SET status = 'resolved',
         resolution_earliest_at = (
           SELECT MAX(p.last_confirmed_at) FROM outage_event_source_presence p
           WHERE p.outage_event_id = outage_events.id
         ),
         resolution_latest_at = (
           SELECT MAX(p.first_missing_at) FROM outage_event_source_presence p
           WHERE p.outage_event_id = outage_events.id
         ),
         time_confidence = 'inferred',
         updated_at = CURRENT_TIMESTAMP
     WHERE status NOT IN ('dismissed', 'resolved')
       AND id IN (
         SELECT outage_event_id FROM outage_event_source_presence
         WHERE source_registry_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM outage_event_source_presence p
         WHERE p.outage_event_id = outage_events.id
           AND p.consecutive_missing_checks < 2
       )`
  ).bind(sourceRegistryId).run();
}

export async function markOutageEventEmailSent(
  db: D1Database,
  eventId: number,
  sentAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE outage_events
       SET email_sent = 1, email_sent_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(sentAt, eventId)
    .run();
}

export async function markOutageEventUpdateEmailSent(
  db: D1Database,
  eventId: number,
  sentAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE outage_events
       SET update_email_sent_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(sentAt, eventId)
    .run();
}

export async function getOutageEvent(
  db: D1Database,
  eventId: number
): Promise<OutageEvent | null> {
  return await db.prepare("SELECT * FROM outage_events WHERE id = ?").bind(eventId).first<OutageEvent>();
}

export async function getOutageEventSources(
  db: D1Database,
  eventId: number
): Promise<OutageSource[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM outage_sources
       WHERE outage_event_id = ?
       ORDER BY is_primary DESC, COALESCE(published_at, created_at) DESC`
    )
    .bind(eventId)
    .all<OutageSource>();
  return result.results.map((source) => {
    const intel = classifySource({
      url: source.source_url,
      title: source.source_title,
      sourceName: source.source_name
    });
    const hasUsefulStoredIntel =
      Boolean(source.independence_key) &&
      source.source_kind !== null &&
      source.source_kind !== "other" &&
      source.source_weight !== null &&
      source.is_official !== null;
    if (hasUsefulStoredIntel) return source;

    return {
      ...source,
      source_kind: intel.source_kind,
      source_weight: intel.source_weight,
      is_official: intel.is_official,
      independence_key: intel.independence_key
    };
  });
}

export async function getOutageSourceById(
  db: D1Database,
  sourceId: number
): Promise<OutageSource | null> {
  return await db.prepare("SELECT * FROM outage_sources WHERE id = ?").bind(sourceId).first<OutageSource>();
}

export async function getOutageEventSnapshots(
  db: D1Database,
  eventId: number
): Promise<SourceSnapshot[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM source_snapshots
       WHERE outage_event_id = ?
       ORDER BY fetched_at DESC, id DESC`
    )
    .bind(eventId)
    .all<SourceSnapshot>();
  return result.results;
}

export async function isPublicEvidenceSnapshot(db: D1Database, snapshotId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT snapshot.id
     FROM source_snapshots snapshot
     INNER JOIN outage_events event ON event.id = snapshot.outage_event_id
     INNER JOIN outage_sources source ON source.id = snapshot.outage_source_id
     INNER JOIN publication_decisions decision ON decision.outage_event_id = event.id
     LEFT JOIN outage_facts fact
       ON fact.outage_source_id = source.id AND fact.confidence >= 0.65
     WHERE snapshot.id = ? AND decision.publishable = 1
       AND event.status != 'dismissed' AND event.country = 'CH'
       AND (
         source.source_url = decision.primary_source_url
         OR (
           fact.id IS NOT NULL
           AND source.source_kind IN ('official', 'operator', 'local_media', 'national_media')
         )
       )
     LIMIT 1`
  ).bind(snapshotId).first<{ id: number }>();
  return Boolean(row);
}

export async function getLatestSourceSnapshot(
  db: D1Database,
  sourceId: number
): Promise<SourceSnapshot | null> {
  return await db
    .prepare(
      `SELECT *
       FROM source_snapshots
       WHERE outage_source_id = ?
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`
    )
    .bind(sourceId)
    .first<SourceSnapshot>();
}

export async function getSnapshotsNeedingPublicDigest(
  db: D1Database,
  limit = 20,
  eventId?: number | null
): Promise<Array<{
  snapshot_id: number;
  outage_event_id: number | null;
  outage_source_id: number | null;
  markdown_excerpt: string;
  source_title: string | null;
  source_url: string;
  event_title: string | null;
  event_summary: string | null;
  research_summary_de: string | null;
  location_text: string | null;
}>> {
  const result = await db
    .prepare(
      `SELECT
         ss.id AS snapshot_id,
         ss.outage_event_id,
         ss.outage_source_id,
         ss.markdown_excerpt,
         COALESCE(os.source_title, ss.title) AS source_title,
         COALESCE(os.source_url, ss.final_url, ss.url) AS source_url,
         oe.title AS event_title,
         oe.summary AS event_summary,
         oe.research_summary_de,
         oe.location_text
       FROM source_snapshots ss
       LEFT JOIN outage_sources os ON os.id = ss.outage_source_id
       LEFT JOIN outage_events oe ON oe.id = ss.outage_event_id
       WHERE ss.fetch_status = 'success'
         AND ss.markdown_excerpt IS NOT NULL
         AND trim(ss.markdown_excerpt) != ''
         AND ss.digest_generated_at IS NULL
         AND (? IS NULL OR ss.outage_event_id = ?)
       ORDER BY ss.fetched_at DESC, ss.id DESC
       LIMIT ?`
    )
    .bind(eventId ?? null, eventId ?? null, Math.max(1, Math.min(50, limit)))
    .all<{
      snapshot_id: number;
      outage_event_id: number | null;
      outage_source_id: number | null;
      markdown_excerpt: string;
      source_title: string | null;
      source_url: string;
      event_title: string | null;
      event_summary: string | null;
      research_summary_de: string | null;
      location_text: string | null;
    }>();
  return result.results;
}

export async function getPlaceExtractionTargets(
  db: D1Database,
  limit = 20,
  eventId?: number | null
): Promise<Array<{ source_id: number; outage_event_id: number; alert_item_id: number | null }>> {
  const result = await db
    .prepare(
      `SELECT s.id AS source_id, s.outage_event_id, s.alert_item_id
       FROM outage_sources s
       LEFT JOIN source_place_mentions m ON m.outage_source_id = s.id
       WHERE m.id IS NULL
         AND (? IS NULL OR s.outage_event_id = ?)
       ORDER BY s.id DESC
       LIMIT ?`
    )
    .bind(eventId ?? null, eventId ?? null, limit)
    .all<{ source_id: number; outage_event_id: number; alert_item_id: number | null }>();
  return result.results;
}

export async function insertSourceSnapshot(
  db: D1Database,
  snapshot: {
    alertItemId: number | null;
    outageEventId: number | null;
    outageSourceId: number | null;
    url: string;
    finalUrl: string | null;
    fetchMethod: string;
    fetchStatus: "success" | "failed";
    httpStatus: number | null;
    title: string | null;
    markdownR2Key: string | null;
    markdownExcerpt: string | null;
    contentHash: string | null;
    fetchedAt: string;
    error: string | null;
  }
): Promise<SourceSnapshot> {
  const result = await db
    .prepare(
      `INSERT INTO source_snapshots (
         alert_item_id, outage_event_id, outage_source_id, url, final_url,
         fetch_method, fetch_status, http_status, title, markdown_r2_key,
         markdown_excerpt, content_hash, fetched_at, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      snapshot.alertItemId,
      snapshot.outageEventId,
      snapshot.outageSourceId,
      snapshot.url,
      snapshot.finalUrl,
      snapshot.fetchMethod,
      snapshot.fetchStatus,
      snapshot.httpStatus,
      snapshot.title,
      snapshot.markdownR2Key,
      snapshot.markdownExcerpt,
      snapshot.contentHash,
      snapshot.fetchedAt,
      snapshot.error
    )
    .run();

  const meta = result.meta as { last_row_id?: number } | undefined;
  if (typeof meta?.last_row_id === "number") {
    const row = await db
      .prepare("SELECT * FROM source_snapshots WHERE id = ?")
      .bind(meta.last_row_id)
      .first<SourceSnapshot>();
    if (row) return row;
  }

  const row = await db
    .prepare(
      `SELECT *
       FROM source_snapshots
       WHERE url = ? AND fetched_at = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(snapshot.url, snapshot.fetchedAt)
    .first<SourceSnapshot>();
  if (!row) throw new Error("Source snapshot could not be loaded after insert");
  return row;
}

export async function getDueSourceRegistryEntries(
  db: D1Database,
  nowIso: string,
  limit = 10
): Promise<SourceRegistryEntry[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM source_registry
       WHERE enabled = 1
         AND (
           last_checked_at IS NULL
           OR datetime(last_checked_at, '+' || check_interval_minutes || ' minutes') <= datetime(?)
         )
       ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC, priority DESC
       LIMIT ?`
    )
    .bind(nowIso, Math.max(1, Math.min(50, limit)))
    .all<SourceRegistryEntry>();
  return result.results;
}

export async function getSourceRegistryEntryByUrl(
  db: D1Database,
  url: string
): Promise<SourceRegistryEntry | null> {
  const canonical = canonicalSourceUrl(url);
  if (!canonical) return null;
  const targetHost = new URL(canonical).hostname.replace(/^www\./, "").toLowerCase();
  const rows = await db
    .prepare("SELECT * FROM source_registry WHERE enabled = 1 ORDER BY priority DESC")
    .all<SourceRegistryEntry>();
  return rows.results.find((row) => {
    const registryUrl = canonicalSourceUrl(row.url);
    return registryUrl && new URL(registryUrl).hostname.replace(/^www\./, "").toLowerCase() === targetHost;
  }) ?? null;
}

export async function updateSourceRegistryHealth(
  db: D1Database,
  sourceId: number,
  input: {
    checkedAt: string;
    success: boolean;
    error?: string | null;
    healthStatus?: SourceHealthStatus;
    transportStatus?: "unknown" | "ok" | "error";
    parserStatus?: "unknown" | "ready" | "no_current_outage" | "needs_adapter" | "error";
    lastObservationAt?: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE source_registry
       SET last_checked_at = ?,
           last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
           last_error = ?,
           health_status = ?,
           transport_status = ?,
           parser_status = ?,
           last_observation_at = COALESCE(?, last_observation_at),
           consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      input.checkedAt,
      input.success ? 1 : 0,
      input.checkedAt,
      input.error ?? null,
      input.healthStatus ?? (input.success ? "healthy" : "degraded"),
      input.transportStatus ?? (input.success ? "ok" : "error"),
      input.parserStatus ?? (input.success ? "ready" : "error"),
      input.lastObservationAt ?? null,
      input.success ? 1 : 0,
      sourceId
    )
    .run();
}

export async function insertSourceObservation(
  db: D1Database,
  input: SourceObservationInput
): Promise<{ inserted: boolean; observation: SourceObservation }> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO source_observations (
         source_registry_id, source_key, source_type, operator_name, observation_hash,
         canonical_status, event_type, title, url, location_text, area_text,
         started_at, resolved_at, observed_at, published_at, evidence_excerpt,
         raw_payload_json, extractor_version, confidence, independence_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.sourceRegistryId,
      input.sourceKey,
      input.sourceType,
      input.operatorName,
      input.observationHash,
      input.canonicalStatus,
      input.eventType,
      input.title,
      input.url,
      input.locationText,
      input.areaText,
      input.startedAt,
      input.resolvedAt,
      input.observedAt,
      input.publishedAt,
      input.evidenceExcerpt,
      input.rawPayloadJson,
      input.extractorVersion,
      input.confidence,
      input.independenceKey
    )
    .run();

  const observation = await db
    .prepare("SELECT * FROM source_observations WHERE observation_hash = ?")
    .bind(input.observationHash)
    .first<SourceObservation>();
  if (!observation) throw new Error("Source observation could not be loaded after insert");
  return { inserted: changes(result) > 0, observation };
}

export async function linkSourceObservationToAlert(
  db: D1Database,
  observationId: number,
  alertItemId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE source_observations
       SET alert_item_id = COALESCE(alert_item_id, ?)
       WHERE id = ?`
    )
    .bind(alertItemId, observationId)
    .run();
  await db
    .prepare("UPDATE alert_items SET source_observation_id = ? WHERE id = ?")
    .bind(observationId, alertItemId)
    .run();
}

export async function linkSourceObservationToEvent(
  db: D1Database,
  observationId: number,
  eventId: number,
  sourceId: number
): Promise<void> {
  await db
    .prepare("UPDATE source_observations SET outage_event_id = ? WHERE id = ?")
    .bind(eventId, observationId)
    .run();
  await db
    .prepare(
      `UPDATE outage_sources
       SET source_observation_id = COALESCE(source_observation_id, ?),
           source_registry_id = COALESCE(source_registry_id, (
             SELECT source_registry_id FROM source_observations WHERE id = ?
           ))
       WHERE id = ?`
    )
    .bind(observationId, observationId, sourceId)
    .run();
}

export async function recordEventVersion(
  db: D1Database,
  input: {
    event: OutageEvent;
    changeType: string;
    sourceObservationId?: number | null;
    snapshotId?: number | null;
    evidenceExcerpt?: string | null;
    extractorVersion?: string | null;
  }
): Promise<void> {
  const next = await db
    .prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
       FROM outage_event_versions
       WHERE outage_event_id = ?`
    )
    .bind(input.event.id)
    .first<{ version_number: number }>();
  await db
    .prepare(
      `INSERT INTO outage_event_versions (
         outage_event_id, version_number, change_type, source_observation_id,
         source_snapshot_id, event_state_json, evidence_excerpt, extractor_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.event.id,
      next?.version_number ?? 1,
      input.changeType,
      input.sourceObservationId ?? null,
      input.snapshotId ?? null,
      JSON.stringify(input.event),
      input.evidenceExcerpt ?? null,
      input.extractorVersion ?? null
    )
    .run();
}

export async function upsertQaMetric(
  db: D1Database,
  input: {
    metricDate: string;
    metricName: string;
    metricValue: number;
    numerator?: number | null;
    denominator?: number | null;
    dimensionKey?: string | null;
    notes?: string | null;
    calculatedAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO qa_metrics (
         metric_date, metric_name, metric_value, numerator, denominator,
         dimension_key, notes, calculated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(metric_date, metric_name, dimension_key) DO UPDATE SET
         metric_value = excluded.metric_value,
         numerator = excluded.numerator,
         denominator = excluded.denominator,
         notes = excluded.notes,
         calculated_at = excluded.calculated_at`
    )
    .bind(
      input.metricDate,
      input.metricName,
      input.metricValue,
      input.numerator ?? null,
      input.denominator ?? null,
      input.dimensionKey ?? null,
      input.notes ?? null,
      input.calculatedAt
    )
    .run();
}

export async function updateSourceSnapshotDigest(
  db: D1Database,
  snapshotId: number,
  digest: SourcePublicDigest | null,
  generatedAt: string,
  error: string | null = null
): Promise<void> {
  await db
    .prepare(
      `UPDATE source_snapshots
       SET public_summary_de = ?,
           public_key_points_json = ?,
           public_relevance_label = ?,
           public_facts_json = ?,
           digest_generated_at = ?,
           digest_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      digest?.summary_de ?? null,
      digest ? JSON.stringify(digest.key_points.slice(0, 5)) : null,
      digest?.relevance_label ?? null,
      digest ? JSON.stringify(digest.facts ?? {}) : null,
      generatedAt,
      error,
      snapshotId
    )
    .run();
}

export async function getKnownSourceUrlsForEvent(
  db: D1Database,
  eventId: number
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT source_url AS url FROM outage_sources WHERE outage_event_id = ?
       UNION
       SELECT url FROM source_snapshots WHERE outage_event_id = ?`
    )
    .bind(eventId, eventId)
    .all<{ url: string }>();
  return result.results.map((row) => row.url);
}

export async function startEventResearch(
  db: D1Database,
  eventId: number,
  startedAt: string,
  options: { automatic?: boolean } = {}
): Promise<boolean> {
  const statusPredicate = options.automatic
    ? "COALESCE(research_status, 'not_started') = 'not_started' AND auto_research_started_at IS NULL"
    : "COALESCE(research_status, 'not_started') != 'running'";

  const result = await db
    .prepare(
      `UPDATE outage_events
       SET research_status = 'running',
           research_started_at = ?,
           auto_research_started_at = CASE
             WHEN ? = 1 AND auto_research_started_at IS NULL THEN ?
             ELSE auto_research_started_at
           END,
           research_finished_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND ${statusPredicate}`
    )
    .bind(startedAt, options.automatic ? 1 : 0, startedAt, eventId)
    .run();
  return changes(result) > 0;
}

export async function finishEventResearch(
  db: D1Database,
  eventId: number,
  status: Extract<ResearchStatus, "completed" | "failed">,
  finishedAt: string,
  error: string | null
): Promise<void> {
  const event = await getOutageEvent(db, eventId);
  await db
    .prepare(
      `UPDATE outage_events
       SET research_status = ?,
           research_finished_at = ?,
           admin_note = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      status,
      finishedAt,
      error ? composeAdminNote(event?.admin_note ?? null, error, "research failed") : event?.admin_note ?? null,
      eventId
    )
    .run();
}

export async function updateEventResearchAssessment(
  db: D1Database,
  eventId: number,
  assessment: ResearchAssessment,
  factSheet?: FactSheet | null
): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET outage_nature = ?,
           cause_category = ?,
           cause_text = ?,
           status = CASE
             WHEN ? = 'resolved' AND status != 'dismissed' THEN 'resolved'
             ELSE status
           END,
           research_summary_de = ?,
           fact_confidence = ?,
           fact_sheet_json = COALESCE(?, fact_sheet_json),
           fact_sheet_updated_at = CASE WHEN ? IS NULL THEN fact_sheet_updated_at ELSE CURRENT_TIMESTAMP END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      assessment.outage_nature,
      assessment.cause_category,
      assessment.cause_text,
      assessment.status,
      assessment.research_summary_de,
      assessment.fact_confidence,
      factSheet ? JSON.stringify(factSheet) : null,
      factSheet ? 1 : null,
      eventId
    )
    .run();

  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Event vanished after research assessment update");
  return event;
}

export async function getOutageEventFacts(
  db: D1Database,
  eventId: number
): Promise<OutageFact[]> {
  const result = await db
    .prepare(
      `SELECT fact.*, candidate.alert_item_id
       FROM outage_facts fact
       LEFT JOIN outage_candidates candidate ON candidate.id = fact.candidate_id
       WHERE fact.outage_event_id = ?
       ORDER BY fact.confidence DESC, fact.id ASC`
    )
    .bind(eventId)
    .all<OutageFact>();
  return result.results;
}

function publicationDecisionStatements(
  db: D1Database,
  event: OutageEvent,
  decision: PublicationDecision,
  decidedAt: string
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO publication_decisions (
           outage_event_id, publishable, trust, reasons_json, public_summary,
           primary_source_publisher, primary_source_url, primary_source_domain,
           evaluator_version, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'strict-publication/v1', ?)
         ON CONFLICT(outage_event_id) DO UPDATE SET
           publishable = excluded.publishable,
           trust = excluded.trust,
           reasons_json = excluded.reasons_json,
           public_summary = excluded.public_summary,
           primary_source_publisher = excluded.primary_source_publisher,
           primary_source_url = excluded.primary_source_url,
           primary_source_domain = excluded.primary_source_domain,
           evaluator_version = excluded.evaluator_version,
           decided_at = excluded.decided_at`
      )
      .bind(
        event.id,
        decision.publishable ? 1 : 0,
        decision.trust,
        JSON.stringify(decision.reasons),
        decision.summary,
        decision.primary_source?.publisher ?? null,
        decision.primary_source?.url ?? null,
        decision.primary_source?.domain ?? null,
        decidedAt
      )
  ];
}

export async function applyPublicationDecision(
  db: D1Database,
  event: OutageEvent,
  decision: PublicationDecision,
  decidedAt = new Date().toISOString()
): Promise<OutageEvent> {
  await db.batch(publicationDecisionStatements(db, event, decision, decidedAt));

  const updated = await getOutageEvent(db, event.id);
  if (!updated) throw new Error("Event vanished after publication decision");
  return updated;
}

export async function applyPublicationDecisions(
  db: D1Database,
  entries: Array<{ event: OutageEvent; decision: PublicationDecision }>,
  decidedAt = new Date().toISOString()
): Promise<void> {
  if (entries.length === 0) return;
  await db.batch(entries.flatMap(({ event, decision }) =>
    publicationDecisionStatements(db, event, decision, decidedAt)
  ));
}

export async function recordPublicationRevalidationRun(
  db: D1Database,
  report: {
    apply: boolean;
    assessed: number;
    publishable_before: number;
    publishable_after: number;
    changed: number;
    decisions: unknown[];
  },
  createdAt = new Date().toISOString()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO publication_revalidation_runs (
         apply_mode, assessed, publishable_before, publishable_after,
         changed, decisions_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      report.apply ? 1 : 0,
      report.assessed,
      report.publishable_before,
      report.publishable_after,
      report.changed,
      JSON.stringify(report.decisions),
      createdAt
    )
    .run();
}

export async function getEnabledSourceAuthorityHosts(db: D1Database): Promise<Set<string>> {
  const result = await db
    .prepare("SELECT hostname FROM source_authorities WHERE enabled = 1 AND trust_level = 'official'")
    .all<{ hostname: string }>();
  return new Set(result.results.map((row) => row.hostname.replace(/^www\./, "").toLowerCase()));
}

export async function getEventsForPublicationRevalidation(
  db: D1Database,
  limit = 50
): Promise<OutageEvent[]> {
  const result = await db
    .prepare(
      `SELECT * FROM outage_events
       WHERE status != 'dismissed' AND country = 'CH' AND origin != 'operator'
       ORDER BY COALESCE(received_at, created_at, first_seen_at) DESC
       LIMIT ?`
    )
    .bind(Math.max(1, Math.min(50, Number.isFinite(limit) ? limit : 50)))
    .all<OutageEvent>();
  return result.results;
}

export async function getPublicationEvidenceForEvents(
  db: D1Database,
  eventIds: number[]
): Promise<{ sources: Map<number, OutageSource[]>; facts: Map<number, OutageFact[]> }> {
  const sources = new Map<number, OutageSource[]>();
  const facts = new Map<number, OutageFact[]>();
  if (eventIds.length === 0) return { sources, facts };
  const placeholders = eventIds.map(() => "?").join(", ");
  const [sourceRows, factRows] = await Promise.all([
    db
      .prepare(`SELECT * FROM outage_sources WHERE outage_event_id IN (${placeholders}) ORDER BY id ASC`)
      .bind(...eventIds)
      .all<OutageSource>(),
    db
      .prepare(
        `SELECT fact.*, candidate.alert_item_id
         FROM outage_facts fact
         LEFT JOIN outage_candidates candidate ON candidate.id = fact.candidate_id
         WHERE fact.outage_event_id IN (${placeholders})
         ORDER BY fact.confidence DESC, fact.id ASC`
      )
      .bind(...eventIds)
      .all<OutageFact>()
  ]);
  for (const source of sourceRows.results) {
    sources.set(source.outage_event_id, [...(sources.get(source.outage_event_id) ?? []), source]);
  }
  for (const fact of factRows.results) {
    if (typeof fact.outage_event_id !== "number") continue;
    facts.set(fact.outage_event_id, [...(facts.get(fact.outage_event_id) ?? []), fact]);
  }
  return { sources, facts };
}

export async function getPublicFeedItems(
  db: D1Database,
  input: { limit?: number; before?: string | null } = {}
): Promise<{ items: PublicFeedItem[]; next_cursor: string | null }> {
  const requestedLimit = Number(input.limit ?? 10);
  const limit = Math.max(1, Math.min(40, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : 10)));
  const cursor = parsePublicFeedCursor(input.before);
  const result = await db
    .prepare(
      `SELECT event.*, decision.trust AS publication_trust,
              decision.public_summary AS publication_summary,
              decision.primary_source_publisher, decision.primary_source_url,
              decision.primary_source_domain, decision.reasons_json,
              loc.latitude AS map_latitude,
              loc.longitude AS map_longitude,
              loc.precision AS map_precision,
              COALESCE(
                event.started_at_estimate,
                event.resolved_at_estimate,
                event.received_at,
                event.created_at,
                event.first_seen_at
              ) AS feed_sort_at
       FROM outage_events event
       INNER JOIN publication_decisions decision ON decision.outage_event_id = event.id
       LEFT JOIN event_public_locations loc ON loc.outage_event_id = event.id
       WHERE decision.publishable = 1
         AND event.status != 'dismissed'
         AND event.country = 'CH'
         AND (
           (? IS NULL AND 1 = 1)
           OR (
             NOT (event.outage_nature = 'planned' AND julianday(event.started_at_estimate) > julianday('now'))
             AND COALESCE(
               event.started_at_estimate,
               event.resolved_at_estimate,
               event.received_at,
               event.created_at,
               event.first_seen_at
             ) < ?
           )
           OR (
             NOT (event.outage_nature = 'planned' AND julianday(event.started_at_estimate) > julianday('now'))
             AND
             COALESCE(
               event.started_at_estimate,
               event.resolved_at_estimate,
               event.received_at,
               event.created_at,
               event.first_seen_at
             ) = ?
             AND event.id < ?
           )
         )
       ORDER BY
         CASE WHEN event.outage_nature = 'planned'
           AND julianday(event.started_at_estimate) > julianday('now') THEN 0 ELSE 1 END,
         CASE WHEN event.outage_nature = 'planned'
           AND julianday(event.started_at_estimate) > julianday('now') THEN event.started_at_estimate END ASC,
         COALESCE(
           event.started_at_estimate,
           event.resolved_at_estimate,
           event.received_at,
           event.created_at,
           event.first_seen_at
         ) DESC,
         event.id DESC
       LIMIT ?`
    )
    .bind(
      cursor?.receivedAt ?? null,
      cursor?.receivedAt ?? null,
      cursor?.receivedAt ?? null,
      cursor?.id ?? null,
      limit
    )
    .all<OutageEvent & {
      publication_trust: "official" | "corroborated" | "reported";
      publication_summary: string;
      primary_source_publisher: string;
      primary_source_url: string;
      primary_source_domain: string;
      reasons_json: string;
      feed_sort_at: string;
      map_latitude: number | null;
      map_longitude: number | null;
      map_precision: PublicFeedItem["map_precision"];
    }>();

  const evidence = await getPublicationEvidenceForEvents(db, result.results.map((row) => row.id));
  const entries = result.results.flatMap((row) => {
    const item = attachPublicMapCoords(
      toPublicFeedItem(
        row,
        {
          publishable: true,
          trust: row.publication_trust,
          reasons: [],
          summary: row.publication_summary,
          primary_source: {
            publisher: row.primary_source_publisher,
            url: row.primary_source_url,
            domain: row.primary_source_domain
          }
        },
        evidence.facts.get(row.id) ?? []
      ),
      {
        latitude: row.map_latitude,
        longitude: row.map_longitude,
        precision: row.map_precision
      }
    );
    return item ? [{ item, sortAt: row.feed_sort_at }] : [];
  });
  const items = entries.map((entry) => entry.item);
  const lastEntry = entries.at(-1);
  return {
    items,
    next_cursor: items.length === limit && lastEntry
      ? publicFeedCursor({ id: lastEntry.item.id, received_at: lastEntry.sortAt })
      : null
  };
}

export async function getPublicFeedItem(db: D1Database, eventId: number): Promise<PublicFeedItem | null> {
  const [row, evidence] = await Promise.all([db
    .prepare(
      `SELECT event.*, decision.trust AS publication_trust,
              decision.public_summary AS publication_summary,
              decision.primary_source_publisher, decision.primary_source_url,
              decision.primary_source_domain,
              loc.latitude AS map_latitude,
              loc.longitude AS map_longitude,
              loc.precision AS map_precision
       FROM outage_events event
       INNER JOIN publication_decisions decision ON decision.outage_event_id = event.id
       LEFT JOIN event_public_locations loc ON loc.outage_event_id = event.id
       WHERE event.id = ? AND decision.publishable = 1
         AND event.status != 'dismissed' AND event.country = 'CH'
       LIMIT 1`
    )
    .bind(eventId)
    .first<OutageEvent & {
      publication_trust: "official" | "corroborated" | "reported";
      publication_summary: string;
      primary_source_publisher: string;
      primary_source_url: string;
      primary_source_domain: string;
      map_latitude: number | null;
      map_longitude: number | null;
      map_precision: PublicFeedItem["map_precision"];
    }>(), getPublicationEvidenceForEvents(db, [eventId])]);
  if (!row) return null;
  return attachPublicMapCoords(
    toPublicFeedItem(row, {
      publishable: true,
      trust: row.publication_trust,
      reasons: [],
      summary: row.publication_summary,
      primary_source: {
        publisher: row.primary_source_publisher,
        url: row.primary_source_url,
        domain: row.primary_source_domain
      }
    }, evidence.facts.get(eventId) ?? []),
    {
      latitude: row.map_latitude,
      longitude: row.map_longitude,
      precision: row.map_precision
    }
  );
}

export async function getUnplannedEventsDueForResearchRefresh(
  db: D1Database,
  now: string,
  limit = 1
): Promise<OutageEvent[]> {
  const staleBefore = new Date(new Date(now).getTime() - 6 * 60 * 60 * 1000).toISOString();
  const activeWindowStart = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const dayBefore = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(
    `SELECT event.*
     FROM outage_events event
     INNER JOIN publication_decisions decision ON decision.outage_event_id = event.id
     WHERE decision.publishable = 1
       AND event.country = 'CH'
       AND event.status NOT IN ('dismissed', 'resolved') AND event.origin != 'operator'
       AND event.outage_nature = 'unplanned'
       AND COALESCE(event.started_at_estimate, event.received_at, event.first_seen_at) >= ?
       AND COALESCE(event.research_status, 'not_started') != 'running'
       AND COALESCE(event.research_finished_at, event.auto_research_started_at, event.first_seen_at) < ?
       AND (SELECT COUNT(*) FROM outage_events WHERE research_finished_at >= ?) < 2
     ORDER BY COALESCE(event.research_finished_at, event.auto_research_started_at, event.first_seen_at) ASC
     LIMIT ?`
  ).bind(activeWindowStart, staleBefore, dayBefore, Math.max(1, Math.min(2, limit))).all<OutageEvent>();
  return result.results;
}

export async function createGeoSyncRun(
  db: D1Database,
  input: { provider: string; scope: string; startedAt: string }
): Promise<number> {
  const result = await db
    .prepare("INSERT INTO geo_sync_runs (provider, scope, started_at, status) VALUES (?, ?, ?, 'running')")
    .bind(input.provider, input.scope, input.startedAt)
    .run();
  const id = (result.meta as { last_row_id?: number } | undefined)?.last_row_id;
  if (typeof id !== "number") throw new Error("Could not create geo sync run");
  return id;
}

export async function finishGeoSyncRun(
  db: D1Database,
  id: number,
  input: { status: "success" | "failed"; itemsSeen: number; itemsUpserted: number; error?: string | null }
): Promise<void> {
  await db
    .prepare(
      `UPDATE geo_sync_runs
       SET finished_at = ?, status = ?, items_seen = ?, items_upserted = ?, error = ?
       WHERE id = ?`
    )
    .bind(new Date().toISOString(), input.status, input.itemsSeen, input.itemsUpserted, input.error ?? null, id)
    .run();
}

export async function upsertGeoPlace(
  db: D1Database,
  place: {
    externalId: string;
    country?: string;
    cantonKey?: string | null;
    cantonCode?: string | null;
    cantonName?: string | null;
    districtKey?: string | null;
    districtName?: string | null;
    municipalityKey?: string | null;
    municipalityName?: string | null;
    localityKey?: string | null;
    localityName?: string | null;
    postcode?: string | null;
    streetName?: string | null;
    placeType: GeoPlaceType;
    canonicalName: string;
    normalizedName: string;
    parentExternalId?: string | null;
    source: string;
    sourceUpdatedAt?: string | null;
  }
): Promise<GeoPlace> {
  await db
    .prepare(
      `INSERT INTO geo_places (
         external_id, country, canton_key, canton_code, canton_name,
         district_key, district_name, municipality_key, municipality_name,
         locality_key, locality_name, postcode, street_name, place_type,
         canonical_name, normalized_name, parent_external_id, source, source_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         country = excluded.country,
         canton_key = excluded.canton_key,
         canton_code = excluded.canton_code,
         canton_name = excluded.canton_name,
         district_key = excluded.district_key,
         district_name = excluded.district_name,
         municipality_key = excluded.municipality_key,
         municipality_name = excluded.municipality_name,
         locality_key = excluded.locality_key,
         locality_name = excluded.locality_name,
         postcode = excluded.postcode,
         street_name = excluded.street_name,
         place_type = excluded.place_type,
         canonical_name = excluded.canonical_name,
         normalized_name = excluded.normalized_name,
         parent_external_id = excluded.parent_external_id,
         source = excluded.source,
         source_updated_at = excluded.source_updated_at,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      place.externalId,
      place.country ?? "CH",
      place.cantonKey ?? null,
      place.cantonCode ?? null,
      place.cantonName ?? null,
      place.districtKey ?? null,
      place.districtName ?? null,
      place.municipalityKey ?? null,
      place.municipalityName ?? null,
      place.localityKey ?? null,
      place.localityName ?? null,
      place.postcode ?? null,
      place.streetName ?? null,
      place.placeType,
      place.canonicalName,
      place.normalizedName,
      place.parentExternalId ?? null,
      place.source,
      place.sourceUpdatedAt ?? null
    )
    .run();

  const row = await db.prepare("SELECT * FROM geo_places WHERE external_id = ?").bind(place.externalId).first<GeoPlace>();
  if (!row) throw new Error("Geo place could not be loaded after upsert");
  return row;
}

export async function upsertGeoPlaceAlias(
  db: D1Database,
  input: { placeId: number; alias: string; normalizedAlias: string; language?: string | null; source: string }
): Promise<void> {
  if (!input.normalizedAlias || input.normalizedAlias.length < 2) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO geo_place_aliases
       (place_id, alias, normalized_alias, language, source)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(input.placeId, input.alias, input.normalizedAlias, input.language ?? null, input.source)
    .run();
}

export async function getGeoAliasCatalog(
  db: D1Database,
  limit = 8000
): Promise<GeoAliasCatalogRow[]> {
  const result = await db
    .prepare(
      `SELECT p.*, a.alias, a.normalized_alias
       FROM geo_place_aliases a
       JOIN geo_places p ON p.id = a.place_id
       WHERE p.country = 'CH'
       ORDER BY LENGTH(a.normalized_alias) DESC, p.place_type ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<GeoAliasCatalogRow>();
  return result.results;
}

export async function replaceSourcePlaceMentions(
  db: D1Database,
  input: {
    eventId: number;
    sourceId: number;
    alertItemId: number | null;
    rawText: string;
    mentions: Array<{
      matchedText: string;
      placeId: number;
      placeType: GeoPlaceType;
      role: EventPlaceRole;
      confidence: number;
      matchMethod: string;
      evidenceQuote: string;
    }>;
  }
): Promise<void> {
  await db.prepare("DELETE FROM source_place_mentions WHERE outage_source_id = ?").bind(input.sourceId).run();
  for (const mention of input.mentions) {
    await db
      .prepare(
        `INSERT INTO source_place_mentions (
           outage_source_id, alert_item_id, outage_event_id, raw_text, matched_text,
           place_id, place_type, role, confidence, match_method, evidence_quote
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.sourceId,
        input.alertItemId,
        input.eventId,
        input.rawText.slice(0, 4000),
        mention.matchedText,
        mention.placeId,
        mention.placeType,
        mention.role,
        mention.confidence,
        mention.matchMethod,
        mention.evidenceQuote.slice(0, 800)
      )
      .run();
  }
}

export async function refreshEventPlaces(db: D1Database, eventId: number): Promise<EventPlace[]> {
  const mentions = await db
    .prepare(
      `SELECT place_id, role, COUNT(DISTINCT COALESCE(outage_source_id, alert_item_id)) AS source_count,
              MAX(confidence) AS confidence,
              MIN(created_at) AS first_seen_at,
              MAX(created_at) AS last_seen_at
       FROM source_place_mentions
       WHERE outage_event_id = ? AND place_id IS NOT NULL
       GROUP BY place_id, role`
    )
    .bind(eventId)
    .all<{ place_id: number; role: EventPlaceRole; source_count: number; confidence: number; first_seen_at: string; last_seen_at: string }>();

  for (const row of mentions.results) {
    await db
      .prepare(
        `INSERT INTO event_places (
           outage_event_id, place_id, role, confidence, source_count, first_seen_at, last_seen_at, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(outage_event_id, place_id) DO UPDATE SET
           role = CASE
             WHEN event_places.role = 'affected' THEN event_places.role
             WHEN excluded.role = 'affected' THEN excluded.role
             WHEN event_places.role = 'possibly_affected' THEN event_places.role
             ELSE excluded.role
           END,
           confidence = MAX(event_places.confidence, excluded.confidence),
           source_count = excluded.source_count,
           first_seen_at = COALESCE(event_places.first_seen_at, excluded.first_seen_at),
           last_seen_at = excluded.last_seen_at,
           reason = excluded.reason,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(
        eventId,
        row.place_id,
        row.role,
        row.confidence,
        row.source_count,
        row.first_seen_at,
        row.last_seen_at,
        `Deterministisch aus ${row.source_count} Quelle(n) erkannt`
      )
      .run();
  }

  return await getEventPlaces(db, eventId);
}

export async function getEventPlaces(db: D1Database, eventId: number): Promise<EventPlace[]> {
  const result = await db
    .prepare(
      `SELECT ep.*, p.external_id, p.country, p.canton_key, p.canton_code, p.canton_name,
              p.district_key, p.district_name, p.municipality_key, p.municipality_name,
              p.locality_key, p.locality_name, p.postcode, p.street_name, p.place_type,
              p.canonical_name, p.normalized_name, p.parent_external_id, p.source,
              p.source_updated_at, p.created_at AS place_created_at, p.updated_at AS place_updated_at
       FROM event_places ep
       JOIN geo_places p ON p.id = ep.place_id
       WHERE ep.outage_event_id = ?
       ORDER BY
         CASE ep.role WHEN 'affected' THEN 1 WHEN 'possibly_affected' THEN 2 WHEN 'context' THEN 3 ELSE 4 END,
         ep.confidence DESC,
         p.place_type DESC,
         p.canonical_name ASC`
    )
    .bind(eventId)
    .all<Record<string, unknown>>();

  const rows = result.results.map((row) => ({
    id: Number(row.id),
    outage_event_id: Number(row.outage_event_id),
    place_id: Number(row.place_id),
    role: row.role as EventPlaceRole,
    confidence: Number(row.confidence),
    source_count: Number(row.source_count),
    first_seen_at: row.first_seen_at as string | null,
    last_seen_at: row.last_seen_at as string | null,
    reason: row.reason as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    place: {
      id: Number(row.place_id),
      external_id: row.external_id as string,
      country: row.country as string,
      canton_key: row.canton_key as string | null,
      canton_code: row.canton_code as string | null,
      canton_name: row.canton_name as string | null,
      district_key: row.district_key as string | null,
      district_name: row.district_name as string | null,
      municipality_key: row.municipality_key as string | null,
      municipality_name: row.municipality_name as string | null,
      locality_key: row.locality_key as string | null,
      locality_name: row.locality_name as string | null,
      postcode: row.postcode as string | null,
      street_name: row.street_name as string | null,
      place_type: row.place_type as GeoPlaceType,
      canonical_name: row.canonical_name as string,
      normalized_name: row.normalized_name as string,
      parent_external_id: row.parent_external_id as string | null,
      source: row.source as string,
      source_updated_at: row.source_updated_at as string | null,
      created_at: row.place_created_at as string,
      updated_at: row.place_updated_at as string
    }
  }));

  const deduped = new Map<string, EventPlace>();
  for (const row of rows) {
    const key = `${row.role}:${row.place?.place_type}:${row.place?.canonical_name}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, row);
      continue;
    }
    existing.confidence = Math.max(existing.confidence, row.confidence);
    existing.source_count = Math.max(existing.source_count, row.source_count);
    existing.first_seen_at = [existing.first_seen_at, row.first_seen_at].filter(Boolean).sort()[0] ?? null;
    existing.last_seen_at = [existing.last_seen_at, row.last_seen_at].filter(Boolean).sort().at(-1) ?? null;
  }
  return [...deduped.values()];
}

export async function updateEventIntelligence(
  db: D1Database,
  eventId: number,
  input: {
    eventScore: number;
    evidenceLevel: EvidenceLevel;
    factSheet: FactSheet;
    mailDecisionReason?: string | null;
  }
): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET event_score = ?,
           evidence_level = ?,
           fact_sheet_json = ?,
           fact_sheet_updated_at = ?,
           mail_decision_reason = COALESCE(?, mail_decision_reason),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      input.eventScore,
      input.evidenceLevel,
      JSON.stringify(input.factSheet),
      input.factSheet.generated_at,
      input.mailDecisionReason ?? null,
      eventId
    )
    .run();

  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Event vanished after intelligence update");
  return event;
}

export async function markOutageEventPublishable(
  db: D1Database,
  eventId: number,
  input: {
    publicStatus: string;
    verificationLevel: string;
    locationGranularity: string;
    eventQualityState: string;
    outageNature: string;
    startedAtEstimate?: string | null;
  }
): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET started_at_estimate = COALESCE(started_at_estimate, ?),
           public_status = ?,
           verification_level = ?,
           location_granularity = ?,
           event_quality_state = ?,
           country = 'CH',
           outage_nature = CASE
             WHEN COALESCE(outage_nature, 'unknown') = 'unknown' THEN ?
             ELSE outage_nature
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      input.startedAtEstimate ?? null,
      input.publicStatus,
      input.verificationLevel,
      input.locationGranularity,
      input.eventQualityState,
      input.outageNature,
      eventId
    )
    .run();

  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Event vanished after quality update");
  return event;
}

export async function updateOutageEventCandidateDetails(
  db: D1Database,
  eventId: number,
  input: {
    locationGranularity: string;
    outageNature: string;
    startedAtEstimate?: string | null;
  }
): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET started_at_estimate = COALESCE(started_at_estimate, ?),
           location_granularity = ?,
           country = 'CH',
           outage_nature = CASE
             WHEN COALESCE(outage_nature, 'unknown') = 'unknown' THEN ?
             ELSE outage_nature
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(input.startedAtEstimate ?? null, input.locationGranularity, input.outageNature, eventId)
    .run();
  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Event vanished after candidate detail update");
  return event;
}

export async function updateOutageEventPublicationGate(
  db: D1Database,
  eventId: number,
  input: {
    publicStatus: string;
    verificationLevel: string;
    eventQualityState: string;
    mailDecisionReason: string;
  }
): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET public_status = ?,
           verification_level = ?,
           event_quality_state = ?,
           mail_decision_reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      input.publicStatus,
      input.verificationLevel,
      input.eventQualityState,
      input.mailDecisionReason,
      eventId
    )
    .run();

  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Event vanished after publication gate update");
  return event;
}

export async function updateOutageEventMailDecision(
  db: D1Database,
  eventId: number,
  reason: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE outage_events
       SET mail_decision_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(reason, eventId)
    .run();
}

export async function upsertMergeSuggestion(
  db: D1Database,
  input: {
    sourceEventId: number;
    targetEventId: number;
    heuristicScore: number;
    aiConfidence: number | null;
    sameEvent: boolean;
    reason: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_merge_suggestions (
         source_event_id, target_event_id, heuristic_score, ai_confidence,
         same_event, reason, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'open')
       ON CONFLICT(source_event_id, target_event_id) DO UPDATE SET
         heuristic_score = excluded.heuristic_score,
         ai_confidence = excluded.ai_confidence,
         same_event = excluded.same_event,
         reason = excluded.reason,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      input.sourceEventId,
      input.targetEventId,
      input.heuristicScore,
      input.aiConfidence,
      input.sameEvent ? 1 : 0,
      input.reason
    )
    .run();
}

export async function getMergeSuggestionsForEvent(
  db: D1Database,
  eventId: number
): Promise<EventMergeSuggestion[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM event_merge_suggestions
       WHERE source_event_id = ?
         AND status = 'open'
       ORDER BY same_event DESC, COALESCE(ai_confidence, 0) DESC, heuristic_score DESC
       LIMIT 8`
    )
    .bind(eventId)
    .all<EventMergeSuggestion>();
  return result.results;
}

export async function refreshOutageEventSourceCount(
  db: D1Database,
  eventId: number
): Promise<OutageEvent> {
  return await refreshOutageEventAggregates(db, eventId);
}

export async function getPendingOutageEventEmails(db: D1Database): Promise<OutageEvent[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM outage_events
       WHERE email_sent = 0
         AND status != 'dismissed' AND origin != 'operator'
         AND (
           COALESCE(event_score, 0) >= 80
           OR (COALESCE(event_score, 0) >= 70 AND evidence_level = 'official')
         )
       ORDER BY first_seen_at DESC
       LIMIT 10`
    )
    .all<OutageEvent>();
  return result.results;
}

export async function getEventsNeedingIntelligence(
  db: D1Database,
  limit = 5
): Promise<OutageEvent[]> {
  const result = await db
    .prepare(
      `SELECT *
       FROM outage_events
       WHERE status != 'dismissed' AND origin != 'operator'
         AND (
           COALESCE(event_score, 0) = 0
           OR fact_sheet_json IS NULL
           OR evidence_level IS NULL
         )
       ORDER BY last_seen_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<OutageEvent>();
  return result.results;
}

async function refreshOutageEventAggregates(db: D1Database, eventId: number): Promise<OutageEvent> {
  await db
    .prepare(
      `UPDATE outage_events
       SET source_count = (SELECT COUNT(*) FROM outage_sources WHERE outage_event_id = ?),
           status = CASE
             WHEN (SELECT COUNT(*) FROM outage_sources WHERE outage_event_id = ?) >= 2
                  AND status = 'needs_review'
             THEN 'corroborated'
             ELSE status
           END,
           first_seen_at = COALESCE(
             (SELECT MIN(COALESCE(published_at, created_at)) FROM outage_sources WHERE outage_event_id = ?),
             first_seen_at
           ),
           last_seen_at = COALESCE(
             (SELECT MAX(COALESCE(published_at, created_at)) FROM outage_sources WHERE outage_event_id = ?),
             last_seen_at
           ),
           primary_source_url = COALESCE(
             (SELECT source_url FROM outage_sources WHERE outage_event_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1),
             primary_source_url
           ),
           primary_source_title = COALESCE(
             (SELECT source_title FROM outage_sources WHERE outage_event_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1),
             primary_source_title
           ),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(eventId, eventId, eventId, eventId, eventId, eventId, eventId)
    .run();

  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error("Outage event could not be loaded after aggregate refresh");
  return event;
}

function composeAdminNote(existing: string | null, note: string | null, action: string): string {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${action}${note ? `: ${note}` : ""}`;
  return existing ? `${existing}\n${entry}` : entry;
}

export async function mergeOutageEvent(
  db: D1Database,
  sourceEventId: number,
  targetEventId: number,
  adminNote: string | null
): Promise<{ source: OutageEvent; target: OutageEvent }> {
  if (sourceEventId === targetEventId) {
    throw new Error("Source and target event must differ");
  }

  const [source, target] = await Promise.all([
    getOutageEvent(db, sourceEventId),
    getOutageEvent(db, targetEventId)
  ]);
  if (!source) throw new Error(`Source event ${sourceEventId} not found`);
  if (!target) throw new Error(`Target event ${targetEventId} not found`);
  if (source.status === "dismissed" && source.merged_into_event_id === targetEventId) {
    return { source, target };
  }

  await db
    .prepare(
      `UPDATE outage_sources
       SET outage_event_id = ?,
           is_primary = 0
       WHERE outage_event_id = ?
         AND alert_item_id NOT IN (
           SELECT alert_item_id FROM outage_sources WHERE outage_event_id = ?
         )`
    )
    .bind(targetEventId, sourceEventId, targetEventId)
    .run();

  await db
    .prepare("DELETE FROM outage_sources WHERE outage_event_id = ?")
    .bind(sourceEventId)
    .run();

  await db
    .prepare(
      `UPDATE alert_items
       SET outage_event_id = ?, event_linked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE outage_event_id = ?`
    )
    .bind(targetEventId, sourceEventId)
    .run();

  const updatedTarget = await refreshOutageEventAggregates(db, targetEventId);

  await db
    .prepare(
      `UPDATE event_merge_suggestions
       SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
       WHERE source_event_id = ? AND target_event_id = ?`
    )
    .bind(sourceEventId, targetEventId)
    .run();

  await db
    .prepare(
      `UPDATE outage_events
       SET status = 'dismissed',
           merged_into_event_id = ?,
           source_count = 0,
           admin_note = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(
      targetEventId,
      composeAdminNote(source.admin_note, adminNote, `merged into event ${targetEventId}`),
      sourceEventId
    )
    .run();

  const dismissedSource = await getOutageEvent(db, sourceEventId);
  if (!dismissedSource) throw new Error("Source event vanished after merge");
  return { source: dismissedSource, target: updatedTarget };
}

export async function dismissOutageEvent(
  db: D1Database,
  eventId: number,
  adminNote: string | null
): Promise<OutageEvent> {
  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  await db
    .prepare(
      `UPDATE outage_events
       SET status = 'dismissed',
           admin_note = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(composeAdminNote(event.admin_note, adminNote, "dismissed"), eventId)
    .run();

  const updated = await getOutageEvent(db, eventId);
  if (!updated) throw new Error("Event vanished after dismiss");
  return updated;
}

export async function markOutageEventCorroborated(
  db: D1Database,
  eventId: number,
  adminNote: string | null
): Promise<OutageEvent> {
  const event = await getOutageEvent(db, eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  await db
    .prepare(
      `UPDATE outage_events
       SET status = 'corroborated',
           admin_note = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(composeAdminNote(event.admin_note, adminNote, "marked corroborated"), eventId)
    .run();

  const updated = await getOutageEvent(db, eventId);
  if (!updated) throw new Error("Event vanished after corroboration");
  return updated;
}
