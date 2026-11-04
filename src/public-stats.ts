/**
 * Precomputed public aggregates, stored in public_stats_cache by the cron.
 *
 * - INDEX_CACHE_KEY: compact list of all recent public events for the radar's
 *   instant search, filters and map (one row read per edge-cache miss instead of
 *   hundreds).
 * - STATS_CACHE_KEY: national statistics for /statistik.
 * - OPERATOR_STATS_CACHE_KEY: per-operator figures for operator and event pages.
 *
 * Everything is derived from public_events only, so statistics can never
 * disagree with what the feed and the detail pages show.
 */
import { publicOperatorProfiles, summarizeOperatorEvents, type OperatorLiveStats } from "./operators";
import { dbTimeMs, liteRowToItem, readStatsCache, writeStatsCache, type LiteRow } from "./public-projection";
import { SWISS_CANTONS } from "./swiss-cantons";
import type { Env, PublicFeedItem } from "./types";

export const INDEX_CACHE_KEY = "index:v1";
export const STATS_CACHE_KEY = "stats:v1";
export const OPERATOR_STATS_CACHE_KEY = "operators:v1";
export const PLACES_CACHE_KEY = "places:v1";

export interface PlacesPayload {
  v: 1;
  generatedAt: string;
  /** slug, name, canton, total events, active+upcoming events, latest sort time */
  places: Array<[slug: string, name: string, canton: string | null, count: number, current: number, lastAt: string | null]>;
}
export const STATS_MAX_AGE_MS = 60 * 60 * 1000;
const INDEX_WINDOW_DAYS = 365;

interface AggregateRow extends LiteRow {
  end_earliest_at: string | null;
  end_latest_at: string | null;
  active_since_at: string | null;
  time_confidence: string | null;
}

// ------------------------------------------------------------------ index

/** Positional tuple to keep the index small: see INDEX_FIELDS. */
export type IndexEntry = [
  id: number,
  slugId: string,
  location: string,
  status: string,
  nature: string,
  canton: string | null,
  operatorSlug: string | null,
  publisher: string,
  startMin: number | null,
  endMin: number | null,
  plannedEndMin: number | null,
  sortMin: number,
  lat: number | null,
  lon: number | null,
  places: string
];

export const INDEX_FIELDS = [
  "id", "slugId", "location", "status", "nature", "canton", "operatorSlug", "publisher",
  "startMin", "endMin", "plannedEndMin", "sortMin", "lat", "lon", "places"
] as const;

export interface PublicIndexPayload {
  v: 1;
  generatedAt: string;
  fields: typeof INDEX_FIELDS;
  items: IndexEntry[];
}

function minutes(value: string | null | undefined): number | null {
  const ms = dbTimeMs(value);
  return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
}

function round4(value: number | null): number | null {
  return typeof value === "number" ? Math.round(value * 10000) / 10000 : null;
}

export function buildPublicIndex(rows: LiteRow[], now = Date.now()): PublicIndexPayload {
  const cutoff = now - INDEX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const items = rows
    .filter((row) => row.sort_bucket === 0 || dbTimeMs(row.sort_at) >= cutoff)
    .map((row): IndexEntry => {
      const item = liteRowToItem(row);
      return [
        row.event_id,
        item.url.replace(/^\/stromausfall\//, ""),
        row.location,
        row.status ?? "historical",
        row.nature,
        row.canton,
        row.operator_slug,
        row.publisher ?? "",
        minutes(row.started_at),
        minutes(row.resolved_at),
        minutes(row.expected_restore_at),
        minutes(row.sort_at) ?? 0,
        round4(row.latitude),
        round4(row.longitude),
        row.places_key.split("|").map((entry) => entry.split(":")[0]).filter(Boolean).join(" ")
      ];
    });
  return { v: 1, generatedAt: new Date(now).toISOString(), fields: INDEX_FIELDS, items };
}

// ------------------------------------------------------------------ stats

export interface Bucket {
  key: string;
  count: number;
}

export interface DistributionStat {
  n: number;
  median: number | null;
  buckets: Bucket[];
}

export interface StatsPayload {
  v: 1;
  generatedAt: string;
  firstAt: string | null;
  totals: {
    all: number;
    active: number;
    upcoming: number;
    planned: number;
    unplanned: number;
    last30: number;
    last30Planned: number;
    last30Unplanned: number;
    previous30: number;
    operators: number;
    places: number;
    withCanton: number;
  };
  daily: Array<{ date: string; planned: number; unplanned: number }>;
  weekly: Array<{ week: string; planned: number; unplanned: number }>;
  /** 7 x 24 counts of unplanned starts (Monday first, Europe/Zurich local hours). */
  weekdayHour: number[][];
  weekdayHourN: number;
  leadTimeHours: DistributionStat;
  plannedDurationMinutes: DistributionStat;
  unplannedDurationMinutes: DistributionStat & { exact: number; estimated: number };
  byOperator: Array<{ slug: string; name: string; total: number; planned: number; unplanned: number; last30: number; weekly: number[] }>;
  byCanton: Array<{ code: string; total: number; planned: number; unplanned: number }>;
  topPlaces: Array<{ slug: string; name: string; canton: string | null; count: number }>;
  sources: { monitored: number; healthy: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const zurichParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  weekday: "short",
  hourCycle: "h23"
});
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function zurich(ms: number): { date: string; weekday: number; hour: number } {
  const parts = Object.fromEntries(zurichParts.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? "Mon")),
    hour: Number(parts.hour ?? 0) % 24
  };
}

