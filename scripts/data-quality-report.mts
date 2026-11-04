/**
 * Data quality report over a local copy of the database. Optionally refreshes
 * the public projection first (with the production code), so the numbers are
 * exactly what the public pages would show.
 *
 *   npx vite-node scripts/data-quality-report.mts -- --db <sqlite> [--project] [--now <iso>] [--json <out.json>]
 */
import { writeFileSync } from "node:fs";
import { refreshPublicProjection } from "../src/public-projection";
import { SqliteD1 } from "../test/helpers/sqlite-d1";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(arg.slice(2), next);
    index += 1;
  } else args.set(arg.slice(2), "true");
}
const path = args.get("db");
if (!path) {
  console.error("usage: --db <sqlite> [--project] [--now <iso>] [--json <file>]");
  process.exit(1);
}
const d1 = new SqliteD1(path);
const db = d1.sqlite;
const one = <T>(sql: string): T => db.prepare(sql).get() as T;
const many = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

if (args.get("project") === "true") {
  const now = args.has("now") ? Date.parse(args.get("now") as string) : Date.now();
  let before: number | undefined = Number.MAX_SAFE_INTEGER;
  let pages = 0;
  while (before !== undefined && pages < 100) {
    const result = await refreshPublicProjection({ DB: d1.asD1() }, { limit: 400, now, fullBeforeId: before });
    pages += 1;
    before = result.nextBeforeId ?? undefined;
  }
  await refreshPublicProjection({ DB: d1.asD1() }, { limit: 1000, now, sweepOrphans: true });
  console.log(`projection refreshed in ${pages} page(s)`);
}

const report = {
  public_events: one<{ n: number }>("SELECT count(*) AS n FROM public_events").n,
  by_publisher: many<{ publisher: string; n: number }>(
    "SELECT publisher, count(*) AS n FROM public_events GROUP BY 1 ORDER BY n DESC LIMIT 12"
  ),
  completeness: one<Record<string, number>>(`
    SELECT count(*) AS total,
      round(100.0 * sum(started_at IS NOT NULL OR json_extract(item_json, '$.active_since_at') IS NOT NULL) / count(*), 1) AS pct_with_start,
      round(100.0 * sum(started_at IS NOT NULL) / count(*), 1) AS pct_exact_start,
      round(100.0 * sum(status IN ('resolved', 'historical') AND resolved_at IS NULL AND end_earliest_at IS NULL) / max(1, sum(status IN ('resolved', 'historical'))), 1) AS pct_closed_without_end,
      round(100.0 * sum(duration_minutes IS NOT NULL) / max(1, sum(status IN ('resolved', 'historical'))), 1) AS pct_closed_with_duration,
      round(100.0 * sum(canton IS NOT NULL AND canton != '') / count(*), 1) AS pct_with_canton,
      round(100.0 * sum(latitude IS NOT NULL) / count(*), 1) AS pct_with_pin,
      sum(location LIKE '%unbekannt%' OR location LIKE 'Behobener%' OR location LIKE 'in %') AS bad_location_text
    FROM public_events`),
  // Same operator, same place, same nature, starts within 6 h: very likely one outage shown twice.
  duplicate_pairs: one<{ n: number }>(`
    SELECT count(*) AS n FROM public_events a JOIN public_events b
      ON a.publisher = b.publisher AND a.location = b.location AND a.nature = b.nature AND a.event_id < b.event_id
     AND abs(julianday(coalesce(a.started_at, json_extract(a.item_json, '$.active_since_at'), a.received_at))
           - julianday(coalesce(b.started_at, json_extract(b.item_json, '$.active_since_at'), b.received_at))) < 0.25`).n,
  // An event received long after the outage it describes was first seen (the old alert-item hash bug).
  stale_first_seen: one<{ n: number }>(`
    SELECT count(*) AS n FROM outage_events e JOIN public_events p ON p.event_id = e.id
     WHERE julianday(e.created_at) - julianday(e.first_seen_at) > 1`).n,
  implausible_unplanned_duration: one<{ n: number }>(
    "SELECT count(*) AS n FROM public_events WHERE nature = 'unplanned' AND duration_minutes > 2880"
  ).n,
  non_electric: one<{ n: number }>(`
    SELECT count(*) AS n FROM public_events
     WHERE item_json LIKE '%rmeversorgung%' OR item_json LIKE '%Fernw%rme%' OR item_json LIKE '%rmenetz%'`).n,
  status: many<{ status: string; nature: string; n: number }>(
    "SELECT status, nature, count(*) AS n FROM public_events GROUP BY 1, 2 ORDER BY n DESC"
  ),
  unplanned_duration_minutes: (() => {
    const values = many<{ d: number }>(
      "SELECT duration_minutes AS d FROM public_events WHERE nature = 'unplanned' AND duration_minutes IS NOT NULL ORDER BY 1"
    ).map((row) => row.d);
    const q = (p: number) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : null;
    return { n: values.length, p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95) };
  })(),
  source_records: (() => {
    try {
      return many<Record<string, unknown>>(`
        SELECT r.source_registry_id AS source, s.source_key, count(*) AS records, count(DISTINCT outage_event_id) AS incidents,
               sum(state = 'listed') AS listed, sum(municipality IS NULL AND latitude IS NOT NULL) AS ungeocoded
          FROM source_records r JOIN source_registry s ON s.id = r.source_registry_id GROUP BY 1 ORDER BY records DESC`);
    } catch {
      return [];
    }
  })()
};

console.log(JSON.stringify(report, null, 2));
if (args.get("json")) writeFileSync(args.get("json") as string, JSON.stringify(report, null, 2));
