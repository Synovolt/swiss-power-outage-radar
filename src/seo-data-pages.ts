/**
 * Server-rendered data pages: statistics, places hub, place and canton pages.
 * All of them read the materialized projection and the precomputed caches only
 * (see src/public-projection.ts, src/public-stats.ts) and are injected into the
 * static /data-template/ shell with HTMLRewriter.
 */
import { escapeHtml, inlineJson, setMetaContent } from "./html";
import {
  DATE_LOCALE,
  alternatePath,
  formatAppDate,
  formatAppDuration,
  hreflangEntries,
  isAppLocale,
  pathFor,
  radarViewCopy,
  t,
  type AppLocale,
  type AppRoute
} from "./i18n";
import { operatorBySlug, operatorProfileUrl } from "./operators";
import { DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN, absoluteUrl } from "./public-url";
import { groupsHtml, fromPublicItem, groupItems, sortForView, rowHtml } from "./radar-view";
import { organizationId, websiteId } from "./seo-site";
import { SWISS_CANTONS, cantonByCode, cantonInText, cantonSlug, type SwissCanton } from "./swiss-cantons";
import { distributionBars, heatmapChart, sparkline, srTable, stackedBarChart } from "./svg-charts";
import type { PublicSlice } from "./public-projection";
import type { PlacesPayload, StatsPayload } from "./public-stats";
import type { Env, PublicFeedItem } from "./types";

export type DataNav = "stats" | "places";

export interface DataPage {
  locale: AppLocale;
  route: AppRoute;
  title: string;
  description: string;
  robots: string;
  jsonLd: unknown[];
  html: string;
  nav: DataNav;
}

