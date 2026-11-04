import { summarizeSourceForPublic } from "./ai";
import { insertSourceSnapshot, updateSourceSnapshotDigest } from "./db";
import { stripPageMetadata } from "./source-text";
import type { Env, OutageEvent, OutageSource, SourceSnapshot, StoredAlertItem } from "./types";

interface SnapshotTarget {
  event: Pick<OutageEvent, "id"> & Partial<Pick<OutageEvent, "title" | "summary" | "research_summary_de" | "location_text">>;
  source: Pick<OutageSource, "id" | "source_url" | "source_title">;
  alertItem?: Pick<StoredAlertItem, "id"> | null;
}

interface ParsedMarkdown {
  markdown: string;
  screenshot: Uint8Array | null;
  title: string | null;
  httpStatus: number | null;
  error: string | null;
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function evidenceScreenshotKey(snapshotId: number): string {
  return `evidence/snapshot-${snapshotId}.png`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeScreenshot(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return decodeBase64(value);
  } catch {
    return null;
  }
}

function excerpt(markdown: string): string {
  return stripPageMetadata(markdown)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function snapshotKey(eventId: number, sourceId: number, hash: string, fetchedAt: string): string {
  const day = fetchedAt.slice(0, 10);
  return `snapshots/${day}/event-${eventId}/source-${sourceId}-${hash.slice(0, 16)}.md`;
}

function alertSnapshotKey(alertItemId: number, hash: string, fetchedAt: string): string {
  const day = fetchedAt.slice(0, 10);
  return `snapshots/${day}/alert-${alertItemId}/${hash.slice(0, 16)}.md`;
}

function unwrapGoogleAlertUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const target = parsed.searchParams.get("url");
    if ((hostname === "google.com" || hostname === "google.ch") && target) {
      return target;
    }
  } catch {
    return value;
  }
  return value;
}

async function parseBrowserMarkdownResponse(response: Response): Promise<ParsedMarkdown> {
  const httpStatus = response.status;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    const text = await response.text().catch(() => "");
    return { markdown: "", screenshot: null, title: null, httpStatus, error: text || `HTTP ${httpStatus}` };
  }

  const record = payload as Record<string, unknown>;
  if (record.success === true && typeof record.result === "string") {
    const meta = record.meta as Record<string, unknown> | undefined;
    return {
      markdown: record.result,
      screenshot: null,
      title: typeof meta?.title === "string" ? meta.title : null,
      httpStatus: typeof meta?.status === "number" ? meta.status : httpStatus,
      error: null
    };
  }
  if (record.success === true && record.result && typeof record.result === "object") {
    const result = record.result as Record<string, unknown>;
    const meta = record.meta as Record<string, unknown> | undefined;
    return {
      markdown: typeof result.markdown === "string" ? result.markdown : "",
      screenshot: decodeScreenshot(result.screenshot),
      title: typeof meta?.title === "string" ? meta.title : null,
      httpStatus: typeof meta?.status === "number" ? meta.status : httpStatus,
      error: null
    };
  }

  const errors = Array.isArray(record.errors)
    ? record.errors
        .map((error) => {
          const err = error as Record<string, unknown>;
          return [err.message, err.code, err.detail].filter(Boolean).join(" ");
        })
        .join("; ")
    : `HTTP ${httpStatus}`;
  return { markdown: "", screenshot: null, title: null, httpStatus, error: errors };
}

function titleFromMarkdown(markdown: string): string | null {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || null;
}

function jinaReaderUrl(targetUrl: string): string {
  return `https://r.jina.ai/${targetUrl}`;
}

