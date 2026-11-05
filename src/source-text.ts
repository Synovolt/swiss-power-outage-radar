/**
 * Page captures (Browser Rendering markdown, Jina reader) can start with
 * metadata instead of article text: a YAML front-matter block
 * (`--- title: … meta: author: … ---`) or Jina's `Title: … URL Source: …
 * Markdown Content:` header. That metadata must never be quoted as what a
 * source reports, and it carries author names we do not want to republish.
 */

const QUOTED_FIELD = (name: string) => new RegExp(`(?:^|\\s)${name}:\\s*"([^"]{8,})"?`, "i");

/** Article text without a leading front-matter block or reader header. */
export function stripPageMetadata(text: string | null | undefined): string {
  let value = String(text ?? "").replace(/^﻿/, "");
  if (!value.trim()) return "";

  // Jina reader header: everything up to "Markdown Content:".
  const jina = value.match(/^\s*Title:[\s\S]*?Markdown Content:\s*/i);
  if (jina) value = value.slice(jina[0].length);

  const trimmed = value.trimStart();
  if (!trimmed.startsWith("---")) return value.trim();

  // Multi-line YAML block with a closing fence.
  const block = trimmed.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (block) {
    const rest = trimmed.slice(block[0].length).trim();
    return rest || fieldFallback(block[0]);
  }

  // Collapsed to one line ("--- title: … description: … --- body").
  const closing = trimmed.indexOf(" --- ", 3);
  const header = closing > 0 ? trimmed.slice(0, closing) : trimmed;
  const body = closing > 0 ? trimmed.slice(closing + 5).trim() : "";
  return body || fieldFallback(header);
}

/** The article's own description (or title) from a metadata header. */
function fieldFallback(header: string): string {
  const description = header.match(QUOTED_FIELD("description"))?.[1];
  if (description) return description.trim();
  return header.match(QUOTED_FIELD("title"))?.[1]?.trim() ?? "";
}
