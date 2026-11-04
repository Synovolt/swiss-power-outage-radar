import type { PublicEventDetail } from "./public-detail";
import type { Env, PublicFeedItem } from "./types";
import { relatedKnowledgeArticles, knowledgeArticleUrl } from "./knowledge";
import { findOperatorProfile, operatorProfileUrl, resolveOperatorProfile, type OperatorLiveContext } from "./operators";
import {
  DEFAULT_OG_IMAGE_PATH,
  SITE_ORIGIN,
  absoluteUrl,
  publicDisplayLocation
} from "./public-url";
import { renderOperatorStatsGrid } from "./seo-operator-page";
import { organizationId, websiteId } from "./seo-site";
import { escapeHtml, fetchTemplate, renderedHeaders, setMetaContent } from "./html";
import { cantonByCode, cantonInText, cantonSlug } from "./swiss-cantons";
import {
  DATE_LOCALE,
  HTML_LANG,
  formatAppDate,
  formatAppDuration,
  hreflangEntries,
  isAppLocale,
  localizeStoredEventUrl,
  parseLocaleFromPath,
  pathFor,
  t,
  type AppLocale
} from "./i18n";

export const INDEXABLE_ROBOTS = "index,follow,max-image-preview:large";

export function eventHreflangHrefMap(storedUrl: string, origin = SITE_ORIGIN): Record<string, string> {
  const path = localizeStoredEventUrl(storedUrl, "de");
  const seen = new Set<string>();
  return Object.fromEntries(
    hreflangEntries(path, origin).flatMap((entry) => {
      if (seen.has(entry.hreflang)) return [];
      seen.add(entry.hreflang);
      return [[entry.hreflang, entry.href] as const];
    })
  );
}

export function eventHreflangLinkTags(storedUrl: string, origin = SITE_ORIGIN): string {
  return Object.entries(eventHreflangHrefMap(storedUrl, origin))
    .map(([hreflang, href]) => `<link rel="alternate" hreflang="${escapeHtml(hreflang)}" href="${escapeHtml(href)}">`)
    .join("");
}

function formatDate(value: string | null | undefined, locale: AppLocale = "de"): string | null {
  return formatAppDate(value, locale);
}

function statusText(detail: PublicEventDetail, locale: AppLocale = "de"): string {
  const status = detail.item.status;
  if (status === "upcoming") return t(locale, "status.upcoming");
  if (status === "active") return t(locale, "status.active");
  if (status === "resolved") {
    if (isAutoClosed(detail)) return t(locale, "status.autoClosed");
    return detail.item.resolved_at ? t(locale, "status.resolved") : t(locale, "status.resolvedReported");
  }
  if (status === "stale_unconfirmed") return t(locale, "status.stale");
  if (status === "historical") return t(locale, "status.historical");
  return t(locale, "status.unknown");
}

function isAutoClosed(detail: PublicEventDetail): boolean {
  return detail.item.status === "resolved" &&
    detail.item.time_confidence === "inferred" &&
    !detail.item.resolved_at;
}

function formatDuration(minutes: number | null, locale: AppLocale = "de"): string | null {
  return formatAppDuration(minutes, locale);
}

function statusLine(detail: PublicEventDetail, locale: AppLocale = "de"): string {
  const item = detail.item;
  if (item.status === "active") {
    return [
      t(locale, "status.active"),
      item.started_at ? t(locale, "event.statusLine.started", { date: formatDate(item.started_at, locale) }) : null,
      item.last_confirmed_active_at ? t(locale, "event.statusLine.lastConfirmed", { date: formatDate(item.last_confirmed_active_at, locale) }) : null
    ].filter(Boolean).join(" · ");
  }
  if (item.status === "stale_unconfirmed") {
    return [
      t(locale, "status.stale"),
      item.last_confirmed_active_at ? t(locale, "event.statusLine.lastActive", { date: formatDate(item.last_confirmed_active_at, locale) }) : null
    ].filter(Boolean).join(" · ");
  }
  if (item.status === "resolved") {
    if (isAutoClosed(detail)) {
      return [
        t(locale, "status.autoClosed"),
        item.last_confirmed_active_at ? t(locale, "event.statusLine.lastConfirm", { date: formatDate(item.last_confirmed_active_at, locale) }) : null,
        t(locale, "event.statusLine.durationUnknown")
      ].filter(Boolean).join(" · ");
    }
    const duration = formatDuration(item.duration_minutes, locale);
    return [
      item.resolved_at ? t(locale, "status.resolved") : t(locale, "status.resolvedReported"),
      duration ? t(locale, "event.statusLine.lasted", { duration }) : null,
      !item.resolved_at ? t(locale, "event.statusLine.timeUnknown") : null
    ].filter(Boolean).join(" · ");
  }
  return statusText(detail, locale);
}

