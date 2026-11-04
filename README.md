# Swiss Power Outage Radar

Schlanker Cloudflare-MVP: ein Cron-Worker prüft alle 15 Minuten direkte Netzbetreiberquellen aus der `source_registry` und nutzt Google Alerts nur noch als Discovery-Quelle. Alle Funde werden als unveränderliche `source_observations` gespeichert und erst danach in die Pipeline aus `alert_items`, `outage_candidates`, `outage_facts`, Snapshots, OpenPLZ/Geo-Erkennung, Exa-Recherche, Event-Merging und Quality Gates eingespeist.

Ein öffentliches `outage_event` entsteht automatisch nur, wenn mindestens eine offizielle Netzbetreiber-/Behördenquelle vorliegt oder mindestens zwei unabhängige glaubwürdige Quellen dasselbe Ereignis belegen. Alles andere bleibt Kandidat, Review-Fall oder nicht öffentliche Quellenbeobachtung. Relevante Quellen werden in einem Browser-Run-Aufruf als Markdown und verlustfreier Full-Page-PNG-Screenshot in R2 gesichert. Öffentliche Screenshots werden über `/api/public/evidence/:snapshotId.png` nur so lange ausgeliefert, wie das zugehörige Ereignis veröffentlicht ist.

## Öffentliche Übersicht und pSEO

Die Übersicht zeigt Art, Status, Beginn, Ende, Dauer, Ursache und betroffene Region und kann nach Ort, Art und Status gefiltert werden. Zukünftige geplante Unterbrüche werden nach ihrem tatsächlichen Starttermin angezeigt. Öffentliche Detailseiten verwenden kanonische URLs wie `/stromausfall/zuerich-42`, serverseitig auslesbare Inhalte, individuelle Titel und Beschreibungen, Breadcrumb- und Event-JSON-LD sowie eine dynamische Sitemap.

Ungeplante, noch aktive Ereignisse werden inkrementell aktualisiert: frühestens alle sechs Stunden, höchstens ein Ereignis pro Cron-Lauf und höchstens acht Recherchen pro Tag. Quellenabfragen, Geocoding und öffentliche Antworten sind zusätzlich gecacht.

## Öffentliche Projektion, Statistik und Orts-Seiten

Der öffentliche Zustand eines Ereignisses (Status, Beginn, Ende, Vertrauen, Kanton, Orte, Betreiber) wird genau an einer Stelle berechnet: `toPublicFeedItem()` in `src/publication.ts`. `src/public-projection.ts` materialisiert das Ergebnis in `public_events` und `public_event_places` (Migration `0020_public_projection.sql`). Alle öffentlichen Seiten, die APIs, die Sitemap und die Statistik lesen nur diese Projektion. Dadurch zeigen Startseite, Detailseite, Betreiber-, Orts- und Statistikseiten immer dieselben Zahlen.

- Der Cron findet Kandidaten über indexierte Abfragen «geändert seit Watermark» (Event, Publikationsentscheid, Kartenpunkt) plus die zeitabhängigen Zeilen (bevorstehend/aktiv). Er verarbeitet höchstens 60 Zeilen pro Lauf und schreibt nur echte Änderungen. Ein routinemässiges «weiterhin gelistet» zählt nicht als Änderung: `last_confirmed_active_at` wird höchstens stündlich neu geschrieben.
- Fehlende Kartenpunkte werden mit höchstens 3 geo.admin-Abfragen pro Lauf nachgeholt.
- `src/public-stats.ts` legt den kompakten Such-/Kartenindex, eine kleine «Jetzt»-Teilmenge für die Startseite, die Ortsliste, die Betreiber-Kennzahlen und die nationale Statistik als je eine Zeile in `public_stats_cache` ab. Index, Teilmenge und Ortsliste folgen jeder Änderung. Statistik und Betreiber-Kennzahlen werden höchstens stündlich neu berechnet, und nie im selben Lauf wie der Index (ausser sie sind älter als drei Stunden).
- Geplante Unterbrüche gelten nach Ablauf des angekündigten Zeitfensters als beendet (Ende = angekündigtes Ende), solange die Quelle sie nicht weiter bestätigt.
- Automatisch geschlossene Ausfälle behalten ihr Ende-Zeitfenster (`resolution_earliest_at` = zuletzt bestätigt, `resolution_latest_at` = erste Abfrage ohne Meldung). Die Statistik schätzt die Dauer aus der Mitte dieses Fensters und weist exakte und geschätzte Werte getrennt aus.

