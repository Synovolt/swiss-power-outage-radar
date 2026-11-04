# Datenpipeline v2: Betreiberdaten

Stand: 4. November 2026. Dieses Dokument beschreibt, warum die Betreiberdaten neu aufgebaut wurden, wie die Pipeline jetzt funktioniert und wie die Historie migriert wird.

## Befund (Prod-Daten vom 4. November 2026)

Rund 95 % der öffentlichen Meldungen stammen von sechs Betreiberquellen (BKW 484, Romande Energie 213, SES 54, ewl 24, EBL 12, Primeo 7). Ihre Qualität war aus strukturellen Gründen schlecht, nicht wegen einzelner Parserfehler:

| Problem | Ausmass | Ursache |
| --- | --- | --- |
| Falsches «erstmals gesehen» | 442 Ereignisse (35 %), davon 358 öffentlich | `alert_items` wurden per Hash aus Titel + URL dedupliziert. «Stromausfall in Hasliberg» von BKW im Oktober wurde dem gleichnamigen Eintrag vom September zugeordnet und erbte dessen Datum. 191 Alert-Items hängen an mehreren Ereignissen. |
| Duplikate | 380 Paare (gleicher Betreiber, Ort, Art, Beginn innert 6 h) | Die Identität einer Beobachtung war ein Hash aus abgeleitetem Text (Titel, Ort, Trafo-Namensliste). Jede Änderung der Trafo-Menge oder ein Geocoding-Timeout erzeugte eine neue Beobachtung und über das 48-h-Fuzzy-Matching oft ein neues Ereignis. |
| Wiederholungen auf alte Ereignisse gefaltet | 18 BKW-Ereignisse mit über 2 Tagen «Dauer» | Der Beobachtungs-Hash enthielt kein Datum. Fiel derselbe Trafo Wochen später erneut aus, war es «dieselbe» Beobachtung und verlängerte das alte Ereignis. |
| Kein Beginn | 37,5 % der öffentlichen Meldungen, bei BKW 270 von 484 | Ungeplante BKW-Ausfälle haben keine Startzeit. Die erste Sichtung wurde nicht als Messgrösse geführt. |
| Keine Dauer | 57 % der abgeschlossenen Meldungen | Folge aus fehlendem Beginn. |
| «unbekanntem Ort» | wiederkehrend | Jede Abfrage geocodierte jeden Cluster live bei geo.admin (1,5 s Timeout, ohne Cache). |
| Quellen fallen aus | EKZ, ewz, Groupe E, SAK, Regionalwerke Baden mit «Too many subrequests»; rund jeder dritte Lauf mit Fehler | Das Live-Geocoding verbrauchte das 50-Subrequest-Budget des Free Plans, bevor spätere Quellen an der Reihe waren. |
| Keine Stromausfälle | alle 12 öffentlichen EBL-Meldungen | Fernwärme- und Wärmeversorgungs-Unterbrüche liefen als «geplanter Stromunterbruch» durch. |
| Offizielle Meldungen versteckt | 21 von 28 Primeo- und 5 von 7 SAK-Ausfällen | Ein «behoben»-Eintrag neben dem «aktiv»-Eintrag galt als `contradictory_evidence`. Ortstexte wie «Behobener Stromausfall in Seewen» kamen dazu. |
| Verlorene Historie | geplante Primeo-Arbeiten | Der Adapter verwarf die `done`-Liste mit Status `PLANNED`. |

## Prinzipien

1. **Die Identität kommt vom Betreiber.** BKW-Trafonummer, Romande- und SAK-UUID, Primeo Titel + angekündigter Start. Nie aus abgeleitetem Text.
2. **Ein Betreiber-Feed ist eine Momentaufnahme.** Beginn und Ende werden aus vollständigen Abfragen gemessen: Ein Eintrag beginnt spätestens bei der ersten Sichtung und frühestens nach der letzten Abfrage ohne ihn. Er endet frühestens bei der letzten Sichtung und spätestens bei der ersten vollständigen Abfrage ohne ihn.
3. **Keine erfundene Präzision.** Was der Betreiber meldet, ist exakt (`reported`). Was gemessen wird, ist ein Fenster (`inferred`). Unbekanntes bleibt unbekannt.
4. **Rohdaten aufbewahren, alles andere ableiten.** Jede neue Payload liegt in R2. Records und Ereignisse lassen sich jederzeit mit verbessertem Code neu berechnen.
5. **Ein Code-Pfad.** Cron, Neuaufbau und Tests verwenden dieselben Funktionen.

## Architektur

```
Betreiber-API / HTML
      │  1 Request pro Quelle und Lauf
      ▼
R2  raw/<source_key>/<datum>/<zeit>.txt      nur wenn sich die Payload geändert hat
      │
      ▼
source_polls          eine Zeile pro Abfrage: ok, Parserstatus, Anzahl, Payload-Hash
      │
      ▼
source_records        ein Eintrag pro Betreiber-Item (Trafo, UUID …)
      │                first_seen, last_seen, first_missing, prev_absent, gemeldete Zeiten,
      │                Koordinaten, Gemeinde (über geo_point_cache)
      ▼
outage_events         origin = 'operator': deterministisch aus den Records abgeleitet
  + publication_decisions, event_public_locations
      │
      ▼
public_events         unveränderte Projektion (src/public-projection.ts)
```