const INDEXABLE = "index,follow,max-image-preview:large";
const NOINDEX = "noindex,follow";

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trim()}…`;
}

function day(value: string | null | undefined, locale: AppLocale): string {
  return formatAppDate(value, locale, { dateStyle: "medium" }) ?? "–";
}

function dateTime(value: string | null | undefined, locale: AppLocale): string {
  return formatAppDate(value, locale, { dateStyle: "medium", timeStyle: "short" }) ?? "–";
}

function number(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(DATE_LOCALE[locale]).format(value);
}

function listJoin(values: string[], locale: AppLocale): string {
  return new Intl.ListFormat(DATE_LOCALE[locale], { style: "long", type: "conjunction" }).format(values);
}

function crumbs(locale: AppLocale, trail: Array<{ label: string; href?: string }>): { html: string; jsonLd: unknown } {
  const full = [{ label: t(locale, "data.common.home"), href: pathFor({ kind: "home" }, locale) }, ...trail];
  return {
    html: `<nav class="dp-crumbs" aria-label="${escapeHtml(t(locale, "nav.breadcrumbAria"))}"><ol>${full.map((entry, index) =>
      `<li>${entry.href && index < full.length - 1 ? `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.label)}</a>` : `<span aria-current="page">${escapeHtml(entry.label)}</span>`}</li>`
    ).join("")}</ol></nav>`,
    jsonLd: {
      "@type": "BreadcrumbList",
      itemListElement: full.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: entry.label,
        ...(entry.href ? { item: absoluteUrl(entry.href, SITE_ORIGIN) } : {})
      }))
    }
  };
}

function kpi(label: string, value: string, note?: string, tone?: string): string {
  return `<div class="kpi${tone ? ` kpi--${tone}` : ""}"><span class="kpi__label">${escapeHtml(label)}</span><strong class="kpi__value">${escapeHtml(value)}</strong>${note ? `<span class="kpi__note">${escapeHtml(note)}</span>` : ""}</div>`;
}

function card(title: string, body: string, note?: string, id?: string): string {
  return `<section class="dp-card"${id ? ` id="${escapeHtml(id)}"` : ""}><header class="dp-card__head"><h2>${escapeHtml(title)}</h2>${note ? `<p>${escapeHtml(note)}</p>` : ""}</header>${body}</section>`;
}

function hoursText(hours: number | null, locale: AppLocale): string {
  if (hours === null) return "–";
  if (hours < 48) return t(locale, "data.stats.hours", { value: Math.round(hours) });
  return t(locale, "data.stats.days", { value: Math.round(hours / 24) });
}

function minutesText(minutes: number | null, locale: AppLocale): string {
  if (minutes === null) return "–";
  return formatAppDuration(Math.round(minutes), locale) ?? "–";
}

function cantonLabel(code: string | null, locale: AppLocale): string | null {
  return code ? cantonByCode(code)?.names[locale] ?? code : null;
}

function cantonHref(canton: SwissCanton, locale: AppLocale): string {
  return pathFor({ kind: "canton", slug: cantonSlug(canton, locale) }, locale);
}

function placeHref(slug: string, locale: AppLocale): string {
  return pathFor({ kind: "place", slug }, locale);
}

function statusLine(slice: Pick<PublicSlice, "active" | "upcoming">, locale: AppLocale): string {
  const parts = [
    slice.active ? t(locale, "data.common.activeCount", { count: slice.active }) : t(locale, "data.common.noneActiveShort"),
    slice.upcoming ? t(locale, "data.common.upcomingCount", { count: slice.upcoming }) : t(locale, "data.common.noneUpcomingShort")
  ];
  return parts.join(" · ");
}

function eventLists(items: PublicFeedItem[], locale: AppLocale, now: number): string {
  const copy = radarViewCopy(locale);
  const radarItems = items.map(fromPublicItem);
  const current = sortForView(radarItems.filter((item) => item.status === "active" || item.status === "upcoming"), "now");
  const past = radarItems.filter((item) => item.status !== "active" && item.status !== "upcoming").sort((a, b) => b.sortMs - a.sortMs);
  const currentHtml = current.length
    ? `<div class="dp-list">${current.map((item) => rowHtml(item, now, copy)).join("")}</div>`
    : `<p class="dp-empty">${escapeHtml(t(locale, "data.common.noCurrent"))}</p>`;
  const historyHtml = past.length
    ? `<div class="dp-list">${groupsHtml(groupItems(past, "history", now, copy), now, copy)}</div>`
    : `<p class="dp-empty">${escapeHtml(t(locale, "data.common.noHistory"))}</p>`;
  return card(t(locale, "data.common.current"), currentHtml) + card(t(locale, "data.common.history"), historyHtml);
}

function placeLinks(places: PlacesPayload["places"], locale: AppLocale, limit = 400): string {
  if (!places.length) return "";
  return `<ul class="dp-chips">${places.slice(0, limit).map(([slug, name, , count, current]) =>
    `<li><a href="${escapeHtml(placeHref(slug, locale))}"${current ? ' class="is-live"' : ""}>${escapeHtml(name)}<span>${count}</span></a></li>`
  ).join("")}</ul>`;
}

function faqHtml(title: string, entries: Array<{ q: string; a: string }>): { html: string; jsonLd: unknown } {
  return {
    html: `<section class="dp-card dp-faq"><header class="dp-card__head"><h2>${escapeHtml(title)}</h2></header>${entries.map((entry) =>
      `<details><summary>${escapeHtml(entry.q)}</summary><p>${escapeHtml(entry.a)}</p></details>`).join("")}</section>`,
    jsonLd: {
      "@type": "FAQPage",
      mainEntity: entries.map((entry) => ({ "@type": "Question", name: entry.q, acceptedAnswer: { "@type": "Answer", text: entry.a } }))
    }
  };
}

function helpCard(locale: AppLocale): string {
  return `<aside class="dp-help"><strong>${escapeHtml(t(locale, "data.common.whatToDo"))}</strong><p>${escapeHtml(t(locale, "data.common.whatToDoText"))}</p><a href="/ratgeber/stromausfall-was-tun/">${escapeHtml(t(locale, "data.radar.guideLink"))} →</a></aside>`;
}

// ------------------------------------------------------------------ stats

export function buildStatsPage(stats: StatsPayload | null, locale: AppLocale, now = Date.now()): DataPage {
  const route: AppRoute = { kind: "stats" };
  const trail = crumbs(locale, [{ label: t(locale, "data.nav.stats") }]);
  const title = t(locale, "data.stats.title");
  const description = t(locale, "data.stats.description");
  if (!stats) {
    return {
      locale, route, title, description, robots: NOINDEX, nav: "stats",
      jsonLd: [trail.jsonLd],
      html: `<article class="dp">${trail.html}<header class="dp-head"><h1>${escapeHtml(t(locale, "data.stats.h1"))}</h1><p class="dp-lede">${escapeHtml(t(locale, "data.stats.noData"))}</p></header></article>`
    };
  }
  // Abbreviations like "3 Std." must not produce "Std.." at the end of a sentence.
  const s = (key: string, options?: Record<string, unknown>) => t(locale, `data.stats.${key}`, options).replace(/..(?=s|$)/g, ".");
  const totals = stats.totals;
  const delta = totals.last30 - totals.previous30;
  const deltaText = `${delta > 0 ? "+" : ""}${delta}`;
  const weekdays = s("weekdays").split(",");
  const weekLabels = stats.weekly.map((entry) => entry.week);
  const tickLabels = stats.weekly.map((entry, index) => index % 4 === 0
    ? new Intl.DateTimeFormat(DATE_LOCALE[locale], { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${entry.week}T00:00:00Z`))
    : "");
  const weeklyChart = stackedBarChart({
    labels: weekLabels,
    tickLabels,
    title: s("weeklyTitle"),
    series: [
      { key: "unplanned", label: s("legendUnplanned"), values: stats.weekly.map((entry) => entry.unplanned) },
      { key: "planned", label: s("legendPlanned"), values: stats.weekly.map((entry) => entry.planned) }
    ]
  });
  const legend = `<p class="chart-legend"><span class="chart-key chart-key--unplanned"></span>${escapeHtml(s("legendUnplanned"))}<span class="chart-key chart-key--planned"></span>${escapeHtml(s("legendPlanned"))}</p>`;
  const weeklyTable = srTable(s("weeklyTitle"), [s("tableWeek"), s("legendUnplanned"), s("legendPlanned")], stats.weekly.map((entry) => [entry.week, entry.unplanned, entry.planned]));

  const heat = stats.weekdayHourN >= 8
    ? heatmapChart({ matrix: stats.weekdayHour, rowLabels: weekdays, title: s("heatTitle") })
      + srTable(s("heatTitle"), ["", ...Array.from({ length: 24 }, (_, hour) => `${hour}`)], stats.weekdayHour.map((row, index) => [weekdays[index] ?? "", ...row]))
    : `<p class="dp-empty">${escapeHtml(s("noData"))}</p>`;

  const bucketLabel = (key: string) => s(`bucket.${key}`);
  const lead = stats.leadTimeHours;
  const leadBody = lead.n >= 5
    ? distributionBars({ title: s("leadTitle"), tone: "planned", buckets: lead.buckets.map((bucket) => ({ label: bucketLabel(bucket.key), count: bucket.count })) })
    : `<p class="dp-empty">${escapeHtml(s("noData"))}</p>`;
  const planned = stats.plannedDurationMinutes;
  const unplanned = stats.unplannedDurationMinutes;
  const durationBody = `<div class="dp-grid dp-grid--2">`
    + `<div><h3 class="dp-sub">${escapeHtml(s("plannedDuration"))}</h3>${planned.n >= 5
      ? distributionBars({ title: s("plannedDuration"), tone: "planned", buckets: planned.buckets.map((bucket) => ({ label: bucketLabel(bucket.key), count: bucket.count })) })
      : `<p class="dp-empty">${escapeHtml(s("noData"))}</p>`}<p class="dp-note">${escapeHtml(s("plannedDurationNote", { count: planned.n, median: minutesText(planned.median, locale) }))}</p></div>`
    + `<div><h3 class="dp-sub">${escapeHtml(s("unplannedDuration"))}</h3>${unplanned.n >= 5
      ? distributionBars({ title: s("unplannedDuration"), tone: "unplanned", buckets: unplanned.buckets.map((bucket) => ({ label: bucketLabel(bucket.key), count: bucket.count })) })
      : `<p class="dp-empty">${escapeHtml(s("noData"))}</p>`}<p class="dp-note">${escapeHtml(s("unplannedDurationNote", { exact: unplanned.exact, estimated: unplanned.estimated, median: minutesText(unplanned.median, locale) }))}</p></div>`
    + `</div>`;

  const operatorRows = stats.byOperator.slice(0, 40).map((entry) => {
    const profile = operatorBySlug(entry.slug);
    const name = profile ? `<a href="${escapeHtml(operatorProfileUrl(profile, locale))}">${escapeHtml(entry.name)}</a>` : escapeHtml(entry.name);
    return `<tr><th scope="row">${name}</th><td>${number(entry.total, locale)}</td><td>${number(entry.unplanned, locale)}</td><td>${number(entry.planned, locale)}</td><td>${number(entry.last30, locale)}</td><td class="dp-table__spark">${sparkline(entry.weekly, `${entry.name}: ${s("trend")}`)}</td></tr>`;
  }).join("");
  const operatorsTable = `<div class="dp-table-wrap"><table class="dp-table"><thead><tr><th scope="col">${escapeHtml(t(locale, "data.common.operator"))}</th><th scope="col">${escapeHtml(t(locale, "data.common.total"))}</th><th scope="col">${escapeHtml(t(locale, "data.common.unplanned"))}</th><th scope="col">${escapeHtml(t(locale, "data.common.planned"))}</th><th scope="col">${escapeHtml(t(locale, "data.common.last30"))}</th><th scope="col">${escapeHtml(s("trend"))}</th></tr></thead><tbody>${operatorRows}</tbody></table></div>`;

  const cantonMax = Math.max(1, ...stats.byCanton.map((entry) => entry.total));
  const cantonRows = stats.byCanton.filter((entry) => entry.total > 0).map((entry) => {
    const canton = cantonByCode(entry.code)!;
    return `<li><a href="${escapeHtml(cantonHref(canton, locale))}"><span class="dp-rank__label">${escapeHtml(canton.names[locale])}</span><span class="dp-rank__track"><span style="width:${((entry.total / cantonMax) * 100).toFixed(1)}%"></span></span><span class="dp-rank__value">${number(entry.total, locale)}</span></a></li>`;
  }).join("");
  const share = totals.all ? `${Math.round((totals.withCanton / totals.all) * 100)}%` : "0%";
  const placesList = stats.topPlaces.length
    ? `<ul class="dp-chips">${stats.topPlaces.map((place) => `<li><a href="${escapeHtml(placeHref(place.slug, locale))}">${escapeHtml(place.name)}<span>${place.count}</span></a></li>`).join("")}</ul>`
    : `<p class="dp-empty">${escapeHtml(s("noData"))}</p>`;

  const jsonUrl = "/api/public/stats.json";
  const method = `<section class="dp-card dp-method"><header class="dp-card__head"><h2>${escapeHtml(s("methodTitle"))}</h2></header><ul>`
    + ["method1", "method2", "method3"].map((key) => `<li>${escapeHtml(s(key))}</li>`).join("")
    + `<li>${escapeHtml(s("method4"))} <a href="${jsonUrl}">${jsonUrl}</a></li></ul>`
    + `<p class="dp-note">${escapeHtml(t(locale, "data.common.methodNote"))} <a href="${escapeHtml(pathFor({ kind: "about" }, locale))}">${escapeHtml(t(locale, "nav.about"))}</a></p></section>`;

  const html = `<article class="dp dp--stats">${trail.html}`
    + `<header class="dp-head"><h1>${escapeHtml(s("h1"))}</h1>`
    + `<p class="dp-lede">${escapeHtml(s("lede", { total: number(totals.all, locale), since: day(stats.firstAt, locale), sources: stats.sources.monitored || "–" }))}</p>`
    + `<p class="dp-meta">${escapeHtml(t(locale, "data.common.asOf", { date: dateTime(stats.generatedAt, locale) }))}</p></header>`
    + `<section class="dp-kpis">`
    + kpi(s("kpiActive"), number(totals.active, locale), undefined, totals.active ? "active" : undefined)
    + kpi(s("kpiUpcoming"), number(totals.upcoming, locale), undefined, totals.upcoming ? "upcoming" : undefined)
    + kpi(s("kpi30"), number(totals.last30, locale), s("kpi30Delta", { delta: deltaText }))
    + kpi(s("kpiMix"), `${number(totals.last30Unplanned, locale)} / ${number(totals.last30Planned, locale)}`)
    + kpi(s("kpiLead"), hoursText(lead.median, locale), s("kpiLeadNote"))
    + `</section>`
    + card(s("weeklyTitle"), `${weeklyChart}${legend}${weeklyTable}`, s("weeklyNote"))
    + `<div class="dp-grid dp-grid--2">`
    + card(s("heatTitle"), heat, s("heatNote", { count: stats.weekdayHourN }))
    + card(s("leadTitle"), leadBody, s("leadNote", { count: lead.n, median: hoursText(lead.median, locale) }))
    + `</div>`
    + card(s("durationTitle"), durationBody)
    + card(s("operatorsTitle"), operatorsTable, s("operatorsNote"))
    + `<div class="dp-grid dp-grid--2">`
    + card(s("cantonsTitle"), cantonRows ? `<ol class="dp-rank">${cantonRows}</ol>` : `<p class="dp-empty">${escapeHtml(s("noData"))}</p>`, s("cantonsNote", { share }))
    + card(s("placesTitle"), placesList)
    + `</div>`
    + method
    + `</article>`;

  const dataset = {
    "@type": "Dataset",
    "@id": `${absoluteUrl(pathFor(route, locale), SITE_ORIGIN)}#dataset`,
    name: s("datasetName"),
    description,
    url: absoluteUrl(pathFor(route, locale), SITE_ORIGIN),
    inLanguage: locale,
    isAccessibleForFree: true,
    creator: { "@id": organizationId(SITE_ORIGIN) },
    spatialCoverage: { "@type": "Place", name: "Schweiz / Suisse / Svizzera", geo: { "@type": "GeoShape", box: "45.8 5.9 47.9 10.6" } },
    temporalCoverage: `${(stats.firstAt ?? stats.generatedAt).slice(0, 10)}/..`,
    dateModified: stats.generatedAt,
    variableMeasured: ["power outages", "planned interruptions", "duration", "announcement lead time"],
    distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: absoluteUrl(jsonUrl, SITE_ORIGIN) }]
  };
  return {
    locale, route, title, description, robots: INDEXABLE, nav: "stats",
    jsonLd: [trail.jsonLd, dataset],
    html
  };
}

