import { describe, expect, it } from "vitest";
import { derivePublicPlaces } from "../src/public-places";
import { buildStatsPage } from "../src/seo-data-pages";
import { computePublicStats } from "../src/public-stats";
import { cantonByName } from "../src/swiss-cantons";

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
});
