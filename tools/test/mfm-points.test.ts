import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import { deriveDatasheet } from "../src/mfm/points.js";

/**
 * Points derivation: composition.points × Σ(miniature max) for the tier size,
 * datasheet_points_step as per-army-ordinal banding, and referenceGroupingKeyword
 * compositions as allied (host-army) pricing. Tested on synthetic dumps.
 */
function mk(parts: {
  // `models` is a single size, or a [min, max] range for a GW block-priced tier.
  comps: { id: string; pts: number; models: number | [number, number]; group?: string }[];
  step?: { stepAt: number; stepPoints: number };
  keywords?: { id: string; name: string }[];
}): MfmDump {
  const lo = (m: number | [number, number]) => (Array.isArray(m) ? m[0] : m);
  const hi = (m: number | [number, number]) => (Array.isArray(m) ? m[1] : m);
  return new MfmDump({
    data: {
      unit_composition: parts.comps.map((c, i) => ({
        id: c.id,
        datasheetId: "ds",
        displayOrder: i + 1,
        isDefault: i === 0,
        points: c.pts,
        referenceGroupingKeywordId: c.group ?? null,
      })),
      unit_composition_miniature: parts.comps.map((c) => ({
        id: `m-${c.id}`,
        min: lo(c.models),
        max: hi(c.models),
        unitCompositionId: c.id,
        miniatureId: "mini",
      })),
      datasheet_points_step: parts.step
        ? [{ id: "s", datasheetId: "ds", stepAt: parts.step.stepAt, stepPoints: parts.step.stepPoints }]
        : [],
      keyword: (parts.keywords ?? []).map((k) => ({
        id: k.id,
        localisations: { en: { name: k.name } },
      })),
    },
  });
}

describe("deriveDatasheet", () => {
  it("expands datasheet_points_step into per-army-ordinal bands", () => {
    // celestian-sacresants shape: 5@75, 10@150, step(2,15) → #2+ at 90/165.
    const d = mk({
      comps: [
        { id: "c5", pts: 75, models: 5 },
        { id: "c10", pts: 150, models: 10 },
      ],
      step: { stepAt: 2, stepPoints: 15 },
    });
    const { native, ambiguous } = deriveDatasheet(d, "ds");
    expect(ambiguous).toBe(false);
    // Raw tiers carry models_max (== models here); cleanTier strips it later.
    expect(native).toEqual([
      { models: 5, models_max: 5, cost: 75, unit_count_min: 1, unit_count_max: 1 },
      { models: 10, models_max: 10, cost: 150, unit_count_min: 1, unit_count_max: 1 },
      { models: 5, models_max: 5, cost: 90, unit_count_min: 2, unit_count_max: null },
      { models: 10, models_max: 10, cost: 165, unit_count_min: 2, unit_count_max: null },
    ]);
  });

  it("emits flat tiers when there is no step", () => {
    const d = mk({ comps: [{ id: "c5", pts: 80, models: 5 }, { id: "c10", pts: 150, models: 10 }] });
    const { native } = deriveDatasheet(d, "ds");
    expect(native).toEqual([
      { models: 5, models_max: 5, cost: 80 },
      { models: 10, models_max: 10, cost: 150 },
    ]);
  });

  it("keys a range-priced tier at its floor and carries models_max (block pricing)", () => {
    // Venatari shape: 3 models @160, or 4–6 models @320 — the 4–6 build is one
    // tier at a flat cost, floor 4 / ceiling 6.
    const d = mk({
      comps: [
        { id: "c3", pts: 160, models: 3 },
        { id: "c46", pts: 320, models: [4, 6] },
      ],
    });
    const { native, ambiguous } = deriveDatasheet(d, "ds");
    expect(ambiguous).toBe(false);
    expect(native).toEqual([
      { models: 3, models_max: 3, cost: 160 },
      { models: 4, models_max: 6, cost: 320 },
    ]);
  });

  it("routes referenceGrouping compositions to allied_points by host faction", () => {
    const d = mk({
      comps: [
        { id: "base", pts: 75, models: 1 },
        { id: "imp", pts: 110, models: 1, group: "kw-imp" },
      ],
      keywords: [{ id: "kw-imp", name: "Imperium" }],
    });
    const { native, allied } = deriveDatasheet(d, "ds");
    expect(native).toEqual([{ models: 1, models_max: 1, cost: 75 }]);
    expect(allied).toEqual([{ models: 1, models_max: 1, cost: 110, host_faction: "imperium" }]);
  });

  it("flags ambiguity when two native comps share a size at different costs", () => {
    const d = mk({
      comps: [
        { id: "a", pts: 80, models: 3 },
        { id: "b", pts: 85, models: 3 },
      ],
    });
    expect(deriveDatasheet(d, "ds").ambiguous).toBe(true);
  });

  it("flags ambiguity when tier ranges overlap at different costs (choice-based)", () => {
    // Outrider-ATV shape: a 4-model build and a 4–6 build disagree on cost at 4.
    const d = mk({
      comps: [
        { id: "a", pts: 130, models: 4 },
        { id: "b", pts: 140, models: [4, 6] },
      ],
    });
    expect(deriveDatasheet(d, "ds").ambiguous).toBe(true);
  });

  it("does not flag disjoint range tiers (a clean size partition)", () => {
    const d = mk({
      comps: [
        { id: "a", pts: 160, models: 3 },
        { id: "b", pts: 320, models: [4, 6] },
      ],
    });
    expect(deriveDatasheet(d, "ds").ambiguous).toBe(false);
  });
});
