import { describe, expect, it } from "vitest";
import { dbTimeMs, liteRowToItem, projectPublicEvent, type LiteRow, type ProjectionRow } from "../src/public-projection";
import type { OutageFact } from "../src/types";

function row(patch: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    id: 42,
    title: "Stromausfall in Chavornay",
    status: "needs_review",
    event_type: "power_outage",
    location_text: "Chavornay",
    normalized_location: "chavornay",
    canton: null,
    country: "CH",
    first_seen_at: "2026-07-15T06:40:00.000Z",
    last_seen_at: "2026-07-15T06:45:00.000Z",
    received_at: "2026-07-15T06:47:32.000Z",
    started_at_estimate: null,
    resolved_at_estimate: null,
    last_confirmed_active_at: "2026-07-15T06:45:00.000Z",
    summary: "In Chavornay ist der Strom ausgefallen.",
    reason: null,
    confidence: 0.95,
    source_count: 1,
    primary_source_title: "BKW Störungen",
    email_sent: 0,
    email_sent_at: null,
    update_email_sent_at: null,
    merged_into_event_id: null,
    admin_note: null,
    outage_nature: "unplanned",
    cause_category: "unknown",
    cause_text: null,
    research_status: "not_started",
    research_started_at: null,
    research_finished_at: null,
    research_summary_de: null,
    fact_confidence: null,
    event_score: 80,
    evidence_level: "official",
    fact_sheet_json: null,
    fact_sheet_updated_at: null,
    auto_research_started_at: null,
    mail_decision_reason: null,
    public_status: "public_auto",
    verification_level: "auto_analyzed",
    location_granularity: "municipality",
    event_quality_state: "candidate_only",
    created_at: "2026-07-15 06:47:32",
    updated_at: "2026-07-15 06:48:10",
    publication_trust: "official",
    publication_summary: "Stromausfall in Chavornay.",
    primary_source_publisher: "BKW",
    primary_source_url: "https://outage.bkw.ch/",
    primary_source_domain: "outage.bkw.ch",
    decision_decided_at: "2026-07-15 06:50:00",
    map_latitude: 46.705,
    map_longitude: 6.57,
    map_precision: "municipality",
    map_label: "Chavornay (VD)",
    map_resolved_at: null,
    ...patch
  };
}

const NOW = Date.parse("2026-07-15T07:00:00.000Z");

describe("dbTimeMs", () => {
  it("parses D1 timestamps as UTC", () => {
    expect(dbTimeMs("2026-07-15 06:47:32")).toBe(Date.parse("2026-07-15T06:47:32.000Z"));
    expect(dbTimeMs("2026-07-15 06:47")).toBe(Date.parse("2026-07-15T06:47:00.000Z"));
    expect(dbTimeMs(" 2026-07-15 06:47:32.250 ")).toBe(Date.parse("2026-07-15T06:47:32.250Z"));
  });

  it("parses ISO strings and rejects empty or invalid values", () => {
    expect(dbTimeMs("2026-07-15T06:47:32.000Z")).toBe(Date.parse("2026-07-15T06:47:32.000Z"));
    expect(dbTimeMs("2026-07-15T08:47:32+02:00")).toBe(Date.parse("2026-07-15T06:47:32.000Z"));
    expect(dbTimeMs(null)).toBeNaN();
    expect(dbTimeMs("")).toBeNaN();
    expect(dbTimeMs("not a date")).toBeNaN();
  });
});

