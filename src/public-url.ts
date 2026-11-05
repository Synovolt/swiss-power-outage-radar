export const SITE_ORIGIN = "https://outage.ch";
export const DEFAULT_OG_IMAGE_PATH = "/og-default.png";

export function siteOriginFromRequest(request: Request): string {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === "outage.ch" || hostname === "www.outage.ch") return SITE_ORIGIN;
  return new URL(request.url).origin.replace(/^http:/i, "https:");
}

export function absoluteUrl(path: string, origin = SITE_ORIGIN): string {
  return new URL(path.startsWith("/") ? path : `/${path}`, origin).toString();
}

export function publicDisplayLocation(value: string | null | undefined): string {
  const cleaned = (value ?? "")
    .replace(/^\s*(?:behobener?|beendeter?|geplanter?)\s+(?:stromausfall|stromunterbruch)\s+(?:in|im|bei|à)\s+/i, "")
    .replace(/^\s*(?:stromausfall|stromunterbruch|panne de courant)\s+(?:in|im|bei|à)\s+/i, "")
    .replace(/^\s*(?:in|im|bei|à)\s+/i, "")
    // "2608 Courtelary": the postal code is not part of the place name.
    .replace(/^\s*\d{4}\s+(?=\p{L})/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || (value ?? "").trim() || "Schweiz";
}

export function publicEventSlug(location: string): string {
  const slug = publicDisplayLocation(location)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "schweiz";
}

export function publicEventPath(event: { id: number; location: string }): string {
  return `/stromausfall/${publicEventSlug(event.location)}-${event.id}`;
}

export { eventIdFromPath as publicEventIdFromPath, localizeStoredEventUrl } from "./i18n/routes";

const SITEMAP_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function toSitemapLastmod(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (SITEMAP_DAY.test(trimmed)) return trimmed;
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (!Number.isFinite(date.getTime())) {
    const day = trimmed.slice(0, 10);
    return SITEMAP_DAY.test(day) ? day : undefined;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clientProtocol(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.toLowerCase();
  const visitor = request.headers.get("cf-visitor");
  if (visitor) {
    try {
      const scheme = (JSON.parse(visitor) as { scheme?: string }).scheme;
      if (scheme) return scheme.toLowerCase();
    } catch {
      // ignore malformed cf-visitor
    }
  }
  return new URL(request.url).protocol.replace(":", "").toLowerCase();
}

export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const isProdHost = host === "outage.ch" || host === "www.outage.ch";
  if (!isProdHost) return null;

  const needsHttps = clientProtocol(request) === "http";
  const needsHost = host === "www.outage.ch";
  if (!needsHttps && !needsHost) return null;

  url.protocol = "https:";
  url.hostname = "outage.ch";
  return Response.redirect(url.toString(), 301);
}
