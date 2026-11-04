/**
 * Rebuilds operator history (source_records + operator incidents) from a local
 * copy of the production database, with exactly the grouping and derivation
 * code the cron uses. Produces an SQL file to apply to production.
 *
 *   npx vite-node scripts/rebuild-operator-history.mts -- \
 *     --db <prod-copy.sqlite> --geo <geo-cache.json> --out <rebuild.sql> [--fetch-geo]
 *
 * The local database is modified in place (apply the SQL there to verify the
 * public outcome before touching production). See docs/data-pipeline.md.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deriveIncident, groupRecords, type StoredRecord } from "../src/incidents";
import { incidentWrites } from "../src/operator-ingest";
import { pointKey } from "../src/geo-cache";
import { reverseGeocodeSwissMunicipality } from "../src/geo";
import {
  extractBkwRecords,
  extractPrimeoRecords,
  extractRomandeRecords,
  extractSakRecords,
  isCurrentState,
  recordContentFingerprint,
  recordsFromObservations,
  type OperatorRecordInput
} from "../src/operator-records";
import type { SourceObservationInput, SourceRegistryEntry } from "../src/types";

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
const dbPath = args.get("db");
const geoPath = args.get("geo");
const outPath = args.get("out");
if (!dbPath || !geoPath || !outPath) {
  console.error("usage: --db <sqlite> --geo <geo.json> --out <sql> [--fetch-geo] [--now <iso>]");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const all = <T>(sql: string, ...params: Array<string | number | null>): T[] => db.prepare(sql).all(...params) as T[];

/** Records whose unplanned span exceeds this were almost certainly several episodes collapsed by the old hash. */
const MAX_PLAUSIBLE_UNPLANNED_MS = 48 * 60 * 60 * 1000;
/** Records seen this close to the dump are still listed: the cron continues them. */
const LISTED_GRACE_MS = 40 * 60 * 1000;
/** Without any recorded end, sightings further apart than this are separate episodes. */
const UNEVIDENCED_EPISODE_GAP_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 0. Schema: bring the copy to the target migrations.
// ---------------------------------------------------------------------------
const applied = new Set(all<{ name: string }>("SELECT name FROM d1_migrations").map((row) => row.name));
for (const file of ["0021_ail_service_notices.sql", "0022_operator_records.sql"]) {
  if (applied.has(file)) continue;
  db.exec(readFileSync(`migrations/${file}`, "utf8"));
  db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))").run(file);
  console.log(`applied ${file}`);
}

const dumpNow = args.get("now") ?? all<{ t: string }>("SELECT max(started_at) AS t FROM workflow_runs")[0].t;
const dumpMs = Date.parse(dumpNow);
console.log(`dump time ${dumpNow}`);

const sources = new Map(all<SourceRegistryEntry>("SELECT * FROM source_registry").map((row) => [row.id, row]));

interface ObservationRow {
  id: number;
  source_registry_id: number;
  source_key: string;
  source_type: string;
  operator_name: string;
  canonical_status: string;
  event_type: string;
  title: string;
  url: string;
  location_text: string | null;
  area_text: string | null;
  started_at: string | null;
  resolved_at: string | null;
  observed_at: string;
  published_at: string | null;
  evidence_excerpt: string;
  raw_payload_json: string | null;
  outage_event_id: number | null;
}
const observations = all<ObservationRow>(
  `SELECT * FROM source_observations
   WHERE canonical_status IN ('planned', 'unplanned', 'resolved') AND source_registry_id IS NOT NULL
   ORDER BY observed_at, id`
);
console.log(`${observations.length} operator observations`);

// ---------------------------------------------------------------------------
// 1. Re-extract records from the stored payloads (tolerating truncation).
// ---------------------------------------------------------------------------
function tryJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const TRAFO = /\{"trafoNumber":(\d+),"trafoName":"((?:[^"\\]|\\.)*)","supplyState":"(\w+)","affectedCustomers":(\d+)(?:,"disconnectionStartTime":"([^"]+)","disconnectionEndTime":"([^"]+)")?,"latitude":([\d.]+),"longitude":([\d.]+)\}/g;

