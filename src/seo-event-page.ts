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
import { fromPublicItem, rowHtml } from "./radar-view";
import { organizationId, websiteId } from "./seo-site";
import { escapeHtml, fetchTemplate, renderedHeaders, setMetaContent } from "./html";
import { cantonByCode, cantonInText, cantonSlug } from "./swiss-cantons";
import {
  DATE_LOCALE,
  HELP_GUIDE_PATH,
  HTML_LANG,
  formatAppDate,
  formatAppDuration,
  hreflangEntries,
  isAppLocale,
  localizeStoredEventUrl,
  parseLocaleFromPath,
  pathFor,
  radarViewCopy,
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

/**
 * An end observed between two polls of the operator page: last seen listed
 * (from) and first seen gone (to). Only then can the page say "ended between".
 */
function measuredEndWindow(detail: PublicEventDetail): { from: number; to: number } | null {
  const item = detail.item;
  if (item.status !== "resolved" || item.resolved_at) return null;
  const to = toMs(item.resolution_latest_at);
  const from = toMs(item.resolution_earliest_at) ?? toMs(item.last_confirmed_active_at);
  return to !== null && from !== null && from <= to ? { from, to } : null;
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
        item.duration_is_estimate && formatDuration(item.duration_minutes, locale)
          ? t(locale, "event.statusLine.lasted", { duration: `≈ ${formatDuration(item.duration_minutes, locale)}` })
          : t(locale, "event.statusLine.durationUnknown")
      ].filter(Boolean).join(" · ");
    }
    const rawDuration = formatDuration(item.duration_minutes, locale);
    const duration = rawDuration && item.duration_is_estimate ? `≈ ${rawDuration}` : rawDuration;
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

// ------------------------------------------------------------ event page markup
//
// Reading order: where and what (title) → state in one sentence (headline) →
// time window → key facts → what the source literally says → actions → what to
// do → timeline, sources, nearby reports, FAQ. Every value is sourced; unknown
// values are labelled as open/unknown instead of being guessed.

const ZURICH = "Europe/Zurich";
const formatters = new Map<string, Intl.DateTimeFormat>();
function zurichFormat(locale: AppLocale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(DATE_LOCALE[locale], { timeZone: ZURICH, ...options });
    formatters.set(key, formatter);
  }
  return formatter;
}

const toMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const dayKeyOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZURICH, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

