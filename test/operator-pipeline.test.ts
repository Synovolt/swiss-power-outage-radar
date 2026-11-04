import { describe, expect, it } from "vitest";
import { deriveIncident, groupRecords, recordEnd, recordStart, type StoredRecord } from "../src/incidents";
import { ingestOperatorPoll, type OperatorPoll } from "../src/operator-ingest";
import {
  extractBkwRecords,
  extractPrimeoRecords,
  extractRomandeRecords,
  extractSakRecords,
  isNonElectricNotice,
  recordsFromObservations,
  sakPlace,
  splitPlaceDetail,
  type OperatorRecordInput
} from "../src/operator-records";
import { toPublicFeedItem } from "../src/publication";
import type { OutageEvent, SourceObservationInput, SourceRegistryEntry } from "../src/types";
import { migratedDatabase, type SqliteD1 } from "./helpers/sqlite-d1";

const T0 = "2026-11-04T10:00:00.000Z";
function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function trafo(number: number, state: "FAILURE" | "DISCONNECTION", lat: number, lon: number, window?: [string, string]) {
  return {
    trafoNumber: number,
    trafoName: `TS ${number}`,
    supplyState: state,
    affectedCustomers: 0,
    latitude: lat,
    longitude: lon,
    ...(window ? { disconnectionStartTime: window[0], disconnectionEndTime: window[1] } : {})
  };
}

const GEO: Record<string, { municipality: string; canton: string }> = {
  "46.6667,7.5552": { municipality: "Erlenbach im Simmental", canton: "BE" },
  "46.6700,7.5600": { municipality: "Erlenbach im Simmental", canton: "BE" },
  "47.1582,7.3415": { municipality: "Meinisberg", canton: "BE" },
  "46.8552,7.5316": { municipality: "Gerzensee", canton: "BE" }
};
const lookups: string[] = [];
async function fakeLookup(latitude: number, longitude: number) {
  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  lookups.push(key);
  return GEO[key] ?? null;
}

async function source(db: SqliteD1, key: string): Promise<SourceRegistryEntry> {
  const row = await db.prepare("SELECT * FROM source_registry WHERE source_key = ?").bind(key).first<SourceRegistryEntry>();
  if (!row) throw new Error(`missing source ${key}`);
  return row;
}

async function poll(db: SqliteD1, key: string, records: OperatorRecordInput[], polledAt: string, complete = true) {
  const input: OperatorPoll = {
    polledAt,
    records,
    complete,
    transportStatus: "ok",
    parserStatus: records.length ? "ready" : "no_current_outage",
    error: null,
    payloadText: JSON.stringify(records.map((record) => record.raw)),
    usedFirecrawl: false
  };
  return ingestOperatorPoll({ DB: db.asD1() }, await source(db, key), input, { geoBudget: { remaining: 10 }, geoLookup: fakeLookup });
}

function bkw(rows: unknown[], observedAt: string): OperatorRecordInput[] {
  const extraction = extractBkwRecords(rows, observedAt);
  expect(extraction.schemaMatched).toBe(true);
  return extraction.records;
}

async function events(db: SqliteD1) {
  return (await db.prepare("SELECT * FROM outage_events WHERE origin = 'operator' ORDER BY id").all<OutageEvent & { record_count: number; quality_flags: string; start_earliest_at: string | null }>()).results;
}

