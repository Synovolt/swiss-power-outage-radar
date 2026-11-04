import type { Env, PublicFeedItem } from "./types";
import { escapeHtml, fetchTemplate, renderedHeaders, setMetaContent } from "./html";
import { listPublicItems, readStatsCache } from "./public-projection";
import { OPERATOR_STATS_CACHE_KEY } from "./public-stats";
import {
  ELCOM_PRICE_URL,
  elcomDatasetJsonLd,
  elcomFactsDisclaimer,
  elcomFactsForSlug,
  elcomFactsInsight,
  elcomFactsRows
} from "./elcom-operator-facts";
import {
  eventMatchesOperator,
  operatorFaqs,
  operatorLiveInsight,
  operatorProfileUrl,
  publicOperatorProfiles,
  relatedOperatorProfiles,
  sourceCategoryLabel,
  summarizeOperatorEvents,
  type OperatorLiveContext,
  type OperatorLiveStats,
  type OperatorProfile
} from "./operators";
import { DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN, absoluteUrl } from "./public-url";
import { eventRows, factsList, listCard, statusBanner, statusTitle, toneFor } from "./seo-data-pages";
import { organizationId, websiteId } from "./seo-site";
import {
  DATE_LOCALE,
  HTML_LANG,
  formatAppDate,
  formatAppDuration,
  localizeStoredEventUrl,
  parseAppPath,
  parseLocaleFromPath,
  pathFor,
  t,
  type AppLocale
} from "./i18n";

