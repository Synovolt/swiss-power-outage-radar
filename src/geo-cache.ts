/**
 * Reverse geocoding with a permanent D1 cache keyed by coordinate.
 *
 * Operator coordinates (BKW trafos, SAK pins, Romande impact zones) repeat from
 * poll to poll. Geocoding them live on every poll used most of the 50
 * subrequests a free-plan invocation may make, so later sources failed with
 * "Too many subrequests" and timeouts turned into "unbekanntem Ort". Now each
 * point costs one geo.admin call in its lifetime, under a per-run budget.
 */
import { reverseGeocodeSwissMunicipality, type SwissMunicipalityFix } from "./geo";

/** Failed lookups are retried after this long. */
const ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
const IN_CHUNK = 90;

export interface GeoBudget {
  /** External lookups this run may still make. */
  remaining: number;
}

export type GeoLookup = (latitude: number, longitude: number) => Promise<SwissMunicipalityFix | null>;

export function pointKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

interface CacheRow {
  point_key: string;
  municipality: string | null;
  canton: string | null;
  status: string;
  resolved_at: string;
}

/**
 * Returns municipality/canton per point key. Points neither cached nor
 * resolvable within the budget are absent from the map (retried next run).
 */
export async function resolvePoints(
  db: D1Database,
  points: Array<{ latitude: number; longitude: number }>,
  budget: GeoBudget,
  now: string,
  lookup: GeoLookup = reverseGeocodeSwissMunicipality
): Promise<Map<string, SwissMunicipalityFix | null>> {
  const unique = new Map<string, { latitude: number; longitude: number }>();
  for (const point of points) unique.set(pointKey(point.latitude, point.longitude), point);
  const out = new Map<string, SwissMunicipalityFix | null>();
  if (unique.size === 0) return out;

  const keys = [...unique.keys()];
  const cached = new Map<string, CacheRow>();
  for (let index = 0; index < keys.length; index += IN_CHUNK) {
    const part = keys.slice(index, index + IN_CHUNK);
    const rows = await db
      .prepare(`SELECT * FROM geo_point_cache WHERE point_key IN (${part.map(() => "?").join(", ")})`)
      .bind(...part)
      .all<CacheRow>();
    for (const row of rows.results) cached.set(row.point_key, row);
  }

  const nowMs = Date.parse(now);
  const writes: D1PreparedStatement[] = [];
  for (const [key, point] of unique) {
    const row = cached.get(key);
    if (row && (row.status !== "error" || nowMs - Date.parse(row.resolved_at) < ERROR_RETRY_MS)) {
      if (row.status === "ok" && row.municipality) out.set(key, { municipality: row.municipality, canton: row.canton });
      else if (row.status === "outside") out.set(key, null);
      continue;
    }
    if (budget.remaining <= 0) continue;
    budget.remaining -= 1;
    let fix: SwissMunicipalityFix | null = null;
    let status = "error";
    try {
      fix = await lookup(point.latitude, point.longitude);
      status = fix ? "ok" : "outside";
    } catch {
      status = "error";
    }
    // A null answer from geo.admin can also be a timeout; only trust "outside"
    // for points that are really outside the Swiss bounding box.
    if (!fix && status === "outside") status = "error";
    if (fix) out.set(key, fix);
    writes.push(
      db.prepare(
        `INSERT INTO geo_point_cache (point_key, municipality, canton, status, resolved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(point_key) DO UPDATE SET municipality = excluded.municipality,
           canton = excluded.canton, status = excluded.status, resolved_at = excluded.resolved_at`
      ).bind(key, fix?.municipality ?? null, fix?.canton ?? null, status, now)
    );
  }
  if (writes.length > 0) await db.batch(writes);
  return out;
}