| Modul | Aufgabe |
| --- | --- |
| `src/operator-records.ts` | Reine Extraktion pro Betreiber (ohne Netzwerk), Spartenfilter, Identitäten |
| `src/incidents.ts` | Gruppierung von Records zu einem Ereignis, Zeitfenster, Zusammenfassung |
| `src/operator-ingest.ts` | Abfrage, Archiv, Record-Updates, Zuordnung, Schreiben der Ereignisse |
| `src/geo-cache.ts` | Reverse Geocoding mit dauerhaftem Cache und Budget pro Lauf |
| `scripts/rebuild-operator-history.mts` | Neuaufbau der Historie aus einem Prod-Dump |
| `scripts/data-quality-report.mts` | Qualitätskennzahlen, optional nach lokaler Projektion |

### Gruppierung

Zwei Records gehören zum selben Ereignis, wenn sie von derselben Quelle stammen, dieselbe Art haben (geplant/ungeplant), höchstens 2,5 km auseinanderliegen (ohne Koordinaten: gleiche Gemeinde) und zeitlich zusammenhängen:

- geplant: angekündigte Starts innert 60 Minuten und überlappende Fenster
- ungeplant: Beginn innert 6 Stunden und überlappende Zeiträume (30 Minuten Toleranz)

Ein Trafo, der nach mehr als 45 Minuten Pause wieder ausfällt, ist eine neue Episode und damit ein neues Ereignis. Verbindet ein neuer Record zwei bestehende Ereignisse, werden sie zusammengeführt. Das ältere bleibt, das andere erhält `merged_into_event_id` und leitet per 301 weiter.

### Zeitableitung

| Feld | Quelle |
| --- | --- |
| `started_at_estimate` | gemeldeter Start, sonst leer |
| `first_seen_at` | erste Sichtung (öffentlich «≤ Zeitpunkt», «erstmals gemeldet») |
| `start_earliest_at` | letzte vollständige Abfrage ohne den Eintrag |
| `resolved_at_estimate` | gemeldetes tatsächliches Ende, oder angekündigtes Ende, wenn der Eintrag innert ±20 Minuten darum verschwand |
| `resolution_earliest_at` / `resolution_latest_at` | letzte Sichtung / erste vollständige Abfrage ohne den Eintrag |
| `duration_minutes` | exakt, wenn Start und Ende gemeldet sind; sonst Mitte Endfenster minus Mitte Startfenster (`duration_is_estimate`) |

Eine fehlgeschlagene oder unvollständige Abfrage beendet nie einen Eintrag.

### Veröffentlichung

Ein Betreiber-Ereignis ist öffentlich, sobald sein Ort bekannt ist (Gemeinde aus Koordinaten oder Ortsangabe des Betreibers). Vertrauen ist immer `official`, Quelle ist die Betreiberseite. Die Zusammenfassung ist deterministisch, etwa «BKW kündigt einen geplanten Stromunterbruch in Gerzensee an: 4. November 2026, 13:00–17:00 Uhr. 4 Trafostationen betroffen.»

Betreiber-Ereignisse durchlaufen nicht mehr KI-Klassifikation, Kandidaten, Facts, Fuzzy-Matching, Exa-Recherche, Merge-Vorschläge oder Mailversand. Die Medienpipeline (Google Alerts) bleibt unverändert und getrennt (`origin = 'media'`).

### Free-Tier-Budget

- Externe Requests pro Lauf: höchstens 20 Quellen + 10 neue Koordinaten + 3 Alert-Feeds. Jede Trafo-Koordinate wird nur einmal im Leben geocodiert.
- D1-Schreibzugriffe: Ein unverändert gelisteter Record kostet einen Anteil an einem gemeinsamen `UPDATE … WHERE id IN (…)`. Ereignisse werden nur bei echter Änderung geschrieben, «noch aktiv» höchstens stündlich.
- R2: nur geänderte Payloads (3–50 KB).

## Historie neu aufbauen

Das Skript rekonstruiert die Records aus den gespeicherten Beobachtungen (inklusive abgeschnittener Payloads) und den Präsenzdaten des alten Crons. Bestehende öffentliche Ereignis-IDs bleiben erhalten (SEO-URLs). Duplikate werden zusammengeführt und leiten weiter.

Bekannte Grenzen der Altdaten:

- Wo der alte Hash Wiederholungen auf ein altes Ereignis gefaltet hat, ist nur die erste Episode sicher. Ihr Ende wird als unbekannt markiert (`merged_episodes_suspected`), spätere Episoden sind nicht rekonstruierbar.
- Das Endfenster stammt aus der Präsenz auf Ereignisebene. Bei Ereignissen mit mehreren Trafos ist es für einzelne Trafos ungenauer.
- Das Startfenster alter Records ist «erste Sichtung minus Abfrageintervall» (Flag `backfill`).

### Ablauf

```bash
# 1. Prod exportieren und lokal laden
CLOUDFLARE_ACCOUNT_ID=<account> npx wrangler d1 export swiss-power-outage-radar --remote --output prod.sql
node -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');new DatabaseSync('prod.db').exec(fs.readFileSync('prod.sql','utf8'))"

# 2. Neu aufbauen (geocodiert fehlende Koordinaten lokal über geo.admin)
npx vite-node scripts/rebuild-operator-history.mts -- --db prod.db --geo geo.json --out rebuild.sql --fetch-geo

# 3. Ergebnis prüfen: Projektion lokal rechnen, Kennzahlen vergleichen
npx vite-node scripts/data-quality-report.mts -- --db prod.db --project
```

Für Produktion: Migrationen anwenden, `rebuild.sql` einspielen, deployen und die Projektion vollständig neu aufbauen (siehe README, Abschnitt Deploy). Zwischen Export und Deploy darf der alte Cron keine neuen Betreiber-Ereignisse anlegen. Am einfachsten Export, Neuaufbau, Einspielen und Deploy direkt hintereinander ausführen.
