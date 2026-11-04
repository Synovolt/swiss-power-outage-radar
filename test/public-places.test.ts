import { describe, expect, it } from "vitest";
import { derivePublicPlaces, placesKey } from "../src/public-places";

const slugs = (location: string, extra: Partial<Parameters<typeof derivePublicPlaces>[0]> = {}) =>
  derivePublicPlaces({ location, ...extra }).places.map((place) => place.slug);

describe("derivePublicPlaces", () => {
  it("reads a two-letter canton suffix", () => {
    expect(derivePublicPlaces({ location: "Brugg AG" })).toEqual({
      places: [{ slug: "brugg-ag", name: "Brugg", canton: "AG" }],
      canton: "AG"
    });
  });

  it("treats a trailing canton name as context, not as a place", () => {
    expect(derivePublicPlaces({ location: "Brugg, Aargau" })).toEqual({
      places: [{ slug: "brugg-ag", name: "Brugg", canton: "AG" }],
      canton: "AG"
    });
  });

  it("splits a list of municipalities and applies the trailing canton to all of them", () => {
    const result = derivePublicPlaces({ location: "Egliswil, Lenzburg, Seengen, Seon, Aargau" });
    expect(result.canton).toBe("AG");
    expect(result.places.map((place) => place.slug)).toEqual(["egliswil-ag", "lenzburg-ag", "seengen-ag", "seon-ag"]);
    expect(result.places.every((place) => place.canton === "AG")).toBe(true);
  });

  it("keeps a single city that shares its canton's name as a place in that canton", () => {
    expect(derivePublicPlaces({ location: "Bern" })).toEqual({
      places: [{ slug: "bern-be", name: "Bern", canton: "BE" }],
      canton: "BE"
    });
  });

  it("treats an explicit 'Kanton X' as canton context only", () => {
    expect(derivePublicPlaces({ location: "Kanton Bern" })).toEqual({ places: [], canton: "BE" });
  });

  it("uses a precise geo.admin label as the place", () => {
    const result = derivePublicPlaces({ location: "Chavornay", label: "Chavornay (VD)", precision: "municipality" });
    expect(result).toEqual({ places: [{ slug: "chavornay-vd", name: "Chavornay", canton: "VD" }], canton: "VD" });
  });

  it("takes the canton from an imprecise label but not the place", () => {
    const result = derivePublicPlaces({ location: "Orbe", label: "Jura-Nord vaudois (VD)", precision: "district" });
    expect(result.canton).toBe("VD");
    expect(result.places.map((place) => place.slug)).toEqual(["orbe-vd"]);
  });

  it("drops generic country-level locations", () => {
    expect(derivePublicPlaces({ location: "Schweiz" })).toEqual({ places: [], canton: null });
    expect(slugs("Suisse")).toEqual([]);
  });

  it("never produces slugs ending in -<digits> that would collide with event URLs", () => {
    const result = slugs("Zürich 8, Winterthur 2, Bülach 12");
    expect(result).toEqual(["zurich", "winterthur", "bulach"]);
    for (const slug of result) expect(slug).not.toMatch(/-\d+$/);
  });

  it("strips postcodes and prefixes like 'Gemeinde'", () => {
    expect(slugs("5200 Brugg, Gemeinde Windisch")).toEqual(["brugg", "windisch"]);
  });

  it("deduplicates and caps the list at 12 places", () => {
    const names = Array.from({ length: 15 }, (_, index) => `Weiler ${String.fromCharCode(65 + index)}`);
    const result = slugs([...names, "Weiler A"].join(", "));
    expect(result).toHaveLength(12);
    expect(new Set(result).size).toBe(12);
    expect(result[0]).toBe("weiler-a");
  });

  it("keeps the event canton when no other canton hint exists", () => {
    const result = derivePublicPlaces({ location: "Wohlen", eventCanton: "ag" });
    expect(result).toEqual({ places: [{ slug: "wohlen-ag", name: "Wohlen", canton: "AG" }], canton: "AG" });
  });
});

describe("placesKey", () => {
  it("serializes slug:canton pairs joined by |", () => {
    expect(placesKey([
      { slug: "brugg", name: "Brugg", canton: "AG" },
      { slug: "orbe", name: "Orbe", canton: null }
    ])).toBe("brugg:AG|orbe:");
    expect(placesKey([])).toBe("");
  });
});
