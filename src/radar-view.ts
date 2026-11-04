/**
 * Radar list logic shared by the Worker (server-rendered first paint and SEO)
 * and the browser (instant search/filter over the full public index). Pure and
 * dependency-light on purpose: it is bundled into the client script.
 */
import { SWISS_CANTONS } from "./swiss-cantons";
import type { IndexEntry, PublicIndexPayload } from "./public-stats";

export type RadarView = "now" | "planned" | "history";
export type RadarNature = "" | "planned" | "unplanned";
export type RadarTone = "active" | "upcoming" | "resolved" | "other";

export interface RadarItem {
  id: number;
  slugId: string;
  location: string;
  status: string;
  nature: string;
  canton: string | null;
  operatorSlug: string | null;
  publisher: string;
  startMs: number | null;
  endMs: number | null;
  plannedEndMs: number | null;
  sortMs: number;
  lat: number | null;
  lon: number | null;
  places: string;
  /** Lower-cased search haystack. */
  hay: string;
}

export interface RadarCopy {
  locale: string;
  dateLocale: string;
  eventStem: string;
  localePrefix: string;
  status: Record<string, string>;
  nature: Record<string, string>;
  views: Record<RadarView, string>;
  natureAll: string;
  groups: Record<"active" | "next7" | "recent" | "today" | "tomorrow" | "results" | "later", string>;
  time: { since: string; reported: string; endedAt: string; window: string; lasted: string };
  countOne: string;
  countOther: string;
  empty: Record<RadarView | "query", string>;
  showMore: string;
  asOf: string;
  openReport: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_WINDOW_MS = 2 * DAY_MS;
export const NEXT_WINDOW_MS = 7 * DAY_MS;
export const HISTORY_PAGE = 60;

const minuteMs = (value: number | null) => (typeof value === "number" ? value * 60000 : null);

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const CANTON_WORDS = new Map(SWISS_CANTONS.map((canton) => [
  canton.code,
  fold([canton.code, ...Object.values(canton.names)].join(" "))
]));

export function fromIndexEntry(entry: IndexEntry): RadarItem {
  const [id, slugId, location, status, nature, canton, operatorSlug, publisher, startMin, endMin, plannedEndMin, sortMin, lat, lon, places] = entry;
  return {
    id,
    slugId,
    location,
    status,
    nature,
    canton,
    operatorSlug,
    publisher,
    startMs: minuteMs(startMin),
    endMs: minuteMs(endMin),
    plannedEndMs: minuteMs(plannedEndMin),
    sortMs: sortMin * 60000,
    lat,
    lon,
    places,
    hay: fold([location, places.replace(/-/g, " "), publisher, operatorSlug ?? "", canton ? CANTON_WORDS.get(canton) ?? canton : ""].join(" "))
  };
}

/** Same row model for server pages that read full public items. */
export function fromPublicItem(item: {
  id: number;
  url: string;
  location: string;
  status: string | null;
  nature: string;
  canton: string | null;
  operator_slug?: string | null;
  operator_name?: string | null;
  source: { publisher: string };
  started_at: string | null;
  resolved_at: string | null;
  expected_restore_at?: string | null;
  received_at: string;
  latitude?: number | null;
  longitude?: number | null;
  places?: Array<{ slug: string }>;
}): RadarItem {
  const ms = (value: string | null | undefined) => {
    const parsed = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(parsed) ? Math.round(parsed / 60000) : null;
  };
  return fromIndexEntry([
    item.id,
    item.url.replace(/^\/stromausfall\//, ""),
    item.location,
    item.status ?? "historical",
    item.nature,
    item.canton,
    item.operator_slug ?? null,
    item.operator_name ?? item.source.publisher,
    ms(item.started_at),
    ms(item.resolved_at),
    ms(item.expected_restore_at),
    ms(item.started_at) ?? ms(item.resolved_at) ?? ms(item.received_at) ?? 0,
    item.latitude ?? null,
    item.longitude ?? null,
    (item.places ?? []).map((place) => place.slug).join(" ")
  ]);
}

export function fromIndex(payload: PublicIndexPayload | null | undefined): RadarItem[] {
  return (payload?.items ?? []).map(fromIndexEntry);
}

export function toneOf(status: string): RadarTone {
  if (status === "active") return "active";
  if (status === "upcoming") return "upcoming";
  if (status === "resolved") return "resolved";
  return "other";
}

export function inView(item: RadarItem, view: RadarView, now: number): boolean {
  if (view === "planned") return item.status === "upcoming";
  if (view === "history") return item.status !== "upcoming";
  if (item.status === "active") return true;
  if (item.status === "upcoming") return (item.startMs ?? item.sortMs) - now <= NEXT_WINDOW_MS;
  const endedAt = item.endMs ?? item.sortMs;
  return now - endedAt <= RECENT_WINDOW_MS && endedAt <= now + 60000;
}

export function matchesNature(item: RadarItem, nature: RadarNature): boolean {
  if (nature === "planned") return item.nature === "planned";
  if (nature === "unplanned") return item.nature !== "planned";
  return true;
}

export function matchesQuery(item: RadarItem, query: string): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  return needle.split(/\s+/).every((part) => item.hay.includes(part));
}

export function sortForView(items: RadarItem[], view: RadarView): RadarItem[] {
  const upcomingFirst = (a: RadarItem, b: RadarItem) => (a.startMs ?? a.sortMs) - (b.startMs ?? b.sortMs);
  if (view === "planned") return [...items].sort(upcomingFirst);
  return [...items].sort((a, b) => {
    const rank = (item: RadarItem) => item.status === "active" ? 0 : item.status === "upcoming" ? 1 : 2;
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    if (a.status === "upcoming") return upcomingFirst(a, b);
    return b.sortMs - a.sortMs || b.id - a.id;
  });
}

// Intl formatters are expensive to construct; build each locale/option pair once.
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Zurich", ...options });
    formatterCache.set(key, formatter);
  }
  return formatter;
}
const relativeCache = new Map<string, Intl.RelativeTimeFormat>();