function timeText(ms: number, locale: AppLocale): string {
  return zurichFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

/** "Heute" / "Morgen" / "Gestern" / "Do., 5. Nov." (+ year when it differs). */
function dayText(ms: number, now: number, locale: AppLocale): string {
  const diff = Math.round((Date.parse(`${dayKeyOf(ms)}T00:00:00Z`) - Date.parse(`${dayKeyOf(now)}T00:00:00Z`)) / 86_400_000);
  if (Math.abs(diff) <= 1) {
    return capitalizeFirst(new Intl.RelativeTimeFormat(DATE_LOCALE[locale], { numeric: "auto" }).format(diff, "day"));
  }
  const sameYear = dayKeyOf(ms).slice(0, 4) === dayKeyOf(now).slice(0, 4);
  return zurichFormat(locale, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(ms));
}

function whenText(ms: number, now: number, locale: AppLocale): string {
  return `${dayText(ms, now, locale)}, ${timeText(ms, locale)}`;
}

/** End of a window: only the time when it is the same day as the reference. */
function endText(endMs: number, refMs: number, now: number, locale: AppLocale): string {
  return dayKeyOf(endMs) === dayKeyOf(refMs) ? timeText(endMs, locale) : whenText(endMs, now, locale);
}

function relativeText(ms: number, now: number, locale: AppLocale): string {
  const rtf = new Intl.RelativeTimeFormat(DATE_LOCALE[locale], { numeric: "auto" });
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

function sinceMinutes(startMs: number, now: number): number {
  return Math.max(1, Math.round((now - startMs) / 60_000));
}

type EventTone = "active" | "upcoming" | "ended" | "stale";

function eventTone(detail: PublicEventDetail): EventTone {
  const status = detail.item.status;
  if (status === "active") return "active";
  if (status === "upcoming") return "upcoming";
  if (status === "stale_unconfirmed") return "stale";
  return "ended";
}

function statePill(detail: PublicEventDetail, locale: AppLocale): string {
  const tone = eventTone(detail);
  const label = tone === "active"
    ? t(locale, "ui.status.active")
    : tone === "upcoming"
      ? t(locale, "ui.status.upcoming")
      : tone === "stale"
        ? t(locale, "status.staleShort")
        : t(locale, "ui.status.ended");
  return `<span class="state-pill state-pill--${tone}"><i aria-hidden="true"></i>${escapeHtml(label)}</span>`;
}

/** The one sentence that answers "is it still going and until when?" plus a quieter second line. */
function headline(detail: PublicEventDetail, locale: AppLocale, now: number): { main: string; sub: string | null; liveSince: string | null } {
  const item = detail.item;
  const h = (key: string, options?: Record<string, unknown>) => t(locale, `ui.event.headline.${key}`, options);
  const start = toMs(item.started_at);
  const plannedEnd = toMs(item.expected_restore_at);
  const lastConfirmed = toMs(item.last_confirmed_active_at);

  if (item.status === "active") {
    const running = start !== null && start <= now;
    const main = running
      ? h("active", { duration: formatDuration(sinceMinutes(start, now), locale) })
      : h("activeReported", { relative: relativeText(toMs(item.received_at) ?? now, now, locale) });
    const end = plannedEnd !== null && plannedEnd > now
      ? h("endPlanned", { time: endText(plannedEnd, now, now, locale) })
      : h("endOpen");
    const confirmed = lastConfirmed !== null
      ? t(locale, "event.statusLine.lastConfirmed", { date: whenText(lastConfirmed, now, locale) })
      : null;
    return { main: `${main} · ${end}`, sub: confirmed ? capitalizeFirst(confirmed) : null, liveSince: running ? item.started_at : null };
  }

  if (item.status === "upcoming") {
    const at = start ?? toMs(item.received_at) ?? now;
    const window = plannedEnd !== null && plannedEnd > at
      ? `${whenText(at, now, locale)}–${endText(plannedEnd, at, now, locale)}`
      : whenText(at, now, locale);
    return { main: h("upcoming", { when: window }), sub: h("startsIn", { relative: relativeText(at, now, locale) }), liveSince: null };
  }

  if (item.status === "resolved") {
    const measured = measuredEndWindow(detail);
    if (measured) {
      return {
        main: h("endedBetween", { from: whenText(measured.from, now, locale), to: endText(measured.to, measured.from, now, locale) }),
        sub: h("endMeasured"),
        liveSince: null
      };
    }
    if (isAutoClosed(detail)) {
      const main = lastConfirmed !== null ? h("autoClosed", { date: whenText(lastConfirmed, now, locale) }) : h("autoClosedNoDate");
      return { main, sub: statusLine(detail, locale), liveSince: null };
    }
    const resolved = toMs(item.resolved_at);
    if (resolved === null) return { main: h("resolvedNoTime"), sub: statusLine(detail, locale), liveSince: null };
    const lasted = formatDuration(item.duration_minutes, locale);
    return {
      main: [h("resolved", { date: whenText(resolved, now, locale) }), lasted ? h("lasted", { duration: lasted }) : null].filter(Boolean).join(" · "),
      sub: null,
      liveSince: null
    };
  }

  if (item.status === "stale_unconfirmed") {
    return {
      main: lastConfirmed !== null ? h("stale", { date: whenText(lastConfirmed, now, locale) }) : t(locale, "status.stale"),
      sub: statusLine(detail, locale),
      liveSince: null
    };
  }

  const at = toMs(item.started_at) ?? toMs(item.received_at) ?? now;
  return { main: h("historical", { date: whenText(at, now, locale) }), sub: null, liveSince: null };
}

/** Bar from announced start to announced end with a "now" marker (planned windows only). */
function renderWindow(detail: PublicEventDetail, locale: AppLocale, now: number): string {
  const item = detail.item;
  if (item.status !== "active" && item.status !== "upcoming") return "";
  const start = toMs(item.started_at);
  const end = toMs(item.expected_restore_at);
  if (start === null || end === null || end <= start) return "";
  const progress = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  const startLabel = whenText(start, now, locale);
  const endLabel = endText(end, start, now, locale);
  return `<div class="ev-window" data-start="${escapeHtml(item.started_at)}" data-end="${escapeHtml(item.expected_restore_at)}" role="img" aria-label="${escapeHtml(t(locale, "ui.event.progress.aria", { start: startLabel, end: endLabel }))}">
      <div class="ev-window__track"><span class="ev-window__fill" style="width:${progress.toFixed(1)}%"></span>${item.status === "active" ? `<span class="ev-window__now" style="left:${progress.toFixed(1)}%"></span>` : ""}</div>
      <div class="ev-window__labels" aria-hidden="true"><span>${escapeHtml(startLabel)}</span><span>${escapeHtml(endLabel)}</span></div>
    </div>`;
}

function renderFacts(detail: PublicEventDetail, locale: AppLocale, now: number, operatorName: string | null, operatorHref: string | null): string {
  const item = detail.item;
  const f = (key: string) => t(locale, `ui.event.facts.${key}`);
  const start = toMs(item.started_at);
  const resolved = toMs(item.resolved_at);
  const plannedEnd = toMs(item.expected_restore_at);
  const rows: Array<[string, string, string?]> = [];

  // "≤": an operator outage without a reported start began no later than its first sighting.
  // Without that, the moment outage.ch received the report is still an upper bound.
  const firstSeen = item.active_since_is_minimum ? toMs(item.active_since_at) : toMs(item.received_at);
  rows.push(start !== null
    ? [f("start"), whenText(start, now, locale)]
    : firstSeen !== null
      ? [f("start"), `≤ ${whenText(firstSeen, now, locale)}`]
      : [f("start"), f("unknown"), "is-open"]);

  if (item.status === "active" || item.status === "upcoming") {
    rows.push(plannedEnd !== null
      ? [f("plannedEnd"), endText(plannedEnd, start ?? now, now, locale)]
      : [f("end"), f("open"), "is-open"]);
  } else if (resolved !== null) {
    rows.push([f("end"), whenText(resolved, now, locale)]);
  } else if (measuredEndWindow(detail)) {
    const measured = measuredEndWindow(detail) as { from: number; to: number };
    rows.push([f("end"), `${whenText(measured.from, now, locale)}–${endText(measured.to, measured.from, now, locale)}`]);
  } else if (item.status === "resolved" && toMs(item.resolution_latest_at) !== null) {
    // Measured end window: gone from the operator listing no later than this poll.
    rows.push([f("end"), `≤ ${whenText(toMs(item.resolution_latest_at) as number, now, locale)}`]);
  } else {
    rows.push([f("end"), item.status === "resolved" && !isAutoClosed(detail) ? t(locale, "event.answers.resolvedTimeUnknown") : f("unknown"), "is-open"]);
  }

  const rawDuration = formatDuration(item.duration_minutes, locale);
  const duration = rawDuration && item.duration_is_estimate ? `≈ ${rawDuration}` : rawDuration;
  if (duration && item.status !== "active" && item.status !== "upcoming") rows.push([f("duration"), duration]);
  if (item.status === "upcoming" && start !== null && plannedEnd !== null && plannedEnd > start) {
    rows.push([f("duration"), formatDuration(Math.round((plannedEnd - start) / 60_000), locale) ?? ""]);
  }

  rows.push([f("area"), item.affected_area ?? eventLocation(detail)]);
  if (item.cause) rows.push([f("cause"), item.cause]);
  if (operatorName) rows.push([f("operator"), operatorName, operatorHref ? `href:${operatorHref}` : undefined]);

  return `<dl class="ev-facts">${rows.map(([label, value, extra]) => {
    const href = extra?.startsWith("href:") ? extra.slice(5) : null;
    const cls = extra && !href ? ` class="${extra}"` : "";
    return `<div${cls}><dt>${escapeHtml(label)}</dt><dd>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(value)}</a>` : escapeHtml(value)}</dd></div>`;
  }).join("")}</dl>`;
}

function primarySource(detail: PublicEventDetail): PublicEventDetail["sources"][number] | null {
  return detail.sources.find((source) => source.role === "operator")
    ?? detail.sources.find((source) => source.role === "authority")
    ?? detail.sources[0]
    ?? null;
}

/** What the primary source literally says (quoted, untranslated) right under the facts. */
function renderReport(detail: PublicEventDetail, locale: AppLocale, now: number): string {
  const source = primarySource(detail);
  if (!source?.excerpt) return "";
  const published = toMs(source.published_at);
  return `<figure class="ev-report">
      <figcaption><span>${escapeHtml(t(locale, "ui.event.reportHeading", { publisher: source.publisher }))}</span>${published !== null ? `<time datetime="${escapeHtml(source.published_at)}">${escapeHtml(whenText(published, now, locale))}</time>` : ""}</figcaption>
      <blockquote>${escapeHtml(source.excerpt)}</blockquote>
    </figure>`;
}

function renderActions(detail: PublicEventDetail, locale: AppLocale, operatorName: string | null, operatorHref: string | null, officialUrl: string | null): string {
  const source = primarySource(detail);
  const sourceUrl = source?.url ?? officialUrl;
  const publisher = source?.publisher ?? operatorName ?? detail.item.source.publisher;
  const external = `<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
  const share = `<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></svg>`;
  return `<div class="ev-actions">
      ${sourceUrl ? `<a class="ev-btn ev-btn--primary" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "ui.event.officialSource", { publisher }))}${external}</a>` : ""}
      ${operatorHref && operatorName ? `<a class="ev-btn" href="${escapeHtml(operatorHref)}">${escapeHtml(t(locale, "event.operator.reports", { name: operatorName }))}</a>` : ""}
      ${officialUrl && officialUrl !== sourceUrl ? `<a class="ev-btn" href="${escapeHtml(officialUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "event.operator.official"))}${external}</a>` : ""}
      <button type="button" class="ev-btn ev-btn--ghost" data-share data-copied="${escapeHtml(t(locale, "ui.event.copied"))}">${share}<span>${escapeHtml(t(locale, "ui.event.share"))}</span></button>
    </div>`;
}

function renderTips(detail: PublicEventDetail, locale: AppLocale): string {
  const status = detail.item.status;
  if (status !== "active" && status !== "upcoming") return "";
  const prepare = status === "upcoming";
  const k = (key: string) => t(locale, `ui.event.tips.${key}`);
  // A planned interruption that is under way needs no fuse-box check: it is announced.
  const items = prepare
    ? [k("p1"), k("p2"), k("p3")]
    : detail.item.nature === "planned"
      ? [k("d2"), k("p3"), k("d3")]
      : [k("d1"), k("d2"), k("d3")];
  return `<section class="ev-card ev-tips" aria-labelledby="tips-heading">
      <h2 id="tips-heading">${escapeHtml(prepare ? k("prepare") : k("during"))}</h2>
      <ol>${items.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ol>
      <a class="ev-link" href="${escapeHtml(HELP_GUIDE_PATH)}">${escapeHtml(k("more"))} →</a>
    </section>`;
}

function renderTimeline(detail: PublicEventDetail, locale: AppLocale, now: number): string {
  const item = detail.item;
  const entries: Array<{ label: string; ms: number }> = [];
  for (const entry of detail.timeline) {
    const ms = toMs(entry.value);
    if (ms !== null) entries.push({ label: entry.label, ms });
  }
  const confirmed = toMs(item.last_confirmed_active_at);
  if (confirmed !== null && (item.status === "active" || item.status === "stale_unconfirmed")) {
    entries.push({ label: capitalizeFirst(t(locale, "event.statusLine.lastConfirmed", { date: "" }).trim()), ms: confirmed });
  }
  const plannedEnd = toMs(item.expected_restore_at);
  if (plannedEnd !== null && (item.status === "active" || item.status === "upcoming") && !entries.some((entry) => entry.ms === plannedEnd)) {
    entries.push({ label: t(locale, "ui.event.facts.plannedEnd"), ms: plannedEnd });
  }
  if (!entries.length) return "";
  entries.sort((a, b) => a.ms - b.ms);
  return `<section class="ev-card" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">${escapeHtml(t(locale, "ui.event.timeline"))}</h2>
      <ol class="ev-timeline">${entries.map((entry) => `<li class="${entry.ms > now ? "is-future" : ""}"><time datetime="${new Date(entry.ms).toISOString()}">${escapeHtml(whenText(entry.ms, now, locale))}</time><span>${escapeHtml(entry.label)}</span></li>`).join("")}</ol>
    </section>`;
}

function renderSourceRole(role: PublicEventDetail["sources"][number]["role"], locale: AppLocale): string {
  if (role === "operator") return t(locale, "event.source.operator");
  if (role === "authority") return t(locale, "event.source.authority");
  return t(locale, "event.source.media");
}

function renderSources(detail: PublicEventDetail, locale: AppLocale, now: number): string {
  if (!detail.sources.length) return "";
  return `<section class="ev-card ev-sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading">${escapeHtml(t(locale, "event.source.heading"))}</h2>
      <p class="ev-muted">${escapeHtml(t(locale, "ui.event.sourcesIntro"))}</p>
      <ul>${detail.sources.map((source) => {
        const screenshot = detail.evidence.find((entry) => entry.source_url === source.url);
        const published = toMs(source.published_at);
        return `<li class="ev-source">
          <div class="ev-source__head">
            <span class="ev-source__role">${escapeHtml(renderSourceRole(source.role, locale))}</span>
            <strong>${escapeHtml(source.title || source.publisher)}</strong>
            <span class="ev-muted">${escapeHtml(source.publisher)}${published !== null ? ` · ${escapeHtml(whenText(published, now, locale))}` : ""}</span>
          </div>
          ${source.excerpt ? `<blockquote>${escapeHtml(source.excerpt)}</blockquote>` : `<p class="ev-muted">${escapeHtml(t(locale, "event.source.empty"))}</p>`}
          ${source.facts.length ? `<dl class="ev-source__facts">${source.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.format === "datetime" ? formatDate(fact.value, locale) : fact.value)}</dd></div>`).join("")}</dl>` : ""}
          <div class="ev-source__foot">
            <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(t(locale, "event.source.open"))}</a>
            ${screenshot ? `<a href="${escapeHtml(screenshot.image_url)}" target="_blank" rel="noreferrer" title="${escapeHtml(t(locale, "event.source.proof", { date: formatDate(screenshot.captured_at, locale), hash: screenshot.sha256.slice(0, 16) }))}">${escapeHtml(t(locale, "event.source.preview"))}</a>` : ""}
          </div>
        </li>`;
      }).join("")}</ul>
    </section>`;
}