describe("projectPublicEvent", () => {
  it("derives canton, places and operator for an active event", () => {
    const projection = projectPublicEvent(row(), [], NOW);
    expect(projection).not.toBeNull();
    expect(projection!.eventId).toBe(42);
    expect(projection!.canton).toBe("VD");
    expect(projection!.item.canton).toBe("VD");
    expect(projection!.places).toEqual([{ slug: "chavornay-vd", name: "Chavornay", canton: "VD" }]);
    expect(projection!.item.places).toEqual([{ slug: "chavornay-vd", name: "Chavornay" }]);
    expect(projection!.operatorSlug).toBe("bkw");
    expect(projection!.item.operator_slug).toBe("bkw");
    expect(projection!.item.operator_name).toBeTruthy();
    expect(projection!.item.status).toBe("active");
    expect(projection!.item.trust).toBe("official");
    expect(projection!.item.summary).toBe("Stromausfall in Chavornay.");
    expect(projection!.item.latitude).toBe(46.705);
    expect(projection!.item.map_precision).toBe("municipality");
    expect(projection!.sortBucket).toBe(1);
    expect(projection!.isFinal).toBe(false);
  });

  it("sorts by the received time when no start is known and reports ISO timestamps", () => {
    const projection = projectPublicEvent(row(), [], NOW)!;
    expect(projection.sortAt).toBe("2026-07-15T06:47:32.000Z");
    // Latest of updated_at, decision_decided_at and map_resolved_at.
    expect(projection.sourceUpdatedAt).toBe("2026-07-15T06:50:00.000Z");
    expect(projectPublicEvent(row({ map_resolved_at: "2026-07-15T06:55:00.000Z" }), [], NOW)!.sourceUpdatedAt)
      .toBe("2026-07-15T06:55:00.000Z");
  });

  it("resolves the operator from the source domain when the publisher name is unknown", () => {
    const projection = projectPublicEvent(row({ primary_source_publisher: "Störungsmeldung" }), [], NOW)!;
    expect(projection.operatorSlug).toBe("bkw");
  });

  it("leaves the operator empty for an unrelated source", () => {
    const projection = projectPublicEvent(row({
      primary_source_publisher: "Lokalzeitung",
      primary_source_url: "https://news.example.org/artikel",
      primary_source_domain: "news.example.org"
    }), [], NOW)!;
    expect(projection.operatorSlug).toBeNull();
    expect(projection.item.operator_slug).toBeNull();
  });

  it("puts upcoming planned events into sort bucket 0 sorted by their start", () => {
    const projection = projectPublicEvent(row({
      outage_nature: "planned",
      started_at_estimate: "2026-07-20T06:00:00.000Z",
      expected_restore_at: "2026-07-20T08:00:00.000Z"
    }), [], NOW)!;
    expect(projection.item.status).toBe("upcoming");
    expect(projection.sortBucket).toBe(0);
    expect(projection.isFinal).toBe(false);
    expect(projection.sortAt).toBe("2026-07-20T06:00:00.000Z");
  });

  it("marks resolved events as final", () => {
    const facts = [{
      fact_type: "status",
      value_text: "resolved",
      confidence: 0.95
    } as OutageFact];
    const projection = projectPublicEvent(row(), facts, NOW)!;
    expect(projection.item.status).toBe("resolved");
    expect(projection.isFinal).toBe(true);
    expect(projection.sortBucket).toBe(1);
  });

  it("ignores map pins outside Switzerland but still uses the label canton", () => {
    const projection = projectPublicEvent(row({ map_latitude: 40, map_longitude: 8 }), [], NOW)!;
    expect(projection.item.latitude).toBeNull();
    expect(projection.canton).toBe("VD");
  });

  it("returns null when the publication summary is missing", () => {
    expect(projectPublicEvent(row({ publication_summary: "" }), [], NOW)).toBeNull();
  });
});

describe("liteRowToItem", () => {
  const lite: LiteRow = {
    event_id: 9,
    status: "resolved",
    nature: "unplanned",
    trust: "official",
    location: "Brugg AG",
    canton: "AG",
    operator_slug: "ibb",
    publisher: "IBB",
    received_at: "2026-07-15T06:47:32.000Z",
    started_at: "2026-07-15T06:00:00.000Z",
    resolved_at: "2026-07-15T07:00:00.000Z",
    expected_restore_at: null,
    duration_minutes: 60,
    sort_bucket: 1,
    sort_at: "2026-07-15T06:00:00.000Z",
    latitude: 47.48,
    longitude: 8.2,
    places_key: "brugg:AG|windisch:AG",
    source_updated_at: "2026-07-15T07:05:00.000Z"
  };

  it("maps the column-only row to a public item", () => {
    const item = liteRowToItem(lite);
    expect(item.id).toBe(9);
    expect(item.url).toBe("/stromausfall/brugg-ag-9");
    expect(item.status).toBe("resolved");
    expect(item.duration_minutes).toBe(60);
    expect(item.updated_at).toBe("2026-07-15T07:05:00.000Z");
    expect(item.source).toEqual({ publisher: "IBB", url: "", domain: "" });
    expect(item.operator_slug).toBe("ibb");
    expect(item.operator_name).toBe("IBB");
    expect(item.places).toEqual([{ slug: "brugg", name: "" }, { slug: "windisch", name: "" }]);
  });

  it("handles a missing publisher and empty places key", () => {
    const item = liteRowToItem({ ...lite, publisher: null, places_key: "" });
    expect(item.source.publisher).toBe("");
    expect(item.places).toEqual([]);
  });
});
