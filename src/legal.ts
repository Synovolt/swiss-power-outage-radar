import type { AppLocale } from "./i18n";

/** Operator of outage.ch as entered in the commercial register (Zefix, CHE-472.550.750). */
export const LEGAL_ENTITY = {
  name: "Synovolt AG",
  street: "Schorenstrasse 39",
  town: "3645 Gwatt (Thun)",
  country: "Schweiz",
  uid: "CHE-472.550.750",
  email: "alert@outage.ch",
  register: "https://www.zefix.ch/de/search/entity/list/firm/1770519"
} as const;

export const IMPRINT_PATH = "/impressum/";
export const PRIVACY_PATH = "/datenschutz/";

export function legalPath(path: string, locale: AppLocale): string {
  return locale === "de" ? path : `/${locale}${path}`;
}

export const LEGAL_LABELS: Record<AppLocale, { imprint: string; privacy: string }> = {
  de: { imprint: "Impressum", privacy: "Datenschutz" },
  fr: { imprint: "Mentions légales", privacy: "Protection des données" },
  it: { imprint: "Note legali", privacy: "Protezione dei dati" },
  en: { imprint: "Imprint", privacy: "Privacy" }
};
