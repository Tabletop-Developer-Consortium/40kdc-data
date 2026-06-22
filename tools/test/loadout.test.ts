import { describe, it, expect } from "vitest";

import { dataset } from "../src/data/index.js";
import {
  optionCap,
  baseLoadout,
  maximalLoadout,
  weaponBounds,
  clampWeaponCount,
  validateLoadout,
  checkUnitLegality,
  type LoadoutTier,
} from "../src/data/loadout.js";
import type { Unit, WargearOption } from "../src/generated.js";

const GV = { edition: "10th", dataslate: "2025-q3" };
function opt(p: Partial<WargearOption>): WargearOption {
  return { id: "x", unit_id: "u", game_version: GV, ...p } as WargearOption;
}

describe("optionCap", () => {
  it("per_n_models floors model_count / n", () => {
    expect(optionCap(opt({ model_constraint: { per_n_models: 5 } }), 10)).toBe(2);
    expect(optionCap(opt({ model_constraint: { per_n_models: 5 } }), 9)).toBe(1);
  });
  it("any_number → every model", () => {
    expect(optionCap(opt({ model_constraint: { any_number: true } }), 7)).toBe(7);
  });
  it("max_count alone defaults to a 1-model cap", () => {
    expect(optionCap(opt({ model_constraint: { max_count: 1 } }), 10)).toBe(1);
  });
  it("max_count clamps a ratio", () => {
    expect(optionCap(opt({ model_constraint: { per_n_models: 5, max_count: 1 } }), 20)).toBe(1);
  });
});

describe("optionCap — eligible-model clamp", () => {
  const models = [
    { name: "Champion", min: 1, max: 1, is_leader_model: true },
    { name: "Trooper", min: 4, max: 9 },
  ];
  it("caps a champion-scoped option at the champion count (1), not per_n_models", () => {
    // floor(10/5) = 2, but only 1 Champion exists → 1.
    expect(optionCap(opt({ model_constraint: { model_name: "Champion", per_n_models: 5 } }), 10, models)).toBe(1);
  });
  it("scopes any_number to the matching profile's count", () => {
    expect(optionCap(opt({ model_constraint: { model_name: "Champion", any_number: true } }), 10, models)).toBe(1);
  });
  it("leaves the cap unclamped when model_name matches no row", () => {
    expect(optionCap(opt({ model_constraint: { model_name: "Nobody", per_n_models: 5 } }), 10, models)).toBe(2);
  });
});

describe("validateLoadout — shared-allowance budgets", () => {
  const unit = (budgets: unknown) => ({ id: "u", wargear_budgets: budgets } as unknown as Unit);
  it("flags when summed budget items exceed floor(models * count / per_models)", () => {
    const u = unit([{ items: ["a", "b"], count: 1, per_models: 5 }]);
    const v = validateLoadout(u, 10, [], new Map([["a", 2], ["b", 1]])); // 3 > floor(10/5)=2
    expect(v.some((x) => x.code === "exceeds-allowance")).toBe(true);
  });
  it("passes exactly at the cap", () => {
    const u = unit([{ items: ["a", "b"], count: 1, per_models: 5 }]);
    expect(validateLoadout(u, 10, [], new Map([["a", 1], ["b", 1]]))).toEqual([]); // 2 == 2
  });
  it("uses an exact ratio — 3 per 5 → 6 at 10 models", () => {
    const u = unit([{ items: ["a"], count: 3, per_models: 5 }]);
    expect(validateLoadout(u, 10, [], new Map([["a", 6]]))).toEqual([]);
    expect(validateLoadout(u, 10, [], new Map([["a", 7]])).some((x) => x.code === "exceeds-allowance")).toBe(true);
  });
});

describe("baseLoadout — Khorne Berzerkers @ 10 (legal default)", () => {
  it("carries only the base weapons on every model, no swaps applied", () => {
    const bz = dataset.units.get("khorne-berzerkers")!;
    const options = dataset.wargearOptionsOf(bz.raw);
    const lo = baseLoadout(bz.raw, 10, options);
    // Base weapons (never a replacement) only — none of the swap/add-on ids.
    expect(Object.fromEntries(lo.counts)).toEqual({
      "bolt-pistol": 10,
      "chainblade": 10,
    });
    // The legal default is itself valid (the maximal take-every-swap set is not).
    expect(validateLoadout(bz.raw, 10, options, lo.counts)).toEqual([]);
  });
});