function bkwRows(observation: ObservationRow): unknown[] {
  const parsed = tryJson(observation.raw_payload_json) as Record<string, unknown> | null;
  if (parsed && Array.isArray(parsed.transformers)) return parsed.transformers;
  if (parsed && typeof parsed.city === "string") return [parsed];
  const rows: unknown[] = [];
  for (const match of (observation.raw_payload_json ?? "").matchAll(TRAFO)) {
    rows.push({
      trafoNumber: Number(match[1]), trafoName: JSON.parse(`"${match[2]}"`), supplyState: match[3],
      affectedCustomers: Number(match[4]), disconnectionStartTime: match[5], disconnectionEndTime: match[6],
      latitude: Number(match[7]), longitude: Number(match[8])
    });
  }
  return rows;
}

function romandeRow(observation: ObservationRow): unknown | null {
  const parsed = tryJson(observation.raw_payload_json);
  if (parsed) return parsed;
  const raw = observation.raw_payload_json ?? "";
  const field = (name: string) => raw.match(new RegExp(`"${name}":"([^"]*)"`))?.[1] ?? null;
  const uuid = field("uuid_perturbation");
  if (!uuid) return null;
  const point = raw.match(/"type":"Point","coordinates":\[([\d.]+),([\d.]+)\]/);
  return {
    uuid_perturbation: uuid,
    genre: field("genre"),
    date_debut: field("date_debut"),
    date_fin: field("date_fin"),
    active: /"active":true/.test(raw),
    geojson: point
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [Number(point[1]), Number(point[2])] } }] }
      : null
  };
}

function observationInput(observation: ObservationRow): SourceObservationInput {
  return {
    sourceRegistryId: observation.source_registry_id,
    sourceKey: observation.source_key,
    sourceType: observation.source_type as SourceObservationInput["sourceType"],
    operatorName: observation.operator_name,
    observationHash: "",
    canonicalStatus: observation.canonical_status as SourceObservationInput["canonicalStatus"],
    eventType: observation.event_type as SourceObservationInput["eventType"],
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
    extractorVersion: "",
    confidence: 0.9,
    independenceKey: null
  };
}

function recordsOf(observation: ObservationRow): OperatorRecordInput[] {
  const at = observation.observed_at;
  switch (observation.source_key) {
    case "bkw-outage":
      return extractBkwRecords(bkwRows(observation), at).records;
    case "sak-netzstatus": {
      const row = tryJson(observation.raw_payload_json);
      return row ? extractSakRecords([row], at).records : [];
    }
    case "primeo-netzstatus": {
      const row = tryJson(observation.raw_payload_json) as Record<string, unknown> | null;
      if (!row) return [];
      const resolved = row.status === "RESOLVED";
      return extractPrimeoRecords({ current: resolved ? [] : [row], done: resolved ? [row] : [] }, at).records;
    }
    case "romande-energie-pannes": {
      const row = romandeRow(observation);
      return row ? extractRomandeRecords([row], at).records : [];
    }
    default:
      return recordsFromObservations([observationInput(observation)]);
  }
}

const presence = new Map<string, { last: number; missing: number }>();
for (const row of all<{ outage_event_id: number; source_registry_id: number; last_confirmed_at: string; first_missing_at: string | null }>(
  "SELECT outage_event_id, source_registry_id, last_confirmed_at, first_missing_at FROM outage_event_source_presence"
)) {
  presence.set(`${row.outage_event_id}|${row.source_registry_id}`, {
    last: Date.parse(row.last_confirmed_at),
    missing: row.first_missing_at ? Date.parse(row.first_missing_at) : NaN
  });
}
interface OldEvent {
  id: number;
  status: string;
  public_status: string | null;
  last_confirmed_active_at: string | null;
  resolution_latest_at: string | null;
  location_text: string | null;
  origin: string;
}
const oldEvents = new Map(all<OldEvent>(
  "SELECT id, status, public_status, last_confirmed_active_at, resolution_latest_at, location_text, origin FROM outage_events"
).map((row) => [row.id, row]));