function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

export function distribution(values: number[], edges: Array<[string, number]>): DistributionStat {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const buckets = edges.map(([key]) => ({ key, count: 0 }));
  for (const value of sorted) {
    const index = edges.findIndex(([, upper]) => value < upper);
    buckets[index === -1 ? buckets.length - 1 : index].count += 1;
  }
  return { n: sorted.length, median: median === null ? null : Math.round(median * 10) / 10, buckets };
}

export function computePublicStats(
  rows: AggregateRow[],
  context: { now?: number; sources?: { monitored: number; healthy: number }; placeNames?: Map<string, string> } = {}
): StatsPayload {
  const now = context.now ?? Date.now();
  const past = rows.filter((row) => row.sort_bucket === 1);
  const in30 = past.filter((row) => now - dbTimeMs(row.sort_at) <= 30 * DAY_MS && dbTimeMs(row.sort_at) <= now);
  const prev30 = past.filter((row) => {
    const age = now - dbTimeMs(row.sort_at);
    return age > 30 * DAY_MS && age <= 60 * DAY_MS;
  });

  // Daily (last 91 days) and weekly (last 26 weeks) series in Swiss local time.
  const dailyMap = new Map<string, { planned: number; unplanned: number }>();
  for (let offset = 90; offset >= 0; offset -= 1) dailyMap.set(zurich(now - offset * DAY_MS).date, { planned: 0, unplanned: 0 });
  const weeklyMap = new Map<string, { planned: number; unplanned: number }>();
  const currentMonday = mondayOf(zurich(now).date);
  for (let offset = 25; offset >= 0; offset -= 1) {
    weeklyMap.set(new Date(new Date(`${currentMonday}T00:00:00Z`).getTime() - offset * 7 * DAY_MS).toISOString().slice(0, 10), { planned: 0, unplanned: 0 });
  }
  const operatorWeekly = new Map<string, Map<string, number>>();
  for (const row of past) {
    const ms = dbTimeMs(row.sort_at);
    if (!Number.isFinite(ms) || ms > now) continue;
    const local = zurich(ms);
    const kind = row.nature === "planned" ? "planned" : "unplanned";
    const day = dailyMap.get(local.date);
    if (day) day[kind] += 1;
    const monday = mondayOf(local.date);
    const week = weeklyMap.get(monday);
    if (week) week[kind] += 1;
    if (row.operator_slug && week) {
      const perOperator = operatorWeekly.get(row.operator_slug) ?? new Map<string, number>();
      perOperator.set(monday, (perOperator.get(monday) ?? 0) + 1);
      operatorWeekly.set(row.operator_slug, perOperator);
    }
  }

  // When do unplanned outages start? Only reported start times count.
  const weekdayHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let weekdayHourN = 0;
  for (const row of rows) {
    if (row.nature === "planned" || !row.started_at) continue;
    const ms = dbTimeMs(row.started_at);
    if (!Number.isFinite(ms) || ms > now) continue;
    const local = zurich(ms);
    weekdayHour[local.weekday][local.hour] += 1;
    weekdayHourN += 1;
  }

  // How early are planned interruptions announced?
  const leadHours = rows
    .filter((row) => row.nature === "planned" && row.started_at)
    .map((row) => (dbTimeMs(row.started_at) - dbTimeMs(row.received_at)) / 3_600_000)
    .filter((hours) => Number.isFinite(hours) && hours > 0);
  const plannedMinutes = rows
    .filter((row) => row.nature === "planned" && row.started_at && row.expected_restore_at)
    .map((row) => (dbTimeMs(row.expected_restore_at) - dbTimeMs(row.started_at)) / 60000)
    .filter((value) => Number.isFinite(value) && value > 0 && value < 7 * 24 * 60);

  // Unplanned durations: exact where reported, otherwise the midpoint of the
  // polling window between "last confirmed" and "first missing".
  let exact = 0;
  let estimated = 0;
  const unplannedMinutes: number[] = [];
  for (const row of rows) {
    if (row.nature === "planned") continue;
    const start = dbTimeMs(row.started_at ?? row.active_since_at);
    if (!Number.isFinite(start)) continue;
    if (row.resolved_at) {
      const value = (dbTimeMs(row.resolved_at) - start) / 60000;
      if (Number.isFinite(value) && value > 0 && value < 3 * 24 * 60) {
        unplannedMinutes.push(value);
        exact += 1;
      }
      continue;
    }
    if (row.end_earliest_at && row.end_latest_at) {
      const mid = (dbTimeMs(row.end_earliest_at) + dbTimeMs(row.end_latest_at)) / 2;
      const value = (mid - start) / 60000;
      if (Number.isFinite(value) && value > 0 && value < 3 * 24 * 60) {
        unplannedMinutes.push(value);
        estimated += 1;
      }
    }
  }

  const operatorNames = new Map(publicOperatorProfiles().map((profile) => [profile.slug, profile.name]));
  const byOperatorMap = new Map<string, { total: number; planned: number; unplanned: number; last30: number }>();
  const byCantonMap = new Map<string, { total: number; planned: number; unplanned: number }>();
  for (const row of rows) {
    const kind = row.nature === "planned" ? "planned" : "unplanned";
    const recent = row.sort_bucket === 1 && now - dbTimeMs(row.sort_at) <= 30 * DAY_MS;
    if (row.operator_slug && operatorNames.has(row.operator_slug)) {
      const entry = byOperatorMap.get(row.operator_slug) ?? { total: 0, planned: 0, unplanned: 0, last30: 0 };
      entry.total += 1;
      entry[kind] += 1;
      if (recent) entry.last30 += 1;
      byOperatorMap.set(row.operator_slug, entry);
    }
    if (row.canton) {
      const entry = byCantonMap.get(row.canton) ?? { total: 0, planned: 0, unplanned: 0 };
      entry.total += 1;
      entry[kind] += 1;
      byCantonMap.set(row.canton, entry);
    }
  }
  const weeks = [...weeklyMap.keys()];
  const placeCounts = new Map<string, { name: string; canton: string | null; count: number }>();
  for (const row of rows) {
    for (const entry of row.places_key.split("|").filter(Boolean)) {
      const [slug, canton] = entry.split(":");
      if (!slug) continue;
      const current = placeCounts.get(slug) ?? { name: context.placeNames?.get(slug) ?? slug, canton: canton || null, count: 0 };
      current.count += 1;
      placeCounts.set(slug, current);
    }
  }

  const firstMs = Math.min(...past.map((row) => dbTimeMs(row.sort_at)).filter(Number.isFinite));
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    firstAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    totals: {
      all: rows.length,
      active: rows.filter((row) => row.status === "active").length,
      upcoming: rows.filter((row) => row.status === "upcoming").length,
      planned: rows.filter((row) => row.nature === "planned").length,
      unplanned: rows.filter((row) => row.nature !== "planned").length,
      last30: in30.length,
      last30Planned: in30.filter((row) => row.nature === "planned").length,
      last30Unplanned: in30.filter((row) => row.nature !== "planned").length,
      previous30: prev30.length,
      operators: byOperatorMap.size,
      places: placeCounts.size,
      withCanton: rows.filter((row) => row.canton).length
    },
    daily: [...dailyMap.entries()].map(([date, value]) => ({ date, ...value })),
    weekly: [...weeklyMap.entries()].map(([week, value]) => ({ week, ...value })),
    weekdayHour,
    weekdayHourN,
    leadTimeHours: distribution(leadHours, [["lt1d", 24], ["d1to3", 72], ["d3to7", 168], ["d7to14", 336], ["gt14d", Infinity]]),
    plannedDurationMinutes: distribution(plannedMinutes, [["lt60", 60], ["h1to2", 120], ["h2to4", 240], ["h4to8", 480], ["gt8h", Infinity]]),
    unplannedDurationMinutes: {
      ...distribution(unplannedMinutes, [["lt30", 30], ["m30to60", 60], ["h1to2", 120], ["h2to4", 240], ["gt4h", Infinity]]),
      exact,
      estimated
    },
    byOperator: [...byOperatorMap.entries()]
      .map(([slug, value]) => ({
        slug,
        name: operatorNames.get(slug) ?? slug,
        ...value,
        weekly: weeks.slice(-12).map((week) => operatorWeekly.get(slug)?.get(week) ?? 0)
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "de-CH")),
    byCanton: SWISS_CANTONS
      .map((canton) => ({ code: canton.code, ...(byCantonMap.get(canton.code) ?? { total: 0, planned: 0, unplanned: 0 }) }))
      .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
    topPlaces: [...placeCounts.entries()]
      .map(([slug, value]) => ({ slug, ...value }))
      .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
      .slice(0, 24),
    sources: context.sources ?? { monitored: 0, healthy: 0 }
  };
}