const dayKey = (ms: number) => dateFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

export interface RadarGroup {
  key: string;
  label: string;
  items: RadarItem[];
}

export function groupItems(items: RadarItem[], view: RadarView, now: number, copy: RadarCopy, searching = false): RadarGroup[] {
  if (searching) return items.length ? [{ key: "results", label: copy.groups.results, items }] : [];
  const groups = new Map<string, RadarGroup>();
  const push = (key: string, label: string, item: RadarItem) => {
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  };
  const today = dayKey(now);
  const tomorrow = dayKey(now + DAY_MS);
  const dayLabel = (ms: number) => {
    const key = dayKey(ms);
    if (key === today) return copy.groups.today;
    if (key === tomorrow) return copy.groups.tomorrow;
    return dateFormat(copy.dateLocale, { weekday: "long", day: "numeric", month: "long" }).format(new Date(ms));
  };
  for (const item of items) {
    if (view === "now") {
      if (item.status === "active") push("active", copy.groups.active, item);
      else if (item.status === "upcoming") push("next7", copy.groups.next7, item);
      else push("recent", copy.groups.recent, item);
    } else if (view === "planned") {
      const start = item.startMs ?? item.sortMs;
      push(dayKey(start), dayLabel(start), item);
    } else {
      const label = dateFormat(copy.dateLocale, { month: "long", year: "numeric" }).format(new Date(item.sortMs));
      push(dayKey(item.sortMs).slice(0, 7), label, item);
    }
  }
  return [...groups.values()];
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(ms: number, copy: RadarCopy): string {
  return dateFormat(copy.dateLocale, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function formatDay(ms: number, copy: RadarCopy, now: number): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date(now).getUTCFullYear();
  return dateFormat(copy.dateLocale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" })
  }).format(new Date(ms));
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours >= 48) return `${Math.round(hours / 24)} d`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function relativeTime(ms: number, now: number, copy: RadarCopy): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  let rtf = relativeCache.get(copy.dateLocale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(copy.dateLocale, { numeric: "auto", style: "short" });
    relativeCache.set(copy.dateLocale, rtf);
  }
  if (abs < 60 * 60000) return rtf.format(Math.round(diff / 60000), "minute");
  if (abs < DAY_MS) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / DAY_MS), "day");
}

function durationOnly(ms: number, now: number): string {
  return formatDuration(Math.abs(now - ms) / 60000);
}

