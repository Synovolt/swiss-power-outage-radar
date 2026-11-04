/**
 * Materialized public projection (see migrations/0020_public_projection.sql).
 *
 * Writer: refreshPublicProjection() — called by the cron and after admin actions.
 * Readers: everything public. No public page computes event state on its own.
 *
 * Cloudflare free-tier budget (D1: 5M rows read / 100k rows written per day):
 * - Refresh reads only candidate rows (new, changed or time-dependent) and writes
 *   only rows whose projected output actually changed.
 * - The compact client index and the statistics are stored as single rows in
 *   public_stats_cache, so hot pages cost one row read per cache miss.
 */
import { attachPublicMapCoords, parsePublicFeedCursor, publicFeedCursor, toPublicFeedItem } from "./publication";
import { resolveOperatorProfile } from "./operators";
import { derivePublicPlaces, placesKey, type PublicPlace } from "./public-places";
import { resolvePublicEventLocation } from "./public-detail";
import { publicEventPath } from "./public-url";
import type { Env, OutageEvent, OutageFact, PublicFeedItem } from "./types";

export const PROJECTION_VERSION = "projection/v1";
const IN_CHUNK = 90; // D1 allows at most 100 bound parameters per statement.
const BATCH_CHUNK = 40;

export interface ProjectionRow extends OutageEvent {
  publication_trust: "official" | "corroborated" | "reported";
  publication_summary: string;
  primary_source_publisher: string;
  primary_source_url: string;
  primary_source_domain: string;
  decision_decided_at: string | null;
  map_latitude: number | null;
  map_longitude: number | null;
  map_precision: PublicFeedItem["map_precision"];
  map_label: string | null;
  map_resolved_at: string | null;
}

export interface PublicProjection {
  eventId: number;
  item: PublicFeedItem;
  places: PublicPlace[];
  canton: string | null;
  operatorSlug: string | null;
  sortBucket: 0 | 1;
  sortAt: string;
  isFinal: boolean;
  sourceUpdatedAt: string;
}

/** Parses D1 timestamps ("2026-07-15 06:47:32" is UTC) and ISO strings alike. */
export function dbTimeMs(value: string | null | undefined): number {
  if (!value) return NaN;
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed;
  return new Date(iso).getTime();
}