// The loadout *maths* (maximal/bounds/clamp/validate/swap-conflict) is exercised
// with synthetic options rather than a live unit: dump-primary wargear data is
// regenerated per ingest, so pinning a real unit's take-every-swap maximal would
// couple these maths tests to churning data. (Base loadout — the pinned contract
// — is still asserted against a real unit above; maximal is advisory per
// CONFORMANCE.) A 10-model squad whose models carry bolt-pistol + chainblade,
// with two per-5 swaps and a one-per-unit add-on.
const SYN_UNIT = { weapon_ids: ["bolt-pistol", "chainblade"] } as never;
const SYN_OPTS: WargearOption[] = [
  opt({ replaces: ["bolt-pistol"], replacement: ["plasma-pistol"], model_constraint: { per_n_models: 5 } }),
  opt({ replaces: ["chainblade"], replacement: ["khornate-eviscerator"], model_constraint: { per_n_models: 5 } }),
  opt({ replacement: ["icon-of-khorne"], model_constraint: { max_count: 1 } }),
];

describe("maximalLoadout — synthetic dogfood target", () => {
  it("applies every swap at its cap and the add-on once", () => {
    const lo = maximalLoadout(SYN_UNIT, 10, SYN_OPTS);
    expect(Object.fromEntries(lo.counts)).toEqual({
      "bolt-pistol": 8, // 10 base − 2 swapped to plasma
      "plasma-pistol": 2, // per-5 cap at 10 models
      chainblade: 8, // 10 base − 2 swapped to eviscerator
      "khornate-eviscerator": 2,
      "icon-of-khorne": 1, // add-on, max 1
    });
  });
});

describe("weaponBounds + clampWeaponCount + validateLoadout", () => {
  it("caps a replacement weapon at its max and a base weapon at model_count", () => {
    const bounds = weaponBounds(SYN_UNIT, 10, SYN_OPTS);
    // plasma pistol: per-5 → 2 max
    expect(bounds.get("plasma-pistol")).toEqual({ min: 0, max: 2 });
    // bolt pistol: base 10, up to 2 swapped away
    expect(bounds.get("bolt-pistol")).toEqual({ min: 8, max: 10 });
  });

  it("clamps an over-cap request down to the max", () => {
    const bounds = weaponBounds(SYN_UNIT, 10, SYN_OPTS);
    expect(clampWeaponCount(bounds, "plasma-pistol", 4)).toBe(2);
    expect(clampWeaponCount(bounds, "plasma-pistol", 1)).toBe(1);
  });

  it("flags an over-cap loadout", () => {
    const violations = validateLoadout(SYN_UNIT, 10, SYN_OPTS, new Map([["plasma-pistol", 4]]));
    expect(violations).toEqual([
      { id: "plasma-pistol", code: "exceeds-max", message: "plasma-pistol: 4 exceeds max 2" },
    ]);
  });

  it("accepts the maximal loadout as valid", () => {
    const lo = maximalLoadout(SYN_UNIT, 10, SYN_OPTS);
    expect(validateLoadout(SYN_UNIT, 10, SYN_OPTS, lo.counts)).toEqual([]);
  });

  it("flags a swap conflict: base weapon kept while its replacement is also taken", () => {
    // A lone plain single-target swap (base weapon → one replacement, max 1): a
    // model takes one or the other, never both. Each id sits independently within
    // [0,1], so only the swap-conservation check catches keeping both.
    const unit = { weapon_ids: ["diabolus-heavy-stubber"] } as never;
    const opts = [
      opt({
        replaces: ["diabolus-heavy-stubber"],
        replacement: ["havoc-multi-launcher"],
        model_constraint: { max_count: 1 },
      }),
    ];
    expect(
      validateLoadout(
        unit,
        1,
        opts,
        new Map([
          ["diabolus-heavy-stubber", 1],
          ["havoc-multi-launcher", 1],
        ]),
      ),
    ).toEqual([
      {
        id: "diabolus-heavy-stubber",
        code: "swap-conflict",
        message:
          "diabolus-heavy-stubber and its swap replacement(s) total 2, exceeding 1 (a model takes the base weapon or a swap, not both)",
      },
    ]);
    // Either single choice is legal.
    expect(validateLoadout(unit, 1, opts, new Map([["diabolus-heavy-stubber", 1]]))).toEqual([]);
    expect(validateLoadout(unit, 1, opts, new Map([["havoc-multi-launcher", 1]]))).toEqual([]);
  });
});

