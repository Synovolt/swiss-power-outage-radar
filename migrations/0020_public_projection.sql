-- Materialized public projection.
--
-- Until now every public page recomputed an event's public state (status, start,
-- end, trust) on each request from outage_events + publication_decisions +
-- outage_facts, and different pages passed different inputs. That produced
-- inconsistent numbers and made SQL statistics impossible.
--
-- From here on a single writer (src/public-projection.ts) materializes the
-- output of toPublicFeedItem() into public_events. All public reads — feed,
-- detail item, operator pages, place pages, sitemap and statistics — read only
-- these tables. The cron keeps time-dependent rows (upcoming/active) fresh.

CREATE TABLE IF NOT EXISTS public_events (
  event_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  nature TEXT NOT NULL,
  trust TEXT NOT NULL,
  location TEXT NOT NULL,
  canton TEXT,
  operator_slug TEXT,
  publisher TEXT,
  received_at TEXT NOT NULL,
  started_at TEXT,
  resolved_at TEXT,
  end_earliest_at TEXT,
  end_latest_at TEXT,
  expected_restore_at TEXT,
  duration_minutes INTEGER,
  -- 0 = future planned interruption (listed first, ascending), 1 = everything else
  sort_bucket INTEGER NOT NULL DEFAULT 1,
  sort_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  places_key TEXT NOT NULL DEFAULT '',
  item_json TEXT NOT NULL,
  -- 1 when the state can no longer change through the passage of time alone
  is_final INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT NOT NULL,
  projected_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES outage_events(id)
);

CREATE INDEX IF NOT EXISTS idx_public_events_feed
ON public_events(sort_bucket, sort_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_public_events_operator
ON public_events(operator_slug, sort_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_events_canton
ON public_events(canton, sort_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_events_final
ON public_events(is_final);

-- One row per affected municipality/locality, so multi-place outages show up
-- on every place page and place statistics do not double count events.
CREATE TABLE IF NOT EXISTS public_event_places (
  event_id INTEGER NOT NULL,
  place_slug TEXT NOT NULL,
  place_name TEXT NOT NULL,
  canton TEXT,
  PRIMARY KEY (event_id, place_slug),
  FOREIGN KEY (event_id) REFERENCES public_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_public_event_places_slug
ON public_event_places(place_slug);

-- Precomputed statistics (one row per key), refreshed by the cron at most hourly
-- so that statistics pages cost a single row read.
CREATE TABLE IF NOT EXISTS public_stats_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- Backfill the resolution window for events that were auto-closed while the
-- window was still being discarded. The presence rows keep both bounds.
UPDATE outage_events
SET resolution_earliest_at = (
      SELECT MAX(p.last_confirmed_at) FROM outage_event_source_presence p
      WHERE p.outage_event_id = outage_events.id
    ),
    resolution_latest_at = (
      SELECT MAX(p.first_missing_at) FROM outage_event_source_presence p
      WHERE p.outage_event_id = outage_events.id
    )
WHERE status = 'resolved'
  AND time_confidence = 'inferred'
  AND resolution_earliest_at IS NULL
  AND EXISTS (
    SELECT 1 FROM outage_event_source_presence p
    WHERE p.outage_event_id = outage_events.id
      AND p.first_missing_at IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_public_event_places_canton
ON public_event_places(canton, place_slug);
