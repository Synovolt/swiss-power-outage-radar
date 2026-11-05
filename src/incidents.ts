/**
 * Incidents: operator records grouped into one physical outage, and every
 * public field derived from those records. Pure and deterministic — the cron,
 * the history rebuild and the tests all run exactly this code, so rebuilding
 * from the records always yields the same events.
 *
 * Time model (no invented precision):
 *   start = operator-announced start, else the window
 *           [last complete poll without it, first poll with it]
 *   end   = operator-reported actual end, else the announced end when the item
 *           disappeared around it, else the window
 *           [last poll with it, first complete poll without it]
 */
import { keyText } from "./operator-records";

export const INCIDENT_DERIVATION_VERSION = "incidents/v1";

/** Two records farther apart than this are separate incidents. */
export const INCIDENT_RADIUS_METERS = 2500;

/** Grid operators whose whole supply area lies in one canton (by registry operator_name). */
export const SINGLE_CANTON_OPERATORS: Readonly<Record<string, string>> = {
  "AIL": "TI",
  "AIM Mendrisio": "TI",
  "AGE Chiasso": "TI",
  "SES": "TI",
  "ewl Luzern": "LU",
  "EW Davos": "GR",
  "TB Flawil": "SG",
  "Energie Thun": "BE",
  "Energie Wasser Bern": "BE",
  "ESB Biel": "BE",
  "Energie Uster": "ZH",
  "EKZ": "ZH",
  "EKS": "SH",
  "AEW": "AG"
};
/** Unplanned records starting further apart than this are separate incidents. */
export const UNPLANNED_START_SPREAD_MS = 6 * 60 * 60 * 1000;
/** Slack for "still the same incident" between one record ending and another starting. */
export const CONTINUITY_SLACK_MS = 30 * 60 * 1000;
/** Announced planned starts within this spread belong to the same works. */
export const PLANNED_START_SPREAD_MS = 60 * 60 * 1000;
/** An announced end counts when the item disappeared within this slack around it. */
export const ANNOUNCED_END_SLACK_MS = 20 * 60 * 1000;

export interface StoredRecord {
  id: number;
  source_registry_id: number;
  base_key: string;
  record_key: string;
  kind: "planned" | "unplanned";
  state: "listed" | "ended";
  operator_state: string;
  title: string | null;
  place_text: string | null;
  detail_text: string | null;
  municipality: string | null;
  canton: string | null;
  latitude: number | null;
  longitude: number | null;
  reported_start_at: string | null;
  reported_end_at: string | null;
  end_is_actual: number;
  cause: string | null;
  customers_affected: number | null;
  prev_absent_at: string | null;
  first_seen_at: string;
  /** Last poll that listed it as current. */
  last_seen_at: string;
  seen_current: number;
  first_missing_at: string | null;
  outage_event_id: number | null;
  quality_flags: string;
}

function ms(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value);
}

