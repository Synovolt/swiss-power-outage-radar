import { publicDisplayLocation, publicEventSlug } from "./public-url";
import { cantonByName, splitCantonSuffix } from "./swiss-cantons";

export interface PublicPlace {
  slug: string;
  name: string;
  canton: string | null;
}

export interface PublicPlaceInput {
  location: string;
  /** geo.admin label of the resolved pin, e.g. "Chavornay (VD)". */
  label?: string | null;
  precision?: string | null;
  /** Canton already known on the event itself. */
  eventCanton?: string | null;
}

const MAX_PLACES = 12;
const GENERIC_PLACES = new Set(["schweiz", "suisse", "svizzera", "switzerland", "unknown", "unbekannt", "region", "gemeinde"]);
// "Commune d'Ollon" has no space after the apostrophe, hence the separate branch.
const PREFIX = /^(?:(?:gemeinde|gemeindegebiet|stadt|ortschaft|commune de|ville de|comune di|region|région|regione|quartier|ortsteil)\s+|(?:commune|ville|comune) d['’]\s*)/i;

function cleanPart(part: string): string {
  return part
    .replace(PREFIX, "")
    .replace(/^\d{4}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CITY_NAMED_CANTONS = new Set([
  "zurich", "zuerich", "bern", "berne", "luzern", "lucerne", "zug", "zoug", "schwyz", "glarus",
  "freiburg", "fribourg", "solothurn", "soleure", "schaffhausen", "st-gallen", "st-gall", "saint-gall",
  "genf", "geneve", "geneva", "ginevra", "neuchatel", "neuenburg", "appenzell"
]);

function isCityNamedCanton(part: string): boolean {
  return CITY_NAMED_CANTONS.has(publicEventSlug(part));
}

function splitLocation(location: string): string[] {
  return publicDisplayLocation(location)
    .split(/\s*(?:,|;|\/|\s+und\s+|\s+et\s+|\s+e\s+|\s+sowie\s+)\s*/i)
    .map(cleanPart)
    .filter(Boolean);
}

/**
 * Turns the public location of an event into the municipalities/localities it
 * affects. Canton names inside the location are used as canton context, never
 * as a place of their own.
 */
export function derivePublicPlaces(input: PublicPlaceInput): { places: PublicPlace[]; canton: string | null } {
  const parts = splitLocation(input.location);
  let canton = input.eventCanton?.toUpperCase() ?? null;
  const places: PublicPlace[] = [];
  const seen = new Set<string>();

  const label = input.label?.trim();
  const preciseLabel = label && (input.precision === "municipality" || input.precision === "locality");
  const labelSplit = label ? splitCantonSuffix(label) : null;
  if (labelSplit?.canton) canton = labelSplit.canton;

  const add = (name: string, placeCanton: string | null) => {
    // A trailing "-<digits>" would collide with event URLs (/stromausfall/<place>-<id>).
    const slug = publicEventSlug(name).replace(/(?:-\d+)+$/, "");
    if (!slug || slug === "schweiz" || GENERIC_PLACES.has(slug) || /^\d+$/.test(slug) || slug.length < 2) return;
    if (seen.has(slug) || places.length >= MAX_PLACES) return;
    seen.add(slug);
    places.push({ slug, name, canton: placeCanton });
  };

  const named: Array<{ name: string; canton: string | null }> = [];
  for (const [index, part] of parts.entries()) {
    const cantonPart = cantonByName(part);
    // "Bern", "Zug" or "Genève" are cities as well as cantons: only treat them as
    // canton context when explicitly marked or when trailing a list of places.
    const explicit = /^(?:kanton|canton|cantone)\b/i.test(part);
    const trailing = parts.length > 1 && index === parts.length - 1;
    if (cantonPart && (explicit || trailing || !isCityNamedCanton(part))) {
      canton = canton ?? cantonPart.code;
      continue;
    }
    // A city that shares its canton's name lies in that canton.
    if (cantonPart) canton = canton ?? cantonPart.code;
    const split = splitCantonSuffix(part);
    if (split.canton) canton = canton ?? split.canton;
    if (split.name) named.push(split);
  }

  if (preciseLabel && labelSplit && named.length <= 1) {
    add(labelSplit.name, labelSplit.canton ?? canton);
  } else {
    for (const part of named) add(part.name, part.canton ?? canton);
  }

  // Swiss municipality names repeat across cantons (Buchs AG/SG/ZH, Wil SG/ZH,
  // Kirchberg BE/SG), so the canton is part of the page identity when known.
  const unique = new Set<string>();
  const output: PublicPlace[] = [];
  for (const place of places) {
    const placeCanton = place.canton ?? canton;
    const slug = placeCanton ? `${place.slug}-${placeCanton.toLowerCase()}` : place.slug;
    if (unique.has(slug)) continue;
    unique.add(slug);
    output.push({ ...place, slug, canton: placeCanton });
  }
  return { places: output, canton };
}

export function placesKey(places: PublicPlace[]): string {
  return places.map((place) => `${place.slug}:${place.canton ?? ""}`).join("|");
}
