import { describe, expect, it } from "vitest";
import { radarViewCopy } from "../src/i18n";
import type { IndexEntry } from "../src/public-stats";
import {
  DAY_MS,
  eventHref,
  formatDuration,
  fromIndexEntry,
  groupItems,
  inView,
  matchesNature,
  matchesQuery,
  rowHtml,
  sortForView,
  timeLabel,
  viewCounts,
  type RadarItem
} from "../src/radar-view";

const NOW = Date.parse("2026-07-16T10:00:00.000Z"); // Thursday 12:00 in Zurich
const HOUR = 60 * 60 * 1000;
const de = radarViewCopy("de");
const min = (ms: number) => Math.round(ms / 60000);

interface ItemInput {
  id?: number;
  location?: string;
  status?: string;
  nature?: string;
  canton?: string | null;
  publisher?: string;
  start?: number | null;
  end?: number | null;
  plannedEnd?: number | null;
  sort?: number;
  places?: string;
}

function item(input: ItemInput = {}): RadarItem {
  const start = input.start === undefined ? NOW - HOUR : input.start;
  const entry: IndexEntry = [
    input.id ?? 1,
    `brugg-${input.id ?? 1}`,
    input.location ?? "Brugg",
    input.status ?? "active",
    input.nature ?? "unplanned",
    input.canton === undefined ? "AG" : input.canton,
    null,
    input.publisher ?? "IBB",
    start === null ? null : min(start),
    input.end == null ? null : min(input.end),
    input.plannedEnd == null ? null : min(input.plannedEnd),
    min(input.sort ?? start ?? NOW),
    null,
    null,
    input.places ?? ""
  ];
  return fromIndexEntry(entry);
}

describe("fromIndexEntry", () => {
  it("expands minute timestamps and builds a folded search haystack", () => {
    const radar = item({ location: "Zürich", canton: "ZH", start: Date.parse("2026-07-16T08:00:00.000Z"), places: "zurich-altstetten" });
    expect(radar.startMs).toBe(Date.parse("2026-07-16T08:00:00.000Z"));
    expect(radar.endMs).toBeNull();
    expect(radar.sortMs).toBe(Date.parse("2026-07-16T08:00:00.000Z"));
    expect(radar.hay).toContain("zurich");
    expect(radar.hay).toContain("zurich altstetten");
    expect(radar.hay).toContain("zurigo");
  });
});

describe("inView", () => {
  it("always shows active events in the now view", () => {
    const old = item({ status: "active", start: NOW - 30 * DAY_MS });
    expect(inView(old, "now", NOW)).toBe(true);
    expect(inView(old, "history", NOW)).toBe(true);
    expect(inView(old, "planned", NOW)).toBe(false);
  });

  it("shows upcoming events within 7 days in the now view and all of them in planned", () => {
    const soon = item({ status: "upcoming", nature: "planned", start: NOW + 6 * DAY_MS });
    const later = item({ status: "upcoming", nature: "planned", start: NOW + 8 * DAY_MS });
    expect(inView(soon, "now", NOW)).toBe(true);
    expect(inView(later, "now", NOW)).toBe(false);
    expect(inView(soon, "planned", NOW)).toBe(true);
    expect(inView(later, "planned", NOW)).toBe(true);
    expect(inView(later, "history", NOW)).toBe(false);
  });

  it("shows resolved events in the now view for 48 hours after their end", () => {
    const recent = item({ status: "resolved", start: NOW - 50 * HOUR, end: NOW - 47 * HOUR });
    const older = item({ status: "resolved", start: NOW - 52 * HOUR, end: NOW - 49 * HOUR });
    expect(inView(recent, "now", NOW)).toBe(true);
    expect(inView(older, "now", NOW)).toBe(false);
    expect(inView(older, "history", NOW)).toBe(true);
    // Without an end the sort time decides.
    expect(inView(item({ status: "resolved", start: null, sort: NOW - HOUR }), "now", NOW)).toBe(true);
  });

  it("counts views per nature filter", () => {
    const items = [
      item({ id: 1, status: "active" }),
      item({ id: 2, status: "upcoming", nature: "planned", start: NOW + DAY_MS }),
      item({ id: 3, status: "resolved", start: NOW - 10 * DAY_MS, end: NOW - 9 * DAY_MS })
    ];
    expect(viewCounts(items, "", NOW)).toEqual({ now: 2, planned: 1, history: 2 });
    expect(viewCounts(items, "planned", NOW)).toEqual({ now: 1, planned: 1, history: 0 });
    expect(matchesNature(items[0], "unplanned")).toBe(true);
    expect(matchesNature(items[1], "unplanned")).toBe(false);
  });
});

