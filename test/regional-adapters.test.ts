import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSourceObservations, isBlockPage } from "../src/source-adapters";
import { recordsFromObservations } from "../src/operator-records";
import type { SourceObservationInput, SourceRegistryEntry } from "../src/types";
import iwbFixture from "./fixtures/operators/iwb.html?raw";
import kreuzlingenFixture from "./fixtures/operators/energie-kreuzlingen.html?raw";
import ckwFixture from "./fixtures/operators/ckw.html?raw";
import wwzFixture from "./fixtures/operators/wwz.html?raw";
import wwzClearFixture from "./fixtures/operators/wwz-clear.html?raw";
import repowerHistoryFixture from "./fixtures/operators/repower-history.html?raw";
import sesBlockedFixture from "./fixtures/operators/ses-blocked.html?raw";
import sesFixture from "./fixtures/operators/ses.html?raw";

// Fixtures are trimmed copies of the operator pages as fetched on 2026-11-05
// (WWZ: archived 2026-10-26, during the Rotkreuz outage).
const OBSERVED_AT = "2026-11-05T09:00:00.000Z";

function source(patch: Partial<SourceRegistryEntry>): SourceRegistryEntry {
  return {
    id: 1,
    source_key: "x",
    operator_name: "x",
    source_type: "html",
    source_category: "live_status",
    url: "https://example.ch/",
    area_text: "x",
    trust_level: "official",
    check_interval_minutes: 30,
    priority: 50,
    adapter_config_json: '{"language":"de","utility_filter":"electricity_only"}',
    firecrawl_enabled: 0,
    firecrawl_monitor_id: null,
    last_checked_at: null,
    last_success_at: null,
    last_error: null,
    health_status: "unknown",
    consecutive_failures: 0,
    enabled: 1,
    created_at: "2026-11-05 00:00:00",
    updated_at: "2026-11-05 00:00:00",
    ...patch
  } as SourceRegistryEntry;
}

async function run(body: string, sourceKey: string, observedAt = OBSERVED_AT) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
  return fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, source({ source_key: sourceKey }), observedAt);
}

function line(item: SourceObservationInput): string {
  return `${item.canonicalStatus}|${item.locationText}|${item.startedAt}|${item.resolvedAt}`;
}

afterEach(() => vi.unstubAllGlobals());

describe("IWB Unterbrüche", () => {
  it("keeps the electricity rows of the planned table, per municipality, with the street as detail", async () => {
    const result = await run(iwbFixture, "iwb-unterbrueche");
    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(14);
    expect(result.observations.every((item) => item.canonicalStatus === "planned")).toBe(true);
    expect(result.observations.filter((item) => item.locationText === "Bettingen")).toHaveLength(4);
    // "06.11.2026, 09:00 – 10:00" in Swiss winter time.
    expect(line(result.observations[0]!)).toBe("planned|Basel|2026-11-06T08:00:00.000Z|2026-11-06T09:00:00.000Z");
    // The water disturbance in the current table and the water/gas rows are dropped.
    expect(result.observations.some((item) => /wasser|gas|fernw/i.test(item.evidenceExcerpt))).toBe(false);
  });

  it("gives every street its own record, also when two works share place and start", async () => {
    const result = await run(iwbFixture, "iwb-unterbrueche");
    const records = recordsFromObservations(result.observations);
    expect(records).toHaveLength(14);
    expect(records[0]!.detailText).toBe("Schöllenenstrasse 14");
    expect(records[0]!.kind).toBe("planned");
    expect(records[0]!.operatorState).toBe("scheduled");
  });

  it("marks planned works whose window has passed as finished", async () => {
    const result = await run(iwbFixture, "iwb-unterbrueche", "2026-11-25T00:00:00.000Z");
    expect(result.observations.every((item) => item.canonicalStatus === "resolved")).toBe(true);
    expect(recordsFromObservations(result.observations).every((record) => record.kind === "planned")).toBe(true);
  });
});

describe("Energie Kreuzlingen", () => {
  it("reads electricity notices from the Störungen and Geplante Unterbrüche accordions", async () => {
    const result = await run(kreuzlingenFixture, "energie-kreuzlingen-stoerungen");
    expect(result.parserStatus).toBe("ready");
    const lines = result.observations.map(line);
    // "Ein technischer Defekt führte um ca. 16:00 … innerhalb von 45 min wiederhergestellt"
    expect(lines).toContain("resolved|Kreuzlingen|2026-08-18T14:00:00.000Z|2026-08-18T14:45:00.000Z");
    // "am Freitag, 30. Oktober 2026 13:30 bis 15:30 Uhr"
    expect(lines).toContain("resolved|Kreuzlingen|2026-10-30T12:30:00.000Z|2026-10-30T14:30:00.000Z");
    // Water, gas, building sites and the upstream voltage dip are not power interruptions here.
    expect(result.observations.some((item) => /wasser|rohrbruch|spannungseinbruch im vorgelagerten|werkleitung/i.test(item.title))).toBe(false);
    // Old notices without a time are skipped: their first sighting would pose as the start.
    expect(result.observations.every((item) => item.startedAt !== null)).toBe(true);
    expect(result.observations).toHaveLength(16);
  });

  it("keeps planned works as planned records with the street from the Ort line", async () => {
    const result = await run(kreuzlingenFixture, "energie-kreuzlingen-stoerungen");
    const records = recordsFromObservations(result.observations);
    const freiestrasse = records.find((record) => record.detailText === "Freiestrasse 2");
    expect(freiestrasse?.kind).toBe("planned");
    expect(freiestrasse?.reportedStartAt).toBe("2026-10-21T13:00:00.000Z");
    expect(records.filter((record) => record.kind === "unplanned")).toHaveLength(3);
  });

  it("ignores notices older than the archive window", async () => {
    const result = await run(kreuzlingenFixture, "energie-kreuzlingen-stoerungen", "2027-12-01T00:00:00.000Z");
    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });
});

