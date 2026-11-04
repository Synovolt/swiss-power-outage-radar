import i18next from "i18next";
import { de, fr } from "./catalogs";
import { en, it } from "./catalogs-it-en";
import { dataDe, dataEn, dataFr, dataIt } from "./catalog-data";
import { uiDe, uiEn, uiFr, uiIt } from "./catalog-ui";
import { DATE_LOCALE, EVENT_STEM, localePrefix, type AppLocale } from "./locales";
import type { RadarCopy } from "../radar-view";

const i18n = i18next.createInstance();

void i18n.init({
  lng: "de",
  fallbackLng: "de",
  resources: {
    de: { translation: { ...de, data: dataDe, ui: uiDe } },
    fr: { translation: { ...fr, data: dataFr, ui: uiFr } },
    it: { translation: { ...it, data: dataIt, ui: uiIt } },
    en: { translation: { ...en, data: dataEn, ui: uiEn } }
  },
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false
});

export function t(locale: AppLocale, key: string, options?: Record<string, unknown>): string {
  return String(i18n.getFixedT(locale)(key, options ?? {}));
}

export function homeFaqs(locale: AppLocale = "de"): Array<{ question: string; answer: string }> {
  return (["1", "2", "3", "4", "5"] as const).map((id) => ({
    question: t(locale, `home.faq.${id}.q`),
    answer: t(locale, `home.faq.${id}.a`)
  }));
}

export function formatAppDate(
  value: string | null | undefined,
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions = { dateStyle: "long", timeStyle: "short" }
): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(DATE_LOCALE[locale], { ...options, timeZone: "Europe/Zurich" }).format(date)
    : null;
}

export function formatAppDuration(minutes: number | null, locale: AppLocale): string | null {
  if (minutes === null || minutes < 0) return null;
  if (minutes < 60) return t(locale, "time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? t(locale, "time.hoursMinutes", { hours, minutes: rest })
    : t(locale, "time.hours", { count: hours });
}

/** Copy for the shared radar list renderer (src/radar-view.ts). */
export function radarViewCopy(locale: AppLocale): RadarCopy {
  const r = (key: string, options?: Record<string, unknown>) => t(locale, `data.radar.${key}`, options);
  return {
    locale,
    dateLocale: DATE_LOCALE[locale],
    eventStem: EVENT_STEM[locale],
    localePrefix: localePrefix(locale),
    status: {
      upcoming: t(locale, "status.upcoming"),
      active: t(locale, "status.activeShort"),
      resolved: t(locale, "status.resolved"),
      stale: t(locale, "status.staleShort"),
      historical: t(locale, "status.historicalShort"),
      unknown: t(locale, "status.unknown")
    },
    nature: {
      planned: t(locale, "nature.planned"),
      unplanned: t(locale, "nature.unplanned"),
      unknown: t(locale, "nature.unknown")
    },
    views: { now: r("views.now"), planned: r("views.planned"), history: r("views.history") },
    natureAll: r("natureAll"),
    groups: {
      active: r("groups.active"),
      next7: r("groups.next7"),
      recent: r("groups.recent"),
      today: r("groups.today"),
      tomorrow: r("groups.tomorrow"),
      results: r("groups.results"),
      later: r("groups.later")
    },
    time: {
      since: r("time.since", { relative: "{{relative}}" }),
      reported: r("time.reported", { relative: "{{relative}}" }),
      endedAt: r("time.endedAt", { date: "{{date}}" }),
      window: r("time.window", { start: "{{start}}", end: "{{end}}" }),
      lasted: r("time.lasted", { duration: "{{duration}}" }),
      until: t(locale, "ui.row.until", { time: "{{time}}" })
    },
    state: {
      active: t(locale, "ui.status.active"),
      upcoming: t(locale, "ui.status.upcoming"),
      ended: t(locale, "ui.status.ended")
    },
    kind: {
      planned: t(locale, "nature.plannedList"),
      unplanned: t(locale, "nature.unplannedKind")
    },
    tiles: {
      activeOne: t(locale, "ui.home.activeLabel", { count: 1 }),
      activeOther: t(locale, "ui.home.activeLabel", { count: 2 }),
      plannedOne: t(locale, "ui.home.plannedLabel", { count: 1 }),
      plannedOther: t(locale, "ui.home.plannedLabel", { count: 2 })
    },
    historyLink: t(locale, "ui.home.historyLink"),
    countOne: r("count", { count: 1 }).replace("1", "{{count}}"),
    countOther: r("count", { count: 2 }).replace("2", "{{count}}"),
    empty: {
      now: r("emptyNow"),
      planned: r("emptyPlanned"),
      history: r("emptyHistory"),
      query: r("emptyQuery", { query: "{{query}}" })
    },
    showMore: r("showMore", { count: "{{count}}" }),
    asOf: t(locale, "home.asOf", { date: "{{date}}" }),
    openReport: t(locale, "home.openReport")
  };
}

export function radarCopy(locale: AppLocale) {
  return {
    locale,
    status: {
      upcoming: t(locale, "status.upcoming"),
      active: t(locale, "status.activeShort"),
      resolved: t(locale, "status.resolved"),
      stale: t(locale, "status.staleShort"),
      historical: t(locale, "status.historicalShort"),
      unknown: t(locale, "status.unknown")
    },
    nature: {
      planned: t(locale, "nature.planned").toLowerCase(),
      unplanned: t(locale, "nature.unplanned").toLowerCase(),
      unknown: t(locale, "nature.unknown").toLowerCase()
    },
    filters: {
      all: t(locale, "home.filterAll"),
      allNatures: t(locale, "home.filterAllNatures"),
      active: t(locale, "status.activeShort"),
      upcoming: t(locale, "status.upcoming"),
      resolved: t(locale, "status.resolved"),
      historical: t(locale, "status.historicalShort"),
      unplanned: t(locale, "nature.unplanned"),
      planned: t(locale, "nature.planned")
    },
    visibleCount: t(locale, "home.visibleCount"),
    loadError: t(locale, "home.loadError"),
    retry: t(locale, "home.retry"),
    emptyQuery: t(locale, "home.emptyQuery"),
    emptyFilter: t(locale, "home.emptyFilter"),
    showAll: t(locale, "home.showAll"),
    openReport: t(locale, "home.openReport"),
    loading: t(locale, "home.loading"),
    asOf: t(locale, "home.asOf"),
    dateLocale: DATE_LOCALE[locale]
  };
}

export { APP_LOCALES, DATE_LOCALE, DEFAULT_LOCALE, EVENT_STEM, EVENT_STEMS, HREFLANG, HTML_LANG, OG_LOCALE, PREFIX_LOCALES, isAppLocale, isPrefixLocale, localeFromParam, localeParam, localePrefix, localeStaticPaths, type AppLocale, type PrefixLocale } from "./locales";
export {
  HELP_GUIDE_PATH,
  CANTON_STEM,
  STATS_STEM,
  alternatePath,
  canonicalRoutePath,
  canonicalEventPath,
  dateLocale,
  dePrefixTarget,
  eventCanonicalRedirect,
  eventIdFromPath,
  eventsTemplateTarget,
  eventStemFromPath,
  hreflangEntries,
  localizeRoute,
  localizeStoredEventUrl,
  parseAppPath,
  parseLocaleFromPath,
  pathFor,
  stripLocalePrefix,
  templateShellTarget,
  type AppRoute
} from "./routes";