function isoOf(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function projectPublicEvent(row: ProjectionRow, facts: OutageFact[], now = Date.now()): PublicProjection | null {
  const base = toPublicFeedItem(row, {
    publishable: true,
    trust: row.publication_trust,
    reasons: [],
    summary: row.publication_summary,
    primary_source: {
      publisher: row.primary_source_publisher,
      url: row.primary_source_url,
      domain: row.primary_source_domain
    }
  }, facts, now);
  const withCoords = attachPublicMapCoords(base, {
    latitude: row.map_latitude,
    longitude: row.map_longitude,
    precision: row.map_precision
  });
  if (!withCoords) return null;

  const { places, canton } = derivePublicPlaces({
    location: withCoords.location,
    label: row.map_label,
    precision: row.map_precision,
    eventCanton: row.canton
  });
  const operator = resolveOperatorProfile({
    name: withCoords.source.publisher,
    domain: withCoords.source.domain,
    url: withCoords.source.url
  });
  const item: PublicFeedItem = {
    ...withCoords,
    canton,
    operator_slug: operator?.slug ?? null,
    operator_name: operator?.name ?? null,
    places: places.map((place) => ({ slug: place.slug, name: place.name }))
  };

  const sortMs = [item.started_at, item.resolved_at, item.received_at, row.created_at, row.first_seen_at]
    .map(dbTimeMs)
    .find(Number.isFinite);
  const sortAt = isoOf(sortMs ?? NaN) ?? new Date(0).toISOString();
  const sourceUpdatedMs = Math.max(
    ...[row.updated_at, row.decision_decided_at, row.map_resolved_at].map(dbTimeMs).filter(Number.isFinite),
    0
  );
  return {
    eventId: row.id,
    item,
    places,
    canton,
    operatorSlug: operator?.slug ?? null,
    sortBucket: item.status === "upcoming" ? 0 : 1,
    sortAt,
    // Only upcoming and active items can change through the passage of time alone.
    isFinal: item.status !== "upcoming" && item.status !== "active",
    sourceUpdatedAt: isoOf(sourceUpdatedMs) ?? new Date(0).toISOString()
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

const PROJECTION_ROW_SQL = `SELECT event.*, decision.trust AS publication_trust,
        decision.public_summary AS publication_summary,
        decision.primary_source_publisher, decision.primary_source_url,
        decision.primary_source_domain, decision.decided_at AS decision_decided_at,
        loc.latitude AS map_latitude, loc.longitude AS map_longitude,
        loc.precision AS map_precision, loc.label AS map_label,
        loc.resolved_at AS map_resolved_at
 FROM outage_events event
 INNER JOIN publication_decisions decision ON decision.outage_event_id = event.id
 LEFT JOIN event_public_locations loc ON loc.outage_event_id = event.id
 WHERE decision.publishable = 1 AND event.status != 'dismissed' AND event.country = 'CH'`;

async function loadProjectionInputs(db: D1Database, ids: number[]): Promise<{
  rows: ProjectionRow[];
  facts: Map<number, OutageFact[]>;
}> {
  const rows: ProjectionRow[] = [];
  const facts = new Map<number, OutageFact[]>();
  for (const part of chunks(ids, IN_CHUNK)) {
    const placeholders = part.map(() => "?").join(", ");
    const [rowResult, factResult] = await Promise.all([
      db.prepare(`${PROJECTION_ROW_SQL} AND event.id IN (${placeholders})`).bind(...part).all<ProjectionRow>(),
      db.prepare(
        `SELECT outage_event_id, fact_type, value_text, confidence, extractor_version
         FROM outage_facts WHERE outage_event_id IN (${placeholders})`
      ).bind(...part).all<OutageFact>()
    ]);
    rows.push(...rowResult.results);
    for (const fact of factResult.results) {
      if (typeof fact.outage_event_id !== "number") continue;
      facts.set(fact.outage_event_id, [...(facts.get(fact.outage_event_id) ?? []), fact]);
    }
  }
  return { rows, facts };
}

const WATERMARK_KEY = "projection:watermark";
/** Overlap between runs so a write committed during the previous run is never missed. */
const WATERMARK_SKEW_MS = 2 * 60 * 1000;

interface Watermark {
  /** "YYYY-MM-DD HH:MM:SS" — the format of outage_events.updated_at (CURRENT_TIMESTAMP). */
  db: string;
  /** ISO — the format of decided_at and event_public_locations.resolved_at. */
  iso: string;
}

async function readWatermark(db: D1Database): Promise<Watermark | null> {
  const row = await db.prepare("SELECT payload_json FROM public_stats_cache WHERE cache_key = ?").bind(WATERMARK_KEY)
    .first<{ payload_json: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as Watermark;
    return parsed.db && parsed.iso ? parsed : null;
  } catch {
    return null;
  }
}

async function writeWatermark(db: D1Database, ms: number): Promise<void> {
  const iso = new Date(ms).toISOString();
  const value: Watermark = { db: iso.replace("T", " ").slice(0, 19), iso };
  await db.prepare(
    `INSERT INTO public_stats_cache (cache_key, payload_json, computed_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, computed_at = excluded.computed_at`
  ).bind(WATERMARK_KEY, JSON.stringify(value), iso).run();
}

/**
 * Indexed candidate lookup: everything touched since the watermark (event row,
 * publication decision, map pin) plus the few rows whose state depends on the
 * clock. Changed rows come first so time-dependent rows can never starve them.
 */
async function changedCandidates(db: D1Database, watermark: Watermark, limit: number): Promise<number[]> {
  const result = await db.prepare(
    `SELECT id, MIN(priority) AS priority FROM (
       SELECT id, 0 AS priority FROM outage_events WHERE updated_at > ?
       UNION ALL SELECT outage_event_id, 0 FROM publication_decisions WHERE decided_at > ?
       UNION ALL SELECT outage_event_id, 0 FROM event_public_locations WHERE resolved_at > ?
       UNION ALL SELECT event_id, 1 FROM public_events WHERE is_final = 0
     )
     GROUP BY id
     ORDER BY priority ASC, id DESC
     LIMIT ?`
  ).bind(watermark.db, watermark.iso, watermark.iso, limit).all<{ id: number }>();
  return result.results.map((row) => row.id);
}

async function allPublishedBefore(db: D1Database, beforeId: number, limit: number): Promise<number[]> {
  const result = await db.prepare(
    `SELECT outage_event_id AS id FROM publication_decisions
     WHERE outage_event_id < ? ORDER BY outage_event_id DESC LIMIT ?`
  ).bind(beforeId, limit).all<{ id: number }>();
  return result.results.map((row) => row.id);
}

/** First run / rebuild only: every published event without an up-to-date projection. */
async function fullScanCandidates(db: D1Database, limit: number): Promise<number[]> {
  const result = await db.prepare(
    `SELECT event.id AS id
     FROM outage_events event
     INNER JOIN publication_decisions decision ON decision.outage_event_id = event.id
     LEFT JOIN public_events p ON p.event_id = event.id
     LEFT JOIN event_public_locations loc ON loc.outage_event_id = event.id
     WHERE decision.publishable = 1 AND event.status != 'dismissed' AND event.country = 'CH'
       AND (
         p.event_id IS NULL
         OR p.is_final = 0
         OR julianday(event.updated_at) > julianday(p.source_updated_at)
         OR julianday(decision.decided_at) > julianday(p.source_updated_at)
         OR (loc.resolved_at IS NOT NULL AND julianday(loc.resolved_at) > julianday(p.source_updated_at))
       )
     ORDER BY (p.event_id IS NULL) DESC, event.id DESC
     LIMIT ?`
  ).bind(limit).all<{ id: number }>();
  return result.results.map((row) => row.id);
}

/**
 * What counts as a change worth a D1 write. "Last confirmed" moves on every
 * poll while an outage is listed; it is only written again once it advanced
 * by an hour, everything else is written as soon as it changes.
 */
export function stableItemKey(itemJson: string): string {
  try {
    const item = JSON.parse(itemJson) as PublicFeedItem;
    const confirmed = item.last_confirmed_active_at ? Math.floor(new Date(item.last_confirmed_active_at).getTime() / 3_600_000) : null;
    return JSON.stringify({ ...item, updated_at: null, last_confirmed_active_at: confirmed });
  } catch {
    return itemJson;
  }
}

export interface ProjectionRefreshResult {
  candidates: number;
  written: number;
  removed: number;
  locationsResolved: number;
  errors: string[];
  /** Cursor for the next page of a full rebuild, null when done. */
  nextBeforeId: number | null;
}

/**
 * Brings public_events up to date. Without `eventIds` it picks new rows, rows
 * whose inputs changed since the last projection and rows whose state depends
 * on the clock (upcoming/active), newest first and bounded by `limit`.
 */
export async function refreshPublicProjection(
  env: Pick<Env, "DB">,
  options: {
    limit?: number;
    eventIds?: number[];
    now?: number;
    resolveLocations?: number;
    sweepOrphans?: boolean;
    /** Re-project every published event with an id below this cursor (paged full rebuild). */
    fullBeforeId?: number;
  } = {}
): Promise<ProjectionRefreshResult> {
  const db = env.DB;
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 400)));
  const result: ProjectionRefreshResult = { candidates: 0, written: 0, removed: 0, locationsResolved: 0, errors: [], nextBeforeId: null };
  const targeted = Boolean(options.eventIds?.length) || options.fullBeforeId !== undefined;

  const watermark = targeted ? null : await readWatermark(db);
  const startedAt = now;
  const ids = options.eventIds?.length
    ? [...new Set(options.eventIds)].slice(0, limit)
    : options.fullBeforeId !== undefined
      ? await allPublishedBefore(db, options.fullBeforeId, limit)
      : watermark
      ? await changedCandidates(db, watermark, limit)
      : await fullScanCandidates(db, limit);
  result.candidates = ids.length;
  if (options.fullBeforeId !== undefined && ids.length === limit) result.nextBeforeId = Math.min(...ids);

  if (ids.length) {
    const { rows, facts } = await loadProjectionInputs(db, ids);

    // Resolve a few missing map pins per run. Until now pins were only resolved
    // when someone (usually a crawler) opened the detail page. Rows whose last
    // lookup failed recently are skipped so they cannot block newer events.
    let budget = Math.max(0, options.resolveLocations ?? 0);
    const pinless = rows.filter((row) => typeof row.map_latitude !== "number").sort((a, b) => b.id - a.id);
    const recentMisses = new Set<number>();
    if (budget > 0 && pinless.length) {
      for (const part of chunks(pinless.map((row) => row.id), IN_CHUNK)) {
        const found = await db.prepare(
          `SELECT outage_event_id FROM event_public_location_misses
           WHERE outage_event_id IN (${part.map(() => "?").join(", ")}) AND retry_after > ?`
        ).bind(...part, new Date(now).toISOString()).all<{ outage_event_id: number }>();
        for (const miss of found.results) recentMisses.add(miss.outage_event_id);
      }
    }
    for (const row of pinless) {
      if (budget <= 0) break;
      if (recentMisses.has(row.id)) continue;
      budget -= 1;
      try {
        const location = await resolvePublicEventLocation(db, row);
        if (location) {
          row.map_latitude = location.latitude;
          row.map_longitude = location.longitude;
          row.map_precision = location.precision as PublicFeedItem["map_precision"];
          row.map_label = location.label;
          row.map_resolved_at = new Date(now).toISOString();
          result.locationsResolved += 1;
        }
      } catch (error) {
        result.errors.push(`location ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const existing = new Map<number, { item_json: string; places_key: string; source_updated_at: string; sort_bucket: number; is_final: number }>();
    for (const part of chunks(ids, IN_CHUNK)) {
      const placeholders = part.map(() => "?").join(", ");
      const found = await db.prepare(
        `SELECT event_id, item_json, places_key, source_updated_at, sort_bucket, is_final
         FROM public_events WHERE event_id IN (${placeholders})`
      ).bind(...part).all<{ event_id: number; item_json: string; places_key: string; source_updated_at: string; sort_bucket: number; is_final: number }>();
      for (const row of found.results) existing.set(row.event_id, row);
    }

    const statements: D1PreparedStatement[] = [];
    const projectedIds = new Set<number>();
    const projectedAt = new Date(now).toISOString();
    for (const row of rows) {
      const projection = projectPublicEvent(row, facts.get(row.id) ?? [], now);
      if (!projection) continue;
      projectedIds.add(row.id);
      const itemJson = JSON.stringify(projection.item);
      const key = placesKey(projection.places);
      const previous = existing.get(row.id);
      if (
        previous &&
        previous.places_key === key &&
        previous.sort_bucket === projection.sortBucket &&
        previous.is_final === Number(projection.isFinal) &&
        stableItemKey(previous.item_json) === stableItemKey(itemJson)
      ) continue;
      const item = projection.item;
      statements.push(db.prepare(
        `INSERT INTO public_events (
           event_id, status, nature, trust, location, canton, operator_slug, publisher,
           received_at, started_at, resolved_at, end_earliest_at, end_latest_at,
           expected_restore_at, duration_minutes, sort_bucket, sort_at, latitude, longitude,
           places_key, item_json, is_final, source_updated_at, projected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           status = excluded.status, nature = excluded.nature, trust = excluded.trust,
           location = excluded.location, canton = excluded.canton,
           operator_slug = excluded.operator_slug, publisher = excluded.publisher,
           received_at = excluded.received_at, started_at = excluded.started_at,
           resolved_at = excluded.resolved_at, end_earliest_at = excluded.end_earliest_at,
           end_latest_at = excluded.end_latest_at, expected_restore_at = excluded.expected_restore_at,
           duration_minutes = excluded.duration_minutes, sort_bucket = excluded.sort_bucket,
           sort_at = excluded.sort_at, latitude = excluded.latitude, longitude = excluded.longitude,
           places_key = excluded.places_key, item_json = excluded.item_json,
           is_final = excluded.is_final, source_updated_at = excluded.source_updated_at,
           projected_at = excluded.projected_at`
      ).bind(
        row.id, item.status ?? "historical", item.nature, item.trust, item.location, projection.canton,
        projection.operatorSlug, item.operator_name ?? item.source.publisher,
        item.received_at, item.started_at, item.resolved_at, item.resolution_earliest_at ?? null,
        item.resolution_latest_at ?? null, item.expected_restore_at ?? null, item.duration_minutes,
        projection.sortBucket, projection.sortAt, item.latitude ?? null, item.longitude ?? null,
        key, itemJson, Number(projection.isFinal), projection.sourceUpdatedAt, projectedAt
      ));
      if (!previous || previous.places_key !== key) {
        statements.push(db.prepare("DELETE FROM public_event_places WHERE event_id = ?").bind(row.id));
        for (const place of projection.places) {
          statements.push(db.prepare(
            "INSERT OR IGNORE INTO public_event_places (event_id, place_slug, place_name, canton) VALUES (?, ?, ?, ?)"
          ).bind(row.id, place.slug, place.name, place.canton));
        }
      }
      result.written += 1;
    }

    // Candidates that no longer produce a public item (e.g. summary withdrawn).
    const vanished = ids.filter((id) => !projectedIds.has(id) && existing.has(id));
    for (const id of vanished) {
      statements.push(db.prepare("DELETE FROM public_event_places WHERE event_id = ?").bind(id));
      statements.push(db.prepare("DELETE FROM public_events WHERE event_id = ?").bind(id));
      result.removed += 1;
    }
    for (const part of chunks(statements, BATCH_CHUNK)) await db.batch(part);
  }

  // Advance the watermark only when this run saw every changed candidate;
  // a truncated run is simply continued by the next one.
  if (!targeted && ids.length < limit) {
    await writeWatermark(db, startedAt - WATERMARK_SKEW_MS);
  }

  // Events that left the public set entirely (dismissed, merged, gate failed).
  // Targeted refreshes already remove their own ids above; the full sweep only
  // runs when asked (hourly from the cron) to keep D1 reads low.
  if (!options.sweepOrphans) return result;
  const orphanSql = `SELECT p.event_id FROM public_events p
    LEFT JOIN outage_events event ON event.id = p.event_id
    LEFT JOIN publication_decisions decision ON decision.outage_event_id = p.event_id
    WHERE event.id IS NULL OR decision.publishable IS NOT 1
      OR event.status = 'dismissed' OR event.country IS NOT 'CH'`;
  const orphans = (await db.prepare(orphanSql).all<{ event_id: number }>()).results.map((row) => row.event_id);
  if (orphans.length) {
    const statements = orphans.flatMap((id) => [
      db.prepare("DELETE FROM public_event_places WHERE event_id = ?").bind(id),
      db.prepare("DELETE FROM public_events WHERE event_id = ?").bind(id)
    ]);
    for (const part of chunks(statements, BATCH_CHUNK)) await db.batch(part);
    result.removed += orphans.length;
  }
  return result;
}

// ---------------------------------------------------------------- readers

function parseItem(json: string): PublicFeedItem | null {
  try {
    return JSON.parse(json) as PublicFeedItem;
  } catch {
    return null;
  }
}

/**
 * Feed cursor. "u|<sort_at>|<id>" continues inside the upcoming bucket
 * (ascending); the legacy "<sort_at>|<id>" form continues in the past bucket.
 */
export function encodeFeedCursor(bucket: 0 | 1, sortAt: string, id: number): string {
  return bucket === 0 ? `u|${sortAt}|${id}` : publicFeedCursor({ id, received_at: sortAt });
}

export function decodeFeedCursor(value: string | null | undefined): { bucket: 0 | 1; sortAt: string; id: number } | null {
  if (!value) return null;
  if (value.startsWith("u|")) {
    const parsed = parsePublicFeedCursor(value.slice(2));
    return parsed ? { bucket: 0, sortAt: parsed.receivedAt, id: parsed.id } : null;
  }
  const parsed = parsePublicFeedCursor(value);
  return parsed ? { bucket: 1, sortAt: parsed.receivedAt, id: parsed.id } : null;
}

interface BucketFilter {
  from: string;
  where: string[];
  binds: unknown[];
}

function bucketFilter(input: { operatorSlug?: string; placeSlug?: string; canton?: string; excludeId?: number }): BucketFilter {
  const filter: BucketFilter = { from: "public_events p", where: [], binds: [] };
  if (input.placeSlug) {
    filter.from = "public_event_places pl INNER JOIN public_events p ON p.event_id = pl.event_id";
    filter.where.push("pl.place_slug = ?");
    filter.binds.push(input.placeSlug);
  }
  if (input.operatorSlug) {
    filter.where.push("p.operator_slug = ?");
    filter.binds.push(input.operatorSlug);
  }
  if (input.canton) {
    filter.where.push("p.canton = ?");
    filter.binds.push(input.canton);
  }
  if (input.excludeId) {
    filter.where.push("p.event_id != ?");
    filter.binds.push(input.excludeId);
  }
  return filter;
}

/**
 * Reads one bucket in index order: upcoming ascending by start, everything
 * else newest first. Two small indexed queries instead of one ORDER BY that
 * forces a full scan and sort.
 */
async function readBucket(
  db: D1Database,
  bucket: 0 | 1,
  filter: BucketFilter,
  limit: number,
  after?: { sortAt: string; id: number }
): Promise<Array<{ event_id: number; sort_at: string; item_json: string }>> {
  if (limit <= 0) return [];
  const where = [...filter.where, "p.sort_bucket = ?"];
  const binds = [...filter.binds, bucket];
  if (after) {
    where.push(bucket === 0
      ? "(p.sort_at > ? OR (p.sort_at = ? AND p.event_id > ?))"
      : "(p.sort_at < ? OR (p.sort_at = ? AND p.event_id < ?))");
    binds.push(after.sortAt, after.sortAt, after.id);
  }
  const order = bucket === 0 ? "p.sort_at ASC, p.event_id ASC" : "p.sort_at DESC, p.event_id DESC";
  const result = await db.prepare(
    `SELECT p.event_id, p.sort_at, p.item_json FROM ${filter.from}
     WHERE ${where.join(" AND ")}
     ORDER BY ${order}
     LIMIT ?`
  ).bind(...binds, limit).all<{ event_id: number; sort_at: string; item_json: string }>();
  return result.results;
}

export async function listPublicFeed(
  db: D1Database,
  input: { limit?: number; before?: string | null } = {}
): Promise<{ items: PublicFeedItem[]; next_cursor: string | null }> {
  const requested = Number(input.limit ?? 10);
  const limit = Math.max(1, Math.min(40, Math.floor(Number.isFinite(requested) ? requested : 10)));
  const cursor = decodeFeedCursor(input.before);
  const filter = bucketFilter({});
  const rows: Array<{ bucket: 0 | 1; event_id: number; sort_at: string; item_json: string }> = [];
  if (!cursor || cursor.bucket === 0) {
    const upcoming = await readBucket(db, 0, filter, limit, cursor ?? undefined);
    rows.push(...upcoming.map((row) => ({ ...row, bucket: 0 as const })));
  }
  if (rows.length < limit) {
    const past = await readBucket(db, 1, filter, limit - rows.length, cursor?.bucket === 1 ? cursor : undefined);
    rows.push(...past.map((row) => ({ ...row, bucket: 1 as const })));
  }
  const items = rows.flatMap((row) => {
    const item = parseItem(row.item_json);
    return item ? [item] : [];
  });
  const last = rows.at(-1);
  return {
    items,
    next_cursor: rows.length === limit && last ? encodeFeedCursor(last.bucket, last.sort_at, last.event_id) : null
  };
}

export async function getPublicItem(db: D1Database, eventId: number): Promise<PublicFeedItem | null> {
  const row = await db.prepare("SELECT item_json FROM public_events WHERE event_id = ?").bind(eventId).first<{ item_json: string }>();
  return row ? parseItem(row.item_json) : null;
}

export async function listPublicItems(
  db: D1Database,
  input: { limit?: number; operatorSlug?: string; placeSlug?: string; canton?: string; excludeId?: number } = {}
): Promise<PublicFeedItem[]> {
  const limit = Math.max(1, Math.min(2000, Math.floor(input.limit ?? 50)));
  const filter = bucketFilter(input);
  const upcoming = await readBucket(db, 0, filter, limit);
  const past = await readBucket(db, 1, filter, limit - upcoming.length);
  return [...upcoming, ...past].flatMap((row) => {
    const item = parseItem(row.item_json);
    return item ? [item] : [];
  });
}

/**
 * Column-only variant for whole-set pages (sitemap, aggregates): avoids
 * parsing hundreds of item_json blobs within the 10 ms CPU budget.
 * Only the fields listed in LiteRow are populated.
 */
export async function listPublicItemsLite(db: D1Database, limit = 10000): Promise<PublicFeedItem[]> {
  const capped = Math.max(1, Math.min(20000, Math.floor(limit)));
  const result = await db.prepare(
    `SELECT event_id, status, nature, trust, location, canton, operator_slug, publisher,
            received_at, started_at, resolved_at, expected_restore_at, duration_minutes,
            sort_bucket, sort_at, latitude, longitude, places_key, source_updated_at
     FROM public_events
     ORDER BY sort_at DESC, event_id DESC
     LIMIT ?`
  ).bind(capped).all<LiteRow>();
  return result.results.map(liteRowToItem);
}

export interface LiteRow {
  event_id: number;
  status: PublicFeedItem["status"];
  nature: PublicFeedItem["nature"];
  trust: PublicFeedItem["trust"];
  location: string;
  canton: string | null;
  operator_slug: string | null;
  publisher: string | null;
  received_at: string;
  started_at: string | null;
  resolved_at: string | null;
  expected_restore_at: string | null;
  duration_minutes: number | null;
  sort_bucket: number;
  sort_at: string;
  latitude: number | null;
  longitude: number | null;
  places_key: string;
  source_updated_at: string;
}

export function liteRowToItem(row: LiteRow): PublicFeedItem {
  return {
    id: row.event_id,
    location: row.location,
    canton: row.canton,
    url: publicEventPath({ id: row.event_id, location: row.location }),
    received_at: row.received_at,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    status: row.status,
    nature: row.nature,
    duration_minutes: row.duration_minutes,
    expected_restore_at: row.expected_restore_at,
    cause: null,
    affected_area: null,
    updated_at: row.source_updated_at,
    summary: "",
    trust: row.trust,
    source: { publisher: row.publisher ?? "", url: "", domain: "" },
    latitude: row.latitude,
    longitude: row.longitude,
    operator_slug: row.operator_slug,
    operator_name: row.publisher,
    places: row.places_key
      ? row.places_key.split("|").map((entry) => ({ slug: entry.split(":")[0] ?? "", name: "" })).filter((place) => place.slug)
      : []
  };
}

export interface PublicSlice {
  total: number;
  active: number;
  upcoming: number;
  resolved: number;
  planned: number;
  unplanned: number;
  last30Days: number;
  lastAt: string | null;
  firstAt: string | null;
  medianDurationMinutes: number | null;
  knownDurations: number;
}

/** Aggregates over the full public set of an operator, place or canton (not a capped sample). */
export async function summarizePublicSlice(
  db: D1Database,
  input: { operatorSlug?: string; placeSlug?: string; canton?: string }
): Promise<PublicSlice> {
  const where: string[] = [];
  const binds: unknown[] = [];
  let from = "public_events p";
  if (input.placeSlug) {
    from = "public_event_places pl INNER JOIN public_events p ON p.event_id = pl.event_id";
    where.push("pl.place_slug = ?");
    binds.push(input.placeSlug);
  }
  if (input.operatorSlug) {
    where.push("p.operator_slug = ?");
    binds.push(input.operatorSlug);
  }
  if (input.canton) {
    where.push("p.canton = ?");
    binds.push(input.canton);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [counts, durations] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(p.status = 'active') AS active,
              SUM(p.status = 'upcoming') AS upcoming,
              SUM(p.status = 'resolved') AS resolved,
              SUM(p.nature = 'planned') AS planned,
              SUM(p.nature = 'unplanned') AS unplanned,
              SUM(julianday(p.sort_at) >= julianday('now', '-30 days') AND p.sort_bucket = 1) AS last30,
              MAX(CASE WHEN p.sort_bucket = 1 THEN p.sort_at END) AS last_at,
              MIN(p.received_at) AS first_at
       FROM ${from} ${clause}`
    ).bind(...binds).first<Record<string, number | string | null>>(),
    db.prepare(
      `SELECT p.duration_minutes AS minutes FROM ${from}
       ${clause ? `${clause} AND` : "WHERE"} p.duration_minutes IS NOT NULL AND p.nature = 'unplanned'
       ORDER BY p.duration_minutes`
    ).bind(...binds).all<{ minutes: number }>()
  ]);
  const values = durations.results.map((row) => row.minutes);
  const middle = Math.floor(values.length / 2);
  const median = values.length === 0
    ? null
    : values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
  const num = (value: unknown) => Number(value ?? 0) || 0;
  return {
    total: num(counts?.total),
    active: num(counts?.active),
    upcoming: num(counts?.upcoming),
    resolved: num(counts?.resolved),
    planned: num(counts?.planned),
    unplanned: num(counts?.unplanned),
    last30Days: num(counts?.last30),
    lastAt: (counts?.last_at as string | null) ?? null,
    firstAt: (counts?.first_at as string | null) ?? null,
    medianDurationMinutes: median,
    knownDurations: values.length
  };
}

export interface PublicPlaceSummary {
  slug: string;
  name: string;
  canton: string | null;
  count: number;
  lastAt: string | null;
}

export async function listPublicPlaces(db: D1Database, input: { minEvents?: number; limit?: number; canton?: string } = {}): Promise<PublicPlaceSummary[]> {
  const minEvents = Math.max(1, Math.floor(input.minEvents ?? 1));
  const limit = Math.max(1, Math.min(3000, Math.floor(input.limit ?? 2000)));
  const result = await db.prepare(
    `SELECT pl.place_slug AS slug, MAX(pl.place_name) AS name, MAX(pl.canton) AS canton,
            COUNT(*) AS count, MAX(p.sort_at) AS last_at
     FROM public_event_places pl
     INNER JOIN public_events p ON p.event_id = pl.event_id
     ${input.canton ? "WHERE pl.canton = ?" : ""}
     GROUP BY pl.place_slug
     HAVING COUNT(*) >= ?
     ORDER BY count DESC, slug ASC
     LIMIT ?`
  ).bind(...(input.canton ? [input.canton] : []), minEvents, limit).all<{ slug: string; name: string; canton: string | null; count: number; last_at: string | null }>();
  return result.results.map((row) => ({ slug: row.slug, name: row.name, canton: row.canton, count: row.count, lastAt: row.last_at }));
}

export async function getPublicPlace(db: D1Database, slug: string): Promise<PublicPlaceSummary | null> {
  const row = await db.prepare(
    `SELECT pl.place_slug AS slug, MAX(pl.place_name) AS name, MAX(pl.canton) AS canton,
            COUNT(*) AS count, MAX(p.sort_at) AS last_at
     FROM public_event_places pl
     INNER JOIN public_events p ON p.event_id = pl.event_id
     WHERE pl.place_slug = ?
     GROUP BY pl.place_slug`
  ).bind(slug).first<{ slug: string; name: string; canton: string | null; count: number; last_at: string | null }>();
  return row ? { slug: row.slug, name: row.name, canton: row.canton, count: row.count, lastAt: row.last_at } : null;
}

// ------------------------------------------------------- cached aggregates

/** The stored JSON text as is, for embedding into HTML without a parse/serialize round trip. */
export async function readStatsCacheRaw(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT payload_json FROM public_stats_cache WHERE cache_key = ?")
    .bind(key).first<{ payload_json: string }>();
  return row?.payload_json ?? null;
}

export async function readStatsCache<T>(db: D1Database, key: string): Promise<{ payload: T; computedAt: string } | null> {
  const row = await db.prepare("SELECT payload_json, computed_at FROM public_stats_cache WHERE cache_key = ?")
    .bind(key).first<{ payload_json: string; computed_at: string }>();
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payload_json) as T, computedAt: row.computed_at };
  } catch {
    return null;
  }
}

/** One row per key; a handful of writes per cron run at most. */
export async function writeStatsCache(db: D1Database, key: string, payload: unknown, computedAt = new Date().toISOString()): Promise<void> {
  await db.prepare(
    `INSERT INTO public_stats_cache (cache_key, payload_json, computed_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, computed_at = excluded.computed_at`
  ).bind(key, JSON.stringify(payload), computedAt).run();
}
