import { describe, expect, it } from "vitest";
import { eventHreflangHrefMap, eventHreflangLinkTags, eventSeo, INDEXABLE_ROBOTS, renderEventSeoMarkup } from "../src/seo-event-page";
import { renderHomeAbout } from "../src/seo-home";
import type { PublicEventDetail } from "../src/public-detail";

function detail(): PublicEventDetail {
  return {
    item: {
      id: 42, location: "Zürich", canton: "ZH", url: "/stromausfall/zurich-42",
      received_at: "2026-07-29T08:00:00.000Z", started_at: "2026-08-02T06:00:00.000Z",
      resolved_at: "2026-08-02T08:00:00.000Z", status: "upcoming", nature: "planned",
      duration_minutes: 120, cause: "Wartungsarbeiten", affected_area: "Kreis 4",
      updated_at: "2026-07-29T09:00:00.000Z", summary: "Geplanter Unterbruch im Kreis 4.",
      trust: "official", source: { publisher: "ewz", url: "https://www.ewz.ch/", domain: "ewz.ch" }
    },
    map: null, facts: [], timeline: [], operator: null,
    sources: [{
      publisher: "ewz",
      url: "https://www.ewz.ch/",
      domain: "ewz.ch",
      role: "operator",
      title: "Geplanter Unterbruch im Kreis 4",
      published_at: "2026-07-29T07:45:00.000Z",
      excerpt: "Wegen Wartungsarbeiten wird die Versorgung im Kreis 4 vorübergehend unterbrochen.",
      facts: [{ label: "Betroffen", value: "Kreis 4", format: "text" }]
    }],
    evidence: []
  };
}

