import { describe, it, expect } from "vitest";

import { dataset } from "../src/data/index.js";
import { baseUnitPoints, pointsTierMissing } from "../src/data/pricing.js";

// World Eaters Chaos Terminators are priced by army ordinal: 175 for your 1st–2nd
// copy, 185 for your 3rd+ at 5 models, and 350/360 for a 6–10 model squad (a
// range tier). The id is shared with Emperor's Children, so resolve the WE copy.
const ct = dataset.units.getInFaction("chaos-terminators", "world-eaters")!.raw;

describe("baseUnitPoints — ordinal bands", () => {
  it("prices the 1st–2nd army copy at the lower band", () => {
    expect(baseUnitPoints(ct, 5, 1)).toBe(175);
    expect(baseUnitPoints(ct, 5, 2)).toBe(175);
    expect(baseUnitPoints(ct, 10, 1)).toBe(350);
  });

  it("prices the 3rd+ army copy at the higher band", () => {
    expect(baseUnitPoints(ct, 5, 3)).toBe(185);
    expect(baseUnitPoints(ct, 10, 3)).toBe(360);
    expect(baseUnitPoints(ct, 5, 7)).toBe(185); // open-ended top band
  });

  it("defaults to the 1st army copy when no ordinal is given", () => {
    expect(baseUnitPoints(ct, 5)).toBe(175);
  });

  it("picks the highest model tier the count reaches, within the band", () => {
    expect(baseUnitPoints(ct, 10, 1)).toBe(350);
    expect(baseUnitPoints(ct, 7, 1)).toBe(350); // inside the 6–10 range tier
    expect(baseUnitPoints(ct, 4, 1)).toBe(175); // below smallest tier → lowest tier
  });

  it("ignores ordinal for an unbanded unit (no unit_count_min)", () => {
    const bz = dataset.units.get("khorne-berzerkers")!.raw;
    expect(baseUnitPoints(bz, 10, 1)).toBe(baseUnitPoints(bz, 10, 99));
  });
});

describe("pointsTierMissing — ordinal-aware", () => {
  it("is false for a covered model count + ordinal, true below the smallest tier", () => {
    expect(pointsTierMissing(ct, 5, 1)).toBe(false);
    expect(pointsTierMissing(ct, 5, 3)).toBe(false);
    expect(pointsTierMissing(ct, 4, 1)).toBe(true);
  });
});

// Venatari Custodians are a GW range-priced unit: 3 models @160, or 4–6 models
// @320 (block pricing). The 320 tier carries models_max=6, so every size in its
// range prices at 320 — the regression that crashed the list builder on resize
// was 4/5-model squads falling through to the 3-model tier (160).
const ven = dataset.units.getInFaction("venatari-custodians", "adeptus-custodes")!.raw;

describe("range-priced tiers (models_max)", () => {
  it("prices every size in a range tier at that tier's cost", () => {
    expect(ven.points).toEqual([
      { models: 3, cost: 160 },
      { models: 4, models_max: 6, cost: 320 },
    ]);
    expect(baseUnitPoints(ven, 3)).toBe(160);
    expect(baseUnitPoints(ven, 4)).toBe(320);
    expect(baseUnitPoints(ven, 5)).toBe(320);
    expect(baseUnitPoints(ven, 6)).toBe(320);
  });

  it("flags counts outside every tier range (below floor, above ceiling)", () => {
    expect(pointsTierMissing(ven, 2)).toBe(true); // below the 3-model tier
    expect(pointsTierMissing(ven, 3)).toBe(false);
    expect(pointsTierMissing(ven, 4)).toBe(false);
    expect(pointsTierMissing(ven, 6)).toBe(false);
    expect(pointsTierMissing(ven, 7)).toBe(true); // above the 6-model ceiling
  });
});
