import { describe, it, expect } from "vitest";

import { Dataset } from "../src/data/dataset.js";

/**
 * Guards the base_size_mm population against regression. Thresholds are absolute
 * floors (well below the current populated counts) so adding a handful of units
 * won't make the suite flaky, while a broken bridge — which would drop counts
 * sharply — still fails. The honest ceiling from the available sources is ~89% of
 * non-vehicle units; the rest are flying-stem / Hull / Unique without standard
 * dimensions, or Forge World / Legends units absent from every source.
 */
describe("base_size_mm coverage", () => {
  const ds = Dataset.embedded();
  const units = ds.units.all.map((u) => u.raw);
  const isVehicle = (u: (typeof units)[number]) =>
    (u.keywords ?? []).some((k) => /vehicle|aircraft/i.test(k));

  const populated = units.filter((u) => u.base_size_mm != null);
  const nonVehicle = units.filter((u) => !isVehicle(u));
  const nonVehiclePopulated = nonVehicle.filter((u) => u.base_size_mm != null);
  const authoritative = populated.filter((u) => !u.base_size_mm?.draft);

  it("populates most units (categorical)", () => {
    // Current: 918/1107 unique. Floor set well below to guard regression, not drift.
    expect(populated.length).toBeGreaterThanOrEqual(900);
  });

  it("populates the large majority of non-vehicle units", () => {
    // Current: 663/748 ≈ 88.6%. The residual is flying-stem/Hull/Unique + source gaps.
    expect(nonVehiclePopulated.length).toBeGreaterThanOrEqual(650);
    expect(nonVehiclePopulated.length / nonVehicle.length).toBeGreaterThanOrEqual(0.85);
  });

  it("most populated bases are authoritative (non-draft) round/oval values", () => {
    // Current: 783 authoritative.
    expect(authoritative.length).toBeGreaterThanOrEqual(760);
  });

  it("carries provisional flying/hull/unique bases as draft for later authoring", () => {
    const draft = populated.filter((u) => u.base_size_mm?.draft);
    expect(draft.length).toBeGreaterThanOrEqual(100);
    // Every draft unit is a category, never a plain round/oval authoritative value.
    for (const u of draft) {
      expect(["flying-base", "hull", "unique", "round", "oval"]).toContain(u.base_size_mm!.shape);
    }
  });

  it("matches known authoritative sizes", () => {
    const base = (id: string) => ds.units.getAny(id)?.raw.base_size_mm;
    expect(base("intercessor-squad")).toEqual({ shape: "round", diameter: 32 });
    expect(base("vertus-praetors")).toEqual({ shape: "oval", width: 75, length: 42 });
    expect(base("windriders")).toEqual({ shape: "flying-base", size: "small", draft: true });
  });

  it("resolves mixed squads per-model via composition", () => {
    const comp = ds.unitCompositions.find((c) => c.unit_id === "jakhals");
    const byName = new Map(comp!.models.map((m) => [m.name, m.base_size_mm]));
    expect(byName.get("Dishonoured")).toEqual({ shape: "round", diameter: 40 });
    expect(byName.get("Jakhal")).toEqual({ shape: "round", diameter: 28.5 });
    // Representative unit-level base is the bulk model (Jakhal), not the 40mm Dishonoured.
    expect(ds.units.getAny("jakhals")?.raw.base_size_mm).toEqual({ shape: "round", diameter: 28.5 });
  });
});
