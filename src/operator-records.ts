/**
 * Operator records: the atomic unit of operator data.
 *
 * An operator feed is a *current listing* (which trafos are off, which works are
 * scheduled). Each item in it becomes one record, identified by the operator's
 * own identity — never by derived text such as a reverse-geocoded place name or
 * a generated title. Everything here is pure: no network, no database, so the
 * same code runs in the cron, in tests and when replaying archived payloads.
 */
import type { SourceObservationInput } from "./types";

export const RECORD_EXTRACTOR_VERSION = "operator-records/v1";

export type RecordKind = "planned" | "unplanned";
/** What the operator itself says about the item. "listed" = present, no state given. */
export type OperatorState = "active" | "scheduled" | "resolved" | "listed";

export interface OperatorRecordInput {
  /** Operator identity without episode, e.g. "trafo:10885:failure". */
  baseKey: string;
  /**
   * True when baseKey alone identifies exactly one occurrence (an operator uuid
   * or an identity that includes the announced start). False for a failing
   * trafo: the same trafo can fail again next month, so every sighting after a
   * gap starts a new episode.
   */
  stableIdentity: boolean;
  kind: RecordKind;
  operatorState: OperatorState;
  title: string | null;
  /** The operator's own place wording (cleaned), e.g. "Ettingen". */
  placeText: string | null;
  /** Streets, trafo names or other sub-place detail. */
  detailText: string | null;
  latitude: number | null;
  longitude: number | null;
  reportedStartAt: string | null;
  reportedEndAt: string | null;
  /** True when reportedEndAt is an actual end, not an announced or expected one. */
  endIsActual: boolean;
  cause: string | null;
  customersAffected: number | null;
  raw: unknown;
}

