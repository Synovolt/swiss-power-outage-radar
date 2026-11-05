import { classifySource } from "./intelligence";
import { normalizeLocation } from "./events";
import { stripPageMetadata } from "./source-text";
import type {
  AiClassification,
  CandidateAssessment,
  CandidateFactInput,
  LocationGranularity,
  NormalizedRssItem,
  OutageNature,
  RelevanceRole,
  SourceSnapshot
} from "./types";

const GENERIC_LOCATIONS = new Set([
  "schweiz",
  "suisse",
  "svizzera",
  "switzerland",
  "unknown",
  "unbekannt",
  "ort unklar",
  "nicht eindeutig erkannt"
]);

const FOREIGN_LOCATION_TERMS = new Set([
  "berlin",
  "kuba",
  "cuba",
  "deutschland",
  "germany",
  "tuerkei",
  "turkei",
  "turkey",
  "marmaray"
]);

const OUTAGE_TERMS = [
  "stromausfall",
  "stromunterbruch",
  "netzunterbruch",
  "netzausfall",
  "netzstörung",
  "netzstoerung",
  "panne de courant",
  "coupure de courant",
  "interruption de courant",
  "interruzione di corrente",
  "guasto elettrico"
];

const OUTAGE_TITLE_TERMS = [
  ...OUTAGE_TERMS,
  "ohne strom",
  "sans courant",
  "privées d'électricité",
  "privees d'electricite",
  "privati dell'elettricita",
  "privati dell'elettricità"
];

const INCIDENTAL_TERMS = [
  "expertenkommission",
  "bericht vor",
  "lehren aus",
  "rückblick",
  "rueckblick",
  "archiv",
  "im januar",
  "anfang des jahres",
  "damals",
  "historisch",
  "vorsorge",
  "ratgeber"
];

const MONTHS: Record<string, number> = {
  januar: 0,
  janvier: 0,
  gennaio: 0,
  februar: 1,
  fevrier: 1,
  février: 1,
  febbraio: 1,
  maerz: 2,
  marz: 2,
  märz: 2,
  mars: 2,
  marzo: 2,
  april: 3,
  avril: 3,
  aprile: 3,
  mai: 4,
  maggio: 4,
  juni: 5,
  juin: 5,
  giugno: 5,
  juli: 6,
  juillet: 6,
  luglio: 6,
  august: 7,
  aout: 7,
  août: 7,
  agosto: 7,
  september: 8,
  septembre: 8,
  settembre: 8,
  oktober: 9,
  octobre: 9,
  ottobre: 9,
  november: 10,
  novembre: 10,
  dezember: 11,
  decembre: 11,
  décembre: 11,
  dicembre: 11
};