describe("operator record extraction", () => {
  it("keys BKW trafos by number, planned ones by number and announced start", () => {
    const records = extractBkwRecords([
      trafo(10885, "FAILURE", 46.66672, 7.55522),
      trafo(30040, "DISCONNECTION", 46.85515, 7.53157, ["2026-11-04T12:00:00Z", "2026-11-04T16:00:00Z"]),
      { trafoNumber: 1, trafoName: "ok", supplyState: "SUPPLIED", latitude: 47, longitude: 7 }
    ], T0).records;
    expect(records.map((record) => [record.baseKey, record.stableIdentity, record.kind, record.operatorState])).toEqual([
      ["trafo:10885:failure", false, "unplanned", "active"],
      ["trafo:30040:planned:2026-11-04T12:00:00.000Z", true, "planned", "scheduled"]
    ]);
  });

  it("reports a schema change instead of silently returning nothing", () => {
    expect(extractBkwRecords([{ foo: 1 }], T0).schemaMatched).toBe(false);
    expect(extractPrimeoRecords({ items: [] }, T0).schemaMatched).toBe(false);
  });

  it("keeps Primeo history from the done list, including completed planned works", () => {
    const records = extractPrimeoRecords({
      current: [{ status: "PROGRESS", title: "Balsthal ( Fläschackerstrasse  )", from: "2026-11-01T04:05:00.000Z" }],
      done: [
        { status: "PLANNED", title: "Ettingen ( Neubergliweg )", from: "2026-11-03T12:30:00.000Z", to: "2026-11-03T14:00:00.000Z" },
        { status: "RESOLVED", title: "Seewen ( Bödeli )", from: "2026-10-30T07:13:00.000Z", to: "2026-10-30T07:14:00.000Z" }
      ]
    }, T0).records;
    expect(records.map((record) => [record.placeText, record.kind, record.operatorState, record.endIsActual])).toEqual([
      ["Balsthal", "unplanned", "active", false],
      ["Ettingen", "planned", "resolved", false],
      ["Seewen", "unplanned", "resolved", true]
    ]);
    expect(records[0].detailText).toBe("Fläschackerstrasse");
    // Primeo files announced works under "done" before they happen.
    const upcoming = extractPrimeoRecords({ current: [], done: [
      { status: "PLANNED", title: "Hochwald ( Stelzenweg )", from: "2026-11-04T12:15:00.000Z", to: "2026-11-04T14:00:00.000Z" }
    ] }, T0).records[0];
    expect(upcoming.operatorState).toBe("scheduled");
  });

  it("uses operator uuids for Romande and SAK", () => {
    const romande = extractRomandeRecords([{
      uuid_perturbation: "01M6K5", genre: "panne", date_debut: "2026-11-04T12:30:00+01:00", date_fin: null, active: true,
      geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: { CAUSE: "Défaut câble" }, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [6.40876, 46.47069] }] } }] }
    }], T0).records[0];
    expect(romande).toMatchObject({ baseKey: "romande:01M6K5", kind: "unplanned", operatorState: "active", cause: "Défaut câble", latitude: 46.47069 });
    const sak = extractSakRecords([{
      id: "9bfce347", title: "Störung Gebiet Ebni in Wald AR", status: 2, category: 0,
      start_date: "2026-11-02T06:00:00.000+01:00", end_date: "2026-11-02T12:00:00.000+01:00",
      coordinates: { latitude: 47.418, longitude: 9.4956 }
    }], T0).records[0];
    expect(sak).toMatchObject({ baseKey: "sak:9bfce347", operatorState: "resolved", endIsActual: true, placeText: "Wald AR" });
  });

  it("cleans operator place wording", () => {
    expect(sakPlace("Stromunterbruch Jonschwil")).toBe("Jonschwil");
    expect(sakPlace("Netz Störung Stein AR (Schedlern, Mettlen, Grub)")).toBe("Stein AR");
    expect(splitPlaceDetail("Binningen (Höhenweg) ")).toEqual({ place: "Binningen", detail: "Höhenweg" });
  });

  it("drops district heating, water and gas notices", () => {
    expect(isNonElectricNotice("Unterbruch Wärmeversorgung FSG Saanen Gstaad. Instandsetzung am Wärmenetz")).toBe(true);
    expect(isNonElectricNotice("Inbetriebnahme Fernwärme WDL Lampenberg. Zeitraum: 02.10.2026 Art: geplant Sparte: Fernwärme")).toBe(true);
    expect(isNonElectricNotice("Stromunterbruch Lampenberg. Sparte: Strom")).toBe(false);
    expect(isNonElectricNotice("Geplanter Stromunterbruch wegen Arbeiten an der Wasserleitung")).toBe(false);
    expect(isNonElectricNotice("In einigen Teilen unseres Netzes kommt es zu Ausfällen der Strassen- und Quartierbeleuchtung.")).toBe(true);
    expect(isNonElectricNotice("Stromausfall in Aesch, auch die Strassenbeleuchtung ist betroffen")).toBe(false);
  });

  it("gives item adapters an identity that survives the status change", () => {
    const base: SourceObservationInput = {
      sourceRegistryId: 1, sourceKey: "ewl-luzern-stoerungen", sourceType: "html", operatorName: "ewl", observationHash: "x",
      canonicalStatus: "unplanned", eventType: "power_outage", title: "Stromausfall in Luzern", url: "https://ewl", locationText: "Luzern",
      areaText: null, startedAt: "2026-10-16T06:00:00.000Z", resolvedAt: null, observedAt: T0, publishedAt: null,
      evidenceExcerpt: "Wo Luzern Wann 16.10.2026 Was Strom In Arbeit", rawPayloadJson: null, extractorVersion: "v1", confidence: 0.9, independenceKey: null
    };
    const [active] = recordsFromObservations([base]);
    const [resolved] = recordsFromObservations([{ ...base, canonicalStatus: "resolved", title: "Behobener Stromausfall in Luzern", resolvedAt: "2026-10-16T08:30:00.000Z" }]);
    expect(resolved.baseKey).toBe(active.baseKey);
    expect(resolved).toMatchObject({ operatorState: "resolved", endIsActual: true });
  });
});