export interface RecordExtraction {
  /** False when the payload no longer matches the verified contract. */
  schemaMatched: boolean;
  records: OperatorRecordInput[];
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function compactText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function textOrNull(value: unknown): string | null {
  const text = compactText(value);
  return text || null;
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function swissCoordinate(latitude: number | null, longitude: number | null): { latitude: number | null; longitude: number | null } {
  if (latitude === null || longitude === null) return { latitude: null, longitude: null };
  if (latitude < 45.7 || latitude > 47.9 || longitude < 5.9 || longitude > 10.7) return { latitude: null, longitude: null };
  return { latitude, longitude };
}

/** Lower-case, accent-free, single-spaced: for identity keys only. */
export function keyText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// BKW: https://api-outage.bkw.ch/api/services/trafo/state — one row per trafo
// that is currently not supplied. FAILURE = unplanned, DISCONNECTION = planned
// (with announced window). Identity: the trafo number.
// ---------------------------------------------------------------------------
export function extractBkwRecords(payload: unknown, observedAt: string): RecordExtraction {
  if (!Array.isArray(payload)) return { schemaMatched: false, records: [] };
  const rows = payload.map(recordOf);
  const states = new Set(["SUPPLIED", "DISCONNECTION", "FAILURE"]);
  const trafoRows = rows.filter((row) =>
    typeof row.supplyState === "string" && states.has(row.supplyState) && finiteNumber(row.trafoNumber) !== null
  );
  const zoneRows = rows.filter((row) =>
    typeof row.supplyState === "string" && states.has(row.supplyState) && typeof row.city === "string"
  );
  if (rows.length > 0 && trafoRows.length === 0 && zoneRows.length === 0) return { schemaMatched: false, records: [] };
  const now = Date.parse(observedAt);
  const records: OperatorRecordInput[] = [];

  for (const row of trafoRows) {
    if (row.supplyState !== "FAILURE" && row.supplyState !== "DISCONNECTION") continue;
    const planned = row.supplyState === "DISCONNECTION";
    const trafo = String(finiteNumber(row.trafoNumber));
    const start = isoOrNull(row.disconnectionStartTime);
    const end = isoOrNull(row.disconnectionEndTime);
    const coords = swissCoordinate(finiteNumber(row.latitude), finiteNumber(row.longitude));
    const customers = finiteNumber(row.affectedCustomers);
    records.push({
      baseKey: planned ? `trafo:${trafo}:planned:${start ?? "open"}` : `trafo:${trafo}:failure`,
      stableIdentity: planned && Boolean(start),
      kind: planned ? "planned" : "unplanned",
      operatorState: planned && start && Date.parse(start) > now ? "scheduled" : "active",
      title: null,
      placeText: null,
      detailText: textOrNull(row.trafoName) ? `Trafostation ${compactText(row.trafoName)}` : null,
      ...coords,
      reportedStartAt: planned ? start : null,
      reportedEndAt: planned ? end : null,
      endIsActual: false,
      cause: null,
      customersAffected: customers !== null && customers > 0 ? customers : null,
      raw: row
    });
  }

  // Legacy zone format (until mid-August 2026): one row per municipality.
  for (const row of zoneRows) {
    if (row.supplyState !== "FAILURE" && row.supplyState !== "DISCONNECTION") continue;
    const planned = row.supplyState === "DISCONNECTION";
    const city = compactText(row.city);
    const plz = finiteNumber(row.plz);
    records.push({
      baseKey: `zone:${plz ?? ""}:${keyText(city)}:${planned ? "planned" : "failure"}`,
      stableIdentity: false,
      kind: planned ? "planned" : "unplanned",
      operatorState: "active",
      title: null,
      placeText: city || null,
      detailText: null,
      latitude: null,
      longitude: null,
      reportedStartAt: null,
      reportedEndAt: null,
      endIsActual: false,
      cause: null,
      customersAffected: null,
      raw: row
    });
  }
  return { schemaMatched: true, records };
}

// ---------------------------------------------------------------------------
// SAK: https://netzstatus.sak.ch/api/v1/failures — operator uuid per item.
// status 1 = active, 2 = resolved; category 0 = failure, otherwise planned work.
// ---------------------------------------------------------------------------
export function extractSakRecords(payload: unknown, observedAt: string): RecordExtraction {
  if (!Array.isArray(payload)) return { schemaMatched: false, records: [] };
  const rows = payload.map(recordOf);
  const matching = rows.filter((row) =>
    typeof row.id === "string" && typeof row.title === "string" &&
    typeof row.status === "number" && typeof row.category === "number" && typeof row.start_date === "string"
  ).filter((row) => !isNonElectricNotice(`${compactText(row.title)}. ${compactText(row.description)}`));
  if (rows.length > 0 && matching.length === 0) return { schemaMatched: false, records: [] };
  const now = Date.parse(observedAt);
  return {
    schemaMatched: true,
    records: matching.map((row) => {
      const start = isoOrNull(row.start_date);
      const end = isoOrNull(row.end_date);
      const planned = Number(row.category) !== 0;
      const resolvedByOperator = Number(row.status) === 2;
      const endPassed = Boolean(end && Date.parse(end) <= now);
      const coordinates = recordOf(row.coordinates);
      const title = compactText(row.title);
      const operatorState: OperatorState = resolvedByOperator || endPassed
        ? "resolved"
        : start && Date.parse(start) > now
          ? "scheduled"
          : "active";
      return {
        baseKey: `sak:${String(row.id)}`,
        stableIdentity: true,
        kind: planned ? "planned" : "unplanned",
        operatorState,
        title: title || null,
        placeText: sakPlace(title),
        detailText: null,
        ...swissCoordinate(finiteNumber(coordinates.latitude), finiteNumber(coordinates.longitude)),
        reportedStartAt: start,
        reportedEndAt: end,
        endIsActual: resolvedByOperator && Boolean(end),
        cause: null,
        customersAffected: null,
        raw: { ...row, template_default_failure: undefined, template_local_failure: undefined }
      } satisfies OperatorRecordInput;
    })
  };
}

/** "Störung Gebiet Ebni in Wald AR" → "Wald AR"; "Stromunterbruch Jonschwil" → "Jonschwil". */
export function sakPlace(title: string): string | null {
  const cleaned = compactText(title)
    .replace(/\(.*?\)/g, " ")
    .replace(/^(?:netz\s*)?(?:störung|stoerung|stromunterbruch|stromausfall|unterbruch)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const inPlace = cleaned.match(/\bin\s+(.+)$/i)?.[1];
  const place = (inPlace ?? cleaned).replace(/^gebiet\s+/i, "").trim();
  return place || null;
}

// ---------------------------------------------------------------------------
// Primeo: gridStatus.json — {current: [...], done: [...]}. No id: identity is
// title + announced start, both stable from PROGRESS to RESOLVED.
// ---------------------------------------------------------------------------
export function extractPrimeoRecords(payload: unknown, observedAt: string): RecordExtraction {
  const root = recordOf(payload);
  if (!Array.isArray(root.current) || !Array.isArray(root.done)) return { schemaMatched: false, records: [] };
  const statuses = new Set(["PROGRESS", "PLANNED", "RESOLVED"]);
  const now = Date.parse(observedAt);
  const records: OperatorRecordInput[] = [];
  let seen = 0;
  for (const [list, isDone] of [[root.current, false], [root.done, true]] as const) {
    for (const row of list.map(recordOf)) {
      seen += 1;
      if (typeof row.status !== "string" || !statuses.has(row.status) || typeof row.title !== "string") continue;
      if (isNonElectricNotice(row.title)) continue;
      const start = isoOrNull(row.from);
      const end = isoOrNull(row.to);
      const planned = row.status === "PLANNED";
      const split = splitPlaceDetail(row.title);
      const place = swissPlacesOnly(split.place);
      const detail = split.detail;
      if (split.place && !place) continue; // only French communes
      // Primeo files announced works under "done" before they happen, so a
      // planned item's state comes from its window, not from the list.
      const operatorState: OperatorState = planned
        ? start && Date.parse(start) > now
          ? "scheduled"
          : end && Date.parse(end) <= now
            ? "resolved"
            : "active"
        : isDone || row.status === "RESOLVED"
          ? "resolved"
          : "active";
      records.push({
        baseKey: `primeo:${keyText(place)}:${keyText(detail)}:${start ?? "open"}`,
        stableIdentity: Boolean(start),
        kind: planned ? "planned" : "unplanned",
        operatorState,
        title: compactText(row.title) || null,
        placeText: place,
        detailText: detail,
        latitude: null,
        longitude: null,
        reportedStartAt: start,
        reportedEndAt: end,
        endIsActual: row.status === "RESOLVED" && Boolean(end),
        cause: null,
        customersAffected: null,
        raw: row
      });
    }
  }
  if (seen > 0 && records.length === 0) return { schemaMatched: false, records: [] };
  return { schemaMatched: true, records };
}

/** "Balsthal ( Fläschackerstrasse )" → place "Balsthal", detail "Fläschackerstrasse". */
export function splitPlaceDetail(value: string): { place: string | null; detail: string | null } {
  const text = compactText(value);
  const match = text.match(/^([^()]+?)\s*\(\s*(.*?)\s*\)\s*$/);
  if (match) return { place: compactText(match[1]) || null, detail: compactText(match[2]) || null };
  return { place: text || null, detail: null };
}

// ---------------------------------------------------------------------------
// Romande Energie: re_infopannes/data — uuid_perturbation per item, GeoJSON
// impact zone. genre "coupure" = planned, "panne" = unplanned.
// ---------------------------------------------------------------------------
export function extractRomandeRecords(payload: unknown, observedAt: string): RecordExtraction {
  if (!Array.isArray(payload)) return { schemaMatched: false, records: [] };
  const rows = payload.map(recordOf);
  const matching = rows.filter((row) =>
    typeof row.uuid_perturbation === "string" && (row.genre === "coupure" || row.genre === "panne") &&
    typeof row.date_debut === "string"
  );
  if (rows.length > 0 && matching.length === 0) return { schemaMatched: false, records: [] };
  const now = Date.parse(observedAt);
  return {
    schemaMatched: true,
    records: matching.map((row) => {
      const planned = row.genre === "coupure";
      const start = isoOrNull(row.date_debut);
      const end = isoOrNull(row.date_fin);
      const geojson = recordOf(row.geojson);
      const features = Array.isArray(geojson.features) ? geojson.features.map(recordOf) : [];
      const properties = recordOf(features[0]?.properties);
      const centroid = geojsonPointCentroid(row.geojson);
      const endPassed = Boolean(end && Date.parse(end) <= now);
      const operatorState: OperatorState = planned
        ? (start && Date.parse(start) > now ? "scheduled" : endPassed ? "resolved" : "active")
        : row.active === true
          ? "active"
          : end
            ? "resolved"
            : "listed";
      return {
        baseKey: `romande:${String(row.uuid_perturbation)}`,
        stableIdentity: true,
        kind: planned ? "planned" : "unplanned",
        operatorState,
        title: null,
        placeText: textOrNull(properties.LOCATION ?? properties.LIEU ?? row.location),
        detailText: null,
        ...swissCoordinate(centroid?.latitude ?? null, centroid?.longitude ?? null),
        reportedStartAt: start,
        reportedEndAt: end,
        endIsActual: !planned && row.active !== true && Boolean(end),
        cause: textOrNull(properties.CAUSE),
        customersAffected: null,
        // The polygon is large and already archived with the raw payload.
        raw: { ...row, geojson: undefined }
      } satisfies OperatorRecordInput;
    })
  };
}

function collectPoints(value: unknown, out: Array<[number, number]>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) collectPoints(child, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "Point" && Array.isArray(record.coordinates)) {
    const [lon, lat] = record.coordinates as unknown[];
    if (typeof lon === "number" && typeof lat === "number") out.push([lat, lon]);
    return;
  }
  for (const key of ["features", "geometry", "geometries"]) collectPoints(record[key], out);
}

function collectAllPositions(value: unknown, out: Array<[number, number]>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      out.push([value[1] as number, value[0] as number]);
      return;
    }
    for (const child of value) collectAllPositions(child, out);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["features", "geometry", "geometries", "coordinates"]) collectAllPositions(record[key], out);
}

