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
  groupLoadout,
  completeLoadout,
  loadoutCandidates,
  type LoadoutTier,
} from "../src/data/loadout.js";
import type { Unit, WargearOption } from "../src/generated.js";

const GV = { edition: "10th", dataslate: "2025-q3" };
function opt(p: Partial<WargearOption>): WargearOption {
  return { id: "x", unit_id: "u", game_version: GV, ...p } as WargearOption;
}

describe("optionCap", () => {
  it("per_n_models floors model_count / n", () => {
    expect(optionCap(opt({ model_constraint: { per_n_models: 5 } }), 10)).toBe(
      2,
    );
    expect(optionCap(opt({ model_constraint: { per_n_models: 5 } }), 9)).toBe(
      1,
    );
  });
  it("any_number → every model", () => {
    expect(optionCap(opt({ model_constraint: { any_number: true } }), 7)).toBe(
      7,
    );
  });
  it("max_count alone defaults to a 1-model cap", () => {
    expect(optionCap(opt({ model_constraint: { max_count: 1 } }), 10)).toBe(1);
  });
  it("max_count clamps a ratio", () => {
    expect(
      optionCap(
        opt({ model_constraint: { per_n_models: 5, max_count: 1 } }),
        20,
      ),
    ).toBe(1);
  });
});

describe("optionCap — eligible-model clamp", () => {
  const models = [
    { name: "Champion", min: 1, max: 1, is_leader_model: true },
    { name: "Trooper", min: 4, max: 9 },
  ];
  it("caps a champion-scoped option at the champion count (1), not per_n_models", () => {
    // floor(10/5) = 2, but only 1 Champion exists → 1.
    expect(
      optionCap(
        opt({ model_constraint: { model_name: "Champion", per_n_models: 5 } }),
        10,
        models,
      ),
    ).toBe(1);
  });
  it("scopes any_number to the matching profile's count", () => {
    expect(
      optionCap(
        opt({ model_constraint: { model_name: "Champion", any_number: true } }),
        10,
        models,
      ),
    ).toBe(1);
  });
  it("leaves the cap unclamped when model_name matches no row", () => {
    expect(
      optionCap(
        opt({ model_constraint: { model_name: "Nobody", per_n_models: 5 } }),
        10,
        models,
      ),
    ).toBe(2);
  });
});

describe("validateLoadout — shared-allowance budgets", () => {
  const unit = (budgets: unknown) =>
    ({ id: "u", wargear_budgets: budgets }) as unknown as Unit;
  it("flags when summed budget items exceed floor(models * count / per_models)", () => {
    const u = unit([{ items: ["a", "b"], count: 1, per_models: 5 }]);
    const v = validateLoadout(
      u,
      10,
      [],
      new Map([
        ["a", 2],
        ["b", 1],
      ]),
    ); // 3 > floor(10/5)=2
    expect(v.some((x) => x.code === "exceeds-allowance")).toBe(true);
  });
  it("passes exactly at the cap", () => {
    const u = unit([{ items: ["a", "b"], count: 1, per_models: 5 }]);
    expect(
      validateLoadout(
        u,
        10,
        [],
        new Map([
          ["a", 1],
          ["b", 1],
        ]),
      ),
    ).toEqual([]); // 2 == 2
  });
  it("uses an exact ratio — 3 per 5 → 6 at 10 models", () => {
    const u = unit([{ items: ["a"], count: 3, per_models: 5 }]);
    expect(validateLoadout(u, 10, [], new Map([["a", 6]]))).toEqual([]);
    expect(
      validateLoadout(u, 10, [], new Map([["a", 7]])).some(
        (x) => x.code === "exceeds-allowance",
      ),
    ).toBe(true);
  });
});

