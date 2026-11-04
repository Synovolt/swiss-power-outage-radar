import { SITE_ORIGIN, absoluteUrl, DEFAULT_OG_IMAGE_PATH, toSitemapLastmod } from "./public-url";
import { knowledgeArticles, knowledgeArticleUrl } from "./knowledge";
import { publicOperatorProfiles } from "./operators";
import { cantonByCode, cantonSlug } from "./swiss-cantons";
import {
  APP_LOCALES,
  HTML_LANG,
  homeFaqs as faqsForLocale,
  hreflangEntries,
  localizeStoredEventUrl,
  pathFor,
  t,
  type AppLocale,
  type AppRoute
} from "./i18n";

export const SITE_NAME = "outage.ch";
export const SITE_DESCRIPTION =
  "Unabhängiger Radar für aktuelle und geplante Stromausfälle in der Schweiz. Quellenbasiert, ohne erfundene Endzeiten, kein offizieller Notfallkanal.";

export function siteDescription(locale: AppLocale = "de"): string {
  return t(locale, "site.description");
}

export const ABOUT_PATH = "/ueber/";
export const OPERATORS_HUB_PATH = "/netzbetreiber/";
export const GUIDES_HUB_PATH = "/ratgeber/";
export const STATIC_CONTENT_UPDATED_AT = "2026-08-18";

export const homeFaqs = faqsForLocale("de");
export const localizedHomeFaqs = faqsForLocale;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function organizationId(origin = SITE_ORIGIN): string {
  return `${origin}/#organization`;
}

export function websiteId(origin = SITE_ORIGIN): string {
  return `${origin}/#website`;
}

export function siteGraph(origin = SITE_ORIGIN, locale: AppLocale = "de") {
  const logo = absoluteUrl(DEFAULT_OG_IMAGE_PATH, origin);
  return [
    {
      "@type": "Organization",
      "@id": organizationId(origin),
      name: SITE_NAME,
      url: `${origin}/`,
      description: siteDescription(locale),
      email: "alert@outage.ch",
      areaServed: { "@type": "Country", name: "Switzerland" },
      knowsAbout: ["Stromausfall", "Stromunterbruch", "Verteilnetz Schweiz"],
      logo: { "@type": "ImageObject", url: logo },
      image: logo
    },
    {
      "@type": "WebSite",
      "@id": websiteId(origin),
      url: `${origin}/`,
      name: SITE_NAME,
      description: siteDescription(locale),
      inLanguage: HTML_LANG[locale],
      publisher: { "@id": organizationId(origin) }
    }
  ];
}

export function siteJsonLd(origin = SITE_ORIGIN, locale: AppLocale = "de"): string {
  return JSON.stringify({ "@context": "https://schema.org", "@graph": siteGraph(origin, locale) });
}

export function homeJsonLd(origin = SITE_ORIGIN, locale: AppLocale = "de"): string {
  const home = `${origin}${pathFor({ kind: "home" }, locale)}`;
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      ...siteGraph(origin, locale),
      {
        "@type": "WebPage",
        "@id": `${home}#webpage`,
        url: home,
        name: t(locale, "site.homeH1"),
        description: siteDescription(locale),
        inLanguage: HTML_LANG[locale],
        isPartOf: { "@id": websiteId(origin) },
        about: { "@id": organizationId(origin) },
        mainEntity: { "@id": `${home}#faq` }
      },
      {
        "@type": "FAQPage",
        "@id": `${home}#faq`,
        mainEntity: faqsForLocale(locale).map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: { "@type": "Answer", text: faq.answer }
        }))
      }
    ]
  });
}

export function buildRobotsTxt(origin = SITE_ORIGIN): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Content-Signal: search=yes,ai-input=yes,ai-train=no,use=reference",
    "",
    "User-agent: Googlebot",
    "Allow: /",
    "",
    "User-agent: GPTBot",
    "Allow: /",
    "",
    "User-agent: ChatGPT-User",
    "Allow: /",
    "",
    "User-agent: PerplexityBot",
    "Allow: /",
    "",
    "User-agent: ClaudeBot",
    "Allow: /",
    "",
    "User-agent: anthropic-ai",
    "Allow: /",
    "",
    "User-agent: Google-Extended",
    "Allow: /",
    "",
    "User-agent: Bingbot",
    "Allow: /",
    "",
    "User-agent: CCBot",
    "Disallow: /",
    "",
    "User-agent: Bytespider",
    "Disallow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    ""
  ].join("\n");
}

