import {
  dismissOutageEvent,
  getDebugStatus,
  getMergeSuggestionsForEvent,
  getPublicStatus,
  getRecentItems,
  getSnapshotsNeedingPublicDigest,
  isPublicEvidenceSnapshot,
  markOutageEventCorroborated,
  mergeOutageEvent,
  updateSourceSnapshotDigest
} from "./db";
import { summarizeSourceForPublic } from "./ai";
import { generateMergeSuggestions, refreshEventIntelligence } from "./event-intelligence";
import { backfillSourcePlaceMentions, syncOpenPlzLocalities } from "./places";
import { researchOutageEvent } from "./research";
import { applyPublicationGate, ingestFirecrawlWebhook, revalidatePublicEvents, runAlertCheck } from "./runner";
import { loadPublicEventDetail } from "./public-detail";
import { SITE_ORIGIN, httpsRedirect, siteOriginFromRequest } from "./public-url";
import { evidenceScreenshotKey } from "./snapshots";
import { operatorBySlug, resolveOperatorProfile, type OperatorLiveStats } from "./operators";
import { renderSeoEventAsset } from "./seo-event-page";
import { renderHomeSeoAsset } from "./seo-home";
import { edgeCacheKey, forEdgeCache, restoreBrowserCaching } from "./edge-cache";
import { unavailableResponse } from "./outage-fallback";
import {
  loadOperatorLive,
  operatorSitemapLastmods,
  parseOperatorPath,
  renderSeoOperatorAsset,
  renderSeoOperatorHubAsset
} from "./seo-operator-page";
import {
  buildCantonPage,
  buildPlacePage,
  buildPlacesHubPage,
  buildStatsPage,
  placeIsIndexable,
  renderDataPage
} from "./seo-data-pages";
import {
  buildLlmsTxt,
  buildPublicSitemapDocuments,
  buildRobotsTxt,
  isSitemapPath,
  sitemapCacheControl,
  SITEMAP_EVENTS_PATH,
  SITEMAP_PAGES_PATH,
  SITEMAP_PLACES_PATH
} from "./seo-site";
import {
  canonicalRoutePath,
  dePrefixTarget,
  eventCanonicalRedirect,
  parseAppPath,
  parseLocaleFromPath,
  t,
  templateShellTarget
} from "./i18n";
import { publicEventIdFromPath } from "./public-url";
import {
  getPublicPlace,
  listPublicFeed,
  listPublicItems,
  backfillEventCantons,
  listPublicItemsLite,
  readStatsCache,
  readStatsCacheRaw,
  refreshPublicProjection,
  summarizePublicSlice
} from "./public-projection";
import {
  HOME_INDEX_CACHE_KEY,
  INDEX_CACHE_KEY,
  OPERATOR_STATS_CACHE_KEY,
  buildHomeIndex,
  PLACES_CACHE_KEY,
  STATS_CACHE_KEY,
  buildPublicIndex,
  loadAggregateRows,
  refreshPublicAggregates,
  type PlacesPayload,
  type PublicIndexPayload,
  type StatsPayload
} from "./public-stats";
import { cantonBySlug } from "./swiss-cantons";
import { isBearerAuthorized } from "./auth";
import { escapeHtml } from "./html";
import type { Env } from "./types";

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers ?? {})
    },
    status: init?.status
  });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, { status: 401 });
}

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

function isAuthorized(request: Request, env: Env): boolean {
  return isBearerAuthorized(request.headers.get("Authorization"), env.ADMIN_TOKEN);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const text = await request.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function bodyNote(body: Record<string, unknown>): string | null {
  const note = body.admin_note ?? body.note;
  if (note === undefined || note === null) return null;
  return String(note).slice(0, 1000);
}

/** Internal ops page (bearer protected). Public pages never show feed URLs or secrets. */
function renderStatusPage(status: Awaited<ReturnType<typeof getPublicStatus>>): string {
  const totals = (status.totals ?? {}) as Record<string, unknown>;
  const lastRun = (status.lastRun ?? {}) as Record<string, unknown>;
  const feedHealth = status.feedHealth as Record<string, unknown>[];
  const events = status.events as Record<string, unknown>[];
  const feeds = feedHealth.map((feed) => `<tr><td>${escapeHtml(feed.feed_language)}</td><td>${escapeHtml(feed.last_success_at ?? "-")}</td><td>${escapeHtml(feed.items_seen_last_run ?? 0)}</td><td>${escapeHtml(feed.items_new_last_run ?? 0)}</td><td>${escapeHtml(feed.last_error ?? "")}</td></tr>`).join("");
  const rows = events.map((event) => `<tr><td>${escapeHtml(event.last_seen_at ?? event.first_seen_at ?? "-")}</td><td>${escapeHtml(event.location_text ?? "–")}</td><td>${escapeHtml(event.status ?? "-")}</td><td>${escapeHtml(event.source_count ?? 0)}</td><td>${escapeHtml(event.confidence ?? "-")}</td><td><a href="/events/${escapeHtml(event.id)}">#${escapeHtml(event.id)}</a></td></tr>`).join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>outage.ch · Betrieb</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;background:Canvas;color:CanvasText}main{max-width:1080px;margin:0 auto;padding:32px 20px}table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent);text-align:left;font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}.metric{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:8px;padding:14px}.metric strong{display:block;font-size:26px}</style></head>