Neue öffentliche Seiten (alle vier Sprachen, eigene hreflang, Breadcrumb- und JSON-LD-Daten):

- `/statistik/` (`/fr/statistiques/`, `/it/statistiche/`, `/en/statistics/`): Kennzahlen, Wochenverlauf, Wochentag × Stunde, Vorlauf, Dauer, Betreiber, Kantone, Orte. Serverseitige SVG-Diagramme ohne Client-JavaScript, `Dataset`-JSON-LD.
- `/stromausfall/`: alle Orte nach Kanton.
- `/stromausfall/<ort>-<kanton>`, z. B. `/stromausfall/brugg-ag`: Live-Status, Verlauf, FAQ und Nachbarorte. Der Kanton im Slug trennt gleichnamige Gemeinden (Buchs AG/SG/ZH). Indexiert ab 2 Ereignissen oder einer Meldung in den letzten 90 Tagen.
- `/stromausfall/kanton/<kanton>` mit lokalisierten Slugs (`/fr/panne-de-courant/canton/vaud`).

Die Startseite rendert die aktuelle Liste serverseitig (sichtbar, crawlbar) und bettet nur die «Jetzt»-Teilmenge mit vorberechneten Zählern ein. Den vollständigen Index (`/api/public/index.json`, 365 Tage) lädt der Browser im Leerlauf oder sobald gesucht bzw. die Ansicht gewechselt wird. Suche und Filter laufen dann über alle öffentlichen Meldungen, nicht nur über die erste Seite.

## Cloudflare Free Tier

Dieses Projekt bindet weder Durable Objects noch Cloudflare Workflows. Der frühere Workflow-Wrapper wurde entfernt; Cron und manueller Lauf rufen den idempotenten Worker direkt auf. Ein atomarer D1-Lock verhindert überlappende Läufe. Damit kann dieses Projekt keine Durable-Objects-Requests mehr erzeugen. Bei einer weiteren Durable-Objects-Warnung muss im Cloudflare-Dashboard nach anderen Workern, alten Deployments oder Apps im selben Account gesucht werden.

Budget-Regeln für öffentliche Seiten (Free Plan: 10 ms CPU pro Request, 50 externe Subrequests pro Aufruf, D1 5 Mio. gelesene und 100 000 geschriebene Zeilen pro Tag):

- Teure Lesepfade gehen über eine vorberechnete Zeile in \`public_stats_cache\`: Startseite und Index, Statistik, Ortsliste und Betreiber-Kennzahlen. Ein Cache-Miss liest dann eine Zeile statt hunderter.
- Orts- und Kantonsseiten lesen nur indexierte Ausschnitte (\`place_slug\`, \`canton\`). Die Betreiber-Übersicht und die Sitemap lesen Spalten statt JSON, damit kein Parsing von Hunderten Items im 10-ms-Budget nötig ist.
- Antworten werden per Cache API an der Edge gecacht (60 s bis 10 min, \`stale-while-revalidate\`). \`PUBLIC_CACHE_VERSION\` in \`src/index.ts\` hochzählen, wenn sich Markup ändert.
- Der Cron schreibt nur geänderte Projektionszeilen. Zeitabhängige Zeilen werden gelesen, aber nur bei Änderung geschrieben. Der Orphan-Sweep läuft stündlich.

## Setup

```bash
npm install
npm run typecheck
npm test
```

## D1 erstellen

```bash
npx wrangler d1 create swiss-power-outage-radar
```

Die ausgegebene `database_id` in `wrangler.jsonc` unter `d1_databases[0].database_id` eintragen.

## Migration anwenden

Lokal:

```bash
npm run db:migrate:local
```

Remote:

```bash
npm run db:migrate:remote
```

## Secrets setzen

Keine Secrets, privaten Feed-URLs oder Mailvariablen ins Repo committen. `keep_vars: true` erhält die bereits im Cloudflare-Dashboard gesetzten Variablen bei Deployments. Für Produktion werden diese Secrets benötigt:

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put EXA_API_KEY
```

