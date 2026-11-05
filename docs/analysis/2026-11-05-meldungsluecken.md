# Meldungslücken in der Schweiz: Analyse und Massnahmen

Stand 5. November 2026. Datenbasis: 863 öffentliche Meldungen seit 30. Juni 2026.

## Kurzfazit

- **Die Hälfte der Bevölkerung ist praktisch nicht abgedeckt.** 52 % der Einwohner leben in Kantonen mit weniger als 2 Meldungen pro 100'000 Einwohner. BE liegt bei 37, VD bei 25. Gar keine Meldungen haben TG, BS, NE, NW, GL, OW und UR. ZH (1,6 Mio.) hat 3 Meldungen, GE (520k) eine.
- **Zwei Betreiber liefern 82 % aller Meldungen**: BKW (480) und Romande Energie (229). Beide haben eine echte API mit Karte.
- **Die Ursachen sind sehr verschieden.** Grob die Hälfte der Lücke kann man selbst schliessen:
  1. **Der Betreiber publiziert, aber wir verwerfen es.** Das gilt für CKW, WWZ, IWB, Energie Kreuzlingen, Repower, IBB Brugg und TBGN.
  2. **Der Worker wird gesperrt.** Bei SES (Tessin) ist das belegt: Geoblocking seit dem 7. Oktober. Bei EWS, TB Wil, Energie Uster, EKS und EW Urnäsch ist es wahrscheinlich.
  3. **Der Betreiber publiziert, ist aber nicht erfasst.** Das gilt für Eli10 (NE), Eniwa (AG), RELL und Sinergy (VS), energieUri, EWN (NW), TB Seon, EW Heiden und die Feuerschaugemeinde Appenzell.
  4. **Der Betreiber publiziert online gar nichts.** Das betrifft EKZ, SIG, Groupe E, OIKEN, Stadtwerk Winterthur, EKS, die St.Galler Stadtwerke und die geplanten Unterbrüche bei SAK. Hier helfen nur Medien, Gemeinden oder eine Datenpartnerschaft.
- **Die günstigsten Hebel nach Wirkung:** SES-Sperre lösen, dann Adapter für IWB, Eli10, Energie Kreuzlingen, CKW und WWZ, dazu die Repower-Tabelle. Alle Schätzungen dazu stehen in Welle 1 unten.

## Methode und D1-Last

Die Analyse sollte das D1-Kontingent nicht belasten. Verwendet wurde:

- **Öffentliche, edge-gecachte Endpunkte** `/api/public/index.json` und `/api/public/stats.json`. Jeder davon liest höchstens eine Zeile aus `public_stats_cache`.
- **D1 direkt**, zwei Abfragen: einmal `source_registry` mit 50 Zeilen, einmal `source_polls` über den Index mit 3 Zeilen. Zusammen sind das **53 gelesene Zeilen** von 5 Mio. pro Tag.
- **Ein R2-Objekt**, die Rohantwort von SES.
- **Sechs Recherche-Agenten parallel**, aufgeteilt in ZH/SH/TG, AG/BS, Ostschweiz/GR, Zentralschweiz, Westschweiz und überregionale Kanäle. Grundlage waren die Websites der Betreiber und die ElCom-Zuordnung Gemeinde → Netzbetreiber (LINDAS-SPARQL, Tarifjahr 2026).
- **Eigene Stichproben** der zentralen Aussagen: IWB (14 Zeilen «Strom»), Eli10 (REST liefert 100 Strom-Events) und Energie Kreuzlingen (41 Einträge).

Die Kantone der Meldungen ohne Kanton (72) wurden über den Betreiber zugeordnet, z.B. SES → TI. Die Einwohnerzahlen sind gerundete BFS-Werte.

**Einschränkung:** Meldungen pro Einwohner sind kein perfektes Mass. Städte mit verkabelten Netzen haben weniger ungeplante Ausfälle als ländliche Freileitungsnetze. Geplante Unterbrüche gibt es aber überall. Ein Unterschied von Faktor 100 und mehr lässt sich damit nicht erklären.