describe("CKW Stromnetz box", () => {
  it("publishes the last disturbance next to the all-clear sentence", async () => {
    const result = await run(ckwFixture, "ckw-stoerungen");
    expect(result.parserStatus).toBe("ready");
    expect(result.observations.map(line)).toEqual([
      "resolved|Egolzwil, Schötz, Nebikon, Dagmersellen|2026-11-01T12:31:00.000Z|2026-11-01T12:40:00.000Z"
    ]);
    expect(result.observations[0]!.title).toBe("Behobener Stromausfall in Egolzwil, Schötz, Nebikon, Dagmersellen");
  });

  it("reports an active disturbance written in the box", async () => {
    const active = ckwFixture.replace(
      "<p>Momentan sind keine Netzstörungen bekannt.</p>",
      "<p>Aktuell Netzstörung in Gemeindeteilen von Sursee und Oberkirch. Unsere Teams sind unterwegs.</p>"
    );
    const result = await run(active, "ckw-stoerungen");
    expect(result.observations.map((item) => `${item.canonicalStatus}|${item.locationText}`)).toEqual([
      "unplanned|Sursee, Oberkirch",
      "resolved|Egolzwil, Schötz, Nebikon, Dagmersellen"
    ]);
  });

  it("flags a missing box as a schema change", async () => {
    const result = await run("<html><body><h1>Störungen</h1></body></html>", "ckw-stoerungen");
    expect(result.parserStatus).toBe("needs_adapter");
  });
});

describe("WWZ Aktuelle Störungen", () => {
  it("reads the outage block with area, start and end", async () => {
    const result = await run(wwzFixture, "wwz-stoerungen", "2026-10-26T07:19:24.000Z");
    expect(result.parserStatus).toBe("ready");
    expect(result.observations.map(line)).toEqual(["resolved|Risch|2026-10-23T19:20:00.000Z|2026-10-24T00:45:00.000Z"]);
  });

  it("drops telecom-only notices", async () => {
    const telecom = wwzFixture.replace(/<span class="text">Strom<\/span>/, '<span class="text">Telekom</span>').replace("Stromunterbruch ", "Telekomstörung ");
    const result = await run(telecom, "wwz-stoerungen", "2026-10-26T07:19:24.000Z");
    expect(result.observations).toHaveLength(0);
  });

  it("treats the quiet page as no current outage", async () => {
    const result = await run(wwzClearFixture, "wwz-stoerungen");
    expect(result.parserStatus).toBe("no_current_outage");
  });
});

describe("Repower Vergangene Störungen", () => {
  it("turns table rows inside the archive window into finished outages with places", async () => {
    const result = await run(repowerHistoryFixture, "repower-vergangene-stoerungen");
    expect(result.parserStatus).toBe("ready");
    expect(result.observations.map(line)).toEqual([
      // "15:45-00:31" runs past midnight.
      "resolved|Trun, Schlans Vitg, Ruschein|2026-07-31T13:45:00.000Z|2026-07-31T22:31:00.000Z",
      "resolved|Sevgein, Castrisch|2026-07-31T13:45:00.000Z|2026-07-31T14:30:00.000Z",
      // "teil Morissen, teil Degen, EW Lumbrein"
      "resolved|Vella, Vignogn, Morissen, Degen, Lumbrein|2026-07-31T13:27:00.000Z|2026-07-31T14:51:00.000Z",
      "resolved|St. Martin, Tersnaus, Suraua, Riein, Pitasch, Duvin, Cumbel, Sevgein, Castrisch, Ilanz, Degen|2026-06-28T01:08:00.000Z|2026-06-28T06:57:00.000Z"
    ]);
    expect(recordsFromObservations(result.observations).every((record) => record.kind === "unplanned" && record.endIsActual)).toBe(true);
  });

  it("binds the times of a two-day row to its first day", async () => {
    const result = await run(repowerHistoryFixture, "repower-vergangene-stoerungen", "2026-04-01T00:00:00.000Z");
    expect(result.observations.find((item) => item.locationText?.startsWith("Conters"))?.startedAt).toBe("2026-03-14T22:00:00.000Z");
  });
});

describe("blocked sources", () => {
  it("reports SES's geo-block page as a transport error, not a markup change", async () => {
    const result = await run(sesBlockedFixture, "ses-homepage");
    expect(result.transportStatus).toBe("error");
    expect(result.parserStatus).toBe("error");
    expect(result.error).toMatch(/^blocked_by_operator: Accesso bloccato/);
  });

  it("does not mistake a real operator page for a block page", () => {
    expect(isBlockPage(sesFixture)).toBe(false);
    expect(isBlockPage(ckwFixture)).toBe(false);
  });
});
