-- Operator data pipeline v2: raw payload → poll → record → incident.
--
-- Until now an operator item went through the Google-Alert machinery
-- (alert_items → candidates → facts → fuzzy 48 h location matching). Its
-- identity was a hash of derived text (title, place, evidence), so
--   * the same trafo produced a second observation whenever reverse geocoding
--     timed out ("unbekanntem Ort"),
--   * a recurring outage in the same place collapsed onto a months-old event,
--   * alert_items were deduplicated by title + URL, which gave new events the
--     first_seen_at of an unrelated outage weeks earlier.
--
-- From here on each operator item is a source_record keyed by the operator's
-- own identity (BKW trafo number, Romande uuid, SAK id, Primeo title + start).
-- Every poll updates when the record was last seen or first missing, so start
-- and end are measured, not guessed. Incidents (outage_events with
-- origin = 'operator') are derived deterministically from their records.

-- One row per completed poll of a registry source. ok = 1 means the listing was
-- complete and authoritative: an item missing from it has really disappeared.
CREATE TABLE IF NOT EXISTS source_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_registry_id INTEGER NOT NULL,
  polled_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  transport_status TEXT NOT NULL,
  parser_status TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT,
  raw_object_key TEXT,
  error TEXT,
  FOREIGN KEY (source_registry_id) REFERENCES source_registry(id)
);

CREATE INDEX IF NOT EXISTS idx_source_polls_source_time
  ON source_polls(source_registry_id, polled_at);

CREATE TABLE IF NOT EXISTS source_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_registry_id INTEGER NOT NULL,
  -- Operator identity without episode, e.g. "trafo:10885:failure".
  base_key TEXT NOT NULL,
  -- Unique identity of this episode: base_key, or base_key#first_seen when the
  -- operator gives no own identity for one occurrence (a failing trafo).
  record_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('planned', 'unplanned')),
  -- listed: present in the latest complete poll; ended: gone or reported resolved
  state TEXT NOT NULL CHECK (state IN ('listed', 'ended')),
  -- What the operator itself says: active, scheduled, resolved or listed (no state given)
  operator_state TEXT NOT NULL,
  title TEXT,
  place_text TEXT,
  detail_text TEXT,
  municipality TEXT,
  canton TEXT,
  latitude REAL,
  longitude REAL,
  reported_start_at TEXT,
  reported_end_at TEXT,
  -- 1 when reported_end_at is an actual end (operator marked it resolved)
  end_is_actual INTEGER NOT NULL DEFAULT 0,
  cause TEXT,
  customers_affected INTEGER,
  -- Last complete poll before the first sighting: earliest possible start.
  prev_absent_at TEXT,
  first_seen_at TEXT NOT NULL,
  -- Last poll that listed it as current (active/scheduled); first_seen_at when
  -- it was never seen current (e.g. an operator history entry).
  last_seen_at TEXT NOT NULL,
  -- 1 once a poll listed it as current.
  seen_current INTEGER NOT NULL DEFAULT 0,
  -- First complete poll where it was gone or no longer current: latest possible end.
  first_missing_at TEXT,
  content_hash TEXT NOT NULL,
  raw_json TEXT,
  outage_event_id INTEGER,
  -- e.g. ["backfill","merged_episodes_suspected"]
  quality_flags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_registry_id, record_key),
  FOREIGN KEY (source_registry_id) REFERENCES source_registry(id),
  FOREIGN KEY (outage_event_id) REFERENCES outage_events(id)
);

CREATE INDEX IF NOT EXISTS idx_source_records_open
  ON source_records(source_registry_id, state, base_key);
CREATE INDEX IF NOT EXISTS idx_source_records_event
  ON source_records(outage_event_id);
CREATE INDEX IF NOT EXISTS idx_source_records_recent
  ON source_records(source_registry_id, kind, last_seen_at);

-- Reverse geocoding results by coordinate (4 decimals ≈ 10 m). A trafo never
-- moves, so each one costs one geo.admin call in its lifetime instead of one
-- per poll. status: ok | outside | error (errors are retried later).
CREATE TABLE IF NOT EXISTS geo_point_cache (
  point_key TEXT PRIMARY KEY,
  municipality TEXT,
  canton TEXT,
  status TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

ALTER TABLE source_registry ADD COLUMN last_payload_hash TEXT;

-- media: Google Alerts / press pipeline; operator: derived from source_records.
ALTER TABLE outage_events ADD COLUMN origin TEXT NOT NULL DEFAULT 'media';
ALTER TABLE outage_events ADD COLUMN source_registry_id INTEGER;
-- Earliest possible start when the operator gives none (last poll without it).
ALTER TABLE outage_events ADD COLUMN start_earliest_at TEXT;
ALTER TABLE outage_events ADD COLUMN record_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outage_events ADD COLUMN quality_flags TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_outage_events_origin_source
  ON outage_events(origin, source_registry_id, last_seen_at);