interface Draft {
  sourceId: number;
  input: OperatorRecordInput;
  kind: "planned" | "unplanned";
  recordKey: string;
  sightings: number[];
  currentSightings: number[];
  eventIds: Set<number>;
  observationIds: number[];
  flags: Set<string>;
}

const drafts: Draft[] = [];
const openByKey = new Map<string, Draft>();
let unparsed = 0;
for (const observation of observations) {
  const inputs = recordsOf(observation);
  if (inputs.length === 0) unparsed += 1;
  const at = Date.parse(observation.observed_at);
  for (const input of inputs) {
    const key = `${observation.source_registry_id}|${input.baseKey}`;
    let draft = openByKey.get(key);
    if (draft && !input.stableIdentity) {
      // An unstable identity continues only within the same old event or a short gap.
      // Old observations exist only where the listing changed, so a gap between
      // them is no evidence of an end. A new episode starts only after an end
      // the old cron did record (presence first_missing / resolution window).
      const sameEvent = observation.outage_event_id !== null && draft.eventIds.has(observation.outage_event_id);
      const lastSeen = Math.max(...draft.sightings);
      const endEvidence = Math.min(...[...draft.eventIds].map((eventId) => {
        const seen = presence.get(`${eventId}|${observation.source_registry_id}`);
        const missing = Number.isFinite(seen?.missing ?? NaN) ? (seen?.missing as number) : Date.parse(oldEvents.get(eventId)?.resolution_latest_at ?? "");
        return Number.isFinite(missing) && missing >= lastSeen ? missing : Number.POSITIVE_INFINITY;
      }));
      const continues = sameEvent || (Number.isFinite(endEvidence) ? at < endEvidence : at - lastSeen <= UNEVIDENCED_EPISODE_GAP_MS);
      if (!continues) draft = undefined;
    }
    if (!draft) {
      draft = {
        sourceId: observation.source_registry_id,
        input,
        kind: input.kind,
        recordKey: input.stableIdentity ? input.baseKey : `${input.baseKey}#${observation.observed_at}`,
        sightings: [],
        currentSightings: [],
        eventIds: new Set(),
        observationIds: [],
        flags: new Set(["backfill"])
      };
      drafts.push(draft);
      openByKey.set(key, draft);
    } else {
      // Later observations carry the newer operator state; the nature stays.
      draft.input = { ...input, kind: isCurrentState(input.operatorState) ? input.kind : draft.kind };
      if (isCurrentState(input.operatorState)) draft.kind = input.kind;
    }
    draft.sightings.push(at);
    if (isCurrentState(input.operatorState)) draft.currentSightings.push(at);
    if (observation.outage_event_id !== null) draft.eventIds.add(observation.outage_event_id);
    draft.observationIds.push(observation.id);
  }
}
console.log(`${drafts.length} records from ${observations.length - unparsed} parsable observations (${unparsed} without items, e.g. non-electric notices)`);

// ---------------------------------------------------------------------------
// 2. Sightings → windows, using the event-level presence the old cron kept.
// ---------------------------------------------------------------------------
const publicIds = new Set(all<{ event_id: number }>("SELECT event_id FROM public_events").map((row) => row.event_id));

