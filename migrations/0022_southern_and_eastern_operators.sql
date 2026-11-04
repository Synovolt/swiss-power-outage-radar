-- Southern Ticino, Davos and Frauenfeld get item-level sources; Gossau loses
-- a dead URL. Every new source is checked every 30 minutes (one fetch each),
-- so the cron stays well inside the free-tier subrequest budget.
--
-- AIM (Mendrisio): "Interruzioni programmate" card list with when/where lines.
-- AGE (Chiasso): WordPress posts in the two electricity categories (19
--   unplanned, 24 planned) with ACF start/end/municipality fields.
-- EW Davos: the homepage "Netzzustand" box.
INSERT INTO source_registry (
  source_key, operator_name, source_type, source_category, url, area_text, trust_level,
  check_interval_minutes, priority, adapter_config_json, firecrawl_enabled, health_status
) VALUES
('aim-mendrisio-interruzioni','AIM Mendrisio','html','live_status','https://aim.mendrisio.ch/web/news-e-approfondimenti/interruzioni-programmate.html','Mendrisio und AIM Versorgungsgebiet im Mendrisiotto','official',30,72,'{"language":"it","status_mode":"aim_interruzioni_programmate","utility_filter":"electricity_only","no_outage_terms":["nessuna interruzione"]}',0,'unknown'),
('age-chiasso-interruzioni','AGE Chiasso','html','live_status','https://age-sa.ch/','Chiasso, Balerna, Morbio Inferiore und Vacallo','official',30,70,'{"language":"it","status_mode":"operator_api","api_url":"https://age-sa.ch/wp-json/wp/v2/posts?categories=19,24&per_page=20&_fields=id,date,link,title,categories,acf","utility_filter":"electricity_only","no_outage_terms":["nessuna interruzione"]}',0,'unknown'),
('ewd-davos-netzzustand','EW Davos','html','live_status','https://www.ewd.ch/','Gemeinde Davos','official',30,68,'{"language":"de","status_mode":"ewd_netzzustand","utility_filter":"electricity_only","no_outage_terms":["momentan keine störung"]}',0,'unknown')
ON CONFLICT(source_key) DO UPDATE SET
  operator_name = excluded.operator_name,
  source_type = excluded.source_type,
  source_category = excluded.source_category,
  url = excluded.url,
  area_text = excluded.area_text,
  trust_level = excluded.trust_level,
  check_interval_minutes = excluded.check_interval_minutes,
  priority = excluded.priority,
  adapter_config_json = excluded.adapter_config_json,
  firecrawl_enabled = excluded.firecrawl_enabled,
  updated_at = CURRENT_TIMESTAMP;

-- Thurplus: the press page (/ueber-thurplus/presse/) answers 404; the
-- Störungsdienst page carries an "Aktuelle Störungen" widget instead.
UPDATE source_registry
SET source_key = 'thurplus-stoerungen',
    source_category = 'live_status',
    url = 'https://www.thurplus.ch/fuer-private/kundenservice/stoerung/stoerungsdienst.html/67',
    adapter_config_json = '{"language":"de","status_mode":"thurplus_aktuelle_stoerungen","utility_filter":"electricity_only"}',
    check_interval_minutes = 30,
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'thurplus-presse'
  AND NOT EXISTS (SELECT 1 FROM source_registry WHERE source_key = 'thurplus-stoerungen');

-- Stadtwerke Gossau: the one-off "Aktuelle Störungsmeldung" post was deleted
-- (HTTP 404) and no outage list replaced it. Polling the homepage would only
-- queue unverified admin items, so the source is switched off; the operator
-- page links the homepage.
UPDATE source_registry
SET source_category = 'discovery_only',
    url = 'https://sw-gossau.ch/',
    adapter_config_json = '{"language":"de","status_mode":"homepage_discovery","utility_filter":"electricity_only"}',
    check_interval_minutes = 60,
    enabled = 0,
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'sw-gossau-stoerungsmeldung';

INSERT OR IGNORE INTO source_authorities (
  hostname, display_name, authority_kind, trust_level, source_registry_id
)
SELECT
  LOWER(REPLACE(
    CASE
      WHEN INSTR(SUBSTR(url, INSTR(url, '//') + 2), '/') > 0
      THEN SUBSTR(
        SUBSTR(url, INSTR(url, '//') + 2),
        1,
        INSTR(SUBSTR(url, INSTR(url, '//') + 2), '/') - 1
      )
      ELSE SUBSTR(url, INSTR(url, '//') + 2)
    END,
    'www.',
    ''
  )),
  operator_name,
  'operator',
  'official',
  id
FROM source_registry
WHERE source_key IN (
  'aim-mendrisio-interruzioni',
  'age-chiasso-interruzioni',
  'ewd-davos-netzzustand'
);
