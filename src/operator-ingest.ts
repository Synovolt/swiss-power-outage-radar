/**
 * Operator pipeline v2 (see migrations/0022_operator_records.sql):
 *
 *   raw payload (R2, on change) → source_polls → source_records → incidents
 *   (outage_events origin='operator') → public projection
 *
 * One poll per source and cron run. Every write is batched and only real
 * changes are written: a still-listed record costs one shared UPDATE per poll.
 */
import { resolvePoints, pointKey, type GeoBudget, type GeoLookup } from "./geo-cache";
import {
  deriveIncident,
  groupRecords,
  INCIDENT_DERIVATION_VERSION,
  type DerivedIncident,
  type StoredRecord
} from "./incidents";
import {
  extractKnownApiRecords,
  isCurrentState,
  keyText,
  RECORD_EXTRACTOR_VERSION,
  recordContentFingerprint,
  recordsFromObservations,
  type OperatorRecordInput
} from "./operator-records";
import { fetchSourceObservations, type PayloadCapture } from "./source-adapters";
import type { Env, SourceRegistryEntry } from "./types";

/** A failing trafo that reappears within this gap is the same episode (flapping). */
export const REOPEN_GAP_MS = 45 * 60 * 1000;
/** Records this recent are candidates for joining a new record's incident. */
const GROUPING_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
/** last_confirmed_active_at / last_seen_at on the event are refreshed at most this often. */
const EVENT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const IN_CHUNK = 90;
const BATCH_CHUNK = 50;

export const PURE_API_SOURCES = new Set(["bkw-outage", "sak-netzstatus", "primeo-netzstatus", "romande-energie-pannes"]);

export interface OperatorPoll {
  polledAt: string;
  records: OperatorRecordInput[];
  /** True when the listing is complete, so a missing record has really disappeared. */
  complete: boolean;
  transportStatus: "ok" | "error";
  parserStatus: "ready" | "no_current_outage" | "needs_adapter" | "error";
  error: string | null;
  payloadText: string | null;
  usedFirecrawl: boolean;
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

function parseConfig(source: SourceRegistryEntry): Record<string, unknown> {
  try {
    return JSON.parse(source.adapter_config_json ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fetchPayload(url: string): Promise<{ text: string; error: string | null }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "outage.ch radar (+https://outage.ch/ueber/)",
      Accept: "application/json,text/html;q=0.9,*/*;q=0.1"
    }
  });
  const text = await response.text().catch(() => "");
  return { text, error: response.ok ? null : `HTTP ${response.status}` };
}

