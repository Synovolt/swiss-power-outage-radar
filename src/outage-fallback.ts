import { escapeHtml } from "./html";
import { pathFor, type AppLocale } from "./i18n";
import { parseLocaleFromPath } from "./i18n/routes";
import { publicOperatorProfiles } from "./operators";

/**
 * What visitors get when the Worker cannot answer, typically because D1 is
 * unavailable (daily free-tier read limit, outage). Rendered without any
 * database access, so it works exactly when everything else does not.
 */

const RETRY_SECONDS_DEFAULT = 120;

/** D1's free-tier quota error: no reads succeed until the next UTC midnight. */
export function isD1QuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /D1_ERROR/i.test(message) && /(limit|quota)/i.test(message);
}

/** When the database is expected back, and how long clients should wait. */
export function expectedRecovery(error: unknown, now = Date.now()): { retryAfter: number; at: Date | null } {
  if (!isD1QuotaError(error)) return { retryAfter: RETRY_SECONDS_DEFAULT, at: null };
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  // Retry a little after the reset rather than exactly on it.
  const at = new Date(midnight.getTime() + 5 * 60_000);
  return { retryAfter: Math.max(60, Math.ceil((at.getTime() - now) / 1000)), at };
}

const COPY: Record<AppLocale, {
  lang: string;
  title: string;
  lead: string;
  backAt: (time: string) => string;
  backSoon: string;
  nowTitle: string;
  steps: string[];
  guides: string;
  operatorsTitle: string;
  operatorsLead: string;
}> = {
  de: {
    lang: "de-CH",
    title: "Meldungen vorübergehend nicht verfügbar",
    lead: "outage.ch kann die Meldungen gerade nicht laden. Das betrifft nur diese Seite, nicht das Stromnetz.",
    backAt: (time) => `Voraussichtlich wieder verfügbar ab ${time} Uhr.`,
    backSoon: "Bitte versuchen Sie es in wenigen Minuten erneut.",
    nowTitle: "Haben Sie gerade keinen Strom?",
    steps: [
      "Prüfen Sie, ob nur Ihr Haushalt betroffen ist: Sicherungen kontrollieren, Nachbarn fragen.",
      "Verbindliche Informationen hat Ihr Netzbetreiber, Links unten.",
      "Im Notfall 112, 118 oder 144 wählen."
    ],
    guides: "Ratgeber: Was tun bei Stromausfall?",
    operatorsTitle: "Störungsseiten der Netzbetreiber",
    operatorsLead: "Direkt zu den offiziellen Seiten, die outage.ch sonst auswertet."
  },
  fr: {
    lang: "fr-CH",
    title: "Signalements temporairement indisponibles",
    lead: "outage.ch ne peut pas charger les signalements pour le moment. Cela concerne uniquement ce site, pas le réseau électrique.",
    backAt: (time) => `Retour prévu dès ${time}.`,
    backSoon: "Veuillez réessayer dans quelques minutes.",
    nowTitle: "Vous n'avez plus de courant ?",
    steps: [
      "Vérifiez si seul votre logement est touché : fusibles, voisins.",
      "Votre gestionnaire de réseau fait foi, liens ci-dessous.",
      "En cas d'urgence, appelez le 112, 118 ou 144."
    ],
    guides: "Guide : que faire en cas de panne ?",
    operatorsTitle: "Pages de dérangement des gestionnaires de réseau",
    operatorsLead: "Accès direct aux pages officielles qu'outage.ch consulte habituellement."
  },
  it: {
    lang: "it-CH",
    title: "Segnalazioni temporaneamente non disponibili",
    lead: "outage.ch non riesce a caricare le segnalazioni in questo momento. Riguarda solo questo sito, non la rete elettrica.",
    backAt: (time) => `Di nuovo disponibile presumibilmente dalle ${time}.`,
    backSoon: "Riprovi tra qualche minuto.",
    nowTitle: "È senza corrente?",
    steps: [
      "Verifichi se è interessata solo la sua abitazione: fusibili, vicini.",
      "Fanno fede le informazioni del gestore di rete, link qui sotto.",
      "In caso di emergenza chiami il 112, 118 o 144."
    ],
    guides: "Guida: cosa fare in caso di blackout?",
    operatorsTitle: "Pagine guasti dei gestori di rete",
    operatorsLead: "Direttamente alle pagine ufficiali che outage.ch consulta di solito."
  },
  en: {
    lang: "en",
    title: "Reports temporarily unavailable",
    lead: "outage.ch cannot load its reports right now. This affects this website only, not the power grid.",
    backAt: (time) => `Expected back from ${time} (Swiss time).`,
    backSoon: "Please try again in a few minutes.",
    nowTitle: "Is your power out?",
    steps: [
      "Check whether only your home is affected: fuses, neighbours.",
      "Your grid operator has the authoritative information, links below.",
      "In an emergency call 112, 118 or 144."
    ],
    guides: "Guide: what to do in a power outage",
    operatorsTitle: "Grid operators' outage pages",
    operatorsLead: "Straight to the official pages outage.ch normally reads."
  }
};