export function buildLlmsTxt(origin = SITE_ORIGIN): string {
  const guides = knowledgeArticles
    .map((article) => `- [${article.shortTitle}](${origin}${knowledgeArticleUrl(article)}): ${article.description}`)
    .join("\n");
  return `# outage.ch

> Unabhängiger öffentlicher Radar für Stromausfälle und geplante Stromunterbrüche in der Schweiz.

outage.ch sammelt öffentlich zugängliche Meldungen von Verteilnetzbetreibern, Behörden und Medien. Die Seite ist kein offizieller Notfallkanal, kein Pikettdienst und nimmt keine Störungsmeldungen entgegen. Fehlende Endzeiten oder Ursachen werden als offen gekennzeichnet und nicht geschätzt.

## Wichtig für Zitate

- Verbindlich ist immer der zuständige Verteilnetzbetreiber, nicht der Stromlieferant und nicht outage.ch.
- Öffentlich wird nur, was eine offizielle Quelle oder mindestens zwei unabhängige glaubwürdige Quellen belegt.
- Ein Stromausfall ist lokal oder regional. Eine Strommangellage oder ein Blackout ist etwas anderes.
- Bei Lebensgefahr, Feuer oder herunterhängenden Leitungen gelten 112 bzw. die offiziellen Alarmierungswege.

## Seiten

- [Aktuelle Stromausfälle](${origin}/): Karte und Liste mit Status, Ort und Quellen
- [Ratgeber](${origin}${GUIDES_HUB_PATH}): praktische Anleitungen für Haushalt und Betrieb
- [Netzbetreiber](${origin}${OPERATORS_HUB_PATH}): beobachtete Verteilnetzbetreiber, offizielle Störungsseiten und öffentliche Meldezahlen im Radar
- [Statistik](${origin}/statistik/): Auswertung aller öffentlichen Meldungen nach Woche, Uhrzeit, Dauer, Betreiber und Kanton
- [Orte](${origin}/stromausfall/): Stromausfälle nach Gemeinde und Kanton, je mit aktuellem Status und Verlauf
- [Öffentliche Daten](${origin}/api/public/stats.json): Statistik als JSON; Meldungen unter /api/public/events
- [Methodik](${origin}${ABOUT_PATH}): Quellenregeln, Veröffentlichung und Grenzen

## Ratgeber

${guides}

## Optional

- [llms.txt](${origin}/llms.txt)
`;
}

export const SITEMAP_INDEX_PATH = "/sitemap.xml";
export const SITEMAP_PAGES_PATH = "/sitemap-pages.xml";
export const SITEMAP_EVENTS_PATH = "/sitemap-events.xml";
export const SITEMAP_PLACES_PATH = "/sitemap-places.xml";

export type SitemapPlaceItem = { slug: string; lastAt: string | null };
export type SitemapCantonItem = { code: string; lastAt: string | null };

const SITEMAP_LASTMOD_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const STORED_EVENT_PATH_RE = /^\/stromausfall\/[a-z0-9-]+-\d+\/?$/;

export type SitemapEntry = {
  loc: string;
  lastmod?: string;
  alternates?: Array<{ hreflang: string; href: string }>;
};

export type SitemapEventItem = {
  url: string;
  updated_at: string;
};

function asLastmodMap(value: Map<string, string> | Record<string, string>): Map<string, string> {
  return value instanceof Map ? value : new Map(Object.entries(value));
}

export function sitemapLastmodValue(value: string | null | undefined): string | undefined {
  const lastmod = toSitemapLastmod(value);
  return lastmod && SITEMAP_LASTMOD_RE.test(lastmod) ? lastmod : undefined;
}

