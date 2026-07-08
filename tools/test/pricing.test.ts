import { describe, it, expect } from "vitest";

import { dataset } from "../src/data/index.js";
import { baseUnitPoints, pointsTierMissing } from "../src/data/pricing.js";

// World Eaters Chaos Terminators are priced by army ordinal: 175 for your 1st–2nd
// copy, 185 for your 3rd+ (and 350/360 at 10 models). The id is shared with
// Emperor's Children, so resolve the WE copy explicitly.
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
    expect(baseUnitPoints(ct, 7, 1)).toBe(175); // reaches the 5-model tier, not 10
    expect(baseUnitPoints(ct, 4, 1)).toBe(175); // below smallest tier → lowest tier
  });

  it("ignores ordinal for an unbanded unit (no unit_count_min)", () => {
    const bz = dataset.units.getAny("khorne-berzerkers")!.raw;
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