## 1. Wo fehlen Meldungen?

| Kanton | Einw. (Tsd.) | Meldungen | pro 100k | Herkunft heute |
|---|---:|---:|---:|---|
| TG | 300 | 0 | 0 | – |
| BS | 200 | 0 | 0 | – |
| NE | 178 | 0 | 0 | – |
| NW / GL / OW / UR | 45 / 42 / 39 / 38 | 0 | 0 | – |
| ZH | 1620 | 3 | 0,2 | 2 aus Medien, 1 von Primeo (wahrscheinlich Aesch BL, falsch geocodiert) |
| GE | 520 | 1 | 0,2 | Romande Energie (Céligny) |
| SZ | 167 | 1 | 0,6 | Medien |
| AG | 730 | 9 | 1,2 | 8 aus Medien, 1 von AEW |
| SH | 86 | 1 | 1,2 | Medien |
| SG | 535 | 8 | 1,5 | SAK, TB Flawil |
| ZG | 132 | 2 | 1,5 | Medien |
| GR | 205 | 4 | 2,0 | SES (Misox), Medien |
| FR | 345 | 8 | 2,3 | grösstenteils Medien |
| AR / AI | 56 / 17 | 2 / 1 | 3,6 / 5,9 | SAK, ai.ch |
| VS | 365 | 15 | 4,1 | nur Romande Energie (Chablais); Mittel- und Oberwallis fehlen |
| LU | 430 | 18 | 4,2 | ewl (Stadt); CKW liefert 0 |
| BL | 295 | 19 | 6,4 | Primeo, BKW, EBL |
| SO | 285 | 36 | 12,6 | BKW, Primeo |
| TI | 360 | 66 | 18,3 | SES, AIL; SES ist seit 7.10. ausgefallen |
| VD | 850 | 212 | 24,9 | Romande Energie |
| BE | 1070 | 399 | 37,3 | BKW |
| JU | 74 | 55 | 74,3 | BKW |

**Gewichtet nach Bevölkerung** sind die grössten Lücken ZH, AG, GE, SG, TG, BS und NE, dann Zentralschweiz und FR.

**Wie zersplittert die Netze sind** (ElCom 2026): ZH hat 39 Netzbetreiber, AG 95, TG rund 75, SG 67, GR 48 und VS 39. In den Lückenkantonen ist das Netz also auf viele kleine Werke verteilt, nicht auf einen grossen Betreiber mit API wie BKW oder Romande Energie.

## 2. Warum fehlen sie? Ursachen nach Typ

### A. Der Betreiber publiziert, unser Parser verwirft es

| Quelle | Befund | Lösung |
|---|---|---|
| **IWB** (BS, 200k) | `section.incidents-container`: Gemeinde, Strasse, Sparte, Zeitraum. **Heute 14 geplante Strom-Zeilen**, adressgenau (geprüft). Status heute `needs_adapter`. | Tabellen-Adapter, Filter auf Sparte «Strom» |
| **Energie Kreuzlingen** (TG) | Akkordeons «Störungen» und «Geplante Unterbrüche» mit Datum, Dauer und Strassen. Gemischt Strom, Wasser und Gas. Rund 5 geplante Unterbrüche und 1 Störung pro Monat. | Item-Adapter (`span.accordion-date`, `h3.accordion-title`) |
| **CKW** (LU, über 200k Kunden) | Box «Letzte Störung: 01.11.2026, 13.31–13.40, Egolzwil, Schötz, Nebikon, Dagmersellen». Der Negativsatz «keine Netzstörungen» löst `no_current_outage` aus und verschluckt die Meldung. | Eigener Adapter: «Letzte Störung» als behobenes Ereignis übernehmen |
| **WWZ** (ZG) | Je Störung ein `div.outage` mit Gebiet, Beginn, Ende und Service-Label. Beispiel Rotkreuz 23./24.10. Der Negativsatz und Meldungen können gleichzeitig auf der Seite stehen. | Item-Adapter, Filter auf Service «Strom» |
| **Repower** (GR) | Wir lesen nur `GetWarnings`, eine Rot/Grün-Ampel. Die Tabelle «Vergangene Störungen» auf derselben Seite ignorieren wir. Sie enthält Datum, Grund und Orte, 12 Zeilen seit Jahresbeginn 2026. | Tabelle parsen, Zeilen als behobene Ausfälle übernehmen |
| **IBB Brugg** (AG) | JSON-Endpunkt `https://stoerung.ibbrugg.ch` liefert `{unresolved[], resolved[]}`. Der Ausfall vom 01.11. ist uns entgangen. | Quelle auf JSON umstellen |
| **TBGN** (GL) | News-Kategorie «Störungsmeldung». Die Meldung vom 04.07.2026 fehlt bei uns. | Listen-Adapter |
| **Regionalwerke Baden / EW Neuenhof** | TYPO3-Akkordeon. Wenige Meldungen. | Ein gemeinsamer Adapter für beide |
| **ewz** | Die Komponente `ewz-incident-messages` wird aus dem internen System ESIS gespeist. Der generische Treffer liefert keine Ortsangabe. | Item-Adapter. Gewinn klein, die Latenz ist fraglich |

