-- AIL (Lugano) publishes announced interruptions with start, end, municipality
-- and sector as "Comunicati di servizio" on /privati.html; the news page used
-- so far never yielded a single item. The structured adapter keys on
-- source_key 'ail-homepage' and keeps the electricity sector only.
UPDATE source_registry
SET url = 'https://www.ail.ch/privati.html',
    source_category = 'live_status',
    adapter_config_json = '{"language":"it","status_mode":"ail_comunicati","utility_filter":"electricity_only","no_outage_terms":["nessun guasto","nessuna interruzione"]}',
    check_interval_minutes = 30,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'ail-homepage';