function eventLocation(detail: PublicEventDetail): string {
  return publicDisplayLocation(detail.item.location) || detail.map?.query || "Schweiz";
}

function eventKind(detail: PublicEventDetail, locale: AppLocale): string {
  return detail.item.nature === "planned"
    ? t(locale, "nature.plannedKind")
    : t(locale, "nature.unplannedKind");
}

function eventKindShort(detail: PublicEventDetail, locale: AppLocale): string {
  return detail.item.nature === "planned"
    ? t(locale, "nature.plannedKindShort")
    : t(locale, "nature.unplannedKindShort");
}

function shortDate(value: string | null, locale: AppLocale = "de"): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Zurich"
  }).format(date);
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","));
  return `${(boundary > 40 ? cut.slice(0, boundary) : cut).trim()}…`;
}

function titlePlace(location: string): string {
  const primary = location.split(",")[0]?.trim() || location;
  return primary.length <= 36 ? primary : clampText(primary, 36).replace(/…$/, "").trim();
}

function buildEventTitle(kindShort: string, location: string, date: string | null): string {
  const place = titlePlace(location);
  const withDate = `${kindShort} ${place}${date ? `, ${date}` : ""} | outage.ch`;
  if (withDate.length <= 60) return withDate;
  const withoutDate = `${kindShort} ${place} | outage.ch`;
  if (withoutDate.length <= 60) return withoutDate;
  return `${clampText(`${kindShort} ${place}`, 45)} | outage.ch`;
}

function padDescription(parts: string[], locale: AppLocale, min = 120, max = 158): string {
  const base = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (base.length >= min) return clampText(base, max);
  const filler = t(locale, "event.descFiller");
  return clampText(`${base}${base.endsWith(".") ? "" : "."}${filler}`, max);
}

function consistentSummary(detail: PublicEventDetail, locale: AppLocale = "de"): string {
  const item = detail.item;
  const location = eventLocation(detail);
  if (item.status === "upcoming") return t(locale, "event.summary.upcoming", { location });
  if (item.status === "active") return t(locale, "event.summary.active", { location });
  if (item.status === "stale_unconfirmed") return t(locale, "event.summary.stale", { location });
  if (isAutoClosed(detail)) return t(locale, "event.summary.autoClosed", { location });
  if (item.status === "resolved" && !item.resolved_at) return t(locale, "event.summary.resolvedUnknown", { location });
  if (item.status === "resolved") return t(locale, "event.summary.resolved", { location });
  return item.summary;
}