### B. Der Worker wird blockiert

- **SES (TI und Misox), belegt.** Im R2-Rohspeicher liegt statt der Seite die Antwort «Accesso bloccato … non è possibile accedere a questo sito web dalla nazione in cui si trova». SES sperrt also das Herkunftsland der Cloudflare-Egress-IP.
  - Folge: Seit dem 7.10. kommen keine SES-Meldungen mehr. Vorher waren es 1 bis 13 pro Woche, insgesamt 52.
  - Der Parser ist intakt. Von einer Schweizer IP aus passt das Markup.
  - Die Statusmeldung `parser_schema_changed` ist irreführend. Sie sollte als «blocked» erkannt werden.
- **Wahrscheinlich dasselbe Muster** (nicht verifiziert) bei EWS (403), TB Wil (403), Energie Uster (403), EKS (Cloudflare-Challenge) und EW Urnäsch (510). Von normalen IPs aus antworten alle mit 200.
  - Bei Energie Uster, EKS und EW Urnäsch steht auf der Seite ohnehin keine Liste. Die Sperre kostet dort nichts.

### C. Der Betreiber publiziert, ist aber nicht erfasst

| Betreiber | Gebiet | Zugang | Erwartung |
|---|---|---|---|
| **Eli10** | NE: Boudry, Cortaillod, Milvignes, Le Landeron, Bevaix, Bôle (~30k) | `wp-json/wp/v2/ajde_events?event_type_2=34` (34 = Strom). Start, Ende und Adresse stehen im JSON-LD der Detailseite. | ~28 Strom-Unterbrüche in 16 Wochen, also ~80 pro Jahr (REST geprüft) |
| **Eniwa** | Aarau und 14 weitere AG-Gemeinden (~58k) | `eniwa.ch/api/fetch?apiAction=disruptions&apiExtension={current,planned,solved}` | unbekannt, heute leer |
| **RELL** | Leuk, Leukerbad, Turtmanntal (~16k) | `rell.ch/stoerungen/`, Tabelle «Geplante Unterbrüche» | ~1–3 pro Monat (Vermutung) |
| **Sinergy** | Martigny (~24k) | `infos-pannes`, Freitext pro Sparte | gering bis mittel |
| **energieUri** | praktisch ganz UR | RSS `energieuri.ch/feed/` mit Stichwortfilter | 1–3 pro Jahr, aber erste Abdeckung für UR |
| **EWN** | NW | `ewn.ch/kundendienst/stoerungen/`; leer, wenn `.empty-state` angezeigt wird | erste Abdeckung für NW |
| **TB Seon** | Seon | WP-REST, Meldungen vom Okt. und Sep. 2026 | gering |
| **EW Heiden**, **Feuerschaugemeinde Appenzell** | AR, AI | HTML-Listen für geplante und aktuelle Unterbrüche | gering, aber erste Abdeckung für AI |
| **AEW** | 74 AG-Gemeinden direkt | RSS `aew.ch/rss.xml` mit Filter (Stromunterbr\|Störung\|Gewitter) | 2–5 pro Jahr, nur grössere Ereignisse |
| Energie Opfikon, EW Höfe, EnBAG, EWS Reinach, Gruyère Energie | je 10–40k | Statusseite bzw. News | erst beobachten, Adapter nach dem ersten echten Eintrag |