/** Romande puts explicit Point markers next to the impact polygon; prefer those. */
export function geojsonPointCentroid(geojson: unknown): { latitude: number; longitude: number } | null {
  const points: Array<[number, number]> = [];
  collectPoints(geojson, points);
  if (points.length === 0) collectAllPositions(geojson, points);
  if (points.length === 0) return null;
  return {
    latitude: points.reduce((sum, point) => sum + point[0], 0) / points.length,
    longitude: points.reduce((sum, point) => sum + point[1], 0) / points.length
  };
}

// ---------------------------------------------------------------------------
// Generic: item-level HTML adapters (ewl, SES, ewz, TB Flawil, structured
// lists), Repower and Alertswiss already emit one observation per item. Their
// identity is place + announced start, which survives the status change from
// "in Arbeit" to "abgeschlossen".
// ---------------------------------------------------------------------------
const POWER_WORDS = /\b(?:strom|elektri|electri|courant|corrente|energia elettrica|netzst[oö]rung|stromnetz)\w*/i;
// Street lighting is electric but not a supply outage.
const NON_POWER_WORDS = /\b(?:\w*beleuchtung|[ée]clairage public|illuminazione pubblica|fernw[aä]rme\w*|w[aä]rmeverbund|w[aä]rmeversorgung|w[aä]rmenetz\w*|wasserversorgung|trinkwasser|wasserleitung|abwasser|erdgas|gasversorgung|gasleitung|chauffage [aà] distance|eau potable|acqua potabile|teleriscaldamento|glasfaser|internet|tv)\b/i;
const SPARTE = /\b(?:sparte|branche|secteur|settore)\s*:\s*([\p{L} ]+)/iu;

