import { describe, expect, it } from "vitest";
import { liteRowToItem, type LiteRow, type PublicSlice } from "../src/public-projection";
import { computePublicStats } from "../src/public-stats";
import { buildCantonPage, buildPlacePage, buildStatsPage, placeIsIndexable, type PlacePageInput } from "../src/seo-data-pages";
import { cantonByCode } from "../src/swiss-cantons";

type AggregateRow = Parameters<typeof computePublicStats>[0][number];

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

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
    received_at: "2026-10-20T06:10:00.000Z",
    started_at: "2026-10-20T06:00:00.000Z",
    resolved_at: "2026-10-20T07:00:00.000Z",
    expected_restore_at: null,
    duration_minutes: 60,
    sort_bucket: 1,
    sort_at: "2026-10-20T06:00:00.000Z",
    latitude: null,
    longitude: null,
    places_key: "brugg:AG",
    source_updated_at: "2026-10-20T07:05:00.000Z",
    ...patch
  };
}

const aggregate = (patch: Partial<LiteRow> = {}): AggregateRow => ({
  ...lite(patch),
  end_earliest_at: null,
  end_latest_at: null,
  active_since_at: null,
  time_confidence: null
});

function slice(patch: Partial<PublicSlice> = {}): PublicSlice {
  return {
    total: 3,
    active: 0,
    upcoming: 0,
    resolved: 3,
    planned: 1,
    unplanned: 2,
    last30Days: 1,
    lastAt: "2026-10-20T06:00:00.000Z",
    firstAt: "2026-01-10T06:00:00.000Z",
    medianDurationMinutes: 60,
    knownDurations: 2,
    ...patch
  };
}

function placeInput(patch: Partial<PlacePageInput> = {}): PlacePageInput {
  return {
    slug: "brugg",
    name: "Brugg",
    canton: "AG",
    slice: slice(),
    items: [liteRowToItem(lite())],
    nearby: [["brugg", "Brugg", "AG", 3, 0, null], ["windisch", "Windisch", "AG", 2, 0, null]],
    generatedAt: "2026-11-04T11:55:00.000Z",
    ...patch
  };
}

const types = (jsonLd: unknown[]) => jsonLd.map((entry) => (entry as { "@type"?: string })["@type"]);

describe("buildStatsPage", () => {
  const stats = computePublicStats([
    aggregate({ event_id: 1 }),
    aggregate({ event_id: 2, nature: "planned", received_at: "2026-10-01T08:00:00.000Z", started_at: "2026-10-05T06:00:00.000Z", expected_restore_at: "2026-10-05T08:00:00.000Z", sort_at: "2026-10-05T06:00:00.000Z" }),
    aggregate({ event_id: 3, canton: "VD", location: "Orbe", places_key: "orbe:VD", started_at: "2026-10-28T18:00:00.000Z", resolved_at: "2026-10-28T19:30:00.000Z", sort_at: "2026-10-28T18:00:00.000Z" })
  ], { now: NOW, sources: { monitored: 20, healthy: 19 } });

  it("renders an indexable page with heading, chart and Dataset JSON-LD", () => {
    const page = buildStatsPage(stats, "de", NOW);
    expect(page.robots).toContain("index");
    expect(page.robots).not.toContain("noindex");
    expect(page.route).toEqual({ kind: "stats" });
    expect(page.nav).toBe("stats");
    expect(page.html).toContain("<h1>Stromausfall-Statistik Schweiz</h1>");
    expect(page.html).toContain("<svg");
    expect(page.html).toContain('href="/stromausfall/kanton/waadt"');
    const dataset = page.jsonLd.find((entry) => (entry as { "@type"?: string })["@type"] === "Dataset") as Record<string, unknown> | undefined;
    expect(dataset).toBeDefined();
    expect(dataset?.url).toBe("https://outage.ch/statistik/");
    expect(dataset?.dateModified).toBe(stats.generatedAt);
    expect(types(page.jsonLd)).toContain("BreadcrumbList");
  });

  it("localizes canton links on the French page", () => {
    const page = buildStatsPage(stats, "fr", NOW);
    expect(page.html).toContain('href="/fr/panne-de-courant/canton/vaud"');
  });

  it("is noindex without statistics", () => {
    const page = buildStatsPage(null, "de", NOW);
    expect(page.robots).toContain("noindex");
    expect(page.html).toContain("<h1>");
    expect(types(page.jsonLd)).not.toContain("Dataset");
  });
});

