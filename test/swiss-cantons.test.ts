import { describe, expect, it } from "vitest";
import { SWISS_CANTONS, cantonByCode, cantonByName, cantonBySlug, cantonName, cantonSlug, splitCantonSuffix } from "../src/swiss-cantons";

describe("Swiss canton lookup", () => {
  it("lists all 26 cantons with unique codes", () => {
    expect(SWISS_CANTONS).toHaveLength(26);
    expect(new Set(SWISS_CANTONS.map((canton) => canton.code)).size).toBe(26);
  });

  it("splits a parenthesized or trailing canton code off a place label", () => {
    expect(splitCantonSuffix("Chavornay (VD)")).toEqual({ name: "Chavornay", canton: "VD" });
    expect(splitCantonSuffix("Brugg AG")).toEqual({ name: "Brugg", canton: "AG" });
    expect(splitCantonSuffix("  Bad   Ragaz  SG ")).toEqual({ name: "Bad Ragaz", canton: "SG" });
  });

  it("leaves labels without a valid canton code untouched", () => {
    expect(splitCantonSuffix("Brugg XX")).toEqual({ name: "Brugg XX", canton: null });
    expect(splitCantonSuffix("Zürich (ZZ)")).toEqual({ name: "Zürich (ZZ)", canton: null });
    expect(splitCantonSuffix("Lenzburg")).toEqual({ name: "Lenzburg", canton: null });
    // Lower-case codes are not treated as canton markers.
    expect(splitCantonSuffix("Brugg ag")).toEqual({ name: "Brugg ag", canton: null });
  });

  it.each([
    ["Wallis", "VS"],
    ["Valais", "VS"],
    ["Vallese", "VS"],
    ["Waadt", "VD"],
    ["Vaud", "VD"],
    ["Grisons", "GR"],
    ["Grigioni", "GR"],
    ["Graubünden", "GR"],
    ["graubunden", "GR"],
    ["Geneva", "GE"],
    ["Genève", "GE"],
    ["Kanton Bern", "BE"],
    ["canton de Vaud", "VD"],
    ["canton du Valais", "VS"],
    ["Baselland", "BL"],
    ["St.Gallen", "SG"],
    ["Sankt Gallen", "SG"]
  ])("resolves the canton name %s", (name, code) => {
    expect(cantonByName(name)?.code).toBe(code);
  });

  it("does not match partial texts or unknown names", () => {
    expect(cantonByName("Brugg, Aargau")).toBeNull();
    expect(cantonByName("Basel")).toBeNull();
    expect(cantonByName("")).toBeNull();
    expect(cantonByName(null)).toBeNull();
  });

  it("resolves cantons by code and by slug of any locale", () => {
    expect(cantonByCode(" vd ")?.code).toBe("VD");
    expect(cantonByCode("XX")).toBeNull();
    expect(cantonBySlug("vd")?.code).toBe("VD");
    expect(cantonBySlug("waadt")?.code).toBe("VD");
    expect(cantonBySlug("vaud")?.code).toBe("VD");
    expect(cantonBySlug("VAUD")?.code).toBe("VD");
    expect(cantonBySlug("zuerich")?.code).toBe("ZH");
    expect(cantonBySlug("zurigo")?.code).toBe("ZH");
    expect(cantonBySlug("bale-ville")?.code).toBe("BS");
    expect(cantonBySlug("atlantis")).toBeNull();
    expect(cantonBySlug(undefined)).toBeNull();
  });

  it("builds localized URL slugs", () => {
    const vd = cantonByCode("VD")!;
    expect(cantonSlug(vd, "de")).toBe("waadt");
    expect(cantonSlug(vd, "fr")).toBe("vaud");
    const vs = cantonByCode("VS")!;
    expect(cantonSlug(vs, "it")).toBe("vallese");
    expect(cantonSlug(cantonByCode("BS")!, "fr")).toBe("bale-ville");
    expect(cantonSlug(cantonByCode("SG")!, "de")).toBe("st-gallen");
    // Every localized slug resolves back to its canton.
    for (const canton of SWISS_CANTONS) {
      for (const locale of ["de", "fr", "it", "en"] as const) {
        expect(cantonBySlug(cantonSlug(canton, locale))?.code).toBe(canton.code);
      }
    }
  });

  it("returns localized canton names", () => {
    expect(cantonName("GE", "de")).toBe("Genf");
    expect(cantonName("GE", "it")).toBe("Ginevra");
    expect(cantonName(null, "de")).toBeNull();
  });
});