/** The one line that answers "when?" for a row. */
export function timeLabel(item: RadarItem, now: number, copy: RadarCopy): string {
  const start = item.startMs;
  if (item.status === "upcoming") {
    const at = start ?? item.sortMs;
    const end = item.plannedEndMs;
    const startText = `${formatDay(at, copy, now)} ${formatTime(at, copy)}`;
    if (end && end > at) {
      const endText = dayKey(end) === dayKey(at) ? formatTime(end, copy) : `${formatDay(end, copy, now)} ${formatTime(end, copy)}`;
      return copy.time.window.replace("{{start}}", startText).replace("{{end}}", endText);
    }
    return startText;
  }
  if (item.status === "active") {
    if (start && start <= now) return copy.time.since.replace("{{relative}}", durationOnly(start, now));
    return copy.time.reported.replace("{{relative}}", relativeTime(item.sortMs, now, copy));
  }
  const end = item.endMs;
  const when = end ?? start ?? item.sortMs;
  const day = `${formatDay(when, copy, now)} ${formatTime(when, copy)}`;
  if (start && end && end > start) return `${day} · ${formatDuration((end - start) / 60000)}`;
  return day;
}

export function eventHref(item: RadarItem, copy: RadarCopy): string {
  return `${copy.localePrefix}/${copy.eventStem}/${item.slugId}`;
}

function shortLocation(value: string): string {
  return value.split(",")[0]?.trim() || value;
}

function iconSvg(item: RadarItem): string {
  return item.nature === "planned"
    ? `<svg class="radar-item__icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2.5"/></svg>`
    : `<svg class="radar-item__icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6 14 13H2z"/></svg>`;
}

export function rowHtml(item: RadarItem, now: number, copy: RadarCopy, selected = false): string {
  const tone = toneOf(item.status);
  const status = copy.status[item.status === "stale_unconfirmed" ? "stale" : item.status] ?? copy.status.unknown ?? item.status;
  const nature = copy.nature[item.nature] ?? copy.nature.unknown ?? "";
  const extra = item.location.includes(",") ? item.location.split(",").slice(1).join(",").trim() : "";
  return `<a class="radar-item radar-item--${tone}${selected ? " is-selected" : ""}" href="${escapeHtml(eventHref(item, copy))}" data-id="${item.id}"${selected ? ' aria-current="true"' : ""}>`
    + `<span class="radar-item__mark">${iconSvg(item)}</span>`
    + `<span class="radar-item__main"><span class="radar-item__title">${escapeHtml(shortLocation(item.location))}`
    + `${item.canton ? `<span class="radar-item__canton">${escapeHtml(item.canton)}</span>` : ""}</span>`
    + `<span class="radar-item__meta">${escapeHtml(nature)}${item.publisher ? ` · ${escapeHtml(item.publisher)}` : ""}${extra ? ` · ${escapeHtml(extra)}` : ""}</span></span>`
    + `<span class="radar-item__side"><span class="radar-item__status">${escapeHtml(status)}</span>`
    + `<time class="radar-item__time">${escapeHtml(timeLabel(item, now, copy))}</time></span>`
    + `</a>`;
}

export function countLabel(count: number, copy: RadarCopy): string {
  return (count === 1 ? copy.countOne : copy.countOther).replace("{{count}}", String(count));
}

export function groupsHtml(groups: RadarGroup[], now: number, copy: RadarCopy, selectedId: number | null = null): string {
  return groups.map((group) =>
    `<section class="radar-group" data-group="${escapeHtml(group.key)}">`
    + `<h3 class="radar-group__head"><span>${escapeHtml(group.label)}</span><span class="radar-group__n">${group.items.length}</span></h3>`
    + group.items.map((item) => rowHtml(item, now, copy, item.id === selectedId)).join("")
    + `</section>`
  ).join("");
}

export function viewCounts(items: RadarItem[], nature: RadarNature, now: number): Record<RadarView, number> {
  const counts: Record<RadarView, number> = { now: 0, planned: 0, history: 0 };
  for (const item of items) {
    if (!matchesNature(item, nature)) continue;
    for (const view of ["now", "planned", "history"] as const) if (inView(item, view, now)) counts[view] += 1;
  }
  return counts;
}