// ------------------------------------------------------------ places hub

export function buildPlacesHubPage(places: PlacesPayload | null, locale: AppLocale): DataPage {
  const route: AppRoute = { kind: "places" };
  const trail = crumbs(locale, [{ label: t(locale, "data.nav.places") }]);
  const list = places?.places ?? [];
  const byCanton = new Map<string, PlacesPayload["places"]>();
  for (const entry of list) {
    const key = entry[2] ?? "";
    byCanton.set(key, [...(byCanton.get(key) ?? []), entry]);
  }
  const sections = [...SWISS_CANTONS]
    .sort((a, b) => a.names[locale].localeCompare(b.names[locale], DATE_LOCALE[locale]))
    .filter((canton) => byCanton.has(canton.code))
    .map((canton) => {
      const entries = [...(byCanton.get(canton.code) ?? [])].sort((a, b) => a[1].localeCompare(b[1], DATE_LOCALE[locale]));
      return `<section class="dp-card dp-canton-block"><header class="dp-card__head"><h2><a href="${escapeHtml(cantonHref(canton, locale))}">${escapeHtml(canton.names[locale])}</a></h2><p>${escapeHtml(t(locale, "data.common.reports", { count: entries.reduce((sum, entry) => sum + entry[3], 0) }))}</p></header>${placeLinks(entries, locale)}</section>`;
    }).join("");
  const unknown = byCanton.get("") ?? [];
  const unknownHtml = unknown.length
    ? `<section class="dp-card dp-canton-block"><header class="dp-card__head"><h2>${escapeHtml(t(locale, "data.common.unknownCanton"))}</h2></header>${placeLinks([...unknown].sort((a, b) => a[1].localeCompare(b[1], DATE_LOCALE[locale])), locale)}</section>`
    : "";
  const html = `<article class="dp">${trail.html}<header class="dp-head"><h1>${escapeHtml(t(locale, "data.places.h1"))}</h1>`
    + `<p class="dp-lede">${escapeHtml(t(locale, "data.places.lede", { places: number(list.length, locale) }))}</p></header>`
    + `<div class="dp-columns">${sections}${unknownHtml}</div></article>`;
  return {
    locale, route,
    title: t(locale, "data.places.title"),
    description: t(locale, "data.places.description"),
    robots: list.length ? INDEXABLE : NOINDEX,
    nav: "places",
    jsonLd: [trail.jsonLd, { "@type": "CollectionPage", name: t(locale, "data.places.h1"), url: absoluteUrl(pathFor(route, locale), SITE_ORIGIN), isPartOf: { "@id": websiteId(SITE_ORIGIN) } }],
    html
  };
}