function formatDate(value: string | null | undefined, locale: AppLocale = "de"): string | null {
  return formatAppDate(value, locale, { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(minutes: number | null, locale: AppLocale = "de"): string | null {
  return formatAppDuration(minutes, locale);
}

function statusLabel(status: PublicFeedItem["status"], locale: AppLocale = "de"): string {
  if (status === "upcoming") return t(locale, "status.upcoming");
  if (status === "active") return t(locale, "status.activeShort");
  if (status === "resolved") return t(locale, "status.resolved");
  if (status === "stale_unconfirmed") return t(locale, "status.staleShort");
  if (status === "historical") return t(locale, "status.historicalShort");
  return t(locale, "status.report");
}

export async function loadOperatorLive(
  db: D1Database,
  profile: OperatorProfile,
  input: { excludeId?: number; limit?: number } = {}
): Promise<OperatorLiveContext> {
  // Statistics cover the operator's complete public record (precomputed by the
  // cron), the list only the most recent reports.
  const [cached, recent] = await Promise.all([
    readStatsCache<Record<string, OperatorLiveStats>>(db, OPERATOR_STATS_CACHE_KEY),
    listPublicItems(db, { operatorSlug: profile.slug, limit: (input.limit ?? 12) + 1, excludeId: input.excludeId })
  ]);
  const stats = cached?.payload[profile.slug]
    ?? summarizeOperatorEvents(await listPublicItems(db, { operatorSlug: profile.slug, limit: 2000 }));
  return {
    profile,
    stats,
    recent: recent.slice(0, input.limit ?? 12)
  };
}

export function parseOperatorPath(pathname: string): { hub: true; locale: AppLocale } | { hub: false; slug: string; locale: AppLocale } | null {
  const parsed = parseAppPath(pathname);
  if (!parsed) return null;
  if (parsed.route.kind === "operators") return { hub: true, locale: parsed.locale };
  if (parsed.route.kind === "operator") return { hub: false, slug: parsed.route.slug, locale: parsed.locale };
  return null;
}

export function operatorLiveTitle(operator: OperatorProfile, stats: OperatorLiveStats, locale: AppLocale = "de"): string {
  if (stats.total > 0) {
    const count = stats.total === 1
      ? t(locale, "operator.countOne")
      : t(locale, "operator.countMany", { count: stats.total });
    const title = t(locale, "operator.pageTitleLive", { name: operator.name, count });
    if (title.length <= 60) return title;
  }
  return t(locale, "operator.pageTitle", { name: operator.name });
}

export function operatorLiveDescription(operator: OperatorProfile, stats: OperatorLiveStats, locale: AppLocale = "de"): string {
  const insight = operatorLiveInsight(operator, stats, locale);
  return insight.length <= 158 ? insight : `${insight.slice(0, 157).trimEnd()}…`;
}

function statsRows(stats: OperatorLiveStats, locale: AppLocale = "de"): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    [t(locale, "operator.statsPublic"), String(stats.total)],
    [t(locale, "operator.statsActive"), String(stats.active)],
    [t(locale, "operator.statsUpcoming"), String(stats.upcoming)],
    [t(locale, "operator.statsUnplanned"), String(stats.unplanned)],
    [t(locale, "operator.statsPlanned"), String(stats.planned)],
    [t(locale, "operator.stats30"), String(stats.last30Days)]
  ];
  if (stats.medianDurationMinutes !== null && stats.knownDurations > 0) {
    rows.push([t(locale, "operator.statsMedian"), formatDuration(stats.medianDurationMinutes, locale) ?? "–"]);
  }
  return rows;
}

export function renderOperatorStatsGrid(stats: OperatorLiveStats, footnote: string, locale: AppLocale = "de"): string {
  return `<div class="stat-grid not-sw-prose">
    <dl>${statsRows(stats, locale).map(([label, value]) =>
      `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join("")}</dl>
    <p class="stat-grid__note">${escapeHtml(footnote)}</p>
  </div>`;
}

function itemLinkHtml(href: string, title: string, description: string, kicker?: string, attrs = ""): string {
  return `<a href="${escapeHtml(href)}" ${attrs} class="op-row op-row--none">
    <span class="op-row__dot" aria-hidden="true"></span>
    <span class="op-row__main">
      <span class="op-row__name">${escapeHtml(title)}</span>
      <span class="op-row__area">${kicker ? `${escapeHtml(kicker)} · ` : ""}${escapeHtml(description)}</span>
    </span>
  </a>`;
}

function radarSearchHref(query: string, locale: AppLocale): string {
  return `${pathFor({ kind: "home" }, locale)}?q=${encodeURIComponent(query)}`;
}

/**
 * Live block of an operator page: status answer first, then the current and
 * latest reports as the shared radar rows, then the counts.
 */
export function renderOperatorLiveSection(live: OperatorLiveContext, locale: AppLocale = "de"): string {
  const { profile, stats, recent } = live;
  const insight = operatorLiveInsight(profile, stats, locale);
  const rows = eventRows(recent, locale, Date.now());
  const updated = formatDate(stats.lastUpdatedAt, locale);
  const banner = statusBanner({
    tone: toneFor(stats.active, stats.upcoming),
    kicker: t(locale, "operator.liveHeading"),
    title: statusTitle(stats, locale, t(locale, "data.common.operatorCalm", { name: profile.name })),
    detail: [
      stats.total ? t(locale, "data.common.reportsShort", { count: stats.total }) : t(locale, "data.common.noReports"),
      updated ? t(locale, "operator.liveUpdated", { date: updated }).replace(/\.$/, "") : null
    ].filter(Boolean).join(" · "),
    actions: [
      { href: profile.officialUrl, label: t(locale, "data.common.official"), primary: true, external: true }
    ]
  });
  const footer = stats.total
    ? `<a href="${escapeHtml(radarSearchHref(profile.name, locale))}">${escapeHtml(t(locale, "data.common.allOperatorReports", { name: profile.name }))} →</a>`
    : undefined;
  const places = stats.topLocations.length
    ? `<p class="op-places">${escapeHtml(t(locale, "operator.livePlaces", {
      places: stats.topLocations.map((place) => `${place.label} (${place.count})`).join(", ")
    }))}</p>`
    : "";
  const lists = (rows.current ? listCard(t(locale, "data.common.current"), rows.current, { count: rows.currentCount }) : "")
    + (rows.history
      ? listCard(t(locale, "data.common.latest"), rows.history, { footer })
      : rows.current ? "" : `<p class="dp-empty">${escapeHtml(t(locale, "operator.liveNone", { name: profile.name }))}</p>`);
  const figures = stats.total
    ? `<section class="dp-card dp-card--facts"><header class="dp-card__head"><h2>${escapeHtml(t(locale, "data.common.facts"))}</h2></header>`
      + `<p class="op-insight">${escapeHtml(insight)}</p>`
      + factsList(statsRows(stats, locale).map(([label, value]) => ({ label, value })))
      + places
      + `<p class="dp-fact-note">${escapeHtml(t(locale, "operator.liveFootnote"))}</p></section>`
    : "";
  return `<section id="operator-live" class="op-live" aria-label="${escapeHtml(t(locale, "operator.liveHeading"))}">${banner}${lists}${figures}</section>`;
}

export function renderElcomFactsSection(operator: OperatorProfile, locale: AppLocale = "de"): string {
  const facts = elcomFactsForSlug(operator.slug);
  if (!facts) return "";
  const rows = elcomFactsRows(facts, locale);
  return `<section id="operator-facts" class="dp-card dp-card--facts">
    <header class="dp-card__head"><h2>${escapeHtml(t(locale, "elcom.heading"))}</h2><p>${escapeHtml(elcomFactsInsight(operator.name, facts, locale))}</p></header>
    ${factsList(rows.map(([label, value]) => ({ label, value })))}
    <p class="dp-fact-note">${escapeHtml(elcomFactsDisclaimer(locale))}</p>
    <p class="op-actions"><a class="dp-btn" href="${escapeHtml(ELCOM_PRICE_URL)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "elcom.open"))}<span aria-hidden="true">↗</span></a></p>
  </section>`;
}

export function renderOperatorRelated(operator: OperatorProfile, locale: AppLocale = "de"): string {
  const related = relatedOperatorProfiles(operator, 4);
  if (!related.length) return "";
  return `<section aria-labelledby="related-operators-heading">
    <h2 id="related-operators-heading">${escapeHtml(t(locale, "operator.relatedHeading"))}</h2>
    <div class="not-sw-prose op-list">${related.map((profile) =>
      itemLinkHtml(operatorProfileUrl(profile, locale), profile.name, profile.area, sourceCategoryLabel(profile.sourceCategory, locale))
    ).join("")}</div>
  </section>`;
}

export function renderOperatorFaqsHtml(operator: OperatorProfile, stats: OperatorLiveStats | null, locale: AppLocale = "de"): string {
  const faqs = operatorFaqs(operator, stats, locale);
  return faqs.map((faq) =>
    `<details><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`
  ).join("");
}

export function operatorPageJsonLd(
  operator: OperatorProfile,
  stats: OperatorLiveStats | null,
  origin = SITE_ORIGIN,
  locale: AppLocale = "de"
): string {
  const canonical = `${origin}${operatorProfileUrl(operator, locale)}`;
  const faqs = operatorFaqs(operator, stats, locale);
  const graph: Record<string, unknown>[] = [
    {
      "@type": "WebPage",
      "@id": `${canonical}#page`,
      url: canonical,
      name: stats ? operatorLiveTitle(operator, stats, locale) : t(locale, "operator.pageH1", { name: operator.name }),
      description: stats ? operatorLiveDescription(operator, stats, locale) : operatorLiveInsight(operator, summarizeOperatorEvents([]), locale),
      inLanguage: HTML_LANG[locale],
      isPartOf: { "@id": websiteId(origin) },
      about: {
        "@type": "Organization",
        name: operator.name,
        url: operator.officialUrl,
        areaServed: operator.area,
        sameAs: operator.officialUrl
      },
      publisher: { "@id": organizationId(origin) }
    },
    {
      "@type": "FAQPage",
      "@id": `${canonical}#faq`,
      mainEntity: faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer }
      }))
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: t(locale, "site.breadcrumbHome"), item: `${origin}${pathFor({ kind: "home" }, locale)}` },
        { "@type": "ListItem", position: 2, name: t(locale, "operator.crumb"), item: `${origin}${pathFor({ kind: "operators" }, locale)}` },
        { "@type": "ListItem", position: 3, name: operator.name, item: canonical }
      ]
    }
  ];
  const elcom = elcomFactsForSlug(operator.slug);
  if (elcom) graph.push(elcomDatasetJsonLd(operator.name, elcom, canonical, locale));
  if (stats) {
    graph.push({
      "@type": "Dataset",
      "@id": `${canonical}#dataset`,
      name: t(locale, "operator.datasetName", { name: operator.name }),
      description: t(locale, "operator.datasetDescription", { name: operator.name }),
      creator: { "@id": organizationId(origin) },
      isAccessibleForFree: true,
      license: `${origin}${pathFor({ kind: "about" }, locale)}`,
      variableMeasured: statsRows(stats, locale).map(([name, value]) => ({
        "@type": "PropertyValue",
        name,
        value
      }))
    });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

export function groupPublicItemsByOperator(items: PublicFeedItem[]): Map<string, PublicFeedItem[]> {
  const grouped = new Map<string, PublicFeedItem[]>();
  const known = new Set(publicOperatorProfiles().map((operator) => operator.slug));
  const unresolved: PublicFeedItem[] = [];
  for (const item of items) {
    // Projected items carry their operator; only legacy items still need matching.
    if (item.operator_slug !== undefined) {
      if (item.operator_slug && known.has(item.operator_slug)) {
        grouped.set(item.operator_slug, [...(grouped.get(item.operator_slug) ?? []), item]);
      }
      continue;
    }
    unresolved.push(item);
  }
  if (unresolved.length) {
    for (const operator of publicOperatorProfiles()) {
      const matched = unresolved.filter((item) => eventMatchesOperator(item, operator));
      if (matched.length) grouped.set(operator.slug, [...(grouped.get(operator.slug) ?? []), ...matched]);
    }
  }
  return grouped;
}

export function renderOperatorHubLive(
  items: PublicFeedItem[],
  locale: AppLocale = "de"
): { summary: string; list: string } {
  const grouped = groupPublicItemsByOperator(items);
  const stats: Record<string, OperatorLiveStats> = {};
  for (const operator of publicOperatorProfiles()) stats[operator.slug] = summarizeOperatorEvents(grouped.get(operator.slug) ?? []);
  return renderOperatorHubLiveFromStats(stats, locale);
}

/** Hub rendering from precomputed per-operator figures (one cached row instead of every event). */
export function renderOperatorHubLiveFromStats(
  statsBySlug: Record<string, OperatorLiveStats>,
  locale: AppLocale = "de"
): { summary: string; list: string } {
  const stat = (slug: string) => statsBySlug[slug] ?? summarizeOperatorEvents([]);
  // Live ones first (ongoing, then planned), then by number of public reports.
  const operators = [...publicOperatorProfiles()].sort((left, right) => {
    const a = stat(left.slug);
    const b = stat(right.slug);
    return (b.active - a.active)
      || (b.upcoming - a.upcoming)
      || (b.total - a.total)
      || left.name.localeCompare(right.name, DATE_LOCALE[locale]);
  });
  const withEvents = operators.filter((operator) => stat(operator.slug).total > 0).length;
  const total = operators.reduce((sum, operator) => sum + stat(operator.slug).total, 0);
  const summary = total
    ? t(locale, "operator.hubSummary", { total, withEvents })
    : t(locale, "operator.hubSummaryEmpty");
  const list = operators.map((operator) => {
    const stats = stat(operator.slug);
    const tone = stats.active ? "active" : stats.upcoming ? "upcoming" : "calm";
    const live = [
      stats.active ? t(locale, "data.common.activeShort", { count: stats.active }) : null,
      stats.upcoming ? t(locale, "data.common.upcomingShort", { count: stats.upcoming }) : null
    ].filter(Boolean).join(" · ");
    const count = stats.total ? t(locale, "data.common.reportsShort", { count: stats.total }) : t(locale, "data.common.noReports");
    return `<a href="${escapeHtml(operatorProfileUrl(operator, locale))}" data-operator-slug="${escapeHtml(operator.slug)}" class="op-row op-row--${tone}" role="listitem">`
      + `<span class="op-row__dot" aria-hidden="true"></span>`
      + `<span class="op-row__main"><span class="op-row__name">${escapeHtml(operator.name)}</span><span class="op-row__area">${escapeHtml(operator.area)}</span></span>`
      + `<span class="op-row__side">${live ? `<span class="op-row__live">${escapeHtml(live)}</span>` : ""}<span class="op-row__count">${escapeHtml(count)}</span></span>`
      + `</a>`;
  }).join("");
  return { summary, list };
}

export async function renderSeoOperatorAsset(
  env: Pick<Env, "ASSETS">,
  request: Request,
  live: OperatorLiveContext
): Promise<Response> {
  const locale = parseLocaleFromPath(new URL(request.url).pathname);
  const { profile, stats } = live;
  const assetUrl = new URL(operatorProfileUrl(profile, locale), request.url);
  const asset = await fetchTemplate(env.ASSETS, assetUrl);
  const title = operatorLiveTitle(profile, stats, locale);
  const description = operatorLiveDescription(profile, stats, locale);
  const canonical = absoluteUrl(operatorProfileUrl(profile, locale), SITE_ORIGIN);
  const ogImage = absoluteUrl(DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN);
  const jsonLd = operatorPageJsonLd(profile, stats, SITE_ORIGIN, locale);
  return new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(title); } })
    .on('meta[name="description"]', setMetaContent(description))
    .on('meta[property="og:title"]', setMetaContent(title))
    .on('meta[property="og:description"]', setMetaContent(description))
    .on('meta[property="og:url"]', setMetaContent(canonical))
    .on('meta[property="og:image"]', setMetaContent(ogImage))
    .on('meta[name="twitter:title"]', setMetaContent(title))
    .on('meta[name="twitter:description"]', setMetaContent(description))
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on("#operator-jsonld", { element(element) { element.setInnerContent(jsonLd); } })
    .on("#operator-live", { element(element) { element.replace(renderOperatorLiveSection(live, locale), { html: true }); } })
    .on("#operator-facts", { element(element) {
      const html = renderElcomFactsSection(profile, locale);
      if (html) element.replace(html, { html: true });
    } })
    .on("#operator-faq", { element(element) { element.setInnerContent(renderOperatorFaqsHtml(profile, stats, locale), { html: true }); } })
    .transform(new Response(asset.body, {
      status: asset.status,
      headers: renderedHeaders(asset, "public,max-age=60,s-maxage=300,stale-while-revalidate=1800")
    }));
}