describe("validateLoadout — per-item duplicate sub-cap", () => {
  const unit = (budgets: unknown) =>
    ({ id: "u", wargear_budgets: budgets }) as unknown as Unit;

  // The Cadian special-weapon rule: 4 special weapons per 20 models (shared), but
  // no more than 2 of the SAME weapon (duplicate_limit 1 per 10 models → 2 at 20).
  const cadian = [
    { items: ["a", "b"], count: 2, per_models: 10, duplicate_limit: 1 },
  ];

  it("flags 4 identical items even though the shared cap of 4 is met at 20 models", () => {
    const u = unit(cadian);
    const v = validateLoadout(u, 20, [], new Map([["a", 4]]));
    // Shared cap floor(20*2/10)=4 satisfied, but per-item cap floor(20*1/10)=2 is not.
    expect(v.some((x) => x.code === "exceeds-allowance" && x.id === "a")).toBe(
      true,
    );
  });

  it("passes 2 of each — within both the shared cap (4) and the per-item cap (2)", () => {
    const u = unit(cadian);
    expect(
      validateLoadout(
        u,
        20,
        [],
        new Map([
          ["a", 2],
          ["b", 2],
        ]),
      ),
    ).toEqual([]);
  });

  it("still enforces the shared cap when each item is under its duplicate cap", () => {
    const u = unit([
      { items: ["a", "b", "c"], count: 2, per_models: 10, duplicate_limit: 1 },
    ]);
    // a=1,b=1,c=1 → shared 3 > floor(20*2/10)=4? no; but at 10 models shared cap is 2.
    const v = validateLoadout(
      u,
      10,
      [],
      new Map([
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ]),
    );
    expect(
      v.some((x) => x.code === "exceeds-allowance" && x.id.includes("+")),
    ).toBe(true);
  });

  it("applies a flat per-item cap when per_models is 0", () => {
    const u = unit([
      { items: ["a", "b"], count: 4, per_models: 0, duplicate_limit: 2 },
    ]);
    expect(
      validateLoadout(
        u,
        20,
        [],
        new Map([
          ["a", 2],
          ["b", 2],
        ]),
      ),
    ).toEqual([]); // 2 each ok
    expect(
      validateLoadout(
        u,
        20,
        [],
        new Map([
          ["a", 3],
          ["b", 1],
        ]),
      ).some((x) => x.id === "a"),
    ).toBe(true);
  });

  it("is a no-op when duplicate_limit is absent (any one item may fill the allowance)", () => {
    const u = unit([{ items: ["a", "b"], count: 4, per_models: 10 }]);
    // Shared cap floor(20*4/10)=8; only the shared cap applies with no dup limit.
    expect(
      validateLoadout(u, 20, [], new Map([["a", 9]])).some(
        (x) => x.code === "exceeds-allowance",
      ),
    ).toBe(true);
    expect(validateLoadout(u, 20, [], new Map([["a", 8]]))).toEqual([]); // 8 of one is fine w/o dup cap
  });
});