function compact(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalized(value: string | null | undefined): string {
  return normalizeLocation(value ?? "");
}

function includesAny(text: string, terms: string[]): boolean {
  const haystack = normalized(text);
  return terms.some((term) => haystack.includes(normalized(term)));
}

function bestEvidenceText(item: NormalizedRssItem, snapshot?: SourceSnapshot | null): string {
  const snapshotText = compact(stripPageMetadata(snapshot?.markdown_excerpt));
  if (snapshotText && includesAny(snapshotText, OUTAGE_TERMS)) return snapshotText;
  return compact([item.title, item.source, item.snippet].filter(Boolean).join(". "));
}

function evidenceSentence(text: string): string {
  const sentences = compact(text).split(/(?<=[.!?])\s+/);
  const outageSentence = sentences.find((sentence) => includesAny(sentence, OUTAGE_TERMS));
  return compact(outageSentence || sentences[0] || text).slice(0, 600);
}

function locationGranularity(location: string): LocationGranularity {
  const key = normalized(location);
  if (!key || key === "unknown") return "unknown";
  if (GENERIC_LOCATIONS.has(key)) return "country";
  if (/\b(kanton|canton|cantone)\b/i.test(location)) return "canton";
  if (/\b(region|bezirk|district|tal|nordosten|sueden|süden|osten|westen)\b/i.test(location)) {
    return "region";
  }
  if (/\b(strasse|straße|weg|gasse|platz|route|rue|via)\b/i.test(location)) return "street";
  return "municipality";
}

function isForeignLocation(location: string, text: string): boolean {
  const combined = normalized(`${location} ${text}`);
  return [...FOREIGN_LOCATION_TERMS].some((term) => combined.includes(term));
}

function relevanceRole(input: {
  classification: AiClassification;
  text: string;
  sourceOfficial: boolean;
  foreign: boolean;
}): RelevanceRole {
  if (input.foreign) return "foreign_event";
  if (includesAny(input.text, INCIDENTAL_TERMS)) return "incidental_mention";
  if (input.classification.event_type === "planned_outage" || input.sourceOfficial) {
    return "official_notice";
  }
  if (/\b(behoben|wieder am netz|resolved|rétabli|ripristinata)\b/i.test(input.text)) {
    return "incident_update";
  }
  if (includesAny(input.text, OUTAGE_TERMS)) return "primary_report";
  return "background";
}

function inferNature(classification: AiClassification, text: string): OutageNature {
  if (
    classification.event_type === "planned_outage" ||
    /\b(geplant|geplanter|wartung|unterhaltsarbeiten|maintenance|travaux|programmata)\b/i.test(text)
  ) {
    return "planned";
  }
  if (classification.event_type === "power_outage" || classification.event_type === "grid_disturbance") {
    return "unplanned";
  }
  return "unknown";
}

function inferStatus(text: string): "active" | "resolved" | "unknown" {
  if (/\b(behoben|wieder am netz|wiederhergestellt|resolved|rétabli|ripristinata)\b/i.test(text)) {
    return "resolved";
  }
  if (/\b(aktuell|derzeit|zurzeit|ohne strom|betroffen|unterbrochen)\b/i.test(text)) return "active";
  return "unknown";
}

function explicitDate(text: string, fallbackYear: number): string | null {
  const numeric = text.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
  if (numeric) {
    return new Date(
      Date.UTC(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]))
    ).toISOString();
  }

  const words = text.match(/\b(\d{1,2})\.?\s+([A-Za-zÀ-ÿäöüÄÖÜéèêàùûôîç]+)\s+(20\d{2})\b/);
  if (words) {
    const month = MONTHS[normalized(words[2])];
    if (month !== undefined) {
      return new Date(Date.UTC(Number(words[3]), month, Number(words[1]))).toISOString();
    }
  }

  const shortWords = text.match(/\b(\d{1,2})\.?\s+([A-Za-zÀ-ÿäöüÄÖÜéèêàùûôîç]+)\b/);
  if (!shortWords) return null;
  const month = MONTHS[normalized(shortWords[2])];
  if (month === undefined) return null;
  return new Date(Date.UTC(fallbackYear, month, Number(shortWords[1]))).toISOString();
}

function fact(
  fact_type: CandidateFactInput["fact_type"],
  value_text: string,
  confidence: number,
  evidence_excerpt: string,
  source_role: string,
  verified_by: CandidateFactInput["verified_by"] = "auto"
): CandidateFactInput {
  return {
    fact_type,
    value_text,
    confidence,
    evidence_excerpt,
    source_role,
    verified_by
  };
}