export function eventFaq(detail: PublicEventDetail, locale: AppLocale = "de"): Array<{ question: string; answer: string }> {
  const item = detail.item;
  const location = eventLocation(detail);
  const start = formatDate(item.started_at, locale);
  const end = formatDate(item.resolved_at, locale);
  const operatorProfile = resolveOperatorProfile({
    name: detail.operator?.name ?? item.source.publisher,
    domain: detail.operator?.domain ?? item.source.domain,
    url: detail.operator?.url ?? item.source.url
  });
  const statusAnswer = item.status === "active"
    ? t(locale, "event.faq.aActive", { status: statusLine(detail, locale) })
    : item.status === "upcoming"
      ? t(locale, "event.faq.aUpcoming", { location })
      : item.status === "resolved"
        ? isAutoClosed(detail)
          ? t(locale, "event.faq.aResolvedAuto", { status: statusLine(detail, locale) })
          : t(locale, "event.faq.aResolved", { status: statusLine(detail, locale), location })
        : item.status === "stale_unconfirmed"
          ? t(locale, "event.faq.aStale", { status: statusLine(detail, locale) })
        : t(locale, "event.faq.aHistorical", { location });
  return [
    {
      question: t(locale, "event.faq.qActive", { location }),
      answer: statusAnswer
    },
    {
      question: t(locale, "event.faq.qStart", { location }),
      answer: start
        ? t(locale, "event.faq.aStart", { date: start })
        : t(locale, "event.faq.aStartUnknown")
    },
    {
      question: t(locale, "event.faq.qEnd", { location }),
      answer: end
        ? t(locale, "event.faq.aEnd", { date: end })
        : t(locale, "event.faq.aEndUnknown")
    },
    {
      question: t(locale, "event.faq.qCause", { location }),
      answer: item.cause
        ? t(locale, "event.faq.aCause", { cause: item.cause })
        : t(locale, "event.faq.aCauseUnknown")
    },
    {
      question: t(locale, "event.faq.qArea", { location }),
      answer: item.affected_area
        ? t(locale, "event.faq.aArea", { area: item.affected_area })
        : t(locale, "event.faq.aAreaFallback", { location })
    },
    {
      question: t(locale, "event.faq.qOfficial"),
      answer: detail.operator
        ? t(locale, "event.faq.aOfficial", { name: detail.operator.name }) + (
            operatorProfile
              ? t(locale, "event.faq.aOfficialProfile", { url: `${SITE_ORIGIN}${operatorProfileUrl(operatorProfile, locale)}` })
              : ""
          )
        : t(locale, "event.faq.aOfficialFallback")
    }
  ];
}

export function eventSeo(detail: PublicEventDetail, origin = SITE_ORIGIN, locale: AppLocale = "de") {
  const siteOrigin = origin.includes("outage.ch") ? SITE_ORIGIN : origin.replace(/^http:/i, "https:");
  const item = detail.item;
  const location = eventLocation(detail);
  const kind = eventKind(detail, locale);
  const kindShort = eventKindShort(detail, locale);
  const summary = consistentSummary(detail, locale);
  const date = shortDate(item.started_at ?? item.received_at, locale);
  const title = buildEventTitle(kindShort, location, date);
  const operatorProfile = resolveOperatorProfile({
    name: detail.operator?.name ?? item.source.publisher,
    domain: detail.operator?.domain ?? item.source.domain,
    url: detail.operator?.url ?? item.source.url
  });
  const operatorPage = operatorProfile ? `${siteOrigin}${operatorProfileUrl(operatorProfile, locale)}` : null;
  const statusBit = item.status === "upcoming"
    ? t(locale, "event.statusBit.upcoming")
    : item.status === "resolved"
      ? isAutoClosed(detail) ? t(locale, "event.statusBit.autoClosed") : t(locale, "event.statusBit.resolved")
      : item.status === "stale_unconfirmed"
        ? t(locale, "event.statusBit.stale")
        : item.status === "historical"
          ? t(locale, "event.statusBit.historical")
          : t(locale, "event.statusBit.active");
  const description = padDescription([
    t(locale, "event.desc.kindIn", { kind, location }),
    `${statusBit}.`,
    item.cause ? t(locale, "event.desc.cause", { cause: item.cause }) : "",
    item.affected_area ? t(locale, "event.desc.area", { area: item.affected_area }) : "",
    detail.operator ? t(locale, "event.desc.operator", { name: detail.operator.name }) : "",
    summary
  ], locale);
  const canonical = absoluteUrl(localizeStoredEventUrl(item.url, locale), siteOrigin);
  const ogImage = detail.evidence[0]?.image_url
    ? absoluteUrl(detail.evidence[0].image_url, siteOrigin)
    : absoluteUrl(DEFAULT_OG_IMAGE_PATH, siteOrigin);
  const pageId = `${canonical}#webpage`;
  const homeUrl = `${siteOrigin}${pathFor({ kind: "home" }, locale)}`;
  const graph: Record<string, unknown>[] = [
    { "@type": "WebSite", "@id": websiteId(siteOrigin), url: homeUrl, name: "outage.ch", inLanguage: HTML_LANG[locale], publisher: { "@id": organizationId(siteOrigin) } },
    {
      "@type": "WebPage", "@id": pageId, url: canonical, name: title, description,
      isPartOf: { "@id": websiteId(siteOrigin) }, dateModified: item.updated_at, inLanguage: HTML_LANG[locale],
      breadcrumb: { "@id": `${canonical}#breadcrumb` },
      primaryImageOfPage: { "@type": "ImageObject", url: ogImage }
    },
    {
      "@type": "BreadcrumbList", "@id": `${canonical}#breadcrumb`,
      // Place hierarchy (canton → municipality) matches how people search
      // ("stromausfall brugg"); falls back to the operator when no place is known.
      itemListElement: [
        { "@type": "ListItem", name: t(locale, "site.breadcrumbHome"), item: homeUrl },
        ...placeTrail(detail, locale, siteOrigin),
        ...(!placeTrail(detail, locale, siteOrigin).length && operatorPage && operatorProfile
          ? [{ "@type": "ListItem", name: operatorProfile.name, item: operatorPage }]
          : []),
        { "@type": "ListItem", name: location, item: canonical }
      ].map((entry, index) => ({ ...entry, position: index + 1 }))
    }
  ];
  const faqId = `${canonical}#faq`;
  graph[1].mainEntity = { "@id": faqId };
  graph.push({
    "@type": "FAQPage",
    "@id": faqId,
    mainEntity: eventFaq(detail, locale).map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer }
    }))
  });
  if (item.started_at) {
    const eventId = `${canonical}#event`;
    graph[1].about = { "@id": eventId };
    graph.push({
      "@type": "Event", "@id": eventId, name: t(locale, "event.in", { kind, location }),
      description: summary, startDate: item.started_at,
      ...(item.resolved_at ? { endDate: item.resolved_at } : {}),
      ...(item.status === "upcoming" ? { eventStatus: "https://schema.org/EventScheduled" } : {}),
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      image: [ogImage],
      location: {
        "@type": "Place", name: detail.map?.label ?? location,
        address: { "@type": "PostalAddress", addressLocality: location, addressRegion: item.canton ?? undefined, addressCountry: "CH" },
        ...(detail.map ? { geo: { "@type": "GeoCoordinates", latitude: detail.map.latitude, longitude: detail.map.longitude } } : {})
      },
      organizer: {
        "@type": "Organization",
        name: detail.operator?.name ?? operatorProfile?.name ?? "outage.ch",
        url: operatorPage ?? detail.operator?.url ?? homeUrl
      }
    });
  } else {
    graph[1].about = { "@type": "Thing", name: t(locale, "event.in", { kind, location }) };
  }
  return { title, description, canonical, ogImage, jsonLd: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }) };
}

