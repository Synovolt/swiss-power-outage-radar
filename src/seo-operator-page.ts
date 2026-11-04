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
import { DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN, absoluteUrl, publicDisplayLocation } from "./public-url";
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
  return `<a href="${escapeHtml(href)}" ${attrs} class="flex w-full items-center gap-2 border-b border-border px-3.5 py-2.5 text-sm last:border-b-0 hover:bg-muted/60">
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      ${kicker ? `<span class="text-muted-foreground font-mono text-[0.62rem] tracking-wider uppercase">${escapeHtml(kicker)}</span>` : ""}
      <span class="font-heading font-semibold leading-snug">${escapeHtml(title)}</span>
      <span class="text-muted-foreground line-clamp-1 text-xs leading-snug">${escapeHtml(description)}</span>
    </span>
  </a>`;
}

function renderEventList(items: PublicFeedItem[], locale: AppLocale = "de"): string {
  if (!items.length) return "";
  return `<div class="not-sw-prose overflow-hidden rounded-xl border border-border bg-card">${items.map((item) => {
    const location = publicDisplayLocation(item.location);
    const kind = item.nature === "planned" ? t(locale, "nature.plannedList") : t(locale, "nature.unplannedKind");
    const when = formatDate(item.started_at ?? item.updated_at, locale);
    return itemLinkHtml(
      localizeStoredEventUrl(item.url, locale),
      t(locale, "event.in", { kind, location }),
      [when, item.nature === "planned" ? t(locale, "nature.planned").toLowerCase() : t(locale, "nature.unplanned").toLowerCase()].filter(Boolean).join(" · "),
      statusLabel(item.status, locale)
    );
  }).join("")}</div>`;
}

export function renderOperatorLiveSection(live: OperatorLiveContext, locale: AppLocale = "de"): string {
  const { profile, stats, recent } = live;
  const insight = operatorLiveInsight(profile, stats, locale);
  const footnote = t(locale, "operator.liveFootnote");
  const places = stats.topLocations.length
    ? `<p>${escapeHtml(t(locale, "operator.livePlaces", {
      places: stats.topLocations.map((place) => `${place.label} (${place.count})`).join(", ")
    }))}</p>`
    : "";
  const updated = formatDate(stats.lastUpdatedAt, locale);
  return `<section id="operator-live">
    <h2>${escapeHtml(t(locale, "operator.liveHeading"))}</h2>
    <p>${escapeHtml(insight)}</p>
    ${renderOperatorStatsGrid(stats, footnote, locale)}
    ${places}
    ${updated ? `<p>${escapeHtml(t(locale, "operator.liveUpdated", { date: updated }))}</p>` : ""}
    ${recent.length
      ? `<h3>${escapeHtml(t(locale, "operator.liveRecent", { name: profile.name }))}</h3>${renderEventList(recent, locale)}`
      : `<p>${escapeHtml(t(locale, "operator.liveNone", { name: profile.name }))}</p>`}
  </section>`;
}

export function renderElcomFactsSection(operator: OperatorProfile, locale: AppLocale = "de"): string {
  const facts = elcomFactsForSlug(operator.slug);
  if (!facts) return "";
  const rows = elcomFactsRows(facts, locale);
  return `<section id="operator-facts">
    <h2>${escapeHtml(t(locale, "elcom.heading"))}</h2>
    <p>${escapeHtml(elcomFactsInsight(operator.name, facts, locale))}</p>
    <div class="stat-grid not-sw-prose">
      <dl>${rows.map(([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
      ).join("")}</dl>
      <p class="stat-grid__note">${escapeHtml(elcomFactsDisclaimer(locale))}</p>
    </div>
    <p class="not-sw-prose">
      <a class="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm hover:bg-muted" href="${escapeHtml(ELCOM_PRICE_URL)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "elcom.open"))}</a>
    </p>
  </section>`;
}

export function renderOperatorRelated(operator: OperatorProfile, locale: AppLocale = "de"): string {
  const related = relatedOperatorProfiles(operator, 4);
  if (!related.length) return "";
  return `<section aria-labelledby="related-operators-heading">
    <h2 id="related-operators-heading">${escapeHtml(t(locale, "operator.relatedHeading"))}</h2>
    <div class="not-sw-prose overflow-hidden rounded-xl border border-border bg-card">${related.map((profile) =>
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
  const count = (slug: string) => statsBySlug[slug]?.total ?? 0;
  const operators = [...publicOperatorProfiles()].sort((left, right) => {
    const delta = count(right.slug) - count(left.slug);
    if (delta !== 0) return delta;
    return left.name.localeCompare(right.name, DATE_LOCALE[locale]);
  });
  const withEvents = operators.filter((operator) => count(operator.slug) > 0).length;
  const total = operators.reduce((sum, operator) => sum + count(operator.slug), 0);
  const summary = total
    ? t(locale, "operator.hubSummary", { total, withEvents })
    : t(locale, "operator.hubSummaryEmpty");
  const list = operators.map((operator) => {
    const stats = statsBySlug[operator.slug] ?? summarizeOperatorEvents([]);
    const countLabel = stats.total
      ? stats.active
        ? t(locale, "operator.countActive", { total: stats.total, active: stats.active })
        : t(locale, "operator.countPublic", { count: stats.total })
      : sourceCategoryLabel(operator.sourceCategory, locale);
    return itemLinkHtml(
      operatorProfileUrl(operator, locale),
      operator.name,
      `${operator.area} · ${countLabel}`,
      undefined,
      `data-operator-slug="${escapeHtml(operator.slug)}"`
    );
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