Optional für priorisierte dynamische Betreiberseiten und Webhooks:

```bash
npx wrangler secret put FIRECRAWL_API_KEY
npx wrangler secret put FIRECRAWL_WEBHOOK_SECRET
```

`FIRECRAWL_API_KEY` und `FIRECRAWL_WEBHOOK_SECRET` sind optional. Ohne Firecrawl-Key laufen alle JSON/API-, RSS-, HTML- und Google-Alert-Adapter normal weiter. Firecrawl wird nur für priorisierte schwierige HTML-Quellen mit `firecrawl_enabled = 1` und hoher `priority` genutzt.

Lokale Entwicklung kann mit einer nicht committed `.dev.vars` arbeiten:

```dotenv
ALERT_FEED_DE="http://127.0.0.1:8788/mock-feed.xml"
ALERT_FEED_FR="http://127.0.0.1:8788/mock-feed.xml"
ALERT_FEED_IT="http://127.0.0.1:8788/mock-feed.xml"
ADMIN_TOKEN="local-admin-token"
NOTIFY_EMAIL="pw@bimex.ch"
FROM_EMAIL="alert@outage.ch"
AI_MOCK_MODE="true"
EMAIL_MOCK_MODE="true"
BROWSER_MOCK_MODE="true"
EXA_MOCK_MODE="true"
```

`AI_MOCK_MODE`, `EMAIL_MOCK_MODE`, `BROWSER_MOCK_MODE` und `EXA_MOCK_MODE` sind nur für lokale Smoke-Tests gedacht. In Produktion weglassen.

## Quellenpipeline

Die kanonische Quellenliste steht in D1 unter `source_registry`. Die Migration `0009_source_registry_observations_qa.sql` legt eine kleine Startauswahl an, `0010_expand_source_registry.sql` erweitert sie um priorisierte Schweizer EVU-Quellen und Alertswiss.

- BKW: `https://outage.bkw.ch/`
- ewz: `https://www.ewz.ch/de/services/stoerungen.html`
- CKW: `https://www.ckw.ch/kontakt/stoerungen`
- Energie Wasser Bern: `https://www.ewb.ch/stoerungsmeldungen/`
- Repower: `https://www.repower.com/ch/kundencenter/stoerungen-stromausfaelle`

Die erweiterte Seed-Liste wird zusätzlich in `src/source-registry-seeds.ts` gepflegt. Sie enthält die im Projekt priorisierten Betreiberquellen von BKW, EKZ, Romande Energie, Groupe E, ewz, SAK, CKW, AEW, SIG, IWB, Primeo, EBL, AIL, SIL Lausanne, Repower, ewb, WWZ, ewl Luzern, ESB Biel, Stadtwerk Winterthur, St.Galler Stadtwerke, Evolon, EWS, ebs, Energie Uster, IBB Brugg, Regionalwerke Baden, ibw Wohlen, Genossenschaft Elektra, Werke am Zürichsee, Energie Kreuzlingen, EW Neuenhof, EW Urnäsch, Elektra Fislisbach, TB Flawil, TBGN, TBGS, Stadtwerke Gossau, Technische Betriebe Wil, Thurplus, Viteos, OIKEN, EKS, SES, Energie Thun, Regio Energie Solothurn und Alertswiss. Alertswiss wird über den öffentlichen JSON-Feed nur auf strombezogene Warnungen gefiltert. Die Migration `0017_more_operators_alertswiss_json.sql` schreibt diese Quellen nach D1. Betreiberseiten zeigen wo verfügbar einen ElCom-H4-Snapshot (kein individueller Tarif).

Wichtige Felder:

- `source_type`: `json_api`, `rss`, `html` oder `google_alert`
- `source_category`: `live_status`, `outage_map`, `news_feed`, `discovery_only` oder `needs_adapter`
- `url`: direkte Quelle
- `area_text`: Versorgungsgebiet
- `trust_level`: `official`, `credible`, `aggregator` oder `unknown`
- `check_interval_minutes`: gewünschter Polling-Abstand
- `priority`: höhere Werte werden zuerst geprüft
- `adapter_config_json`: Parser-Hinweise wie `no_outage_terms`, `historical_terms`, `json_path`
- `firecrawl_enabled`: nur für schwierige priorisierte HTML-Seiten aktivieren
- `health_status`, `last_checked_at`, `last_success_at`, `last_error`, `consecutive_failures`: Adapter-Freshness und Health

Polling-Regel:

- Live- und Kartenquellen: 10 bis 15 Minuten
- Newsfeeds und Discovery-Quellen: 30 Minuten
- Google Alerts bleiben Discovery und werden nicht als Wahrheit behandelt

Bei generischen HTML-Seiten gilt ein Sicherheitsmodus: negative Statusmeldungen wie "keine Störung" werden als erfolgreiche `irrelevant`-Observation gespeichert. Nicht-negative Treffer aus Karten-, News-, Multi-Utility- oder nicht verifizierten Vollseiten werden dagegen mit `parser_needs_adapter` gestoppt, bis ein item-spezifischer Adapter oder stabiler JSON/API-Endpunkt vorhanden ist. Dadurch werden Archiv-, Navigations- und FAQ-Texte nicht als Stromausfall-Kandidaten veröffentlicht.

Die Adapter schreiben immutable `source_observations` mit `canonical_status`:

- `planned`: geplanter Stromunterbruch
- `unplanned`: akuter ungeplanter Ausfall
- `resolved`: Aufhebung/Behebung eines bestehenden Ereignisses
- `historical`: Archiv, Rückblick oder alte Meldung
- `irrelevant`: keine Störung oder nicht stromrelevant
- `unverified`: potenziell relevant, aber nicht belastbar genug

Nur `planned`, `unplanned` und `resolved` werden automatisch in Event-Akten weitergeführt. `historical`, `irrelevant` und `unverified` bleiben nicht öffentlich.

## Quality Gates

Die Pipeline trennt Datenqualität in zwei Stufen:

1. `outage_candidates` und `outage_facts` prüfen, ob ein Fund grundsätzlich ein Schweizer Stromversorgungsereignis mit Ort, Evidenz und Belegauszug ist.
2. Das Publication Gate veröffentlicht nur offizielle Quellen oder Ereignisse mit mindestens zwei unabhängigen glaubwürdigen Quellen. Ein einzelner Google-Alert- oder Medienfund bleibt verborgen.

Jeder öffentliche Fakt in `outage_facts` speichert Quelle, Belegauszug, Zeitpunkt und `extractor_version`. Betreiber-Observations ergänzen zusätzlich `source_observation_id` und `observed_at`.

Updates und Aufhebungen werden anhand von Betreiber, Ort, Zeitfenster und Evidenz in dasselbe Event gemerged. Jede Änderung schreibt einen Eintrag in `outage_event_versions`.

## Firecrawl

Firecrawl ist optional und soll wegen des Free-Limits von 1'000 Credits/Monat sparsam bleiben:

- Nur Quellen mit `firecrawl_enabled = 1` und hoher Priorität verwenden Firecrawl als Fallback.
- Normale HTML-, RSS- und JSON/API-Fetches kosten keine Firecrawl-Credits.
- `qa_metrics.metric_name = 'firecrawl_credits_estimated'` hält die geschätzten Scrape-Aufrufe gegen das Monatslimit.

Webhook:

```bash
curl -X POST https://outage.ch/api/firecrawl/webhook \
  -H "x-firecrawl-webhook-secret: <FIRECRAWL_WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://outage.bkw.ch/","title":"BKW Stromausfall","markdown":"Stromausfall in Belp behoben."}'
```

Alternativ akzeptiert der Webhook den bestehenden Admin-Bearer. Der Webhook schreibt keine Sonderarchitektur, sondern dieselben `source_observations` wie die Polling-Adapter.

## QA-Kennzahlen

`qa_metrics` speichert messbare Betriebs- und Datenqualitätswerte. Aktuell werden pro Workflow-Lauf geschrieben:

- `source_coverage_checked`: Anzahl geprüfter Registry-Quellen
- `adapter_freshness_success_rate`: Anteil erfolgreicher Adapterchecks
- `firecrawl_credits_estimated`: geschätzte Firecrawl-Scrapes gegen 1'000 Credits/Monat

Weitere Kennzahlen können additiv ergänzt werden:

- Precision: Anteil veröffentlichter Events, die nach Review korrekt waren
- Detection-Latenz: Differenz zwischen `started_at_estimate`/Quellzeit und `first_seen_at`
- Quellenabdeckung: aktive Registry-Quellen nach Versorgungsgebiet
- Duplikate: offene Merge-Suggestions und tatsächliche Merges
- False Merges/Splits: Admin-Markierungen auf `event_merge_suggestions`
- Ortsgenauigkeit: `event_places`-Granularität und Confidence

## R2 und Browser Run

Snapshots werden in R2 gespeichert. Einmalig:

```bash
npx wrangler r2 bucket create outage-source-snapshots
```

Der Worker bindet den Bucket als `SNAPSHOTS`. Cloudflare Browser Run ist als Binding `BROWSER` konfiguriert und nutzt die Quick Action `markdown`. Vollständige Markdown-Snapshots werden nicht öffentlich angezeigt.

## Cloudflare Email Sending

Der Worker nutzt das `send_email` Binding `EMAIL`. Cloudflare Email Sending muss fuer `alert@outage.ch` eingerichtet und verifiziert sein. Die Binding-Konfiguration beschränkt Sender und Empfänger auf:

- Sender: `alert@outage.ch`
- Empfänger: `pw@bimex.ch`

## Lokal testen

Fixture-Server starten:

```bash
npx http-server fixtures -p 8788
```

In einem zweiten Terminal:

```bash
npm run db:migrate:local
npm run dev
```

Manuellen Lauf starten:

```bash
curl -X POST http://127.0.0.1:8787/run \
  -H "Authorization: Bearer local-admin-token"
```

Status prüfen:

```bash
curl http://127.0.0.1:8787/status \
  -H "Authorization: Bearer local-admin-token"

curl http://127.0.0.1:8787/recent \
  -H "Authorization: Bearer local-admin-token"
```

Die öffentliche Statusseite ist unter `http://127.0.0.1:8787/` erreichbar und zeigt keine Feed-URLs oder Secrets.

Live-Reality-Check aller Registry-Seeds:

```bash
npx tsx scripts/reality-check-sources.ts
```

Der Check speichert pro Quelle Rohdaten, HTTP-Metadaten, Adapterausgabe und eine `summary.json` unter `artifacts/source-reality-check/<run-id>/`. Firecrawl wird dabei nur genutzt, wenn lokal `FIRECRAWL_API_KEY` gesetzt ist und die Quelle entsprechend priorisiert wurde.

## Deploy

```bash
npm run db:migrate:remote
npm run deploy
```

Nach einem Deploy, der die Projektion einführt oder ihre Logik ändert, diese sofort vollständig neu aufbauen. Der Aufruf ist paginiert: mit dem zurückgegebenen `projection.nextBeforeId` als `before_id` wiederholen, bis er `null` ist. Bis dahin liefern Detailseite und `/api/public/events` über einen Fallback weiterhin Daten.

```bash
curl -X POST https://outage.ch/admin/projection/rebuild   -H "Authorization: Bearer <ADMIN_TOKEN>"   -H "Content-Type: application/json"   -d '{"full":true,"limit":80}'
```

Danach einmal ohne `full` und mit `"force_stats":true` aufrufen. Das setzt die Watermark für die inkrementellen Läufe und berechnet die Statistik.

Nach dem Deployment:

```bash
curl -X POST https://<worker-url>/run \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Danach die Worker-URL öffnen und die Statusseite prüfen. Der Cron Trigger `*/15 * * * *` ist in `wrangler.jsonc` konfiguriert.

## Endpunkte

- `GET /` Radar mit Karte, serverseitig gerenderter Liste und eingebettetem Index
- `GET /stromausfall/<ort>-<id>` öffentliche Event-Akte; `/events/:id` leitet dorthin um
- `GET /statistik/`, `/stromausfall/`, `/stromausfall/<ort>`, `/stromausfall/kanton/<kanton>` Datenseiten (siehe oben)
- `GET /api/public/index.json` kompakter Index aller öffentlichen Meldungen (365 Tage) für Suche und Karte
- `GET /api/public/stats.json` nationale Statistik als JSON (CORS offen)
- `GET /api/public/events` paginierter Feed (`limit`, `before`)
- `GET /admin/status-page` geschützte interne Betriebsübersicht
- `POST /admin/projection/rebuild` geschützter, begrenzter Neuaufbau der öffentlichen Projektion
- `GET /status` geschützter JSON-Debugstatus
- `POST /run` geschützter manueller Workflow-Start
- `GET /recent` geschützte letzte 20 Items
- `POST /api/firecrawl/webhook` optionaler Firecrawl-Monitor-Webhook
- `POST /admin/events/:id/merge` geschütztes Merge von Event `:id` in `target_event_id`
- `POST /admin/events/:id/dismiss` geschütztes Dismiss eines Events
- `POST /admin/events/:id/corroborate` geschütztes Markieren als `corroborated`
- `POST /admin/events/:id/research` geschützte manuelle Recherche via Exa, kleine Result-Sets, Snapshots in R2, vorsichtige AI-Anreicherung
- `POST /admin/geo/sync-openplz` geschützter, limitierter OpenPLZ-Import für einen Kanton in den lokalen Geo-Katalog
- `POST /admin/geo/backfill-places` geschützter, limitierter Backfill bestehender Quellen in `source_place_mentions` und `event_places`

Geschützte Endpunkte verlangen:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Admin-Action-Beispiele:

```bash
curl -X POST https://outage.ch/admin/events/2/merge \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"target_event_id":1,"admin_note":"Same Wohlen incident"}'

curl -X POST https://outage.ch/admin/events/4/dismiss \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"admin_note":"Only incidental mention"}'

curl -X POST https://outage.ch/admin/events/5/corroborate \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"admin_note":"Manual source check"}'

curl -X POST https://outage.ch/admin/events/1/research \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"admin_note":"Manuelle Zusatzrecherche"}'

curl -X POST https://outage.ch/admin/geo/sync-openplz \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Belp","page_size":10}'

curl -X POST https://outage.ch/admin/geo/sync-openplz \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"canton_key":"2","start_page":1,"max_pages":1,"page_size":5}'

curl -X POST https://outage.ch/admin/geo/backfill-places \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"limit":25}'

curl -X POST https://outage.ch/admin/geo/backfill-places \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"event_id":16,"limit":25}'
```

Der OpenPLZ-Sync ist bewusst klein: `name` synchronisiert gezielt passende Lokalitäten; `canton_key` synchronisiert nur sehr kleine Seiten-Batches. Die normale Alert-Pipeline ruft OpenPLZ nicht live auf, sondern nutzt nur den lokalen D1-Katalog. So bleiben Cron-Läufe stabil und AI-/API-Kosten kontrolliert.

## Bekannte Limitierungen

- Google Alerts ist Discovery, nicht Wahrheit.
- KI-Ergebnis ist nur eine Vorprüfung; offizielle Betreiberquellen und unabhängige Evidenz haben Vorrang.
- Automatische Veröffentlichung bedeutet Quellenregel erfüllt, nicht behördliche Verifikation.
- geo.admin.ch-Ortsnormalisierung ist eine Datenhilfe, kein Pflichtpfad; bei Fehlern läuft der Radar mit lokalem Fallback weiter.
- OpenPLZ-Ortserkennung greift nur, soweit der lokale D1-Ortskatalog bereits synchronisiert ist.
- Kanton-/Bezirk-Treffer werden als Kontext behandelt und nicht als betroffene Orte gezählt.
- Markdown-Snapshots werden intern in R2 gesichert, aber öffentlich nicht vollständig angezeigt.
- Manuelle Exa-Recherche ist eine Vorprüfung, keine offizielle Bestätigung.
- RSS-Parsing ist robust genug für RSS/Atom-Grundfelder, aber kein vollständiger XML-Validator.