export async function renderSeoOperatorHubAsset(
  env: Pick<Env, "ASSETS">,
  request: Request,
  source: PublicFeedItem[] | Record<string, OperatorLiveStats>
): Promise<Response> {
  const locale = parseLocaleFromPath(new URL(request.url).pathname);
  const asset = await fetchTemplate(env.ASSETS, new URL(pathFor({ kind: "operators" }, locale), request.url));
  const live = Array.isArray(source) ? renderOperatorHubLive(source, locale) : renderOperatorHubLiveFromStats(source, locale);
  const description = live.summary.length <= 158 ? live.summary : `${live.summary.slice(0, 157).trimEnd()}…`;
  return new HTMLRewriter()
    .on('meta[name="description"]', setMetaContent(description))
    .on('meta[property="og:description"]', setMetaContent(description))
    .on("#operator-hub-live", { element(element) { element.setInnerContent(live.summary); } })
    .on("#operator-list", { element(element) { element.setInnerContent(live.list, { html: true }); } })
    .transform(new Response(asset.body, {
      status: asset.status,
      headers: renderedHeaders(asset, "public,max-age=60,s-maxage=180,stale-while-revalidate=900")
    }));
}

export function operatorSitemapLastmods(items: PublicFeedItem[]): Map<string, string> {
  const grouped = groupPublicItemsByOperator(items);
  const lastmods = new Map<string, string>();
  for (const [slug, matched] of grouped) {
    const latest = matched.reduce((max, item) => item.updated_at > max ? item.updated_at : max, matched[0]?.updated_at ?? "");
    if (latest) lastmods.set(slug, latest);
  }
  return lastmods;
}
