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
