import { canonicalSourceUrl, classifySource } from "./intelligence";
import { normalizePlaceText } from "./places";
import { getOutageEvent, getOutageEventFacts, getOutageEventSnapshots, getOutageEventSources, getPublicFeedItem } from "./db";
import { getPublicItem } from "./public-projection";
import { evidenceScreenshotKey } from "./snapshots";
import { operatorHostnames, operatorProfileUrl, resolveOperatorProfile } from "./operators";
import type { Env, OutageEvent, OutageFact, OutageSource, PublicFeedItem, SourceSnapshot } from "./types";

export interface GeoAdminSearchResult {
  id: string | number;
  weight?: number;
  attrs: {
    detail?: string;
    label?: string;
    lat?: number;
    lon?: number;
    origin?: string;
    rank?: number;
  };
}

export interface PublicEventLocation {
  query: string;
  label: string;
  latitude: number;
  longitude: number;
  precision: "address" | "locality" | "municipality" | "district" | "region";
  provider: "geo.admin.ch";
}

export interface PublicDetailFact {
  key: "start_time" | "end_time" | "duration" | "active_since" | "last_confirmed" | "expected_restore" | "resolution_window" | "nature" | "status" | "affected_area" | "cause";
  label: string;
  value: string;
  format: "text" | "datetime" | "duration";
}

export interface PublicDetailOperator {
  name: string;
  role: "Netzbetreiber" | "Behörde";
  area: string | null;
  url: string;
  domain: string;
  profile_url: string | null;
}

export interface PublicDetailSource {
  publisher: string;
  url: string;
  domain: string;
  role: "operator" | "authority" | "media";
  title: string | null;
  published_at: string | null;
  excerpt: string | null;
  facts: Array<{
    label: string;
    value: string;
    format: "text" | "datetime";
  }>;
}

export interface PublicTimelineEntry {
  key: "received_at" | "start_time" | "end_time";
  label: string;
  value: string;
}

export interface PublicEvidenceScreenshot {
  snapshot_id: number;
  image_url: string;
  source_url: string;
  publisher: string;
  captured_at: string;
  sha256: string;
  format: "png";
}

export interface PublicEventDetail {
  item: PublicFeedItem;
  map: PublicEventLocation | null;
  facts: PublicDetailFact[];
  timeline: PublicTimelineEntry[];
  operator: PublicDetailOperator | null;
  sources: PublicDetailSource[];
  evidence: PublicEvidenceScreenshot[];
}