function renderFaq(detail: PublicEventDetail, locale: AppLocale): string {
  const faqs = eventFaq(detail, locale);
  return `<section class="ev-card ev-faq" aria-labelledby="faq-heading">
      <h2 id="faq-heading">${escapeHtml(t(locale, "event.faq.heading"))}</h2>
      ${faqs.map((faq) => `<details><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join("")}
    </section>`;
}

function renderKnowledgeLinks(locale: AppLocale): string {
  return `<section class="ev-guides" aria-labelledby="knowledge-heading">
      <h2 id="knowledge-heading">${escapeHtml(t(locale, "event.knowledge.heading"))}</h2>
      <div>${relatedKnowledgeArticles(3).map((article) => `<a href="${knowledgeArticleUrl(article)}"><strong>${escapeHtml(article.shortTitle)}</strong><span>${escapeHtml(article.description)}</span><small>${escapeHtml(t(locale, "guides.minutes", { count: article.readingMinutes }))}</small></a>`).join("")}</div>
      <a class="ev-link" href="${pathFor({ kind: "guides" }, locale)}">${escapeHtml(t(locale, "event.knowledge.all"))} →</a>
    </section>`;
}

function renderRelatedEvents(related: PublicFeedItem[], locale: AppLocale, now: number, heading?: string): string {
  if (!related.length) return "";
  const copy = radarViewCopy(locale);
  const rows = related.map((item) => rowHtml(fromPublicItem(item), now, copy)).join("");
  return `<section class="ev-card ev-related" aria-labelledby="related-heading">
      <h2 id="related-heading">${escapeHtml(heading ?? t(locale, "event.related.heading"))}</h2>
      <div class="ev-rows">${rows}</div>
      <a class="ev-link" href="${pathFor({ kind: "home" }, locale)}">${escapeHtml(t(locale, "event.related.all"))} →</a>
    </section>`;
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

function renderCrumbs(detail: PublicEventDetail, locale: AppLocale): string {
  const canton = cantonByCode(detail.item.canton);
  const places = detail.item.places ?? [];
  const links = [
    `<a class="ev-crumbs__back" href="${escapeHtml(pathFor({ kind: "home" }, locale))}"><svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>${escapeHtml(t(locale, "ui.event.back"))}</a>`,
    ...(canton ? [`<a href="${escapeHtml(pathFor({ kind: "canton", slug: cantonSlug(canton, locale) }, locale))}">${escapeHtml(t(locale, "data.canton.h1", { canton: cantonInText(canton, locale) }))}</a>`] : []),
    ...places.slice(0, 4).map((place) => `<a href="${escapeHtml(pathFor({ kind: "place", slug: place.slug }, locale))}">${escapeHtml(t(locale, "data.place.h1", { place: place.name }))}</a>`)
  ];
  return `<nav class="ev-crumbs brief__places" aria-label="${escapeHtml(t(locale, "nav.breadcrumbAria"))}">${links.join("")}</nav>`;
}

function trustLabel(detail: PublicEventDetail, locale: AppLocale): string {
  const trust = detail.item.trust as string;
  if (trust === "official") return t(locale, "ui.event.trustOfficial");
  if (trust === "corroborated") return t(locale, "ui.event.trustCorroborated");
  return t(locale, "ui.event.trustReported");
}

export function renderEventSeoMarkup(
  detail: PublicEventDetail,
  related: PublicFeedItem[] = [],
  live: OperatorLiveContext | null = null,
  locale: AppLocale = "de",
  now = Date.now()
): string {
  const item = detail.item;
  const location = eventLocation(detail);
  const kind = eventKind(detail, locale);
  const hasMap = Boolean(detail.map);
  const tone = eventTone(detail);
  const operator = detail.operator;
  const profile = live?.profile
    ?? (operator ? resolveOperatorProfile({ name: operator.name, domain: operator.domain, url: operator.url }) : null)
    ?? findOperatorProfile(operator?.name ?? item.source.publisher);
  const operatorName = operator?.name ?? profile?.name ?? null;
  const operatorHref = profile ? operatorProfileUrl(profile, locale) : null;
  const officialUrl = operator?.url ?? profile?.officialUrl ?? null;
  const head = headline(detail, locale, now);
  const relatedHeading = live?.profile && related.length
    ? t(locale, "event.related.headingOperator", { name: live.profile.name })
    : undefined;
  const timeUnits = {
    m: t(locale, "time.minutes", { count: "{{m}}" }),
    h: t(locale, "time.hours", { count: "{{h}}" }),
    hm: t(locale, "time.hoursMinutes", { hours: "{{h}}", minutes: "{{m}}" })
  };
  const liveTemplate = head.liveSince ? t(locale, "ui.event.headline.active", { duration: "{{duration}}" }) : "";
  return `<article class="ev" data-status="${escapeHtml(item.status ?? "historical")}" data-tone="${tone}">
    ${renderCrumbs(detail, locale)}
    <div class="ev-top">
      <div class="ev-main">
        <div class="ev-kicker">
          ${statePill(detail, locale)}
          <span>${escapeHtml(kind)}</span>
          <span class="ev-trust" data-trust="${escapeHtml(item.trust)}">${escapeHtml(trustLabel(detail, locale))}</span>
        </div>
        <h1>${escapeHtml(t(locale, "event.in", { kind, location }))}</h1>
        <p class="ev-headline"><strong${head.liveSince ? ` data-live-since="${escapeHtml(head.liveSince)}" data-template="${escapeHtml(liveTemplate)}" data-units="${escapeHtml(JSON.stringify(timeUnits))}"` : ""}>${escapeHtml(head.main)}</strong>${head.sub ? `<span>${escapeHtml(head.sub)}</span>` : ""}</p>
        ${renderWindow(detail, locale, now)}
        ${renderFacts(detail, locale, now, operatorName, operatorHref)}
        ${renderReport(detail, locale, now)}
        ${renderActions(detail, locale, operatorName, operatorHref, officialUrl)}
      </div>
      <div class="ev-map event-hero ${hasMap ? "has-map map-loading" : "no-map"}">${hasMap
        ? `<div id="event-map" role="img" aria-label="${escapeHtml(t(locale, "event.mapAria", { label: detail.map!.label }))}"></div><div class="map-fallback" aria-hidden="true"><span></span><strong>${escapeHtml(detail.map!.label)}</strong><small>${escapeHtml(t(locale, "event.mapLoading"))}</small></div><span class="map-place">${escapeHtml(detail.map!.label)}</span>`
        : ""}</div>
    </div>
    <div class="ev-body">
      <div class="ev-col">
        ${renderTips(detail, locale)}
        ${renderTimeline(detail, locale, now)}
        ${renderSources(detail, locale, now)}
        ${renderFaq(detail, locale)}
      </div>
      <div class="ev-col">
        ${renderRelatedEvents(related, locale, now, relatedHeading)}
        ${renderKnowledgeLinks(locale)}
      </div>
    </div>
    <footer class="ev-note">${escapeHtml(t(locale, "event.footer", { date: formatDate(item.updated_at, locale) }))}</footer>
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
