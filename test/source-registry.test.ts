import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreEvent, classifySource } from "../src/intelligence";
import { fetchSourceObservations, makeSourceObservationFromText } from "../src/source-adapters";
import { assessSourceObservation, observationToClassification } from "../src/source-quality";
import type { OutageEvent, OutageSource, SourceObservation, SourceRegistryEntry } from "../src/types";
import bkwFixture from "./fixtures/operators/bkw.json?raw";
import bkwTrafoFixture from "./fixtures/operators/bkw-trafo.json?raw";
import ewzFixture from "./fixtures/operators/ewz.html?raw";
import ewzNoCurrentFixture from "./fixtures/operators/ewz-no-current.html?raw";
import ewlFixture from "./fixtures/operators/ewl.html?raw";
import ewlEmptyFixture from "./fixtures/operators/ewl-empty.html?raw";
import primeoFixture from "./fixtures/operators/primeo.json?raw";
import romandeFixture from "./fixtures/operators/romande-energie.json?raw";
import sakFixture from "./fixtures/operators/sak.json?raw";
import alertswissFixture from "./fixtures/operators/alertswiss.json?raw";
import repowerWarningsFixture from "./fixtures/operators/repower-warnings.json?raw";
import repowerClearFixture from "./fixtures/operators/repower-clear.json?raw";
import sesFixture from "./fixtures/operators/ses.html?raw";
import tbFlawilFixture from "./fixtures/operators/tb-flawil.html?raw";
import ailFixture from "./fixtures/operators/ail.html?raw";
import aimMendrisioFixture from "./fixtures/operators/aim-mendrisio.html?raw";
import ageChiassoFixture from "./fixtures/operators/age-chiasso.json?raw";
import ewdDavosClearFixture from "./fixtures/operators/ewd-davos-clear.html?raw";
import thurplusFixture from "./fixtures/operators/thurplus.html?raw";
import thurplusClearFixture from "./fixtures/operators/thurplus-clear.html?raw";

function geoIdentifyBody(municipality: string, canton = "BE"): string {
  return JSON.stringify({
    results: [
      {
        attributes: {
          gemname: municipality,
          label: municipality,
          is_current_jahr: true,
          jahr: 2024,
          kanton: canton
        }
      }
    ]
  });
}

function stubOperatorFetch(operatorBody: string, municipalityForCoords: (lat: number, lon: number) => string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("geo.admin.ch") && url.includes("identify")) {
        const geometry = new URL(url).searchParams.get("geometry") ?? "";
        const [lon, lat] = geometry.split(",").map(Number);
        return new Response(geoIdentifyBody(municipalityForCoords(lat, lon)), { status: 200 });
      }
      return new Response(operatorBody, { status: 200 });
    })
  );
}

function registry(patch: Partial<SourceRegistryEntry> = {}): SourceRegistryEntry {
  return {
    id: 1,
    source_key: "ewz-stoerungen",
    operator_name: "ewz",
    source_type: "html",
    source_category: "live_status",
    url: "https://www.ewz.ch/de/services/stoerungen.html",
    area_text: "Stadt Zürich und ewz Versorgungsgebiet",
    trust_level: "official",
    check_interval_minutes: 15,
    priority: 90,
    adapter_config_json: '{"no_outage_terms":["keine störungsmeldungen"]}',
    firecrawl_enabled: 1,
    firecrawl_monitor_id: null,
    last_checked_at: null,
    last_success_at: null,
    last_error: null,
    health_status: "unknown",
    consecutive_failures: 0,
    enabled: 1,
    created_at: "2026-07-10 00:00:00",
    updated_at: "2026-07-10 00:00:00",
    ...patch
  };
}

function stored(input: Awaited<ReturnType<typeof makeSourceObservationFromText>>, id = 1): SourceObservation {
  return {
    id,
    source_registry_id: input.sourceRegistryId,
    source_key: input.sourceKey,
    source_type: input.sourceType,
    operator_name: input.operatorName,
    observation_hash: input.observationHash,
    canonical_status: input.canonicalStatus,
    event_type: input.eventType,
    title: input.title,
    url: input.url,
    location_text: input.locationText,
    area_text: input.areaText,
    started_at: input.startedAt,
    resolved_at: input.resolvedAt,
    observed_at: input.observedAt,
    published_at: input.publishedAt,
    evidence_excerpt: input.evidenceExcerpt,
    raw_payload_json: input.rawPayloadJson,
    extractor_version: input.extractorVersion,
    confidence: input.confidence,
    independence_key: input.independenceKey,
    alert_item_id: null,
    outage_event_id: null,
    created_at: "2026-07-10 00:00:00"
  };
}

function event(patch: Partial<OutageEvent> = {}): OutageEvent {
  return {
    id: 1,
    title: "Möglicher Stromausfall / Netzunterbruch: Zürich",
    status: "needs_review",
    event_type: "power_outage",
    location_text: "Zürich",
    normalized_location: "zurich",
    canton: null,
    country: "CH",
    first_seen_at: "2026-07-10T08:00:00.000Z",
    last_seen_at: "2026-07-10T08:30:00.000Z",
    started_at_estimate: null,
    resolved_at_estimate: null,
    summary: "Stromausfall in Zürich.",
    reason: "Operator observation.",
    confidence: 0.92,
    source_count: 1,
    primary_source_url: "https://www.ewz.ch/de/services/stoerungen.html",
    primary_source_title: "ewz: Störung",
    email_sent: 0,
    email_sent_at: null,
    update_email_sent_at: null,
    merged_into_event_id: null,
    admin_note: null,
    outage_nature: "unknown",
    cause_category: "unknown",
    cause_text: null,
    research_status: "not_started",
    research_started_at: null,
    research_finished_at: null,
    research_summary_de: null,
    fact_confidence: null,
    event_score: null,
    evidence_level: null,
    fact_sheet_json: null,
    fact_sheet_updated_at: null,
    auto_research_started_at: null,
    mail_decision_reason: null,
    public_status: "hidden",
    verification_level: "auto_analyzed",
    location_granularity: "municipality",
    event_quality_state: "candidate_only",
    created_at: "2026-07-10 08:00:00",
    updated_at: "2026-07-10 08:00:00",
    ...patch
  };
}

