import { describe, expect, it } from "vitest";
import { stripPageMetadata } from "../src/source-text";

describe("stripPageMetadata", () => {
  it("drops a multi-line front-matter block", () => {
    const markdown = "---\ntitle: \"Stromausfall in der Schachenhalle\"\nmeta:\n  author: \"Nadja Rohner\"\n---\n\nVor dem Cupspiel fiel der Strom aus.";
    expect(stripPageMetadata(markdown)).toBe("Vor dem Cupspiel fiel der Strom aus.");
  });

  it("keeps only the description of an excerpt stored collapsed to one line", () => {
    const stored = "--- title: \"Stromausfall in der Schachenhalle: Ursache gefunden\" meta: author: \"Nadja Rohner\" date: \"2026-11-03 11:17:28+01:00\" description: \"Vor dem Cupspiel zwischen HSC Suhr Aarau und BSV Bern fiel in der Schachenhalle der Strom aus.";
    const cleaned = stripPageMetadata(stored);
    expect(cleaned).toBe("Vor dem Cupspiel zwischen HSC Suhr Aarau und BSV Bern fiel in der Schachenhalle der Strom aus.");
    expect(cleaned).not.toContain("Nadja Rohner");
  });

  it("prefers the body after a collapsed closing fence", () => {
    expect(stripPageMetadata("--- title: \"Panne à Morges\" --- Une panne a touché Morges ce matin.")).toBe("Une panne a touché Morges ce matin.");
  });

  it("drops the Jina reader header", () => {
    expect(stripPageMetadata("Title: Stromausfall\n\nURL Source: https://example.ch/a\n\nMarkdown Content:\nIn Brugg fiel der Strom aus.")).toBe("In Brugg fiel der Strom aus.");
  });

  it("leaves ordinary text alone", () => {
    expect(stripPageMetadata("Stromausfall in Meinisberg. 1 Trafostation betroffen.")).toBe("Stromausfall in Meinisberg. 1 Trafostation betroffen.");
  });
});