function renderSourceRole(role: PublicEventDetail["sources"][number]["role"], locale: AppLocale): string {
  if (role === "operator") return t(locale, "event.source.operator");
  if (role === "authority") return t(locale, "event.source.authority");
  return t(locale, "event.source.media");
}

function renderSourceCards(detail: PublicEventDetail, locale: AppLocale): string {
  if (!detail.sources.length) return "";
  return `<section class="sources-block" aria-labelledby="sources-heading">
    <div class="section-heading"><span>${escapeHtml(t(locale, "event.source.kicker"))}</span><h2 id="sources-heading">${escapeHtml(t(locale, "event.source.heading"))}</h2></div>
    <p class="section-intro">${escapeHtml(t(locale, "event.source.intro"))}</p>
    <div class="source-report-list">${detail.sources.map((source, index) => {
      const screenshot = detail.evidence.find((entry) => entry.source_url === source.url);
      return `<article class="source-report">
        ${screenshot ? `<a class="source-preview" href="${escapeHtml(screenshot.image_url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(screenshot.image_url)}" alt="${escapeHtml(t(locale, "event.source.screenshotAlt", { publisher: source.publisher }))}" loading="lazy"><span>${escapeHtml(t(locale, "event.source.preview"))}</span></a>` : ""}
        <div class="source-report-body">
          <div class="source-report-meta"><span>${String(index + 1).padStart(2, "0")}</span><b>${escapeHtml(renderSourceRole(source.role, locale))}</b>${source.published_at ? `<time datetime="${escapeHtml(source.published_at)}">${escapeHtml(formatDate(source.published_at, locale))}</time>` : ""}</div>
          <h3>${escapeHtml(source.title || source.publisher)}</h3>
          ${source.excerpt ? `<blockquote>${escapeHtml(source.excerpt)}</blockquote>` : `<p class="source-empty">${escapeHtml(t(locale, "event.source.empty"))}</p>`}
          ${source.facts.length ? `<dl class="source-facts">${source.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.format === "datetime" ? formatDate(fact.value, locale) : fact.value)}</dd></div>`).join("")}</dl>` : ""}
          <div class="source-report-footer"><span>${escapeHtml(source.domain)}</span><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "event.source.open"))}</a></div>
          ${screenshot ? `<small class="source-proof">${escapeHtml(t(locale, "event.source.proof", { date: formatDate(screenshot.captured_at, locale), hash: screenshot.sha256.slice(0, 16) }))}</small>` : ""}
        </div>
      </article>`;
    }).join("")}</div>
  </section>`;
}

function renderIncidentAnswers(detail: PublicEventDetail, locale: AppLocale): string {
  const item = detail.item;
  const location = eventLocation(detail);
  type AnswerState = "confirmed" | "reported" | "automatic" | "open";
  const stateLabel = (state: AnswerState) => t(locale, `event.answers.${state}`);
  const rows: Array<[string, string, AnswerState]> = [
    [t(locale, "event.answers.status"), statusLine(detail, locale), isAutoClosed(detail) ? "automatic" : "reported"],
    [t(locale, "event.answers.start"), formatDate(item.started_at, locale) ?? t(locale, "event.answers.notConfirmed"), item.started_at ? "confirmed" : "open"],
    [t(locale, "event.answers.end"), formatDate(item.resolved_at, locale) ?? (isAutoClosed(detail) ? t(locale, "event.answers.unknown") : item.status === "resolved" ? t(locale, "event.answers.resolvedTimeUnknown") : t(locale, "event.answers.notConfirmed")), item.resolved_at ? "confirmed" : isAutoClosed(detail) ? "open" : item.status === "resolved" ? "reported" : "open"],
    [t(locale, "event.answers.cause"), item.cause ?? t(locale, "event.answers.causeUnknown"), item.cause ? "reported" : "open"],
    [t(locale, "event.answers.area"), item.affected_area ?? location, "reported"]
  ];
  const known = rows.filter((row) => row[2] !== "open").length;
  return `<section class="answers-block fold-block" aria-labelledby="answers-heading">
    <details>
      <summary>
        <span class="fold-kicker">${escapeHtml(t(locale, "event.answers.kicker"))}</span>
        <strong>${escapeHtml(t(locale, "event.answers.summary"))}</strong>
        <span class="fold-hint">${escapeHtml(t(locale, "event.answers.hint", { known, total: rows.length }))}</span>
      </summary>
      <h2 id="answers-heading">${escapeHtml(t(locale, "event.answers.heading", { location }))}</h2>
      <div class="answer-grid">${rows.map(([label, value, state]) => `<div class="${state === "open" ? "is-open" : "is-known"}"><span>${escapeHtml(stateLabel(state))}</span><h3>${escapeHtml(label)}</h3><p>${escapeHtml(value)}</p></div>`).join("")}</div>
    </details>
  </section>`;
}

function renderFaq(detail: PublicEventDetail, locale: AppLocale): string {
  const faqs = eventFaq(detail, locale);
  return `<section class="event-faq fold-block" aria-labelledby="faq-heading">
    <details>
      <summary>
        <span class="fold-kicker">${escapeHtml(t(locale, "event.faq.kicker"))}</span>
        <strong id="faq-heading">${escapeHtml(t(locale, "event.faq.heading"))}</strong>
        <span class="fold-hint">${escapeHtml(t(locale, "event.faq.hint", { count: faqs.length }))}</span>
      </summary>
      ${faqs.map((faq) => `<details><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join("")}
    </details>
  </section>`;
}

function renderKnowledgeLinks(locale: AppLocale): string {
  return `<section class="knowledge-links" aria-labelledby="knowledge-heading">
    <div class="section-heading"><span>${escapeHtml(t(locale, "event.knowledge.kicker"))}</span><h2 id="knowledge-heading">${escapeHtml(t(locale, "event.knowledge.heading"))}</h2></div>
    <div>${relatedKnowledgeArticles(3).map((article, index) => `<a href="${knowledgeArticleUrl(article)}"><span>${String(index + 1).padStart(2, "0")}</span><div><small>${escapeHtml(t(locale, "guides.minutes", { count: article.readingMinutes }))}</small><strong>${escapeHtml(article.shortTitle)}</strong><p>${escapeHtml(article.description)}</p></div><b>→</b></a>`).join("")}</div>
    <a class="all-guides" href="${pathFor({ kind: "guides" }, locale)}">${escapeHtml(t(locale, "event.knowledge.all"))}</a>
  </section>`;
}

function relatedStatusLabel(item: PublicFeedItem, locale: AppLocale): string {
  if (item.status === "upcoming") return t(locale, "status.upcoming");
  if (item.status === "active") return t(locale, "status.activeShort");
  if (item.status === "resolved") return t(locale, "status.resolved");
  if (item.status === "stale_unconfirmed") return t(locale, "status.staleShort");
  if (item.status === "historical") return t(locale, "status.historicalShort");
  return t(locale, "status.report");
}

function renderRelatedEvents(related: PublicFeedItem[], locale: AppLocale, heading?: string): string {
  if (!related.length) return "";
  const title = heading ?? t(locale, "event.related.heading");
  return `<section class="related-events" aria-labelledby="related-heading">
    <div class="section-heading"><span>${escapeHtml(t(locale, "event.related.kicker"))}</span><h2 id="related-heading">${escapeHtml(title)}</h2></div>
    <div class="related-list">${related.map((item) => {
      const location = publicDisplayLocation(item.location);
      const kind = item.nature === "planned" ? t(locale, "nature.plannedList") : t(locale, "nature.unplannedKind");
      return `<a href="${escapeHtml(localizeStoredEventUrl(item.url, locale))}"><span>${escapeHtml(relatedStatusLabel(item, locale))}</span><strong>${escapeHtml(t(locale, "event.in", { kind, location }))}</strong><small>${escapeHtml(item.source.publisher)}</small></a>`;
    }).join("")}</div>
    <a class="all-guides" href="${pathFor({ kind: "home" }, locale)}">${escapeHtml(t(locale, "event.related.all"))}</a>
  </section>`;
}

function renderOperator(operator: PublicEventDetail["operator"], locale: AppLocale, live?: OperatorLiveContext | null): string {
  const profile = live?.profile
    ?? (operator ? resolveOperatorProfile({ name: operator.name, domain: operator.domain, url: operator.url }) : null)
    ?? findOperatorProfile(operator?.name);
  if (!operator && !profile) return "";
  const name = operator?.name ?? profile?.name ?? "";
  const area = operator?.area ?? profile?.area ?? "";
  const role = operator?.role ?? t(locale, "event.source.operator");
  const officialUrl = operator?.url ?? profile?.officialUrl ?? "";
  const profileUrl = profile ? operatorProfileUrl(profile, locale) : "";
  const stats = live?.stats;
  const footnote = t(locale, "event.operator.statsNote");
  return `<aside class="operator-block" aria-labelledby="operator-heading">
    <div class="operator-copy">
      <span>${escapeHtml(role)}</span>
      <h2 id="operator-heading">${escapeHtml(name)}</h2>
      ${area ? `<p>${escapeHtml(area)}</p>` : ""}
      ${stats ? `<p class="operator-live-line">${escapeHtml(
        stats.active > 0
          ? t(locale, "event.operator.liveActive", { total: stats.total, active: stats.active })
          : stats.upcoming > 0
            ? t(locale, "event.operator.liveUpcoming", { total: stats.total, upcoming: stats.upcoming })
            : t(locale, "event.operator.liveNone", { total: stats.total })
      )}</p>` : ""}
    </div>
    <div class="operator-actions">
      ${profileUrl ? `<a href="${escapeHtml(profileUrl)}">${escapeHtml(t(locale, "event.operator.reports", { name }))}</a>` : ""}
      ${officialUrl ? `<a class="operator-official-btn" href="${escapeHtml(officialUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "event.operator.official"))}</a>` : ""}
    </div>
    ${stats ? renderOperatorStatsGrid(stats, footnote, locale) : ""}
  </aside>`;
}

/** Canton and primary place pages for this event (empty when unknown). */
function placeTrail(detail: PublicEventDetail, locale: AppLocale, origin = SITE_ORIGIN): Array<{ "@type": "ListItem"; name: string; item: string }> {
  const trail: Array<{ "@type": "ListItem"; name: string; item: string }> = [];
  const canton = cantonByCode(detail.item.canton);
  if (canton) {
    trail.push({ "@type": "ListItem", name: canton.names[locale], item: `${origin}${pathFor({ kind: "canton", slug: cantonSlug(canton, locale) }, locale)}` });
  }
  const place = detail.item.places?.[0];
  if (place) trail.push({ "@type": "ListItem", name: place.name, item: `${origin}${pathFor({ kind: "place", slug: place.slug }, locale)}` });
  return trail;
}

function renderPlaceLinks(detail: PublicEventDetail, locale: AppLocale): string {
  const places = detail.item.places ?? [];
  const canton = cantonByCode(detail.item.canton);
  if (!places.length && !canton) return "";
  const links = [
    ...places.slice(0, 6).map((place) => `<a href="${escapeHtml(pathFor({ kind: "place", slug: place.slug }, locale))}">${escapeHtml(t(locale, "data.place.h1", { place: place.name }))}</a>`),
    ...(canton ? [`<a href="${escapeHtml(pathFor({ kind: "canton", slug: cantonSlug(canton, locale) }, locale))}">${escapeHtml(t(locale, "data.canton.h1", { canton: cantonInText(canton, locale) }))}</a>`] : [])
  ];
  return `<nav class="brief__places" aria-label="${escapeHtml(t(locale, "data.nav.places"))}">${links.join("")}</nav>`;
}

function renderTimeline(detail: PublicEventDetail, locale: AppLocale): string {
  if (!detail.timeline.length) return "";
  return `<ol class="brief__times">${detail.timeline.map((entry) =>
    `<li><span>${escapeHtml(entry.label)}</span><strong>${escapeHtml(formatDate(entry.value, locale))}</strong></li>`
  ).join("")}</ol>`;
}

export function renderEventSeoMarkup(
  detail: PublicEventDetail,
  related: PublicFeedItem[] = [],
  live: OperatorLiveContext | null = null,
  locale: AppLocale = "de"
): string {
  const item = detail.item;
  const location = eventLocation(detail);
  const kind = eventKind(detail, locale);
  const hasMap = Boolean(detail.map);
  const statusClass = item.status ?? "historical";
  const factRows = [
    [t(locale, "event.facts.kind"), item.nature === "planned" ? t(locale, "nature.planned") : item.nature === "unplanned" ? t(locale, "nature.unplanned") : t(locale, "nature.unknown")],
    [t(locale, "event.facts.status"), statusText(detail, locale)],
    [t(locale, "event.facts.start"), formatDate(item.started_at, locale)],
    [t(locale, "event.facts.end"), formatDate(item.resolved_at, locale) ?? (item.status === "resolved" ? t(locale, "event.facts.endUnknown") : null)],
    [t(locale, "event.facts.duration"), formatDuration(item.duration_minutes, locale)],
    [t(locale, "event.facts.area"), item.affected_area ?? location],
    [t(locale, "event.facts.cause"), item.cause]
  ].filter((row) => row[1]);
  const relatedHeading = live?.profile && related.length
    ? t(locale, "event.related.headingOperator", { name: live.profile.name })
    : undefined;
  return `<article class="event-brief seo-event" data-status="${escapeHtml(statusClass)}">
    <header class="brief">
      <div class="brief__copy">
        <div class="brief__kicker">
          <span class="radar-badge radar-badge--${escapeHtml(statusClass)}">${escapeHtml(statusText(detail, locale))}</span>
          <span class="trust-mark"><i></i>${escapeHtml(item.trust === "official" ? t(locale, "event.trustOfficial") : t(locale, "event.trustReported"))}</span>
          <span>${escapeHtml(t(locale, "event.updated", { date: formatDate(item.updated_at, locale) }))}</span>
        </div>
        <p class="hero-statusline">${escapeHtml(statusLine(detail, locale))}</p>
        <h1>${escapeHtml(t(locale, "event.in", { kind, location }))}</h1>
        <p class="brief__lede">${escapeHtml(consistentSummary(detail, locale))}</p>
        <section class="fact-strip"><h2>${escapeHtml(t(locale, "event.factsHeading"))}</h2><dl>${factRows.map(([label, value]) =>
          `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></section>
        ${renderTimeline(detail, locale)}
        ${renderPlaceLinks(detail, locale)}
        ${renderOperator(detail.operator, locale, live)}
      </div>
      <div class="brief__map event-hero ${hasMap ? "has-map map-loading" : "no-map"}">${hasMap ? `<div id="event-map" role="img" aria-label="${escapeHtml(t(locale, "event.mapAria", { label: detail.map!.label }))}"></div><div class="map-fallback" aria-hidden="true"><span></span><strong>${escapeHtml(detail.map!.label)}</strong><small>${escapeHtml(t(locale, "event.mapLoading"))}</small></div>` : ""}<div class="hero-wash"></div>${hasMap ? `<span class="map-place">${escapeHtml(detail.map!.label)}</span>` : ""}</div>
    </header>
    ${renderSourceCards(detail, locale)}
    ${renderIncidentAnswers(detail, locale)}
    ${renderFaq(detail, locale)}
    <div class="brief__more">
      ${renderRelatedEvents(related, locale, relatedHeading)}
      ${renderKnowledgeLinks(locale)}
    </div>
    <footer class="detail-note">${escapeHtml(t(locale, "event.footer", { date: formatDate(item.updated_at, locale) }))}</footer>
  </article>`;
}

export async function renderSeoEventAsset(
  env: Pick<Env, "ASSETS">,
  request: Request,
  detail: PublicEventDetail,
  related: PublicFeedItem[] = [],
  live: OperatorLiveContext | null = null
): Promise<Response> {
  const locale = parseLocaleFromPath(new URL(request.url).pathname);
  const assetUrl = new URL(pathFor({ kind: "eventsTemplate" }, locale), request.url);
  const asset = await fetchTemplate(env.ASSETS, assetUrl);
  const seo = eventSeo(detail, SITE_ORIGIN, locale);
  const data = JSON.stringify(detail).replace(/</g, "\\u003c");
  const hreflangTags = eventHreflangLinkTags(detail.item.url, SITE_ORIGIN);
  return new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(seo.title); } })
    .on('meta[name="description"]', setMetaContent(seo.description))
    .on('meta[name="robots"]', setMetaContent(INDEXABLE_ROBOTS))
    .on('meta[property="og:title"]', setMetaContent(seo.title))
    .on('meta[property="og:description"]', setMetaContent(seo.description))
    .on('meta[property="og:type"]', setMetaContent("article"))
    .on('meta[property="og:url"]', setMetaContent(seo.canonical))
    .on('meta[property="og:image"]', setMetaContent(seo.ogImage))
    .on('meta[name="twitter:title"]', setMetaContent(seo.title))
    .on('meta[name="twitter:description"]', setMetaContent(seo.description))
    .on('meta[name="twitter:image"]', setMetaContent(seo.ogImage))
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", seo.canonical); } })
    .on('link[rel="alternate"][hreflang]', { element(element) { element.remove(); } })
    .on("nav.app-langs a[data-locale]", {
      element(element) {
        const code = element.getAttribute("data-locale");
        if (isAppLocale(code)) element.setAttribute("href", localizeStoredEventUrl(detail.item.url, code));
      }
    })
    .on("head", { element(element) {
      element.append(`${hreflangTags}<script type="application/ld+json">${seo.jsonLd}</script><script id="outage-event-data" type="application/json">${data}</script>`, { html: true });
    } })
    .on("#event-shell", { element(element) { element.setInnerContent(renderEventSeoMarkup(detail, related, live, locale), { html: true }); element.setAttribute("aria-busy", "false"); } })
    .transform(new Response(asset.body, { status: asset.status, headers: renderedHeaders(asset, "public,max-age=60,s-maxage=300,stale-while-revalidate=1800") }));
}
