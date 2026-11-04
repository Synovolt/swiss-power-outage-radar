/**
 * Copy for the redesigned interface (home radar, event page, shared rows).
 * Kept in its own namespace (`ui.*`) so the older catalogs stay untouched.
 */
export const uiDe = {
  status: {
    active: "Aktiv",
    upcoming: "Geplant",
    ended: "Beendet"
  },
  home: {
    eyebrow: "Live · Schweiz",
    question: "Gibt es bei Ihnen einen Stromausfall?",
    searchPlaceholder: "Ort, Kanton oder Netzbetreiber",
    searchClear: "Suche löschen",
    activeLabel_one: "aktive Störung",
    activeLabel_other: "aktive Störungen",
    plannedLabel_one: "geplanter Unterbruch",
    plannedLabel_other: "geplante Unterbrüche",
    plannedHint: "angekündigt",
    historyLink: "Ganzen Verlauf ansehen",
    activeHint: "jetzt",
    allClear: "Zurzeit ist keine Störung gemeldet.",
    natureLabel: "Art",
    mapShow: "Karte",
    mapHide: "Karte ausblenden",
    legendActive: "Aktiv",
    legendPlanned: "Geplant",
    legendEnded: "Beendet",
    sources: "Direkt aus {{count}} Quellen von Netzbetreibern und Behörden",
    refreshed: "Aktualisiert {{date}}",
    noPin: "Ohne genaue Kartenposition"
  },
  row: {
    until: "bis {{time}}",
    endedAgo: "beendet {{relative}}",
    startsIn: "beginnt {{relative}}"
  },
  event: {
    back: "Alle Meldungen",
    headline: {
      active: "Läuft seit {{duration}}",
      activeReported: "Gemeldet {{relative}}",
      endPlanned: "Ende angekündigt {{time}}",
      endOpen: "Ende noch offen",
      upcoming: "{{when}}",
      startsIn: "Beginnt {{relative}}",
      resolved: "Beendet {{date}}",
      resolvedNoTime: "Als behoben gemeldet",
      lasted: "Dauer {{duration}}",
      autoClosed: "Seit {{date}} nicht mehr gemeldet",
      autoClosedNoDate: "Nicht mehr gemeldet",
      endUnknown: "Ende unbekannt",
      stale: "Seit {{date}} nicht mehr bestätigt",
      historical: "Archivierte Meldung vom {{date}}"
    },
    progress: {
      aria: "Zeitfenster: {{start}} bis {{end}}",
      now: "Jetzt"
    },
    facts: {
      start: "Beginn",
      end: "Ende",
      plannedEnd: "Angekündigtes Ende",
      duration: "Dauer",
      area: "Gebiet",
      cause: "Ursache",
      operator: "Netzbetreiber",
      kind: "Art",
      open: "offen",
      unknown: "unbekannt",
      received: "Bei outage.ch seit"
    },
    reportHeading: "Das meldet {{publisher}}",
    reportAt: "Meldung vom {{date}}",
    officialSource: "Meldung bei {{publisher}} öffnen",
    operatorPage: "Alle Meldungen von {{name}}",
    share: "Link teilen",
    copied: "Link kopiert",
    timeline: "Verlauf",
    sources: "Quellen",
    sourcesIntro: "Alle Angaben auf dieser Seite stammen aus diesen öffentlichen Meldungen.",
    tips: {
      prepare: "So bereiten Sie sich vor",
      during: "Was jetzt tun?",
      p1: "Empfindliche Geräte vor Beginn ausschalten oder ausstecken.",
      p2: "Handy, Powerbank und Taschenlampe aufladen.",
      p3: "Kühlschrank und Tiefkühler während des Unterbruchs geschlossen halten.",
      d1: "Prüfen, ob nur Ihr Haushalt betroffen ist: Sicherungen kontrollieren, Nachbarn fragen.",
      d2: "Empfindliche Geräte ausstecken, Kühlgeräte geschlossen halten.",
      d3: "Im Notfall 112, 118 oder 144 wählen. Störungen meldet man dem Netzbetreiber.",
      more: "Ratgeber: Was tun bei Stromausfall?"
    },
    more: "Weitere Meldungen",
    trustOfficial: "Offizielle Quelle",
    trustCorroborated: "Mehrfach bestätigt",
    trustReported: "Öffentlich gemeldet"
  }
};

export type UiCatalog = typeof uiDe;