export function assessCandidateEvidence(input: {
  item: NormalizedRssItem;
  classification: AiClassification;
  snapshot?: SourceSnapshot | null;
}): CandidateAssessment {
  const text = bestEvidenceText(input.item, input.snapshot);
  const evidence = evidenceSentence(text);
  const sourceIntel = classifySource({
    url: input.item.url,
    title: input.item.title,
    sourceName: input.item.source
  });
  const sourceRole = sourceIntel.source_kind;
  const verifiedBy = sourceIntel.is_official === 1 ? "official_source" : "auto";
  const location = compact(input.classification.location_text);
  const locationKey = normalized(location);
  const granularity = locationGranularity(location);
  const foreign = input.classification.country === "other" || isForeignLocation(location, text);
  const role = relevanceRole({
    classification: input.classification,
    text,
    sourceOfficial: sourceIntel.is_official === 1,
    foreign
  });
  const titleOutageCentered = includesAny(input.item.title, OUTAGE_TITLE_TERMS);
  const nature = inferNature(input.classification, text);
  const status = inferStatus(text);
  const fallbackYear = new Date(input.item.published_at ?? Date.now()).getUTCFullYear();
  const startDate = explicitDate(text, fallbackYear);
  const facts: CandidateFactInput[] = [];
  const reasons: string[] = [];

  if (location && locationKey !== "unknown") {
    facts.push(fact("location", location, 0.85, evidence, sourceRole, verifiedBy));
    reasons.push(`location:${granularity}`);
  }

  if (includesAny(text, OUTAGE_TERMS)) {
    facts.push(
      fact(
        input.classification.event_type === "planned_outage" ? "planned_outage_notice" : "outage_happened",
        "true",
        Math.max(0.7, input.classification.confidence),
        evidence,
        sourceRole,
        verifiedBy
      )
    );
    reasons.push("outage_evidence_excerpt");
  }

  if (nature !== "unknown") {
    facts.push(fact("planned_nature", nature, 0.72, evidence, sourceRole, verifiedBy));
    reasons.push(`nature:${nature}`);
  }

  if (status !== "unknown") {
    facts.push(fact("status", status, 0.68, evidence, sourceRole, verifiedBy));
    reasons.push(`status:${status}`);
  }

  if (startDate) {
    facts.push(fact("start_time", startDate, 0.72, evidence, sourceRole, verifiedBy));
    reasons.push("start_time:explicit_date");
  }

  if (foreign) {
    return {
      publishable: false,
      needs_admin: false,
      is_ch_incident: false,
      location_text: location,
      location_granularity: granularity,
      event_type: input.classification.event_type,
      relevance_role: role,
      quality_score: 0,
      quality_reasons: [...reasons, "foreign_event"],
      rejection_reason: "Ausländisches Ereignis oder Schweizer Quelle berichtet nur über Ausland.",
      outage_nature: nature,
      status,
      summary_de: input.classification.summary,
      facts
    };
  }

  if (
    input.classification.event_type === "unclear" ||
    role === "incidental_mention" ||
    role === "background"
  ) {
    return {
      publishable: false,
      needs_admin: role !== "background",
      is_ch_incident: true,
      location_text: location,
      location_granularity: granularity,
      event_type: input.classification.event_type,
      relevance_role: role,
      quality_score: 25,
      quality_reasons: reasons,
      rejection_reason:
        role === "incidental_mention"
          ? "Stromausfall ist nur Neben- oder Rückblickkontext."
          : "Kein klarer Stromversorgungsunterbruch belegt.",
      outage_nature: nature,
      status,
      summary_de: input.classification.summary,
      facts
    };
  }

  const hasConcreteLocation =
    granularity === "address" ||
    granularity === "street" ||
    granularity === "municipality" ||
    granularity === "region";
  const hasEvidence = facts.some((candidate) =>
    candidate.fact_type === "outage_happened" || candidate.fact_type === "planned_outage_notice"
  );
  const hasPrimaryOrOfficial =
    (role === "primary_report" && titleOutageCentered) ||
    role === "official_notice" ||
    role === "incident_update" ||
    sourceIntel.is_official === 1;

  let qualityScore = Math.round(input.classification.confidence * 45);
  if (hasConcreteLocation) qualityScore += 20;
  if (hasEvidence) qualityScore += 20;
  if (hasPrimaryOrOfficial) qualityScore += 10;
  if (!titleOutageCentered && sourceIntel.is_official !== 1) qualityScore -= 25;
  if (sourceIntel.is_official === 1) qualityScore += 10;
  if (input.snapshot?.fetch_status === "success") qualityScore += 5;
  qualityScore = Math.max(0, Math.min(100, qualityScore));

  const publishable =
    qualityScore >= 70 &&
    hasConcreteLocation &&
    hasEvidence &&
    hasPrimaryOrOfficial &&
    (titleOutageCentered || sourceIntel.is_official === 1);

  return {
    publishable,
    needs_admin: !publishable,
    is_ch_incident: true,
    location_text: location,
    location_granularity: granularity,
    event_type: input.classification.event_type,
    relevance_role: role,
    quality_score: qualityScore,
    quality_reasons: reasons,
    rejection_reason: publishable ? null : "Mindestkriterien fuer öffentliche Anzeige nicht erfüllt.",
    outage_nature: nature,
    status,
    summary_de: input.classification.summary,
    facts
  };
}
