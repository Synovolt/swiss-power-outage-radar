/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Serializes JSON for an inline <script type="application/json"> or JSON-LD block. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function setMetaContent(content: string) {
  return {
    element(element: Element) {
      element.setAttribute("content", content);
    }
  };
}

/**
 * Loads a static shell for server rendering. The client's conditional headers
 * are deliberately not forwarded: the rendered page differs from the shell, so
 * the shell's ETag must never decide whether the browser gets fresh content.
 */
export function fetchTemplate(assets: Fetcher, url: URL | string): Promise<Response> {
  return assets.fetch(new Request(url.toString(), { method: "GET" }));
}

/** Headers for a page rendered from a shell: no shell validators, explicit caching. */
export function renderedHeaders(asset: Response, cacheControl: string): Headers {
  const headers = new Headers(asset.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.delete("Content-Length");
  headers.set("Cache-Control", cacheControl);
  return headers;
}