// ------------------------------------------------------------------ place

export interface PlacePageInput {
  slug: string;
  name: string;
  canton: string | null;
  slice: PublicSlice;
  items: PublicFeedItem[];
  nearby: PlacesPayload["places"];
  generatedAt: string;
}

export function placeIsIndexable(slice: Pick<PublicSlice, "total" | "lastAt" | "active" | "upcoming">, now = Date.now()): boolean {
  if (slice.total >= 2 || slice.active || slice.upcoming) return true;
  const last = slice.lastAt ? new Date(slice.lastAt).getTime() : NaN;
  return Number.isFinite(last) && now - last <= 90 * 24 * 60 * 60 * 1000;
}

export function buildPlacePage(input: PlacePageInput, locale: AppLocale, now = Date.now()): DataPage {
  const route: AppRoute = { kind: "place", slug: input.slug };
  const p = (key: string, options?: Record<string, unknown>) => t(locale, `data.place.${key}`, { place: input.name, ...options });
  const canton = input.canton ? cantonByCode(input.canton) : null;
  const cantonName = canton?.names[locale] ?? null;
  const cantonSuffix = cantonName ? ` (${cantonName})` : "";
  const trailEntries: Array<{ label: string; href?: string }> = [{ label: t(locale, "data.nav.places"), href: pathFor({ kind: "places" }, locale) }];
  if (canton) trailEntries.push({ label: canton.names[locale], href: cantonHref(canton, locale) });
  trailEntries.push({ label: input.name });
  const trail = crumbs(locale, trailEntries);
  const slice = input.slice;
  const operators = [...new Set(input.items.map((item) => item.operator_name ?? item.source.publisher).filter(Boolean))].slice(0, 4);
  const since = day(slice.firstAt, locale);
  const live = slice.active > 0;
  const statusText = live ? t(locale, "data.common.activeCount", { count: slice.active }) : t(locale, "data.common.noneActive");
  const faq = faqHtml(p("faqHeading"), [
    { q: p("faqToday"), a: live ? p("faqTodayYes", { status: statusText }) : p("faqTodayNo", { date: dateTime(input.generatedAt, locale) }) },
    { q: p("faqWho"), a: operators.length ? p("faqWhoKnown", { operators: listJoin(operators, locale) }) : p("faqWhoUnknown") },
    { q: p("faqHow"), a: p("faqHowAnswer", { since, count: slice.total, unplanned: slice.unplanned, planned: slice.planned }) }
  ]);
  const nearby = input.nearby.filter(([slug]) => slug !== input.slug).slice(0, 18);
  const title = clamp(p("title"), 62);
  const html = `<article class="dp dp--place">${trail.html}`
    + `<header class="dp-head"><p class="dp-live dp-live--${live ? "active" : slice.upcoming ? "upcoming" : "calm"}"><i aria-hidden="true"></i>${escapeHtml(statusLine(slice, locale))}</p>`
    + `<h1>${escapeHtml(p("h1"))}</h1>`
    + `<p class="dp-lede">${escapeHtml(p("lede", { count: slice.total, cantonSuffix, since }))}${operators.length ? ` ${escapeHtml(p("ledeOperators", { operators: listJoin(operators, locale) }))}` : ""}</p>`
    + `<p class="dp-meta">${escapeHtml(t(locale, "data.common.asOf", { date: dateTime(input.generatedAt, locale) }))} · <a href="${escapeHtml(pathFor({ kind: "home" }, locale))}">${escapeHtml(t(locale, "data.common.showOnRadar"))}</a></p></header>`
    + `<section class="dp-kpis">`
    + kpi(t(locale, "data.common.total"), number(slice.total, locale))
    + kpi(t(locale, "data.common.unplanned"), number(slice.unplanned, locale))
    + kpi(t(locale, "data.common.planned"), number(slice.planned, locale))
    + kpi(t(locale, "data.common.lastReport"), day(slice.lastAt, locale))
    + `</section>`
    + eventLists(input.items, locale, now)
    + faq.html
    + (nearby.length ? card(canton ? p("nearby", { canton: cantonInText(canton, locale) }) : p("nearbyAll"), placeLinks(nearby, locale)) : "")
    + helpCard(locale)
    + `</article>`;
  const placeLd = {
    "@type": "CollectionPage",
    name: p("h1"),
    url: absoluteUrl(pathFor(route, locale), SITE_ORIGIN),
    isPartOf: { "@id": websiteId(SITE_ORIGIN) },
    about: {
      "@type": "Place",
      name: input.name,
      address: { "@type": "PostalAddress", addressCountry: "CH", ...(canton ? { addressRegion: canton.code } : {}) }
    },
    dateModified: input.generatedAt
  };
  return {
    locale, route, title,
    description: clamp(p("description", { count: slice.total, cantonSuffix }), 158),
    robots: placeIsIndexable(slice, now) ? INDEXABLE : NOINDEX,
    nav: "places",
    jsonLd: [trail.jsonLd, placeLd, faq.jsonLd],
    html
  };
}

