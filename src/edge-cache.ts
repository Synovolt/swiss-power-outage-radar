/**
 * The browser caching a cached public response is meant to carry. The zone's
 * "Browser Cache TTL" setting rewrites max-age to 4 h on responses read back
 * through the Cache API, so the intended value travels in this header and is
 * restored before the response leaves the Worker.
 */
export const BROWSER_CACHE_CONTROL = "X-Outage-Cache-Control";

/** Cache API key: one entry per cache version and deploy. */
export function edgeCacheKey(request: Request, version: string): Request {
  const url = new URL(request.url);
  url.searchParams.set("__cv", version);
  return new Request(url.toString(), request);
}

/** The copy written to the Cache API, remembering the intended browser caching. */
export function forEdgeCache(response: Response): Response {
  const stored = new Response(response.body, response);
  const cacheControl = response.headers.get("Cache-Control");
  if (cacheControl) stored.headers.set(BROWSER_CACHE_CONTROL, cacheControl);
  return stored;
}

/** A Cache API hit with the browser caching it was stored with. */
export function restoreBrowserCaching(cached: Response): Response {
  const restored = new Response(cached.body, cached);
  const intended = restored.headers.get(BROWSER_CACHE_CONTROL);
  if (intended) restored.headers.set("Cache-Control", intended);
  restored.headers.delete(BROWSER_CACHE_CONTROL);
  return restored;
}
