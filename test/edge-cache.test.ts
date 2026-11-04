import { describe, expect, it } from "vitest";
import { BROWSER_CACHE_CONTROL, edgeCacheKey, forEdgeCache, restoreBrowserCaching } from "../src/edge-cache";

describe("edge cache", () => {
  it("keys entries by version so a deploy never serves HTML with stale asset hashes", () => {
    const request = new Request("https://outage.ch/?view=planned");
    const a = new URL(edgeCacheKey(request, "seo-v10-aaa").url);
    const b = new URL(edgeCacheKey(request, "seo-v10-bbb").url);
    expect(a.searchParams.get("view")).toBe("planned");
    expect(a.searchParams.get("__cv")).toBe("seo-v10-aaa");
    expect(a.toString()).not.toBe(b.toString());
  });

  it("restores the intended browser caching after the zone rewrote max-age", async () => {
    const fresh = new Response("<html>", { headers: { "Cache-Control": "public,max-age=60,s-maxage=120" } });
    const stored = forEdgeCache(fresh);
    expect(stored.headers.get(BROWSER_CACHE_CONTROL)).toBe("public,max-age=60,s-maxage=120");

    // What the Cache API hands back with Browser Cache TTL = 4 h.
    const hit = new Response(stored.body, stored);
    hit.headers.set("Cache-Control", "public, max-age=14400, s-maxage=120");

    const served = restoreBrowserCaching(hit);
    expect(served.headers.get("Cache-Control")).toBe("public,max-age=60,s-maxage=120");
    expect(served.headers.has(BROWSER_CACHE_CONTROL)).toBe(false);
    expect(await served.text()).toBe("<html>");
  });

  it("leaves entries without the marker unchanged", () => {
    const hit = new Response("x", { headers: { "Cache-Control": "public,max-age=300" } });
    expect(restoreBrowserCaching(hit).headers.get("Cache-Control")).toBe("public,max-age=300");
  });
});