function iso(value: number): string | null {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function recordPlaceKey(record: Pick<StoredRecord, "municipality" | "place_text">): string {
  return keyText(record.municipality ?? record.place_text);
}

function hasCoords(record: StoredRecord): record is StoredRecord & { latitude: number; longitude: number } {
  return typeof record.latitude === "number" && typeof record.longitude === "number";
}

export interface TimeWindow {
  /** Earliest possible instant. */
  earliest: number;
  /** Latest possible instant (equal to earliest when exact). */
  latest: number;
  exact: boolean;
}

export function recordStart(record: StoredRecord): TimeWindow {
  const reported = ms(record.reported_start_at);
  if (Number.isFinite(reported)) return { earliest: reported, latest: reported, exact: true };
  const firstSeen = ms(record.first_seen_at);
  const prevAbsent = ms(record.prev_absent_at);
  return {
    earliest: Number.isFinite(prevAbsent) && prevAbsent < firstSeen ? prevAbsent : firstSeen,
    latest: firstSeen,
    exact: false
  };
}

/** null while the record is still listed or its end is unknown. */
export function recordEnd(record: StoredRecord): TimeWindow | null {
  const reported = ms(record.reported_end_at);
  if (record.end_is_actual === 1 && Number.isFinite(reported)) {
    return { earliest: reported, latest: reported, exact: true };
  }
  if (record.state !== "ended") return null;
  const lastSeen = ms(record.last_seen_at);
  const firstMissing = ms(record.first_missing_at);
  if (Number.isFinite(firstMissing)) {
    // The announced end is the truth when the item vanished right around it.
    if (
      Number.isFinite(reported) &&
      reported >= lastSeen - ANNOUNCED_END_SLACK_MS &&
      reported <= firstMissing + ANNOUNCED_END_SLACK_MS
    ) {
      return { earliest: reported, latest: reported, exact: true };
    }
    return { earliest: Math.min(lastSeen, firstMissing), latest: firstMissing, exact: false };
  }
  // The operator marked it resolved before it ever disappeared.
  if (Number.isFinite(reported)) return { earliest: reported, latest: reported, exact: true };
  return null;
}

/** Interval used for grouping: [start, end or +∞ while open]. */
function groupingInterval(record: StoredRecord): [number, number] {
  const start = recordStart(record).latest;
  const end = recordEnd(record);
  if (end) return [start, end.latest];
  if (record.state === "listed") return [start, Number.POSITIVE_INFINITY];
  // Ended without a known end: assume it ended by its last sighting.
  return [start, ms(record.last_seen_at)];
}

export function recordsBelongTogether(a: StoredRecord, b: StoredRecord): boolean {
  if (a.source_registry_id !== b.source_registry_id || a.kind !== b.kind) return false;

  if (hasCoords(a) && hasCoords(b)) {
    if (distanceMeters(a, b) > INCIDENT_RADIUS_METERS) return false;
  } else {
    const placeA = recordPlaceKey(a);
    if (!placeA || placeA !== recordPlaceKey(b)) return false;
  }

  if (a.kind === "planned") {
    const startA = ms(a.reported_start_at);
    const startB = ms(b.reported_start_at);
    if (Number.isFinite(startA) && Number.isFinite(startB)) {
      if (Math.abs(startA - startB) > PLANNED_START_SPREAD_MS) return false;
      const endA = ms(a.reported_end_at);
      const endB = ms(b.reported_end_at);
      if (Number.isFinite(endA) && Number.isFinite(endB)) {
        return startA < endB + CONTINUITY_SLACK_MS && startB < endA + CONTINUITY_SLACK_MS;
      }
      return true;
    }
    if (Number.isFinite(startA) !== Number.isFinite(startB)) return false;
  }

  const [startA, endA] = groupingInterval(a);
  const [startB, endB] = groupingInterval(b);
  if (Math.abs(startA - startB) > UNPLANNED_START_SPREAD_MS && a.kind === "unplanned") return false;
  return startA <= endB + CONTINUITY_SLACK_MS && startB <= endA + CONTINUITY_SLACK_MS;
}

/** Union-find over records → groups, each ordered by first sighting. */
export function groupRecords(records: StoredRecord[]): StoredRecord[][] {
  const sorted = [...records].sort((left, right) => ms(left.first_seen_at) - ms(right.first_seen_at) || left.id - right.id);
  const parent = sorted.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (recordsBelongTogether(sorted[i], sorted[j])) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[Math.max(rootI, rootJ)] = Math.min(rootI, rootJ);
      }
    }
  }
  const groups = new Map<number, StoredRecord[]>();
  sorted.forEach((record, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), record]);
  });
  return [...groups.values()];
}

export interface IncidentSource {
  id: number;
  operator_name: string;
  url: string;
}

export interface DerivedIncident {
  kind: "planned" | "unplanned";
  open: boolean;
  title: string;
  locationText: string | null;
  municipalities: string[];
  canton: string | null;
  latitude: number | null;
  longitude: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  startedAt: string | null;
  startEarliestAt: string | null;
  resolvedAt: string | null;
  resolutionEarliestAt: string | null;
  resolutionLatestAt: string | null;
  expectedRestoreAt: string | null;
  lastConfirmedActiveAt: string | null;
  timeConfidence: "reported" | "inferred" | "unknown";
  cause: string | null;
  customersAffected: number | null;
  recordCount: number;
  detail: string | null;
  qualityFlags: string[];
  summary: string;
  publishable: boolean;
  unpublishableReasons: string[];
}