describe("weaponBounds + maximalLoadout — single-weapon flat budgets", () => {
  // A 1-model unit with two independent swap slots that can each add the same
  // weapon (the Knight Destrier: chastiser gatling cannon AND frag bombard can
  // each become a bellatus reaper chainsword). Without the flat-budget clamp the
  // weapon sums to 2 across the two slots — an illegal count the salvo calculator
  // would seed. The "max one" rule is modelled as a single-item per-unit budget.
  const unit = {
    weapon_ids: ["gun-a", "gun-b"],
    wargear_budgets: [{ items: ["sword"], count: 1, per_models: 0 }],
  } as unknown as Unit;
  const opts = [
    opt({ replaces: ["gun-a"], replacement: ["sword"], model_constraint: { any_number: true } }),
    opt({ replaces: ["gun-b"], replacement: ["sword"], model_constraint: { any_number: true } }),
  ];

  it("caps the weapon's bound max at the budget, not the sum of slots", () => {
    const bounds = weaponBounds(unit, 1, opts);
    expect(bounds.get("sword")).toEqual({ min: 0, max: 1 });
  });

  it("caps the maximal loadout count at the budget", () => {
    expect(maximalLoadout(unit, 1, opts).counts.get("sword")).toBe(1);
  });

  it("clamps a user input down to the budgeted max", () => {
    const bounds = weaponBounds(unit, 1, opts);
    expect(clampWeaponCount(bounds, "sword", 2)).toBe(1);
  });

  it("leaves a shared (multi-item) budget to validateLoadout", () => {
    // Two distinct weapons sharing one allowance must not be clamped per-id here.
    const shared = {
      weapon_ids: ["gun-a", "gun-b"],
      wargear_budgets: [{ items: ["sword", "spear"], count: 1, per_models: 0 }],
    } as unknown as Unit;
    const sharedOpts = [
      opt({ replaces: ["gun-a"], replacement: ["sword"], model_constraint: { any_number: true } }),
      opt({ replaces: ["gun-b"], replacement: ["spear"], model_constraint: { any_number: true } }),
    ];
    expect(weaponBounds(shared, 1, sharedOpts).get("sword")).toEqual({ min: 0, max: 1 });
    expect(weaponBounds(shared, 1, sharedOpts).get("spear")).toEqual({ min: 0, max: 1 });
  });
});

describe("checkUnitLegality — tier selection", () => {
  // Neurogaunts: 1 Nodebeast + 10, or 1 + 11–20, or 2 + 20. A roster carries only
  // the total model count, so the tier that admits 22 is the one with 2 Nodebeasts.
  const unit = { id: "neurogaunts" } as unknown as Unit;
  const models = [
    { name: "Neurogaunt Nodebeast", min: 1, max: 2, is_leader_model: true },
    { name: "Neurogaunt", min: 10, max: 20 },
  ];
  const tiers: LoadoutTier[] = [
    { models: [{ name: "Neurogaunt Nodebeast", min: 1, max: 1 }, { name: "Neurogaunt", min: 10, max: 10 }] },
    { models: [{ name: "Neurogaunt Nodebeast", min: 1, max: 1 }, { name: "Neurogaunt", min: 11, max: 20 }] },
    { models: [{ name: "Neurogaunt Nodebeast", min: 2, max: 2 }, { name: "Neurogaunt", min: 20, max: 20 }] },
  ];

  it("accepts a size that matches a tier", () => {
    expect(checkUnitLegality(unit, 22, [], new Map(), models, tiers)).toEqual([]);
    expect(checkUnitLegality(unit, 11, [], new Map(), models, tiers)).toEqual([]);
    expect(checkUnitLegality(unit, 15, [], new Map(), models, tiers)).toEqual([]);
  });

  it("flags invalid-model-count when the size matches no tier", () => {
    const v = checkUnitLegality(unit, 23, [], new Map(), models, tiers);
    expect(v).toEqual([
      { id: "neurogaunts", code: "invalid-model-count", message: "neurogaunts: 23 models matches no composition tier" },
    ]);
    // 21 is reachable (tier 1: 1 Nodebeast + 11–20 → total 12–21).
    expect(checkUnitLegality(unit, 21, [], new Map(), models, tiers)).toEqual([]);
  });

  it("is legal iff some containing tier validates clean", () => {
    // A 1-per-5 budget: at 22 models the only containing tier is {2 + 20}, allowing
    // floor(22/5)=4. 5 copies exceeds it under every containing tier → flagged.
    const u = { id: "neurogaunts", wargear_budgets: [{ items: ["spike"], count: 1, per_models: 5 }] } as unknown as Unit;
    expect(checkUnitLegality(u, 22, [], new Map([["spike", 4]]), models, tiers)).toEqual([]);
    expect(checkUnitLegality(u, 22, [], new Map([["spike", 5]]), models, tiers)[0].code).toBe("exceeds-allowance");
  });

  it("falls back to a plain validateLoadout (no size check) when no tiers are supplied", () => {
    // 99 models, no tiers → no invalid-model-count; behaves like validateLoadout.
    expect(checkUnitLegality(unit, 99, [], new Map(), models)).toEqual([]);
  });
});

describe("wargearOptionsOf accessor", () => {
  it("returns options for a unit and empty for one without", () => {
    const bz = dataset.units.get("khorne-berzerkers")!;
    expect(dataset.wargearOptionsOf(bz.raw).length).toBeGreaterThan(0);
    expect(bz.wargearOptions.length).toBe(dataset.wargearOptionsOf(bz.raw).length);
  });
});