export function latestSitemapLastmod(values: Array<string | null | undefined>): string | undefined {
  return values
    .map((value) => sitemapLastmodValue(value))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function alternatesFor(path: string, origin: string): Array<{ hreflang: string; href: string }> {
  const seen = new Set<string>();
  return hreflangEntries(path, origin).flatMap((entry) => {
    if (seen.has(entry.hreflang)) return [];
    seen.add(entry.hreflang);
    return [{ hreflang: entry.hreflang, href: entry.href }];
  });
}

function localizedStaticPages(route: AppRoute, lastmod: string | undefined, origin: string): SitemapEntry[] {
  return APP_LOCALES.map((locale) => {
    const path = pathFor(route, locale);
    return { loc: `${origin}${path}`, lastmod, alternates: alternatesFor(path, origin) };
  });
}

export function staticIndexablePages(
  origin = SITE_ORIGIN,
  operatorLastmods: Map<string, string> | Record<string, string> = new Map(),
  latestContentAt?: string
): SitemapEntry[] {
  const lastmods = asLastmodMap(operatorLastmods);
  const guideUpdated = latestSitemapLastmod(knowledgeArticles.map((article) => article.updatedAt))
    ?? STATIC_CONTENT_UPDATED_AT;
  const hubLastmod = latestSitemapLastmod([...lastmods.values()]) ?? STATIC_CONTENT_UPDATED_AT;
  const homeLastmod = latestSitemapLastmod([latestContentAt, hubLastmod, STATIC_CONTENT_UPDATED_AT])
    ?? STATIC_CONTENT_UPDATED_AT;
  return [
    ...localizedStaticPages({ kind: "home" }, homeLastmod, origin),
    ...localizedStaticPages({ kind: "about" }, STATIC_CONTENT_UPDATED_AT, origin),
    ...localizedStaticPages({ kind: "guides" }, guideUpdated, origin),
    ...localizedStaticPages({ kind: "operators" }, hubLastmod, origin),
    ...knowledgeArticles.map((article) => {
      const path = knowledgeArticleUrl(article);
      return {
        loc: `${origin}${path}`,
        lastmod: sitemapLastmodValue(article.updatedAt) ?? article.updatedAt,
        alternates: alternatesFor(path, origin)
      };
    }),
    ...publicOperatorProfiles().flatMap((operator) =>
      localizedStaticPages(
        { kind: "operator", slug: operator.slug },
        sitemapLastmodValue(lastmods.get(operator.slug)) ?? STATIC_CONTENT_UPDATED_AT,
        origin
      )
    )
  ];
}

export function eventIndexablePages(
  events: SitemapEventItem[],
  origin = SITE_ORIGIN
): SitemapEntry[] {
  return [...events]
    .filter((item) => STORED_EVENT_PATH_RE.test(item.url))
    .sort((left, right) => {
      const lastmod = (latestSitemapLastmod([right.updated_at]) ?? "").localeCompare(
        latestSitemapLastmod([left.updated_at]) ?? ""
      );
      return lastmod !== 0 ? lastmod : left.url.localeCompare(right.url);
    })
    .flatMap((item) => {
      const lastmod = sitemapLastmodValue(item.updated_at);
      return APP_LOCALES.map((locale) => {
        const path = localizeStoredEventUrl(item.url, locale);
        return {
          loc: `${origin}${path}`,
          lastmod,
          alternates: alternatesFor(path, origin)
        };
      });
    });
}

function lastmodXml(value: string | undefined): string {
  const lastmod = sitemapLastmodValue(value);
  return lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : "";
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const seen = new Set<string>();
  const body = entries
    .filter((entry) => {
      if (!entry.loc.startsWith("http") || seen.has(entry.loc)) return false;
      seen.add(entry.loc);
      return true;
    })
    .map((entry) => {
      const seenHreflang = new Set<string>();
      const links = (entry.alternates ?? [])
        .filter((alternate) => {
          if (!alternate.hreflang || !alternate.href || seenHreflang.has(alternate.hreflang)) return false;
          seenHreflang.add(alternate.hreflang);
          return true;
        })
        .map((alternate) =>
          `<xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}"/>`
        )
        .join("");
      return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmodXml(entry.lastmod)}${links}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>`;
}

export function buildSitemapIndexXml(sitemaps: Array<{ loc: string; lastmod?: string }>): string {
  const seen = new Set<string>();
  const body = sitemaps
    .filter((entry) => {
      if (!entry.loc.startsWith("http") || seen.has(entry.loc)) return false;
      seen.add(entry.loc);
      return true;
    })
    .map((entry) => `<sitemap><loc>${escapeXml(entry.loc)}</loc>${lastmodXml(entry.lastmod)}</sitemap>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>`;
}

/** Place hubs, canton pages and the places index (only indexable entries are passed in). */
export function placeIndexablePages(
  places: SitemapPlaceItem[],
  cantons: SitemapCantonItem[],
  origin = SITE_ORIGIN
): SitemapEntry[] {
  const latest = latestSitemapLastmod([...places, ...cantons].map((item) => item.lastAt));
  return [
    ...localizedStaticPages({ kind: "places" }, latest, origin),
    ...cantons.flatMap((canton) => {
      const known = cantonByCode(canton.code);
      if (!known) return [];
      return APP_LOCALES.map((locale) => {
        const path = pathFor({ kind: "canton", slug: cantonSlug(known, locale) }, locale);
        return { loc: `${origin}${path}`, lastmod: sitemapLastmodValue(canton.lastAt), alternates: alternatesFor(path, origin) };
      });
    }),
    ...places.flatMap((place) => localizedStaticPages({ kind: "place", slug: place.slug }, sitemapLastmodValue(place.lastAt), origin))
  ];
}

export function buildPublicSitemapDocuments(input: {
  origin?: string;
  events?: SitemapEventItem[];
  operatorLastmods?: Map<string, string> | Record<string, string>;
  places?: SitemapPlaceItem[];
  cantons?: SitemapCantonItem[];
  statsLastmod?: string | null;
} = {}): { index: string; pages: string; events: string; places: string } {
  const origin = input.origin ?? SITE_ORIGIN;
  const events = input.events ?? [];
  const pageEntries = [
    ...staticIndexablePages(
      origin,
      input.operatorLastmods ?? new Map(),
      latestSitemapLastmod(events.map((item) => item.updated_at))
    ),
    ...(input.statsLastmod ? localizedStaticPages({ kind: "stats" }, sitemapLastmodValue(input.statsLastmod), origin) : [])
  ];
  const eventEntries = eventIndexablePages(events, origin);
  const placeEntries = placeIndexablePages(input.places ?? [], input.cantons ?? [], origin);
  return {
    index: buildSitemapIndexXml([
      {
        loc: `${origin}${SITEMAP_PAGES_PATH}`,
        lastmod: latestSitemapLastmod(pageEntries.map((entry) => entry.lastmod))
      },
      {
        loc: `${origin}${SITEMAP_EVENTS_PATH}`,
        lastmod: latestSitemapLastmod(eventEntries.map((entry) => entry.lastmod))
      },
      ...(placeEntries.length && (input.places?.length || input.cantons?.length) ? [{
        loc: `${origin}${SITEMAP_PLACES_PATH}`,
        lastmod: latestSitemapLastmod(placeEntries.map((entry) => entry.lastmod))
      }] : [])
    ]),
    pages: buildSitemapXml(pageEntries),
    events: buildSitemapXml(eventEntries),
    places: buildSitemapXml(placeEntries)
  };
}

export function sitemapCacheControl(pathname: string): string {
  if (pathname === SITEMAP_EVENTS_PATH) {
    return "public,max-age=60,s-maxage=300,stale-while-revalidate=600";
  }
  if (pathname === SITEMAP_PAGES_PATH || pathname === SITEMAP_PLACES_PATH) {
    return "public,max-age=300,s-maxage=1800,stale-while-revalidate=3600";
  }
  return "public,max-age=120,s-maxage=300,stale-while-revalidate=600";
}

export function isSitemapPath(pathname: string): boolean {
  return pathname === SITEMAP_INDEX_PATH || pathname === SITEMAP_PAGES_PATH || pathname === SITEMAP_EVENTS_PATH || pathname === SITEMAP_PLACES_PATH;
}