function swissTime(date: Date): string {
  return new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function renderUnavailablePage(locale: AppLocale, recoveryAt: Date | null): string {
  const copy = COPY[locale] ?? COPY.de;
  const operators = publicOperatorProfiles()
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map((operator) => `<li><a href="${escapeHtml(operator.officialUrl)}" rel="noopener">${escapeHtml(operator.name)}</a><span>${escapeHtml(operator.area)}</span></li>`)
    .join("");
  const when = recoveryAt ? copy.backAt(swissTime(recoveryAt)) : copy.backSoon;
  return `<!doctype html><html lang="${copy.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(copy.title)} | outage.ch</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--text:#1a1a1a;--muted:#5f5f5a;--line:#e3e2dd;--accent:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--text:#f1f0ec;--muted:#a9a8a1;--line:#33322f;--accent:#ff7b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 48px}
.brand{font-weight:700;text-decoration:none;color:inherit}
h1{font-size:28px;line-height:1.2;margin:24px 0 8px}h2{font-size:18px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:16px}
.when{color:var(--accent);font-weight:600}.muted{color:var(--muted)}
ol{margin:0;padding-left:20px}ol li{margin:4px 0}
ul{list-style:none;margin:12px 0 0;padding:0}ul li{display:flex;flex-wrap:wrap;gap:4px 10px;padding:8px 0;border-top:1px solid var(--line)}
ul li span{color:var(--muted);font-size:14px}a{color:inherit}
</style></head>
<body><main>
<a class="brand" href="${escapeHtml(pathFor({ kind: "home" }, locale))}">outage.ch</a>
<h1>${escapeHtml(copy.title)}</h1>
<p>${escapeHtml(copy.lead)}</p>
<p class="when">${escapeHtml(when)}</p>
<section class="card"><h2>${escapeHtml(copy.nowTitle)}</h2><ol>${copy.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
<p><a href="${escapeHtml(pathFor({ kind: "guides" }, locale))}">${escapeHtml(copy.guides)}</a></p></section>
<section class="card"><h2>${escapeHtml(copy.operatorsTitle)}</h2><p class="muted">${escapeHtml(copy.operatorsLead)}</p><ul>${operators}</ul></section>
</main></body></html>`;
}

/** 503 for a request the Worker could not answer: HTML for pages, JSON for the API. */
export function unavailableResponse(request: Request, error: unknown, now = Date.now()): Response {
  const url = new URL(request.url);
  const { retryAfter, at } = expectedRecovery(error, now);
  const headers = { "Cache-Control": "no-store", "Retry-After": String(retryAfter), "X-Robots-Tag": "noindex" };
  const wantsHtml = (request.method === "GET" || request.method === "HEAD") &&
    !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/admin/");
  if (!wantsHtml) {
    return Response.json({ error: "Temporarily unavailable", retry_after: retryAfter }, { status: 503, headers });
  }
  const body = request.method === "HEAD" ? null : renderUnavailablePage(parseLocaleFromPath(url.pathname), at);
  return new Response(body, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}
