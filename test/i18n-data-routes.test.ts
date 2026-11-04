import { describe, expect, it } from "vitest";
import {
  alternatePath,
  canonicalRoutePath,
  hreflangEntries,
  localizeRoute,
  parseAppPath,
  pathFor,
  templateShellTarget
} from "../src/i18n/routes";

describe("data page routes", () => {
  it.each([
    ["/statistik/", { locale: "de", route: { kind: "stats" } }],
    ["/statistik", { locale: "de", route: { kind: "stats" } }],
    ["/fr/statistiques/", { locale: "fr", route: { kind: "stats" } }],
    ["/stromausfall/", { locale: "de", route: { kind: "places" } }],
    ["/stromausfall/brugg", { locale: "de", route: { kind: "place", slug: "brugg" } }],
    ["/fr/panne-de-courant/la-chaux-de-fonds", { locale: "fr", route: { kind: "place", slug: "la-chaux-de-fonds" } }],
    ["/stromausfall/kanton/waadt", { locale: "de", route: { kind: "canton", slug: "waadt" } }],
    ["/fr/panne-de-courant/canton/vaud", { locale: "fr", route: { kind: "canton", slug: "vaud" } }],
    ["/stromausfall/brugg-42", { locale: "de", route: { kind: "event", slugId: "brugg-42" } }],
    ["/data-template/", { locale: "de", route: { kind: "dataTemplate" } }]
  ])("parses %s", (path, expected) => {
    expect(parseAppPath(path)).toEqual(expected);
  });

  it("does not treat numeric-only or upper-case segments as places", () => {
    expect(parseAppPath("/stromausfall/12345")).toBeNull();
    expect(parseAppPath("/stromausfall/Brugg")).toBeNull();
  });

  it("builds localized paths for data routes", () => {
    expect(pathFor({ kind: "stats" }, "de")).toBe("/statistik/");
    expect(pathFor({ kind: "stats" }, "it")).toBe("/it/statistiche/");
    expect(pathFor({ kind: "places" }, "en")).toBe("/en/power-outage/");
    expect(pathFor({ kind: "place", slug: "brugg" }, "fr")).toBe("/fr/panne-de-courant/brugg");
    expect(pathFor({ kind: "canton", slug: "vaud" }, "it")).toBe("/it/interruzione-di-corrente/cantone/vaud");
  });

  it("localizes canton slugs and leaves other routes alone", () => {
    expect(localizeRoute({ kind: "canton", slug: "waadt" }, "fr")).toEqual({ kind: "canton", slug: "vaud" });
    expect(localizeRoute({ kind: "canton", slug: "vd" }, "de")).toEqual({ kind: "canton", slug: "waadt" });
    expect(localizeRoute({ kind: "canton", slug: "atlantis" }, "fr")).toEqual({ kind: "canton", slug: "atlantis" });
    expect(localizeRoute({ kind: "place", slug: "brugg" }, "fr")).toEqual({ kind: "place", slug: "brugg" });
  });

  it("canonicalizes mixed stems and foreign canton slugs", () => {
    expect(canonicalRoutePath("/fr/stromausfall/kanton/waadt")).toBe("/fr/panne-de-courant/canton/vaud");
    expect(canonicalRoutePath("/stromausfall/canton/vaud")).toBe("/stromausfall/kanton/waadt");
    expect(canonicalRoutePath("/fr/statistik")).toBe("/fr/statistiques/");
    expect(canonicalRoutePath("/stromausfall/kanton/waadt")).toBe("/stromausfall/kanton/waadt");
    expect(canonicalRoutePath("/nope/nope")).toBeNull();
  });

  it("switches language on a canton page with the localized slug", () => {
    expect(alternatePath("/stromausfall/kanton/wallis", "fr")).toBe("/fr/panne-de-courant/canton/valais");
    expect(alternatePath("/fr/panne-de-courant/canton/valais", "it")).toBe("/it/interruzione-di-corrente/cantone/vallese");
  });

  it("lists hreflang alternates with localized canton slugs", () => {
    const entries = hreflangEntries("/stromausfall/kanton/waadt", "https://outage.ch");
    expect(entries.map((entry) => [entry.hreflang, entry.href])).toEqual([
      ["de-CH", "https://outage.ch/stromausfall/kanton/waadt"],
      ["fr-CH", "https://outage.ch/fr/panne-de-courant/canton/vaud"],
      ["it-CH", "https://outage.ch/it/interruzione-di-corrente/cantone/vaud"],
      ["en", "https://outage.ch/en/power-outage/canton/vaud"],
      ["x-default", "https://outage.ch/stromausfall/kanton/waadt"]
    ]);
  });

  it("emits no hreflang alternates for template shells", () => {
    expect(hreflangEntries("/data-template/", "https://outage.ch")).toEqual([]);
  });

  it("redirects template shells to the localized home", () => {
    expect(templateShellTarget("/data-template/")).toBe("/");
    expect(templateShellTarget("/data-template")).toBe("/");
    expect(templateShellTarget("/fr/events")).toBe("/fr/");
    expect(templateShellTarget("/it/data-template/")).toBe("/it/");
    expect(templateShellTarget("/events/")).toBe("/");
    expect(templateShellTarget("/statistik/")).toBeNull();
    expect(templateShellTarget("/events/42")).toBeNull();
  });
});