describe("incident derivation", () => {
  const record = (patch: Partial<StoredRecord>): StoredRecord => ({
    id: 1, source_registry_id: 1, base_key: "k", record_key: "k", kind: "unplanned", state: "ended", operator_state: "active",
    title: null, place_text: null, detail_text: null, municipality: "Worb", canton: "BE", latitude: 46.93, longitude: 7.56,
    reported_start_at: null, reported_end_at: null, end_is_actual: 0, cause: null, customers_affected: null,
    prev_absent_at: at(-15), first_seen_at: at(0), last_seen_at: at(45), seen_current: 1, first_missing_at: at(60),
    outage_event_id: null, quality_flags: "[]", ...patch
  });

  it("measures an unannounced outage as two polling windows", () => {
    expect(recordStart(record({}))).toEqual({ earliest: Date.parse(at(-15)), latest: Date.parse(at(0)), exact: false });
    expect(recordEnd(record({}))).toEqual({ earliest: Date.parse(at(45)), latest: Date.parse(at(60)), exact: false });
    const incident = deriveIncident([record({})], { id: 1, operator_name: "BKW", url: "https://outage.bkw.ch/" });
    expect(incident).toMatchObject({
      startedAt: null, startEarliestAt: at(-15), firstSeenAt: at(0),
      resolvedAt: null, resolutionEarliestAt: at(45), resolutionLatestAt: at(60), timeConfidence: "inferred", publishable: true
    });
    expect(incident.qualityFlags).toEqual(["end_window", "start_observed"]);
  });

  it("takes the announced end when a planned works item vanishes around it", () => {
    const incident = deriveIncident([record({
      kind: "planned", reported_start_at: at(0), reported_end_at: at(240), last_seen_at: at(225), first_missing_at: at(245)
    })], { id: 1, operator_name: "BKW", url: "https://outage.bkw.ch/" });
    expect(incident).toMatchObject({ startedAt: at(0), resolvedAt: at(240), timeConfidence: "reported" });
    expect(incident.summary).toContain("BKW kündigt einen geplanten Stromunterbruch in Worb an");
  });

  it("does not merge a recurrence weeks later or a trafo 10 km away", () => {
    const a = record({ id: 1 });
    const b = record({ id: 2, first_seen_at: at(30), last_seen_at: at(50), first_missing_at: at(65), latitude: 46.935 });
    const later = record({ id: 3, first_seen_at: at(60 * 24 * 20), last_seen_at: at(60 * 24 * 20 + 30), first_missing_at: at(60 * 24 * 20 + 45) });
    const far = record({ id: 4, latitude: 47.02, municipality: "Bern" });
    expect(groupRecords([a, b, later, far]).map((group) => group.map((item) => item.id))).toEqual([[1, 2], [4], [3]]);
  });
});

