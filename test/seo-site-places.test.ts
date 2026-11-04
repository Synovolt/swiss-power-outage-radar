import { describe, expect, it } from "vitest";
import { buildPublicSitemapDocuments, placeIndexablePages } from "../src/seo-site";

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

describe("place and canton sitemap", () => {
  const docs = buildPublicSitemapDocuments({
    places: [{ slug: "brugg", lastAt: "2026-10-01T00:00:00Z" }],
    cantons: [{ code: "VD", lastAt: null }],
    statsLastmod: "2026-11-01T00:00:00Z"
  });

  it("lists localized place and canton URLs in the places sitemap", () => {
    const places = locs(docs.places);
    expect(places).toEqual(expect.arrayContaining([
      "https://outage.ch/stromausfall/",
      "https://outage.ch/stromausfall/brugg",
      "https://outage.ch/fr/panne-de-courant/brugg",
      "https://outage.ch/it/interruzione-di-corrente/brugg",
      "https://outage.ch/en/power-outage/brugg",
      "https://outage.ch/stromausfall/kanton/waadt",
      "https://outage.ch/fr/panne-de-courant/canton/vaud",
      "https://outage.ch/it/interruzione-di-corrente/cantone/vaud",
      "https://outage.ch/en/power-outage/canton/vaud"
    ]));
    expect(new Set(places).size).toBe(places.length);
    expect(docs.places).toContain('hreflang="fr-CH" href="https://outage.ch/fr/panne-de-courant/canton/vaud"');
  });

  it("adds the statistics page to the pages sitemap with its lastmod", () => {
    const pages = locs(docs.pages);
    expect(pages).toContain("https://outage.ch/statistik/");
    expect(pages).toContain("https://outage.ch/fr/statistiques/");
    expect(docs.pages).toMatch(/<loc>https:\/\/outage\.ch\/statistik\/<\/loc><lastmod>2026-11-01/);
  });

  it("references the places sitemap from the index", () => {
    expect(locs(docs.index)).toEqual(expect.arrayContaining([
      "https://outage.ch/sitemap-pages.xml",
      "https://outage.ch/sitemap-events.xml",
      "https://outage.ch/sitemap-places.xml"
    ]));
  });

  it("omits the places sitemap and the stats page when there is nothing to list", () => {
    const empty = buildPublicSitemapDocuments({});
    expect(locs(empty.index)).not.toContain("https://outage.ch/sitemap-places.xml");
    expect(locs(empty.pages)).not.toContain("https://outage.ch/statistik/");
  });

  it("skips unknown canton codes", () => {
    const entries = placeIndexablePages([], [{ code: "XX", lastAt: null }]);
    expect(entries.some((entry) => entry.loc.includes("/kanton/"))).toBe(false);
  });
});
