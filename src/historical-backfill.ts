import type { CandidateFactInput, OutageEvent } from "./types";

export const HISTORICAL_BACKFILL_VERSION = "historical-backfill/v1";

export interface HistoricalBackfillTarget extends OutageEvent {
  backfill_source_id: number;
  backfill_source_url: string;
  /** COALESCE(received_at, first_seen_at): the target's position in the backfill queue. */
  backfill_sort_at: string;
}

type CuratedFact = Omit<CandidateFactInput, "extractor_version" | "observed_at">;

const CURATED_BY_SOURCE: Record<string, CuratedFact[]> = {
  "https://frapp.ch/fr/articles/stories/plus-de-2300-personnes-privees-delectricite-a-marly": [
    fact("start_time", "2026-07-01T06:20:00.000Z", "Der Stromunterbruch dauerte am 1. Juli 2026 von 08:20 bis 09:15 Uhr.", 0.98),
    fact("end_time", "2026-07-01T07:15:00.000Z", "Der Stromunterbruch dauerte am 1. Juli 2026 von 08:20 bis 09:15 Uhr.", 0.98),
    fact("cause", "Störung an einer Trafostation", "Groupe E nannte eine Störung an einer Trafostation als Ursache.", 0.95),
    fact("affected_area", "Rund 2'360 Personen im Zentrum von Marly", "Betroffen waren rund 2'360 Personen im Zentrum von Marly.", 0.95),
    fact("status", "resolved", "Die Stromversorgung wurde bis 09:15 Uhr wiederhergestellt.", 0.98)
  ],
  "https://march24.ch/articles/390755-stromausfall-in-lufingen-und-winkel-defektes-erdkabel-legte-versorgung-lahm": [
    fact("start_time", "2026-06-29T07:07:00.000Z", "Die Störung trat laut EKZ am 29. Juni 2026 gegen 09:07 Uhr auf.", 0.98),
    fact("end_time", "2026-06-29T10:09:00.000Z", "Um 12:09 Uhr waren sämtliche betroffenen Kundinnen und Kunden wieder am Netz.", 0.98),
    fact("cause", "Defektes Erdkabel nach vorgelagerter Freileitungsstörung", "Eine Störung an einer Freileitung beschädigte ein Erdkabel und löste den Ausfall aus.", 0.96),
    fact("affected_area", "2'170 Kundinnen und Kunden in Lufingen und Teilen von Winkel", "Insgesamt waren 2'170 Kundinnen und Kunden betroffen.", 0.98),
    fact("status", "resolved", "Um 12:09 Uhr waren sämtliche betroffenen Kundinnen und Kunden wieder am Netz.", 0.98)
  ],
  "https://www.bote.ch/nachrichten/schwyz/11000-haushalte-nach-blitzschlag-ohne-strom-art-1713216": [
    fact("start_time", "2026-07-16T19:30:00.000Z", "Leser meldeten am 16. Juli 2026 um 21:30 Uhr einen Stromausfall.", 0.95),
    fact("end_time", "2026-07-16T19:35:00.000Z", "Der Stromunterbruch dauerte rund fünf Minuten.", 0.9),
    fact("cause", "Blitzschlag mit automatischer Schutzabschaltung", "Ein naher Blitzschlag führte laut EWS zu einer automatischen Schutzauslösung.", 0.98),
    fact("affected_area", "Rund 11'000 Haushalte in mehreren Gemeinden der Region Küssnacht", "Rund 11'000 Haushalte waren in mehreren Gemeinden ohne Strom.", 0.95),
    fact("status", "resolved", "Der Stromunterbruch dauerte rund fünf Minuten.", 0.95)
  ],
  "https://www.ai.ch/feuerschaugemeinde/news/versorgungsstoerungen/20260713_stoerung": [
    fact("start_time", "2026-07-13T06:50:00.000Z", "Am 13. Juli 2026 fiel der Strom ab 08:50 Uhr aus.", 0.95),
    fact("end_time", "2026-07-13T07:50:00.000Z", "Der Strom fiel laut Feuerschaugemeinde für rund eine Stunde aus.", 0.85),
    fact("cause", "Kurzschluss, ausgelöst durch einen Vogel", "Ein Vogel verursachte einen Kurzschluss und damit den Stromunterbruch.", 0.98),
    fact("status", "resolved", "Der Strom fiel für rund eine Stunde aus.", 0.9)
  ]
};

