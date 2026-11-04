import { describe, expect, it } from "vitest";
import { INDEX_FIELDS, buildPublicIndex, computePublicStats, distribution } from "../src/public-stats";
import type { LiteRow } from "../src/public-projection";

type AggregateRow = Parameters<typeof computePublicStats>[0][number];

function lite(patch: Partial<LiteRow> = {}): LiteRow {
  return {
    event_id: 1,
    status: "resolved",
    nature: "unplanned",
    trust: "official",
    location: "Brugg AG",
    canton: "AG",
    operator_slug: null,
    publisher: "IBB",
    received_at: "2026-07-15T06:10:00.000Z",
    started_at: "2026-07-15T06:00:00.000Z",
    resolved_at: "2026-07-15T07:30:00.000Z",
    expected_restore_at: null,
    duration_minutes: 90,
    sort_bucket: 1,
    sort_at: "2026-07-15T06:00:00.000Z",
    latitude: 47.481234567,
    longitude: 8.208765432,
    places_key: "brugg:AG",
    source_updated_at: "2026-07-15T07:35:00.000Z",
    ...patch
  };
}

function agg(patch: Partial<AggregateRow> = {}): AggregateRow {
  return { ...lite(), end_earliest_at: null, end_latest_at: null, active_since_at: null, time_confidence: null, ...patch };
}

const NOW = Date.parse("2026-07-16T12:00:00.000Z");

describe("buildPublicIndex", () => {
  it("emits positional tuples in INDEX_FIELDS order", () => {
    const payload = buildPublicIndex([lite({ expected_restore_at: "2026-07-15T08:00:00.000Z", places_key: "brugg:AG|windisch:AG" })], NOW);
    expect(payload.v).toBe(1);
    expect(payload.fields).toBe(INDEX_FIELDS);
    expect(payload.generatedAt).toBe("2026-07-16T12:00:00.000Z");
    const entry = payload.items[0];
    expect(entry).toHaveLength(INDEX_FIELDS.length);
    const named = Object.fromEntries(INDEX_FIELDS.map((field, index) => [field, entry[index]]));
    expect(named).toEqual({
      id: 1,
      slugId: "brugg-ag-1",
      location: "Brugg AG",
      status: "resolved",
      nature: "unplanned",
      canton: "AG",
      operatorSlug: null,
      publisher: "IBB",
      startMin: Date.parse("2026-07-15T06:00:00.000Z") / 60000,
      endMin: Date.parse("2026-07-15T07:30:00.000Z") / 60000,
      plannedEndMin: Date.parse("2026-07-15T08:00:00.000Z") / 60000,
      sortMin: Date.parse("2026-07-15T06:00:00.000Z") / 60000,
      lat: 47.4812,
      lon: 8.2088,
      places: "brugg windisch"
    });
  });

  it("keeps upcoming events and drops past events older than 365 days", () => {
    const rows = [
      lite({ event_id: 1, sort_at: "2026-07-01T00:00:00.000Z" }),
      lite({ event_id: 2, sort_at: "2025-07-01T00:00:00.000Z" }),
      lite({ event_id: 3, sort_at: "2025-07-20T00:00:00.000Z" }),
      lite({ event_id: 4, status: "upcoming", nature: "planned", sort_bucket: 0, sort_at: "2024-01-01T00:00:00.000Z" })
    ];
    expect(buildPublicIndex(rows, NOW).items.map((entry) => entry[0])).toEqual([1, 3, 4]);
  });

  it("uses null minutes for missing times and an empty publisher string", () => {
    const [entry] = buildPublicIndex([lite({ started_at: null, resolved_at: null, publisher: null, latitude: null, longitude: null, places_key: "" })], NOW).items;
    expect(entry[7]).toBe("");
    expect(entry[8]).toBeNull();
    expect(entry[9]).toBeNull();
    expect(entry[12]).toBeNull();
    expect(entry[14]).toBe("");
  });
});

