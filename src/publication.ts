import { canonicalSourceUrl, classifySource } from "./intelligence";
import { normalizeLocation } from "./events";
import { publicDisplayLocation, publicEventPath } from "./public-url";
import type {
  OutageEvent,
  OutageFact,
  OutageSource,
  PublicationDecision,
  PublicCanonicalSource,
  PublicFeedItem,
  PublicTrust
} from "./types";

const NON_CONCRETE_LOCATIONS = new Set([
  "",
  "unknown",
  "unbekannt",
  "schweiz",
  "suisse",
  "svizzera",
  "switzerland"
]);

const NEGATIVE_EVIDENCE = [
  /kein(?:e|en)?\s+(?:aktuell(?:e[ns]?)?\s+)?stromausfall/i,
  /kein(?:e|en)?\b.{0,40}\bstromausf[aä]ll/i,
  /keine\s+(?:aktuellen?\s+)?st[oö]rungen/i,
  /no\s+(?:current\s+)?(?:power\s+)?outages?/i,
  /aucune\s+(?:panne|perturbation)/i,
  /nessun(?:a|o)\s+(?:interruzione|guasto)/i
];

const NON_INCIDENT_EVIDENCE = [
  /\b(?:r[uü]ckblick|historisch|archiv|marktbericht|marktanalyse|ratgeber)\b/i,
  /\bwas\s+tun\s+bei\s+einem\s+stromausfall\b/i,
  /\bnach\s+dem\s+letzten\s+stromausfall\b/i,
  /\bim\s+jahr\s+20\d{2}\b/i,
  /\b(?:retour|r[eé]trospective|historique|archives?|analyse du march[eé]|conseils?)\b/i,
  /\bque faire (?:en cas|lors) (?:de|d['’]une?) panne de courant\b/i,
  /\b(?:retrospettiva|storico|archivio|analisi di mercato|guida)\b/i,
  /\bcosa fare in caso di (?:interruzione|blackout)\b/i
];

const LOW_VALUE_UNCERTAINTY = [
  /\bkeine (?:klaren|konkreten|weiteren) informationen\b/i,
  /\b(?:angaben|lage).{0,80}\b(?:unklar|unbest[aä]tigt|nicht best[aä]tigt)\b/i,
  /\b(?:ursache|status|dauer|umfang|details?|informationen).{0,100}\b(?:unklar|unbekannt|nicht (?:vollst[aä]ndig )?(?:klar|bekannt|detailliert|angegeben|beschrieben))\b/i,
  /\b(?:details?|cause|status|duration|extent|information).{0,100}\b(?:unclear|unknown|not (?:fully )?(?:clear|known|provided|specified|described))\b/i,
  /\b(?:cause|statut|dur[eé]e|d[eé]tails?|informations?).{0,100}\b(?:inconnu|incertain|pas (?:claire?|connue?|pr[eé]cis[eé]e?|indiqu[eé]e?))\b/i,
  /\b(?:causa|stato|durata|dettagli|informazioni).{0,100}\b(?:sconosciut[ao]|incert[ao]|non (?:chiar[ao]|not[ao]|specificat[ao]))\b/i
];

const POWER_OUTAGE_EVIDENCE = /\b(?:stromausfall|stromunterbruch|netzunterbruch|ohne strom|panne de courant|coupure de courant|interruzione di corrente|power outage|blackout)\b/i;

const NON_POWER_HAZARD = /feuerverbot|interdiction de faire du feu|divieto di accendere fuochi|risque d['’]incendie|waldbrandgefahr|s[ée]cheresse|trockenheit|hitzewelle|canicule/i;

function isNonPowerIncident(text: string): boolean {
  if (POWER_OUTAGE_EVIDENCE.test(text)) return false;
  return NON_POWER_HAZARD.test(text);
}

function concreteSwissLocation(event: OutageEvent): boolean {
  const location = normalizeLocation(event.location_text);
  return (
    event.country === "CH" &&
    !NON_CONCRETE_LOCATIONS.has(location) &&
    !/netzgebiet|versorgungsgebiet|westschweiz|ostschweiz|nordwestschweiz|zentralschweiz|schweizweit|^(?:grossraum|r[eé]gion\b|regione\b|gebiet$|umgebung$)/i.test(location) &&
    ["address", "street", "municipality", "district", "region"].includes(event.location_granularity || "unknown")
  );
}

function provesOutage(fact: OutageFact): boolean {
  if (!['outage_happened', 'planned_outage_notice'].includes(fact.fact_type)) return false;
  if (!fact.evidence_excerpt.trim()) return false;
  if (NEGATIVE_EVIDENCE.some((pattern) => pattern.test(fact.evidence_excerpt))) return false;
  if (NON_INCIDENT_EVIDENCE.some((pattern) => pattern.test(fact.evidence_excerpt))) return false;
  if (isNonPowerIncident(fact.evidence_excerpt)) return false;
  return fact.value_text.trim().toLowerCase() === "true" || fact.fact_type === "planned_outage_notice";
}

function canonicalPublicSource(source: OutageSource, authorityHosts?: ReadonlySet<string>): {
  publicSource: PublicCanonicalSource;
  trust: PublicTrust | null;
  independenceKey: string;
} | null {
  const canonicalUrl = canonicalSourceUrl(source.source_url);
  if (!canonicalUrl) return null;

  const intelligence = classifySource({
    url: canonicalUrl,
    title: source.source_title,
    sourceName: source.source_name
  });
  const domain = new URL(canonicalUrl).hostname.replace(/^www\./, "").toLowerCase();
  const isOfficial = authorityHosts ? authorityHosts.has(domain) : intelligence.is_official === 1;
  if (!isOfficial && !["local_media", "national_media"].includes(intelligence.source_kind)) return null;
  if (authorityHosts && ["official", "operator"].includes(intelligence.source_kind) && !isOfficial) return null;
  return {
    publicSource: {
      publisher: source.source_name?.trim() || domain,
      url: canonicalUrl,
      domain
    },
    trust: isOfficial ? "official" : null,
    independenceKey: domain
  };
}

function outageCenteredSource(source: OutageSource): boolean {
  const canonicalUrl = canonicalSourceUrl(source.source_url) ?? source.source_url;
  let decodedUrl = canonicalUrl;
  try {
    decodedUrl = decodeURIComponent(canonicalUrl);
  } catch {
    // Keep the original URL when malformed percent encoding cannot be decoded.
  }
  const text = normalizeLocation(`${source.source_title} ${decodedUrl}`);
  return /\b(?:stromausfall|stromunterbruch|netzunterbruch|ohne strom|kappt strom|panne de courant|coupure de courant|privees delectricite|blackout|interruzione di corrente|senza corrente|power outage)\b/.test(text);
}

function publicSummary(event: OutageEvent): string | null {
  const summary = event.research_summary_de?.trim() || event.summary?.trim() || null;
  if (
    !summary ||
    NEGATIVE_EVIDENCE.some((pattern) => pattern.test(summary)) ||
    NON_INCIDENT_EVIDENCE.some((pattern) => pattern.test(summary)) ||
    isNonPowerIncident(summary)
  ) return null;
  const sentences = summary
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && !LOW_VALUE_UNCERTAINTY.some((pattern) => pattern.test(sentence)))
    .slice(0, 2)
    .join(" ");
  if (!sentences) return null;
  return sentences.length <= 320 ? sentences : `${sentences.slice(0, 317).trimEnd()}…`;
}

function contradictoryFacts(event: OutageEvent, facts: OutageFact[]): boolean {
  const values = (type: OutageFact["fact_type"]) => new Set(
    facts
      .filter((fact) => fact.fact_type === type && fact.confidence >= 0.65)
      .map((fact) => normalizeLocation(fact.value_text))
      .filter((value) => value && value !== "unknown" && value !== "unbekannt")
  );
  const outageClaims = values("outage_happened");
  if (outageClaims.has("true") && outageClaims.has("false")) return true;
  const statusValues = values("status");
  const lifecycleStatuses = new Set(["active", "aktiv", "resolved", "behoben"]);
  const invalidStatusConflict = statusValues.size > 1 &&
    [...statusValues].some((value) => !lifecycleStatuses.has(value));
  if (invalidStatusConflict || values("cause").size > 1 || values("planned_nature").size > 1) return true;

  const summary = normalizeLocation(event.research_summary_de || event.summary);
  const plannedFacts = values("planned_nature");
  if (summary.includes("geplant") && plannedFacts.has("unplanned")) return true;
  if (summary.includes("ungeplant") && plannedFacts.has("planned")) return true;
  const hasKnownCause = values("cause").size > 0 || Boolean(event.cause_text?.trim());
  if (hasKnownCause && /ursache (?:ist )?(?:unklar|unbekannt|nicht bekannt)/.test(summary)) return true;
  return false;
}

export function evaluatePublicEvent(
  event: OutageEvent,
  sources: OutageSource[],
  facts: OutageFact[],
  options: { authorityHosts?: ReadonlySet<string> } = {}
): PublicationDecision {
  const reasons: string[] = [];
  if (!concreteSwissLocation(event)) reasons.push("no_concrete_swiss_location");
  const positiveFacts = facts.filter((fact) => fact.confidence >= 0.65 && provesOutage(fact));
  if (positiveFacts.length === 0) reasons.push("no_positive_outage_evidence");
  if (contradictoryFacts(event, facts)) reasons.push("contradictory_evidence");

  const summary = publicSummary(event);
  if (!summary) reasons.push("no_coherent_public_summary");

  const credibleSources = sources
    .map((source) => {
      const canonical = canonicalPublicSource(source, options.authorityHosts);
      return canonical ? { ...canonical, sourceId: source.id } : null;
    })
    .filter((source) => source !== null);
  const evidencedSourceIds = new Set(positiveFacts.flatMap((fact) =>
    typeof fact.outage_source_id === "number" ? [fact.outage_source_id] : []
  ));
  const evidencedObservationIds = new Set(positiveFacts.flatMap((fact) =>
    typeof fact.source_observation_id === "number" ? [fact.source_observation_id] : []
  ));
  const evidencedAlertItemIds = new Set(positiveFacts.flatMap((fact) =>
    typeof fact.alert_item_id === "number" ? [fact.alert_item_id] : []
  ));
  const evidencedSources = credibleSources.filter((source) => {
    const original = sources.find((item) => item.id === source.sourceId);
    return evidencedSourceIds.has(source.sourceId) || (
      typeof original?.source_observation_id === "number" &&
      evidencedObservationIds.has(original.source_observation_id)
    ) || evidencedAlertItemIds.has(original?.alert_item_id ?? -1);
  });
  const official = evidencedSources.find((source) => source.trust === "official");
  const independentDomains = new Set(evidencedSources.map((source) => source.independenceKey));
  const centeredReport = evidencedSources.find((source) => {
    const original = sources.find((item) => item.id === source.sourceId);
    return original ? outageCenteredSource(original) : false;
  });
  const trust: PublicTrust | null = official
    ? "official"
    : independentDomains.size >= 2
      ? "corroborated"
      : evidencedSources.length === 1 && centeredReport
        ? "reported"
        : null;
  if (!trust) reasons.push("insufficient_source_authority");

  const primary = official || evidencedSources.find((candidate) => {
    const source = sources.find((item) => canonicalSourceUrl(item.source_url) === candidate.publicSource.url);
    return source?.is_primary === 1;
  }) || evidencedSources[0];

  return {
    publishable: reasons.length === 0,
    trust,
    reasons,
    summary,
    primary_source: primary?.publicSource || null
  };
}

export function publicFeedCursor(item: Pick<PublicFeedItem, "id" | "received_at">): string {
  return `${item.received_at}|${item.id}`;
}

export function parsePublicFeedCursor(cursor: string | null | undefined): { receivedAt: string; id: number } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) return null;
  const receivedAt = cursor.slice(0, separator);
  const id = Number(cursor.slice(separator + 1));
  return receivedAt && Number.isInteger(id) && id > 0 ? { receivedAt, id } : null;
}