const NON_POWER_WORDS_ALL = new RegExp(NON_POWER_WORDS.source, "gi");
const LIGHTING_WORDS = /\w*beleuchtung|[ée]clairage public|illuminazione pubblica/i;
/** Words that only fit an interruption of the household supply, not of street lights. */
const SUPPLY_OUTAGE_WORDS = /\b(?:stromausfall|stromausf[aä]lle|stromunterbruch|stromunterbr[uü]che|versorgungsunterbruch|unterbruch der stromversorgung|panne de courant|pannes de courant|coupure de courant|coupures de courant|interruzion[ei] (?:di|della) corrente|blackout)\b/i;

/** Utility filter: district heating, water, gas works or street lighting are not power outages. */
export function isNonElectricNotice(text: string): boolean {
  const sparte = text.match(SPARTE)?.[1];
  if (sparte) return !POWER_WORDS.test(sparte);
  // "Ausfällen der Strassen- und Quartierbeleuchtung" mentions electricity
  // ("Stromnetz", "Strom") without any household losing power.
  if (LIGHTING_WORDS.test(text) && !SUPPLY_OUTAGE_WORDS.test(text)) return true;
  return NON_POWER_WORDS.test(text) && !POWER_WORDS.test(text.replace(NON_POWER_WORDS_ALL, " "));
}

/**
 * French communes in Primeo's grid around Saint-Louis (Alsace). outage.ch
 * covers Switzerland only, so these records are dropped.
 */
const FRENCH_PRIMEO_COMMUNES = new Set([
  "leymen", "folgensbourg", "hesingue", "liebenswiller", "liebenswiler", "hegenheim", "hagenthal-le-bas",
  "hagenthal-le-haut", "neuwiller", "wentzwiller", "buschwiller", "attenschwiller", "michelbach-le-bas",
  "michelbach-le-haut", "knoeringue", "ranspach-le-bas", "ranspach-le-haut", "saint-louis", "huningue",
  "village-neuf", "blotzheim", "hesingue", "oltingue", "wolschwiller", "biederthal", "linsdorf", "kiffis"
]);

function communeKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, "-");
}

