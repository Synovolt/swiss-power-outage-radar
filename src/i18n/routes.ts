import {
  APP_LOCALES,
  DATE_LOCALE,
  DEFAULT_LOCALE,
  EVENT_STEM,
  EVENT_STEMS,
  HREFLANG,
  type AppLocale,
  isPrefixLocale,
  localeFromParam,
  localePrefix
} from "./locales";
import { cantonBySlug, cantonSlug } from "../swiss-cantons";

export const HELP_GUIDE_PATH = "/ratgeber/stromausfall-was-tun/";

export type AppRoute =
  | { kind: "home" }
  | { kind: "about" }
  | { kind: "operators" }
  | { kind: "operator"; slug: string }
  | { kind: "guides" }
  | { kind: "guide"; slug: string }
  | { kind: "event"; slugId: string }
  | { kind: "eventsTemplate" }
  | { kind: "stats" }
  | { kind: "places" }
  | { kind: "place"; slug: string }
  | { kind: "canton"; slug: string }
  | { kind: "dataTemplate" };

const EVENT_STEM_PATTERN = EVENT_STEMS.join("|");

export const STATS_STEM: Record<AppLocale, string> = {
  de: "statistik",
  fr: "statistiques",
  it: "statistiche",
  en: "statistics"
};

export const CANTON_STEM: Record<AppLocale, string> = {
  de: "kanton",
  fr: "canton",
  it: "cantone",
  en: "canton"
};

const STATS_STEM_PATTERN = [...new Set(Object.values(STATS_STEM))].join("|");
const CANTON_STEM_PATTERN = [...new Set(Object.values(CANTON_STEM))].join("|");

export function parseLocaleFromPath(pathname: string): AppLocale {
  const match = pathname.match(/^\/(fr|it|en)(?:\/|$)/);
  return match ? localeFromParam(match[1]) : DEFAULT_LOCALE;
}

export function stripLocalePrefix(pathname: string): { locale: AppLocale; rest: string } {
  const match = pathname.match(/^\/(fr|it|en)(\/.*)?$/);
  if (!match) return { locale: "de", rest: pathname || "/" };
  return { locale: match[1] as AppLocale, rest: match[2] || "/" };
}

