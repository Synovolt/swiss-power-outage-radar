import type { AppLocale } from "./i18n/locales";

export interface SwissCanton {
  code: string;
  slug: string;
  names: Record<AppLocale, string>;
  /** French name with its preposition, as in "canton de Vaud" / "canton du Valais". */
  frOf: string;
  /** Extra spellings that appear in operator and media texts. */
  aliases: string[];
  centroid: [number, number];
}

export const SWISS_CANTONS: SwissCanton[] = [
  { code: "ZH", slug: "zuerich", names: { de: "Zürich", fr: "Zurich", it: "Zurigo", en: "Zurich" }, frOf: "de Zurich", aliases: [], centroid: [47.3769, 8.5417] },
  { code: "BE", slug: "bern", names: { de: "Bern", fr: "Berne", it: "Berna", en: "Bern" }, frOf: "de Berne", aliases: [], centroid: [46.948, 7.4474] },
  { code: "LU", slug: "luzern", names: { de: "Luzern", fr: "Lucerne", it: "Lucerna", en: "Lucerne" }, frOf: "de Lucerne", aliases: [], centroid: [47.0502, 8.3093] },
  { code: "UR", slug: "uri", names: { de: "Uri", fr: "Uri", it: "Uri", en: "Uri" }, frOf: "d'Uri", aliases: [], centroid: [46.8817, 8.6444] },
  { code: "SZ", slug: "schwyz", names: { de: "Schwyz", fr: "Schwytz", it: "Svitto", en: "Schwyz" }, frOf: "de Schwytz", aliases: [], centroid: [47.0207, 8.652] },
  { code: "OW", slug: "obwalden", names: { de: "Obwalden", fr: "Obwald", it: "Obvaldo", en: "Obwalden" }, frOf: "d'Obwald", aliases: [], centroid: [46.898, 8.244] },
  { code: "NW", slug: "nidwalden", names: { de: "Nidwalden", fr: "Nidwald", it: "Nidvaldo", en: "Nidwalden" }, frOf: "de Nidwald", aliases: [], centroid: [46.9581, 8.366] },
  { code: "GL", slug: "glarus", names: { de: "Glarus", fr: "Glaris", it: "Glarona", en: "Glarus" }, frOf: "de Glaris", aliases: [], centroid: [47.0404, 9.068] },
  { code: "ZG", slug: "zug", names: { de: "Zug", fr: "Zoug", it: "Zugo", en: "Zug" }, frOf: "de Zoug", aliases: [], centroid: [47.1662, 8.5155] },
  { code: "FR", slug: "freiburg", names: { de: "Freiburg", fr: "Fribourg", it: "Friburgo", en: "Fribourg" }, frOf: "de Fribourg", aliases: [], centroid: [46.8065, 7.162] },
  { code: "SO", slug: "solothurn", names: { de: "Solothurn", fr: "Soleure", it: "Soletta", en: "Solothurn" }, frOf: "de Soleure", aliases: [], centroid: [47.2088, 7.5323] },
  { code: "BS", slug: "basel-stadt", names: { de: "Basel-Stadt", fr: "Bâle-Ville", it: "Basilea Città", en: "Basel-Stadt" }, frOf: "de Bâle-Ville", aliases: [], centroid: [47.5596, 7.5886] },
  { code: "BL", slug: "basel-landschaft", names: { de: "Basel-Landschaft", fr: "Bâle-Campagne", it: "Basilea Campagna", en: "Basel-Landschaft" }, frOf: "de Bâle-Campagne", aliases: ["Baselland"], centroid: [47.4418, 7.764] },
  { code: "SH", slug: "schaffhausen", names: { de: "Schaffhausen", fr: "Schaffhouse", it: "Sciaffusa", en: "Schaffhausen" }, frOf: "de Schaffhouse", aliases: [], centroid: [47.696, 8.634] },
  { code: "AR", slug: "appenzell-ausserrhoden", names: { de: "Appenzell Ausserrhoden", fr: "Appenzell Rhodes-Extérieures", it: "Appenzello Esterno", en: "Appenzell Ausserrhoden" }, frOf: "d'Appenzell Rhodes-Extérieures", aliases: [], centroid: [47.3667, 9.3] },
  { code: "AI", slug: "appenzell-innerrhoden", names: { de: "Appenzell Innerrhoden", fr: "Appenzell Rhodes-Intérieures", it: "Appenzello Interno", en: "Appenzell Innerrhoden" }, frOf: "d'Appenzell Rhodes-Intérieures", aliases: [], centroid: [47.331, 9.409] },
  { code: "SG", slug: "st-gallen", names: { de: "St. Gallen", fr: "Saint-Gall", it: "San Gallo", en: "St. Gallen" }, frOf: "de Saint-Gall", aliases: ["St.Gallen", "Sankt Gallen"], centroid: [47.4245, 9.3767] },
  { code: "GR", slug: "graubuenden", names: { de: "Graubünden", fr: "Grisons", it: "Grigioni", en: "Graubünden" }, frOf: "des Grisons", aliases: ["Grischun"], centroid: [46.8499, 9.5329] },
  { code: "AG", slug: "aargau", names: { de: "Aargau", fr: "Argovie", it: "Argovia", en: "Aargau" }, frOf: "d'Argovie", aliases: [], centroid: [47.3925, 8.0444] },
  { code: "TG", slug: "thurgau", names: { de: "Thurgau", fr: "Thurgovie", it: "Turgovia", en: "Thurgau" }, frOf: "de Thurgovie", aliases: [], centroid: [47.556, 8.896] },
  { code: "TI", slug: "tessin", names: { de: "Tessin", fr: "Tessin", it: "Ticino", en: "Ticino" }, frOf: "du Tessin", aliases: [], centroid: [46.2044, 9.024] },
  { code: "VD", slug: "waadt", names: { de: "Waadt", fr: "Vaud", it: "Vaud", en: "Vaud" }, frOf: "de Vaud", aliases: [], centroid: [46.5197, 6.6323] },
  { code: "VS", slug: "wallis", names: { de: "Wallis", fr: "Valais", it: "Vallese", en: "Valais" }, frOf: "du Valais", aliases: [], centroid: [46.2276, 7.3606] },
  { code: "NE", slug: "neuenburg", names: { de: "Neuenburg", fr: "Neuchâtel", it: "Neuchâtel", en: "Neuchâtel" }, frOf: "de Neuchâtel", aliases: [], centroid: [46.99, 6.929] },
  { code: "GE", slug: "genf", names: { de: "Genf", fr: "Genève", it: "Ginevra", en: "Geneva" }, frOf: "de Genève", aliases: [], centroid: [46.2044, 6.1432] },
  { code: "JU", slug: "jura", names: { de: "Jura", fr: "Jura", it: "Giura", en: "Jura" }, frOf: "du Jura", aliases: [], centroid: [47.365, 7.345] }
];