describe("buildPlacePage", () => {
  it("noindexes a place with a single report older than 90 days", () => {
    const page = buildPlacePage(placeInput({ slice: slice({ total: 1, lastAt: "2026-06-01T06:00:00.000Z" }) }), "de", NOW);
    expect(page.robots).toContain("noindex");
  });

  it("indexes a place with several reports", () => {
    const page = buildPlacePage(placeInput(), "de", NOW);
    expect(page.robots).not.toContain("noindex");
    expect(page.route).toEqual({ kind: "place", slug: "brugg" });
    expect(page.title.length).toBeLessThanOrEqual(62);
    expect(page.title).toContain("Brugg");
    expect(page.description.length).toBeLessThanOrEqual(158);
    expect(page.html).toContain("Stromausfall Brugg");
    expect(page.html).toContain('href="/stromausfall/windisch"');
    // The page itself is not listed as its own neighbour.
    expect(page.html).not.toContain('href="/stromausfall/brugg"');
    expect(types(page.jsonLd)).toEqual(expect.arrayContaining(["BreadcrumbList", "CollectionPage", "FAQPage"]));
    const faq = page.jsonLd.find((entry) => (entry as { "@type"?: string })["@type"] === "FAQPage") as { mainEntity: unknown[] };
    expect(faq.mainEntity).toHaveLength(3);
  });

  it("clamps long titles to 62 characters", () => {
    const name = "Oberhinterwilerberg bei Unterniederdorf am Schattenhang";
    const page = buildPlacePage(placeInput({ name, slug: "oberhinterwilerberg" }), "de", NOW);
    expect(page.title.length).toBeLessThanOrEqual(62);
    expect(page.title.endsWith("…")).toBe(true);
  });

  it("escapes place names in the HTML", () => {
    const page = buildPlacePage(placeInput({ name: "<Brugg & Co>" }), "de", NOW);
    expect(page.html).not.toContain("<Brugg");
    expect(page.html).toContain("&lt;Brugg &amp; Co&gt;");
  });

  it("indexes a single recent or currently active report", () => {
    expect(placeIsIndexable({ total: 1, lastAt: "2026-10-01T00:00:00.000Z", active: 0, upcoming: 0 }, NOW)).toBe(true);
    expect(placeIsIndexable({ total: 1, lastAt: "2026-01-01T00:00:00.000Z", active: 1, upcoming: 0 }, NOW)).toBe(true);
    expect(placeIsIndexable({ total: 1, lastAt: null, active: 0, upcoming: 0 }, NOW)).toBe(false);
  });
});

describe("buildCantonPage", () => {
  const input = {
    canton: cantonByCode("VD")!,
    slice: slice(),
    items: [liteRowToItem(lite({ location: "Orbe", canton: "VD" }))],
    places: [["orbe", "Orbe", "VD", 2, 0, null]] as PlacePageInput["nearby"],
    operators: [{ slug: "romande-energie", name: "Romande Energie", count: 2 }],
    generatedAt: "2026-11-04T11:55:00.000Z"
  };

  it("uses the localized canton name and slug", () => {
    const fr = buildCantonPage(input, "fr", NOW);
    expect(fr.title).toContain("Vaud");
    expect(fr.title.length).toBeLessThanOrEqual(62);
    expect(fr.route).toEqual({ kind: "canton", slug: "vaud" });
    expect(fr.robots).not.toContain("noindex");
    const de = buildCantonPage(input, "de", NOW);
    expect(de.title).toContain("Waadt");
    expect(de.route).toEqual({ kind: "canton", slug: "waadt" });
  });

  it("is noindex for a canton without reports", () => {
    expect(buildCantonPage({ ...input, slice: slice({ total: 0 }) }, "de", NOW).robots).toContain("noindex");
  });
});