describe("baseLoadout — Khorne Berzerkers @ 10 (legal default)", () => {
  it("carries only the base weapons on every model, no swaps applied", () => {
    const bz = dataset.units.getAny("khorne-berzerkers")!;
    const options = dataset.wargearOptionsOf(bz.raw);
    const lo = baseLoadout(bz.raw, 10, options);
    // Base weapons (never a replacement) only — none of the swap/add-on ids.
    expect(Object.fromEntries(lo.counts)).toEqual({
      "bolt-pistol-khorne-berzerkers": 10,
      chainblade: 10,
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
  opt({
    replaces: ["bolt-pistol"],
    replacement: ["plasma-pistol"],
    model_constraint: { per_n_models: 5 },
  }),
  opt({
    replaces: ["chainblade"],
    replacement: ["khornate-eviscerator"],
    model_constraint: { per_n_models: 5 },
  }),
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
    const violations = validateLoadout(
      SYN_UNIT,
      10,
      SYN_OPTS,
      new Map([["plasma-pistol", 4]]),
    );
    expect(violations).toEqual([
      {
        id: "plasma-pistol",
        code: "exceeds-max",
        message: "plasma-pistol: 4 exceeds max 2",
      },
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
    expect(
      validateLoadout(unit, 1, opts, new Map([["diabolus-heavy-stubber", 1]])),
    ).toEqual([]);
    expect(
      validateLoadout(unit, 1, opts, new Map([["havoc-multi-launcher", 1]])),
    ).toEqual([]);
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
    opt({
      replaces: ["gun-a"],
      replacement: ["sword"],
      model_constraint: { any_number: true },
    }),
    opt({
      replaces: ["gun-b"],
      replacement: ["sword"],
      model_constraint: { any_number: true },
    }),
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
      opt({
        replaces: ["gun-a"],
        replacement: ["sword"],
        model_constraint: { any_number: true },
      }),
      opt({
        replaces: ["gun-b"],
        replacement: ["spear"],
        model_constraint: { any_number: true },
      }),
    ];
    expect(weaponBounds(shared, 1, sharedOpts).get("sword")).toEqual({
      min: 0,
      max: 1,
    });
    expect(weaponBounds(shared, 1, sharedOpts).get("spear")).toEqual({
      min: 0,
      max: 1,
    });
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
    {
      models: [
        { name: "Neurogaunt Nodebeast", min: 1, max: 1 },
        { name: "Neurogaunt", min: 10, max: 10 },
      ],
    },
    {
      models: [
        { name: "Neurogaunt Nodebeast", min: 1, max: 1 },
        { name: "Neurogaunt", min: 11, max: 20 },
      ],
    },
    {
      models: [
        { name: "Neurogaunt Nodebeast", min: 2, max: 2 },
        { name: "Neurogaunt", min: 20, max: 20 },
      ],
    },
  ];

  it("accepts a size that matches a tier", () => {
    expect(checkUnitLegality(unit, 22, [], new Map(), models, tiers)).toEqual(
      [],
    );
    expect(checkUnitLegality(unit, 11, [], new Map(), models, tiers)).toEqual(
      [],
    );
    expect(checkUnitLegality(unit, 15, [], new Map(), models, tiers)).toEqual(
      [],
    );
  });

  it("flags invalid-model-count when the size matches no tier", () => {
    const v = checkUnitLegality(unit, 23, [], new Map(), models, tiers);
    expect(v).toEqual([
      {
        id: "neurogaunts",
        code: "invalid-model-count",
        message: "neurogaunts: 23 models matches no composition tier",
      },
    ]);
    // 21 is reachable (tier 1: 1 Nodebeast + 11–20 → total 12–21).
    expect(checkUnitLegality(unit, 21, [], new Map(), models, tiers)).toEqual(
      [],
    );
  });

  it("is legal iff some containing tier validates clean", () => {
    // A 1-per-5 budget: at 22 models the only containing tier is {2 + 20}, allowing
    // floor(22/5)=4. 5 copies exceeds it under every containing tier → flagged.
    const u = {
      id: "neurogaunts",
      wargear_budgets: [{ items: ["spike"], count: 1, per_models: 5 }],
    } as unknown as Unit;
    expect(
      checkUnitLegality(u, 22, [], new Map([["spike", 4]]), models, tiers),
    ).toEqual([]);
    expect(
      checkUnitLegality(u, 22, [], new Map([["spike", 5]]), models, tiers)[0]
        .code,
    ).toBe("exceeds-allowance");
  });

  it("falls back to a plain validateLoadout (no size check) when no tiers are supplied", () => {
    // 99 models, no tiers → no invalid-model-count; behaves like validateLoadout.
    expect(checkUnitLegality(unit, 99, [], new Map(), models)).toEqual([]);
  });
});

describe("wargearOptionsOf accessor", () => {
  it("returns options for a unit and empty for one without", () => {
    const bz = dataset.units.getAny("khorne-berzerkers")!;
    expect(dataset.wargearOptionsOf(bz.raw).length).toBeGreaterThan(0);
    expect(bz.wargearOptions.length).toBe(
      dataset.wargearOptionsOf(bz.raw).length,
    );
  });
});

describe("loadoutCandidates", () => {
  const unit = { id: "u", weapon_ids: [] } as unknown as Unit;
  const models = [
    { name: "Leader", min: 1, max: 1, default_weapon_ids: ["pistol"] },
    { name: "Trooper", min: 1, max: 3, default_weapon_ids: ["rifle", "knife"] },
    {
      name: "Specialist",
      min: 0,
      max: 2,
      default_weapon_ids: ["special", "knife"],
    },
  ];

  it("enumerates every bounded model-row allocation in stable encoded order", () => {
    expect(loadoutCandidates(unit, 4, [], models)).toEqual([
      "Leader×1;Trooper×1;Specialist×2 => knife:3,pistol:1,rifle:1,special:2",
      "Leader×1;Trooper×2;Specialist×1 => knife:3,pistol:1,rifle:2,special:1",
      "Leader×1;Trooper×3 => knife:3,pistol:1,rifle:3",
    ]);
  });

  it("truncates after sorting and appends the protocol marker", () => {
    expect(loadoutCandidates(unit, 4, [], models, undefined, 1)).toEqual([
      "Leader×1;Trooper×1;Specialist×2 => knife:3,pistol:1,rifle:1,special:2",
      "…truncated",
    ]);
  });

  it("uses only tiers containing the requested model count", () => {
    const tiers = [
      {
        models: [
          { name: "Leader", min: 1, max: 1 },
          { name: "Trooper", min: 2, max: 2 },
          { name: "Specialist", min: 1, max: 1 },
        ],
      },
    ];
    expect(loadoutCandidates(unit, 4, [], models, tiers)).toEqual([
      "Leader×1;Trooper×2;Specialist×1 => knife:3,pistol:1,rifle:2,special:1",
    ]);
    expect(loadoutCandidates(unit, 5, [], models, tiers)).toEqual([]);
  });

  it("matches baseLoadout for a variant-free single allocation", () => {
    const term = dataset.units.getInFaction(
      "chaos-terminators",
      "world-eaters",
    )!.raw;
    const options = dataset.wargearOptionsOf(term);
    const comp = dataset.unitCompositionOf(term)!;
    const candidate = loadoutCandidates(
      term,
      5,
      options,
      comp.models,
      comp.tiers,
    )[0];
    const encodedBase = [...baseLoadout(term, 5, options, comp.models).counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, count]) => `${id}:${count}`)
      .join(",");
    expect(candidate.split(" => ")[1]).toBe(encodedBase);
  });
});

describe("groupLoadout", () => {
  const u = (p: Partial<Unit> = {}) => ({ id: "u", ...p }) as Unit;
  const summarize = (gs: ReturnType<typeof groupLoadout>) =>
    gs?.map(
      (g) =>
        `${g.count}x ${g.model_name}: ${g.weapons.map((w) => `${w.count}:${w.id}`).join(",")}`,
    );

  it("returns null for single-model units and units without recorded per-model defaults", () => {
    const models = [{ name: "A", min: 1, max: 1, default_weapon_ids: ["x"] }];
    expect(groupLoadout(u(), 1, [], models, new Map([["x", 1]]))).toBeNull();
    // model_count 3 but no default_weapon_ids → can't partition → null.
    expect(
      groupLoadout(
        u(),
        3,
        [],
        [{ name: "A", min: 3, max: 3 }],
        new Map([["x", 3]]),
      ),
    ).toBeNull();
  });

  it("splits a leader model from the bulk even when loadouts match", () => {
    const models = [
      {
        name: "Champion",
        min: 1,
        max: 1,
        is_leader_model: true,
        default_weapon_ids: ["bolter", "ccw"],
      },
      {
        name: "Trooper",
        min: 4,
        max: 9,
        default_weapon_ids: ["bolter", "ccw"],
      },
    ];
    const counts = new Map([
      ["bolter", 10],
      ["ccw", 10],
    ]);
    expect(summarize(groupLoadout(u(), 10, [], models, counts))).toEqual([
      "1x Champion: 1:bolter,1:ccw",
      "9x Trooper: 1:bolter,1:ccw",
    ]);
  });

  it("reconstructs an option swap into its own sub-group", () => {
    const models = [
      {
        name: "Herald",
        min: 1,
        max: 1,
        is_leader_model: true,
        default_weapon_ids: ["pistol", "blade", "ccw"],
      },
      {
        name: "Grunt",
        min: 7,
        max: 7,
        default_weapon_ids: ["pistol", "blade", "ccw"],
      },
    ];
    const options = [
      opt({
        replaces: ["blade"],
        replacement: ["harpoon"],
        model_constraint: { model_name: "Grunt", max_count: 1 },
      }),
    ];
    // 8 models, base = 8×{pistol,blade,ccw}; one Grunt swapped blade→harpoon.
    const counts = new Map([
      ["pistol", 8],
      ["blade", 7],
      ["ccw", 8],
      ["harpoon", 1],
    ]);
    expect(summarize(groupLoadout(u(), 8, options, models, counts))).toEqual([
      "1x Herald: 1:blade,1:ccw,1:pistol",
      "6x Grunt: 1:blade,1:ccw,1:pistol",
      "1x Grunt: 1:ccw,1:harpoon,1:pistol",
    ]);
  });

  it("applies a capped add-on option more than once to one eligible model", () => {
    const models = [
      { name: "Leader", min: 1, max: 1, default_weapon_ids: ["rifle"] },
      { name: "Trooper", min: 2, max: 2, default_weapon_ids: ["rifle"] },
    ];
    const options = [
      opt({
        replacement_choice: [["shield-drone"], ["gun-drone"]],
        model_constraint: {
          model_name: "Leader",
          any_number: true,
          max_count: 2,
        },
      }),
    ];
    const counts = new Map([
      ["rifle", 3],
      ["shield-drone", 2],
    ]);

    expect(summarize(groupLoadout(u(), 3, options, models, counts))).toEqual([
      "1x Leader: 1:rifle,2:shield-drone",
      "2x Trooper: 1:rifle",
    ]);
  });

  it("infers opt-in weapon-variant rows from their distinctive default weapon", () => {
    const models = [
      {
        name: "Sgt",
        min: 1,
        max: 1,
        is_leader_model: true,
        default_weapon_ids: ["pistol", "rifle", "ccw"],
      },
      {
        name: "Trooper",
        min: 2,
        max: 9,
        default_weapon_ids: ["pistol", "rifle", "ccw"],
      },
      {
        name: "Plasma",
        min: 0,
        max: 4,
        default_weapon_ids: ["pistol", "plasma", "ccw"],
      },
    ];
    // 6 models: counts imply 2 plasma models; the rest fill Sgt(1)+Trooper(3).
    const counts = new Map([
      ["pistol", 6],
      ["rifle", 4],
      ["ccw", 6],
      ["plasma", 2],
    ]);
    expect(summarize(groupLoadout(u(), 6, [], models, counts))).toEqual([
      "1x Sgt: 1:ccw,1:pistol,1:rifle",
      "3x Trooper: 1:ccw,1:pistol,1:rifle",
      "2x Plasma: 1:ccw,1:pistol,1:plasma",
    ]);
  });

  it("returns null when leftover counts can't be explained (inexact)", () => {
    const models = [{ name: "A", min: 2, max: 2, default_weapon_ids: ["x"] }];
    // an unexplained extra weapon → no exact decomposition.
    expect(
      groupLoadout(
        u(),
        2,
        [],
        models,
        new Map([
          ["x", 2],
          ["mystery", 1],
        ]),
      ),
    ).toBeNull();
  });

  it("decomposes real dataset units (Goremongers, Chaos Terminators)", () => {
    const gore = dataset.units.getInFaction("goremongers", "world-eaters")!.raw;
    const gOpts = dataset.wargearOptionsOf(gore);
    const gModels = dataset.unitCompositionOf(gore)?.models;
    const gCounts = baseLoadout(gore, 8, gOpts, gModels).counts;
    expect(summarize(groupLoadout(gore, 8, gOpts, gModels, gCounts))).toEqual([
      "1x Blood Herald: 1:autopistol,1:chainblade-goremongers,1:close-combat-weapon-goremongers",
      "7x Goremongers: 1:autopistol,1:chainblade-goremongers,1:close-combat-weapon-goremongers",
    ]);

    const term = dataset.units.getInFaction(
      "chaos-terminators",
      "world-eaters",
    )!.raw;
    const tOpts = dataset.wargearOptionsOf(term);
    const tModels = dataset.unitCompositionOf(term)?.models;
    const tCounts = baseLoadout(term, 10, tOpts, tModels).counts;
    expect(summarize(groupLoadout(term, 10, tOpts, tModels, tCounts))).toEqual([
      "1x World Eaters Terminator Champion: 1:accursed-weapon,1:combi-bolter",
      "9x World Eaters Terminator: 1:accursed-weapon,1:combi-bolter",
    ]);
  });

  it("decomposes a mixed-loadout 10-model unit a greedy peeler dead-ends on", () => {
    // 10 Chaos Terminators with two Paired (both-slot) models plus an assortment of
    // ranged/melee swaps. A valid partition exists; the old greedy mis-committed
    // combi-weapons and bailed. The complete solver must find an exact partition.
    const term = dataset.units.getInFaction(
      "chaos-terminators",
      "world-eaters",
    )!.raw;
    const tOpts = dataset.wargearOptionsOf(term);
    const tModels = dataset.unitCompositionOf(term)?.models;
    const counts = new Map([
      ["reaper-autocannon-chaos-terminators", 2],
      ["power-fist", 6],
      ["paired-accursed-weapons", 2],
      ["chainfist", 2],
      ["combi-weapon", 6],
    ]);
    const groups = groupLoadout(term, 10, tOpts, tModels, counts);
    expect(groups).not.toBeNull();
    // Exactly 10 models, and the per-group weapons sum back to the input bag.
    expect(groups!.reduce((n, g) => n + g.count, 0)).toBe(10);
    const totals = new Map<string, number>();
    for (const g of groups!) {
      for (const w of g.weapons)
        totals.set(w.id, (totals.get(w.id) ?? 0) + w.count * g.count);
    }
    expect(totals).toEqual(counts);
  });
  it("prunes impossible addon candidates without losing an exact cover", () => {
    const models = [
      { name: "Trooper", min: 5, max: 5, default_weapon_ids: ["rifle"] },
    ];
    const validSwap = opt({
      id: "plasma-swap",
      replaces: ["rifle"],
      replacement: ["plasma"],
      model_constraint: { max_count: 1 },
    });
    const deadAddons = Array.from({ length: 14 }, (_, index) =>
      opt({
        id: `dead-addon-${index}`,
        replacement: [`missing-${index}`],
        model_constraint: { any_number: true },
      }),
    );
    const counts = new Map([
      ["rifle", 4],
      ["plasma", 1],
    ]);

    expect(
      summarize(
        groupLoadout(u(), 5, [validSwap, ...deadAddons], models, counts),
      ),
    ).toEqual(["4x Trooper: 1:rifle", "1x Trooper: 1:plasma"]);
  });

  it("completes omitted defaults around an explicit swap", () => {
    const models = [
      {
        name: "Trooper",
        min: 5,
        max: 5,
        default_weapon_ids: ["rifle", "knife"],
      },
    ];
    const options = [
      opt({
        id: "plasma-swap",
        replaces: ["rifle"],
        replacement: ["plasma"],
        model_constraint: { max_count: 1 },
      }),
    ];
    const completed = completeLoadout(
      u(),
      5,
      options,
      models,
      new Map([["plasma", 1]]),
    );

    expect(completed?.counts).toEqual(
      new Map([
        ["knife", 5],
        ["plasma", 1],
        ["rifle", 4],
      ]),
    );
    expect(summarize(completed?.groups ?? null)).toEqual([
      "4x Trooper: 1:knife,1:rifle",
      "1x Trooper: 1:knife,1:plasma",
    ]);
  });

  it("does not invent an optional add-on omitted from the source", () => {
    const models = [
      { name: "Trooper", min: 2, max: 2, default_weapon_ids: ["rifle"] },
    ];
    const options = [
      opt({
        id: "optional-banner",
        replacement: ["banner"],
        model_constraint: { max_count: 1 },
      }),
    ];
    const completed = completeLoadout(u(), 2, options, models, new Map());

    expect(completed?.counts).toEqual(new Map([["rifle", 2]]));
    expect(completed?.counts.has("banner")).toBe(false);
  });

  it("derives a repeated branch co-item instead of keeping an exporter duplicate", () => {
    const models = [
      {
        name: "Trooper",
        min: 5,
        max: 5,
        default_weapon_ids: ["rifle", "pistol"],
      },
    ];
    const options = [
      opt({
        id: "special-swap",
        replaces: ["rifle"],
        replacement_choice: [
          ["heavy", "close-combat"],
          ["melta", "close-combat"],
          ["plasma", "close-combat"],
        ],
        model_constraint: { any_number: true },
      }),
    ];
    const completed = completeLoadout(
      u(),
      5,
      options,
      models,
      new Map([
        ["pistol", 5],
        ["rifle", 2],
        ["heavy", 2],
        ["melta", 1],
        ["close-combat", 4],
      ]),
    );

    expect(completed?.counts).toEqual(
      new Map([
        ["close-combat", 3],
        ["heavy", 2],
        ["melta", 1],
        ["pistol", 5],
        ["rifle", 2],
      ]),
    );
  });
});