async function fetchJinaMarkdown(targetUrl: string): Promise<ParsedMarkdown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(jinaReaderUrl(targetUrl), {
      headers: {
        "User-Agent": "swiss-power-outage-radar/0.2",
        "Accept": "text/markdown,text/plain;q=0.9,*/*;q=0.1"
      },
      signal: controller.signal
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        markdown: "", screenshot: null,
        title: null,
        httpStatus: response.status,
        error: text || `Jina HTTP ${response.status}`
      };
    }
    if (!text.trim()) {
      return {
        markdown: "", screenshot: null,
        title: null,
        httpStatus: response.status,
        error: "Jina markdown response was empty"
      };
    }
    return {
      markdown: text, screenshot: null,
      title: titleFromMarkdown(text),
      httpStatus: response.status,
      error: null
    };
  } catch (error) {
    return {
      markdown: "", screenshot: null,
      title: null,
      httpStatus: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCloudflareMarkdown(
  env: Pick<Env, "BROWSER" | "BROWSER_MOCK_MODE">,
  fetchUrl: string,
  sourceTitle: string,
  sourceUrl: string,
  captureScreenshot = true
): Promise<ParsedMarkdown> {
  if (env.BROWSER_MOCK_MODE === "true") {
    return {
      markdown: `# ${sourceTitle}\n\nMock Markdown Snapshot for ${sourceUrl}`,
      screenshot: captureScreenshot
        ? decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=")
        : null,
      title: sourceTitle,
      httpStatus: 200,
      error: null
    };
  }

  return await parseBrowserMarkdownResponse(
    await (env.BROWSER.quickAction as unknown as (
      action: "snapshot" | "markdown",
      options: Record<string, unknown>
    ) => Promise<Response>)(captureScreenshot ? "snapshot" : "markdown", {
      url: fetchUrl,
      ...(captureScreenshot ? {
        formats: ["screenshot", "markdown"],
        screenshotOptions: { fullPage: true }
      } : {}),
      cacheTTL: 0,
      bestAttempt: true,
      gotoOptions: {
        timeout: 30000,
        waitUntil: "domcontentloaded"
      },
      userAgent: "swiss-power-outage-radar/0.2"
    })
  );
}

export async function createSourceSnapshot(
  env: Pick<Env, "DB" | "BROWSER" | "SNAPSHOTS" | "BROWSER_MOCK_MODE"> & Partial<Pick<Env, "AI" | "AI_MOCK_MODE">>,
  target: SnapshotTarget,
  fetchedAt = new Date().toISOString()
): Promise<SourceSnapshot> {
  const fetchUrl = unwrapGoogleAlertUrl(target.source.source_url);
  const base = {
    alertItemId: target.alertItem?.id ?? null,
    outageEventId: target.event.id,
    outageSourceId: target.source.id,
    url: target.source.source_url,
    finalUrl: fetchUrl,
    fetchMethod: "cloudflare_browser_markdown",
    fetchedAt
  };

  try {
    let parsed = await fetchCloudflareMarkdown(
      env,
      fetchUrl,
      target.source.source_title,
      target.source.source_url
    );
    let fetchMethod = base.fetchMethod;
    let fallbackError: string | null = null;

    if (parsed.error || !parsed.markdown.trim()) {
      fallbackError = parsed.error || "Cloudflare markdown response was empty";
      const screenshot = parsed.screenshot;
      parsed = { ...await fetchJinaMarkdown(fetchUrl), screenshot };
      fetchMethod = "jina_markdown_fallback";
    }

    if (parsed.error || !parsed.markdown.trim()) {
      return await insertSourceSnapshot(env.DB, {
        ...base,
        fetchMethod,
        fetchStatus: "failed",
        httpStatus: parsed.httpStatus,
        title: parsed.title,
        markdownR2Key: null,
        markdownExcerpt: null,
        contentHash: null,
        error: [fallbackError, parsed.error || "Markdown response was empty"].filter(Boolean).join("; ")
      });
    }

    const contentHash = await sha256Hex(parsed.markdown);
    const key = snapshotKey(target.event.id, target.source.id, contentHash, fetchedAt);
    await env.SNAPSHOTS.put(key, parsed.markdown, {
      httpMetadata: {
        contentType: "text/markdown; charset=utf-8"
      },
      customMetadata: {
        source_url: target.source.source_url,
        final_url: fetchUrl,
        outage_event_id: String(target.event.id),
        outage_source_id: String(target.source.id),
        content_hash: contentHash
      }
    });

    const snapshot = await insertSourceSnapshot(env.DB, {
      ...base,
      fetchMethod,
      fetchStatus: "success",
      httpStatus: parsed.httpStatus,
      title: parsed.title,
      markdownR2Key: key,
      markdownExcerpt: excerpt(parsed.markdown),
      contentHash,
      error: null
    });
    if (parsed.screenshot) {
      try {
        const imageHash = await sha256Hex(parsed.screenshot);
        await env.SNAPSHOTS.put(evidenceScreenshotKey(snapshot.id), parsed.screenshot, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: {
            source_url: target.source.source_url,
            captured_at: fetchedAt,
            content_hash: imageHash,
            compression: "lossless"
          }
        });
      } catch {
        // Evidence capture is supplementary and must never block event ingestion.
      }
    }
    await maybeDigestSnapshot(env, target, snapshot, parsed.markdown);
    return snapshot;
  } catch (error) {
    return await insertSourceSnapshot(env.DB, {
      ...base,
      fetchStatus: "failed",
      httpStatus: null,
      title: null,
      markdownR2Key: null,
      markdownExcerpt: null,
      contentHash: null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function maybeDigestSnapshot(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "AI" | "AI_MOCK_MODE">>,
  target: SnapshotTarget,
  snapshot: SourceSnapshot,
  markdown: string
): Promise<void> {
  if (!env.AI && env.AI_MOCK_MODE !== "true") return;
  const excerptText = excerpt(markdown);
  if (!excerptText) return;

  const result = await summarizeSourceForPublic(env as Pick<Env, "AI" | "AI_MOCK_MODE">, {
    eventTitle: target.event.title || target.event.location_text || target.source.source_title,
    eventSummary: target.event.research_summary_de || target.event.summary || "",
    sourceTitle: target.source.source_title,
    sourceUrl: target.source.source_url,
    excerpt: excerptText
  });

  await updateSourceSnapshotDigest(
    env.DB,
    snapshot.id,
    result.parsed,
    new Date().toISOString(),
    result.error ?? null
  );
}

export async function createAlertSnapshot(
  env: Pick<Env, "DB" | "BROWSER" | "SNAPSHOTS" | "BROWSER_MOCK_MODE">,
  alertItem: Pick<StoredAlertItem, "id" | "url" | "title">,
  fetchedAt = new Date().toISOString()
): Promise<SourceSnapshot> {
  const fetchUrl = unwrapGoogleAlertUrl(alertItem.url);
  const base = {
    alertItemId: alertItem.id,
    outageEventId: null,
    outageSourceId: null,
    url: alertItem.url,
    finalUrl: fetchUrl,
    fetchMethod: "cloudflare_browser_markdown",
    fetchedAt
  };

  try {
    let parsed = await fetchCloudflareMarkdown(env, fetchUrl, alertItem.title, alertItem.url, false);
    let fetchMethod = base.fetchMethod;
    let fallbackError: string | null = null;

    if (parsed.error || !parsed.markdown.trim()) {
      fallbackError = parsed.error || "Cloudflare markdown response was empty";
      parsed = await fetchJinaMarkdown(fetchUrl);
      fetchMethod = "jina_markdown_fallback";
    }

    if (parsed.error || !parsed.markdown.trim()) {
      return await insertSourceSnapshot(env.DB, {
        ...base,
        fetchMethod,
        fetchStatus: "failed",
        httpStatus: parsed.httpStatus,
        title: parsed.title,
        markdownR2Key: null,
        markdownExcerpt: null,
        contentHash: null,
        error: [fallbackError, parsed.error || "Markdown response was empty"].filter(Boolean).join("; ")
      });
    }

    const contentHash = await sha256Hex(parsed.markdown);
    const key = alertSnapshotKey(alertItem.id, contentHash, fetchedAt);
    await env.SNAPSHOTS.put(key, parsed.markdown, {
      httpMetadata: {
        contentType: "text/markdown; charset=utf-8"
      },
      customMetadata: {
        source_url: alertItem.url,
        final_url: fetchUrl,
        alert_item_id: String(alertItem.id),
        content_hash: contentHash
      }
    });

    return await insertSourceSnapshot(env.DB, {
      ...base,
      fetchMethod,
      fetchStatus: "success",
      httpStatus: parsed.httpStatus,
      title: parsed.title,
      markdownR2Key: key,
      markdownExcerpt: excerpt(parsed.markdown),
      contentHash,
      error: null
    });
  } catch (error) {
    return await insertSourceSnapshot(env.DB, {
      ...base,
      fetchStatus: "failed",
      httpStatus: null,
      title: null,
      markdownR2Key: null,
      markdownExcerpt: null,
      contentHash: null,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