### D. Der Betreiber publiziert online nichts

**EKZ** (131 ZH-Gemeinden, ~650k), **SIG** (ganz GE), **Groupe E** (FR, Teile NE), **OIKEN** (Sion/Sierre), **Stadtwerk Winterthur**, **EKS**, **SH Power**, **St.Galler Stadtwerke**, **IBC Chur**, **EWO**, **ebs** (nur Telekom).

- SAK hat eine Kategorie «Wartung», nutzt sie aber nicht.
- Repower kündigt geplante Unterbrüche laut eigener FAQ per Flugblatt und amtlichen Publikationen an.
- ewz kündigt geplante Unterbrüche per Brief und Türanschlag an.

Diese Gebiete umfassen zusammen rund 2 Mio. Einwohner. Hier hilft kein Adapter, nur Medien, Gemeinden oder eine Datenpartnerschaft.

### E. Fehler in der Registry

- `sil-lausanne` zeigt auf eine **Parkseite** von Infomaniak («Bienvenue sur sil-lausanne.ch»). Darum steht die Quelle auf «healthy», liefert aber 0 Meldungen.
- `werke-zuerichsee-stoerungsmeldung`: Nach einem Relaunch gilt neu `/kundenservice/aktuelle-stoerungen`. Darum steht die Quelle seit dem 24.08. auf `needs_adapter`.
- Genossenschaft Elektra (`elektra-stoerungen`) sitzt in Jegenstorf BE, nicht im Aargau.
- Primeo-Meldung «Aesch» ist als `aesch-zh` geocodiert. Wahrscheinlich ist Aesch BL gemeint.
- Quellen auf `needs_adapter` bzw. `healthy`, deren Seite **nie** eine Liste enthält: SIG, Groupe E, OIKEN, Viteos, SGSW, ebs, EKZ, Energie Uster, TBGS, EW Urnäsch.
  - Ihr Status suggeriert eine Adapter-Lücke, die es nicht gibt.
  - Jede dieser Quellen kostet trotzdem einen Subrequest pro Lauf.

## 3. Massnahmen, priorisiert

Aufwand: S = unter einem halben Tag, M = 1–2 Tage, L = organisatorisch oder länger.

### Welle 1: Quick Wins mit bestehender Architektur

| # | Massnahme | Region | Aufwand | Erwarteter Gewinn |
|---|---|---|---|---|
| 1 | **SES-Geoblock lösen.** Zuerst testen, ob der Abruf über Browser Run oder eine andere Egress-Region durchkommt. Sonst SES um Freigabe bitten, mit dem User-Agent `outage.ch radar (+https://outage.ch/ueber/)`. Zusätzlich den Status `blocked` erkennen statt `parser_schema_changed`. | TI, GR-Misox | S–M | ~20 pro Monat zurück |
| 2 | **IWB-Tabellen-Adapter** | BS | S | 14 geplante Einträge heute sichtbar. BS geht von 0 auf regelmässig. |
| 3 | **Eli10-Adapter** (REST-Liste, JSON-LD nur für neue IDs) | NE | S–M | ~7 pro Monat |
| 4 | **Energie-Kreuzlingen-Adapter** | TG | S | ~6 pro Monat |
| 5 | **CKW- und WWZ-Adapter** (Negativsatz darf Meldungen nicht unterdrücken) | LU, ZG | je S | 1–4 pro Monat |
| 6 | **Repower-Tabelle «Vergangene Störungen»** | GR | S–M | 10–15 pro Jahr |
| 7 | **IBB auf JSON umstellen, Eniwa-JSON neu aufnehmen** | AG | je S | IBB belegt verpasst; Eniwa offen |
| 8 | **Registry bereinigen:** SIL-URL ersetzen (RSS der Stadt Lausanne), Werke-am-Zürichsee-URL korrigieren, Quellen ohne Inhalt auf `discovery_only` setzen oder deaktivieren | – | S | spart rund 10 Subrequests pro Lauf, das deckt die neuen Quellen |