export function dePrefixTarget(pathname: string): string | null {
  if (pathname === "/de" || pathname === "/de/") return "/";
  if (pathname.startsWith("/de/")) {
    const rest = pathname.slice(3);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return null;
}

export function eventsTemplateTarget(pathname: string): string | null {
  if (pathname === "/events" || pathname === "/events/") return "/";
  const prefixed = pathname.match(/^\/(fr|it|en)\/events\/?$/);
  return prefixed ? `/${prefixed[1]}/` : null;
}

export function pathFor(route: AppRoute, locale: AppLocale = "de"): string {
  const prefix = localePrefix(locale);
  switch (route.kind) {
    case "home":
      return prefix ? `${prefix}/` : "/";
    case "about":
      return `${prefix}/ueber/`;
    case "operators":
      return `${prefix}/netzbetreiber/`;
    case "operator":
      return `${prefix}/netzbetreiber/${route.slug}/`;
    case "guides":
      return `${prefix}/ratgeber/`;
    case "guide":
      return `/ratgeber/${route.slug}/`;
    case "event":
      return `${prefix}/${EVENT_STEM[locale]}/${route.slugId}`;
    case "eventsTemplate":
      return `${prefix}/events/`;
    case "stats":
      return `${prefix}/${STATS_STEM[locale]}/`;
    case "places":
      return `${prefix}/${EVENT_STEM[locale]}/`;
    case "place":
      return `${prefix}/${EVENT_STEM[locale]}/${route.slug}`;
    case "canton":
      return `${prefix}/${EVENT_STEM[locale]}/${CANTON_STEM[locale]}/${route.slug}`;
    case "dataTemplate":
      return `${prefix}/data-template/`;
  }
}

/** Static shells that only exist to be filled by the Worker; never served directly. */
export function templateShellTarget(pathname: string): string | null {
  const shell = pathname.match(/^(?:\/(fr|it|en))?\/(?:events|data-template)\/?$/);
  if (!shell) return null;
  return shell[1] ? `/${shell[1]}/` : "/";
}

export function parseAppPath(pathname: string): { locale: AppLocale; route: AppRoute } | null {
  if (dePrefixTarget(pathname)) return null;
  const { locale, rest } = stripLocalePrefix(pathname);
  const path = rest === "/" || rest === "" ? "/" : rest.replace(/\/+$/, "") || "/";

  if (path === "/") return { locale, route: { kind: "home" } };
  if (path === "/ueber") return { locale, route: { kind: "about" } };
  if (path === "/ratgeber") return { locale, route: { kind: "guides" } };
  if (path === "/netzbetreiber") return { locale, route: { kind: "operators" } };
  if (path === "/events") return { locale, route: { kind: "eventsTemplate" } };

  const operator = path.match(/^\/netzbetreiber\/([a-z0-9-]+)$/);
  if (operator) return { locale, route: { kind: "operator", slug: operator[1] } };

  const guide = path.match(/^\/ratgeber\/([a-z0-9-]+)$/);
  if (guide) return { locale, route: { kind: "guide", slug: guide[1] } };

  if (path === "/data-template") return { locale, route: { kind: "dataTemplate" } };

  const event = path.match(new RegExp(`^/(?:${EVENT_STEM_PATTERN})/([a-z0-9-]+-\\d+)$`));
  if (event) return { locale, route: { kind: "event", slugId: event[1] } };

  if (new RegExp(`^/(?:${STATS_STEM_PATTERN})$`).test(path)) return { locale, route: { kind: "stats" } };
  if (new RegExp(`^/(?:${EVENT_STEM_PATTERN})$`).test(path)) return { locale, route: { kind: "places" } };

  const canton = path.match(new RegExp(`^/(?:${EVENT_STEM_PATTERN})/(?:${CANTON_STEM_PATTERN})/([a-z0-9-]+)$`));
  if (canton) return { locale, route: { kind: "canton", slug: canton[1] } };

  const place = path.match(new RegExp(`^/(?:${EVENT_STEM_PATTERN})/([a-z0-9-]*[a-z][a-z0-9-]*)$`));
  if (place && !/-\d+$/.test(place[1])) return { locale, route: { kind: "place", slug: place[1] } };

  return null;
}

export function localizeStoredEventUrl(storedUrl: string, locale: AppLocale): string {
  const match = storedUrl.match(/^\/stromausfall\/([a-z0-9-]+-\d+)\/?$/);
  if (!match) return storedUrl;
  return pathFor({ kind: "event", slugId: match[1] }, locale);
}

export function eventIdFromPath(pathname: string): number | null {
  const match = pathname.match(new RegExp(`(?:/(?:${EVENT_STEM_PATTERN})/|\\/events\\/)(?:[a-z0-9-]*-)?(\\d+)\\/?$`));
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function eventStemFromPath(pathname: string): string | null {
  const match = pathname.match(new RegExp(`^/(?:(fr|it|en)/)?(${EVENT_STEM_PATTERN})/`));
  return match?.[2] ?? null;
}

export function canonicalEventPath(storedUrl: string, pathname: string): string {
  const locale = parseLocaleFromPath(pathname);
  return localizeStoredEventUrl(storedUrl, locale);
}

export function eventCanonicalRedirect(pathname: string, storedUrl: string): string | null {
  const expected = canonicalEventPath(storedUrl, pathname);
  return pathname === expected ? null : expected;
}

/** Routes whose slug itself is localized (canton names) are translated here. */
export function localizeRoute(route: AppRoute, locale: AppLocale): AppRoute {
  if (route.kind !== "canton") return route;
  const canton = cantonBySlug(route.slug);
  return canton ? { kind: "canton", slug: cantonSlug(canton, locale) } : route;
}

export function alternatePath(pathname: string, target: AppLocale): string {
  const parsed = parseAppPath(pathname);
  if (!parsed) return pathFor({ kind: "home" }, target);
  if (parsed.route.kind === "guide") {
    return target === "de" ? pathFor(parsed.route, "de") : pathFor({ kind: "guides" }, target);
  }
  return pathFor(localizeRoute(parsed.route, target), target);
}

/** Canonical path for a parsed public route, or null when the route is not a page. */
export function canonicalRoutePath(pathname: string): string | null {
  const parsed = parseAppPath(pathname);
  if (!parsed) return null;
  return pathFor(localizeRoute(parsed.route, parsed.locale), parsed.locale);
}

export function hreflangEntries(pathname: string, origin: string): Array<{ locale: AppLocale | "x-default"; href: string; hreflang: string }> {
  const parsed = parseAppPath(pathname);
  if (!parsed || parsed.route.kind === "eventsTemplate" || parsed.route.kind === "dataTemplate") return [];
  const route = parsed.route;
  const locales: AppLocale[] = route.kind === "guide" ? ["de"] : [...APP_LOCALES];
  const seen = new Set<string>();
  const entries: Array<{ locale: AppLocale | "x-default"; href: string; hreflang: string }> = [];
  for (const locale of locales) {
    const hreflang = HREFLANG[locale];
    if (seen.has(hreflang)) continue;
    seen.add(hreflang);
    entries.push({ locale, href: `${origin}${pathFor(localizeRoute(route, locale), locale)}`, hreflang });
  }
  const defaultHref = `${origin}${pathFor(localizeRoute(route, "de"), "de")}`;
  if (!seen.has("x-default")) {
    entries.push({ locale: "x-default", href: defaultHref, hreflang: "x-default" });
  }
  return entries;
}

export function isPrefixLocalePath(pathname: string): boolean {
  return isPrefixLocale(pathname.split("/").filter(Boolean)[0]);
}

export function dateLocale(locale: AppLocale): string {
  return DATE_LOCALE[locale];
}
