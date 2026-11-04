import { describe, expect, it } from "vitest";
import { historicalBackfillFacts, type HistoricalBackfillTarget } from "../src/historical-backfill";

function target(patch: Partial<HistoricalBackfillTarget>): HistoricalBackfillTarget {
  return {
    id: 20,
    title: "Stromausfall in Marly",
    status: "needs_review",
    event_type: "power_outage",
    location_text: "Marly",
    normalized_location: "marly",
    canton: "FR",
    country: "CH",
    first_seen_at: "2026-07-01T12:56:00.000Z",
    last_seen_at: "2026-07-01T12:56:00.000Z",
    received_at: "2026-07-02T05:30:50.000Z",
    started_at_estimate: null,
    resolved_at_estimate: null,
    summary: "Über 2'300 Personen waren ohne Strom.",
    reason: null,
    confidence: 0.9,
    source_count: 1,
    primary_source_url: null,
    primary_source_title: null,
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
    event_score: 70,
    evidence_level: "plausible",
    fact_sheet_json: null,
    fact_sheet_updated_at: null,
    auto_research_started_at: null,
    mail_decision_reason: null,
    public_status: "public_auto",
    verification_level: "auto_analyzed",
    location_granularity: "municipality",
    event_quality_state: "publishable",
    created_at: "2026-07-02 05:30:50",
    updated_at: "2026-07-02 05:30:50",
    backfill_source_id: 9,
    backfill_source_url: "https://frapp.ch/fr/articles/stories/plus-de-2300-personnes-privees-delectricite-a-marly",
    backfill_sort_at: "2026-07-02T05:30:50.000Z",
    ...patch
  };
}

describe("historical backfill", () => {
  it("uses researched source-specific facts without a paid lookup", () => {
    const facts = historicalBackfillFacts(target({}), "2026-07-30T12:00:00.000Z");
    expect(facts.find((fact) => fact.fact_type === "start_time")?.value_text).toBe("2026-07-01T06:20:00.000Z");
    expect(facts.find((fact) => fact.fact_type === "end_time")?.value_text).toBe("2026-07-01T07:15:00.000Z");
    expect(facts.find((fact) => fact.fact_type === "cause")?.value_text).toContain("Trafostation");
    expect(facts.every((fact) => fact.extractor_version === "historical-backfill/v1")).toBe(true);
  });

  it("marks an old unresolved report historical and extracts safe summary facts", () => {
    const facts = historicalBackfillFacts(target({
      backfill_source_url: "https://example.ch/outage",
      summary: "Ein defektes Erdkabel betraf mehr als 2'100 Haushalte."
    }), "2026-07-30T12:00:00.000Z");
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact_type: "cause", value_text: "Defektes Erdkabel" }),
      expect.objectContaining({ fact_type: "status", value_text: "historical" })
    ]));
  });
});