function fact(
  fact_type: CandidateFactInput["fact_type"],
  value_text: string,
  evidence_excerpt: string,
  confidence: number
): CuratedFact {
  return {
    fact_type,
    value_text,
    confidence,
    evidence_excerpt,
    source_role: "researched_public_source",
    verified_by: "auto"
  };
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

function genericCause(text: string): CuratedFact | null {
  if (/\b(?:blitzschlag|foudre)\b/i.test(text)) {
    return fact("cause", "Blitzschlag / Gewitter", "Die vorhandene Quellenmeldung nennt einen Blitzschlag oder ein Gewitter als Ursache.", 0.82);
  }
  if (/\b(?:gewitter|unwetter|sturm|orage|temp[eê]te)\b/i.test(text)) {
    return fact("cause", "Gewitter / Unwetter", "Die vorhandene Quellenmeldung nennt ein Gewitter oder Unwetter.", 0.78);
  }
  if (/\b(?:defekt\w*\s+erdkabel|underground cable)\b/i.test(text)) {
    return fact("cause", "Defektes Erdkabel", "Die vorhandene Quellenmeldung nennt ein defektes Erdkabel.", 0.88);
  }
  if (/\b(?:ratten?|rats?)\b/i.test(text)) {
    return fact("cause", "Beschädigung durch Ratten", "Die vorhandene Quellenmeldung nennt Ratten als Auslöser.", 0.85);
  }
  if (/\b(?:vogel|bird)\b/i.test(text)) {
    return fact("cause", "Kurzschluss durch einen Vogel", "Die vorhandene Quellenmeldung nennt einen Vogel als Auslöser.", 0.85);
  }
  if (/\b(?:bauarbeiten|construction work)\b/i.test(text)) {
    return fact("cause", "Bauarbeiten", "Die vorhandene Quellenmeldung nennt Bauarbeiten im Zusammenhang mit dem Unterbruch.", 0.75);
  }
  return null;
}

function genericAffectedArea(target: HistoricalBackfillTarget): CuratedFact | null {
  const text = target.summary ?? "";
  const match = text.match(/(?:rund|etwa|ungefähr|über|mehr als|environ|plus de|over)?\s*\d[\d'’., ]*\s+(?:haushalte|personen|kundinnen und kunden|anschlüsse|foyers|personnes|ménages|connections|households|customers)/i);
  if (!match) return null;
  const value = `${match[0].replace(/\s+/g, " ").trim()} in ${target.location_text ?? "der betroffenen Region"}`;
  return fact("affected_area", value, `Die vorhandene Quellenmeldung beziffert den Umfang mit ${match[0].trim()}.`, 0.78);
}

export function historicalBackfillFacts(
  target: HistoricalBackfillTarget,
  observedAt: string
): CandidateFactInput[] {
  const curated = CURATED_BY_SOURCE[normalizeUrl(target.backfill_source_url)];
  const text = `${target.title} ${target.summary ?? ""}`;
  const derived = curated ? [...curated] : [
    genericCause(text),
    genericAffectedArea(target),
    /\b(?:behoben|wiederhergestellt|rasch behoben|rétabli|resolved)\b/i.test(text)
      ? fact("status", "resolved", "Die vorhandene Quellenmeldung bezeichnet den Unterbruch als behoben.", 0.78)
      : fact("status", "historical", "Die Meldung liegt ausserhalb des 36-Stunden-Fensters für aktive Ereignisse.", 0.99)
  ].filter((value): value is CuratedFact => value !== null);

  return derived.map((value) => ({
    ...value,
    observed_at: observedAt,
    extractor_version: HISTORICAL_BACKFILL_VERSION
  }));
}