function source(patch: Partial<OutageSource> = {}): OutageSource {
  const intel = classifySource({
    url: patch.source_url ?? "https://www.ewz.ch/de/services/stoerungen.html",
    title: patch.source_title ?? "ewz: Störung",
    sourceName: patch.source_name ?? "ewz"
  });
  return {
    id: 1,
    outage_event_id: 1,
    alert_item_id: 1,
    source_url: "https://www.ewz.ch/de/services/stoerungen.html",
    source_title: "ewz: Störung",
    source_name: "ewz",
    published_at: "2026-07-10T08:00:00.000Z",
    relation_score: 100,
    is_primary: 1,
    created_at: "2026-07-10 08:00:00",
    source_kind: intel.source_kind,
    source_weight: intel.source_weight,
    is_official: intel.is_official,
    independence_key: intel.independence_key,
    ...patch
  };
}

describe("source registry observations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies real operator outages as official publishable candidates", async () => {
    const observation = stored(
      await makeSourceObservationFromText(registry(), {
        title: "Stromausfall in Zürich Höngg",
        text: "Aktuelle Störung aufgrund technischer Ursachen. Betroffen sind Höngg und Wipkingen.",
        locationText: "Zürich Höngg",
        observedAt: "2026-07-10T08:00:00.000Z"
      })
    );

    const assessment = assessSourceObservation(observation);
    expect(observation.canonical_status).toBe("unplanned");
    expect(assessment.publishable).toBe(true);
    expect(assessment.facts.every((fact) => fact.extractor_version === "source-registry/v1")).toBe(true);
    expect(observationToClassification(observation).country).toBe("CH");
  });

  it("separates planned, historical, resolved and irrelevant observations", async () => {
    const planned = stored(await makeSourceObservationFromText(registry(), {
      title: "Geplanter Stromunterbruch in Diegten",
      text: "Wegen Wartungsarbeiten kommt es zu einem geplanten Stromunterbruch in Diegten.",
      locationText: "Diegten",
      observedAt: "2026-07-10T08:00:00.000Z"
    }));
    const historical = stored(await makeSourceObservationFromText(registry(), {
      title: "Rückblick auf Stromausfall 2025",
      text: "Historischer Rückblick auf einen Stromausfall im Jahr 2025.",
      locationText: "Valzeina",
      observedAt: "2026-07-10T08:00:00.000Z"
    }));
    const resolved = stored(await makeSourceObservationFromText(registry(), {
      title: "Störung in Belp behoben",
      text: "Der Stromausfall in Belp ist behoben. Die Versorgung ist wiederhergestellt.",
      locationText: "Belp",
      observedAt: "2026-07-10T08:00:00.000Z"
    }));
    const irrelevant = stored(await makeSourceObservationFromText(registry(), {
      title: "ewz: keine Störungsmeldungen",
      text: "Keine Störungsmeldungen vorhanden.",
      locationText: null,
      observedAt: "2026-07-10T08:00:00.000Z"
    }));

    expect(planned.canonical_status).toBe("planned");
    expect(assessSourceObservation(planned).event_type).toBe("planned_outage");
    expect(historical.canonical_status).toBe("historical");
    expect(assessSourceObservation(historical).publishable).toBe(false);
    expect(resolved.canonical_status).toBe("resolved");
    expect(resolved.resolved_at).toBeNull();
    expect(assessSourceObservation(resolved).facts.map((fact) => fact.fact_type)).not.toContain("end_time");
    expect(irrelevant.canonical_status).toBe("irrelevant");
    expect(assessSourceObservation(irrelevant).publishable).toBe(false);
    expect(assessSourceObservation(irrelevant).facts.map((fact) => fact.fact_type)).not.toContain("end_time");
  });

  it("keeps duplicate observations stable while updates remain mergeable", async () => {
    const first = await makeSourceObservationFromText(registry(), {
      title: "Stromausfall in Zürich Höngg",
      text: "Aktuelle Störung. Betroffen sind Höngg und Wipkingen.",
      locationText: "Zürich Höngg",
      observedAt: "2026-07-10T08:00:00.000Z"
    });
    const duplicate = await makeSourceObservationFromText(registry(), {
      title: "Stromausfall in Zürich Höngg",
      text: "Aktuelle Störung. Betroffen sind Höngg und Wipkingen.",
      locationText: "Zürich Höngg",
      observedAt: "2026-07-10T09:00:00.000Z"
    });
    const update = await makeSourceObservationFromText(registry(), {
      title: "Update Stromausfall in Zürich Höngg",
      text: "Aktuelle Störung in Zürich Höngg. Weitere Strassen sind betroffen, die Behebung läuft weiterhin.",
      locationText: "Zürich Höngg",
      observedAt: "2026-07-10T10:00:00.000Z"
    });

    expect(duplicate.observationHash).toBe(first.observationHash);
    expect(update.observationHash).not.toBe(first.observationHash);
    expect(update.canonicalStatus).toBe("unplanned");
    expect(update.locationText).toBe(first.locationText);
  });

  it("distinguishes no-current-outage pages from parser failures and unreachable sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html><body>Aktuell Stromausfall Stadt Zürich. Aktuell sind keine Störungen bekannt.<article class='stoerung-card'>Archiv: Stromausfall in Bern.</article></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" }
          })
        )
        .mockResolvedValueOnce(new Response("<html><script>window.app={}</script></html>", { status: 200 }))
        .mockResolvedValueOnce(new Response("Service unavailable", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(`<html><body>${"Navigation ".repeat(300)}<div>Keine Einträge vorhanden</div></body></html>`, { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response('<html><body><div data-details-no-warnings-text="Aktuell liegen keine St&#xF6;rungsmeldungen vor"></div></body></html>', { status: 200 })
        )
    );

    const noOutage = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, registry({ source_key: "generic-no-outage" }), "2026-07-10T08:00:00.000Z");
    const parserFailure = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, registry({ source_key: "spa-shell" }), "2026-07-10T08:00:00.000Z");
    const unreachable = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, registry({ source_key: "http-503" }), "2026-07-10T08:00:00.000Z");
    const deepNoOutage = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, registry({ source_key: "deep-no-outage" }), "2026-07-10T08:00:00.000Z");
    const attrNoOutage = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, registry({ source_key: "attr-no-outage" }), "2026-07-10T08:00:00.000Z");

    expect(noOutage.error).toBeNull();
    expect(noOutage.transportStatus).toBe("ok");
    expect(noOutage.parserStatus).toBe("no_current_outage");
    expect(noOutage.observations[0].canonicalStatus).toBe("irrelevant");
    expect(noOutage.observations[0].locationText).toBeNull();
    expect(parserFailure.error).toContain("parser_empty_content");
    expect(parserFailure.parserStatus).toBe("error");
    expect(parserFailure.observations).toHaveLength(0);
    expect(unreachable.error).toBe("HTTP 503");
    expect(unreachable.transportStatus).toBe("error");
    expect(unreachable.observations).toHaveLength(0);
    expect(deepNoOutage.observations[0].canonicalStatus).toBe("irrelevant");
    expect(attrNoOutage.observations[0].canonicalStatus).toBe("irrelevant");
  });

  it("blocks generic positive HTML pages even when legacy config allowed whole-page positives", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("<html><body>Archiv und Navigation. Stromausfall, geplant, behoben.</body></html>", { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response("<html><body>Aktueller Stromausfall in Zürich Höngg. Betroffen sind Höngg und Wipkingen.</body></html>", {
            status: 200
          })
        )
    );

    const blocked = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, registry({ source_key: "generic-positive" }), "2026-07-10T08:00:00.000Z");
    const allowed = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({ source_key: "generic-positive-legacy", adapter_config_json: '{"allow_generic_positive":true}' }),
      "2026-07-10T08:00:00.000Z"
    );

    expect(blocked.error).toContain("parser_needs_adapter");
    expect(blocked.observations).toHaveLength(0);
    expect(blocked.parserStatus).toBe("needs_adapter");
    expect(allowed.error).toContain("parser_needs_adapter");
    expect(allowed.observations).toHaveLength(0);
  });

  it.each([
    ["bkw-outage", "BKW", bkwFixture, "https://api-outage.bkw.ch/api/services/supplyZone/state", "unplanned", "3011 Bern"],
    ["sak-netzstatus", "SAK", sakFixture, "https://netzstatus.sak.ch/api/v1/failures", "planned", "Herrentoebeli"],
    ["primeo-netzstatus", "Primeo Energie", primeoFixture, "https://www.primeo-energie.ch/magnolia/.rest/primeo/v1/gridStatus.json?limit=20", "unplanned", "Liestal"]
  ])("parses the verified %s operator API contract", async (sourceKey, operatorName, payload, apiUrl, status, location) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, { status: 200 })));
    const source = registry({
      source_key: sourceKey,
      operator_name: operatorName,
      adapter_config_json: JSON.stringify({ api_url: apiUrl })
    });
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      source,
      "2026-07-15T09:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.transportStatus).toBe("ok");
    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(sourceKey === "primeo-netzstatus" ? 2 : 1);
    expect(result.observations[0].canonicalStatus).toBe(status);
    expect(result.observations[0].locationText).toContain(location);
    if (sourceKey === "primeo-netzstatus") {
      expect(result.observations[1].canonicalStatus).toBe("resolved");
      expect(result.observations[1].resolvedAt).toBe("2026-07-14T00:30:00.000Z");
    }
  });

  it("keeps a recent SAK resolution and uses its official end time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: "rossfall",
      title: "Stromunterbruch Rossfall - Schwägalp",
      description: "Die Stromversorgung wurde wiederhergestellt.",
      status: 1,
      category: 0,
      publish_date: "2026-07-29T14:12:00.000+02:00",
      start_date: "2026-07-29T13:52:00.000+02:00",
      end_date: "2026-07-29T20:17:00.000+02:00"
    }]), { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "sak-netzstatus",
        operator_name: "SAK",
        adapter_config_json: '{"api_url":"https://netzstatus.sak.ch/api/v1/failures"}'
      }),
      "2026-07-30T09:00:00.000Z"
    );

    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].canonicalStatus).toBe("resolved");
    expect(result.observations[0].startedAt).toBe("2026-07-29T11:52:00.000Z");
    expect(result.observations[0].resolvedAt).toBe("2026-07-29T18:17:00.000Z");
    const assessment = assessSourceObservation(stored(result.observations[0]));
    expect(assessment.status).toBe("resolved");
    expect(assessment.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact_type: "end_time", value_text: "2026-07-29T18:17:00.000Z" })
    ]));
  });

  it("does not re-import old SAK history as new resolved incidents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: "old",
      title: "Stromunterbruch Alter Fall",
      description: "Die Störung wurde behoben.",
      status: 2,
      category: 0,
      publish_date: "2026-05-01T10:00:00.000+02:00",
      start_date: "2026-05-01T10:00:00.000+02:00",
      end_date: "2026-05-01T11:00:00.000+02:00"
    }]), { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "sak-netzstatus",
        operator_name: "SAK",
        adapter_config_json: '{"api_url":"https://netzstatus.sak.ch/api/v1/failures"}'
      }),
      "2026-07-30T09:00:00.000Z"
    );

    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("parses Romande Energie geometry and resolves a municipality from coordinates at intake", async () => {
    stubOperatorFetch(romandeFixture, () => "Montricher");
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "romande-energie-pannes",
        operator_name: "Romande Energie",
        adapter_config_json: '{"api_url":"https://www.romande-energie.ch/re_infopannes/data"}'
      }),
      "2026-07-15T09:00:00.000Z"
    );

    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].canonicalStatus).toBe("planned");
    expect(result.observations[0].locationText).toBe("Montricher");
    const observation = stored(result.observations[0]);
    const assessment = assessSourceObservation(observation);
    expect(assessment.publishable).toBe(true);
    expect(assessment.location_text).toBe("Montricher");
    expect(assessment.facts.some((candidate) => candidate.fact_type === "location")).toBe(true);
    expect(observationToClassification(observation).location_text).toBe("Montricher");
  });

  it("ingests the BKW transformer incident feed and aggregates nearby failures by municipality", async () => {
    stubOperatorFetch(bkwTrafoFixture, (lat) => {
      if (lat < 46.8) return "Höfen";
      if (lat < 46.95) return "Köniz";
      return "Lützelflüh";
    });
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "bkw-outage",
        operator_name: "BKW",
        adapter_config_json: '{"api_url":"https://api-outage.bkw.ch/api/services/trafo/state?supplier=bkw"}'
      }),
      "2026-08-14T08:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    const locations = result.observations.map((observation) => `${observation.canonicalStatus}:${observation.locationText}`).sort();
    expect(locations).toEqual(["planned:Köniz", "unplanned:Höfen", "unplanned:Lützelflüh"]);
    expect(result.observations.every((observation) => !/Bracher|Schnetzenschachen|Höfen-Dorf|Föhrenweg/i.test(observation.locationText ?? ""))).toBe(true);
    const planned = result.observations.find((observation) => observation.canonicalStatus === "planned");
    expect(planned?.startedAt).toBe("2026-08-14T06:00:00.000Z");
    expect(planned?.resolvedAt).toBe("2026-08-14T09:00:00.000Z");
    expect(assessSourceObservation(stored(result.observations[0])).publishable).toBe(true);
  });

  it("keeps known BKW incidents when a single row uses an unknown enum", async () => {
    stubOperatorFetch(
      JSON.stringify([
        {
          trafoNumber: 1,
          trafoName: "Kirchplatz 4",
          supplyState: "FAILURE",
          latitude: 47.00787,
          longitude: 7.68643,
          affectedCustomers: 0
        },
        {
          trafoNumber: 2,
          trafoName: "Unknown",
          supplyState: "MAINTENANCE",
          latitude: 47.00787,
          longitude: 7.68643,
          affectedCustomers: 0
        }
      ]),
      () => "Lützelflüh"
    );
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "bkw-outage",
        adapter_config_json: '{"api_url":"https://api-outage.bkw.ch/api/services/trafo/state?supplier=bkw"}'
      }),
      "2026-08-14T08:00:00.000Z"
    );

    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].locationText).toBe("Lützelflüh");
  });

  it("treats an empty BKW transformer list as no current outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "bkw-outage",
        adapter_config_json: '{"api_url":"https://api-outage.bkw.ch/api/services/trafo/state?supplier=bkw"}'
      }),
      "2026-08-14T08:00:00.000Z"
    );

    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("parses the live ewz incident component and recognizes its real no-current message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(ewzFixture, { status: 200 }))
        .mockResolvedValueOnce(new Response(ewzNoCurrentFixture, { status: 200 }))
    );
    const source = registry({ source_key: "ewz-stoerungen", operator_name: "ewz" });

    const positive = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, source, "2026-07-15T09:00:00.000Z");
    const negative = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, source, "2026-07-15T09:00:00.000Z");

    expect(positive.parserStatus).toBe("ready");
    expect(positive.observations).toHaveLength(1);
    expect(positive.observations[0].locationText).toBe("Zürich");
    expect(negative.parserStatus).toBe("no_current_outage");
    expect(negative.observations).toHaveLength(0);
  });

  it("fails closed when a verified operator API changes schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"unexpected":true}', { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "bkw-outage",
        adapter_config_json: '{"api_url":"https://api-outage.bkw.ch/api/services/supplyZone/state"}'
      }),
      "2026-07-15T09:00:00.000Z"
    );

    expect(result.parserStatus).toBe("needs_adapter");
    expect(result.observations).toHaveLength(0);
    expect(result.error).toContain("schema_changed");
  });

  it.each([
    ["bkw-outage", "https://api-outage.bkw.ch/api/services/supplyZone/state", '[{"supplyState":"MAINTENANCE","city":"Bern"}]'],
    ["sak-netzstatus", "https://netzstatus.sak.ch/api/v1/failures", '[{"title":"Netzstörung Bern","status":9,"category":0,"start_date":"2026-07-15T08:00:00Z"}]'],
    ["romande-energie-pannes", "https://www.romande-energie.ch/re_infopannes/data", '[{"genre":"information","date_debut":"2026-07-15T08:00:00Z","geojson":{"type":"FeatureCollection","features":[]}}]'],
    ["primeo-netzstatus", "https://www.primeo-energie.ch/magnolia/.rest/primeo/v1/gridStatus.json?limit=20", '{"current":[{"status":"ACKNOWLEDGED","title":"Liestal"}],"done":[]}'],
    ["alertswiss", "https://www.alert.swiss/content/alertswiss-internet/de/home/_jcr_content/polyalert.alertswiss_alerts.actual.json", '{"heartbeatAgeInMillis":1}'],
    ["repower-stoerungen", "https://www.repower.com/umbraco/api/Stoerung/GetWarnings?culture=de", '[{"title":"Surselva","active":true}]']
  ])("fails closed on unknown %s operator enums", async (sourceKey, apiUrl, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(payload, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({ source_key: sourceKey, adapter_config_json: JSON.stringify({ api_url: apiUrl }) }),
      "2026-07-15T09:00:00.000Z"
    );

    expect(result.parserStatus).toBe("needs_adapter");
    expect(result.observations).toHaveLength(0);
    expect(result.error).toContain("schema_changed");
  });

  it("keeps only electricity-related Alertswiss alerts and does not copy full alert bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(alertswissFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "alertswiss",
        operator_name: "Alertswiss",
        source_category: "discovery_only",
        url: "https://www.alert.swiss/",
        adapter_config_json: JSON.stringify({
          api_url: "https://www.alert.swiss/content/alertswiss-internet/de/home/_jcr_content/polyalert.alertswiss_alerts.actual.json"
        })
      }),
      "2026-08-18T09:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((item) => item.canonicalStatus).sort()).toEqual(["resolved", "unplanned"]);
    expect(result.observations.every((item) => item.locationText === "Chur")).toBe(true);
    expect(result.observations.some((item) => item.title.includes("Stromausfall in Teilen der Stadt Chur"))).toBe(true);
    expect(result.observations.every((item) => item.evidenceExcerpt.includes("Quelle: www.alertswiss.ch"))).toBe(true);
    expect(result.observations.some((item) => item.evidenceExcerpt.includes("Volltext"))).toBe(false);
    expect(result.observations.some((item) => item.title.includes("Feuerverbot"))).toBe(false);
    expect(result.observations.some((item) => item.title.includes("Test:"))).toBe(false);
  });

  it("treats an Alertswiss feed without electricity alerts as no current outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      heartbeatAgeInMillis: 800,
      renderTime: "18.08.2026 11:18:18.291 +0200",
      alerts: [{
        identifier: "FIRE-2",
        title: { title: "Feuerverbot" },
        description: { description: "Waldbrandgefahr." },
        event: "Feuerverbot",
        allClear: false,
        testAlert: false,
        technicalTestAlert: false,
        areas: [{ description: { description: "Kanton Wallis" } }]
      }]
    }), { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "alertswiss",
        adapter_config_json: '{"api_url":"https://www.alert.swiss/content/alertswiss-internet/de/home/_jcr_content/polyalert.alertswiss_alerts.actual.json"}'
      }),
      "2026-08-18T09:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("does not treat a fire ban as a power outage because electric barbecues are mentioned", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      heartbeatAgeInMillis: 3536,
      renderTime: "18.08.2026 11:18:18.291 +0200",
      alerts: [{
        identifier: "POA-1357813895-3",
        title: { title: "Risque d'incendie maximal : rappel de l'interdiction des feux en plein air" },
        description: { description: "Dans l'espace privé, seuls les barbecues à gaz et électriques sont autorisés." },
        event: "Interdiction de faire du feu",
        allClear: false,
        testAlert: false,
        technicalTestAlert: false,
        publisherName: "Canton de Genève",
        areas: [{ description: { description: "Genève" } }]
      }]
    }), { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "alertswiss",
        adapter_config_json: '{"api_url":"https://www.alert.swiss/content/alertswiss-internet/de/home/_jcr_content/polyalert.alertswiss_alerts.actual.json"}'
      }),
      "2026-08-18T09:30:47.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("parses ewl disturbance rows for electricity and skips water", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ewlFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "ewl-luzern-stoerungen",
        operator_name: "ewl Luzern",
        url: "https://www.ewl-luzern.ch/kundencenter/stoerungen",
        area_text: "Stadt Luzern und ewl Versorgungsgebiet"
      }),
      "2026-08-19T08:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    expect(result.observations.map((item) => `${item.canonicalStatus}:${item.locationText}`).sort()).toEqual([
      "planned:Horw",
      "resolved:Kriens",
      "resolved:Luzern"
    ]);
    expect(result.observations.every((item) => !/Wasser|Geissensteinring/i.test(item.title + item.evidenceExcerpt))).toBe(true);
    expect(result.observations.find((item) => item.locationText === "Kriens")?.startedAt).toBe("2026-08-17T05:20:00.000Z");
  });

  it("treats an empty ewl disturbance table as no current outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ewlEmptyFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({ source_key: "ewl-luzern-stoerungen", operator_name: "ewl Luzern" }),
      "2026-08-19T08:00:00.000Z"
    );

    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("reads Repower region warnings from the map API instead of the SPA HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(repowerWarningsFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "repower-stoerungen",
        operator_name: "Repower",
        adapter_config_json: '{"api_url":"https://www.repower.com/umbraco/api/Stoerung/GetWarnings?culture=de"}'
      }),
      "2026-07-31T14:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].canonicalStatus).toBe("unplanned");
    expect(result.observations[0].locationText).toBe("Ilanz");
    expect(result.observations[0].title).toMatch(/Surselva|Ilanz/);
  });

  it("treats Repower regions without a control-panel warning as no current outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(repowerClearFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "repower-stoerungen",
        adapter_config_json: '{"api_url":"https://www.repower.com/umbraco/api/Stoerung/GetWarnings?culture=de"}'
      }),
      "2026-08-19T08:00:00.000Z"
    );

    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("parses SES Sopracenerina planned interruptions and ignores a quiet live grid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sesFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "ses-homepage",
        operator_name: "SES",
        url: "https://www.ses.ch/",
        area_text: "SES Sopracenerina Netzgebiet im Locarnese und nördlichen Tessin",
        adapter_config_json: '{"language":"it"}'
      }),
      "2026-08-13T10:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    expect(result.observations.map((item) => `${item.canonicalStatus}:${item.locationText}`).sort()).toEqual([
      "planned:Gordola",
      "planned:Quartino"
    ]);
  });

  it("parses TB Flawil electricity interruptions and skips heating, telecom and voltage dips", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(tbFlawilFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "tb-flawil-betriebsinfo",
        operator_name: "TB Flawil",
        url: "https://www.tbflawil.ch/betriebsinfo",
        area_text: "Flawil",
        adapter_config_json: '{"language":"de","status_mode":"local_status"}'
      }),
      "2026-11-04T12:00:00.000Z"
    );

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    const titles = result.observations.map((item) => item.title);
    expect(titles.some((title) => /Botsberg/.test(title))).toBe(true);
    expect(titles.some((title) => /thurcom|Fernw|Spannungseinbruch/i.test(title))).toBe(false);
    const botsberg = result.observations.find((item) => /Botsberg/.test(item.title))!;
    expect(botsberg.canonicalStatus).toBe("resolved");
    expect(botsberg.locationText).toBe("Flawil");
    expect(botsberg.startedAt).toBe("2026-09-15T09:06:00.000Z");
    expect(botsberg.resolvedAt).toBe("2026-09-15T09:20:00.000Z");
  });

  it("parses AIL service notices and keeps only the electricity sector", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ailFixture, { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "ail-homepage",
        operator_name: "AIL",
        url: "https://www.ail.ch/privati.html",
        area_text: "Lugano und AIL Versorgungsgebiet",
        adapter_config_json: '{"language":"it","status_mode":"ail_comunicati"}'
      }),
      "2026-11-04T12:00:00.000Z"
    );
    const electricity = (ailFixture.match(/Elettricit/g) ?? []).length;
    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(electricity);
    expect(result.observations.every((item) => /^Interruzione di corrente pianificata a /.test(item.title))).toBe(true);
    for (const item of result.observations) {
      expect(item.startedAt).toBeTruthy();
      const ended = item.resolvedAt ? Date.parse(item.resolvedAt) <= Date.parse("2026-11-04T12:00:00.000Z") : false;
      expect(item.canonicalStatus).toBe(ended ? "resolved" : "planned");
    }
  });

  function stubBody(body: string) {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(body, { status: 200 })));
  }

  const aimSource = () => registry({
    source_key: "aim-mendrisio-interruzioni",
    operator_name: "AIM Mendrisio",
    url: "https://aim.mendrisio.ch/web/news-e-approfondimenti/interruzioni-programmate.html",
    area_text: "Mendrisio und AIM Versorgungsgebiet im Mendrisiotto",
    adapter_config_json: '{"language":"it","status_mode":"aim_interruzioni_programmate"}'
  });

  it("parses AIM Mendrisio planned power interruptions and skips road and pipe works", async () => {
    stubBody(aimMendrisioFixture);
    const result = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, aimSource(), "2026-11-04T12:00:00.000Z");

    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("ready");
    // Seven cards on the live page; only "Avviso interruzione erogazione energia elettrica" is electricity.
    expect(result.observations).toHaveLength(1);
    const [besazio] = result.observations;
    expect(besazio!.title).toBe("Interruzione di corrente pianificata a Besazio");
    expect(besazio!.canonicalStatus).toBe("planned");
    expect(besazio!.locationText).toBe("Besazio");
    // "il 05.11.2026 dalle ore 14.00 alle ore 15.30" in Swiss winter time.
    expect(besazio!.startedAt).toBe("2026-11-05T13:00:00.000Z");
    expect(besazio!.resolvedAt).toBe("2026-11-05T14:30:00.000Z");
    expect(besazio!.evidenceExcerpt).toContain("Via S. Antonio e Via Besazio");

    const after = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, aimSource(), "2026-11-05T15:00:00.000Z");
    expect(after.observations[0]!.canonicalStatus).toBe("resolved");

    const stale = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, aimSource(), "2026-11-20T12:00:00.000Z");
    expect(stale.parserStatus).toBe("no_current_outage");
    expect(stale.observations).toHaveLength(0);
  });

  it("flags a changed AIM Mendrisio page instead of guessing", async () => {
    stubBody("<html><body><h1>Interruzioni programmate</h1><p>Stromausfall</p></body></html>");
    const result = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, aimSource(), "2026-11-04T12:00:00.000Z");
    expect(result.parserStatus).toBe("needs_adapter");
    expect(result.error).toMatch(/parser_schema_changed/);
  });

  const ageSource = () => registry({
    source_key: "age-chiasso-interruzioni",
    operator_name: "AGE Chiasso",
    url: "https://age-sa.ch/",
    area_text: "Chiasso, Balerna, Morbio Inferiore und Vacallo",
    adapter_config_json: JSON.stringify({
      language: "it",
      status_mode: "operator_api",
      api_url: "https://age-sa.ch/wp-json/wp/v2/posts?categories=19,24&per_page=20&_fields=id,date,link,title,categories,acf"
    })
  });

  it("reads AGE Chiasso WordPress notices and ignores the water sector", async () => {
    // Real API answer (categories 18,19,24): one unplanned water interruption.
    stubBody(ageChiassoFixture);
    const water = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ageSource(), "2026-10-31T11:30:00.000Z");
    expect(water.error).toBeNull();
    expect(water.parserStatus).toBe("no_current_outage");
    expect(water.observations).toHaveLength(0);

    // Same post moved to the electricity categories: AGE fills the same ACF fields for every sector.
    const [post] = JSON.parse(ageChiassoFixture) as Array<Record<string, any>>;
    const unplanned = {
      ...post,
      categories: [19],
      title: { rendered: "Interruzione imprevista settore Elettricit&agrave;" },
      acf: { ...post!.acf, app_titolo: "Interruzione imprevista settore Elettricità", app_sommario: "<p>A causa di un guasto sulla rete di distribuzione è stata interrotta l'erogazione di Elettricità</p>" }
    };
    const planned = {
      ...unplanned,
      id: 9999,
      categories: [24],
      acf: { ...unplanned.acf, app_tipologia_interruzione: "1: Pianificata", app_data_inizio_interruzione: "06.11.2026 08:00", app_data_fine_interruzione: "06.11.2026 11:30", app_luogo: "Balerna", app_quartiere: "via San Gottardo" }
    };
    stubBody(JSON.stringify([unplanned, planned]));
    const result = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ageSource(), "2026-10-31T11:30:00.000Z");
    expect(result.parserStatus).toBe("ready");
    expect(result.observations.map((item) => [item.title, item.canonicalStatus, item.locationText, item.startedAt, item.resolvedAt])).toEqual([
      ["Interruzione di corrente a Chiasso", "unplanned", "Chiasso", "2026-10-31T11:09:00.000Z", "2026-10-31T15:09:00.000Z"],
      ["Interruzione di corrente pianificata a Balerna", "planned", "Balerna", "2026-11-06T07:00:00.000Z", "2026-11-06T10:30:00.000Z"]
    ]);

    const later = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ageSource(), "2026-10-31T16:00:00.000Z");
    expect(later.observations[0]!.title).toBe("Interruzione di corrente terminata a Chiasso");
    expect(later.observations[0]!.canonicalStatus).toBe("resolved");
  });

  it("treats an empty AGE Chiasso answer as all-clear and other JSON as a contract change", async () => {
    stubBody("[]");
    const empty = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ageSource(), "2026-11-04T12:00:00.000Z");
    expect(empty.parserStatus).toBe("no_current_outage");
    stubBody(JSON.stringify({ code: "rest_no_route" }));
    const changed = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ageSource(), "2026-11-04T12:00:00.000Z");
    expect(changed.parserStatus).toBe("needs_adapter");
  });

  const ewdSource = () => registry({
    source_key: "ewd-davos-netzzustand",
    operator_name: "EW Davos",
    url: "https://www.ewd.ch/",
    area_text: "Gemeinde Davos",
    adapter_config_json: '{"language":"de","status_mode":"ewd_netzzustand"}'
  });

  it("reads the EW Davos Netzzustand box", async () => {
    stubBody(ewdDavosClearFixture);
    const clear = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ewdSource(), "2026-11-04T12:00:00.000Z");
    expect(clear.error).toBeNull();
    expect(clear.parserStatus).toBe("no_current_outage");
    expect(clear.observations).toHaveLength(0);

    stubBody(ewdDavosClearFixture.replace(
      "Momentan keine Störung im Stromnetz Davos",
      "Stromausfall in Davos Platz seit 04.11.2026, 10:40 Uhr. Wir arbeiten mit Hochdruck an der Behebung."
    ));
    const outage = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ewdSource(), "2026-11-04T12:00:00.000Z");
    expect(outage.parserStatus).toBe("ready");
    expect(outage.observations).toHaveLength(1);
    expect(outage.observations[0]!.title).toBe("Stromausfall in Davos Platz");
    expect(outage.observations[0]!.canonicalStatus).toBe("unplanned");
    expect(outage.observations[0]!.locationText).toBe("Davos Platz");
    expect(outage.observations[0]!.startedAt).toBe("2026-11-04T09:40:00.000Z");

    stubBody("<html><body><main>EWD Elektrizitätswerk Davos</main></body></html>");
    const changed = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, ewdSource(), "2026-11-04T12:00:00.000Z");
    expect(changed.parserStatus).toBe("needs_adapter");
  });

  const thurplusSource = () => registry({
    source_key: "thurplus-stoerungen",
    operator_name: "Thurplus",
    url: "https://www.thurplus.ch/fuer-private/kundenservice/stoerung/stoerungsdienst.html/67",
    area_text: "Frauenfeld und Thurplus Versorgungsgebiet",
    adapter_config_json: '{"language":"de","status_mode":"thurplus_aktuelle_stoerungen"}'
  });

  it("reads the Thurplus 'Aktuelle Störungen' widget and drops notices that went stale", async () => {
    // Widget as archived on 2026-03-07: a resolved outage from 21 August 2025, still on the page.
    stubBody(thurplusFixture);
    const fresh = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, thurplusSource(), "2025-08-21T18:00:00.000Z");
    expect(fresh.parserStatus).toBe("ready");
    expect(fresh.observations).toHaveLength(1);
    expect(fresh.observations[0]!.title).toBe("Behobener Stromausfall in Frauenfeld (Bahnhofstrasse und Heimstrasse)");
    expect(fresh.observations[0]!.canonicalStatus).toBe("resolved");
    expect(fresh.observations[0]!.locationText).toBe("Frauenfeld");
    // The notice gives a date but no time: nothing is invented.
    expect(fresh.observations[0]!.startedAt).toBeNull();

    const archived = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, thurplusSource(), "2026-03-07T08:22:02.000Z");
    expect(archived.parserStatus).toBe("no_current_outage");
    expect(archived.observations).toHaveLength(0);

    stubBody(thurplusClearFixture);
    const clear = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, thurplusSource(), "2026-11-04T12:00:00.000Z");
    expect(clear.error).toBeNull();
    expect(clear.parserStatus).toBe("no_current_outage");
    expect(clear.observations).toHaveLength(0);
  });

  it("keeps Thurplus gas and water notices out", async () => {
    stubBody(thurplusClearFixture.replace(
      "<h3>Derzeit sind keine Störungen bekannt.</h3>",
      "<h3>Wasserunterbruch an der Rheinstrasse</h3><p>Am 04.11.2026 von 08:00 bis 12:00 Uhr ist die Wasserversorgung unterbrochen.</p>"
    ));
    const result = await fetchSourceObservations({ FIRECRAWL_API_KEY: undefined }, thurplusSource(), "2026-11-04T07:00:00.000Z");
    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations).toHaveLength(0);
  });

  it("reads 'Zurzeit sind keine Unterbrechungen geplant' as an all-clear", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><body><h1>Stromabschaltung, Stromausfall und Störungen im Stromnetz</h1><p>Geplante und kurzfristige Unterbrechungen: Zurzeit sind keine Unterbrechungen geplant.</p></body></html>",
      { status: 200 }
    )));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "ew-urnaesch-stoerungen",
        operator_name: "EW Urnäsch",
        source_category: "news_feed",
        url: "https://ewurnaesch.ch/kundenservice/aktuelle-stoerungen/",
        adapter_config_json: '{"language":"de","status_mode":"news_feed","utility_filter":"electricity_only"}'
      }),
      "2026-11-04T12:00:00.000Z"
    );
    expect(result.error).toBeNull();
    expect(result.parserStatus).toBe("no_current_outage");
    expect(result.observations.every((item) => item.canonicalStatus === "irrelevant")).toBe(true);
  });

  it("geocodes a SAK failure from coordinates when the title is not enough", async () => {
    stubOperatorFetch(JSON.stringify([{
      id: "jonschwil",
      title: "Stromunterbruch Jonschwil",
      description: "Wir haben einen Stromausfall festgestellt.",
      status: 1,
      category: 0,
      publish_date: "2026-08-12T16:50:00.000+02:00",
      start_date: "2026-08-12T16:41:00.000+02:00",
      end_date: "2026-08-12T18:36:00.000+02:00",
      coordinates: { latitude: 47.41754923317169, longitude: 9.08165163368193 }
    }]), () => "Jonschwil");
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "sak-netzstatus",
        operator_name: "SAK",
        adapter_config_json: '{"api_url":"https://netzstatus.sak.ch/api/v1/failures"}'
      }),
      "2026-08-19T08:00:00.000Z"
    );

    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].canonicalStatus).toBe("resolved");
    expect(result.observations[0].locationText).toBe("Jonschwil");
  });

  it("keeps a SAK resolution from the last two weeks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: "stein",
      title: "Netz Störung Stein AR",
      description: "Die Stromversorgung wurde wiederhergestellt.",
      status: 2,
      category: 0,
      publish_date: "2026-08-05T19:15:00.000+02:00",
      start_date: "2026-08-05T18:30:00.000+02:00",
      end_date: "2026-08-05T23:09:00.000+02:00"
    }]), { status: 200 })));
    const result = await fetchSourceObservations(
      { FIRECRAWL_API_KEY: undefined },
      registry({
        source_key: "sak-netzstatus",
        operator_name: "SAK",
        adapter_config_json: '{"api_url":"https://netzstatus.sak.ch/api/v1/failures"}'
      }),
      "2026-08-19T08:00:00.000Z"
    );

    expect(result.parserStatus).toBe("ready");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].locationText).toMatch(/Stein/);
  });

  it("keeps single non-official discoveries below public corroboration while official sources pass", () => {
    const mediaOnly = scoreEvent(event({ confidence: 0.98 }), [
      source({
        source_url: "https://www.blick.ch/schweiz/zuerich/stromausfall",
        source_title: "Stromausfall in Zürich",
        source_name: "Blick",
        source_kind: "national_media",
        source_weight: 0.6,
        is_official: 0,
        independence_key: "blick.ch"
      })
    ]);
    const official = scoreEvent(event(), [source()]);

    expect(mediaOnly.evidence_level).not.toBe("official");
    expect(mediaOnly.event_score).toBeLessThan(80);
    expect(official.evidence_level).toBe("official");
    expect(official.event_score).toBeGreaterThanOrEqual(70);
  });
});