describe("SEO event page", () => {
  it("replaces the events-shell noindex with indexable robots and event hreflang", () => {
    expect(INDEXABLE_ROBOTS).toBe("index,follow,max-image-preview:large");
    expect(INDEXABLE_ROBOTS).not.toContain("noindex");
    const links = eventHreflangHrefMap("/stromausfall/zurich-42", "https://outage.ch");
    expect(links["de-CH"]).toBe("https://outage.ch/stromausfall/zurich-42");
    expect(links["fr-CH"]).toBe("https://outage.ch/fr/panne-de-courant/zurich-42");
    expect(links["it-CH"]).toBe("https://outage.ch/it/interruzione-di-corrente/zurich-42");
    expect(links["en"]).toBe("https://outage.ch/en/power-outage/zurich-42");
    expect(links["x-default"]).toBe("https://outage.ch/stromausfall/zurich-42");
    expect(Object.values(links).some((href) => href.includes("/events/"))).toBe(false);
    expect(Object.keys(links).sort()).toEqual(["de-CH", "en", "fr-CH", "it-CH", "x-default"]);
    const tags = eventHreflangLinkTags("/stromausfall/zurich-42", "https://outage.ch");
    expect(tags.match(/hreflang="/g)).toHaveLength(5);
    expect(tags.match(/hreflang="de-CH"/g)).toHaveLength(1);
    expect(tags).not.toContain("/events/");
  });

  it("creates a canonical location URL and structured event data", () => {
    const seo = eventSeo(detail(), "https://outage.ch");
    expect(seo.canonical).toBe("https://outage.ch/stromausfall/zurich-42");
    expect(seo.title).toContain("Unterbruch Zürich");
    expect(seo.title.length).toBeLessThanOrEqual(60);
    expect(seo.title).not.toContain("…");
    expect(seo.description.length).toBeGreaterThanOrEqual(120);
    expect(seo.ogImage).toContain("/og-default.png");
    const graph = JSON.parse(seo.jsonLd)["@graph"];
    expect(graph.some((entry: { "@type": string }) => entry["@type"] === "Event")).toBe(true);
    expect(graph.some((entry: { "@type": string }) => entry["@type"] === "FAQPage")).toBe(true);
  });

  it("localizes event URLs and chrome without translating source quotes", () => {
    const seo = eventSeo(detail(), "https://outage.ch", "fr");
    expect(seo.canonical).toBe("https://outage.ch/fr/panne-de-courant/zurich-42");
    expect(seo.title).toContain("Interruption");
    const html = renderEventSeoMarkup(detail(), [], null, "fr");
    expect(html).toContain("<h1>Interruption électrique planifiée à Zürich</h1>");
    expect(html).toContain("Wegen Wartungsarbeiten wird die Versorgung");
    expect(html).toContain("/fr/ratgeber/");
  });

  it("keeps long compound locations readable in the title without ellipsis", () => {
    const long = detail();
    long.item.location = "Füllinsdorf, Basel-Landschaft, Schweiz";
    const seo = eventSeo(long, "https://outage.ch");
    expect(seo.title).toBe("Unterbruch Füllinsdorf, 2. Aug. 2026 | outage.ch");
    expect(seo.title).not.toContain("…");
  });

  it("strips status prose from polluted location labels before SEO copy", () => {
    const polluted = detail();
    polluted.item.location = "Behobener Stromausfall in Seewen";
    polluted.item.nature = "unplanned";
    polluted.item.status = "resolved";
    const seo = eventSeo(polluted, "http://outage.ch");
    expect(seo.canonical.startsWith("https://")).toBe(true);
    expect(seo.title).toContain("Seewen");
    expect(seo.title).not.toContain("Behobener");
    expect(renderEventSeoMarkup(polluted)).toContain("<h1>Stromausfall in Seewen</h1>");
  });

  it("renders useful location-specific copy without client JavaScript", () => {
    const html = renderEventSeoMarkup(detail());
    expect(html).toContain("<h1>Geplanter Stromunterbruch in Zürich</h1>");
    expect(html).toContain("Wartungsarbeiten");
    expect(html).toContain("Kreis 4");
    expect(html).toContain("Quellen und gemeldete Inhalte");
    expect(html).toContain("Wegen Wartungsarbeiten wird die Versorgung");
    expect(html).toContain("Häufige Fragen zu diesem Vorfall");
    expect(html).toContain("/ratgeber/stromausfall-was-tun/");
  });

  it("keeps the reported compound location while using a shorter map query", () => {
    const compound = detail();
    compound.item.location = "in Lufingen und Winkel";
    compound.map = {
      query: "Lufingen",
      label: "Lufingen (ZH)",
      latitude: 47.4818,
      longitude: 8.5948,
      precision: "municipality",
      provider: "geo.admin.ch"
    };

    const seo = eventSeo(compound, "https://outage.ch");
    expect(seo.title).toContain("Lufingen und Winkel");
    expect(renderEventSeoMarkup(compound)).toContain("in Lufingen und Winkel</h1>");
    expect(renderEventSeoMarkup(compound)).not.toContain("in in Lufingen");
  });

  it("renders a useful fallback while the interactive map is unavailable", () => {
    const mapped = detail();
    mapped.map = {
      query: "Zürich",
      label: "Zürich (ZH)",
      latitude: 47.3769,
      longitude: 8.5417,
      precision: "municipality",
      provider: "geo.admin.ch"
    };

    const html = renderEventSeoMarkup(mapped);
    expect(html).toContain("map-loading");
    expect(html).toContain("map-fallback");
    expect(html).toContain("Zürich (ZH)");
    expect(html).toContain("Karte wird geladen");
  });

  it("puts the reported start and latest confirmation ahead of the detail title without inventing a duration", () => {
    const active = detail();
    active.item.status = "active";
    active.item.started_at = "2026-07-29T06:00:00.000Z";
    active.item.resolved_at = null;
    active.item.duration_minutes = null;
    active.item.active_since_at = "2026-07-29T06:00:00.000Z";
    active.item.active_since_is_minimum = false;
    active.item.last_confirmed_active_at = "2026-07-29T09:00:00.000Z";

    const html = renderEventSeoMarkup(active, [], null, "de", Date.parse("2026-07-29T09:30:00.000Z"));
    expect(html).toContain("Läuft seit 3 Std. 30 Min. · Ende noch offen");
    expect(html).toContain("Zuletzt bestätigt");
    expect(html).not.toContain("<dt>Dauer</dt>");
    // The answer comes right after the title, before facts, sources and FAQ.
    expect(html.indexOf("ev-headline")).toBeGreaterThan(html.indexOf("<h1>"));
    expect(html.indexOf("ev-headline")).toBeLessThan(html.indexOf("ev-facts"));
  });

  it("distinguishes a reported resolution from an exact restoration time", () => {
    const resolved = detail();
    resolved.item.status = "resolved";
    resolved.item.resolved_at = null;
    resolved.item.duration_minutes = null;
    resolved.item.cause = null;
    resolved.item.affected_area = null;
    resolved.item.summary = "Ein Gewitter verursachte den Ausfall.";

    const html = renderEventSeoMarkup(resolved);
    expect(html).toContain("Als behoben gemeldet");
    expect(html).toContain("Behoben gemeldet · Zeitpunkt unbekannt");
    expect(html).toContain("<dt>Ende</dt><dd>Behoben gemeldet · Zeitpunkt unbekannt</dd>");
    expect(html).not.toContain("<dt>Dauer</dt>");
    expect(html).not.toContain("Ein Gewitter verursachte den Ausfall.");
  });

  it("labels a 24-hour fallback closure without claiming restoration or duration", () => {
    const closed = detail();
    closed.item.status = "resolved";
    closed.item.resolved_at = null;
    closed.item.duration_minutes = null;
    closed.item.time_confidence = "inferred";
    closed.item.last_confirmed_active_at = "2026-07-29T09:00:00.000Z";

    const html = renderEventSeoMarkup(closed);
    expect(html).toContain("Automatisch abgeschlossen");
    expect(html).toContain("Dauer unbekannt");
    expect(html).toContain("<dt>Ende</dt><dd>unbekannt</dd>");
    expect(html).not.toContain("Behoben gemeldet · Zeitpunkt unbekannt");
    expect(html).not.toContain("<dt>Dauer</dt>");
  });

  it("says 'ended between' when the end was measured between two polls", () => {
    const measured = detail();
    measured.item.status = "resolved";
    measured.item.resolved_at = null;
    measured.item.duration_minutes = null;
    measured.item.time_confidence = "inferred";
    measured.item.last_confirmed_active_at = "2026-07-29T09:00:00.000Z";
    measured.item.resolution_latest_at = "2026-07-29T09:45:00.000Z";

    const html = renderEventSeoMarkup(measured);
    expect(html).toContain("Beendet zwischen");
    expect(html).not.toContain("nicht mehr gemeldet");
    expect(html).not.toContain("<dt>Ende</dt><dd>≤");
  });

  it("links matching operators to their profile page", () => {
    const withOperator = detail();
    withOperator.operator = {
      name: "ewz",
      role: "Netzbetreiber",
      area: "Stadt Zürich",
      url: "https://www.ewz.ch/de/services/stoerungen.html",
      domain: "ewz.ch",
      profile_url: "/netzbetreiber/ewz/"
    };
    const html = renderEventSeoMarkup(withOperator);
    expect(html).toContain("/netzbetreiber/ewz/");
    expect(html).toContain("Meldungen von ewz");
    expect(html).toContain("Offizielle Seite");
  });

  it("links the operator and lists related events on the incident page", () => {
    const withOperator = detail();
    withOperator.operator = {
      name: "ewz",
      role: "Netzbetreiber",
      area: "Stadt Zürich",
      url: "https://www.ewz.ch/de/services/stoerungen.html",
      domain: "ewz.ch",
      profile_url: "/netzbetreiber/ewz/"
    };
    const live = {
      profile: {
        slug: "ewz",
        name: "ewz",
        area: "Stadt Zürich, Mittelbünden und Bergell",
        officialUrl: "https://www.ewz.ch/de/services/stoerungen.html",
        sourceCategory: "live_status" as const,
        language: "de" as const,
        checkMinutes: 10,
        sourceKey: "ewz-stoerungen"
      },
      stats: {
        total: 4,
        active: 1,
        upcoming: 1,
        resolved: 2,
        planned: 2,
        unplanned: 2,
        last30Days: 3,
        knownDurations: 1,
        medianDurationMinutes: 120,
        lastUpdatedAt: "2026-08-02T08:00:00.000Z",
        topLocations: [{ label: "Zürich", count: 3 }]
      },
      recent: [{
        ...withOperator.item,
        id: 41,
        url: "/stromausfall/seefeld-41",
        location: "Seefeld",
        status: "active" as const,
        nature: "unplanned" as const
      }]
    };
    const html = renderEventSeoMarkup(withOperator, live.recent, live);
    // Operator statistics live on the operator page; the incident page links there and lists related reports.
    expect(html).toContain("/netzbetreiber/ewz/");
    expect(html).toContain("Weitere Meldungen von ewz");
    expect(html).toContain("/stromausfall/seefeld-41");
    expect(html).toContain('class="radar-item radar-item--active"');
  });

  it("exposes crawlable homepage answers as visible content, not hidden SEO text", () => {
    const html = renderHomeAbout("de");
    expect(html).not.toContain("aria-hidden");
    expect(html).not.toContain("sr-only");
    expect(html).toContain("Was outage.ch zeigt");
    expect(html).toContain("/netzbetreiber/");
    expect(html).toContain("/statistik/");
    expect(html).toContain("/stromausfall/");
    expect(html).toContain("Ist outage.ch ein offizieller Störungsdienst?");
  });
});