const BY_CODE = new Map(SWISS_CANTONS.map((canton) => [canton.code, canton]));

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_NAME = new Map<string, SwissCanton>();
for (const canton of SWISS_CANTONS) {
  for (const name of [...Object.values(canton.names), ...canton.aliases, `Kanton ${canton.names.de}`, `canton de ${canton.names.fr}`, `canton du ${canton.names.fr}`]) {
    BY_NAME.set(fold(name), canton);
  }
}

export function cantonByCode(code: string | null | undefined): SwissCanton | null {
  if (!code) return null;
  return BY_CODE.get(code.trim().toUpperCase()) ?? null;
}

/** Matches a whole text against a canton name ("Aargau", "Kanton Bern", "Valais"). */
export function cantonByName(value: string | null | undefined): SwissCanton | null {
  if (!value) return null;
  return BY_NAME.get(fold(value)) ?? null;
}

/** Canton name as it reads after the word "canton"/"Kanton" in running text. */
export function cantonInText(canton: SwissCanton, locale: AppLocale): string {
  return locale === "fr" ? canton.frOf : canton.names[locale];
}

export function cantonName(code: string | null | undefined, locale: AppLocale): string | null {
  return cantonByCode(code)?.names[locale] ?? null;
}

function slugify(value: string): string {
  return fold(value).replace(/\s+/g, "-");
}

/** Localized URL slug, e.g. VD → "waadt" (de) / "vaud" (fr). */
export function cantonSlug(canton: SwissCanton, locale: AppLocale): string {
  return slugify(canton.names[locale]);
}

/** Accepts the slug of any locale or the two-letter code. */
export function cantonBySlug(slug: string | null | undefined): SwissCanton | null {
  if (!slug) return null;
  const needle = slug.toLowerCase();
  return SWISS_CANTONS.find((canton) =>
    canton.code.toLowerCase() === needle ||
    canton.slug === needle ||
    Object.values(canton.names).some((name) => slugify(name) === needle)
  ) ?? null;
}

/**
 * Extracts a canton from a place label such as "Chavornay (VD)", "Brugg AG" or
 * "Brugg, Aargau". Returns the cleaned place name without the canton marker.
 */
export function splitCantonSuffix(label: string): { name: string; canton: string | null } {
  const trimmed = label.replace(/\s+/g, " ").trim();
  const parenthesized = trimmed.match(/^(.*?)\s*\(([A-Z]{2})\)$/);
  if (parenthesized && cantonByCode(parenthesized[2])) {
    return { name: parenthesized[1].trim(), canton: parenthesized[2] };
  }
  const suffix = trimmed.match(/^(.*\S)\s+([A-Z]{2})$/);
  if (suffix && cantonByCode(suffix[2])) {
    return { name: suffix[1].trim(), canton: suffix[2] };
  }
  return { name: trimmed, canton: null };
}