<body><main><h1>outage.ch · Betrieb</h1><p>Interner Status der Quellenpipeline (Netzbetreiberquellen, Discovery-Feeds, Event-Akten).</p>
<section class="grid"><div class="metric">Letzter Lauf<strong>${escapeHtml(lastRun.status ?? "-")}</strong>${escapeHtml(lastRun.finished_at ?? lastRun.started_at ?? "-")}</div><div class="metric">Items 24h<strong>${escapeHtml(totals.items_last_24h ?? 0)}</strong></div><div class="metric">Events 24h<strong>${escapeHtml(totals.events_last_24h ?? 0)}</strong></div><div class="metric">Mails 24h<strong>${escapeHtml(totals.emails_last_24h ?? 0)}</strong></div></section>
<h2>Discovery-Feeds</h2><table><thead><tr><th>Sprache</th><th>Letzter Erfolg</th><th>Gesehen</th><th>Neu</th><th>Fehler</th></tr></thead><tbody>${feeds || `<tr><td colspan="5">Keine Prüfung.</td></tr>`}</tbody></table>
<h2>Letzte Event-Akten</h2><table><thead><tr><th>Zeit</th><th>Ort</th><th>Status</th><th>Quellen</th><th>Confidence</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">Keine Event-Akten.</td></tr>`}</tbody></table></main></body></html>`;
}

/** Bump to drop every cached public response without a deploy. */
const PUBLIC_CACHE_VERSION = "seo-v10";

/**
 * Worker version, set on the first request. An isolate only ever runs one
 * version, so cached HTML never outlives the deploy whose asset hashes it
 * references (otherwise pages load without CSS/JS until the entry expires).
 */
let deployVersion = "dev";

function publicCacheRequest(request: Request): Request {
  return edgeCacheKey(request, `${PUBLIC_CACHE_VERSION}-${deployVersion}`);
}

function cachePublic(response: Response, request: Request, ctx: ExecutionContext, cacheControl: string): Response {
  const fresh = new Response(response.body, response);
  fresh.headers.set("Cache-Control", cacheControl);
  if (response.ok) ctx.waitUntil(caches.default.put(publicCacheRequest(request), forEdgeCache(fresh.clone())));
  return fresh;
}

const CACHE = {
  home: "public,max-age=60,s-maxage=120,stale-while-revalidate=600",
  event: "public,max-age=60,s-maxage=300,stale-while-revalidate=1800",
  data: "public,max-age=120,s-maxage=600,stale-while-revalidate=3600",
  api: "public,max-age=60,s-maxage=120,stale-while-revalidate=600",
  text: "public,max-age=300,s-maxage=3600"
} as const;

function isPublicApi(pathname: string): boolean {
  return pathname === "/api/public/events" ||
    pathname === "/api/public/status" ||
    pathname === "/api/public/index.json" ||
    pathname === "/api/public/stats.json" ||
    /^\/api\/public\/events\/\d+$/.test(pathname) ||
    /^\/api\/public\/evidence\/\d+\.png$/.test(pathname);
}

/** Pages and files whose responses may be shared through the edge cache. */
function isCacheablePublicPath(pathname: string): boolean {
  if (isPublicApi(pathname) || isSitemapPath(pathname) || pathname === "/robots.txt" || pathname === "/llms.txt") return true;
  const parsed = parseAppPath(pathname);
  return Boolean(parsed && ["home", "event", "operators", "operator", "stats", "places", "place", "canton"].includes(parsed.route.kind));
}

