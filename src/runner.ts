import { assessIncidentValidity, classifyItem } from "./ai";
import { assessCandidateEvidence } from "./candidate-quality";
import {
  attachSourceToEvent,
  applyPublicationDecision,
  applyPublicationDecisions,
  createWorkflowRun,
  createOutageEvent,
  findCandidateEvents,
  finishWorkflowRun,
  getAlertItemById,
  getEventsNeedingIntelligence,
  getEventsForPublicationRevalidation,
  getHistoricalBackfillTargets,
  getEnabledSourceAuthorityHosts,
  getLatestAlertSnapshot,
  getLinkedRelevantItemsNeedingCandidate,
  getDueSourceRegistryEntries,
  getOutageEvent,
  getSourceRegistryEntryByUrl,
  getOutageEventSources,
  getOutageEventFacts,
  getPendingOutageEventEmails,
  getPublicationEvidenceForEvents,
  getUnplannedEventsDueForResearchRefresh,
  getUnlinkedRelevantItems,
  insertOutageCandidate,
  insertOutageFacts,
  insertHistoricalBackfillFacts,
  insertAlertItem,
  insertSourceObservation,
  linkSourceObservationToAlert,
  linkSourceObservationToEvent,
  linkCandidateToEvent,
  markAiError,
  markAlertLinkedToEvent,
  markOutageEventEmailSent,
  markOutageEventUpdateEmailSent,
  markFiltered,
  recordEventVersion,
  recordPublicationRevalidationRun,
  refreshOutageEventAfterSource,
  recordEventSourcePresence,
  reconcileSourcePresence,
  updateSourceRegistryHealth,
  updateOutageEventCandidateDetails,
  updateOutageEventMailDecision,
  updateClassification,
  upsertQaMetric,
  upsertFeedHealth
} from "./db";
import { generateMergeSuggestions, refreshEventIntelligence } from "./event-intelligence";
import { canAutoMergeLocation, canCreateEvent, makeEventTitle, normalizeLocation, scoreEventCandidate } from "./events";
import { normalizeSwissLocation } from "./geo";
import { decideNewEventMail, decideUpdateMail } from "./intelligence";
import { evaluatePublicEvent } from "./publication";
import { backfillEventCantons, refreshPublicProjection } from "./public-projection";
import { refreshPublicAggregates } from "./public-stats";

/** Bounded per cron run so a backlog never blows the 10 ms CPU / subrequest budget. */
const PROJECTION_LIMIT_PER_RUN = 60;
/** External geo.admin lookups per run for events that still lack a map pin. */
const LOCATION_LOOKUPS_PER_RUN = 3;
/** External geo.admin boundary lookups per run for pinned events without a canton. */
const CANTON_LOOKUPS_PER_RUN = 4;
import { sendEventEmail } from "./email";
import { cheapFilterItem } from "./filter";
import { itemHash, parseRssFeed } from "./rss";
import { researchOutageEvent } from "./research";
import {
  fetchSourceObservations,
  makeSourceObservationFromText,
  observationHashForAlert
} from "./source-adapters";
import { assessSourceObservation, observationToClassification } from "./source-quality";
import { createAlertSnapshot, createSourceSnapshot } from "./snapshots";
import { extractAndStoreSourcePlaces } from "./places";
import { historicalBackfillFacts } from "./historical-backfill";
import { ingestOperatorPoll, pollOperatorSource } from "./operator-ingest";
import type {
  AiClassification,
  CandidateAssessment,
  Env,
  FeedLanguage,
  NormalizedRssItem,
  OutageEvent,
  SourceObservation,
  StoredAlertItem,
  WorkflowRunSummary
} from "./types";

interface FeedConfig {
  language: FeedLanguage;
  url?: string;
}

interface FetchedFeed {
  language: FeedLanguage;
  items: NormalizedRssItem[];
  error: string | null;
}

function feedsFromEnv(env: Env): FeedConfig[] {
  return [
    { language: "de", url: env.ALERT_FEED_DE },
    { language: "fr", url: env.ALERT_FEED_FR },
    { language: "it", url: env.ALERT_FEED_IT }
  ];
}