// ----------------------------------------------------------------- canton

export interface CantonPageInput {
  canton: SwissCanton;
  slice: PublicSlice;
  items: PublicFeedItem[];
  places: PlacesPayload["places"];
  operators: Array<{ slug: string; name: string; count: number }>;
  generatedAt: string;
}

export function buildCantonPage(input: CantonPageInput, locale: AppLocale, now = Date.now()): DataPage {
  const name = input.canton.names[locale];
  const route: AppRoute = { kind: "canton", slug: cantonSlug(input.canton, locale) };
  const c = (key: string, options?: Record<string, unknown>) => t(locale, `data.canton.${key}`, { canton: cantonInText(input.canton, locale), ...options });
  const trail = crumbs(locale, [{ label: t(locale, "data.nav.places"), href: pathFor({ kind: "places" }, locale) }, { label: name }]);
  const slice = input.slice;
  const live = slice.active > 0;
  const operators = input.operators.length
    ? `<ul class="dp-chips">${input.operators.map((entry) => {
      const profile = operatorBySlug(entry.slug);
      return `<li>${profile ? `<a href="${escapeHtml(operatorProfileUrl(profile, locale))}">` : "<span>"}${escapeHtml(entry.name)}<span>${entry.count}</span>${profile ? "</a>" : "</span>"}</li>`;
    }).join("")}</ul>`
    : "";
  const html = `<article class="dp dp--canton">${trail.html}`
    + `<header class="dp-head"><p class="dp-live dp-live--${live ? "active" : slice.upcoming ? "upcoming" : "calm"}"><i aria-hidden="true"></i>${escapeHtml(statusLine(slice, locale))}</p>`
    + `<h1>${escapeHtml(c("h1"))}</h1>`
    + `<p class="dp-lede">${escapeHtml(c("lede", { count: slice.total, since: day(slice.firstAt, locale) }))}</p>`
    + `<p class="dp-meta">${escapeHtml(t(locale, "data.common.asOf", { date: dateTime(input.generatedAt, locale) }))} · <a href="${escapeHtml(pathFor({ kind: "stats" }, locale))}">${escapeHtml(t(locale, "data.common.viewStats"))}</a></p></header>`
    + `<section class="dp-kpis">`
    + kpi(t(locale, "data.common.total"), number(slice.total, locale))
    + kpi(t(locale, "data.common.last30"), number(slice.last30Days, locale))
    + kpi(t(locale, "data.common.unplanned"), number(slice.unplanned, locale))
    + kpi(t(locale, "data.common.planned"), number(slice.planned, locale))
    + `</section>`
    + eventLists(input.items, locale, now)
    + (input.places.length ? card(c("places"), placeLinks(input.places, locale)) : "")
    + (operators ? card(c("operators"), operators) : "")
    + helpCard(locale)
    + `</article>`;
  return {
    locale, route,
    title: clamp(c("title"), 62),
    description: clamp(c("description", { count: slice.total }), 158),
    robots: slice.total > 0 ? INDEXABLE : NOINDEX,
    nav: "places",
    jsonLd: [trail.jsonLd, {
      "@type": "CollectionPage",
      name: c("h1"),
      url: absoluteUrl(pathFor(route, locale), SITE_ORIGIN),
      isPartOf: { "@id": websiteId(SITE_ORIGIN) },
      about: { "@type": "AdministrativeArea", name, address: { "@type": "PostalAddress", addressCountry: "CH", addressRegion: input.canton.code } }
    }],
    html
  };
}