export const uiFr: UiCatalog = {
  status: {
    active: "En cours",
    upcoming: "Planifiée",
    ended: "Terminée"
  },
  home: {
    eyebrow: "En direct · Suisse",
    question: "Y a-t-il une panne de courant chez vous ?",
    searchPlaceholder: "Lieu, canton ou gestionnaire",
    searchClear: "Effacer la recherche",
    activeLabel_one: "panne en cours",
    activeLabel_other: "pannes en cours",
    plannedLabel_one: "coupure planifiée",
    plannedLabel_other: "coupures planifiées",
    plannedHint: "annoncées",
    historyLink: "Voir tout l'historique",
    activeHint: "maintenant",
    allClear: "Aucune panne n'est signalée en ce moment.",
    natureLabel: "Type",
    mapShow: "Carte",
    mapHide: "Masquer la carte",
    legendActive: "En cours",
    legendPlanned: "Planifiée",
    legendEnded: "Terminée",
    sources: "Directement depuis {{count}} sources de gestionnaires et d'autorités",
    refreshed: "Mis à jour {{date}}",
    noPin: "Sans position précise sur la carte"
  },
  row: {
    until: "jusqu'à {{time}}",
    endedAgo: "terminée {{relative}}",
    startsIn: "débute {{relative}}"
  },
  event: {
    back: "Tous les signalements",
    headline: {
      active: "En cours depuis {{duration}}",
      activeReported: "Signalée {{relative}}",
      endPlanned: "Fin annoncée {{time}}",
      endOpen: "Fin encore inconnue",
      upcoming: "{{when}}",
      startsIn: "Débute {{relative}}",
      resolved: "Terminée {{date}}",
      resolvedNoTime: "Signalée comme rétablie",
      lasted: "Durée {{duration}}",
      autoClosed: "Plus signalée depuis {{date}}",
      autoClosedNoDate: "Plus signalée",
      endUnknown: "Fin inconnue",
      stale: "Plus confirmée depuis {{date}}",
      historical: "Signalement archivé du {{date}}"
    },
    progress: {
      aria: "Plage horaire : {{start}} à {{end}}",
      now: "Maintenant"
    },
    facts: {
      start: "Début",
      end: "Fin",
      plannedEnd: "Fin annoncée",
      duration: "Durée",
      area: "Zone",
      cause: "Cause",
      operator: "Gestionnaire",
      kind: "Type",
      open: "ouverte",
      unknown: "inconnue",
      received: "Sur outage.ch depuis"
    },
    reportHeading: "Ce que signale {{publisher}}",
    reportAt: "Signalement du {{date}}",
    officialSource: "Ouvrir le signalement chez {{publisher}}",
    operatorPage: "Tous les signalements de {{name}}",
    share: "Partager le lien",
    copied: "Lien copié",
    timeline: "Chronologie",
    sources: "Sources",
    sourcesIntro: "Toutes les informations de cette page proviennent de ces signalements publics.",
    tips: {
      prepare: "Comment vous préparer",
      during: "Que faire maintenant ?",
      p1: "Éteindre ou débrancher les appareils sensibles avant le début.",
      p2: "Charger téléphone, batterie externe et lampe de poche.",
      p3: "Garder réfrigérateur et congélateur fermés pendant la coupure.",
      d1: "Vérifier si seul votre logement est touché : fusibles, voisins.",
      d2: "Débrancher les appareils sensibles, garder les appareils de froid fermés.",
      d3: "En cas d'urgence, composer le 112, 118 ou 144. Les pannes se signalent au gestionnaire.",
      more: "Guide : que faire en cas de panne ?"
    },
    more: "Autres signalements",
    trustOfficial: "Source officielle",
    trustCorroborated: "Confirmée par plusieurs sources",
    trustReported: "Signalée publiquement"
  }
};

export const uiIt: UiCatalog = {
  status: {
    active: "In corso",
    upcoming: "Pianificata",
    ended: "Terminata"
  },
  home: {
    eyebrow: "Live · Svizzera",
    question: "C'è un'interruzione di corrente da voi?",
    searchPlaceholder: "Località, cantone o gestore",
    searchClear: "Cancella ricerca",
    activeLabel_one: "guasto in corso",
    activeLabel_other: "guasti in corso",
    plannedLabel_one: "interruzione pianificata",
    plannedLabel_other: "interruzioni pianificate",
    plannedHint: "annunciate",
    historyLink: "Vedi tutta la cronologia",
    activeHint: "ora",
    allClear: "Al momento non è segnalato alcun guasto.",
    natureLabel: "Tipo",
    mapShow: "Mappa",
    mapHide: "Nascondi mappa",
    legendActive: "In corso",
    legendPlanned: "Pianificata",
    legendEnded: "Terminata",
    sources: "Direttamente da {{count}} fonti di gestori e autorità",
    refreshed: "Aggiornato {{date}}",
    noPin: "Senza posizione precisa sulla mappa"
  },
  row: {
    until: "fino alle {{time}}",
    endedAgo: "terminata {{relative}}",
    startsIn: "inizia {{relative}}"
  },
  event: {
    back: "Tutte le segnalazioni",
    headline: {
      active: "In corso da {{duration}}",
      activeReported: "Segnalata {{relative}}",
      endPlanned: "Fine annunciata {{time}}",
      endOpen: "Fine ancora aperta",
      upcoming: "{{when}}",
      startsIn: "Inizia {{relative}}",
      resolved: "Terminata {{date}}",
      resolvedNoTime: "Segnalata come risolta",
      lasted: "Durata {{duration}}",
      autoClosed: "Non più segnalata dal {{date}}",
      autoClosedNoDate: "Non più segnalata",
      endUnknown: "Fine sconosciuta",
      stale: "Non più confermata dal {{date}}",
      historical: "Segnalazione archiviata del {{date}}"
    },
    progress: {
      aria: "Fascia oraria: dalle {{start}} alle {{end}}",
      now: "Ora"
    },
    facts: {
      start: "Inizio",
      end: "Fine",
      plannedEnd: "Fine annunciata",
      duration: "Durata",
      area: "Zona",
      cause: "Causa",
      operator: "Gestore",
      kind: "Tipo",
      open: "aperta",
      unknown: "sconosciuta",
      received: "Su outage.ch dal"
    },
    reportHeading: "Cosa segnala {{publisher}}",
    reportAt: "Segnalazione del {{date}}",
    officialSource: "Apri la segnalazione di {{publisher}}",
    operatorPage: "Tutte le segnalazioni di {{name}}",
    share: "Condividi link",
    copied: "Link copiato",
    timeline: "Cronologia",
    sources: "Fonti",
    sourcesIntro: "Tutte le informazioni di questa pagina provengono da queste segnalazioni pubbliche.",
    tips: {
      prepare: "Come prepararsi",
      during: "Cosa fare adesso?",
      p1: "Spegnere o staccare gli apparecchi sensibili prima dell'inizio.",
      p2: "Caricare telefono, powerbank e torcia.",
      p3: "Tenere chiusi frigorifero e congelatore durante l'interruzione.",
      d1: "Verificare se è colpita solo la propria abitazione: fusibili, vicini.",
      d2: "Staccare gli apparecchi sensibili, tenere chiusi i frigoriferi.",
      d3: "In caso di emergenza chiamare 112, 118 o 144. I guasti si segnalano al gestore.",
      more: "Guida: cosa fare in caso di blackout?"
    },
    more: "Altre segnalazioni",
    trustOfficial: "Fonte ufficiale",
    trustCorroborated: "Confermata da più fonti",
    trustReported: "Segnalata pubblicamente"
  }
};

