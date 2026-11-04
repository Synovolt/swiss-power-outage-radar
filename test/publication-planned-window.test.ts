import { describe, expect, it } from "vitest";
import { PLANNED_WINDOW_GRACE_MS, toPublicFeedItem } from "../src/publication";
import type { OutageEvent, PublicationDecision } from "../src/types";

function plannedEvent(patch: Partial<OutageEvent> = {}): OutageEvent {
  return {
    id: 21,
    title: "Geplanter Stromunterbruch in Brugg",
    status: "needs_review",
    event_type: "power_outage",
    location_text: "Brugg AG",
    normalized_location: "brugg ag",
    canton: "AG",
    country: "CH",
    first_seen_at: "2026-07-15T08:00:00.000Z",
    last_seen_at: "2026-07-15T08:00:00.000Z",
    received_at: "2026-07-15T08:00:00.000Z",
    started_at_estimate: "2026-07-20T06:00:00.000Z",
    resolved_at_estimate: null,
    expected_restore_at: "2026-07-20T08:30:00.000Z",
    summary: "Geplante Arbeiten am Netz.",
    reason: null,
    confidence: 0.95,
    source_count: 1,
    primary_source_url: "https://www.ibb.ch/stromunterbrueche",
    primary_source_title: "Stromunterbrüche",
    email_sent: 0,
    email_sent_at: null,
    update_email_sent_at: null,
    merged_into_event_id: null,
    admin_note: null,
    outage_nature: "planned",
    cause_category: "planned_maintenance",
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
    created_at: "2026-07-15 08:00:00",
    updated_at: "2026-07-15 08:00:00",
    ...patch
  };
}

const decision: PublicationDecision = {
  publishable: true,
  trust: "official",
  reasons: [],
  summary: "Geplanter Unterbruch in Brugg.",
  primary_source: { publisher: "IBB", url: "https://www.ibb.ch/stromunterbrueche", domain: "ibb.ch" }
};

const END_MS = Date.parse("2026-07-20T08:30:00.000Z");

describe("toPublicFeedItem planned windows", () => {
  it("resolves a planned window whose announced end passed more than 30 minutes ago", () => {
    const item = toPublicFeedItem(plannedEvent(), decision, [], END_MS + 31 * 60_000);
    expect(item?.status).toBe("resolved");
    expect(item?.resolved_at).toBe("2026-07-20T08:30:00.000Z");
    expect(item?.duration_minutes).toBe(150);
    expect(item?.started_at).toBe("2026-07-20T06:00:00.000Z");
  });

  it("treats the grace period as the boundary", () => {
    expect(PLANNED_WINDOW_GRACE_MS).toBe(30 * 60_000);
    const within = toPublicFeedItem(plannedEvent(), decision, [], END_MS + 29 * 60_000);
    expect(within?.status).not.toBe("resolved");
    expect(within?.resolved_at).toBeNull();
    expect(within?.duration_minutes).toBeNull();
  });

  it("keeps the event open when the operator still confirmed it after the planned end", () => {
    const item = toPublicFeedItem(
      plannedEvent({ last_confirmed_active_at: "2026-07-20T08:45:00.000Z", last_seen_at: "2026-07-20T08:45:00.000Z" }),
      decision,
      [],
      END_MS + 60 * 60_000
    );
    expect(item?.status).not.toBe("resolved");
    expect(item?.status).toBe("active");
    expect(item?.resolved_at).toBeNull();
    expect(item?.duration_minutes).toBeNull();
  });

  it("still closes the window when the last confirmation predates the planned end", () => {
    const item = toPublicFeedItem(
      plannedEvent({ last_confirmed_active_at: "2026-07-20T07:00:00.000Z" }),
      decision,
      [],
      END_MS + 60 * 60_000
    );
    expect(item?.status).toBe("resolved");
    expect(item?.resolved_at).toBe("2026-07-20T08:30:00.000Z");
  });

  it("keeps a planned event in the future as upcoming", () => {
    const item = toPublicFeedItem(plannedEvent(), decision, [], Date.parse("2026-07-19T12:00:00.000Z"));
    expect(item?.status).toBe("upcoming");
    expect(item?.resolved_at).toBeNull();
    expect(item?.expected_restore_at).toBe("2026-07-20T08:30:00.000Z");
  });

  it("does not invent an end for unplanned events with an expected restore time", () => {
    const item = toPublicFeedItem(
      plannedEvent({ outage_nature: "unplanned", last_confirmed_active_at: "2026-07-20T09:30:00.000Z" }),
      decision,
      [],
      END_MS + 61 * 60_000
    );
    expect(item?.resolved_at).toBeNull();
    expect(item?.status).toBe("active");
  });
});