describe("operator ingest", () => {
  it("follows a BKW failure from first sighting to disappearance, then starts a new incident on recurrence", async () => {
    const db = migratedDatabase();
    lookups.length = 0;
    const failing = [trafo(10885, "FAILURE", 46.66672, 7.55522)];

    await poll(db, "bkw-outage", [], at(-15));
    const first = await poll(db, "bkw-outage", bkw(failing, at(0)), at(0));
    expect(first).toMatchObject({ recordsNew: 1, eventsCreated: 1 });
    await poll(db, "bkw-outage", bkw(failing, at(15)), at(15));
    await poll(db, "bkw-outage", bkw([], at(30)), at(30));

    let [event] = await events(db);
    expect(event).toMatchObject({
      status: "resolved", location_text: "Erlenbach im Simmental", canton: "BE", first_seen_at: at(0),
      start_earliest_at: at(-15), started_at_estimate: null,
      resolution_earliest_at: at(15), resolution_latest_at: at(30), time_confidence: "inferred", public_status: "public_verified"
    });
    // The trafo was geocoded exactly once although it was polled twice.
    expect(lookups).toEqual(["46.6667,7.5552"]);

    // Same trafo, three weeks later: a new episode and a new incident.
    const later = 60 * 24 * 21;
    await poll(db, "bkw-outage", bkw(failing, at(later)), at(later));
    const all = await events(db);
    expect(all).toHaveLength(2);
    expect(all[1].first_seen_at).toBe(at(later));
    [event] = all;
    expect(event.resolution_latest_at).toBe(at(30));

    const decision = await db.prepare("SELECT * FROM publication_decisions WHERE outage_event_id = ?").bind(event.id).first<Record<string, unknown>>();
    expect(decision).toMatchObject({ publishable: 1, trust: "official", primary_source_publisher: "BKW" });
    const pin = await db.prepare("SELECT * FROM event_public_locations WHERE outage_event_id = ?").bind(event.id).first<Record<string, unknown>>();
    expect(pin).toMatchObject({ label: "Erlenbach im Simmental (BE)", provider: "operator" });
  });

  it("joins trafos of one outage into one incident and estimates its duration publicly", async () => {
    const db = migratedDatabase();
    await poll(db, "bkw-outage", [], at(-15));
    await poll(db, "bkw-outage", bkw([trafo(1, "FAILURE", 46.66672, 7.55522)], at(0)), at(0));
    await poll(db, "bkw-outage", bkw([trafo(1, "FAILURE", 46.66672, 7.55522), trafo(2, "FAILURE", 46.67, 7.56)], at(15)), at(15));
    await poll(db, "bkw-outage", bkw([], at(75)), at(75));
    const all = await events(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ record_count: 2, resolution_earliest_at: at(15), resolution_latest_at: at(75) });

    const item = toPublicFeedItem(all[0], {
      publishable: true, trust: "official", reasons: [], summary: all[0].summary,
      primary_source: { publisher: "BKW", url: "https://outage.bkw.ch/", domain: "outage.bkw.ch" }
    }, [], Date.parse(at(200)));
    expect(item).toMatchObject({
      status: "resolved", started_at: null, active_since_at: at(0), active_since_is_minimum: true,
      start_earliest_at: at(-15), duration_is_estimate: true,
      // start window mid = -7.5 min, end window mid = 45 min
      duration_minutes: 53
    });
  });

  it("keeps a still-listed record cheap and does not rewrite the incident every poll", async () => {
    const db = migratedDatabase();
    const failing = [trafo(7, "FAILURE", 47.1582, 7.34149)];
    await poll(db, "bkw-outage", bkw(failing, at(0)), at(0));
    const before = (await events(db))[0].updated_at;
    const second = await poll(db, "bkw-outage", bkw(failing, at(15)), at(15));
    expect(second.eventsUpdated).toBe(0);
    expect((await events(db))[0].updated_at).toBe(before);
    const row = await db.prepare("SELECT last_seen_at, state FROM source_records").first<Record<string, unknown>>();
    expect(row).toEqual({ last_seen_at: at(15), state: "listed" });
  });

  it("closes a Primeo outage with the operator's actual end when it moves to the done list", async () => {
    const db = migratedDatabase();
    const progress = { status: "PROGRESS", title: "Balsthal ( Fläschackerstrasse )", from: "2026-11-04T09:50:00.000Z" };
    await poll(db, "primeo-netzstatus", extractPrimeoRecords({ current: [progress], done: [] }, at(0)).records, at(0));
    await poll(db, "primeo-netzstatus", extractPrimeoRecords({ current: [], done: [{ ...progress, status: "RESOLVED", to: "2026-11-04T10:20:29.000Z" }] }, at(30)).records, at(30));
    const [event] = await events(db);
    expect(event).toMatchObject({
      status: "resolved", location_text: "Balsthal", outage_nature: "unplanned",
      started_at_estimate: "2026-11-04T09:50:00.000Z", resolved_at_estimate: "2026-11-04T10:20:29.000Z", time_confidence: "reported"
    });
    expect(await db.prepare("SELECT count(*) AS n FROM source_records").first()).toEqual({ n: 1 });
  });

  it("does not end records when the listing failed or was incomplete", async () => {
    const db = migratedDatabase();
    await poll(db, "bkw-outage", bkw([trafo(7, "FAILURE", 47.1582, 7.34149)], at(0)), at(0));
    await poll(db, "bkw-outage", [], at(15), false);
    const failed: OperatorPoll = { polledAt: at(30), records: [], complete: false, transportStatus: "error", parserStatus: "error", error: "HTTP 503", payloadText: null, usedFirecrawl: false };
    await ingestOperatorPoll({ DB: db.asD1() }, await source(db, "bkw-outage"), failed, { geoBudget: { remaining: 0 } });
    expect(await db.prepare("SELECT state FROM source_records").first()).toEqual({ state: "listed" });
    const polls = (await db.prepare("SELECT ok, error FROM source_polls ORDER BY id").all()).results;
    expect(polls).toEqual([{ ok: 1, error: null }, { ok: 0, error: null }, { ok: 0, error: "HTTP 503" }]);
  });

  it("holds an incident back until its place is known", async () => {
    const db = migratedDatabase();
    await poll(db, "bkw-outage", bkw([trafo(9, "FAILURE", 46.5, 7.0)], at(0)), at(0));
    const [event] = await events(db);
    expect(event.public_status).toBe("hidden");
    const decision = await db.prepare("SELECT publishable, reasons_json FROM publication_decisions").first();
    expect(decision).toEqual({ publishable: 0, reasons_json: "[\"place_unresolved\"]" });
  });
});
