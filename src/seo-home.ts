/**
 * Home page (radar) server rendering. The static Astro shell already carries
 * the visible intro, links and FAQ; the Worker adds what is live: the list of
 * current events (server-rendered, same markup as the client), view counts,
 * the compact index for instant client-side search, and a meta description
 * with today's numbers.
 */
import { escapeHtml, fetchTemplate, inlineJson, renderedHeaders, setMetaContent } from "./html";
import { formatAppDate, homeFaqs, pathFor, radarViewCopy, t, type AppLocale } from "./i18n";
import { DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN, absoluteUrl } from "./public-url";
import {
  countLabel,
  fromIndex,
  groupItems,
  groupsHtml,
  inView,
  limitRecent,
  sortForView,
  viewCounts,
  type RadarItem
} from "./radar-view";
import type { PublicIndexPayload } from "./public-stats";
import type { Env } from "./types";

/**
 * "active" counts outages only. Planned works whose window is running are
 * "running": they are not a disturbance and are shown separately.
 */
export function homeLiveCounts(items: RadarItem[], now = Date.now()): { active: number; running: number; upcoming: number } {
  return {
    active: items.filter((item) => item.status === "active" && item.nature !== "planned").length,
    running: items.filter((item) => item.status === "active" && item.nature === "planned").length,
    upcoming: items.filter((item) => item.status === "upcoming" && inView(item, "now", now)).length
  };
}

export function homeLiveDescription(locale: AppLocale, counts: { active: number; upcoming: number }, generatedAt: string): string {
  const active = counts.active
    ? t(locale, "data.common.activeCount", { count: counts.active })
    : t(locale, "data.common.noneActiveShort");
  const upcoming = counts.upcoming
    ? t(locale, "data.common.upcomingCount", { count: counts.upcoming })
    : t(locale, "data.common.noneUpcomingShort");
  const date = formatAppDate(generatedAt, locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) ?? "";
  const text = t(locale, "data.home.descLive", { active, upcoming, date });
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 159).trimEnd()}…`;
}

export function renderHomeList(items: RadarItem[], locale: AppLocale, now = Date.now()): string {
  const copy = radarViewCopy(locale);
  const visible = sortForView(items.filter((item) => inView(item, "now", now)), "now");
  if (!visible.length) return `<p class="radar__empty">${escapeHtml(copy.empty.now)}</p>`;
  return groupsHtml(limitRecent(groupItems(visible, "now", now, copy)), now, copy);
}

/** Visible, crawlable context at the end of the radar panel (no hidden SEO text). */
export function renderHomeAbout(locale: AppLocale): string {
  const r = (key: string, options?: Record<string, unknown>) => t(locale, `data.radar.${key}`, options);
  const links = [
    [pathFor({ kind: "places" }, locale), r("placesLink")],
    [pathFor({ kind: "stats" }, locale), r("statsLink")],
    [pathFor({ kind: "operators" }, locale), r("operatorsLink")],
    ["/ratgeber/stromausfall-was-tun/", r("guideLink")]
  ];
  return `<section class="radar-about" aria-labelledby="radar-about-title">`
    + `<h2 id="radar-about-title">${escapeHtml(t(locale, "home.seoHeading"))}</h2>`
    + `<p>${escapeHtml(t(locale, "site.description"))}</p>`
    + `<ul class="radar-about__links">${links.map(([href, label]) => `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`).join("")}</ul>`
    + `<h3>${escapeHtml(t(locale, "home.seoFaq"))}</h3>`
    + homeFaqs(locale).map((faq) => `<details><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`).join("")
    + `</section>`;
}

export async function renderHomeSeoAsset(
  env: Pick<Env, "ASSETS">,
  request: Request,
  input: { index: PublicIndexPayload | null; raw?: string | null; now?: number }
): Promise<Response> {
  const now = input.now ?? Date.now();
  const locale = (new URL(request.url).pathname.match(/^\/(fr|it|en)(?:\/|$)/)?.[1] ?? "de") as AppLocale;
  const homePath = pathFor({ kind: "home" }, locale);
  const asset = await fetchTemplate(env.ASSETS, new URL(homePath, request.url));
  const canonical = absoluteUrl(homePath, SITE_ORIGIN);
  const ogImage = absoluteUrl(DEFAULT_OG_IMAGE_PATH, SITE_ORIGIN);
  const items = fromIndex(input.index);
  const copy = radarViewCopy(locale);
  const generatedAt = input.index?.generatedAt ?? new Date(now).toISOString();
  const live = homeLiveCounts(items, now);
  const description = homeLiveDescription(locale, live, generatedAt);
  // The home subset carries counts over the full index; fall back to counting what we have.
  const counts = input.index?.counts ?? viewCounts(items, "", now);
  const embedded = input.raw ? input.raw.replace(/</g, "\\u003c") : input.index ? inlineJson(input.index) : "null";
  const listHtml = input.index ? renderHomeList(items, locale, now) : null;
  const asOf = copy.asOf.replace("{{date}}", formatAppDate(generatedAt, locale, { dateStyle: "short", timeStyle: "short" }) ?? "");

  let rewriter = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[name="description"]', setMetaContent(description))
    .on('meta[property="og:description"]', setMetaContent(description))
    .on('meta[name="twitter:description"]', setMetaContent(description))
    .on('meta[property="og:url"]', setMetaContent(canonical))
    .on('meta[property="og:image"]', setMetaContent(ogImage))
    .on('meta[name="twitter:image"]', setMetaContent(ogImage));
  if (input.index && listHtml !== null) {
    rewriter = rewriter
      .on("#radar-index", { element(element) { element.setInnerContent(embedded, { html: true }); } })
      .on("#radar-list", { element(element) { element.setInnerContent(listHtml, { html: true }); element.setAttribute("aria-busy", "false"); } })
      .on("#radar-count", { element(element) { element.setInnerContent(countLabel(counts.now, copy)); } })
      .on("#radar-note", { element(element) { element.setInnerContent(asOf); } })
      .on("[data-view-count]", {
        element(element) {
          const view = element.getAttribute("data-view-count") as keyof typeof counts | null;
          if (view && view in counts) element.setInnerContent(String(counts[view]));
        }
      })
      .on("[data-live-count]", {
        element(element) {
          const key = element.getAttribute("data-live-count");
          if (key === "active") element.setInnerContent(String(live.active));
          if (key === "upcoming") element.setInnerContent(String(counts.planned));
        }
      })
      .on("[data-live-label]", {
        element(element) {
          const key = element.getAttribute("data-live-label");
          if (key === "active") element.setInnerContent(live.active === 1 ? copy.tiles.activeOne : copy.tiles.activeOther);
          if (key === "upcoming") element.setInnerContent(counts.planned === 1 ? copy.tiles.plannedOne : copy.tiles.plannedOther);
        }
      })
      .on("[data-live]", {
        element(element) {
          if (live.active > 0) element.setAttribute("data-has-active", "");
        }
      })
      .on("[data-live-running]", {
        element(element) {
          if (live.running > 0) {
            element.setInnerContent(live.running === 1 ? copy.tiles.runningOne : copy.tiles.runningOther.replace("{{count}}", String(live.running)));
            element.removeAttribute("hidden");
          }
        }
      });
  }
  return rewriter.transform(new Response(asset.body, {
    status: asset.status,
    headers: renderedHeaders(asset, "public,max-age=60,s-maxage=120,stale-while-revalidate=600")
  }));
}
