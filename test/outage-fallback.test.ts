import { describe, expect, it } from "vitest";
import { expectedRecovery, isD1QuotaError, unavailableResponse } from "../src/outage-fallback";

const QUOTA = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");
const NOW = Date.parse("2026-11-04T15:00:00Z");

describe("outage fallback", () => {
  it("recognises D1's daily quota error and expects the data back after midnight UTC", () => {
    expect(isD1QuotaError(QUOTA)).toBe(true);
    expect(isD1QuotaError(new Error("D1_ERROR: no such table"))).toBe(false);
    const recovery = expectedRecovery(QUOTA, NOW);
    expect(recovery.at?.toISOString()).toBe("2026-11-05T00:05:00.000Z");
    expect(recovery.retryAfter).toBe(9 * 3600 + 300);
    expect(expectedRecovery(new Error("boom"), NOW)).toEqual({ retryAfter: 120, at: null });
  });

  it("answers pages with an uncached, localized 503 that needs no database", async () => {
    const response = unavailableResponse(new Request("https://outage.ch/fr/"), QUOTA, NOW);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe(String(9 * 3600 + 300));
    const html = await response.text();
    expect(html).toContain('lang="fr-CH"');
    expect(html).toContain("01:05"); // midnight UTC + 5 min in Swiss winter time
    expect(html).toContain("BKW");
    expect(html).toContain("112");
  });

  it("answers the API with JSON", async () => {
    const response = unavailableResponse(new Request("https://outage.ch/api/public/index.json"), new Error("boom"), NOW);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Temporarily unavailable", retry_after: 120 });
  });
});