const iso = (value: number) => new Date(value).toISOString();
let suspicious = 0;
const stored: Array<StoredRecord & { draft: Draft }> = [];
drafts.forEach((draft, index) => {
  const source = sources.get(draft.sourceId);
  if (!source) return;
  const intervalMs = Math.max(5, source.check_interval_minutes || 15) * 60_000;
  const firstSeen = Math.min(...draft.sightings);
  let lastSeen = draft.currentSightings.length ? Math.max(...draft.currentSightings) : firstSeen;
  let firstMissing = NaN;
  if (draft.currentSightings.length) {
    for (const eventId of draft.eventIds) {
      const seen = presence.get(`${eventId}|${draft.sourceId}`);
      const event = oldEvents.get(eventId);
      const last = Math.max(seen?.last ?? NaN, Date.parse(event?.last_confirmed_active_at ?? ""));
      if (Number.isFinite(last) && last > lastSeen) lastSeen = last;
      const missing = Number.isFinite(seen?.missing ?? NaN) ? (seen?.missing as number) : Date.parse(event?.resolution_latest_at ?? "");
      if (Number.isFinite(missing) && (!Number.isFinite(firstMissing) || missing > firstMissing)) firstMissing = missing;
    }
  }
  if (Number.isFinite(firstMissing) && firstMissing < lastSeen) firstMissing = NaN;
  const input = draft.input;
  const unstable = !input.stableIdentity;
  if (draft.kind === "unplanned" && unstable && lastSeen - firstSeen > MAX_PLAUSIBLE_UNPLANNED_MS) {
    // The old hash folded later recurrences onto this record: only the first sighting is trustworthy.
    suspicious += 1;
    draft.flags.add("merged_episodes_suspected");
    lastSeen = Math.max(...draft.currentSightings);
    firstMissing = NaN;
  }
  const current = isCurrentState(input.operatorState);
  const listed = current && !Number.isFinite(firstMissing) && dumpMs - lastSeen <= LISTED_GRACE_MS && !draft.flags.has("merged_episodes_suspected");
  stored.push({
    id: index + 1,
    source_registry_id: draft.sourceId,
    base_key: input.baseKey,
    record_key: draft.recordKey,
    kind: draft.kind,
    state: listed ? "listed" : "ended",
    operator_state: input.operatorState,
    title: input.title,
    place_text: input.placeText,
    detail_text: input.detailText,
    municipality: null,
    canton: null,
    latitude: input.latitude,
    longitude: input.longitude,
    reported_start_at: input.reportedStartAt,
    reported_end_at: input.reportedEndAt,
    end_is_actual: input.endIsActual ? 1 : 0,
    cause: input.cause,
    customers_affected: input.customersAffected,
    prev_absent_at: iso(firstSeen - intervalMs),
    first_seen_at: iso(firstSeen),
    last_seen_at: iso(lastSeen),
    seen_current: draft.currentSightings.length ? 1 : 0,
    first_missing_at: listed ? null : Number.isFinite(firstMissing) ? iso(firstMissing) : null,
    outage_event_id: null,
    quality_flags: JSON.stringify([...draft.flags].sort()),
    draft
  });
});
console.log(`${suspicious} records with collapsed recurrences (end set to unknown)`);

// ---------------------------------------------------------------------------
// 3. Municipalities: local geocode cache (filled from geo.admin when asked).
// ---------------------------------------------------------------------------
const geo: Record<string, { municipality: string; canton: string | null } | null> = existsSync(geoPath) ? JSON.parse(readFileSync(geoPath, "utf8")) : {};
const missingPoints = [...new Set(stored
  .filter((record) => record.latitude !== null && record.longitude !== null)
  .map((record) => pointKey(record.latitude as number, record.longitude as number))
  .filter((key) => !(key in geo)))];
