import { canonicalLocation, normalizeLocation } from "./events";

interface GeoAdminResult {
  attrs?: {
    label?: string;
    detail?: string;
    origin?: string;
  };
  attributes?: {
    gemname?: string;
    label?: string;
    kanton?: string;
    jahr?: number;
    is_current_jahr?: boolean;
  };
}

interface GeoAdminResponse {
  results?: GeoAdminResult[];
}

export interface SwissLocationNormalization {
  normalizedLocation: string;
  label: string | null;
  source: "geo.admin.ch" | "fallback";
  reason: string;
}

export interface SwissMunicipalityFix {
  municipality: string;
  canton: string | null;
}

export const SWISS_LATITUDE_MIN = 45.7;
export const SWISS_LATITUDE_MAX = 47.9;
export const SWISS_LONGITUDE_MIN = 5.9;
export const SWISS_LONGITUDE_MAX = 10.7;

export function isSwissWgs84(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= SWISS_LATITUDE_MIN &&
    latitude <= SWISS_LATITUDE_MAX &&
    longitude >= SWISS_LONGITUDE_MIN &&
    longitude <= SWISS_LONGITUDE_MAX
  );
}

function hasMultipleConcretePlaces(location: string): boolean {
  const parts = location
    .split(",")
    .map((part) => canonicalLocation(part))
    .filter((part) => part && part !== "unknown");
  return new Set(parts).size > 1;
}

function extractLabel(label: string | undefined, detail: string | undefined): string {
  const bold = label?.match(/<b>(.*?)<\/b>/i)?.[1];
  const raw = bold || label || detail || "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactName(value: string | null | undefined): string | null {
  const name = (value ?? "").replace(/\s+/g, " ").trim();
  return name || null;
}

function pickCurrentMunicipality(results: GeoAdminResult[]): SwissMunicipalityFix | null {
  const ranked = results
    .map((result) => result.attributes)
    .filter((attributes): attributes is NonNullable<GeoAdminResult["attributes"]> => Boolean(attributes?.gemname || attributes?.label))
    .sort((left, right) => {
      const currentDelta = Number(Boolean(right.is_current_jahr)) - Number(Boolean(left.is_current_jahr));
      if (currentDelta !== 0) return currentDelta;
      return (right.jahr ?? 0) - (left.jahr ?? 0);
    });
  const selected = ranked[0];
  const municipality = compactName(selected?.gemname) ?? compactName(selected?.label);
  if (!municipality) return null;
  return { municipality, canton: compactName(selected?.kanton) };
}

/**
 * Municipality and canton at a WGS84 point. Returns null when the point lies in
 * no Swiss municipality. With throwOnError, transport failures (timeouts,
 * exhausted subrequest budget, HTTP errors) throw instead of looking like
 * "nothing found", so callers do not persist a miss for a temporary failure.
 */
export async function reverseGeocodeSwissMunicipality(
  latitude: number,
  longitude: number,
  options: { throwOnError?: boolean } = {}
): Promise<SwissMunicipalityFix | null> {
  if (!isSwissWgs84(latitude, longitude)) return null;

  const url = new URL("https://api3.geo.admin.ch/rest/services/all/MapServer/identify");
  url.searchParams.set("geometry", `${longitude},${latitude}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("layers", "all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill");
  url.searchParams.set("mapExtent", `${SWISS_LONGITUDE_MIN},${SWISS_LATITUDE_MIN},${SWISS_LONGITUDE_MAX},${SWISS_LATITUDE_MAX}`);
  url.searchParams.set("imageDisplay", "100,100,96");
  url.searchParams.set("tolerance", "0");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("sr", "4326");
  url.searchParams.set("lang", "de");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url.toString(), {
      headers: { "User-Agent": "swiss-power-outage-radar/0.1" },
      signal: controller.signal
    });
    if (!response.ok) {
      if (options.throwOnError) throw new Error(`geo.admin identify HTTP ${response.status}`);
      return null;
    }
    const data = (await response.json()) as GeoAdminResponse;
    return pickCurrentMunicipality(data.results ?? []);
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function normalizeSwissLocation(
  location: string | null | undefined
): Promise<SwissLocationNormalization> {
  const fallback = canonicalLocation(location);
  const raw = (location ?? "").trim();
  if (!raw || fallback === "unknown") {
    return { normalizedLocation: fallback, label: null, source: "fallback", reason: "missing" };
  }
  if (hasMultipleConcretePlaces(raw)) {
    return { normalizedLocation: fallback, label: raw, source: "fallback", reason: "multi_place" };
  }

  const url = new URL("https://api3.geo.admin.ch/rest/services/ech/SearchServer");
  url.searchParams.set("searchText", raw);
  url.searchParams.set("type", "locations");
  url.searchParams.set("origins", "gg25,zipcode,district,kantone");
  url.searchParams.set("limit", "3");
  url.searchParams.set("returnGeometry", "false");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url.toString(), {
      headers: { "User-Agent": "swiss-power-outage-radar/0.1" },
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        normalizedLocation: fallback,
        label: null,
        source: "fallback",
        reason: `geo_http_${response.status}`
      };
    }

    const data = (await response.json()) as GeoAdminResponse;
    const result = data.results?.[0];
    const label = extractLabel(result?.attrs?.label, result?.attrs?.detail);
    const normalized = canonicalLocation(label) || normalizeLocation(label);
    if (!label || normalized === "unknown") {
      return { normalizedLocation: fallback, label: null, source: "fallback", reason: "geo_empty" };
    }

    return {
      normalizedLocation: normalized,
      label,
      source: "geo.admin.ch",
      reason: result?.attrs?.origin ?? "match"
    };
  } catch (error) {
    return {
      normalizedLocation: fallback,
      label: null,
      source: "fallback",
      reason: error instanceof Error ? error.message : "geo_error"
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
