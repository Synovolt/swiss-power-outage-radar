import { describe, expect, it } from "vitest";
import { derivePublicPlaces } from "../src/public-places";
import { buildStatsPage } from "../src/seo-data-pages";
import { computePublicStats } from "../src/public-stats";
import { cantonByName } from "../src/swiss-cantons";
import { decodeFeedCursor, encodeFeedCursor, stableItemKey } from "../src/public-projection";
import { buildHomeIndex, type IndexEntry, type PublicIndexPayload, INDEX_FIELDS } from "../src/public-stats";

describe("regressions found in review", () => {
  it("keeps statistics copy intact while collapsing a doubled abbreviation dot", () => {
    const page = buildStatsPage(computePublicStats([], { now: Date.parse("2026-11-04T12:00:00Z") }), "de");
    expect(page.html).toContain("<h1>Stromausfall-Statistik Schweiz</h1>");
    expect(page.html).toContain("Aktuell aktiv");
    expect(page.html).not.toMatch(/Std\.\./);
  });

  it.each([
    ["Cantone Ticino", "TI"],
    ["Canton Vaud", "VD"],
    ["Canton of Vaud", "VD"],
    ["Kanton Baselland", "BL"],
    ["canton d'Argovie", "AG"],
    ["canton du Valais", "VS"]
  ])("reads %s as canton context, not as a place", (location, code) => {
    expect(cantonByName(location)?.code).toBe(code);
    const result = derivePublicPlaces({ location });
    expect(result.places).toEqual([]);
    expect(result.canton).toBe(code);
  });

  it("strips the French commune prefix with an elided article", () => {
    expect(derivePublicPlaces({ location: "Commune d'Ollon" }).places.map((place) => place.slug)).toEqual(["ollon"]);
    expect(derivePublicPlaces({ location: "Commune de Bex" }).places.map((place) => place.slug)).toEqual(["bex"]);
  });

  it("gives same-named municipalities in different cantons their own place page", () => {
    expect(derivePublicPlaces({ location: "Buchs AG" }).places[0]?.slug).toBe("buchs-ag");
    expect(derivePublicPlaces({ location: "Buchs SG" }).places[0]?.slug).toBe("buchs-sg");
    expect(derivePublicPlaces({ location: "Buchs" }).places[0]?.slug).toBe("buchs");
  });

  it("keeps the feed cursor inside the upcoming bucket until it is exhausted", () => {
    const upcoming = encodeFeedCursor(0, "2026-11-10T08:00:00.000Z", 42);
    expect(decodeFeedCursor(upcoming)).toEqual({ bucket: 0, sortAt: "2026-11-10T08:00:00.000Z", id: 42 });
    const past = encodeFeedCursor(1, "2026-11-01T08:00:00.000Z", 7);
    expect(decodeFeedCursor(past)).toEqual({ bucket: 1, sortAt: "2026-11-01T08:00:00.000Z", id: 7 });
    expect(decodeFeedCursor("garbage")).toBeNull();
  });

  it("does not treat a routine 'still listed' confirmation as a change", () => {
    const base = { id: 1, status: "active", updated_at: "2026-11-04 10:00:00", last_confirmed_active_at: "2026-11-04T10:00:00.000Z" };
    const sameHour = { ...base, updated_at: "2026-11-04 10:15:00", last_confirmed_active_at: "2026-11-04T10:45:00.000Z" };
    const nextHour = { ...base, last_confirmed_active_at: "2026-11-04T11:05:00.000Z" };
    const resolved = { ...base, status: "resolved" };
    expect(stableItemKey(JSON.stringify(sameHour))).toBe(stableItemKey(JSON.stringify(base)));
    expect(stableItemKey(JSON.stringify(nextHour))).not.toBe(stableItemKey(JSON.stringify(base)));
    expect(stableItemKey(JSON.stringify(resolved))).not.toBe(stableItemKey(JSON.stringify(base)));
  });

  it("embeds only what the 'now' view can show, with counts over the full index", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const min = (iso: string) => Math.round(Date.parse(iso) / 60000);
    const entry = (id: number, status: string, sortIso: string, endIso: string | null = null): IndexEntry =>
      [id, `ort-${id}`, "Ort", status, "unplanned", "BE", null, "BKW", min(sortIso), endIso ? min(endIso) : null, null, min(sortIso), null, null, ""];
    const full: PublicIndexPayload = {
      v: 1,
      generatedAt: new Date(now).toISOString(),
      fields: INDEX_FIELDS,
      items: [
        entry(1, "active", "2026-11-04T11:00:00Z"),
        entry(2, "upcoming", "2026-11-06T08:00:00Z"),
        entry(3, "resolved", "2026-11-04T06:00:00Z", "2026-11-04T08:00:00Z"),
        entry(4, "resolved", "2026-10-01T06:00:00Z", "2026-10-01T08:00:00Z")
      ]
    };
    const home = buildHomeIndex(full, now);
    expect(home.partial).toBe(true);
    expect(home.items.map((item) => item[0])).toEqual([1, 2, 3]);
    expect(home.counts).toEqual({ now: 3, planned: 1, history: 3 });
  });
});
