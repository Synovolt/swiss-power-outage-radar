-- Coverage gaps, wave 1 (docs/analysis/2026-11-05-meldungsluecken.md).
--
-- 1. Item adapters for operators that publish interruptions the generic
--    parser could not use: IWB (Basel planned works per street), Energie
--    Kreuzlingen (accordions), CKW ("Letzte Störung" box) and WWZ (outage
--    blocks). Their failure counters restart with the new adapter.
-- 2. Repower's "Vergangene Störungen" table becomes its own source: the map
--    source reads only the live warning flags (one request per source).
-- 3. Registry fixes: SIL pointed to a parked domain, Werke am Zürichsee moved
--    its page. Pages that never list an interruption (checked 2026-11-05) are
--    watched every six hours instead of every 15–30 minutes, which pays for
--    the new sources in the free-tier subrequest budget.

UPDATE source_registry
SET source_category = 'live_status',
    url = 'https://www.iwb.ch/servicecenter/unterbrueche-stoerungen/unterbrueche',
    check_interval_minutes = 30,
    adapter_config_json = '{"language":"de","status_mode":"iwb_unterbrueche_table","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}',
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'iwb-unterbrueche';

UPDATE source_registry
SET source_category = 'live_status',
    url = 'https://energiekreuzlingen.ch/services/stoerungen',
    check_interval_minutes = 30,
    adapter_config_json = '{"language":"de","status_mode":"kreuzlingen_accordion","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}',
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'energie-kreuzlingen-stoerungen';

UPDATE source_registry
SET source_category = 'live_status',
    url = 'https://www.ckw.ch/kontakt/stoerungen',
    check_interval_minutes = 15,
    adapter_config_json = '{"language":"de","status_mode":"ckw_stromnetz_box","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}',
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'ckw-stoerungen';

UPDATE source_registry
SET source_category = 'live_status',
    url = 'https://www.wwz.ch/de/stoerungen',
    check_interval_minutes = 15,
    adapter_config_json = '{"language":"de","status_mode":"wwz_outage_blocks","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}',
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'wwz-stoerungen';

INSERT INTO source_registry (
  source_key, operator_name, source_type, source_category, url, area_text, trust_level,
  check_interval_minutes, priority, adapter_config_json, firecrawl_enabled, health_status
) VALUES ('repower-vergangene-stoerungen', 'Repower', 'html', 'news_feed', 'https://www.repower.com/ch/kundencenter/stoerungen-stromausfaelle', 'Repower Netzgebiet in Graubünden und angrenzenden Regionen', 'official', 60, 60, '{"language":"de","status_mode":"repower_vergangene_stoerungen","utility_filter":"electricity_only"}', 0, 'unknown')
ON CONFLICT(source_key) DO UPDATE SET
  source_category = excluded.source_category,
  url = excluded.url,
  check_interval_minutes = excluded.check_interval_minutes,
  priority = excluded.priority,
  adapter_config_json = excluded.adapter_config_json,
  updated_at = CURRENT_TIMESTAMP;

UPDATE source_registry
SET source_category = 'discovery_only',
    url = 'https://www.lausanne.ch/sil',
    check_interval_minutes = 360,
    adapter_config_json = '{"language":"fr","status_mode":"homepage_discovery","utility_filter":"electricity_only","no_outage_terms":["aucune panne","pas de panne","aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}',
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'sil-lausanne';

UPDATE source_registry
SET source_category = 'live_status',
    url = 'https://werkezuerichsee.ch/kundenservice/aktuelle-stoerungen',
    check_interval_minutes = 30,
    adapter_config_json = '{"language":"de","status_mode":"current_page","utility_filter":"electricity_only","no_outage_terms":["aktuell gibt es keine störungen","aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}',
    last_error = NULL,
    consecutive_failures = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE source_key = 'werke-zuerichsee-stoerungsmeldung';

UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"fr","status_mode":"news_feed","utility_filter":"electricity_only","no_outage_terms":["aucune panne","pas de panne","aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'sig-actualites';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"current_page","utility_filter":"electricity_only","no_outage_terms":["aucune panne","pas de panne","aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'groupe-e-pannenhilfe';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"fr","status_mode":"homepage_discovery","utility_filter":"electricity_only","no_outage_terms":["aucune panne","pas de panne","aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'oiken-homepage';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"fr","status_mode":"news_feed","utility_filter":"electricity_only","no_outage_terms":["aucune panne","pas de panne","aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'viteos-actualites';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"current_page","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'sgsw-stoerungen';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"regional_status","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'ebs-stoerungen';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"current_page","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'ekz-stoerungen';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"planned_and_current","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'energie-uster-unterbrueche';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"homepage_discovery","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'eks-homepage';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"news_feed","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'tbgs-news';
UPDATE source_registry SET source_category = 'discovery_only', check_interval_minutes = 360, adapter_config_json = '{"language":"de","status_mode":"news_feed","utility_filter":"electricity_only","no_outage_terms":["aktuell sind keine störungen bekannt","aktuell sind keine stoerungen bekannt","keine störungsmeldungen","keine stoerungsmeldungen","keine einträge vorhanden","keine eintraege vorhanden","aktuell liegen keine störungsmeldungen vor","aktuell liegen keine stoerungsmeldungen vor","momentan sind keine netzstörungen bekannt","momentan sind keine netzstoerungen bekannt"]}', updated_at = CURRENT_TIMESTAMP WHERE source_key = 'ew-urnaesch-stoerungen';