### Welle 2: Neue offizielle Quellen und Medienschicht

| # | Massnahme | Aufwand | Wirkung |
|---|---|---|---|
| 9 | **Kleine offizielle Quellen aufnehmen:** RELL, Sinergy, energieUri-RSS, EWN, TB Seon (WP-REST), EW Heiden, Feuerschaugemeinde Appenzell, TBGN, AEW-RSS, RWB/EWN-Adapter | je S | erste offizielle Abdeckung für UR, NW, AI und GL; Oberwallis |
| 10 | **Regionale Medien-RSS als Discovery-Schicht**, ergänzend zu Google Alerts. Rund 15 geprüfte Feeds, je 1 Subrequest. Details unten. | S | 10 der 14 Lückenkantone; Latenz verlässlicher als bei Google Alerts |
| 11 | **Polizei- und Behörden-RSS**, wo vorhanden (BL bestätigt, SG auf opendata.swiss gelistet; AG, ZH und TG offen). Gilt als Behördenquelle und ist damit sofort publizierbar. | S–M | grosse ungeplante Ausfälle |

**Medienfeeds für Massnahme 10:**
- CH Media: `aargauerzeitung.ch/aargau.rss`, `tagblatt.ch/ostschweiz/{stgallen,thurgau}.rss`, `luzernerzeitung.ch/zentralschweiz/{zug,schwyz,uri,obwalden,nidwalden}.rss`, `bzbasel.ch/basel.rss`, `limmattalerzeitung.ch/limmattal.rss`
- Tamedia: `tagesanzeiger.ch/zuerich/rss.html`, `tdg.ch/geneve/rss.html`, `bazonline.ch/basel/rss.html`
- RTS Regionen: `rts.ch/info/regions/?format=rss/news`
- SRF: `srf.ch/news/bnf/rss/1646`

**Achtung bei der Regel «zwei unabhängige Quellen»:** Somedia (GR) und CH Media (SG) besitzen jeweils mehrere Titel der Region. Wenn «unabhängig» den Verlag meint, braucht es als Zweitquelle SRF, RTR oder RTS.

### Welle 3: Strukturelle Hebel für die Gebiete ohne Online-Angebot

| # | Massnahme | Aufwand | Wirkung |
|---|---|---|---|
| 12 | **Datenpartnerschaften** mit EKZ (~650k), SIG (520k), Groupe E, EKT (Vorlieferant in TG mit Überwachung der Mittelspannung vieler Gemeinde-EVU) und EKS. Angebot: Darstellung auf outage.ch, Entlastung der Hotline; gewünscht ist ein Feed. | L | grösster einzelner Hebel; ZH und GE sind sonst nicht erreichbar |
| 13 | **Generische Gemeinde-CMS-Adapter** für i-web (`data-entities`-JSON im HTML) und GOViS. Ein Adapter dient vielen Gemeinden. Abfrage rotierend, 20–30 Gemeinden pro Lauf, Schwerpunkt ZH, AG, SG und TG. Beispiel: Stäfa meldete am 7.8. einen Trafo-Defekt. | M | erfasst die Gemeindewerke |
| 14 | **Bürgermeldung als Auslöser**, nicht als Quelle. Ein Formular mit Turnstile publiziert nichts selbst. Es stösst nur einen sofortigen Recheck der zuständigen EVU- oder Gemeindequelle an und erhöht deren Priorität. Vorbilder: störungsauskunft.de, GeoBlackout. | M | Discovery überall |
| 15 | **Branchenfeed anregen** (VSE): eine gemeinsame Schnittstelle nach dem Muster von störungsauskunft.de in Deutschland. | L | die einzige Lösung, die für die über 600 kleinen Netzbetreiber skaliert |