describe("matchesQuery", () => {
  it("folds accents and case", () => {
    const zurich = item({ location: "Zürich", canton: "ZH" });
    expect(matchesQuery(zurich, "zurich")).toBe(true);
    expect(matchesQuery(zurich, "ZÜRICH")).toBe(true);
    expect(matchesQuery(zurich, "  ")).toBe(true);
    expect(matchesQuery(zurich, "bern")).toBe(false);
  });

  it("finds an item by the canton name in any language", () => {
    const orbe = item({ location: "Orbe", canton: "VD", publisher: "Romande Energie" });
    expect(matchesQuery(orbe, "waadt")).toBe(true);
    expect(matchesQuery(orbe, "Vaud")).toBe(true);
    expect(matchesQuery(orbe, "vd")).toBe(true);
    expect(matchesQuery(orbe, "orbe vaud")).toBe(true);
    expect(matchesQuery(orbe, "orbe genf")).toBe(false);
    expect(matchesQuery(orbe, "romande")).toBe(true);
  });

  it("searches affected place slugs as words", () => {
    expect(matchesQuery(item({ location: "Vallée de Joux", places: "le-sentier le-brassus" }), "le brassus")).toBe(true);
  });
});

describe("sortForView", () => {
  const active = item({ id: 1, status: "active", start: NOW - 2 * HOUR });
  const upcomingLate = item({ id: 2, status: "upcoming", nature: "planned", start: NOW + 3 * DAY_MS });
  const upcomingSoon = item({ id: 3, status: "upcoming", nature: "planned", start: NOW + DAY_MS });
  const resolvedOld = item({ id: 4, status: "resolved", start: NOW - 5 * DAY_MS, end: NOW - 5 * DAY_MS + HOUR });
  const resolvedNew = item({ id: 5, status: "resolved", start: NOW - DAY_MS, end: NOW - DAY_MS + HOUR });

  it("orders now/history as active, upcoming by start, then newest first", () => {
    const sorted = sortForView([resolvedOld, upcomingLate, resolvedNew, active, upcomingSoon], "now");
    expect(sorted.map((entry) => entry.id)).toEqual([1, 3, 2, 5, 4]);
  });

  it("orders the planned view by start", () => {
    expect(sortForView([upcomingLate, upcomingSoon], "planned").map((entry) => entry.id)).toEqual([3, 2]);
  });

  it("does not mutate its input", () => {
    const input = [resolvedOld, active];
    sortForView(input, "now");
    expect(input.map((entry) => entry.id)).toEqual([4, 1]);
  });
});