console.log(`${missingPoints.length} coordinates not yet geocoded`);
if (missingPoints.length && args.get("fetch-geo") === "true") {
  for (const [index, key] of missingPoints.entries()) {
    const [lat, lon] = key.split(",").map(Number);
    let fix = null;
    for (let attempt = 0; attempt < 3 && !fix; attempt += 1) {
      fix = await reverseGeocodeSwissMunicipality(lat, lon);
      if (!fix) await new Promise((resolve) => setTimeout(resolve, 400));
    }
    geo[key] = fix ? { municipality: fix.municipality, canton: fix.canton } : null;
    if (index % 50 === 0) {
      writeFileSync(geoPath, JSON.stringify(geo));
      console.log(`  geocoded ${index + 1}/${missingPoints.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  writeFileSync(geoPath, JSON.stringify(geo));
}
for (const record of stored) {
  if (record.latitude === null || record.longitude === null) continue;
  const fix = geo[pointKey(record.latitude, record.longitude)];
  if (fix) {
    record.municipality = fix.municipality;
    record.canton = fix.canton;
  }
}

// ---------------------------------------------------------------------------
// 4. Group into incidents and map them onto existing event ids.
// ---------------------------------------------------------------------------
interface Incident {
  sourceId: number;
  records: Array<StoredRecord & { draft: Draft }>;
  eventId: number;
  reused: boolean;
}
const bySource = new Map<number, Array<StoredRecord & { draft: Draft }>>();
for (const record of stored) bySource.set(record.source_registry_id, [...(bySource.get(record.source_registry_id) ?? []), record]);

const claimed = new Set<number>();
let nextId = Math.max(...oldEvents.keys()) + 1;
const incidents: Incident[] = [];
const mergedInto = new Map<number, number>();
for (const [sourceId, records] of bySource) {
  for (const group of groupRecords(records) as Array<Array<StoredRecord & { draft: Draft }>>) {
    const candidates = [...new Set(group.flatMap((record) => [...record.draft.eventIds]))]
      .filter((id) => oldEvents.has(id) && !claimed.has(id))
      .sort((left, right) => Number(publicIds.has(right)) - Number(publicIds.has(left)) || left - right);
    const reused = candidates[0];
    const eventId = reused ?? nextId++;
    claimed.add(eventId);
    for (const other of candidates.slice(1)) {
      if (!mergedInto.has(other)) mergedInto.set(other, eventId);
    }
    for (const record of group) record.outage_event_id = eventId;
    incidents.push({ sourceId, records: group, eventId, reused: reused !== undefined });
  }
}
// An id claimed later by its own incident is not a merge.
for (const id of claimed) mergedInto.delete(id);

const operatorEventIds = new Set(observations.map((row) => row.outage_event_id).filter((id): id is number => id !== null));
const orphaned = [...operatorEventIds].filter((id) => !claimed.has(id) && !mergedInto.has(id));
console.log(`${incidents.length} incidents (${incidents.filter((incident) => incident.reused).length} keep their id), ${mergedInto.size} old events merged, ${orphaned.length} old events without operator records`);

// ---------------------------------------------------------------------------
// 5. Emit SQL (and apply it to the local copy).
// ---------------------------------------------------------------------------
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}
function render(sql: string, params: unknown[]): string {
  let index = 0;
  return sql.replace(/\?/g, () => literal(params[index++])).replace(/\s+/g, " ").trim() + ";";
}
const recorder = {
  prepare(sql: string) {
    return { bind: (...params: unknown[]) => ({ sql, params }) };
  }
} as unknown as D1Database;

const out: string[] = [
  "-- Operator history rebuild, generated by scripts/rebuild-operator-history.mts",
  `-- dump time ${dumpNow}; ${incidents.length} incidents from ${stored.length} records`
];
const now = new Date().toISOString();

for (const [key, fix] of Object.entries(geo)) {
  out.push(render(
    "INSERT INTO geo_point_cache (point_key, municipality, canton, status, resolved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(point_key) DO NOTHING",
    [key, fix?.municipality ?? null, fix?.canton ?? null, fix ? "ok" : "error", now]
  ));
}

// New incidents first: records reference them.
const derivedByEvent = new Map<number, ReturnType<typeof deriveIncident>>();
for (const incident of incidents) {
  const source = sources.get(incident.sourceId) as SourceRegistryEntry;
  const derived = deriveIncident(incident.records, { id: source.id, operator_name: source.operator_name, url: source.url });
  derivedByEvent.set(incident.eventId, derived);
  if (incident.reused) continue;
  out.push(render(
    `INSERT INTO outage_events (id, title, status, event_type, first_seen_at, last_seen_at, origin, created_at, updated_at)
     VALUES (?, ?, 'needs_review', 'unclear', ?, ?, 'operator', ?, CURRENT_TIMESTAMP)`,
    [incident.eventId, derived.title, derived.firstSeenAt, derived.lastSeenAt, derived.firstSeenAt.replace("T", " ").slice(0, 19)]
  ));
}

out.push("DELETE FROM source_records;");
for (const record of stored) {
  out.push(render(
    `INSERT INTO source_records (id, source_registry_id, base_key, record_key, kind, state, operator_state, title, place_text,
       detail_text, municipality, canton, latitude, longitude, reported_start_at, reported_end_at, end_is_actual, cause,
       customers_affected, prev_absent_at, first_seen_at, last_seen_at, seen_current, first_missing_at, content_hash,
       raw_json, outage_event_id, quality_flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.source_registry_id, record.base_key, record.record_key, record.kind, record.state, record.operator_state,
      record.title, record.place_text, record.detail_text, record.municipality, record.canton, record.latitude, record.longitude,
      record.reported_start_at, record.reported_end_at, record.end_is_actual, record.cause, record.customers_affected,
      record.prev_absent_at, record.first_seen_at, record.last_seen_at, record.seen_current, record.first_missing_at,
      recordContentFingerprint(record.draft.input), JSON.stringify(record.draft.input.raw ?? null).slice(0, 4000),
      record.outage_event_id, record.quality_flags
    ]
  ));
}

let published = 0;
for (const incident of incidents) {
  const source = sources.get(incident.sourceId) as SourceRegistryEntry;
  const derived = derivedByEvent.get(incident.eventId) as ReturnType<typeof deriveIncident>;
  if (derived.publishable) published += 1;
  if (incident.reused) {
    // Old extracted facts would override the operator's own times on the public item.
    out.push(render("DELETE FROM outage_facts WHERE outage_event_id = ?", [incident.eventId]));
    const old = oldEvents.get(incident.eventId);
    if (old && (old.location_text ?? "") !== (derived.locationText ?? "")) {
      out.push(render("DELETE FROM event_public_locations WHERE outage_event_id = ? AND provider != 'operator'", [incident.eventId]));
    }
  }
  out.push(render(
    "UPDATE outage_events SET merged_into_event_id = NULL, admin_note = NULL, research_summary_de = NULL, fact_sheet_json = NULL WHERE id = ?",
    [incident.eventId]
  ));
  for (const statement of incidentWrites(recorder, incident.eventId, derived, source, now) as unknown as Array<{ sql: string; params: unknown[] }>) {
    out.push(render(statement.sql, statement.params));
  }
}

const hide = (id: number, note: string, target: number | null) => {
  out.push(render(
    `UPDATE outage_events SET status = 'dismissed', public_status = 'hidden', event_quality_state = 'candidate_only',
       merged_into_event_id = ?, admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [target, note, id]
  ));
  out.push(render(
    `UPDATE publication_decisions SET publishable = 0, reasons_json = ?, decided_at = ? WHERE outage_event_id = ?`,
    [JSON.stringify([target ? "merged_into_event" : "no_operator_record"]), now, id]
  ));
};
for (const [id, target] of mergedInto) hide(id, `operator history rebuild: same incident as #${target}`, target);
for (const id of orphaned) hide(id, "operator history rebuild: no power-outage record (e.g. district heating or unparsable)", null);

writeFileSync(outPath, out.join("\n") + "\n");
console.log(`wrote ${out.length} statements to ${outPath}; ${published} of ${incidents.length} incidents publishable`);

db.exec("BEGIN");
try {
  db.exec(out.join("\n"));
  db.exec("COMMIT");
  console.log("applied to local copy");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