describe("distribution", () => {
  it("buckets values by upper edge and ignores negative or non-finite values", () => {
    const result = distribution([5, 1, 3, -1, Number.NaN, 100], [["a", 2], ["b", 10], ["c", Infinity]]);
    expect(result.n).toBe(4);
    expect(result.median).toBe(4);
    expect(result.buckets).toEqual([{ key: "a", count: 1 }, { key: "b", count: 2 }, { key: "c", count: 1 }]);
  });

  it("puts values beyond the last finite edge into the last bucket and rounds the median", () => {
    const result = distribution([1.04, 1.12, 50], [["low", 2], ["high", 10]]);
    expect(result.median).toBe(1.1);
    expect(result.buckets).toEqual([{ key: "low", count: 2 }, { key: "high", count: 1 }]);
  });

  it("returns a null median without values", () => {
    expect(distribution([], [["a", 1]])).toEqual({ n: 0, median: null, buckets: [{ key: "a", count: 0 }] });
  });
});

describe("computePublicStats", () => {
  const rows: AggregateRow[] = [
    // Unplanned, exact 90 min, Wednesday 08:00 Zurich time.
    agg({ event_id: 1, operator_slug: "bkw", publisher: "BKW" }),
    // Unplanned, end only known as a polling window (midpoint → 50 min).
    agg({
      event_id: 2, operator_slug: "bkw", publisher: "BKW", canton: "VD", location: "Orbe", places_key: "orbe:VD",
      started_at: "2026-07-14T10:00:00.000Z", resolved_at: null, duration_minutes: null, sort_at: "2026-07-14T10:00:00.000Z",
      end_earliest_at: "2026-07-14T10:40:00.000Z", end_latest_at: "2026-07-14T11:00:00.000Z"
    }),
    // Planned and done, announced 70 h ahead, 2 h window.
    agg({
      event_id: 3, nature: "planned", received_at: "2026-07-10T08:00:00.000Z",
      started_at: "2026-07-13T06:00:00.000Z", expected_restore_at: "2026-07-13T08:00:00.000Z",
      resolved_at: "2026-07-13T08:00:00.000Z", sort_at: "2026-07-13T06:00:00.000Z", places_key: "brugg:AG"
    }),
    // Upcoming planned, announced 94 h ahead, 3 h window.
    agg({
      event_id: 4, status: "upcoming", nature: "planned", sort_bucket: 0, received_at: "2026-07-16T08:00:00.000Z",
      started_at: "2026-07-20T06:00:00.000Z", expected_restore_at: "2026-07-20T09:00:00.000Z",
      resolved_at: null, sort_at: "2026-07-20T06:00:00.000Z", canton: null, places_key: ""
    }),
    // Older unplanned outage in the previous 30-day window (Monday 22:00 local).
    agg({
      event_id: 5, canton: "VD", places_key: "orbe:VD",
      started_at: "2026-06-01T20:00:00.000Z", resolved_at: "2026-06-01T21:00:00.000Z", sort_at: "2026-06-01T20:00:00.000Z"
    })
  ];
  const stats = computePublicStats(rows, { now: NOW, sources: { monitored: 12, healthy: 10 } });

  it("counts totals and rolling 30-day windows", () => {
    expect(stats.totals).toEqual({
      all: 5,
      active: 0,
      upcoming: 1,
      planned: 2,
      unplanned: 3,
      last30: 3,
      last30Planned: 1,
      last30Unplanned: 2,
      previous30: 1,
      operators: 1,
      places: 2,
      withCanton: 4
    });
    expect(stats.firstAt).toBe("2026-06-01T20:00:00.000Z");
    expect(stats.sources).toEqual({ monitored: 12, healthy: 10 });
  });

  it("builds 91 daily and 26 weekly buckets ending today/this week", () => {
    expect(stats.daily).toHaveLength(91);
    expect(stats.daily.at(-1)).toEqual({ date: "2026-07-16", planned: 0, unplanned: 0 });
    expect(stats.daily.find((entry) => entry.date === "2026-07-15")).toEqual({ date: "2026-07-15", planned: 0, unplanned: 1 });
    expect(stats.weekly).toHaveLength(26);
    expect(stats.weekly.at(-1)).toEqual({ week: "2026-07-13", planned: 1, unplanned: 2 });
    expect(stats.weekly.find((entry) => entry.week === "2026-06-01")).toEqual({ week: "2026-06-01", planned: 0, unplanned: 1 });
  });

  it("maps unplanned starts to a Monday-first weekday x hour grid in Europe/Zurich time", () => {
    expect(stats.weekdayHour).toHaveLength(7);
    expect(stats.weekdayHour.every((row) => row.length === 24)).toBe(true);
    expect(stats.weekdayHourN).toBe(3);
    expect(stats.weekdayHour[2][8]).toBe(1); // 2026-07-15T06:00Z = Wed 08:00 CEST
    expect(stats.weekdayHour[1][12]).toBe(1); // 2026-07-14T10:00Z = Tue 12:00 CEST
    expect(stats.weekdayHour[0][22]).toBe(1); // 2026-06-01T20:00Z = Mon 22:00 CEST
    expect(stats.weekdayHour.flat().reduce((sum, value) => sum + value, 0)).toBe(3);
  });

  it("measures announcement lead time and planned window length", () => {
    expect(stats.leadTimeHours.n).toBe(2);
    expect(stats.leadTimeHours.median).toBe(82);
    expect(stats.leadTimeHours.buckets.map((bucket) => bucket.count)).toEqual([0, 1, 1, 0, 0]);
    expect(stats.plannedDurationMinutes.n).toBe(2);
    expect(stats.plannedDurationMinutes.median).toBe(150);
    expect(stats.plannedDurationMinutes.buckets.find((bucket) => bucket.key === "h2to4")?.count).toBe(2);
  });

  it("separates exact and estimated unplanned durations", () => {
    expect(stats.unplannedDurationMinutes.exact).toBe(2);
    expect(stats.unplannedDurationMinutes.estimated).toBe(1);
    expect(stats.unplannedDurationMinutes.n).toBe(3);
    expect(stats.unplannedDurationMinutes.median).toBe(60);
    const counts = Object.fromEntries(stats.unplannedDurationMinutes.buckets.map((bucket) => [bucket.key, bucket.count]));
    expect(counts).toEqual({ lt30: 0, m30to60: 1, h1to2: 2, h2to4: 0, gt4h: 0 });
  });

  it("aggregates by operator, canton and place", () => {
    expect(stats.byOperator).toHaveLength(1);
    expect(stats.byOperator[0]).toMatchObject({ slug: "bkw", total: 2, unplanned: 2, planned: 0, last30: 2 });
    expect(stats.byOperator[0].weekly).toHaveLength(12);
    expect(stats.byOperator[0].weekly.at(-1)).toBe(2);
    expect(stats.byCanton).toHaveLength(26);
    expect(stats.byCanton.slice(0, 2)).toEqual([
      { code: "AG", total: 2, planned: 1, unplanned: 1 },
      { code: "VD", total: 2, planned: 0, unplanned: 2 }
    ]);
    expect(stats.topPlaces).toEqual([
      { slug: "brugg", name: "brugg", canton: "AG", count: 2 },
      { slug: "orbe", name: "orbe", canton: "VD", count: 2 }
    ]);
  });

  it("uses provided place names", () => {
    const named = computePublicStats(rows, { now: NOW, placeNames: new Map([["brugg", "Brugg"]]) });
    expect(named.topPlaces.find((place) => place.slug === "brugg")?.name).toBe("Brugg");
    expect(named.sources).toEqual({ monitored: 0, healthy: 0 });
  });
});
