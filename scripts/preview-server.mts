/**
 * Local UI preview: serves the Astro build (dist/) and renders the Worker pages
 * (home list, event detail, statistics, places, canton, operators) with the same
 * render functions the Worker uses, fed by the public production API. No D1 and
 * no wrangler needed, which makes UI work fast.
 *
 *   npm run build && npx vite-node --watch scripts/preview-server.mts
 *   → http://127.0.0.1:4322/
 *
 * The Worker injects markup with HTMLRewriter; here a small tag-depth scanner
 * does the same for the few elements that are filled.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAppPath, pathFor, radarViewCopy, t, type AppLocale } from "../src/i18n";
import { renderHomeList } from "../src/seo-home";
import { fromIndex, viewCounts, countLabel } from "../src/radar-view";
import { buildHomeIndex, type PlacesPayload, type PublicIndexPayload, type StatsPayload } from "../src/public-stats";
import { renderEventSeoMarkup } from "../src/seo-event-page";
import { buildCantonPage, buildPlacePage, buildPlacesHubPage, buildStatsPage, type DataPage } from "../src/seo-data-pages";
import { cantonBySlug } from "../src/swiss-cantons";
import { publicOperatorProfiles, summarizeOperatorEvents } from "../src/operators";
import {
  groupPublicItemsByOperator,
  parseOperatorPath,
  renderElcomFactsSection,
  renderOperatorFaqsHtml,
  renderOperatorHubLiveFromStats,
  renderOperatorLiveSection
} from "../src/seo-operator-page";
import { formatAppDate } from "../src/i18n";
import type { PublicEventDetail } from "../src/public-detail";
import type { PublicSlice } from "../src/public-projection";
import type { PublicFeedItem } from "../src/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const PORT = Number(process.env.PREVIEW_PORT || 4322);
const API = process.env.PREVIEW_API_ORIGIN || "https://outage.ch";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};

// ------------------------------------------------------------------ data
async function getJson<T>(pathname: string): Promise<T> {
  const response = await fetch(`${API}${pathname}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${pathname} → ${response.status}`);
  return response.json() as Promise<T>;
}

let allItems: PublicFeedItem[] | null = null;
let allItemsAt = 0;
async function loadAllItems(): Promise<PublicFeedItem[]> {
  if (allItems && Date.now() - allItemsAt < 10 * 60_000) return allItems;
  const items: PublicFeedItem[] = [];
  let before: string | null = null;
  for (let page = 0; page < 40; page += 1) {
    const feed: { items: PublicFeedItem[]; next_cursor?: string | null } =
      await getJson(`/api/public/events?limit=40${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    items.push(...feed.items);
    const next = feed.next_cursor ?? null;
    if (!feed.items.length || !next || next === before) break;
    before = next;
  }
  allItems = items;
  allItemsAt = Date.now();
  return items;
}

function slice(items: PublicFeedItem[]): PublicSlice {
  const durations = items.map((item) => item.duration_minutes).filter((value): value is number => typeof value === "number" && value > 0).sort((a, b) => a - b);
  const sortAt = (item: PublicFeedItem) => item.started_at ?? item.received_at;
  const sorted = [...items].sort((a, b) => sortAt(a).localeCompare(sortAt(b)));
  const cutoff = Date.now() - 30 * 86_400_000;
  return {
    total: items.length,
    active: items.filter((item) => item.status === "active").length,
    upcoming: items.filter((item) => item.status === "upcoming").length,
    resolved: items.filter((item) => item.status === "resolved").length,
    planned: items.filter((item) => item.nature === "planned").length,
    unplanned: items.filter((item) => item.nature !== "planned").length,
    last30Days: items.filter((item) => new Date(sortAt(item)).getTime() >= cutoff).length,
    lastAt: sorted.at(-1) ? sortAt(sorted.at(-1)!) : null,
    firstAt: sorted[0] ? sortAt(sorted[0]) : null,
    medianDurationMinutes: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    knownDurations: durations.length
  };
}

function placesPayload(items: PublicFeedItem[]): PlacesPayload {
  const map = new Map<string, PlacesPayload["places"][number]>();
  for (const item of items) {
    for (const place of item.places ?? []) {
      const at = item.started_at ?? item.received_at;
      const entry = map.get(place.slug) ?? [place.slug, place.name, item.canton, 0, 0, null];
      entry[3] += 1;
      if (item.status === "active" || item.status === "upcoming") entry[4] += 1;
      if (!entry[5] || at > entry[5]) entry[5] = at;
      map.set(place.slug, entry);
    }
  }
  return { v: 1, generatedAt: new Date().toISOString(), places: [...map.values()].sort((a, b) => a[1].localeCompare(b[1])) };
}

// ------------------------------------------------------------------ html
function findElement(html: string, selector: { id?: string; tag?: string }): { start: number; openEnd: number; close: number; end: number } | null {
  const pattern = selector.id
    ? new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\bid="${selector.id}"[^>]*>`)
    : new RegExp(`<(${selector.tag})\\b[^>]*>`);
  const match = pattern.exec(html);
  if (!match) return null;
  const tag = match[1];
  const start = match.index;
  const openEnd = start + match[0].length;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  tagRe.lastIndex = openEnd;
  let depth = 1;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start, openEnd, close: m.index, end: m.index + m[0].length };
  }
  return null;
}

function setInner(html: string, id: string, content: string): string {
  const found = findElement(html, { id });
  if (!found) return html;
  return html.slice(0, found.openEnd) + content + html.slice(found.close);
}

function replaceOuter(html: string, id: string, content: string): string {
  const found = findElement(html, { id });
  if (!found) return html;
  return html.slice(0, found.start) + content + html.slice(found.end);
}

function setTitle(html: string, title: string): string {
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
}

function readDist(pathname: string): string | null {
  const clean = decodeURIComponent(pathname);
  for (const file of [path.join(ROOT, clean), path.join(ROOT, clean, "index.html")]) {
    if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) return fs.readFileSync(file, "utf8");
  }
  return null;
}

function setNav(html: string, nav: string): string {
  return html
    .replace(/(data-nav-id="[a-z]+")\s+aria-current="page"/g, "$1")
    .replace(new RegExp(`data-nav-id="${nav}"`, "g"), `data-nav-id="${nav}" aria-current="page"`);
}

function dataPageHtml(page: DataPage): string {
  const template = readDist(pathFor({ kind: "dataTemplate" }, page.locale)) ?? "";
  return setNav(setTitle(setInner(template, "data-shell", page.html), page.title), page.nav);
}

// ----------------------------------------------------------------- routes
async function render(pathname: string): Promise<string | null> {
  const parsed = parseAppPath(pathname);
  const operatorPath = parseOperatorPath(pathname);
  if (operatorPath) {
    const items = await loadAllItems();
    const grouped = groupPublicItemsByOperator(items);
    if (operatorPath.hub) {
      const stats = Object.fromEntries(publicOperatorProfiles().map((profile) => [profile.slug, summarizeOperatorEvents(grouped.get(profile.slug) ?? [])]));
      const live = renderOperatorHubLiveFromStats(stats, operatorPath.locale);
      let html = readDist(pathFor({ kind: "operators" }, operatorPath.locale)) ?? "";
      html = setInner(html, "operator-hub-live", live.summary);
      return setInner(html, "operator-list", live.list);
    }
    const profile = publicOperatorProfiles().find((entry) => entry.slug === operatorPath.slug);
    let html = readDist(pathname);
    if (!profile || !html) return html;
    const recent = grouped.get(profile.slug) ?? [];
    const live = { profile, stats: summarizeOperatorEvents(recent), recent: recent.slice(0, 12) };
    html = replaceOuter(html, "operator-live", renderOperatorLiveSection(live, operatorPath.locale));
    const facts = renderElcomFactsSection(profile, operatorPath.locale);
    if (facts) html = replaceOuter(html, "operator-facts", facts);
    return setInner(html, "operator-faq", renderOperatorFaqsHtml(profile, live.stats, operatorPath.locale));
  }
  if (!parsed) return null;
  const { locale, route } = parsed;

  if (route.kind === "home") {
    const index = await getJson<PublicIndexPayload>("/api/public/index.json");
    const home = buildHomeIndex(index);
    const items = fromIndex(home);
    const copy = radarViewCopy(locale);
    const counts = home.counts ?? viewCounts(items, "", Date.now());
    let html = readDist(pathFor({ kind: "home" }, locale)) ?? "";
    html = setInner(html, "radar-index", JSON.stringify(home).replace(/</g, "\\u003c"));
    html = setInner(html, "radar-list", renderHomeList(items, locale));
    html = setInner(html, "radar-count", countLabel(counts.now, copy));
    html = setInner(html, "radar-note", copy.asOf.replace("{{date}}", formatAppDate(index.generatedAt, locale, { dateStyle: "short", timeStyle: "short" }) ?? ""));
    html = html.replace(/(<[^>]*data-view-count="(now|planned|history)"[^>]*>)[^<]*/g, (_all, open: string, view: "now" | "planned" | "history") => `${open}${counts[view]}`);
    html = html.replace(/(<[^>]*data-live-count="(active|upcoming)"[^>]*>)[^<]*/g, (_all, open: string, key: "active" | "upcoming") =>
      `${open}${key === "active" ? items.filter((item) => item.status === "active").length : counts.planned}`);
    return html;
  }

  if (route.kind === "event") {
    const id = Number(route.slugId.match(/-(\d+)$/)?.[1]);
    const detail = await getJson<PublicEventDetail>(`/api/public/events/${id}`);
    const items = await loadAllItems();
    const sameOperator = items.filter((item) => item.id !== id && item.operator_slug && item.operator_slug === detail.item.operator_slug);
    const profile = publicOperatorProfiles().find((entry) => entry.slug === detail.item.operator_slug);
    const live = profile ? { profile, stats: summarizeOperatorEvents(sameOperator), recent: sameOperator.slice(0, 6) } : null;
    const related = live?.recent.length ? live.recent : items.filter((item) => item.id !== id).slice(0, 6);
    let html = readDist(pathFor({ kind: "eventsTemplate" }, locale)) ?? "";
    html = setInner(html, "event-shell", renderEventSeoMarkup(detail, related, live, locale));
    html = html.replace("</head>", `<script id="outage-event-data" type="application/json">${JSON.stringify(detail).replace(/</g, "\\u003c")}</script></head>`);
    return setTitle(html, `${detail.item.location} | outage.ch`);
  }

  if (route.kind === "stats") {
    const stats = await getJson<StatsPayload>("/api/public/stats.json");
    return dataPageHtml(buildStatsPage(stats, locale));
  }

  if (route.kind === "places") {
    return dataPageHtml(buildPlacesHubPage(placesPayload(await loadAllItems()), locale));
  }

  if (route.kind === "place") {
    const items = await loadAllItems();
    const matched = items.filter((item) => item.places?.some((place) => place.slug === route.slug));
    if (!matched.length) return null;
    const place = matched[0].places!.find((entry) => entry.slug === route.slug)!;
    const all = placesPayload(items);
    return dataPageHtml(buildPlacePage({
      slug: route.slug,
      name: place.name,
      canton: matched[0].canton,
      slice: slice(matched),
      items: matched.slice(0, 60),
      nearby: all.places.filter((entry) => entry[2] === matched[0].canton),
      generatedAt: all.generatedAt
    }, locale));
  }

  if (route.kind === "canton") {
    const canton = cantonBySlug(route.slug);
    if (!canton) return null;
    const items = await loadAllItems();
    const matched = items.filter((item) => item.canton === canton.code);
    const counts = new Map<string, { slug: string; name: string; count: number }>();
    for (const item of matched) {
      if (!item.operator_slug) continue;
      const entry = counts.get(item.operator_slug) ?? { slug: item.operator_slug, name: item.operator_name ?? item.source.publisher, count: 0 };
      entry.count += 1;
      counts.set(item.operator_slug, entry);
    }
    const all = placesPayload(items);
    return dataPageHtml(buildCantonPage({
      canton,
      slice: slice(matched),
      items: matched.slice(0, 60),
      places: all.places.filter((entry) => entry[2] === canton.code),
      operators: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      generatedAt: all.generatedAt
    }, locale));
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const upstream = await fetch(`${API}${url.pathname}${url.search}`);
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json", "Cache-Control": "no-store" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const isAsset = /\.[a-z0-9]+$/i.test(url.pathname);
    const rendered = isAsset ? null : await render(url.pathname);
    const html = rendered ?? (isAsset ? null : readDist(url.pathname));
    if (html !== null) {
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(t("de" as AppLocale, "notFound"));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(error instanceof Error ? error.stack : error));
  }
});

// `vite-node --watch` re-runs this file on every change: close the previous server first.
const previous = (globalThis as { __previewServer?: http.Server }).__previewServer;
const start = () => server.listen(PORT, "127.0.0.1", () => {
  console.log(`PREVIEW → http://127.0.0.1:${PORT}/`);
});
(globalThis as { __previewServer?: http.Server }).__previewServer = server;
if (previous) {
  previous.closeAllConnections?.();
  previous.close(() => start());
} else {
  start();
}