/** Places of a comma/"und"-separated list that lie in France ("-le-Bas"/"-le-Haut" or known Primeo communes). */
export function isFrenchPlace(name: string): boolean {
  const key = communeKey(name);
  return FRENCH_PRIMEO_COMMUNES.has(key) || /-le-(?:bas|haut)$/.test(key);
}

/** Keeps only the Swiss places of a place list; null when none is left. */
export function swissPlacesOnly(place: string | null): string | null {
  if (!place) return null;
  const parts = place.split(/\s*,\s*|\s+und\s+|\s+et\s+/i).map((part) => part.trim()).filter(Boolean);
  const swiss = parts.filter((part) => !isFrenchPlace(part));
  if (swiss.length === parts.length) return place;
  return swiss.length ? swiss.join(", ") : null;
}

const PLANNED_WORDS = /\b(?:geplant\w*|planifi\w*|pianificat\w*|programmat\w*|unterhalt|wartung|travaux|lavori|bauarbeiten)\b/i;

export function recordsFromObservations(observations: SourceObservationInput[]): OperatorRecordInput[] {
  const out: OperatorRecordInput[] = [];
  for (const observation of observations) {
    const status = observation.canonicalStatus;
    if (status !== "planned" && status !== "unplanned" && status !== "resolved") continue;
    const text = `${observation.title}. ${observation.evidenceExcerpt}`;
    if (isNonElectricNotice(text)) continue;
    const kind: RecordKind = status === "planned" || (status === "resolved" && PLANNED_WORDS.test(text))
      ? "planned"
      : "unplanned";
    const place = textOrNull(observation.locationText);
    const start = isoOrNull(observation.startedAt);
    const end = isoOrNull(observation.resolvedAt);
    const raw = observation.rawPayloadJson ? safeJson(observation.rawPayloadJson) : null;
    // Adapters whose lists hold several items per place and start (IWB streets,
    // Kreuzlingen notices) pass the operator's own wording as raw.identity.
    const explicitIdentity = raw && typeof raw === "object" && typeof (raw as { identity?: unknown }).identity === "string"
      ? keyText((raw as { identity: string }).identity)
      : "";
    const identityText = explicitIdentity
      || (start ? keyText(place) : keyText(observation.title.replace(/^(?:behoben\w*|beendet\w*)\s+/i, "")));
    // Adapters that know the street or building pass it as raw.detail (ewl).
    const detail = raw && typeof raw === "object" && typeof (raw as { detail?: unknown }).detail === "string"
      ? textOrNull((raw as { detail: string }).detail)
      : null;
    out.push({
      baseKey: `item:${identityText}:${start ?? "open"}`,
      stableIdentity: Boolean(start),
      kind,
      operatorState: status === "resolved"
        ? "resolved"
        : status === "planned" && start && Date.parse(start) > Date.parse(observation.observedAt)
          ? "scheduled"
          : "active",
      title: observation.title || null,
      placeText: place,
      detailText: detail,
      latitude: null,
      longitude: null,
      reportedStartAt: start,
      reportedEndAt: end,
      endIsActual: status === "resolved" && Boolean(end),
      cause: null,
      customersAffected: null,
      raw
    });
  }
  return dedupeByBaseKey(out);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One listing must not contain the same identity twice; the later row wins. */
export function dedupeByBaseKey(records: OperatorRecordInput[]): OperatorRecordInput[] {
  const byKey = new Map<string, OperatorRecordInput>();
  for (const record of records) byKey.set(record.baseKey, record);
  return [...byKey.values()];
}

export function extractKnownApiRecords(sourceKey: string, payload: unknown, observedAt: string): RecordExtraction | null {
  const extractors: Record<string, (payload: unknown, observedAt: string) => RecordExtraction> = {
    "bkw-outage": extractBkwRecords,
    "sak-netzstatus": extractSakRecords,
    "primeo-netzstatus": extractPrimeoRecords,
    "romande-energie-pannes": extractRomandeRecords
  };
  const extractor = extractors[sourceKey];
  if (!extractor) return null;
  const result = extractor(payload, observedAt);
  return { ...result, records: dedupeByBaseKey(result.records) };
}

/** A record is current while the operator lists it as active, scheduled or plain listed. */
export function isCurrentState(state: OperatorState): boolean {
  return state !== "resolved";
}

/** Content fingerprint: changes when anything the incident derivation reads changes. */
export function recordContentFingerprint(record: OperatorRecordInput): string {
  return JSON.stringify([
    record.kind, record.operatorState, record.placeText, record.detailText,
    record.latitude, record.longitude, record.reportedStartAt, record.reportedEndAt,
    record.endIsActual, record.cause, record.customersAffected
  ]);
}