async function fetchFeed(feed: FeedConfig): Promise<FetchedFeed> {
  if (!feed.url) {
    return {
      language: feed.language,
      items: [],
      error: `ALERT_FEED_${feed.language.toUpperCase()} missing`
    };
  }

  try {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": "swiss-power-outage-radar/0.1"
      }
    });
    if (!response.ok) {
      return {
        language: feed.language,
        items: [],
        error: `HTTP ${response.status}`
      };
    }

    const xml = await response.text();
    return {
      language: feed.language,
      items: parseRssFeed(xml, feed.language),
      error: null
    };
  } catch (error) {
    return {
      language: feed.language,
      items: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function storeNewItems(
  env: Env,
  feed: FetchedFeed,
  fetchedAt: string
): Promise<{ newItems: StoredAlertItem[]; seen: number; errors: string[] }> {
  const newItems: StoredAlertItem[] = [];
  const errors: string[] = [];

  for (const item of feed.items) {
    try {
      const hash = await itemHash(item);
      const stored = await insertAlertItem(env.DB, item, hash, fetchedAt);
      if (stored.inserted) newItems.push(stored.item);
    } catch (error) {
      errors.push(
        `insert ${feed.language} "${item.title}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return { newItems, seen: feed.items.length, errors };
}

async function classifyAndNotify(
  env: Env,
  item: StoredAlertItem
): Promise<{ filtered: boolean; classified: boolean; emailSent: boolean; error?: string }> {
  const filter = cheapFilterItem(item);
  if (!filter.candidate) {
    await markFiltered(env.DB, item.id, filter.reason);
    return { filtered: true, classified: false, emailSent: false };
  }

  const classification = await classifyItem(env, item);
  if (!classification.parsed) {
    await markAiError(env.DB, item.id, classification.raw);
    return {
      filtered: false,
      classified: false,
      emailSent: false,
      error: classification.error ?? "AI classification failed"
    };
  }

  await updateClassification(env.DB, item.id, classification.parsed, classification.raw);

  const freshItem = await getAlertItemById(env.DB, item.id);
  if (!freshItem) {
    return { filtered: false, classified: true, emailSent: false, error: "Item vanished" };
  }

  if (!canCreateEvent(classification.parsed)) {
    return { filtered: false, classified: true, emailSent: false };
  }

  const validity = await assessIncidentValidity(env, freshItem, classification.parsed);
  if (validity.parsed && !validity.parsed.is_actual_outage_incident) {
    await markFiltered(
      env.DB,
      item.id,
      `incident_validity:${validity.parsed.false_positive_type}: ${validity.parsed.reason}`
    );
    return { filtered: true, classified: true, emailSent: false };
  }

  const candidateSnapshot = await createAlertSnapshot(env, freshItem);
  const assessment = assessCandidateEvidence({
    item: freshItem,
    classification: classification.parsed,
    snapshot: candidateSnapshot
  });
  const candidate = await insertOutageCandidate(env.DB, {
    alertItemId: freshItem.id,
    snapshotId: candidateSnapshot.id,
    assessment
  });
  await insertOutageFacts(env.DB, {
    candidateId: candidate.id,
    eventId: null,
    sourceId: null,
    snapshotId: candidateSnapshot.id,
    facts: assessment.facts
  });

  if (!assessment.publishable) {
    if (!assessment.needs_admin) {
      await markFiltered(
        env.DB,
        item.id,
        `candidate_quality:${assessment.relevance_role}: ${assessment.rejection_reason ?? "not publishable"}`
      );
      return { filtered: true, classified: true, emailSent: false };
    }
    return { filtered: false, classified: true, emailSent: false };
  }

  try {
    const result = await linkAlertToOutageEvent(env, freshItem, classification.parsed, {
      assessment,
      candidateId: candidate.id,
      candidateSnapshotId: candidateSnapshot.id
    });
    return { filtered: false, classified: true, emailSent: result.emailSent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { filtered: false, classified: true, emailSent: false, error: message };
  }
}

async function findBestEvent(
  env: Env,
  item: StoredAlertItem,
  classification: AiClassification,
  normalizedLocation: string
): Promise<{ event: OutageEvent; score: number } | null> {
  if (!canAutoMergeLocation(normalizedLocation)) return null;

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const candidates = await findCandidateEvents(env.DB, since);
  let best: { event: OutageEvent; score: number } | null = null;

  for (const event of candidates) {
    const score = scoreEventCandidate(event, item, classification, normalizedLocation);
    if (!best || score > best.score) best = { event, score };
  }

  return best && best.score >= 70 ? best : null;
}

async function shouldSendUpdateEmail(event: OutageEvent, now: string): Promise<boolean> {
  if (event.source_count < 2) return false;
  if (!event.email_sent_at) return false;

  const nowMs = new Date(now).getTime();
  const firstMailMs = new Date(event.email_sent_at).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(firstMailMs)) return false;
  if (nowMs - firstMailMs < 30 * 60 * 1000) return false;

  if (!event.update_email_sent_at) return true;
  const updateMs = new Date(event.update_email_sent_at).getTime();
  return Number.isFinite(updateMs) && nowMs - updateMs >= 6 * 60 * 60 * 1000;
}

async function maybeAutoResearchHighConfidenceEvent(
  env: Env,
  event: OutageEvent
): Promise<string | null> {
  if (Number(event.event_score ?? 0) < 85) return null;
  if (event.status === "dismissed") return null;
  if ((event.research_status ?? "not_started") !== "not_started") return null;
  if (event.auto_research_started_at) return null;

  try {
    await researchOutageEvent(env, event.id, { automatic: true });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Automatic research already ran")) return null;
    return `auto research event ${event.id}: ${message}`;
  }
}

export async function applyPublicationGate(env: Env, event: OutageEvent): Promise<OutageEvent> {
  const [sources, facts, authorityHosts] = await Promise.all([
    getOutageEventSources(env.DB, event.id),
    getOutageEventFacts(env.DB, event.id),
    getEnabledSourceAuthorityHosts(env.DB)
  ]);
  return await applyPublicationDecision(
    env.DB,
    event,
    evaluatePublicEvent(event, sources, facts, { authorityHosts })
  );
}

async function linkAlertToOutageEvent(
  env: Env,
  item: StoredAlertItem,
  classification: AiClassification,
  options: {
    suppressNewEventEmail?: boolean;
    assessment?: CandidateAssessment;
    candidateId?: number;
    candidateSnapshotId?: number;
    sourceObservation?: SourceObservation;
  } = {}
): Promise<{ event: OutageEvent; created: boolean; emailSent: boolean }> {
  const now = new Date().toISOString();
  const startedAtEstimate =
    options.assessment?.facts.find((fact) => fact.fact_type === "start_time")?.value_text ?? null;
  const geoLocation = await normalizeSwissLocation(classification.location_text);
  const normalizedLocation =
    geoLocation.normalizedLocation || normalizeLocation(classification.location_text);
  const best = await findBestEvent(env, item, classification, normalizedLocation);

  let event = best?.event;
  let created = false;
  let relationScore = best?.score ?? 100;

  if (!event) {
    event = await createOutageEvent(env.DB, {
      title: makeEventTitle(classification),
      eventType: classification.event_type,
      locationText: classification.location_text,
      normalizedLocation,
      canton: null,
      country: options.assessment?.is_ch_incident ? "CH" : classification.country,
      seenAt: item.published_at ?? item.fetched_at ?? now,
      receivedAt: item.fetched_at ?? now,
      summary: classification.summary,
      reason: classification.reason,
      confidence: classification.confidence,
      primarySourceUrl: item.url,
      primarySourceTitle: item.title,
      startedAtEstimate,
      publicStatus: "hidden",
      verificationLevel: "auto_analyzed",
      locationGranularity: options.assessment?.location_granularity ?? "unknown",
      eventQualityState: "candidate_only",
      outageNature: options.assessment?.outage_nature ?? "unknown"
    });
    created = true;
  } else if (options.assessment?.publishable) {
    event = await updateOutageEventCandidateDetails(env.DB, event.id, {
      locationGranularity: options.assessment.location_granularity,
      outageNature: options.assessment.outage_nature,
      startedAtEstimate
    });
  }

  const source = await attachSourceToEvent(env.DB, {
    eventId: event.id,
    alertItem: item,
    relationScore,
    isPrimary: created
  });
  if (options.sourceObservation) {
    await linkSourceObservationToEvent(env.DB, options.sourceObservation.id, event.id, source.id);
  }
  await markAlertLinkedToEvent(env.DB, item.id, event.id, now);
  if (options.candidateId) {
    await linkCandidateToEvent(env.DB, options.candidateId, event.id);
    await insertOutageFacts(env.DB, {
      candidateId: options.candidateId,
      eventId: event.id,
      sourceId: source.id,
      snapshotId: options.candidateSnapshotId ?? null,
      facts: options.assessment?.facts ?? []
    });
  }
  event = await refreshOutageEventAfterSource(env.DB, event.id, {
    lastSeenAt: item.published_at ?? item.fetched_at ?? now,
    confidence: classification.confidence,
    summary: classification.summary,
    reason: classification.reason,
    candidateStatus: options.assessment?.status ?? "unknown",
    resolvedAtEstimate:
      options.assessment?.facts.find((fact) => fact.fact_type === "end_time")?.value_text ?? null,
    lastConfirmedActiveAt: options.assessment?.status === "active"
      ? options.sourceObservation?.observed_at ?? item.fetched_at ?? now
      : null,
    expectedRestoreAt: options.assessment?.status === "active"
      ? options.sourceObservation?.resolved_at ?? null
      : null
  });
  if (
    options.sourceObservation?.source_registry_id &&
    options.assessment?.status === "active"
  ) {
    await recordEventSourcePresence(
      env.DB,
      event.id,
      options.sourceObservation.source_registry_id,
      options.sourceObservation.observed_at
    );
  }
  const snapshot = await createSourceSnapshot(env, { event, source, alertItem: item });
  try {
    await extractAndStoreSourcePlaces(env, { event, source, alertItem: item, snapshot });
  } catch (error) {
    console.warn(`place extraction event ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
  }

  event = await refreshEventIntelligence(env, event.id);
  event = await applyPublicationGate(env, event);
  await recordEventVersion(env.DB, {
    event,
    changeType: created ? "created" : "updated",
    sourceObservationId: options.sourceObservation?.id ?? null,
    snapshotId: snapshot.id,
    evidenceExcerpt: options.assessment?.facts[0]?.evidence_excerpt ?? null,
    extractorVersion: options.assessment?.facts[0]?.extractor_version ?? null
  });
  await generateMergeSuggestions(env, event.id);

  const sources = await getOutageEventSources(env.DB, event.id);
  const autoResearchError = await maybeAutoResearchHighConfidenceEvent(env, event);
  if (autoResearchError) console.warn(autoResearchError);

  if (created) {
    if (options.suppressNewEventEmail) {
      if (item.email_sent === 1) {
        await markOutageEventEmailSent(env.DB, event.id, item.email_sent_at ?? now);
      }
      return { event, created, emailSent: false };
    }

    const mailDecision = decideNewEventMail(event, sources);
    await updateOutageEventMailDecision(env.DB, event.id, mailDecision.reason);
    if (mailDecision.send) {
      await sendEventEmail(env, event, sources, "new");
      await markOutageEventEmailSent(env.DB, event.id, now);
      return { event, created, emailSent: true };
    }
    return { event, created, emailSent: false };
  }

  const updateDecision = decideUpdateMail(event, sources, now);
  await updateOutageEventMailDecision(env.DB, event.id, updateDecision.reason);
  if (updateDecision.send) {
    await sendEventEmail(env, event, sources, "update");
    await markOutageEventUpdateEmailSent(env.DB, event.id, now);
    return { event, created, emailSent: true };
  }

  return { event, created, emailSent: false };
}

function classificationFromStoredItem(item: StoredAlertItem): AiClassification | null {
  if (
    item.is_relevant !== 1 ||
    item.confidence === null ||
    !item.country ||
    !item.event_type ||
    !item.summary ||
    !item.reason
  ) {
    return null;
  }

  if (!["CH", "other", "unknown"].includes(item.country)) return null;
  if (
    ![
      "power_outage",
      "grid_disturbance",
      "planned_outage",
      "unclear",
      "not_relevant"
    ].includes(item.event_type)
  ) {
    return null;
  }

  return {
    is_relevant: true,
    confidence: item.confidence,
    country: item.country,
    location_text: item.location_text ?? "",
    event_type: item.event_type as AiClassification["event_type"],
    summary: item.summary,
    reason: item.reason.replace(/\s*Email error:.*$/s, "")
  };
}

async function backfillUnlinkedEvents(env: Env): Promise<{ linked: number; errors: string[] }> {
  const items = await getUnlinkedRelevantItems(env.DB);
  let linked = 0;
  const errors: string[] = [];

  for (const item of items) {
    const classification = classificationFromStoredItem(item);
    if (!classification || !canCreateEvent(classification)) continue;

    try {
      await linkAlertToOutageEvent(env, item, classification, {
        suppressNewEventEmail: item.email_sent === 1
      });
      linked += 1;
    } catch (error) {
      errors.push(
        `backfill item ${item.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { linked, errors };
}

async function backfillLinkedCandidateQuality(
  env: Env
): Promise<{ assessed: number; published: number; errors: string[] }> {
  const items = await getLinkedRelevantItemsNeedingCandidate(env.DB, 20);
  let assessed = 0;
  let published = 0;
  const errors: string[] = [];

  for (const item of items) {
    if (!item.outage_event_id) continue;

    const classification = classificationFromStoredItem(item);
    if (!classification || !canCreateEvent(classification)) continue;

    try {
      const snapshot = await getLatestAlertSnapshot(env.DB, item.id);
      const assessment = assessCandidateEvidence({
        item,
        classification,
        snapshot
      });
      const candidate = await insertOutageCandidate(env.DB, {
        alertItemId: item.id,
        snapshotId: snapshot?.id ?? null,
        assessment
      });
      await insertOutageFacts(env.DB, {
        candidateId: candidate.id,
        eventId: assessment.publishable ? item.outage_event_id : null,
        sourceId: null,
        snapshotId: snapshot?.id ?? null,
        facts: assessment.facts
      });
      assessed += 1;

      if (!assessment.publishable) continue;

      const startedAtEstimate =
        assessment.facts.find((fact) => fact.fact_type === "start_time")?.value_text ?? null;
      let event = await updateOutageEventCandidateDetails(env.DB, item.outage_event_id, {
        locationGranularity: assessment.location_granularity,
        outageNature: assessment.outage_nature,
        startedAtEstimate
      });
      await linkCandidateToEvent(env.DB, candidate.id, item.outage_event_id);
      event = await applyPublicationGate(env, event);
      if (event.event_quality_state === "publishable") published += 1;
    } catch (error) {
      errors.push(
        `candidate quality backfill item ${item.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return { assessed, published, errors };
}

async function retryPendingEventEmails(
  env: Env
): Promise<{ emailsSent: number; errors: string[] }> {
  const events = await getPendingOutageEventEmails(env.DB);
  let emailsSent = 0;
  const errors: string[] = [];

  for (const event of events) {
    try {
      const sources = await getOutageEventSources(env.DB, event.id);
      const mailDecision = decideNewEventMail(event, sources);
      await updateOutageEventMailDecision(env.DB, event.id, mailDecision.reason);
      if (!mailDecision.send) continue;

      await sendEventEmail(env, event, sources, "new");
      await markOutageEventEmailSent(env.DB, event.id, new Date().toISOString());
      emailsSent += 1;
    } catch (error) {
      errors.push(
        `event ${event.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { emailsSent, errors };
}

async function backfillEventIntelligence(env: Env): Promise<{ updated: number; errors: string[] }> {
  const events = await getEventsNeedingIntelligence(env.DB, 5);
  let updated = 0;
  const errors: string[] = [];

  for (const event of events) {
    try {
      const refreshed = await refreshEventIntelligence(env, event.id);
      await generateMergeSuggestions(env, refreshed.id);
      const sources = await getOutageEventSources(env.DB, refreshed.id);
      const mailDecision = decideNewEventMail(refreshed, sources);
      await updateOutageEventMailDecision(env.DB, refreshed.id, mailDecision.reason);
      updated += 1;
    } catch (error) {
      errors.push(
        `event intelligence ${event.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { updated, errors };
}

async function backfillHistoricalPublicFacts(
  env: Env
): Promise<{ events: number; facts: number; errors: string[] }> {
  const now = new Date();
  const olderThan = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
  const targets = await getHistoricalBackfillTargets(env.DB, olderThan, 3);
  let events = 0;
  let facts = 0;
  const errors: string[] = [];
  for (const target of targets) {
    try {
      const extracted = historicalBackfillFacts(target, now.toISOString());
      facts += await insertHistoricalBackfillFacts(env.DB, target, extracted);
      events += 1;
    } catch (error) {
      errors.push(`historical backfill ${target.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { events, facts, errors };
}

async function processSourceObservation(
  env: Env,
  observation: SourceObservation
): Promise<{ itemNew: boolean; classified: boolean; emailSent: boolean; filtered: boolean }> {
  const hash = await observationHashForAlert({
    sourceRegistryId: observation.source_registry_id,
    sourceKey: observation.source_key,
    sourceType: observation.source_type,
    operatorName: observation.operator_name,
    observationHash: observation.observation_hash,
    canonicalStatus: observation.canonical_status,
    eventType: observation.event_type,
    title: observation.title,
    url: observation.url,
    locationText: observation.location_text,
    areaText: observation.area_text,
    startedAt: observation.started_at,
    resolvedAt: observation.resolved_at,
    observedAt: observation.observed_at,
    publishedAt: observation.published_at,
    evidenceExcerpt: observation.evidence_excerpt,
    rawPayloadJson: observation.raw_payload_json,
    extractorVersion: observation.extractor_version,
    confidence: observation.confidence,
    independenceKey: observation.independence_key
  });
  const stored = await insertAlertItem(
    env.DB,
    {
      feed_language: "de",
      title: observation.title,
      url: observation.url,
      source: observation.operator_name,
      snippet: observation.evidence_excerpt,
      published_at: observation.published_at ?? observation.observed_at
    },
    hash,
    observation.observed_at
  );
  await linkSourceObservationToAlert(env.DB, observation.id, stored.item.id);

  const assessment = assessSourceObservation(observation);
  if (observation.canonical_status === "irrelevant") {
    await markFiltered(env.DB, stored.item.id, assessment.rejection_reason ?? "irrelevant source observation");
    return { itemNew: stored.inserted, classified: false, emailSent: false, filtered: true };
  }

  const snapshot = await createAlertSnapshot(env, stored.item, observation.observed_at);
  const candidate = await insertOutageCandidate(env.DB, {
    alertItemId: stored.item.id,
    snapshotId: snapshot.id,
    assessment
  });
  await insertOutageFacts(env.DB, {
    candidateId: candidate.id,
    eventId: null,
    sourceId: null,
    snapshotId: snapshot.id,
    facts: assessment.facts
  });

  if (!assessment.publishable) {
    if (!assessment.needs_admin) {
      await markFiltered(env.DB, stored.item.id, assessment.rejection_reason ?? "not publishable");
    }
    return {
      itemNew: stored.inserted,
      classified: true,
      emailSent: false,
      filtered: !assessment.needs_admin
    };
  }

  const result = await linkAlertToOutageEvent(env, stored.item, observationToClassification(observation), {
    assessment,
    candidateId: candidate.id,
    candidateSnapshotId: snapshot.id,
    sourceObservation: observation
  });

  return {
    itemNew: stored.inserted,
    classified: true,
    emailSent: result.emailSent,
    filtered: false
  };
}

/** External geo.admin lookups per run for new operator coordinates (each point once, ever). */
const OPERATOR_GEOCODES_PER_RUN = 10;
/** Registry sources polled per run. Each costs exactly one external request. */
const SOURCES_PER_RUN = 20;

/**
 * Operator pipeline v2: poll → source_records → incidents (src/operator-ingest.ts).
 * Operator items no longer pass through alert_items, AI classification,
 * candidates, facts or fuzzy event matching: their identity is the operator's own.
 */
async function collectRegistrySources(env: Env): Promise<{
  sourcesChecked: number;
  observationsSeen: number;
  observationsNew: number;
  itemsNew: number;
  itemsFiltered: number;
  itemsClassified: number;
  emailsSent: number;
  firecrawlCreditsEstimated: number;
  errors: string[];
}> {
  const now = new Date().toISOString();
  const sources = await getDueSourceRegistryEntries(env.DB, now, SOURCES_PER_RUN);
  const summary = {
    sourcesChecked: 0,
    observationsSeen: 0,
    observationsNew: 0,
    itemsNew: 0,
    itemsFiltered: 0,
    itemsClassified: 0,
    emailsSent: 0,
    firecrawlCreditsEstimated: 0,
    errors: [] as string[]
  };
  const geoBudget = { remaining: OPERATOR_GEOCODES_PER_RUN };

  for (const source of sources) {
    summary.sourcesChecked += 1;
    const polledAt = new Date().toISOString();
    try {
      const poll = await pollOperatorSource(env, source, polledAt);
      if (poll.usedFirecrawl) summary.firecrawlCreditsEstimated += 1;
      const ingested = await ingestOperatorPoll(env, source, poll, { geoBudget, archive: env.SNAPSHOTS });
      summary.observationsSeen += ingested.recordsSeen;
      summary.observationsNew += ingested.recordsNew;
      if (poll.error && poll.transportStatus === "error") summary.errors.push(`${source.source_key}: ${poll.error}`);
    } catch (error) {
      summary.errors.push(`${source.source_key} ingest: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return summary;
}

export async function ingestFirecrawlWebhook(
  env: Env,
  payload: Record<string, unknown>
): Promise<{ accepted: boolean; observationId?: number; eventId?: number | null; reason?: string }> {
  const data = (payload.data && typeof payload.data === "object"
    ? payload.data
    : payload) as Record<string, unknown>;
  const url = String(data.url ?? data.sourceUrl ?? data.finalUrl ?? "");
  if (!url) return { accepted: false, reason: "missing url" };

  const source = await getSourceRegistryEntryByUrl(env.DB, url);
  if (!source) return { accepted: false, reason: "no matching source registry entry" };
  if (source.firecrawl_enabled !== 1) {
    return { accepted: false, reason: "source is not Firecrawl-enabled" };
  }

  const markdown = String(data.markdown ?? data.content ?? data.text ?? "");
  const title = String(data.title ?? `${source.operator_name}: Firecrawl update`);
  const observedAt = new Date().toISOString();
  const synthesized = await makeSourceObservationFromText(
    {
      ...source,
      source_type: "html",
      url
    },
    {
      title,
      url,
      text: markdown || title,
      locationText: null,
      publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : null,
      raw: payload,
      observedAt
    }
  );
  synthesized.rawPayloadJson = JSON.stringify(payload).slice(0, 5000);

  const stored = await insertSourceObservation(env.DB, synthesized);
  if (!stored.inserted) {
    return {
      accepted: true,
      observationId: stored.observation.id,
      eventId: stored.observation.outage_event_id,
      reason: "duplicate observation"
    };
  }

  const result = await processSourceObservation(env, stored.observation);
  return {
    accepted: true,
    observationId: stored.observation.id,
    eventId: stored.observation.outage_event_id,
    reason: result.classified ? "processed" : "stored"
  };
}

export async function revalidatePublicEvents(
  env: Env,
  options: { apply: boolean; limit?: number }
): Promise<{
  apply: boolean;
  assessed: number;
  publishable_before: number;
  publishable_after: number;
  changed: number;
  decisions: Array<{
    event_id: number;
    before: { publishable: boolean; reason: string | null };
    after: { publishable: boolean; trust: string | null; reasons: string[] };
  }>;
}> {
  const events = await getEventsForPublicationRevalidation(env.DB, options.limit ?? 50);
  const [authorityHosts, evidence] = await Promise.all([
    getEnabledSourceAuthorityHosts(env.DB),
    getPublicationEvidenceForEvents(env.DB, events.map((event) => event.id))
  ]);
  let publishableBefore = 0;
  let publishableAfter = 0;
  let changed = 0;
  const decisions: Array<{
    event_id: number;
    before: { publishable: boolean; reason: string | null };
    after: { publishable: boolean; trust: string | null; reasons: string[] };
  }> = [];
  const evaluated: Array<{ event: OutageEvent; decision: ReturnType<typeof evaluatePublicEvent> }> = [];

  for (const event of events) {
    const sources = evidence.sources.get(event.id) ?? [];
    const facts = evidence.facts.get(event.id) ?? [];
    const decision = evaluatePublicEvent(event, sources, facts, { authorityHosts });
    const wasPublishable = event.public_status !== "hidden" && event.event_quality_state === "publishable";
    if (wasPublishable) publishableBefore += 1;
    if (decision.publishable) publishableAfter += 1;
    if (wasPublishable !== decision.publishable) changed += 1;
    decisions.push({
      event_id: event.id,
      before: { publishable: wasPublishable, reason: event.mail_decision_reason },
      after: {
        publishable: decision.publishable,
        trust: decision.trust,
        reasons: decision.reasons
      }
    });
    evaluated.push({ event, decision });
  }

  const report = {
    apply: options.apply,
    assessed: events.length,
    publishable_before: publishableBefore,
    publishable_after: publishableAfter,
    changed,
    decisions
  };
  if (options.apply) {
    // With 46 current events this remains exactly within D1 Free's 50-query
    // Worker invocation budget (4 reads + 46 decision upserts).
    await applyPublicationDecisions(env.DB, evaluated);
  } else {
    await recordPublicationRevalidationRun(env.DB, report);
  }
  return report;
}

export async function runAlertCheck(env: Env): Promise<WorkflowRunSummary> {
  const startedAt = new Date().toISOString();
  const runId = await createWorkflowRun(env.DB, startedAt);
  if (runId === null) {
    return {
      runId: 0,
      skipped: true,
      itemsSeen: 0,
      itemsNew: 0,
      itemsFiltered: 0,
      itemsClassified: 0,
      emailsSent: 0,
      errors: []
    };
  }
  const summary: WorkflowRunSummary = {
    runId,
    itemsSeen: 0,
    itemsNew: 0,
    itemsFiltered: 0,
    itemsClassified: 0,
    emailsSent: 0,
    sourcesChecked: 0,
    observationsSeen: 0,
    observationsNew: 0,
    firecrawlCreditsEstimated: 0,
    errors: []
  };

  try {
    const registry = await collectRegistrySources(env);
    summary.sourcesChecked = registry.sourcesChecked;
    summary.observationsSeen = registry.observationsSeen;
    summary.observationsNew = registry.observationsNew;
    summary.firecrawlCreditsEstimated = registry.firecrawlCreditsEstimated;
    summary.itemsSeen += registry.observationsSeen;
    summary.itemsNew += registry.itemsNew;
    summary.itemsFiltered += registry.itemsFiltered;
    summary.itemsClassified += registry.itemsClassified;
    summary.emailsSent += registry.emailsSent;
    summary.errors.push(...registry.errors);

    for (const feed of feedsFromEnv(env)) {
      const checkedAt = new Date().toISOString();
      const fetched = await fetchFeed(feed);

      if (fetched.error) {
        summary.errors.push(`${feed.language}: ${fetched.error}`);
        await upsertFeedHealth(env.DB, feed.language, {
          checkedAt,
          error: fetched.error,
          itemsSeen: 0,
          itemsNew: 0
        });
        continue;
      }

      const stored = await storeNewItems(env, fetched, checkedAt);
      summary.itemsSeen += stored.seen;
      summary.itemsNew += stored.newItems.length;
      summary.errors.push(...stored.errors);

      await upsertFeedHealth(env.DB, feed.language, {
        checkedAt,
        successAt: checkedAt,
        error: null,
        itemsSeen: stored.seen,
        itemsNew: stored.newItems.length
      });

      for (const item of stored.newItems) {
        try {
          const result = await classifyAndNotify(env, item);
          if (result.filtered) summary.itemsFiltered += 1;
          if (result.classified) summary.itemsClassified += 1;
          if (result.emailSent) summary.emailsSent += 1;
          if (result.error) summary.errors.push(`item ${item.id}: ${result.error}`);
        } catch (error) {
          summary.errors.push(
            `item ${item.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    const backfill = await backfillUnlinkedEvents(env);
    summary.errors.push(...backfill.errors);

    const qualityBackfill = await backfillLinkedCandidateQuality(env);
    summary.itemsClassified += qualityBackfill.assessed;
    summary.errors.push(...qualityBackfill.errors);

    const intelligenceBackfill = await backfillEventIntelligence(env);
    summary.errors.push(...intelligenceBackfill.errors);

    // Historical details are backfilled first from already stored source material.
    // This path performs no paid search and is intentionally limited to three events/run.
    const historicalBackfill = await backfillHistoricalPublicFacts(env);
    summary.errors.push(...historicalBackfill.errors);

    // Operator feeds are checked every run. Expensive research is incremental:
    // refresh only genuinely current events, at most one/run and two/day.
    const refreshTargets = await getUnplannedEventsDueForResearchRefresh(env.DB, new Date().toISOString(), 1);
    for (const target of refreshTargets) {
      try {
        const refreshed = await researchOutageEvent(env, target.id);
        await applyPublicationGate(env, refreshed.event);
      } catch (error) {
        summary.errors.push(`refresh event ${target.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const eventRetry = await retryPendingEventEmails(env);
    summary.emailsSent += eventRetry.emailsSent;
    for (const error of eventRetry.errors) {
      console.warn(`pending email retry failed: ${error}`);
    }

    // Publish the run's outcome: one writer for every public page and statistic.
    try {
      const cantons = await backfillEventCantons(env, { limit: CANTON_LOOKUPS_PER_RUN });
      summary.errors.push(...cantons.errors);
      const projection = await refreshPublicProjection(env, {
        limit: PROJECTION_LIMIT_PER_RUN,
        resolveLocations: LOCATION_LOOKUPS_PER_RUN,
        sweepOrphans: new Date().getUTCMinutes() < 15
      });
      summary.errors.push(...projection.errors);
      await refreshPublicAggregates(env, { projectionChanged: projection.written + projection.removed > 0 });
    } catch (error) {
      summary.errors.push(`public projection: ${error instanceof Error ? error.message : String(error)}`);
    }

    const calculatedAt = new Date().toISOString();
    const metricDate = calculatedAt.slice(0, 10);
    await upsertQaMetric(env.DB, {
      metricDate,
      metricName: "source_coverage_checked",
      metricValue: summary.sourcesChecked ?? 0,
      numerator: summary.sourcesChecked ?? 0,
      denominator: null,
      dimensionKey: "registry",
      notes: "Registry sources checked in this workflow run",
      calculatedAt
    });
    await upsertQaMetric(env.DB, {
      metricDate,
      metricName: "adapter_freshness_success_rate",
      metricValue:
        (summary.sourcesChecked ?? 0) > 0
          ? ((summary.sourcesChecked ?? 0) - registry.errors.length) / (summary.sourcesChecked ?? 1)
          : 1,
      numerator: (summary.sourcesChecked ?? 0) - registry.errors.length,
      denominator: summary.sourcesChecked ?? 0,
      dimensionKey: "registry",
      notes: "Share of configured operator adapters that fetched successfully",
      calculatedAt
    });
    await upsertQaMetric(env.DB, {
      metricDate,
      metricName: "firecrawl_credits_estimated",
      metricValue: summary.firecrawlCreditsEstimated ?? 0,
      numerator: summary.firecrawlCreditsEstimated ?? 0,
      denominator: 1000,
      dimensionKey: "monthly_free_limit",
      notes: "Estimated scrape calls; keep far below the 1000 credits/month free limit",
      calculatedAt
    });

    await finishWorkflowRun(
      env.DB,
      runId,
      summary.errors.length > 0 ? "partial_error" : "success",
      {
        itemsSeen: summary.itemsSeen,
        itemsNew: summary.itemsNew,
        itemsFiltered: summary.itemsFiltered,
        itemsClassified: summary.itemsClassified,
        emailsSent: summary.emailsSent,
        error: summary.errors.length > 0 ? summary.errors.join("; ").slice(0, 2000) : null
      },
      new Date().toISOString()
    );

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.errors.push(message);
    await finishWorkflowRun(
      env.DB,
      runId,
      "error",
      {
        itemsSeen: summary.itemsSeen,
        itemsNew: summary.itemsNew,
        itemsFiltered: summary.itemsFiltered,
        itemsClassified: summary.itemsClassified,
        emailsSent: summary.emailsSent,
        error: summary.errors.join("; ").slice(0, 2000)
      },
      new Date().toISOString()
    );
    return summary;
  }
}