export const uiEn: UiCatalog = {
  status: {
    active: "Ongoing",
    upcoming: "Planned",
    ended: "Ended"
  },
  home: {
    eyebrow: "Live · Switzerland",
    question: "Is the power out where you are?",
    searchPlaceholder: "Place, canton or grid operator",
    searchClear: "Clear search",
    activeLabel_one: "ongoing outage",
    activeLabel_other: "ongoing outages",
    plannedLabel_one: "planned interruption",
    plannedLabel_other: "planned interruptions",
    plannedHint: "announced",
    historyLink: "See the full history",
    activeHint: "now",
    allClear: "No outage is reported right now.",
    natureLabel: "Type",
    mapShow: "Map",
    mapHide: "Hide map",
    legendActive: "Ongoing",
    legendPlanned: "Planned",
    legendEnded: "Ended",
    sources: "Straight from {{count}} grid operator and authority sources",
    refreshed: "Updated {{date}}",
    noPin: "No exact map position"
  },
  row: {
    until: "until {{time}}",
    endedAgo: "ended {{relative}}",
    startsIn: "starts {{relative}}"
  },
  event: {
    back: "All reports",
    headline: {
      active: "Ongoing for {{duration}}",
      activeReported: "Reported {{relative}}",
      endPlanned: "End announced {{time}}",
      endOpen: "End not known yet",
      upcoming: "{{when}}",
      startsIn: "Starts {{relative}}",
      resolved: "Ended {{date}}",
      resolvedNoTime: "Reported as restored",
      lasted: "Lasted {{duration}}",
      autoClosed: "No longer reported since {{date}}",
      autoClosedNoDate: "No longer reported",
      endUnknown: "End unknown",
      stale: "Not confirmed since {{date}}",
      historical: "Archived report from {{date}}"
    },
    progress: {
      aria: "Time window: {{start}} to {{end}}",
      now: "Now"
    },
    facts: {
      start: "Start",
      end: "End",
      plannedEnd: "Announced end",
      duration: "Duration",
      area: "Area",
      cause: "Cause",
      operator: "Grid operator",
      kind: "Type",
      open: "open",
      unknown: "unknown",
      received: "On outage.ch since"
    },
    reportHeading: "What {{publisher}} reports",
    reportAt: "Report from {{date}}",
    officialSource: "Open the report at {{publisher}}",
    operatorPage: "All reports from {{name}}",
    share: "Share link",
    copied: "Link copied",
    timeline: "Timeline",
    sources: "Sources",
    sourcesIntro: "Everything on this page comes from these public reports.",
    tips: {
      prepare: "How to prepare",
      during: "What to do now?",
      p1: "Switch off or unplug sensitive devices before it starts.",
      p2: "Charge your phone, power bank and torch.",
      p3: "Keep the fridge and freezer closed during the interruption.",
      d1: "Check whether only your home is affected: fuse box, neighbours.",
      d2: "Unplug sensitive devices and keep fridges closed.",
      d3: "In an emergency call 112, 118 or 144. Outages are reported to the grid operator.",
      more: "Guide: what to do in a power cut?"
    },
    more: "More reports",
    trustOfficial: "Official source",
    trustCorroborated: "Confirmed by several sources",
    trustReported: "Publicly reported"
  }
};