export function publicLocationQuery(value: string | null | undefined): string {
  const cleaned = (value ?? "")
    .replace(/^\s*(?:in|im|bei)\s+/i, "")
    .replace(/,?\s*(?:schweiz|suisse|svizzera|switzerland)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const compoundFirst = cleaned.split(/\s+(?:und|et|e)\s+/i)[0]?.trim() || cleaned;
  const parts = compoundFirst.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return compoundFirst;
  const first = normalizePlaceText(parts[0]);
  const genericFirst = /^(?:gemeinde|stadt|region|bezirk|feuerschaugemeinde)$/.test(first);
  return genericFirst ? parts[1] : parts[0];
}

function plainLabel(value: string | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function precisionForOrigin(origin: string | undefined): PublicEventLocation["precision"] {
  if (origin === "address") return "address";
  if (origin === "district") return "district";
  if (origin === "gg25" || origin === "zipcode") return "municipality";
  if (origin === "gazetteer") return "locality";
  return "region";
}

export function choosePublicLocation(
  locationText: string,
  results: GeoAdminSearchResult[]
): PublicEventLocation | null {
  const query = publicLocationQuery(locationText);
  const normalizedQuery = normalizePlaceText(query);
  const queryTokens = new Set(normalizedQuery.split(" ").filter((token) => token.length >= 3));

  const candidates = results
    .filter((result) => {
      const { lat, lon } = result.attrs;
      return typeof lat === "number" && typeof lon === "number" && lat >= 45.7 && lat <= 47.9 && lon >= 5.9 && lon <= 10.7;
    })
    .map((result) => {
      const detail = normalizePlaceText(`${result.attrs.detail ?? ""} ${plainLabel(result.attrs.label)}`);
      const overlap = [...queryTokens].filter((token) => (` ${detail} `).includes(` ${token} `)).length;
      const originBonus = result.attrs.origin === "gg25" ? 30 : result.attrs.origin === "address" ? 24 : result.attrs.origin === "gazetteer" ? 16 : 8;
      const rankPenalty = Math.min(20, Number(result.attrs.rank ?? 10));
      return { result, score: overlap * 50 + originBonus + Number(result.weight ?? 0) / 10 - rankPenalty };
    })
    .filter((candidate) => candidate.score >= 40)
    .sort((a, b) => b.score - a.score);

  const selected = candidates[0]?.result;
  if (!selected || typeof selected.attrs.lat !== "number" || typeof selected.attrs.lon !== "number") return null;
  return {
    query,
    label: plainLabel(selected.attrs.label) || query,
    latitude: selected.attrs.lat,
    longitude: selected.attrs.lon,
    precision: precisionForOrigin(selected.attrs.origin),
    provider: "geo.admin.ch"
  };
}

const HIDDEN_FACT_VALUES = new Set(["", "unknown", "unclear", "unbekannt", "unklar", "null"]);

function concreteFact(facts: OutageFact[], type: OutageFact["fact_type"]): OutageFact | null {
  const matches = facts
    .filter((fact) => fact.fact_type === type && fact.confidence >= 0.7)
    .filter((fact) => !HIDDEN_FACT_VALUES.has(normalizePlaceText(fact.value_text)))
    .sort((left, right) => {
      const backfillPriority = Number(right.extractor_version === "historical-backfill/v1") - Number(left.extractor_version === "historical-backfill/v1");
      if (backfillPriority !== 0) return backfillPriority;
      return right.confidence - left.confidence;
    });
  if (matches[0]?.extractor_version === "historical-backfill/v1") return matches[0];
  const distinct = new Set(matches.map((fact) => normalizePlaceText(fact.value_text)));
  return distinct.size === 1 ? matches[0] ?? null : null;
}

function validIso(value: string): boolean {
  return Boolean(value) && Number.isFinite(new Date(value).getTime());
}

function publicFacts(facts: OutageFact[], item: PublicFeedItem): PublicDetailFact[] {
  const output: PublicDetailFact[] = [];
  const start = concreteFact(facts, "start_time");
  const end = concreteFact(facts, "end_time");
  const nature = concreteFact(facts, "planned_nature");
  const area = concreteFact(facts, "affected_area");
  const cause = concreteFact(facts, "cause");

  // Operator incidents carry no extracted facts: their times live on the item.
  const natureValue = normalizePlaceText(nature?.value_text) || item.nature;
  const isPlanned = ["planned", "geplant"].includes(natureValue);
  const startValue = start && validIso(start.value_text) ? start.value_text : item.started_at;
  if (startValue && validIso(startValue)) {
    output.push({ key: "start_time", label: isPlanned ? "Geplanter Beginn" : "Beginn", value: startValue, format: "datetime" });
  } else if (item.active_since_at && item.active_since_is_minimum) {
    output.push({ key: "active_since", label: "Erstmals gemeldet", value: item.active_since_at, format: "datetime" });
  }
  const endValue = end && validIso(end.value_text)
    ? end.value_text
    : item.resolved_at ?? (isPlanned && item.status === "upcoming" ? item.expected_restore_at : null);
  if (endValue && validIso(endValue)) {
    output.push({ key: "end_time", label: isPlanned ? "Geplantes Ende" : "Behoben", value: endValue, format: "datetime" });
  }
  if (natureValue === "planned" || natureValue === "geplant") {
    output.push({ key: "nature", label: "Art", value: "Geplant", format: "text" });
  } else if (natureValue === "unplanned" || natureValue === "ungeplant") {
    output.push({ key: "nature", label: "Art", value: "Ungeplant", format: "text" });
  }
  if (item.status === "active") {
    output.push({ key: "status", label: "Status", value: "Noch aktiv", format: "text" });
  } else if (item.status === "resolved") {
    output.push({
      key: "status",
      label: "Status",
      value: item.time_confidence === "inferred" && !item.resolved_at ? "Automatisch abgeschlossen" : "Behoben",
      format: "text"
    });
  } else if (item.status === "stale_unconfirmed") {
    output.push({ key: "status", label: "Status", value: "Nicht mehr bestätigt", format: "text" });
  } else if (item.status === "historical") {
    output.push({ key: "status", label: "Status", value: "Historische Meldung", format: "text" });
  } else if (item.status === "upcoming") {
    output.push({ key: "status", label: "Status", value: "Bevorstehend", format: "text" });
  }
  if (item.last_confirmed_active_at && (item.status === "active" || item.status === "stale_unconfirmed")) {
    output.push({ key: "last_confirmed", label: "Zuletzt aktiv bestätigt", value: item.last_confirmed_active_at, format: "datetime" });
  }
  if (item.expected_restore_at && item.status === "active") {
    output.push({ key: "expected_restore", label: "Behebung erwartet", value: item.expected_restore_at, format: "datetime" });
  }
  if (item.resolution_earliest_at && item.resolution_latest_at && item.time_confidence === "inferred") {
    output.push({
      key: "resolution_window",
      label: "Vermutlich behoben",
      value: `${item.resolution_earliest_at}|${item.resolution_latest_at}`,
      format: "text"
    });
  }
  if (area) output.push({ key: "affected_area", label: "Betroffen", value: area.value_text, format: "text" });
  const causeValue = cause?.value_text.trim();
  if (causeValue && !HIDDEN_FACT_VALUES.has(normalizePlaceText(causeValue))) {
    output.push({ key: "cause", label: "Ursache", value: causeValue, format: "text" });
  }
  return output;
}

const SOURCE_FACT_LABELS: Partial<Record<OutageFact["fact_type"], string>> = {
  start_time: "Beginn",
  end_time: "Ende",
  planned_nature: "Art",
  cause: "Ursache",
  affected_area: "Betroffen"
};
const SOURCE_FACT_ORDER: OutageFact["fact_type"][] = [
  "start_time",
  "end_time",
  "planned_nature",
  "affected_area",
  "cause"
];

function conciseExcerpt(value: string | null | undefined, maxLength = 320): string | null {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  const shortened = cleaned.slice(0, maxLength);
  return `${shortened.slice(0, shortened.lastIndexOf(" ")) || shortened}…`;
}

function factsForSource(source: OutageSource, facts: OutageFact[]): PublicDetailSource["facts"] {
  const candidates = facts
    .filter((fact) => fact.confidence >= 0.7)
    .filter((fact) => fact.outage_source_id === source.id || fact.alert_item_id === source.alert_item_id)
    .filter((fact) => Boolean(SOURCE_FACT_LABELS[fact.fact_type]))
    .filter((fact) => !HIDDEN_FACT_VALUES.has(normalizePlaceText(fact.value_text)))
    .sort((left, right) => right.confidence - left.confidence);
  const selected = new Map<OutageFact["fact_type"], OutageFact>();
  for (const fact of candidates) {
    if (!selected.has(fact.fact_type)) selected.set(fact.fact_type, fact);
  }
  return [...selected.values()]
    .sort((left, right) => SOURCE_FACT_ORDER.indexOf(left.fact_type) - SOURCE_FACT_ORDER.indexOf(right.fact_type))
    .slice(0, 5)
    .map((fact) => ({
    label: SOURCE_FACT_LABELS[fact.fact_type]!,
    value: fact.fact_type === "planned_nature"
      ? normalizePlaceText(fact.value_text) === "planned" ? "Geplant" : "Ungeplant"
      : fact.value_text,
    format: fact.fact_type === "start_time" || fact.fact_type === "end_time" ? "datetime" : "text"
    }));
}

function excerptForSource(
  item: PublicFeedItem,
  source: OutageSource,
  facts: OutageFact[]
): string | null {
  const linkedEvidence = facts
    .filter((fact) => fact.confidence >= 0.7 && (fact.evidence_excerpt ?? "").trim())
    // Historical backfill facts describe our classification decision, not the
    // publisher's article. Never present those internal notes as source copy.
    .filter((fact) => fact.extractor_version !== "historical-backfill/v1")
    .filter((fact) => !/(?:36-stunden-fenster|publikationsentscheid|publishable|nicht publiziert)/i.test(fact.evidence_excerpt ?? ""))
    .filter((fact) => fact.outage_source_id === source.id || fact.alert_item_id === source.alert_item_id)
    .sort((left, right) => right.confidence - left.confidence)
    .map((fact) => conciseExcerpt(fact.evidence_excerpt))
    .find(Boolean);
  if (linkedEvidence) return linkedEvidence;
  return source.is_primary ? conciseExcerpt(item.summary) : null;
}

function publicSources(item: PublicFeedItem, sources: OutageSource[], facts: OutageFact[]): PublicDetailSource[] {
  const evidencedSourceIds = new Set(facts.filter((fact) => fact.confidence >= 0.65).flatMap((fact) =>
    typeof fact.outage_source_id === "number" ? [fact.outage_source_id] : []
  ));
  const evidencedAlertIds = new Set(facts.filter((fact) => fact.confidence >= 0.65).flatMap((fact) =>
    typeof fact.alert_item_id === "number" ? [fact.alert_item_id] : []
  ));
  const output = sources.flatMap((source): PublicDetailSource[] => {
    if (!evidencedSourceIds.has(source.id) && !evidencedAlertIds.has(source.alert_item_id)) return [];
    const url = canonicalSourceUrl(source.source_url);
    if (!url) return [];
    const intel = classifySource({ url, title: source.source_title, sourceName: source.source_name });
    if (!["official", "operator", "local_media", "national_media"].includes(intel.source_kind)) return [];
    const domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return [{
      publisher: source.source_name?.trim() || domain,
      url,
      domain,
      role: intel.source_kind === "operator" ? "operator" : intel.source_kind === "official" ? "authority" : "media",
      title: source.source_title?.trim() || null,
      published_at: source.published_at ?? null,
      excerpt: excerptForSource(item, source, facts),
      facts: factsForSource(source, facts)
    }];
  });
  if (!output.some((source) => source.url === item.source.url)) {
    const intel = classifySource({
      url: item.source.url,
      title: item.summary,
      sourceName: item.source.publisher
    });
    output.unshift({
      ...item.source,
      role: intel.source_kind === "operator" ? "operator" : intel.source_kind === "official" ? "authority" : "media",
      title: null,
      published_at: null,
      excerpt: conciseExcerpt(item.summary),
      facts: []
    });
  }
  return output.filter((source, index, all) =>
    all.findIndex((candidate) => candidate.domain === source.domain && candidate.url === source.url) === index
  );
}

export function buildPublicEventDetail(input: {
  item: PublicFeedItem;
  event: OutageEvent;
  facts: OutageFact[];
  sources: OutageSource[];
  location: PublicEventLocation | null;
  operator: PublicDetailOperator | null;
  evidence?: PublicEvidenceScreenshot[];
}): PublicEventDetail {
  const facts = publicFacts(input.facts, input.item);
  if (input.item.duration_minutes !== null) {
    const hours = Math.floor(input.item.duration_minutes / 60);
    const minutes = input.item.duration_minutes % 60;
    facts.splice(Math.min(2, facts.length), 0, {
      key: "duration",
      label: "Dauer",
      value: `${input.item.duration_is_estimate ? "ca. " : ""}${hours ? `${hours} Std.${minutes ? ` ${minutes} Min.` : ""}` : `${minutes} Min.`}`,
      format: "text"
    });
  }
  const timeline: PublicTimelineEntry[] = [{
    key: "received_at",
    label: "Bei outage.ch eingegangen",
    value: input.item.received_at
  }];
  for (const fact of facts) {
    if (fact.key === "start_time") timeline.push({ key: "start_time", label: "Gemeldeter Beginn", value: fact.value });
    if (fact.key === "end_time") timeline.push({ key: "end_time", label: "Als behoben gemeldet", value: fact.value });
  }
  timeline.sort((a, b) => {
    const timeDifference = new Date(a.value).getTime() - new Date(b.value).getTime();
    if (timeDifference !== 0) return timeDifference;
    return a.key.localeCompare(b.key);
  });
  return {
    item: input.item,
    map: input.location,
    facts,
    timeline,
    operator: input.operator,
    sources: publicSources(input.item, input.sources, input.facts),
    evidence: input.evidence ?? []
  };
}

async function publicEvidenceScreenshots(
  bucket: R2Bucket,
  sources: OutageSource[],
  snapshots: SourceSnapshot[],
  publicSources: PublicDetailSource[]
): Promise<PublicEvidenceScreenshot[]> {
  const publicUrls = new Set(publicSources.map((source) => source.url));
  const publisherByUrl = new Map(publicSources.map((source) => [source.url, source.publisher]));
  const candidates = snapshots.filter((snapshot) =>
    snapshot.outage_source_id !== null &&
    publicUrls.has(canonicalSourceUrl(snapshot.url) ?? snapshot.url)
  ).slice(0, 5);
  const output: PublicEvidenceScreenshot[] = [];
  for (const snapshot of candidates) {
    const object = await bucket.head(evidenceScreenshotKey(snapshot.id));
    const hash = object?.customMetadata?.content_hash;
    if (!object || !hash) continue;
    const url = canonicalSourceUrl(snapshot.url) ?? snapshot.url;
    output.push({
      snapshot_id: snapshot.id,
      image_url: `/api/public/evidence/${snapshot.id}.png`,
      source_url: url,
      publisher: publisherByUrl.get(url) ?? new URL(url).hostname.replace(/^www\./, ""),
      captured_at: object.customMetadata?.captured_at ?? snapshot.fetched_at,
      sha256: hash,
      format: "png"
    });
  }
  return output;
}

async function cachedPublicLocation(db: D1Database, eventId: number): Promise<PublicEventLocation | null> {
  return await db
    .prepare(
      `SELECT query_text AS query, label, latitude, longitude, precision, provider
       FROM event_public_locations
       WHERE outage_event_id = ?`
    )
    .bind(eventId)
    .first<PublicEventLocation>();
}

async function cachedPublicLocationMiss(
  db: D1Database,
  eventId: number,
  query: string,
  now = new Date()
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT query_text, retry_after
       FROM event_public_location_misses
       WHERE outage_event_id = ?`
    )
    .bind(eventId)
    .first<{ query_text: string; retry_after: string }>();
  return Boolean(row && row.query_text === query && new Date(row.retry_after).getTime() > now.getTime());
}

async function cachePublicLocationMiss(db: D1Database, eventId: number, query: string): Promise<void> {
  const retryAfter = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO event_public_location_misses (outage_event_id, query_text, retry_after, attempted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(outage_event_id) DO UPDATE SET
         query_text = excluded.query_text,
         retry_after = excluded.retry_after,
         attempted_at = excluded.attempted_at`
    )
    .bind(eventId, query, retryAfter, new Date().toISOString())
    .run();
}

async function cachePublicLocation(db: D1Database, eventId: number, location: PublicEventLocation): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_public_locations (
         outage_event_id, query_text, label, latitude, longitude, precision, provider, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(outage_event_id) DO UPDATE SET
         query_text = excluded.query_text,
         label = excluded.label,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         precision = excluded.precision,
         provider = excluded.provider,
         resolved_at = excluded.resolved_at`
    )
    .bind(
      eventId,
      location.query,
      location.label,
      location.latitude,
      location.longitude,
      location.precision,
      location.provider,
      new Date().toISOString()
    )
    .run();
  await db.prepare("DELETE FROM event_public_location_misses WHERE outage_event_id = ?").bind(eventId).run();
}

export async function resolvePublicEventLocation(
  db: D1Database,
  event: Pick<OutageEvent, "id" | "location_text">,
  fetcher: typeof fetch = fetch
): Promise<PublicEventLocation | null> {
  const query = publicLocationQuery(event.location_text);
  if (!query) return null;
  const cached = await cachedPublicLocation(db, event.id);
  if (cached?.query === query) return cached;
  if (await cachedPublicLocationMiss(db, event.id, query)) return null;
  try {
    const url = new URL("https://api3.geo.admin.ch/rest/services/ech/SearchServer");
    url.searchParams.set("searchText", query);
    url.searchParams.set("type", "locations");
    url.searchParams.set("limit", "8");
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) {
      await cachePublicLocationMiss(db, event.id, query);
      return null;
    }
    const payload = await response.json() as { results?: GeoAdminSearchResult[] };
    const location = choosePublicLocation(query, payload.results ?? []);
    if (!location) {
      await cachePublicLocationMiss(db, event.id, query);
      return null;
    }
    await cachePublicLocation(db, event.id, location);
    return location;
  } catch {
    await cachePublicLocationMiss(db, event.id, query).catch(() => undefined);
    return null;
  }
}

async function getPublicOperator(db: D1Database, eventId: number): Promise<PublicDetailOperator | null> {
  const row = await db
    .prepare(
      `SELECT authority.display_name, authority.authority_kind,
              registry.operator_name, registry.area_text,
              decision.primary_source_url, decision.primary_source_domain
       FROM publication_decisions decision
       LEFT JOIN source_authorities authority
         ON authority.hostname = decision.primary_source_domain
        AND authority.enabled = 1
        AND authority.trust_level = 'official'
        AND authority.authority_kind = 'operator'
       INNER JOIN source_registry registry
         ON registry.id = authority.source_registry_id AND registry.trust_level = 'official'
       WHERE decision.outage_event_id = ? AND decision.publishable = 1
       LIMIT 1`
    )
    .bind(eventId)
    .first<{
      display_name: string | null;
      authority_kind: string | null;
      operator_name: string | null;
      area_text: string | null;
      primary_source_url: string;
      primary_source_domain: string;
    }>();
  if (!row?.display_name && !row?.operator_name) return null;
  return withOperatorProfile({
    name: row.operator_name?.trim() || row.display_name!.trim(),
    role: row.authority_kind === "operator" ? "Netzbetreiber" : "Behörde",
    area: row.area_text?.trim() || null,
    url: row.primary_source_url,
    domain: row.primary_source_domain
  });
}

function withOperatorProfile(operator: Omit<PublicDetailOperator, "profile_url">): PublicDetailOperator {
  const profile = resolveOperatorProfile({
    name: operator.name,
    domain: operator.domain,
    url: operator.url
  });
  return { ...operator, profile_url: profile ? operatorProfileUrl(profile) : null };
}

function operatorFromPublicItem(item: PublicFeedItem): PublicDetailOperator | null {
  const profile = resolveOperatorProfile({
    name: item.source.publisher,
    domain: item.source.domain,
    url: item.source.url
  });
  if (!profile) return null;
  return withOperatorProfile({
    name: profile.name,
    role: "Netzbetreiber",
    area: profile.area,
    url: profile.officialUrl,
    domain: operatorHostnames(profile)[0] ?? item.source.domain
  });
}

export async function loadPublicEventDetail(
  env: Pick<Env, "DB" | "SNAPSHOTS">,
  eventId: number
): Promise<PublicEventDetail | null> {
  // The projection is the source of truth; the legacy computation only bridges
  // the minutes between a fresh deploy and the first projection refresh.
  const item = await getPublicItem(env.DB, eventId) ?? await getPublicFeedItem(env.DB, eventId);
  if (!item) return null;
  const event = await getOutageEvent(env.DB, eventId);
  if (!event) return null;
  const [facts, sources, snapshots, location, operator] = await Promise.all([
    getOutageEventFacts(env.DB, eventId),
    getOutageEventSources(env.DB, eventId),
    getOutageEventSnapshots(env.DB, eventId),
    resolvePublicEventLocation(env.DB, event),
    getPublicOperator(env.DB, eventId)
  ]);
  const base = buildPublicEventDetail({
    item,
    event,
    facts,
    sources,
    location,
    operator: operator ?? operatorFromPublicItem(item)
  });
  const evidence = await publicEvidenceScreenshots(env.SNAPSHOTS, sources, snapshots, base.sources);
  return { ...base, evidence };
}