async function readIndex(env: Env): Promise<PublicIndexPayload | null> {
  const cached = await readStatsCache<PublicIndexPayload>(env.DB, INDEX_CACHE_KEY);
  if (cached) return cached.payload;
  // Only between a deploy and the first aggregate refresh: build from the projection.
  const rows = await loadAggregateRows(env.DB).catch(() => []);
  return rows.length ? buildPublicIndex(rows) : null;
}

async function readPlaces(env: Env): Promise<PlacesPayload | null> {
  return (await readStatsCache<PlacesPayload>(env.DB, PLACES_CACHE_KEY))?.payload ?? null;
}

/** Keeps the public projection in step after an admin action changed events. */
async function republish(env: Env, eventIds: number[]): Promise<void> {
  const projection = await refreshPublicProjection(env, { eventIds });
  await refreshPublicAggregates(env, { projectionChanged: projection.written + projection.removed > 0 });
}

/** 301 to the incident an event was merged into (duplicates found by the operator pipeline). */
async function mergedEventRedirect(env: Env, eventId: number, origin: string): Promise<Response | null> {
  let id = eventId;
  for (let hop = 0; hop < 3; hop += 1) {
    const row = await env.DB.prepare("SELECT merged_into_event_id FROM outage_events WHERE id = ?")
      .bind(id).first<{ merged_into_event_id: number | null }>();
    if (!row?.merged_into_event_id) break;
    id = row.merged_into_event_id;
  }
  if (id === eventId) return null;
  const target = await loadPublicEventDetail(env, id);
  return target ? Response.redirect(new URL(target.item.url, origin).toString(), 301) : null;
}