const SWISS_TIME = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich",
  day: "numeric",
  month: "long",
  year: "numeric"
});
const SWISS_CLOCK = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich",
  hour: "2-digit",
  minute: "2-digit"
});

function mostFrequent(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([value]) => value);
}

function parseFlags(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === "string") : [];
  } catch {
    return [];
  }
}

export function deriveIncident(records: StoredRecord[], source: IncidentSource): DerivedIncident {
  if (records.length === 0) throw new Error("deriveIncident needs at least one record");
  const kind = records.some((record) => record.kind === "unplanned") ? "unplanned" : "planned";
  const open = records.some((record) => record.state === "listed");
  const qualityFlags = new Set(records.flatMap((record) => parseFlags(record.quality_flags)));

  // Place: municipalities by frequency; operator wording as fallback.
  const municipalities = mostFrequent(records.map((record) => record.municipality?.trim() ?? "").filter(Boolean));
  const operatorPlaces = mostFrequent(records.map((record) => record.place_text?.trim() ?? "").filter(Boolean));
  const places = municipalities.length > 0 ? municipalities : operatorPlaces;
  const locationText = places.length > 0 ? places.slice(0, 4).join(", ") : null;
  const primaryMunicipality = municipalities[0] ?? null;
  const recordCanton = primaryMunicipality
    ? records.find((record) => record.municipality === primaryMunicipality && record.canton)?.canton ?? null
    : records.find((record) => record.canton)?.canton ?? null;
  // Operators whose grid lies in one canton (AIL, SES, ewl …) need no geocode for it.
  const canton = recordCanton ?? SINGLE_CANTON_OPERATORS[source.operator_name] ?? null;
  if (municipalities.length === 0 && operatorPlaces.length > 0) qualityFlags.add("place_from_operator_text");

  const withCoords = records.filter(hasCoords);
  const latitude = withCoords.length ? withCoords.reduce((sum, record) => sum + record.latitude, 0) / withCoords.length : null;
  const longitude = withCoords.length ? withCoords.reduce((sum, record) => sum + record.longitude, 0) / withCoords.length : null;

  // Start: the earliest record start.
  const starts = records.map(recordStart);
  const earliestStart = starts.reduce((best, window) => (window.latest < best.latest ? window : best));
  const startExact = earliestStart.exact;
  if (!startExact) qualityFlags.add("start_observed");

  // End: only when every record has ended; the latest record end. Rebuilt
  // history sometimes lacks the end of a single trafo inside a multi-trafo
  // incident; then the other records' ends stand for the incident.
  let ends = records.map(recordEnd);
  const knownEnds = ends.filter((end): end is TimeWindow => end !== null);
  const unknownAreBackfill = records.every((record, index) => ends[index] !== null || parseFlags(record.quality_flags).includes("backfill"));
  if (!open && knownEnds.length > 0 && knownEnds.length < ends.length && unknownAreBackfill) {
    ends = knownEnds;
    qualityFlags.add("end_partial");
  }
  const allEnded = !open;
  let resolvedAt: string | null = null;
  let resolutionEarliestAt: string | null = null;
  let resolutionLatestAt: string | null = null;
  let endKnown = false;
  if (allEnded && ends.every((end): end is TimeWindow => end !== null)) {
    const latest = ends.reduce((best, window) => (window.latest > best.latest ? window : best));
    const earliest = Math.max(...ends.map((window) => window.earliest));
    endKnown = true;
    if (latest.exact && earliest === latest.earliest) {
      resolvedAt = iso(latest.latest);
    } else {
      resolutionEarliestAt = iso(earliest);
      resolutionLatestAt = iso(latest.latest);
      qualityFlags.add("end_window");
    }
  } else if (allEnded) {
    qualityFlags.add("end_unknown");
  }

  const reportedEnds = records.map((record) => ms(record.reported_end_at)).filter(Number.isFinite);
  const announcedEnd = reportedEnds.length ? Math.max(...reportedEnds) : NaN;
  const expectedRestoreAt = records.some((record) => record.end_is_actual === 1) ? null : iso(announcedEnd);

  const listedSightings = records
    .filter((record) => record.seen_current === 1)
    .map((record) => ms(record.last_seen_at))
    .filter(Number.isFinite);
  const lastConfirmedActiveAt = listedSightings.length ? iso(Math.max(...listedSightings)) : null;

  const firstSeenAt = iso(Math.min(...records.map((record) => ms(record.first_seen_at)))) as string;
  const lastSeenAt = iso(Math.max(...records.map((record) => ms(record.last_seen_at)))) as string;

  const exactStart = startExact && (endKnown ? resolvedAt !== null : true);
  const timeConfidence: DerivedIncident["timeConfidence"] = allEnded && !endKnown
    ? "unknown"
    : exactStart
      ? "reported"
      : "inferred";

  const causes = mostFrequent(records.map((record) => record.cause?.trim() ?? "").filter(Boolean));
  const customers = records.map((record) => record.customers_affected).filter((value): value is number => typeof value === "number" && value > 0);
  const trafoCount = records.filter((record) => /^trafo:/.test(record.base_key)).length;
  const details = mostFrequent(records.map((record) => record.detail_text?.trim() ?? "").filter(Boolean));
  const detail = trafoCount > 1
    ? `${trafoCount} Trafostationen betroffen`
    : details[0] ?? null;

  const place = locationText ?? "unbekanntem Ort";
  const title = kind === "planned" ? `Geplanter Stromunterbruch in ${place}` : `Stromausfall in ${place}`;
  const summary = incidentSummary({
    kind,
    place,
    operator: source.operator_name,
    start: startExact ? earliestStart.latest : NaN,
    end: Number.isFinite(announcedEnd) ? announcedEnd : NaN,
    detail,
    cause: causes[0] ?? null
  });

  const unpublishableReasons: string[] = [];
  if (!locationText) unpublishableReasons.push("place_unresolved");

  return {
    kind,
    open,
    title,
    locationText,
    municipalities: places.slice(0, 12),
    canton,
    latitude,
    longitude,
    firstSeenAt,
    lastSeenAt,
    startedAt: startExact ? iso(earliestStart.latest) : null,
    startEarliestAt: startExact ? null : iso(earliestStart.earliest),
    resolvedAt,
    resolutionEarliestAt,
    resolutionLatestAt,
    expectedRestoreAt,
    lastConfirmedActiveAt,
    timeConfidence,
    cause: causes[0] ?? null,
    customersAffected: customers.length ? customers.reduce((sum, value) => sum + value, 0) : null,
    recordCount: records.length,
    detail,
    qualityFlags: [...qualityFlags].sort(),
    summary,
    publishable: unpublishableReasons.length === 0,
    unpublishableReasons
  };
}

function incidentSummary(input: {
  kind: "planned" | "unplanned";
  place: string;
  operator: string;
  start: number;
  end: number;
  detail: string | null;
  cause: string | null;
}): string {
  const parts: string[] = [];
  if (input.kind === "planned") {
    if (Number.isFinite(input.start)) {
      const day = SWISS_TIME.format(new Date(input.start));
      const from = SWISS_CLOCK.format(new Date(input.start));
      const to = Number.isFinite(input.end) && input.end > input.start ? SWISS_CLOCK.format(new Date(input.end)) : null;
      parts.push(`${input.operator} kündigt einen geplanten Stromunterbruch in ${input.place} an: ${day}, ${from}${to ? `–${to}` : ""} Uhr.`);
    } else {
      parts.push(`${input.operator} meldet einen geplanten Stromunterbruch in ${input.place}.`);
    }
  } else {
    parts.push(`${input.operator} meldet einen Stromausfall in ${input.place}.`);
  }
  if (input.detail) parts.push(`${input.detail.replace(/\.$/, "")}.`);
  if (input.cause) parts.push(`Grund: ${input.cause.replace(/\.$/, "")}.`);
  return parts.join(" ").slice(0, 320);
}
