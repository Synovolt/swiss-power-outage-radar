import { describe, expect, it } from "vitest";
import { SINGLE_CANTON_OPERATORS } from "../src/incidents";
import { isNonElectricNotice, swissPlacesOnly } from "../src/operator-records";
import { choosePublicLocation, fallbackLocationQueries, type GeoAdminSearchResult } from "../src/public-detail";
import { derivePublicPlaces } from "../src/public-places";
import { publicDisplayLocation } from "../src/public-url";
import { REPORTED_EVENT_MAX_AGE_MS, toPublicFeedItem } from "../src/publication";
import { explicitLocation } from "../src/source-adapters";
import type { OutageEvent, PublicationDecision } from "../src/types";

function result(label: string, detail: string, lat: number, lon: number, origin = "gg25"): GeoAdminSearchResult {
  return { id: 1, weight: 100, attrs: { label, detail, lat, lon, origin, rank: 2 } } as GeoAdminSearchResult;
}

describe("location text from operator pages", () => {
  it("cuts sentence fragments and rejects nouns after 'in'", () => {
    expect(explicitLocation("Im Gebiet in Saanen kann es zu Unterbrüchen kommen")).toBe("Saanen");
    expect(explicitLocation("Die Anlage wurde in Betrieb genommen")).toBeNull();
    expect(explicitLocation("Stromunterbruch in Brugg seit 08:00")).toBe("Brugg");
  });

  it("treats street-lighting notices as non-electric even when they mention the grid", () => {
    expect(isNonElectricNotice("Störung. In einigen Teilen unseres Netzes kommt es aktuell zu Ausfällen der Strassen- und Quartierbeleuchtung. Die Stromversorgung ist gewährleistet.")).toBe(true);
    expect(isNonElectricNotice("Stromausfall in Wil, auch die Strassenbeleuchtung ist betroffen")).toBe(false);
  });

  it("drops French communes from Primeo place lists", () => {
    expect(swissPlacesOnly("Leymen, Folgensbourg, Hésingue, Liebenswiler, Hégenheim, Hagenthal le Bas und Hagenthal le Haut")).toBeNull();
    expect(swissPlacesOnly("Leymen, Rodersdorf")).toBe("Rodersdorf");
    expect(swissPlacesOnly("Breitenbach, Grindel")).toBe("Breitenbach, Grindel");
  });

  it("removes a leading postal code from the displayed place", () => {
    expect(publicDisplayLocation("2608 Courtelary")).toBe("Courtelary");
    expect(publicDisplayLocation("Lugano Centro")).toBe("Lugano Centro");
  });
});

describe("map pins and cantons", () => {
  it("never picks a result that shares no word with the query", () => {
    expect(choosePublicLocation("Schachenhalle", [result("<b>Trubschachen (BE)</b>", "trubschachen be", 46.92, 7.85)])).toBeNull();
  });

  it("tries the next place of the location when the first is a venue", () => {
    expect(fallbackLocationQueries("Schachenhalle, Aarau, Aargau")).toEqual(["Aarau"]);
    expect(fallbackLocationQueries("Brugg")).toEqual([]);
  });

  it("strips the gazetteer suffix from labels", () => {
    const location = choosePublicLocation("Valcolla", [result("<b>Valcolla</b> # 6951 Signôra", "valcolla", 46.08, 9.0, "gazetteer")]);
    expect(location?.label).toBe("Valcolla");
  });

  it("lets a canton named in the location beat the canton of the pin", () => {
    const derived = derivePublicPlaces({ location: "Schachenhalle, Aarau, Aargau", label: "Trubschachen (BE)", precision: "municipality" });
    expect(derived.canton).toBe("AG");
    expect(derived.places.map((place) => place.slug)).not.toContain("trubschachen");
  });

  it("knows the canton of single-canton operators", () => {
    expect(SINGLE_CANTON_OPERATORS["AIL"]).toBe("TI");
    expect(SINGLE_CANTON_OPERATORS["AIM Mendrisio"]).toBe("TI");
    expect(SINGLE_CANTON_OPERATORS["ewl Luzern"]).toBe("LU");
  });
});

describe("single media reports", () => {
  const received = "2026-11-03T16:22:00.000Z";
  const event = {
    id: 1265, title: "Stromausfall in der Schachenhalle", status: "needs_review", event_type: "power_outage",
    location_text: "Schachenhalle, Aarau, Aargau", normalized_location: "schachenhalle aarau aargau", canton: null, country: "CH",
    first_seen_at: received, last_seen_at: received, received_at: received, started_at_estimate: null,
    resolved_at_estimate: null, expected_restore_at: null, summary: "Stromausfall in der Schachenhalle.", outage_nature: "unplanned"
  } as unknown as OutageEvent;
  const decision: PublicationDecision = {
    publishable: true, trust: "reported", reasons: [], summary: "Stromausfall in der Schachenhalle.",
    primary_source: { publisher: "aargauerzeitung.ch", url: "https://www.aargauerzeitung.ch/a", domain: "aargauerzeitung.ch" }
  };

  it("stop counting as active after six hours without a new confirmation", () => {
    const at = Date.parse(received);
    expect(toPublicFeedItem(event, decision, [], at + REPORTED_EVENT_MAX_AGE_MS - 60_000)?.status).toBe("active");
    expect(toPublicFeedItem(event, decision, [], at + REPORTED_EVENT_MAX_AGE_MS + 60_000)?.status).not.toBe("active");
    expect(toPublicFeedItem(event, { ...decision, trust: "official" }, [], at + REPORTED_EVENT_MAX_AGE_MS + 60_000)?.status).toBe("active");
  });
});