const app = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const forcedHttps = httpsRedirect(request);
    if (forcedHttps) return forcedHttps;
    if (env.CF_VERSION_METADATA?.id) deployVersion = env.CF_VERSION_METADATA.id;

    const url = new URL(request.url);
    const publicOrigin = siteOriginFromRequest(request);
    const isRead = request.method === "GET" || request.method === "HEAD";

    if (isRead) {
      const strippedDe = dePrefixTarget(url.pathname);
      if (strippedDe) return Response.redirect(new URL(strippedDe + url.search, publicOrigin).toString(), 301);
      const shell = templateShellTarget(url.pathname);
      if (shell) return Response.redirect(new URL(shell + url.search, publicOrigin).toString(), 301);
    }

    if (request.method === "GET" && isCacheablePublicPath(url.pathname)) {
      const cached = await caches.default.match(publicCacheRequest(request));
      if (cached) return restoreBrowserCaching(cached);
    }

    // Legacy /events/:id links → canonical event URL.
    const legacyEvent = url.pathname.match(/^\/events\/(\d+)\/?$/);
    if (legacyEvent && isRead) {
      const detail = await loadPublicEventDetail(env, Number(legacyEvent[1]));
      if (!detail) {
        const merged = await mergedEventRedirect(env, Number(legacyEvent[1]), publicOrigin);
        return merged ?? new Response("Event nicht gefunden", { status: 404 });
      }
      return Response.redirect(new URL(detail.item.url, publicOrigin).toString(), 301);
    }

    const route = isRead ? parseAppPath(url.pathname) : null;
    if (route && request.method === "GET") {
      const locale = route.locale;

      if (route.route.kind === "event") {
        const eventId = publicEventIdFromPath(url.pathname);
        const detail = eventId ? await loadPublicEventDetail(env, eventId) : null;
        if (!detail || !eventId) {
          // Duplicates folded into another incident keep their URL as a redirect.
          const merged = eventId ? await mergedEventRedirect(env, eventId, publicOrigin) : null;
          return merged ?? new Response(t(locale, "notFound"), { status: 404 });
        }
        const redirectTo = eventCanonicalRedirect(url.pathname, detail.item.url);
        if (redirectTo) return Response.redirect(new URL(redirectTo + url.search, publicOrigin).toString(), 301);
        const liveProfile = resolveOperatorProfile({
          name: detail.operator?.name ?? detail.item.source.publisher,
          domain: detail.operator?.domain ?? detail.item.source.domain,
          url: detail.operator?.url ?? detail.item.source.url
        });
        const live = liveProfile ? await loadOperatorLive(env.DB, liveProfile, { excludeId: eventId }) : null;
        const related = live?.recent.length
          ? live.recent.slice(0, 6)
          : await listPublicItems(env.DB, { limit: 6, excludeId: eventId });
        return cachePublic(await renderSeoEventAsset(env, request, detail, related, live), request, ctx, CACHE.event);
      }

      if (route.route.kind === "home") {
        const raw = await readStatsCacheRaw(env.DB, HOME_INDEX_CACHE_KEY);
        let index: PublicIndexPayload | null = null;
        try {
          index = raw ? JSON.parse(raw) as PublicIndexPayload : null;
        } catch {
          index = null;
        }
        if (!index) {
          const full = await readIndex(env);
          index = full ? buildHomeIndex(full) : null;
        }
        return cachePublic(await renderHomeSeoAsset(env, request, { index, raw: index && raw ? raw : null }), request, ctx, CACHE.home);
      }

      // Canonical spelling for the data pages (e.g. /fr/stromausfall/x → /fr/panne-de-courant/x).
      if (["stats", "places", "place", "canton"].includes(route.route.kind)) {
        const canonical = canonicalRoutePath(url.pathname);
        if (canonical && canonical !== url.pathname) {
          return Response.redirect(new URL(canonical + url.search, publicOrigin).toString(), 301);
        }
      }

      if (route.route.kind === "stats") {
        const stats = await readStatsCache<StatsPayload>(env.DB, STATS_CACHE_KEY);
        return cachePublic(await renderDataPage(env, request, buildStatsPage(stats?.payload ?? null, locale), CACHE.data), request, ctx, CACHE.data);
      }

      if (route.route.kind === "places") {
        return cachePublic(await renderDataPage(env, request, buildPlacesHubPage(await readPlaces(env), locale), CACHE.data), request, ctx, CACHE.data);
      }

      if (route.route.kind === "place") {
        const slug = route.route.slug;
        const place = await getPublicPlace(env.DB, slug);
        if (!place) return new Response(t(locale, "notFound"), { status: 404, headers: { "Cache-Control": "public,max-age=300" } });
        const [slice, items, places] = await Promise.all([
          summarizePublicSlice(env.DB, { placeSlug: slug }),
          listPublicItems(env.DB, { placeSlug: slug, limit: 60 }),
          readPlaces(env)
        ]);
        const nearby = (places?.places ?? []).filter((entry) => place.canton ? entry[2] === place.canton : true);
        const page = buildPlacePage({
          slug,
          name: place.name,
          canton: place.canton,
          slice,
          items,
          nearby,
          generatedAt: places?.generatedAt ?? new Date().toISOString()
        }, locale);
        return cachePublic(await renderDataPage(env, request, page, CACHE.data), request, ctx, CACHE.data);
      }

      if (route.route.kind === "canton") {
        const canton = cantonBySlug(route.route.slug);
        if (!canton) return new Response(t(locale, "notFound"), { status: 404 });
        const [slice, items, places, operators] = await Promise.all([
          summarizePublicSlice(env.DB, { canton: canton.code }),
          listPublicItems(env.DB, { canton: canton.code, limit: 60 }),
          readPlaces(env),
          env.DB.prepare(
            `SELECT operator_slug AS slug, MAX(publisher) AS name, COUNT(*) AS count
             FROM public_events WHERE canton = ? AND operator_slug IS NOT NULL
             GROUP BY operator_slug ORDER BY count DESC LIMIT 12`
          ).bind(canton.code).all<{ slug: string; name: string; count: number }>()
        ]);
        const page = buildCantonPage({
          canton,
          slice,
          items,
          places: (places?.places ?? []).filter((entry) => entry[2] === canton.code),
          operators: operators.results,
          generatedAt: places?.generatedAt ?? new Date().toISOString()
        }, locale);
        return cachePublic(await renderDataPage(env, request, page, CACHE.data), request, ctx, CACHE.data);
      }
    }

    const operatorPath = parseOperatorPath(url.pathname);
    if (operatorPath && request.method === "GET") {
      if (operatorPath.hub) {
        const cached = await readStatsCache<Record<string, OperatorLiveStats>>(env.DB, OPERATOR_STATS_CACHE_KEY);
        const source = cached?.payload ?? await listPublicItemsLite(env.DB);
        return cachePublic(await renderSeoOperatorHubAsset(env, request, source), request, ctx, "public,max-age=60,s-maxage=180,stale-while-revalidate=900");
      }
      const profile = operatorBySlug(operatorPath.slug);
      if (profile) {
        const live = await loadOperatorLive(env.DB, profile);
        return cachePublic(await renderSeoOperatorAsset(env, request, live), request, ctx, CACHE.event);
      }
    }

    if (isSitemapPath(url.pathname) && isRead) {
      const headers = { "Content-Type": "application/xml; charset=utf-8", "Cache-Tag": "sitemap" };
      const cacheControl = sitemapCacheControl(url.pathname);
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "Cache-Control": cacheControl } });
      let documents = buildPublicSitemapDocuments();
      try {
        const [items, places, stats] = await Promise.all([
          listPublicItemsLite(env.DB),
          readPlaces(env),
          readStatsCache<StatsPayload>(env.DB, STATS_CACHE_KEY)
        ]);
        const indexablePlaces = (places?.places ?? [])
          .filter(([, , , count, current, lastAt]) => placeIsIndexable({ total: count, active: current, upcoming: 0, lastAt }))
          .map(([slug, , , , , lastAt]) => ({ slug, lastAt }));
        // Cantons with an indexable page are the ones with events of their own
        // (public_events.canton), exactly the rule the canton page applies.
        const placeLastmods = new Map<string, string | null>();
        for (const [, , canton, , , lastAt] of places?.places ?? []) {
          if (!canton) continue;
          const previous = placeLastmods.get(canton);
          if (!previous || (lastAt && lastAt > previous)) placeLastmods.set(canton, lastAt);
        }
        const cantonLastmods = new Map<string, string | null>(
          (stats?.payload.byCanton ?? []).filter((entry) => entry.total > 0).map((entry) => [entry.code, placeLastmods.get(entry.code) ?? null])
        );
        documents = buildPublicSitemapDocuments({
          events: items.map((item) => ({ url: item.url, updated_at: item.updated_at })),
          operatorLastmods: operatorSitemapLastmods(items),
          places: indexablePlaces,
          cantons: [...cantonLastmods.entries()].map(([code, lastAt]) => ({ code, lastAt })),
          statsLastmod: stats?.computedAt ?? null
        });
      } catch {
        documents = buildPublicSitemapDocuments();
      }
      const xml = url.pathname === SITEMAP_PAGES_PATH
        ? documents.pages
        : url.pathname === SITEMAP_EVENTS_PATH
          ? documents.events
          : url.pathname === SITEMAP_PLACES_PATH
            ? documents.places
            : documents.index;
      return cachePublic(new Response(xml, { headers }), request, ctx, cacheControl);
    }

    if ((url.pathname === "/robots.txt" || url.pathname === "/llms.txt") && isRead) {
      const body = url.pathname === "/robots.txt" ? buildRobotsTxt(SITE_ORIGIN) : buildLlmsTxt(SITE_ORIGIN);
      const headers = { "Content-Type": "text/plain; charset=utf-8" };
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "Cache-Control": CACHE.text } });
      return cachePublic(new Response(body, { headers }), request, ctx, CACHE.text);
    }

    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/admin/") && !["/status", "/recent", "/run"].includes(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    if (url.pathname === "/api/public/index.json" && request.method === "GET") {
      const raw = await readStatsCacheRaw(env.DB, INDEX_CACHE_KEY);
      const body = raw ?? JSON.stringify(await readIndex(env) ?? buildPublicIndex([]));
      return cachePublic(new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } }), request, ctx, CACHE.api);
    }

    if (url.pathname === "/api/public/stats.json" && request.method === "GET") {
      const stats = await readStatsCache<StatsPayload>(env.DB, STATS_CACHE_KEY);
      if (!stats) return json({ error: "Not ready" }, { status: 503 });
      return cachePublic(Response.json(stats.payload, { headers: { "Access-Control-Allow-Origin": "*" } }), request, ctx, CACHE.data);
    }

    if ((url.pathname === "/api/public/events" || url.pathname === "/api/public/status") && request.method === "GET") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? 10);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(40, Math.floor(requestedLimit))) : 10;
      const before = url.searchParams.get("before");
      const feed = await listPublicFeed(env.DB, { limit, before });
      return cachePublic(json({ ...feed, generated_at: new Date().toISOString() }), request, ctx, CACHE.api);
    }

    const publicEventMatch = url.pathname.match(/^\/api\/public\/events\/(\d+)$/);
    if (publicEventMatch && request.method === "GET") {
      const detail = await loadPublicEventDetail(env, Number(publicEventMatch[1]));
      if (!detail) return json({ error: "Not found" }, { status: 404 });
      return cachePublic(json(detail), request, ctx, CACHE.event);
    }

    const evidenceMatch = url.pathname.match(/^\/api\/public\/evidence\/(\d+)\.png$/);
    if (evidenceMatch && request.method === "GET") {
      const snapshotId = Number(evidenceMatch[1]);
      if (!await isPublicEvidenceSnapshot(env.DB, snapshotId)) return new Response("Not found", { status: 404 });
      const object = await env.SNAPSHOTS.get(evidenceScreenshotKey(snapshotId));
      if (!object) return new Response("Not found", { status: 404 });
      return cachePublic(new Response(object.body, {
        headers: { "Content-Type": "image/png", ETag: object.httpEtag }
      }), request, ctx, "public,max-age=300,s-maxage=300");
    }

    // ------------------------------------------------------------ admin

    if (url.pathname === "/admin/status-page" && request.method === "GET") {
      if (!isAuthorized(request, env)) return unauthorized();
      return new Response(renderStatusPage(await getPublicStatus(env.DB)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      if (!isAuthorized(request, env)) return unauthorized();
      return json(await getDebugStatus(env.DB));
    }

    if (url.pathname === "/recent" && request.method === "GET") {
      if (!isAuthorized(request, env)) return unauthorized();
      return json({ items: await getRecentItems(env.DB) });
    }

    if (url.pathname === "/api/firecrawl/webhook" && request.method === "POST") {
      const webhookSecret = request.headers.get("x-firecrawl-webhook-secret");
      const webhookAuthorized =
        Boolean(env.FIRECRAWL_WEBHOOK_SECRET) && webhookSecret === env.FIRECRAWL_WEBHOOK_SECRET;
      if (!webhookAuthorized && !isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const result = await ingestFirecrawlWebhook(env, body);
        return json({ ok: result.accepted, ...result }, { status: result.accepted ? 200 : 202 });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    // Rebuilds the public projection in bounded batches. Call repeatedly after a
    // deploy until `candidates` is 0, then the cron keeps it current.
    if (url.pathname === "/admin/projection/rebuild" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        // Small default batches keep each call inside the 10 ms CPU budget.
        const cantons = typeof body.resolve_cantons === "number"
          ? await backfillEventCantons(env, { limit: Math.min(25, body.resolve_cantons) })
          : null;
        const projection = await refreshPublicProjection(env, {
          limit: typeof body.limit === "number" ? body.limit : 80,
          resolveLocations: typeof body.resolve_locations === "number" ? Math.min(10, body.resolve_locations) : 0,
          sweepOrphans: body.sweep === true,
          fullBeforeId: body.full === true
            ? (typeof body.before_id === "number" ? body.before_id : Number.MAX_SAFE_INTEGER)
            : undefined
        });
        const aggregates = await refreshPublicAggregates(env, { projectionChanged: projection.written + projection.removed > 0, force: body.force_stats === true });
        return json({ ok: true, cantons, projection, aggregates });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    if (url.pathname === "/admin/events/revalidate" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      const body = await readJsonBody(request);
      return json(await revalidatePublicEvents(env, {
        apply: body.apply === true,
        limit: typeof body.limit === "number" ? body.limit : undefined
      }));
    }

    const adminMergeMatch = url.pathname.match(/^\/admin\/events\/(\d+)\/merge$/);
    if (adminMergeMatch && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const targetEventId = Number(body.target_event_id ?? body.targetEventId);
        if (!Number.isInteger(targetEventId) || targetEventId <= 0) return badRequest("target_event_id is required");
        const sourceId = Number(adminMergeMatch[1]);
        const result = await mergeOutageEvent(env.DB, sourceId, targetEventId, bodyNote(body));
        const target = await refreshEventIntelligence(env, result.target.id, { useAiFactSheet: true });
        await generateMergeSuggestions(env, target.id);
        await republish(env, [sourceId, target.id]);
        return json({ ok: true, action: "merge", source: result.source, target });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    const adminDismissMatch = url.pathname.match(/^\/admin\/events\/(\d+)\/dismiss$/);
    if (adminDismissMatch && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const eventId = Number(adminDismissMatch[1]);
        const event = await dismissOutageEvent(env.DB, eventId, bodyNote(body));
        await republish(env, [eventId]);
        return json({ ok: true, action: "dismiss", event });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    const adminCorroborateMatch = url.pathname.match(/^\/admin\/events\/(\d+)\/corroborate$/);
    if (adminCorroborateMatch && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const eventId = Number(adminCorroborateMatch[1]);
        const event = await markOutageEventCorroborated(env.DB, eventId, bodyNote(body));
        await republish(env, [eventId]);
        return json({ ok: true, action: "corroborate", event });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    const adminResearchMatch = url.pathname.match(/^\/admin\/events\/(\d+)\/research$/);
    if (adminResearchMatch && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const result = await researchOutageEvent(env, Number(adminResearchMatch[1]));
        await applyPublicationGate(env, result.event);
        await republish(env, [result.event.id]);
        return json({
          ok: true,
          action: "research",
          event: result.event,
          added_sources: result.addedSources,
          snapshots: result.snapshots
        });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    if (url.pathname === "/admin/geo/sync-openplz" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const cantonKey = String(body.canton_key ?? body.cantonKey ?? "").trim();
        const name = String(body.name ?? "").trim();
        if (!name && !/^\d{1,2}$/.test(cantonKey)) return badRequest("canton_key or name is required");
        const result = await syncOpenPlzLocalities(env, {
          cantonKey: cantonKey || undefined,
          name: name || undefined,
          startPage: Number(body.start_page ?? body.startPage ?? 1),
          maxPages: Number(body.max_pages ?? body.maxPages ?? 2),
          pageSize: Number(body.page_size ?? body.pageSize ?? (name ? 10 : 5))
        });
        return json({ ok: true, ...result });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    if (url.pathname === "/admin/geo/backfill-places" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const result = await backfillSourcePlaceMentions(env, {
          limit: Number(body.limit ?? 20),
          eventId: body.event_id === undefined && body.eventId === undefined
            ? null
            : Number(body.event_id ?? body.eventId)
        });
        return json({ ok: true, ...result });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    if (url.pathname === "/admin/snapshots/digest" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const body = await readJsonBody(request);
        const limit = Math.max(1, Math.min(3, Number(body.limit ?? 2)));
        const targets = await getSnapshotsNeedingPublicDigest(
          env.DB,
          limit,
          body.event_id === undefined && body.eventId === undefined ? null : Number(body.event_id ?? body.eventId)
        );
        let digested = 0;
        const errors: string[] = [];
        for (const target of targets) {
          const result = await summarizeSourceForPublic(env, {
            eventTitle: target.event_title || target.location_text || target.source_title || "Stromausfall",
            eventSummary: target.research_summary_de || target.event_summary || "",
            sourceTitle: target.source_title || "Quelle",
            sourceUrl: target.source_url,
            excerpt: target.markdown_excerpt
          });
          await updateSourceSnapshotDigest(env.DB, target.snapshot_id, result.parsed, new Date().toISOString(), result.error ?? null);
          if (result.parsed) digested += 1;
          else errors.push(`#${target.snapshot_id}: ${result.error ?? "digest failed"}`);
        }
        return json({ ok: true, scanned: targets.length, digested, errors });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    const adminFactSheetMatch = url.pathname.match(/^\/admin\/events\/(\d+)\/fact-sheet$/);
    if (adminFactSheetMatch && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      try {
        const eventId = Number(adminFactSheetMatch[1]);
        const event = await refreshEventIntelligence(env, eventId, { useAiFactSheet: true });
        await generateMergeSuggestions(env, eventId);
        await republish(env, [eventId]);
        return json({
          ok: true,
          action: "fact-sheet",
          event,
          merge_suggestions: await getMergeSuggestionsForEvent(env.DB, eventId)
        });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!isAuthorized(request, env)) return unauthorized();
      return json({ ok: true, result: await runAlertCheck(env) });
    }

    if (route && request.method === "GET") {
      return new Response(t(parseLocaleFromPath(url.pathname), "notFound"), { status: 404 });
    }
    return json({ error: "Not found" }, { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runAlertCheck(env).then((result) => console.log(JSON.stringify({ cron: event.cron, ...result })))
    );
  }
};

export default {
  /** Any uncaught failure (e.g. D1's daily read limit) answers 503 with a usable page instead of error 1101. */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await app.fetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ unavailable: request.url, error: error instanceof Error ? error.message : String(error) }));
      return unavailableResponse(request, error);
    }
  },
  scheduled: app.scheduled
};