/** Fetches one source and turns its listing into records. Makes exactly one external request (plus Firecrawl where enabled). */
export async function pollOperatorSource(
  env: Pick<Env, "FIRECRAWL_API_KEY">,
  source: SourceRegistryEntry,
  polledAt: string
): Promise<OperatorPoll> {
  const base = { polledAt, records: [] as OperatorRecordInput[], usedFirecrawl: false };
  const apiUrl = typeof parseConfig(source).api_url === "string" ? String(parseConfig(source).api_url) : null;
  try {
    if (apiUrl && PURE_API_SOURCES.has(source.source_key)) {
      const fetched = await fetchPayload(apiUrl);
      if (fetched.error) {
        return { ...base, complete: false, transportStatus: "error", parserStatus: "error", error: fetched.error, payloadText: fetched.text || null };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(fetched.text);
      } catch {
        return { ...base, complete: false, transportStatus: "ok", parserStatus: "error", error: "parser_invalid_json: operator API did not return JSON", payloadText: fetched.text };
      }
      const extraction = extractKnownApiRecords(source.source_key, payload, polledAt);
      if (!extraction?.schemaMatched) {
        return { ...base, complete: false, transportStatus: "ok", parserStatus: "needs_adapter", error: "parser_schema_changed: operator API no longer matches the verified contract", payloadText: fetched.text };
      }
      return {
        ...base,
        records: extraction.records,
        complete: true,
        transportStatus: "ok",
        parserStatus: extraction.records.some((record) => isCurrentState(record.operatorState)) ? "ready" : "no_current_outage",
        error: null,
        payloadText: fetched.text
      };
    }

    const capture: PayloadCapture = {};
    const result = await fetchSourceObservations(env, source, polledAt, capture);
    const healthy = result.transportStatus === "ok" && (result.parserStatus === "ready" || result.parserStatus === "no_current_outage");
    return {
      ...base,
      records: healthy ? recordsFromObservations(result.observations) : [],
      // Only item-level adapters give a listing whose gaps mean something.
      complete: healthy && result.parserStatus === "ready" || (healthy && result.observations.every((observation) => observation.canonicalStatus === "irrelevant")),
      transportStatus: result.transportStatus,
      parserStatus: result.parserStatus,
      error: result.error,
      payloadText: capture.payloadText ?? null,
      usedFirecrawl: result.usedFirecrawl
    };
  } catch (error) {
    return { ...base, complete: false, transportStatus: "error", parserStatus: "error", error: error instanceof Error ? error.message : String(error), payloadText: null };
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface IngestOptions {
  geoBudget: GeoBudget;
  geoLookup?: GeoLookup;
  /** R2 bucket for the raw payload archive; omitted in tests and rebuilds. */
  archive?: R2Bucket | null;
}

export interface IngestResult {
  recordsSeen: number;
  recordsNew: number;
  recordsEnded: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsMerged: number;
  geocoded: number;
}

type RecordRow = StoredRecord & { content_hash: string; raw_json: string | null };

const RECORD_COLUMNS = `id, source_registry_id, base_key, record_key, kind, state, operator_state, title, place_text,
  detail_text, municipality, canton, latitude, longitude, reported_start_at, reported_end_at, end_is_actual, cause,
  customers_affected, prev_absent_at, first_seen_at, last_seen_at, seen_current, first_missing_at, outage_event_id,
  quality_flags, content_hash, raw_json`;

/**
 * Applies one poll to the records, the incidents and the source health.
 * Order matters: records first (so a crash never loses sightings), then
 * geocoding, then incident assignment and derivation.
 */
export async function ingestOperatorPoll(
  env: Pick<Env, "DB">,
  source: SourceRegistryEntry & { last_payload_hash?: string | null },
  poll: OperatorPoll,
  options: IngestOptions
): Promise<IngestResult> {
  const db = env.DB;
  const result: IngestResult = { recordsSeen: poll.records.length, recordsNew: 0, recordsEnded: 0, eventsCreated: 0, eventsUpdated: 0, eventsMerged: 0, geocoded: 0 };
  const ok = poll.transportStatus === "ok" && (poll.parserStatus === "ready" || poll.parserStatus === "no_current_outage");

  // Raw archive: keep every distinct payload so any parser can be replayed later.
  let payloadHash: string | null = null;
  let rawKey: string | null = null;
  if (poll.payloadText) {
    payloadHash = await sha256Hex(poll.payloadText);
    if (options.archive && payloadHash !== source.last_payload_hash) {
      rawKey = `raw/${source.source_key}/${poll.polledAt.slice(0, 10)}/${poll.polledAt.replace(/[:.]/g, "-")}.txt`;
      try {
        await options.archive.put(rawKey, poll.payloadText, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: { source_key: source.source_key, polled_at: poll.polledAt, sha256: payloadHash }
        });
      } catch {
        rawKey = null;
      }
    }
  }

  const statements: D1PreparedStatement[] = [];
  statements.push(
    db.prepare(
      `INSERT INTO source_polls (source_registry_id, polled_at, ok, transport_status, parser_status, record_count, payload_hash, raw_object_key, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(source.id, poll.polledAt, ok && poll.complete ? 1 : 0, poll.transportStatus, poll.parserStatus, poll.records.length, payloadHash, rawKey, poll.error),
    db.prepare(
      `UPDATE source_registry
       SET last_checked_at = ?,
           last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
           last_error = ?, health_status = ?, transport_status = ?, parser_status = ?,
           last_observation_at = CASE WHEN ? > 0 THEN ? ELSE last_observation_at END,
           consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
           last_payload_hash = COALESCE(?, last_payload_hash),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(
      poll.polledAt, ok ? 1 : 0, poll.polledAt, poll.error, ok ? "healthy" : "degraded", poll.transportStatus, poll.parserStatus,
      poll.records.length, poll.polledAt, ok ? 1 : 0, payloadHash, source.id
    )
  );
  if (!ok) {
    await db.batch(statements);
    return result;
  }

  // 1. Existing records: everything listed, plus earlier episodes of incoming identities.
  const incomingKeys = [...new Set(poll.records.map((record) => record.baseKey))];
  const existing = new Map<number, RecordRow>();
  const keyParts = incomingKeys.length > 0 ? chunks(incomingKeys, IN_CHUNK) : [[]];
  for (const part of keyParts) {
    const clause = part.length > 0 ? `OR base_key IN (${part.map(() => "?").join(", ")})` : "";
    const rows = await db
      .prepare(`SELECT ${RECORD_COLUMNS} FROM source_records WHERE source_registry_id = ? AND (state = 'listed' ${clause})`)
      .bind(source.id, ...part)
      .all<RecordRow>();
    for (const row of rows.results) existing.set(row.id, row);
  }
  const byBaseKey = new Map<string, RecordRow[]>();
  for (const row of existing.values()) byBaseKey.set(row.base_key, [...(byBaseKey.get(row.base_key) ?? []), row]);

  const polledMs = Date.parse(poll.polledAt);
  const matchedIds = new Set<number>();
  const touchIds: number[] = [];
  const changedRecordIds = new Set<number>();
  const inserts: Array<{ input: OperatorRecordInput; recordKey: string; current: boolean; hash: string }> = [];

  for (const input of poll.records) {
    const current = isCurrentState(input.operatorState);
    const hash = recordContentFingerprint(input);
    const candidates = (byBaseKey.get(input.baseKey) ?? []).filter((row) => !matchedIds.has(row.id));
    const listed = candidates.find((row) => row.state === "listed");
    const latest = [...candidates].sort((left, right) => Date.parse(right.first_seen_at) - Date.parse(left.first_seen_at))[0];
    const reopenable = latest && latest.state === "ended" &&
      (input.stableIdentity || (latest.first_missing_at !== null && polledMs - Date.parse(latest.first_missing_at) <= REOPEN_GAP_MS));
    const target = listed ?? (reopenable ? latest : undefined);

    if (!target) {
      inserts.push({ input, recordKey: input.stableIdentity ? input.baseKey : `${input.baseKey}#${poll.polledAt}`, current, hash });
      continue;
    }
    matchedIds.add(target.id);

    const contentChanged = target.content_hash !== hash;
    const stateChange = current
      ? target.state !== "listed"
      : target.state === "listed";
    if (!contentChanged && !stateChange) {
      if (current) touchIds.push(target.id);
      continue;
    }
    changedRecordIds.add(target.id);
    if (stateChange && !current) result.recordsEnded += 1;
    statements.push(
      db.prepare(
        `UPDATE source_records SET
           kind = ?, operator_state = ?, title = ?, place_text = ?, detail_text = ?,
           latitude = ?, longitude = ?, reported_start_at = ?, reported_end_at = ?, end_is_actual = ?,
           cause = ?, customers_affected = ?, content_hash = ?, raw_json = ?,
           state = ?,
           last_seen_at = CASE WHEN ? = 1 THEN ? ELSE last_seen_at END,
           seen_current = CASE WHEN ? = 1 THEN 1 ELSE seen_current END,
           first_missing_at = CASE WHEN ? = 1 THEN NULL WHEN state = 'listed' THEN ? ELSE first_missing_at END,
           municipality = CASE WHEN latitude IS ? AND longitude IS ? THEN municipality ELSE NULL END,
           canton = CASE WHEN latitude IS ? AND longitude IS ? THEN canton ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(
        // A resolved status keeps the planned/unplanned nature the record had while current.
        current || !target.seen_current ? input.kind : target.kind,
        input.operatorState, input.title, input.placeText, input.detailText,
        input.latitude, input.longitude, input.reportedStartAt, input.reportedEndAt, input.endIsActual ? 1 : 0,
        input.cause, input.customersAffected, hash, JSON.stringify(input.raw ?? null).slice(0, 4000),
        current ? "listed" : "ended",
        current ? 1 : 0, poll.polledAt,
        current ? 1 : 0,
        current ? 1 : 0, poll.polledAt,
        input.latitude, input.longitude, input.latitude, input.longitude,
        target.id
      )
    );
  }

  // 2. Disappeared: listed records the complete listing no longer contains.
  const endedIds: number[] = [];
  if (poll.complete) {
    for (const row of existing.values()) {
      if (row.state === "listed" && !matchedIds.has(row.id)) endedIds.push(row.id);
    }
  }
  for (const part of chunks(endedIds, IN_CHUNK)) {
    statements.push(
      db.prepare(
        `UPDATE source_records SET state = 'ended', first_missing_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${part.map(() => "?").join(", ")})`
      ).bind(poll.polledAt, ...part)
    );
  }
  result.recordsEnded += endedIds.length;
  for (const id of endedIds) changedRecordIds.add(id);

  // 3. Still listed and unchanged: one shared UPDATE.
  for (const part of chunks(touchIds, IN_CHUNK)) {
    statements.push(
      db.prepare(`UPDATE source_records SET last_seen_at = ? WHERE id IN (${part.map(() => "?").join(", ")})`)
        .bind(poll.polledAt, ...part)
    );
  }

  // 4. New records. prev_absent_at = the last complete poll before this one.
  const insertStart = statements.length;
  for (const insert of inserts) {
    const input = insert.input;
    statements.push(
      db.prepare(
        `INSERT INTO source_records (
           source_registry_id, base_key, record_key, kind, state, operator_state, title, place_text, detail_text,
           latitude, longitude, reported_start_at, reported_end_at, end_is_actual, cause, customers_affected,
           prev_absent_at, first_seen_at, last_seen_at, seen_current, content_hash, raw_json, quality_flags
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
         ON CONFLICT(source_registry_id, record_key) DO NOTHING
         RETURNING id`
      ).bind(
        source.id, input.baseKey, insert.recordKey, input.kind, insert.current ? "listed" : "ended", input.operatorState,
        input.title, input.placeText, input.detailText, input.latitude, input.longitude,
        input.reportedStartAt, input.reportedEndAt, input.endIsActual ? 1 : 0, input.cause, input.customersAffected,
        source.last_success_at, poll.polledAt, poll.polledAt, insert.current ? 1 : 0,
        insert.hash, JSON.stringify(input.raw ?? null).slice(0, 4000)
      )
    );
  }
  const batchResults: D1Result[] = [];
  for (const part of chunks(statements, BATCH_CHUNK)) batchResults.push(...(await db.batch(part)));
  const newIds: number[] = [];
  for (let index = insertStart; index < insertStart + inserts.length; index += 1) {
    const row = (batchResults[index]?.results?.[0] ?? null) as { id?: number } | null;
    if (typeof row?.id === "number") newIds.push(row.id);
  }
  result.recordsNew = newIds.length;

  // 5. Load what the incident layer needs: all records of this source that are
  // new, changed, still listed or recent enough to join a new incident.
  const cutoff = new Date(polledMs - GROUPING_LOOKBACK_MS).toISOString();
  const working = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM source_records
       WHERE source_registry_id = ?
         AND (state = 'listed' OR outage_event_id IS NULL OR last_seen_at >= ? OR first_missing_at >= ? OR reported_start_at >= ?)`
    )
    .bind(source.id, cutoff, cutoff, cutoff)
    .all<RecordRow>();
  const records = new Map<number, RecordRow>(working.results.map((row) => [row.id, row]));

  // 6. Geocode records with coordinates but no municipality (cached, budgeted).
  const needGeo = [...records.values()].filter((row) => row.municipality === null && row.latitude !== null && row.longitude !== null);
  if (needGeo.length > 0) {
    const before = options.geoBudget.remaining;
    const fixes = await resolvePoints(
      db,
      needGeo.map((row) => ({ latitude: row.latitude as number, longitude: row.longitude as number })),
      options.geoBudget,
      poll.polledAt,
      options.geoLookup
    );
    result.geocoded = before - options.geoBudget.remaining;
    const geoWrites: D1PreparedStatement[] = [];
    for (const row of needGeo) {
      const fix = fixes.get(pointKey(row.latitude as number, row.longitude as number));
      if (!fix) continue;
      row.municipality = fix.municipality;
      row.canton = fix.canton;
      changedRecordIds.add(row.id);
      geoWrites.push(
        db.prepare("UPDATE source_records SET municipality = ?, canton = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(fix.municipality, fix.canton, row.id)
      );
    }
    for (const part of chunks(geoWrites, BATCH_CHUNK)) await db.batch(part);
  }

  // 7. Assign unassigned records to incidents.
  const assignment = await assignIncidents(db, source, [...records.values()], poll.polledAt);
  result.eventsCreated = assignment.created;
  result.eventsMerged = assignment.merged;

  // 8. Re-derive every incident touched by this poll.
  const affected = new Set<number>(assignment.affectedEventIds);
  for (const row of records.values()) {
    if (row.outage_event_id === null) continue;
    if (changedRecordIds.has(row.id) || newIds.includes(row.id) || row.state === "listed") affected.add(row.outage_event_id);
  }
  result.eventsUpdated = await refreshIncidents(db, source, [...affected], poll.polledAt);
  return result;
}

/** Assigns records without an incident. Mutates outage_event_id on the passed rows. */
async function assignIncidents(
  db: D1Database,
  source: SourceRegistryEntry,
  rows: StoredRecord[],
  now: string
): Promise<{ created: number; merged: number; affectedEventIds: number[] }> {
  const unassigned = rows.filter((row) => row.outage_event_id === null);
  if (unassigned.length === 0) return { created: 0, merged: 0, affectedEventIds: [] };
  const affected = new Set<number>();
  let created = 0;
  let merged = 0;
  const writes: D1PreparedStatement[] = [];

  for (const group of groupRecords(rows)) {
    const fresh = group.filter((row) => row.outage_event_id === null);
    if (fresh.length === 0) continue;
    const eventIds = [...new Set(group.map((row) => row.outage_event_id).filter((id): id is number => id !== null))].sort((a, b) => a - b);
    let target = eventIds[0];
    if (target === undefined) {
      const derived = deriveIncident(group, { id: source.id, operator_name: source.operator_name, url: source.url });
      const inserted = await db
        .prepare(
          `INSERT INTO outage_events (title, status, event_type, location_text, normalized_location, country, first_seen_at,
             last_seen_at, received_at, origin, source_registry_id, outage_nature, public_status, event_quality_state,
             verification_level, email_sent, research_status, time_confidence)
           VALUES (?, 'needs_review', ?, ?, ?, 'CH', ?, ?, ?, 'operator', ?, ?, 'hidden', 'candidate_only',
             'official_source', 1, 'not_needed', 'unknown')
           RETURNING id`
        )
        .bind(
          derived.title, derived.kind === "planned" ? "planned_outage" : "power_outage", derived.locationText,
          keyText(derived.locationText) || null, derived.firstSeenAt, derived.lastSeenAt, derived.firstSeenAt,
          source.id, derived.kind
        )
        .first<{ id: number }>();
      if (!inserted) continue;
      target = inserted.id;
      created += 1;
    }
    for (const other of eventIds.slice(1)) {
      // A new record bridges two incidents: they were one outage all along.
      merged += 1;
      writes.push(
        db.prepare("UPDATE source_records SET outage_event_id = ?, updated_at = CURRENT_TIMESTAMP WHERE outage_event_id = ?").bind(target, other),
        db.prepare(
          `UPDATE outage_events SET status = 'dismissed', merged_into_event_id = ?, public_status = 'hidden',
             event_quality_state = 'candidate_only', admin_note = 'merged by operator incident grouping', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(target, other),
        db.prepare(
          `UPDATE publication_decisions SET publishable = 0, reasons_json = '["merged_into_event"]', decided_at = ? WHERE outage_event_id = ?`
        ).bind(now, other)
      );
      for (const row of rows) if (row.outage_event_id === other) row.outage_event_id = target;
    }
    for (const row of fresh) row.outage_event_id = target;
    const ids = fresh.map((row) => row.id);
    for (const part of chunks(ids, IN_CHUNK)) {
      writes.push(
        db.prepare(`UPDATE source_records SET outage_event_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${part.map(() => "?").join(", ")})`)
          .bind(target, ...part)
      );
    }
    affected.add(target);
  }
  for (const part of chunks(writes, BATCH_CHUNK)) await db.batch(part);
  return { created, merged, affectedEventIds: [...affected] };
}

interface EventRow {
  id: number;
  title: string;
  status: string;
  location_text: string | null;
  canton: string | null;
  first_seen_at: string;
  last_seen_at: string;
  started_at_estimate: string | null;
  start_earliest_at: string | null;
  resolved_at_estimate: string | null;
  resolution_earliest_at: string | null;
  resolution_latest_at: string | null;
  expected_restore_at: string | null;
  last_confirmed_active_at: string | null;
  time_confidence: string;
  outage_nature: string | null;
  cause_text: string | null;
  summary: string | null;
  public_status: string | null;
  record_count: number;
  quality_flags: string;
  merged_into_event_id: number | null;
}

function eventStatus(derived: DerivedIncident): string {
  return derived.open ? "corroborated" : "resolved";
}

function materialFields(derived: DerivedIncident): unknown[] {
  return [
    derived.title, eventStatus(derived), derived.locationText, derived.canton, derived.firstSeenAt,
    derived.startedAt, derived.startEarliestAt, derived.resolvedAt, derived.resolutionEarliestAt,
    derived.resolutionLatestAt, derived.expectedRestoreAt, derived.timeConfidence, derived.kind,
    derived.cause, derived.summary, derived.publishable ? "public_verified" : "hidden", derived.recordCount,
    JSON.stringify(derived.qualityFlags)
  ];
}

function storedMaterialFields(row: EventRow): unknown[] {
  return [
    row.title, row.status, row.location_text, row.canton, row.first_seen_at,
    row.started_at_estimate, row.start_earliest_at, row.resolved_at_estimate, row.resolution_earliest_at,
    row.resolution_latest_at, row.expected_restore_at, row.time_confidence, row.outage_nature,
    row.cause_text, row.summary, row.public_status, row.record_count, row.quality_flags
  ];
}

/** Writes an incident's derived state. Only real changes (and an hourly "still active") are written. */
export async function refreshIncidents(
  db: D1Database,
  source: SourceRegistryEntry,
  eventIds: number[],
  now: string
): Promise<number> {
  if (eventIds.length === 0) return 0;
  const nowMs = Date.parse(now);
  let updated = 0;
  for (const part of chunks(eventIds, IN_CHUNK)) {
    const placeholders = part.map(() => "?").join(", ");
    const [eventRows, recordRows] = await Promise.all([
      db.prepare(`SELECT * FROM outage_events WHERE id IN (${placeholders})`).bind(...part).all<EventRow>(),
      db.prepare(`SELECT ${RECORD_COLUMNS} FROM source_records WHERE outage_event_id IN (${placeholders})`).bind(...part).all<RecordRow>()
    ]);
    const recordsByEvent = new Map<number, RecordRow[]>();
    for (const row of recordRows.results) {
      if (row.outage_event_id === null) continue;
      recordsByEvent.set(row.outage_event_id, [...(recordsByEvent.get(row.outage_event_id) ?? []), row]);
    }
    const writes: D1PreparedStatement[] = [];
    for (const event of eventRows.results) {
      if (event.merged_into_event_id !== null) continue;
      const records = recordsByEvent.get(event.id) ?? [];
      if (records.length === 0) continue;
      const derived = deriveIncident(records, { id: source.id, operator_name: source.operator_name, url: source.url });
      const material = JSON.stringify(materialFields(derived)) !== JSON.stringify(storedMaterialFields(event));
      const touch = derived.lastConfirmedActiveAt !== null && (
        !event.last_confirmed_active_at ||
        Date.parse(derived.lastConfirmedActiveAt) - Date.parse(event.last_confirmed_active_at) >= EVENT_TOUCH_INTERVAL_MS ||
        (!derived.open && derived.lastConfirmedActiveAt !== event.last_confirmed_active_at)
      );
      if (!material && !touch) continue;
      updated += 1;
      writes.push(...incidentWrites(db, event.id, derived, source, now, material));
    }
    for (const batch of chunks(writes, BATCH_CHUNK)) await db.batch(batch);
  }
  void nowMs;
  return updated;
}

export function incidentWrites(
  db: D1Database,
  eventId: number,
  derived: DerivedIncident,
  source: Pick<SourceRegistryEntry, "id" | "operator_name" | "url">,
  now: string,
  material = true
): D1PreparedStatement[] {
  const writes: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE outage_events SET
         title = ?, status = ?, event_type = ?, location_text = ?, normalized_location = ?, canton = ?, country = 'CH',
         first_seen_at = ?, last_seen_at = ?, received_at = ?, started_at_estimate = ?, start_earliest_at = ?,
         resolved_at_estimate = ?, resolution_earliest_at = ?, resolution_latest_at = ?, expected_restore_at = ?,
         last_confirmed_active_at = ?, time_confidence = ?, outage_nature = ?, cause_text = ?, summary = ?,
         reason = ?, confidence = 0.95, source_count = 1, primary_source_url = ?, primary_source_title = ?,
         public_status = ?, event_quality_state = ?, verification_level = 'official_source',
         location_granularity = 'municipality', evidence_level = 'official', origin = 'operator',
         source_registry_id = ?, record_count = ?, quality_flags = ?, mail_decision_reason = 'operator incident: no mail',
         email_sent = 1, research_status = 'not_needed', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(
      derived.title, eventStatus(derived), derived.kind === "planned" ? "planned_outage" : "power_outage",
      derived.locationText, keyText(derived.locationText) || null, derived.canton,
      derived.firstSeenAt, derived.lastSeenAt, derived.firstSeenAt, derived.startedAt, derived.startEarliestAt,
      derived.resolvedAt, derived.resolutionEarliestAt, derived.resolutionLatestAt, derived.expectedRestoreAt,
      derived.lastConfirmedActiveAt, derived.timeConfidence, derived.kind, derived.cause, derived.summary,
      `${INCIDENT_DERIVATION_VERSION} from ${derived.recordCount} operator record(s)`, source.url, source.operator_name,
      derived.publishable ? "public_verified" : "hidden", derived.publishable ? "publishable" : "candidate_only",
      source.id, derived.recordCount, JSON.stringify(derived.qualityFlags), eventId
    )
  ];
  if (!material) return writes;
  const domain = (() => {
    try {
      return new URL(source.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return null;
    }
  })();
  writes.push(
    db.prepare(
      `INSERT INTO publication_decisions (outage_event_id, publishable, trust, reasons_json, public_summary,
         primary_source_publisher, primary_source_url, primary_source_domain, evaluator_version, decided_at)
       VALUES (?, ?, 'official', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(outage_event_id) DO UPDATE SET publishable = excluded.publishable, trust = excluded.trust,
         reasons_json = excluded.reasons_json, public_summary = excluded.public_summary,
         primary_source_publisher = excluded.primary_source_publisher, primary_source_url = excluded.primary_source_url,
         primary_source_domain = excluded.primary_source_domain, evaluator_version = excluded.evaluator_version,
         decided_at = excluded.decided_at`
    ).bind(
      eventId, derived.publishable ? 1 : 0, JSON.stringify(derived.unpublishableReasons), derived.summary,
      source.operator_name, source.url, domain, `${INCIDENT_DERIVATION_VERSION}+${RECORD_EXTRACTOR_VERSION}`, now
    )
  );
  if (derived.latitude !== null && derived.longitude !== null && derived.locationText) {
    const primary = derived.municipalities[0] ?? derived.locationText;
    const label = derived.canton ? `${primary} (${derived.canton})` : primary;
    writes.push(
      db.prepare(
        `INSERT INTO event_public_locations (outage_event_id, query_text, label, latitude, longitude, precision, provider, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'municipality', 'operator', ?)
         ON CONFLICT(outage_event_id) DO UPDATE SET query_text = excluded.query_text, label = excluded.label,
           latitude = excluded.latitude, longitude = excluded.longitude, precision = excluded.precision,
           provider = excluded.provider, resolved_at = excluded.resolved_at
         WHERE event_public_locations.label != excluded.label
            OR abs(event_public_locations.latitude - excluded.latitude) > 0.0005
            OR abs(event_public_locations.longitude - excluded.longitude) > 0.0005
            OR event_public_locations.provider != excluded.provider`
      ).bind(eventId, `operator:${source.id}`, label, derived.latitude, derived.longitude, now)
    );
  }
  return writes;
}