Nicht weiterverfolgen: Amtsblattportal (dort erscheinen keine Unterbrüche), Swissgrid und ElCom als Echtzeitquelle (nur jährlich oder bei Grossereignissen), allestoerungen.ch.

### Free-Tier-Bilanz

- Welle 1 und 2 bringen rund 20 neue Fetches pro Lauf.
- Die Bereinigung in Welle 1, Massnahme 8, spart rund 10.
- Die Medien-RSS-Abrufe brauchen nur einen 30-Minuten-Takt.
- Damit bleibt der Cron deutlich unter 50 Subrequests.
- Alle Adapter schreiben über die bestehende Pipeline `source_records`. Neue D1-Schreibzugriffe entstehen nur bei echten Meldungen.

## Umsetzung Welle 1 (Stand 5. November 2026)

| Massnahme | Stand |
|---|---|
| IWB-Adapter (geplante Strom-Unterbrüche je Strasse, aktuelle Störungen) | umgesetzt, `parseIwbHtml` |
| Energie-Kreuzlingen-Adapter (Störungen, geplante Unterbrüche, Archiv 180 Tage) | umgesetzt, `parseEnergieKreuzlingenHtml` |
| CKW-Adapter («Letzte Störung» und aktive Meldung in der Box) | umgesetzt, `parseCkwHtml` |
| WWZ-Adapter (`div.outage`, nur Service «Strom») | umgesetzt, `parseWwzHtml` |
| Repower «Vergangene Störungen» als eigene Quelle `repower-vergangene-stoerungen` | umgesetzt, `parseRepowerHistoryHtml` |
| SES-Sperre | erkannt und als `blocked_by_operator` gemeldet statt `parser_schema_changed`. **Abruf noch nicht gelöst**: Freigabe bei SES anfragen oder Firecrawl mit Standort CH (kostet Credits) |
| Registry bereinigen | Migration `0026_regional_coverage_wave1.sql`: SIL-URL, Werke-am-Zürichsee-URL, 11 Quellen ohne Liste nur noch alle 6 h. Abrufbedarf 4'080 → 3'240 pro Tag |
| Eli10 | zurückgestellt: Die Liste hat keine Zeitfenster, sie stehen nur auf den Detailseiten. Das passt nicht zu «ein Abruf pro Quelle»; dafür braucht es einen Zwei-Stufen-Abruf. |
| IBB, Eniwa | zurückgestellt: Beide JSON-Endpunkte waren am 5.11. leer, das Format einer echten Meldung ist unbekannt. Erst beobachten. |

Neue Ereignisse aus Archiven (Kreuzlingen, Repower, CKW) erscheinen mit ihren gemeldeten Zeiten, nicht mit dem Datum der ersten Sichtung. Archiv-Meldungen ohne Uhrzeit werden nicht übernommen.

## 4. Offene Punkte

- Ob der Cloudflare-Egress auch bei EWS, TB Wil, Energie Uster, EKS und EW Urnäsch die Ursache ist. Prüfbar über die Rohantworten in R2 unter `raw/<source_key>/…`.
- Wie oft Eniwa, RELL, EnBAG, EWN und EW Höfe melden. Dafür 2–4 Wochen beobachten.
- Die Einwohnerzahlen je Betreiber sind geschätzt. Genaue Zahlen gäbe eine Verknüpfung von ElCom-Gemeinden mit STATPOP.
- Ob SIG, Groupe E, OIKEN und EKZ über Social Media, SMS oder WhatsApp Meldungen verbreiten, die maschinell lesbar wären.
- Geocoding von «Aesch» (Primeo) korrigieren.