function concreteFact(facts: OutageFact[], type: OutageFact["fact_type"]): string | null {
  const matches = facts
    .filter((fact) => fact.fact_type === type && fact.confidence >= 0.7)
    .filter((fact) => fact.value_text.trim() && !["unknown", "unclear", "unbekannt", "unklar", "null"].includes(normalizeLocation(fact.value_text)))
    .sort((left, right) => {
      const backfillPriority = Number(right.extractor_version === "historical-backfill/v1") - Number(left.extractor_version === "historical-backfill/v1");
      if (backfillPriority !== 0) return backfillPriority;
      return right.confidence - left.confidence;
    });
  if (matches[0]?.extractor_version === "historical-backfill/v1") return matches[0].value_text.trim();
  const distinct = new Map(matches.map((fact) => [normalizeLocation(fact.value_text), fact.value_text.trim()]));
  return distinct.size === 1 ? [...distinct.values()][0] ?? null : null;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function publicNature(event: OutageEvent, facts: OutageFact[]): NonNullable<OutageEvent["outage_nature"]> {
  const nature = normalizeLocation(concreteFact(facts, "planned_nature") ?? "");
  if (nature === "planned" || nature === "geplant") return "planned";
  if (nature === "unplanned" || nature === "ungeplant") return "unplanned";
  return event.outage_nature ?? "unknown";
}

export const ACTIVE_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * A single media report ("reported" trust) is rarely updated and often already
 * describes a fixed outage. Without a new confirmation it stops counting as
 * active after this long instead of a full day.
 */
export const REPORTED_EVENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A planned window counts as over once its announced end lies this far in the past without a newer confirmation. */
export const PLANNED_WINDOW_GRACE_MS = 30 * 60 * 1000;

/**
 * Single source of truth for the public state of an event. Everything public
 * (feed, detail, operator and place pages, statistics) must go through this
 * function — via the materialized `public_events` projection — so that the same
 * event never shows two different states on two pages.
 */
export function toPublicFeedItem(
  event: OutageEvent,
  decision: PublicationDecision,
  facts: OutageFact[] = [],
  now: number = Date.now()
): PublicFeedItem | null {
  if (!decision.publishable || !decision.trust || !decision.primary_source || !decision.summary || !event.received_at) {
    return null;
  }

  const nature = publicNature(event, facts);
  const startedAt = isoOrNull(concreteFact(facts, "start_time") ?? event.started_at_estimate);
  const expectedRestoreAt = isoOrNull(event.expected_restore_at);
  const reportedResolvedAt = isoOrNull(concreteFact(facts, "end_time") ?? event.resolved_at_estimate);
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  // A planned interruption ends with its announced window unless the operator
  // still confirms it afterwards. The end is then the operator's announced end,
  // not an invented one.
  const plannedEndMs = expectedRestoreAt ? new Date(expectedRestoreAt).getTime() : NaN;
  const lastConfirmedMs = event.last_confirmed_active_at ? new Date(event.last_confirmed_active_at).getTime() : NaN;
  const plannedWindowOver = nature === "planned" &&
    !reportedResolvedAt &&
    Number.isFinite(startMs) &&
    Number.isFinite(plannedEndMs) &&
    plannedEndMs > startMs &&
    now - plannedEndMs >= PLANNED_WINDOW_GRACE_MS &&
    !(Number.isFinite(lastConfirmedMs) && lastConfirmedMs > plannedEndMs);
  const resolvedAt = reportedResolvedAt ?? (plannedWindowOver ? expectedRestoreAt : null);
  const durationMinutes = startedAt && resolvedAt
    ? Math.max(0, Math.round((new Date(resolvedAt).getTime() - startMs) / 60000))
    : null;
  const statusFact = normalizeLocation(concreteFact(facts, "status") ?? "");
  const activityReference = Math.max(
    ...[startedAt, event.last_seen_at, event.received_at, event.first_seen_at]
      .map((value) => value ? new Date(value).getTime() : NaN)
      .filter(Number.isFinite)
  );
  const lastConfirmedActiveAt = isoOrNull(event.last_confirmed_active_at ?? event.last_seen_at);
  const confirmationMs = lastConfirmedActiveAt ? new Date(lastConfirmedActiveAt).getTime() : activityReference;
  const maxActiveAge = decision.trust === "reported" ? REPORTED_EVENT_MAX_AGE_MS : ACTIVE_EVENT_MAX_AGE_MS;
  const recentlyObserved = Number.isFinite(confirmationMs) && now - confirmationMs <= maxActiveAge;
  const autoClosed = !resolvedAt && !recentlyObserved &&
    (statusFact === "active" || statusFact === "aktiv" || (!statusFact && nature === "unplanned"));
  const status = nature === "planned" && Number.isFinite(startMs) && startMs > now
    ? "upcoming"
    : statusFact === "resolved" || statusFact === "behoben" || event.status === "resolved" || plannedWindowOver
      ? "resolved"
      : statusFact === "historical" || statusFact === "archiviert"
        ? "historical"
        : autoClosed
          ? "resolved"
        : recentlyObserved && (statusFact === "active" || statusFact === "aktiv" || !resolvedAt)
          ? "active"
          : !resolvedAt
            ? "stale_unconfirmed"
            : "historical";
  const inferredClosure = autoClosed ||
    (status === "resolved" && !resolvedAt && event.time_confidence === "inferred");
  // Operator incidents measure their first sighting from complete polls, so it
  // is a reliable "started no later than" for every status, not only active.
  const operatorOrigin = event.origin === "operator";
  const activeSinceAt = startedAt ?? (operatorOrigin || status === "active" || status === "stale_unconfirmed" ? isoOrNull(event.first_seen_at) : null);
  const startEarliestAt = !startedAt && operatorOrigin ? isoOrNull(event.start_earliest_at) : null;
  // Without a reported start or end, the duration is the distance between the
  // midpoints of the start window and the end window (both one polling interval).
  let estimatedDuration: number | null = null;
  if (durationMinutes === null && operatorOrigin && status === "resolved" && activeSinceAt) {
    const startLatest = new Date(activeSinceAt).getTime();
    const startEarliest = startEarliestAt ? new Date(startEarliestAt).getTime() : startLatest;
    const endEarliest = new Date(resolvedAt ?? event.resolution_earliest_at ?? "").getTime();
    const endLatest = new Date(resolvedAt ?? event.resolution_latest_at ?? "").getTime();
    const minutes = ((endEarliest + endLatest) / 2 - (startEarliest + startLatest) / 2) / 60000;
    if (Number.isFinite(minutes) && minutes >= 0 && minutes < 14 * 24 * 60) estimatedDuration = Math.round(minutes);
  }
  const location = publicDisplayLocation(event.location_text);
  return {
    id: event.id,
    location,
    canton: event.canton,
    url: publicEventPath({ id: event.id, location }),
    received_at: event.received_at,
    started_at: startedAt,
    resolved_at: resolvedAt,
    status,
    nature,
    duration_minutes: durationMinutes ?? estimatedDuration,
    duration_is_estimate: durationMinutes === null && estimatedDuration !== null,
    active_since_at: activeSinceAt,
    active_since_is_minimum: Boolean(activeSinceAt && !startedAt),
    start_earliest_at: startEarliestAt,
    last_confirmed_active_at: lastConfirmedActiveAt,
    expected_restore_at: expectedRestoreAt,
    resolution_earliest_at: isoOrNull(event.resolution_earliest_at),
    resolution_latest_at: isoOrNull(event.resolution_latest_at),
    time_confidence: inferredClosure ? "inferred" : event.time_confidence ?? "unknown",
    cause: concreteFact(facts, "cause") ?? (event.cause_text?.trim() || null),
    affected_area: concreteFact(facts, "affected_area"),
    updated_at: event.updated_at,
    summary: decision.summary,
    trust: decision.trust,
    source: decision.primary_source,
    latitude: null,
    longitude: null,
    map_precision: null
  };
}

export function attachPublicMapCoords(
  item: PublicFeedItem | null,
  coords: {
    latitude?: number | null;
    longitude?: number | null;
    precision?: PublicFeedItem["map_precision"];
  } | null | undefined
): PublicFeedItem | null {
  if (!item) return null;
  const latitude = coords?.latitude;
  const longitude = coords?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return item;
  if (latitude < 45.7 || latitude > 47.9 || longitude < 5.9 || longitude > 10.7) return item;
  return {
    ...item,
    latitude,
    longitude,
    map_precision: coords?.precision ?? null
  };
}