describe("groupItems", () => {
  it("labels planned days as Heute, Morgen and then the weekday", () => {
    const items = [
      item({ id: 1, status: "upcoming", nature: "planned", start: Date.parse("2026-07-16T16:00:00.000Z") }),
      item({ id: 2, status: "upcoming", nature: "planned", start: Date.parse("2026-07-17T05:00:00.000Z") }),
      item({ id: 3, status: "upcoming", nature: "planned", start: Date.parse("2026-07-18T06:00:00.000Z") }),
      item({ id: 4, status: "upcoming", nature: "planned", start: Date.parse("2026-07-18T09:00:00.000Z") })
    ];
    const groups = groupItems(items, "planned", NOW, de);
    expect(groups.map((group) => group.key)).toEqual(["2026-07-16", "2026-07-17", "2026-07-18"]);
    expect(groups[0].label).toBe("Heute");
    expect(groups[1].label).toBe("Morgen");
    expect(groups[2].label).toContain("Samstag");
    expect(groups[2].items.map((entry) => entry.id)).toEqual([3, 4]);
  });

  it("uses the Zurich calendar day for an early-morning start", () => {
    // 23:30 UTC on the 16th is already 01:30 on the 17th in Zurich.
    const [group] = groupItems([item({ status: "upcoming", start: Date.parse("2026-07-16T23:30:00.000Z") })], "planned", NOW, de);
    expect(group.label).toBe("Morgen");
  });

  it("groups the now view by state and search results into one group", () => {
    const items = [
      item({ id: 1, status: "active" }),
      item({ id: 2, status: "upcoming", start: NOW + DAY_MS }),
      item({ id: 3, status: "resolved", end: NOW - HOUR })
    ];
    expect(groupItems(items, "now", NOW, de).map((group) => [group.key, group.label])).toEqual([
      ["active", de.groups.active],
      ["next7", de.groups.next7],
      ["recent", de.groups.recent]
    ]);
    // Search results keep the radar's reading order: grouped by state.
    expect(groupItems(items, "now", NOW, de, true).map((group) => [group.key, group.label, group.items.map((entry) => entry.id)])).toEqual([
      ["active", "Aktiv", [1]],
      ["upcoming", "Geplant", [2]],
      ["ended", "Beendet", [3]]
    ]);
    expect(groupItems([], "now", NOW, de, true)).toEqual([]);
  });
});

describe("timeLabel", () => {
  it("shows the announced window for an upcoming event", () => {
    const label = timeLabel(item({
      status: "upcoming",
      nature: "planned",
      start: Date.parse("2026-07-17T05:00:00.000Z"),
      plannedEnd: Date.parse("2026-07-17T08:30:00.000Z")
    }), NOW, de);
    expect(label).toMatch(/^Fr/);
    expect(label).toContain("17.");
    expect(label).toContain("07:00 – 10:30");
  });

  it("repeats the day when the window ends on another day", () => {
    const label = timeLabel(item({
      status: "upcoming",
      start: Date.parse("2026-07-17T20:00:00.000Z"),
      plannedEnd: Date.parse("2026-07-18T04:00:00.000Z")
    }), NOW, de);
    expect(label).toContain("22:00 – Sa");
    expect(label).toContain("06:00");
  });

  it("says since when for an active event with a start", () => {
    expect(timeLabel(item({ status: "active", start: NOW - 90 * 60000 }), NOW, de)).toBe("seit 1 h 30 min");
  });

  it("falls back to the report time for an active event without a start", () => {
    expect(timeLabel(item({ status: "active", start: null, sort: NOW - 2 * HOUR }), NOW, de)).toMatch(/^gemeldet /);
  });

  it("shows end time and duration for a resolved event", () => {
    const label = timeLabel(item({
      status: "resolved",
      start: Date.parse("2026-07-15T06:00:00.000Z"),
      end: Date.parse("2026-07-15T07:30:00.000Z")
    }), NOW, de);
    expect(label).toContain("09:30 · 1 h 30 min");
  });

  it("formats durations compactly", () => {
    expect(formatDuration(0.2)).toBe("1 min");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(50 * 60)).toBe("2 d");
  });
});

describe("rowHtml", () => {
  it("escapes HTML in the location and publisher", () => {
    const html = rowHtml(item({ location: '<img src=x onerror="alert(1)">, Teil <b>2</b>', publisher: "A&B" }), NOW, de);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("A&amp;B");
    expect(html).toContain("Teil &lt;b&gt;2&lt;/b&gt;");
  });

  it("links to the localized event path and marks the selection", () => {
    const radar = item({ id: 7 });
    expect(eventHref(radar, de)).toBe("/stromausfall/brugg-7");
    expect(eventHref(radar, radarViewCopy("fr"))).toBe("/fr/panne-de-courant/brugg-7");
    const html = rowHtml(radar, NOW, de, true);
    expect(html).toContain('href="/stromausfall/brugg-7"');
    expect(html).toContain('data-id="7"');
    expect(html).toContain("is-selected");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("radar-item--active");
    expect(html).toContain('<span class="radar-item__canton">AG</span>');
  });
});