// ---------------------------------------------------------------- refresh

const AGGREGATE_SQL = `SELECT event_id, status, nature, trust, location, canton, operator_slug, publisher,
        received_at, started_at, resolved_at, end_earliest_at, end_latest_at, expected_restore_at,
        duration_minutes, sort_bucket, sort_at, latitude, longitude, places_key, source_updated_at,
        json_extract(item_json, '$.active_since_at') AS active_since_at,
        json_extract(item_json, '$.time_confidence') AS time_confidence
 FROM public_events
 ORDER BY sort_bucket ASC, CASE WHEN sort_bucket = 0 THEN sort_at END ASC, sort_at DESC, event_id DESC`;

export async function loadAggregateRows(db: D1Database): Promise<AggregateRow[]> {
  return (await db.prepare(AGGREGATE_SQL).all<AggregateRow>()).results;
}

/**
 * Refreshes the cached aggregates. The index follows every projection change;
 * statistics and operator figures are recomputed at most hourly (or when
 * forced) because their time windows move slowly.
 */
export async function refreshPublicAggregates(
  env: Pick<Env, "DB">,
  options: { projectionChanged: boolean; force?: boolean; now?: number }
): Promise<{ index: boolean; stats: boolean }> {
  const now = options.now ?? Date.now();
  const cachedStats = options.force ? null : await readStatsCache<StatsPayload>(env.DB, STATS_CACHE_KEY);
  const statsDue = options.force || !cachedStats || now - dbTimeMs(cachedStats.computedAt) >= STATS_MAX_AGE_MS;
  if (!options.projectionChanged && !statsDue) return { index: false, stats: false };

  const rows = await loadAggregateRows(env.DB);
  const generatedAt = new Date(now).toISOString();
  await writeStatsCache(env.DB, INDEX_CACHE_KEY, buildPublicIndex(rows, now), generatedAt);
  const places = await loadPlaces(env.DB, generatedAt);
  await writeStatsCache(env.DB, PLACES_CACHE_KEY, places, generatedAt);
  if (!statsDue) return { index: true, stats: false };

  const sources = await env.DB.prepare(
    `SELECT COUNT(*) AS monitored, SUM(health_status = 'healthy') AS healthy
     FROM source_registry WHERE enabled = 1`
  ).first<{ monitored: number; healthy: number }>().catch(() => null);
  await writeStatsCache(env.DB, STATS_CACHE_KEY, computePublicStats(rows, {
    now,
    placeNames: new Map(places.places.map(([slug, name]) => [slug, name])),
    sources: { monitored: Number(sources?.monitored ?? 0), healthy: Number(sources?.healthy ?? 0) }
  }), generatedAt);

  const byOperator = new Map<string, PublicFeedItem[]>();
  for (const row of rows) {
    if (!row.operator_slug) continue;
    byOperator.set(row.operator_slug, [...(byOperator.get(row.operator_slug) ?? []), liteRowToItem(row)]);
  }
  const operatorStats: Record<string, OperatorLiveStats> = {};
  for (const profile of publicOperatorProfiles()) {
    operatorStats[profile.slug] = summarizeOperatorEvents(byOperator.get(profile.slug) ?? [], now);
  }
  await writeStatsCache(env.DB, OPERATOR_STATS_CACHE_KEY, operatorStats, generatedAt);
  return { index: true, stats: true };
}

async function loadPlaces(db: D1Database, generatedAt: string): Promise<PlacesPayload> {
  const result = await db.prepare(
    `SELECT pl.place_slug AS slug, MAX(pl.place_name) AS name, MAX(pl.canton) AS canton,
            COUNT(*) AS count,
            SUM(p.status IN ('active', 'upcoming')) AS current,
            MAX(CASE WHEN p.sort_bucket = 1 THEN p.sort_at END) AS last_at
     FROM public_event_places pl
     INNER JOIN public_events p ON p.event_id = pl.event_id
     GROUP BY pl.place_slug
     ORDER BY count DESC, slug ASC`
  ).all<{ slug: string; name: string; canton: string | null; count: number; current: number; last_at: string | null }>();
  return {
    v: 1,
    generatedAt,
    places: result.results.map((row) => [row.slug, row.name, row.canton, row.count, Number(row.current ?? 0), row.last_at])
  };
}