// ------------------------------------------------------------ rendering

export async function renderDataPage(
  env: Pick<Env, "ASSETS">,
  request: Request,
  page: DataPage,
  cacheControl: string
): Promise<Response> {
  const templateUrl = new URL(pathFor({ kind: "dataTemplate" }, page.locale), request.url);
  const asset = await env.ASSETS.fetch(new Request(templateUrl, request));
  const path = pathFor(page.route, page.locale);
  const canonical = absoluteUrl(path, SITE_ORIGIN);
  const indexable = !page.robots.includes("noindex");
  const hreflang = indexable
    ? hreflangEntries(path, SITE_ORIGIN).map((entry) => `<link rel="alternate" hreflang="${escapeHtml(entry.hreflang)}" href="${escapeHtml(entry.href)}">`).join("")
    : "";
  const jsonLd = inlineJson({ "@context": "https://schema.org", "@graph": page.jsonLd });
  const ogImage = absoluteUrl(DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN);
  return new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(page.title); } })
    .on('meta[name="description"]', setMetaContent(page.description))
    .on('meta[name="robots"]', setMetaContent(page.robots))
    .on('meta[property="og:title"]', setMetaContent(page.title))
    .on('meta[property="og:description"]', setMetaContent(page.description))
    .on('meta[property="og:url"]', setMetaContent(canonical))
    .on('meta[property="og:image"]', setMetaContent(ogImage))
    .on('meta[name="twitter:title"]', setMetaContent(page.title))
    .on('meta[name="twitter:description"]', setMetaContent(page.description))
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('link[rel="alternate"][hreflang]', { element(element) { element.remove(); } })
    .on("head", { element(element) { element.append(`${hreflang}<script type="application/ld+json">${jsonLd}</script>`, { html: true }); } })
    .on("nav.app-langs a[data-locale]", {
      element(element) {
        const code = element.getAttribute("data-locale");
        if (isAppLocale(code)) element.setAttribute("href", alternatePath(path, code));
      }
    })
    .on("[data-nav-id]", {
      element(element) {
        if (element.getAttribute("data-nav-id") === page.nav) element.setAttribute("aria-current", "page");
        else element.removeAttribute("aria-current");
      }
    })
    .on("#data-shell", { element(element) { element.setInnerContent(page.html, { html: true }); element.setAttribute("aria-busy", "false"); } })
    .transform(new Response(asset.body, {
      status: asset.status,
      headers: { ...Object.fromEntries(asset.headers), "Cache-Control": cacheControl }
    }));
}
