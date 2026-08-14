import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import { deriveWargear, withinEditDistance1, dumpComposition, reconcileModels, makeResolver, limitedSetBudgets, wargearItemsForDatasheet } from "../src/mfm/wargear.js";
import { mintWeapon } from "../src/mfm/gear-projection.js";

/**
 * A hand-built minimal dump exercising the full derivation: two model types
 * (a capped leader + bulk), a base loadout each, a per-model loadout choice with
 * a heavy-weapon branch, and a 1-per-5 squad cap. Mirrors the shape verified
 * against World Eaters Chaos Terminators.
 */
describe("mintWeapon", () => {
  it("projects a source weapon profile into the core schema shape", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "weapon", wargearType: "weapon", localisations: { en: { name: "Fabricated axe" } } },
        ],
        wargear_item_profile: [
          {
            id: "profile",
            wargearItemId: "weapon",
            displayOrder: 1,
            type: "melee",
            range: "Melee",
            attacks: "4",
            ballisticSkill: null,
            weaponSkill: "3+",
            strength: "6",
            armourPenetration: "-2",
            damage: "2",
            localisations: { en: { name: "Fabricated axe" } },
          },
        ],
        wargear_item_profile_wargear_ability: [],
        wargear_ability: [],
      },
    });
    const item = dump.byId("wargear_item").get("weapon")!;

    expect(
      mintWeapon(
        { dump, gv: { edition: "11th", dataslate: "launch" }, warnings: [] },
        item,
        "fabricated-axe",
        "Fabricated axe",
      ),
    ).toEqual({
      id: "fabricated-axe",
      name: "Fabricated axe",
      type: "melee",
      profiles: [
        {
          name: "Fabricated axe",
          range: "Melee",
          stats: { A: 4, WS: 3, S: 6, AP: -2, D: 2 },
        },
      ],
      game_version: { edition: "11th", dataslate: "launch" },
    });
  });
});

function fixtureDump(): MfmDump {
  const wi = (id: string, name: string) => ({ id, wargearType: "weapon", localisations: { en: { name } } });
  return new MfmDump({
    data: {
      miniature: [
        { id: "m-champ", displayOrder: 0, localisations: { en: { name: "Champion" } } },
        { id: "m-trooper", displayOrder: 1, localisations: { en: { name: "Trooper" } } },
      ],
      unit_composition: [
        { id: "uc1", datasheetId: "ds1", isDefault: true, displayOrder: 1, points: 100, referenceGroupingKeywordId: null },
      ],
      unit_composition_miniature: [
        { id: "ucm1", min: 1, max: 1, unitCompositionId: "uc1", miniatureId: "m-champ" },
        { id: "ucm2", min: 4, max: 9, unitCompositionId: "uc1", miniatureId: "m-trooper" },
      ],
      wargear_item: [
        wi("wi-bolter", "Combi-bolter"),
        wi("wi-blade", "Accursed weapon"),
        wi("wi-fist", "Power fist"),
        wi("wi-reaper", "Reaper autocannon"),
      ],
      // Base loadout lives in default>0 option groups (the authoritative model).
      // One base group per miniature; each group is all-default>0.
      wargear_option_group: [
        { id: "g-champ", displayOrder: 1, datasheetId: "ds1", miniatureId: "m-champ", isStaticWargear: false },
        { id: "g-troop", displayOrder: 2, datasheetId: "ds1", miniatureId: "m-trooper", isStaticWargear: false },
      ],
      wargear_option: [
        // Champion base slot: a single figure → checkboxes default 1 (1/1 model = 1 each).
        { id: "wo-c-bolter", wargearItemId: "wi-bolter", wargearOptionGroupId: "g-champ", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 1 },
        { id: "wo-c-blade", wargearItemId: "wi-blade", wargearOptionGroupId: "g-champ", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 2 },
        // Trooper base slot: a bulk model → steppers default = model count (4) → 1 each.
        { id: "wo-t-bolter", wargearItemId: "wi-bolter", wargearOptionGroupId: "g-troop", inputType: "stepper", defaultValue: 4, points: 0, displayOrder: 1 },
        { id: "wo-t-blade", wargearItemId: "wi-blade", wargearOptionGroupId: "g-troop", inputType: "stepper", defaultValue: 4, points: 0, displayOrder: 2 },
      ],
      loadout_choice_set: [
        { id: "lcs-trooper", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: "m-trooper", alternate: false },
      ],
      loadout_choice: [
        { id: "lc1", loadoutChoiceSetId: "lcs-trooper" },
        { id: "lc2", loadoutChoiceSetId: "lcs-trooper" },
      ],
      loadout_choice_wargear_item: [
        // branch 1 = the base (combi-bolter + accursed weapon) → excluded as no-op
        { id: "i1", count: 1, wargearItemId: "wi-bolter", loadoutChoiceId: "lc1" },
        { id: "i2", count: 1, wargearItemId: "wi-blade", loadoutChoiceId: "lc1" },
        // branch 2 = power fist + reaper autocannon
        { id: "i3", count: 1, wargearItemId: "wi-fist", loadoutChoiceId: "lc2" },
        { id: "i4", count: 1, wargearItemId: "wi-reaper", loadoutChoiceId: "lc2" },
      ],
      limited_wargear_choice_set: [
        { id: "lim1", mandatory: false, datasheetId: "ds1", miniatureId: "m-trooper" },
      ],
      limited_wargear_choice: [{ id: "lwc1", limitedWargearChoiceSetId: "lim1" }],
      limited_wargear_choice_wargear_item: [
        { id: "li1", count: 1, wargearItemId: "wi-reaper", limitedWargearChoiceId: "lwc1" },
      ],
      // 1 reaper per 5 models
      wargear_limit: [
        { id: "wl1", modelCount: 5, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim1" },
      ],
    },
  });
}

const VALID = new Set(["combi-bolter", "accursed-weapon", "power-fist", "reaper-autocannon"]);
const resolve = (name: string) => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return VALID.has(id) ? id : null;
};

describe("wargearItemsForDatasheet", () => {
  it("collects selectable non-weapon equipment from datasheet loadout paths", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "weapon", wargearType: "weapon", localisations: { en: { name: "Fabricated blade" } } },
          { id: "shield", wargearType: "wargear", localisations: { en: { name: "Fabricated shield" } } },
        ],
        wargear_option_group: [
          { id: "group", datasheetId: "datasheet", miniatureId: null, displayOrder: 1, isStaticWargear: false },
        ],
        wargear_option: [
          { id: "option", wargearItemId: "shield", wargearOptionGroupId: "group" },
        ],
        all_model_wargear_choice_set: [],
        all_model_wargear_choice: [],
        all_model_wargear_choice_wargear_item: [],
        loadout_choice_set: [],
        loadout_choice: [],
        loadout_choice_wargear_item: [],
        base_miniature_loadout: [],
        base_miniature_loadout_wargear_option: [],
        limited_wargear_choice_set: [],
        limited_wargear_choice: [],
        limited_wargear_choice_wargear_item: [],
      },
    });

    expect(
      wargearItemsForDatasheet(dump, "datasheet").map((item) => ({
        id: item.id,
        type: item.wargearType,
      })),
    ).toEqual([{ id: "shield", type: "wargear" }]);
  });
});

describe("deriveWargear", () => {
  const d = deriveWargear(fixtureDump(), "ds1", resolve);

  it("derives per-model default loadouts from default>0 option groups", () => {
    expect(d.defaultsByModel.get("Champion")).toEqual(["combi-bolter", "accursed-weapon"]);
    expect(d.defaultsByModel.get("Trooper")).toEqual(["combi-bolter", "accursed-weapon"]);
  });

  it("emits a per-model swap option that replaces the base and offers the non-base branch", () => {
    expect(d.options).toHaveLength(1);
    const o = d.options[0];
    expect(o.replaces).toEqual(["combi-bolter", "accursed-weapon"]);
    // The base branch is dropped as a no-op; the heavy branch remains.
    expect(o.replacement).toEqual(["power-fist", "reaper-autocannon"]);
    // 1-per-5 squad cap → per_n_models 5, scoped to the bulk model.
    expect(o.model_constraint).toEqual({ model_name: "Trooper", per_n_models: 5 });
  });

  it("leaves no orphan: every offered weapon is a default or reachable via an option", () => {
    const reach = new Set<string>();
    for (const id of d.defaultsByModel.get("Trooper") ?? []) reach.add(id);
    for (const o of d.options) {
      for (const id of o.replaces ?? []) reach.add(id);
      for (const id of o.replacement ?? []) reach.add(id);
      for (const g of o.replacement_choice ?? []) for (const id of g) reach.add(id);
    }
    for (const w of VALID) expect(reach.has(w), `${w} reachable`).toBe(true);
  });

  it("reports no unresolved names when the vocabulary is complete", () => {
    expect(d.unresolved).toEqual([]);
  });
});

/**
 * A single-model datasheet with TWO independently swappable base slots —
 *   slot A: bolt pistol → plasma pistol
 *   slot B: chainsword  → power fist
 * encoded (as the dump does) as ONE loadout_choice_set whose branches enumerate the
 * cross-product: base / A-only / B-only / A+B. Pins that deriveWargear factors each
 * branch into its per-slot DELTA vs the base loadout, so a single-slot swap replaces
 * ONLY that slot's base weapon — never the whole base set (the over-listing shape).
 */
function crossProductDump(): MfmDump {
  const wi = (id: string, name: string) => ({ id, wargearType: "weapon", localisations: { en: { name } } });
  const lcwi = (id: string, wargearItemId: string, loadoutChoiceId: string) => ({ id, count: 1, wargearItemId, loadoutChoiceId });
  return new MfmDump({
    data: {
      miniature: [{ id: "m-w", displayOrder: 0, localisations: { en: { name: "Warrior" } } }],
      unit_composition: [
        { id: "uc1", datasheetId: "ds1", isDefault: true, displayOrder: 1, points: 80, referenceGroupingKeywordId: null },
      ],
      unit_composition_miniature: [{ id: "ucm1", min: 1, max: 1, unitCompositionId: "uc1", miniatureId: "m-w" }],
      wargear_item: [
        wi("wi-bp", "Bolt pistol"),
        wi("wi-pp", "Plasma pistol"),
        wi("wi-cs", "Chainsword"),
        wi("wi-pf", "Power fist"),
      ],
      // Base loadout (default>0): bolt pistol + chainsword on the single model.
      wargear_option_group: [
        { id: "g-w", displayOrder: 1, datasheetId: "ds1", miniatureId: "m-w", isStaticWargear: false },
      ],
      wargear_option: [
        { id: "wo-bp", wargearItemId: "wi-bp", wargearOptionGroupId: "g-w", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 1 },
        { id: "wo-cs", wargearItemId: "wi-cs", wargearOptionGroupId: "g-w", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 2 },
      ],
      loadout_choice_set: [
        { id: "lcs-w", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: "m-w", alternate: false },
      ],
      loadout_choice: [
        { id: "lc1", loadoutChoiceSetId: "lcs-w" }, // base
        { id: "lc2", loadoutChoiceSetId: "lcs-w" }, // A-only
        { id: "lc3", loadoutChoiceSetId: "lcs-w" }, // B-only
        { id: "lc4", loadoutChoiceSetId: "lcs-w" }, // A+B
      ],
      loadout_choice_wargear_item: [
        lcwi("j1", "wi-bp", "lc1"), lcwi("j2", "wi-cs", "lc1"),
        lcwi("j3", "wi-pp", "lc2"), lcwi("j4", "wi-cs", "lc2"),
        lcwi("j5", "wi-bp", "lc3"), lcwi("j6", "wi-pf", "lc3"),
        lcwi("j7", "wi-pp", "lc4"), lcwi("j8", "wi-pf", "lc4"),
      ],
      // No squad caps for this single model — empty, but the keys must exist.
      limited_wargear_choice_set: [],
      limited_wargear_choice: [],
      limited_wargear_choice_wargear_item: [],
      wargear_limit: [],
    },
  });
}

describe("deriveWargear — multi-slot replaces delta (over-listing guard)", () => {
  const CP_VALID = new Set(["bolt-pistol", "plasma-pistol", "chainsword", "power-fist"]);
  const resolveCP = (name: string) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return CP_VALID.has(id) ? id : null;
  };

  it("factors a two-slot cross-product into per-slot replaces, not the whole base set", () => {
    const d = deriveWargear(crossProductDump(), "ds1", resolveCP);
    expect(d.unresolved).toEqual([]);
    expect(d.defaultsByModel.get("Warrior")).toEqual(["bolt-pistol", "chainsword"]);

    const byRepl = (repl: string) => d.options.find((o) => (o.replacement ?? []).join(",") === repl);
    const aSwap = byRepl("plasma-pistol");
    const bSwap = byRepl("power-fist");
    const bothSwap = byRepl("plasma-pistol,power-fist");
    expect(aSwap, "plasma-pistol swap option").toBeDefined();
    expect(bSwap, "power-fist swap option").toBeDefined();
    expect(bothSwap, "both-slot swap option").toBeDefined();

    // Each single-slot swap removes ONLY its own base weapon — the per-slot delta.
    expect(aSwap!.replaces).toEqual(["bolt-pistol"]);
    expect(bSwap!.replaces).toEqual(["chainsword"]);
    // The both-slot branch legitimately swaps both, so it (and only it) lists both.
    expect(bothSwap!.replaces).toEqual(["bolt-pistol", "chainsword"]);

    // Regression guard: no option that swaps in a single weapon may list more than
    // one base weapon in `replaces`. Reverting to `removed = baseSet` trips this.
    for (const o of d.options) {
      if ((o.replacement ?? []).length === 1) {
        expect(o.replaces ?? [], `single-weapon swap ${JSON.stringify(o.replacement)} over-lists replaces`).toHaveLength(1);
      }
    }
  });
});

/**
 * A datasheet whose loadout choices come as PER-SLOT sets (the other dump shape;
 * Necron Warriors is the canonical case): one set per independent choice, each
 * mentioning only its own slot's weapons —
 *   set 1: {ccw}                      (fixed melee slot, sole branch)
 *   set 2: {gauss flayer | gauss reaper}  (the ranged either-or)
 * Pins that the branch delta is computed against the base RESTRICTED to the
 * set's own scope: the reaper swap replaces only the flayer, never the ccw
 * (diffing against the full base dragged the ccw into `replaces`, which made a
 * legal ccw+reaper loadout look undecomposable and broke slot conservation).
 * Also pins the base-disjoint shape (icons/instruments): a set none of whose
 * branches touch the base becomes a pure ADDITION, not a whole-kit swap.
 */
function perSlotDump(): MfmDump {
  const wi = (id: string, name: string) => ({ id, wargearType: "weapon", localisations: { en: { name } } });
  const lcwi = (id: string, wargearItemId: string, loadoutChoiceId: string) => ({ id, count: 1, wargearItemId, loadoutChoiceId });
  return new MfmDump({
    data: {
      miniature: [{ id: "m-nw", displayOrder: 0, localisations: { en: { name: "Necron Warrior" } } }],
      unit_composition: [
        { id: "uc1", datasheetId: "ds1", isDefault: true, displayOrder: 1, points: 80, referenceGroupingKeywordId: null },
      ],
      unit_composition_miniature: [{ id: "ucm1", min: 10, max: 20, unitCompositionId: "uc1", miniatureId: "m-nw" }],
      wargear_item: [
        wi("wi-ccw", "Close combat weapon"),
        wi("wi-flayer", "Gauss flayer"),
        wi("wi-reaper", "Gauss reaper"),
        wi("wi-icon", "Daemonic icon"),
        wi("wi-runt", "Ammo runt"),
      ],
      // Base loadout (default>0): ccw + gauss flayer on every model.
      wargear_option_group: [
        { id: "g-nw", displayOrder: 1, datasheetId: "ds1", miniatureId: "m-nw", isStaticWargear: false },
      ],
      wargear_option: [
        { id: "wo-ccw", wargearItemId: "wi-ccw", wargearOptionGroupId: "g-nw", inputType: "stepper", defaultValue: 10, points: 0, displayOrder: 1 },
        { id: "wo-flayer", wargearItemId: "wi-flayer", wargearOptionGroupId: "g-nw", inputType: "stepper", defaultValue: 10, points: 0, displayOrder: 2 },
      ],
      loadout_choice_set: [
        { id: "lcs-melee", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: "m-nw", alternate: false },
        { id: "lcs-ranged", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: "m-nw", alternate: false },
        { id: "lcs-icon", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: "m-nw", alternate: false },
        { id: "lcs-runt", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: null, alternate: false },
        { id: "lcs-extra-flayer", limit: 1, allowDuplicates: false, datasheetId: "ds1", miniatureId: "m-nw", alternate: false },
      ],
      loadout_choice: [
        { id: "lc-melee", loadoutChoiceSetId: "lcs-melee" }, // sole branch = the fixed ccw
        { id: "lc-flayer", loadoutChoiceSetId: "lcs-ranged" }, // base branch
        { id: "lc-reaper", loadoutChoiceSetId: "lcs-ranged" }, // the swap
        { id: "lc-icon", loadoutChoiceSetId: "lcs-icon" }, // base-disjoint addition
        { id: "lc-no-runt", loadoutChoiceSetId: "lcs-runt" },
        { id: "lc-runt", loadoutChoiceSetId: "lcs-runt" },
        { id: "lc-no-extra-flayer", loadoutChoiceSetId: "lcs-extra-flayer" },
        { id: "lc-extra-flayer", loadoutChoiceSetId: "lcs-extra-flayer" },
      ],
      loadout_choice_wargear_item: [
        lcwi("k1", "wi-ccw", "lc-melee"),
        lcwi("k2", "wi-flayer", "lc-flayer"),
        lcwi("k3", "wi-reaper", "lc-reaper"),
        lcwi("k4", "wi-icon", "lc-icon"),
        lcwi("k5", "wi-runt", "lc-runt"),
        lcwi("k6", "wi-flayer", "lc-extra-flayer"),
      ],
      limited_wargear_choice_set: [],
      limited_wargear_choice: [],
      limited_wargear_choice_wargear_item: [],
      wargear_limit: [],
    },
  });
}

describe("deriveWargear — per-slot choice sets (slot-scoped delta)", () => {
  const PS_VALID = new Set([
    "close-combat-weapon",
    "gauss-flayer",
    "gauss-reaper",
    "daemonic-icon",
    "ammo-runt",
  ]);
  const resolvePS = (name: string) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return PS_VALID.has(id) ? id : null;
  };
  const d = deriveWargear(perSlotDump(), "ds1", resolvePS);

  it("resolves the full vocabulary", () => {
    expect(d.unresolved).toEqual([]);
    expect(d.defaultsByModel.get("Necron Warrior")).toEqual(["close-combat-weapon", "gauss-flayer"]);
  });

  it("scopes a slot's swap to its own base weapon — the ccw stays out of replaces", () => {
    const reaperSwap = d.options.find((o) => (o.replacement ?? []).includes("gauss-reaper"));
    expect(reaperSwap, "gauss-reaper swap option").toBeDefined();
    expect(reaperSwap!.replaces).toEqual(["gauss-flayer"]);
  });

  it("emits no option at all for a fixed single-branch slot (it equals the base)", () => {
    for (const o of d.options) {
      expect(o.replacement ?? []).not.toContain("close-combat-weapon");
      expect(o.replaces ?? []).not.toContain("close-combat-weapon");
    }
  });

  it("turns a base-disjoint set (icon/instrument) into a pure addition, not a kit swap", () => {
    const icon = d.options.find((o) => (o.replacement ?? []).includes("daemonic-icon"));
    expect(icon, "daemonic-icon option").toBeDefined();
    expect(icon!.replaces).toBeUndefined();
  });

  it("turns an optional unit-scoped choice into a pure addition", () => {
    const runt = d.options.find((o) => (o.replacement ?? []).includes("ammo-runt"));
    expect(runt, "ammo-runt option").toBeDefined();
    expect(runt!.replaces).toBeUndefined();
    expect(runt!.model_constraint).toEqual({ max_count: 1 });
  });

  it("keeps an optional extra copy of a default weapon as a pure addition", () => {
    const extraFlayer = d.options.find(
      (o) =>
        o.replaces === undefined &&
        (o.replacement ?? []).includes("gauss-flayer"),
    );
    expect(extraFlayer, "extra gauss-flayer option").toBeDefined();
    expect(extraFlayer!.model_constraint).toEqual({ any_number: true });
  });
});

describe("dumpComposition + reconcileModels (Category ② synthesis)", () => {
  const dump = fixtureDump();
  const defaults = deriveWargear(dump, "ds1", resolve).defaultsByModel;
  const unit = { id: "u1", model_count: { min: 5, max: 10 }, base_size_mm: { shape: "round", diameter: 32 } };

  it("reads the dump's default composition in display order (champion leads)", () => {
    expect(dumpComposition(dump, "ds1")).toEqual([
      { name: "Champion", min: 1, max: 1 },
      { name: "Trooper", min: 4, max: 9 },
    ]);
  });

  it("synthesizes a missing single-figure row and corrects the bulk row's counts", () => {
    const collapsed = [
      {
        name: "Trooper",
        min: 5,
        max: 10,
        is_leader_model: false,
        base_size_mm: { shape: "round", diameter: 32 },
        default_weapon_ids: ["combi-bolter", "accursed-weapon"],
      },
    ];
    const rec = reconcileModels(collapsed, dumpComposition(dump, "ds1"), defaults, unit);
    expect(rec).not.toBeNull();
    expect(rec!.synthesized).toEqual(["Champion"]);
    expect(rec!.models).toEqual([
      {
        name: "Champion",
        min: 1,
        max: 1,
        is_leader_model: true, // singleton among a bulk squad
        base_size_mm: { shape: "round", diameter: 32 }, // inherited from the sibling
        default_weapon_ids: ["combi-bolter", "accursed-weapon"], // dump base loadout
      },
      // bulk row's count corrected 5/10 → 4/9 to make room for the champion
      {
        name: "Trooper",
        min: 4,
        max: 9,
        is_leader_model: false,
        base_size_mm: { shape: "round", diameter: 32 },
        default_weapon_ids: ["combi-bolter", "accursed-weapon"],
      },
    ]);
  });

  it("returns null when every dump miniature already has a row (idempotent re-run)", () => {
    const complete = [
      { name: "Champion", min: 1, max: 1 },
      { name: "Trooper", min: 4, max: 9 },
    ];
    expect(reconcileModels(complete, dumpComposition(dump, "ds1"), defaults, unit)).toBeNull();
  });

  it("refuses to synthesize (flags for manual reconcile) when a repo row is absent from the dump", () => {
    const divergent = [{ name: "Heavy Trooper", min: 5, max: 10 }]; // name not in the dump
    const rec = reconcileModels(divergent, dumpComposition(dump, "ds1"), defaults, unit);
    expect(rec).not.toBeNull();
    expect(rec!.synthesized).toEqual([]);
    expect(rec!.models).toEqual(divergent); // untouched
    expect(rec!.notes.some((n) => n.includes("manual reconcile"))).toBe(true);
  });
});

describe("deriveDefaults quantity rule + heterogeneity guard (option-group model)", () => {
  const wi = (id: string, name: string) => ({ id, wargearType: "weapon", localisations: { en: { name } } });
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // deriveWargear touches the choice/limit tables; provide empty defaults.
  const mkDump = (data: Record<string, unknown[]>) =>
    new MfmDump({
      data: {
        loadout_choice_set: [],
        loadout_choice: [],
        loadout_choice_wargear_item: [],
        limited_wargear_choice_set: [],
        limited_wargear_choice: [],
        limited_wargear_choice_wargear_item: [],
        wargear_limit: [],
        ...data,
      } as Record<string, never[]>,
    });

  it("multiplies a stepper default by 1/model_count → a genuine multi-weapon (×2)", () => {
    const dump = mkDump({
      miniature: [{ id: "m1", displayOrder: 0, localisations: { en: { name: "Walker" } } }],
      unit_composition: [{ id: "uc", datasheetId: "dsX", isDefault: true, displayOrder: 1, points: 0, referenceGroupingKeywordId: null }],
      unit_composition_miniature: [{ id: "ucm", min: 1, max: 1, unitCompositionId: "uc", miniatureId: "m1" }],
      wargear_item: [wi("wi-shoota", "Twin big shoota")],
      wargear_option_group: [{ id: "g", displayOrder: 1, datasheetId: "dsX", miniatureId: "m1", isStaticWargear: false }],
      wargear_option: [{ id: "o", wargearItemId: "wi-shoota", wargearOptionGroupId: "g", inputType: "stepper", defaultValue: 2, points: 0, displayOrder: 1 }],
    });
    expect(deriveWargear(dump, "dsX", slug).defaultsByModel.get("Walker")).toEqual([
      "twin-big-shoota",
      "twin-big-shoota",
    ]);
  });

  it("skips a miniature split across >1 default group (heterogeneity) and notes it", () => {
    const dump = mkDump({
      miniature: [{ id: "m1", displayOrder: 0, localisations: { en: { name: "Retinue" } } }],
      unit_composition: [{ id: "uc", datasheetId: "dsY", isDefault: true, displayOrder: 1, points: 0, referenceGroupingKeywordId: null }],
      unit_composition_miniature: [{ id: "ucm", min: 4, max: 4, unitCompositionId: "uc", miniatureId: "m1" }],
      wargear_item: [wi("wi-a", "Gun A"), wi("wi-b", "Gun B")],
      wargear_option_group: [
        { id: "g1", displayOrder: 1, datasheetId: "dsY", miniatureId: "m1", isStaticWargear: false },
        { id: "g2", displayOrder: 2, datasheetId: "dsY", miniatureId: "m1", isStaticWargear: false },
      ],
      wargear_option: [
        { id: "o1", wargearItemId: "wi-a", wargearOptionGroupId: "g1", inputType: "stepper", defaultValue: 3, points: 0, displayOrder: 1 },
        { id: "o2", wargearItemId: "wi-b", wargearOptionGroupId: "g2", inputType: "stepper", defaultValue: 1, points: 0, displayOrder: 1 },
      ],
    });
    const d = deriveWargear(dump, "dsY", slug);
    expect(d.defaultsByModel.has("Retinue")).toBe(false);
    expect(d.notes.some((n) => n.includes("default loadout groups"))).toBe(true);
  });

  it("leaves a datasheet-wide (miniatureId null) default group to MANUAL_DEFAULTS", () => {
    const dump = mkDump({
      miniature: [{ id: "m1", displayOrder: 0, localisations: { en: { name: "Tank" } } }],
      unit_composition: [{ id: "uc", datasheetId: "dsZ", isDefault: true, displayOrder: 1, points: 0, referenceGroupingKeywordId: null }],
      unit_composition_miniature: [{ id: "ucm", min: 1, max: 1, unitCompositionId: "uc", miniatureId: "m1" }],
      wargear_item: [wi("wi-turret", "Support turret")],
      wargear_option_group: [{ id: "g", displayOrder: 1, datasheetId: "dsZ", miniatureId: null, isStaticWargear: false }],
      wargear_option: [{ id: "o", wargearItemId: "wi-turret", wargearOptionGroupId: "g", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 1 }],
    });
    expect(deriveWargear(dump, "dsZ", slug).defaultsByModel.size).toBe(0);
  });
});

describe("deriveWargear per-model swaps and ratio caps", () => {
  const wi = (id: string, name: string) => ({ id, wargearType: "weapon", localisations: { en: { name } } });
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Two model types. A multi-model "Goremonger" offering its chainblade swapped for
  // one of {autopistol, blood-harpoon} (per-model menu — stays any_number). A
  // "Trooper" with an uncapped swap (any number) and a swap that is governed by
  // a 1-per-5 wargear_limit (the ratio is the only per-option cap source).
  function dump(): MfmDump {
    return new MfmDump({
      data: {
        miniature: [
          { id: "m-gore", displayOrder: 0, localisations: { en: { name: "Goremonger" } } },
          { id: "m-troop", displayOrder: 1, localisations: { en: { name: "Trooper" } } },
        ],
        unit_composition: [
          { id: "uc", datasheetId: "ds", isDefault: true, displayOrder: 1, points: 0, referenceGroupingKeywordId: null },
        ],
        unit_composition_miniature: [
          { id: "ucm1", min: 1, max: 7, unitCompositionId: "uc", miniatureId: "m-gore" },
          { id: "ucm2", min: 1, max: 5, unitCompositionId: "uc", miniatureId: "m-troop" },
        ],
        wargear_item: [
          wi("wi-chainblade", "Chainblade"),
          wi("wi-autopistol", "Autopistol"),
          wi("wi-harpoon", "Blood harpoon"),
          wi("wi-bolter", "Bolter"),
          wi("wi-pistol", "Pistol"),
          wi("wi-special", "Special weapon"),
          wi("wi-heavy", "Heavy weapon"),
        ],
        wargear_option_group: [
          // base loadouts (defaultValue > 0)
          { id: "g-gore-base", displayOrder: 1, datasheetId: "ds", miniatureId: "m-gore", isStaticWargear: false },
          { id: "g-troop-base", displayOrder: 2, datasheetId: "ds", miniatureId: "m-troop", isStaticWargear: false },
          // optional swaps (defaultValue == 0) — the inputType carries the cap
          { id: "g-gore-swaps", displayOrder: 3, datasheetId: "ds", miniatureId: "m-gore", isStaticWargear: false },
          { id: "g-troop-swaps", displayOrder: 4, datasheetId: "ds", miniatureId: "m-troop", isStaticWargear: false },
        ],
        wargear_option: [
          { id: "o-gore-cb", wargearItemId: "wi-chainblade", wargearOptionGroupId: "g-gore-base", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 1 },
          { id: "o-troop-b", wargearItemId: "wi-bolter", wargearOptionGroupId: "g-troop-base", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 1 },
          { id: "o-troop-p", wargearItemId: "wi-pistol", wargearOptionGroupId: "g-troop-base", inputType: "checkbox", defaultValue: 1, points: 0, displayOrder: 2 },
          // swaps: checkbox → max 1; stepper → any number; checkbox+ratio → ratio
          { id: "o-auto", wargearItemId: "wi-autopistol", wargearOptionGroupId: "g-gore-swaps", inputType: "checkbox", defaultValue: 0, points: 0, displayOrder: 1 },
          { id: "o-harpoon", wargearItemId: "wi-harpoon", wargearOptionGroupId: "g-gore-swaps", inputType: "checkbox", defaultValue: 0, points: 0, displayOrder: 2 },
          { id: "o-special", wargearItemId: "wi-special", wargearOptionGroupId: "g-troop-swaps", inputType: "stepper", defaultValue: 0, points: 0, displayOrder: 1 },
          { id: "o-heavy", wargearItemId: "wi-heavy", wargearOptionGroupId: "g-troop-swaps", inputType: "checkbox", defaultValue: 0, points: 0, displayOrder: 2 },
        ],
        loadout_choice_set: [
          { id: "lcs-1-gore", limit: 1, allowDuplicates: false, datasheetId: "ds", miniatureId: "m-gore", alternate: false },
          { id: "lcs-2-special", limit: 1, allowDuplicates: false, datasheetId: "ds", miniatureId: "m-troop", alternate: false },
          { id: "lcs-3-heavy", limit: 1, allowDuplicates: false, datasheetId: "ds", miniatureId: "m-troop", alternate: false },
        ],
        loadout_choice: [
          { id: "c1a", loadoutChoiceSetId: "lcs-1-gore" },
          { id: "c1b", loadoutChoiceSetId: "lcs-1-gore" },
          { id: "c1c", loadoutChoiceSetId: "lcs-1-gore" },
          { id: "c2a", loadoutChoiceSetId: "lcs-2-special" },
          { id: "c2b", loadoutChoiceSetId: "lcs-2-special" },
          { id: "c3a", loadoutChoiceSetId: "lcs-3-heavy" },
          { id: "c3b", loadoutChoiceSetId: "lcs-3-heavy" },
        ],
        loadout_choice_wargear_item: [
          // gore: base chainblade, or autopistol, or blood harpoon
          { id: "x1", count: 1, wargearItemId: "wi-chainblade", loadoutChoiceId: "c1a" },
          { id: "x2", count: 1, wargearItemId: "wi-autopistol", loadoutChoiceId: "c1b" },
          { id: "x3", count: 1, wargearItemId: "wi-harpoon", loadoutChoiceId: "c1c" },
          // trooper special swap: base [bolter,pistol] or [special,pistol]
          { id: "x4", count: 1, wargearItemId: "wi-bolter", loadoutChoiceId: "c2a" },
          { id: "x5", count: 1, wargearItemId: "wi-pistol", loadoutChoiceId: "c2a" },
          { id: "x6", count: 1, wargearItemId: "wi-special", loadoutChoiceId: "c2b" },
          { id: "x7", count: 1, wargearItemId: "wi-pistol", loadoutChoiceId: "c2b" },
          // trooper heavy swap: base [bolter,pistol] or [bolter,heavy]
          { id: "x8", count: 1, wargearItemId: "wi-bolter", loadoutChoiceId: "c3a" },
          { id: "x9", count: 1, wargearItemId: "wi-pistol", loadoutChoiceId: "c3a" },
          { id: "x10", count: 1, wargearItemId: "wi-bolter", loadoutChoiceId: "c3b" },
          { id: "x11", count: 1, wargearItemId: "wi-heavy", loadoutChoiceId: "c3b" },
        ],
        // heavy weapon capped 1-per-5 (mini-scoped single set → per-option ratio)
        limited_wargear_choice_set: [
          { id: "lim-heavy", mandatory: false, datasheetId: "ds", miniatureId: "m-troop" },
        ],
        limited_wargear_choice: [{ id: "lwc-heavy", limitedWargearChoiceSetId: "lim-heavy" }],
        limited_wargear_choice_wargear_item: [
          { id: "lwi-heavy", count: 1, wargearItemId: "wi-heavy", limitedWargearChoiceId: "lwc-heavy" },
        ],
        wargear_limit: [
          { id: "wl-heavy", modelCount: 5, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim-heavy" },
        ],
      },
    });
  }

  const d = deriveWargear(dump(), "ds", slug);
  const byRemoved = (id: string) => d.options.find((o) => (o.replaces ?? []).includes(id));

  it("a checkbox swap with no limited set stays per-model (any_number)", () => {
    // The app checkbox is a per-MODEL-card toggle, not a unit-wide cap: every
    // true unit-wide 1-cap lives in a limited set (Goremongers' real blood
    // harpoon carries one, and its single-item flat budget clamps the bounds).
    const o = byRemoved("chainblade")!;
    expect(o.replaces).toEqual(["chainblade"]);
    // the two alternatives merge under one option (same replaced weapon)
    expect(o.replacement_choice).toEqual([["autopistol"], ["blood-harpoon"]]);
    expect(o.model_constraint).toEqual({ model_name: "Goremonger", any_number: true });
  });

  it("leaves a stepper swap uncapped (any_number)", () => {
    const o = byRemoved("bolter")!;
    expect(o.replacement).toEqual(["special-weapon"]);
    expect(o.model_constraint).toEqual({ model_name: "Trooper", any_number: true });
  });

  it("a wargear_limit ratio caps the swap (per_n_models)", () => {
    const o = byRemoved("pistol")!;
    expect(o.replacement).toEqual(["heavy-weapon"]);
    expect(o.model_constraint).toEqual({ model_name: "Trooper", per_n_models: 5 });
  });
});

describe("makeResolver per-unit priority overrides", () => {
  // Both ids are valid faction weapons (the GW dump reuses the display name
  // "Questoris multi-laser" for two distinct profiles). Without an override the
  // exact slug wins; the per-unit override must remap it BEFORE the direct match.
  const valid = new Set(["questoris-multi-laser", "chainbreaker-multi-laser", "las-impulsor"]);

  it("returns the exact-slug match when no override applies", () => {
    const r = makeResolver(valid, []);
    expect(r("Questoris multi-laser")).toBe("questoris-multi-laser");
  });

  it("a priority override remaps a valid id to another, beating the direct match", () => {
    const r = makeResolver(valid, [], {}, { "questoris-multi-laser": "chainbreaker-multi-laser" });
    expect(r("Questoris multi-laser")).toBe("chainbreaker-multi-laser");
    // unrelated names are unaffected
    expect(r("Las-impulsor")).toBe("las-impulsor");
  });

  it("a priority override pointing at a non-existent id falls through to the direct match", () => {
    const r = makeResolver(valid, [], {}, { "questoris-multi-laser": "not-a-real-id" });
    expect(r("Questoris multi-laser")).toBe("questoris-multi-laser");
  });
});

describe("limitedSetBudgets — per-item duplicate cap capture", () => {
  // A multi-item shared set (the Cadian special-weapon pattern): pick `choiceLimit`
  // per `modelCount` models, but no more than `duplicateLimit` of the SAME item.
  // GW tiers it (2/1 at 10 models, 4/2 at 20) — the binding (tightest-ratio) row's
  // dup must ride alongside its count/per_models. Faithful shape: one CHOICE per
  // alternative weapon (a multi-item choice is a bundle, not alternatives).
  const budgetResolve = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const sharedDump = (
    limits: Array<{ modelCount: number; choiceLimit: number; duplicateLimit: number | null }>,
    defaultModelCount?: number,
  ) =>
    new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-a", wargearType: "weapon", localisations: { en: { name: "Alpha" } } },
          { id: "wi-b", wargearType: "weapon", localisations: { en: { name: "Beta" } } },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [
          { id: "lwc-a", limitedWargearChoiceSetId: "lim" },
          { id: "lwc-b", limitedWargearChoiceSetId: "lim" },
        ],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-a", limitedWargearChoiceId: "lwc-a" },
          { id: "x2", count: 1, wargearItemId: "wi-b", limitedWargearChoiceId: "lwc-b" },
        ],
        wargear_limit: limits.map((l, i) => ({ id: `wl${i}`, ...l, limitedWargearChoiceSetId: "lim" })),
        ...(defaultModelCount == null
          ? {}
          : {
              unit_composition: [
                { id: "uc1", datasheetId: "ds1", isDefault: true, displayOrder: 1 },
              ],
              unit_composition_miniature: [
                {
                  id: "ucm1",
                  unitCompositionId: "uc1",
                  miniatureId: "m1",
                  min: defaultModelCount,
                  max: defaultModelCount,
                },
              ],
            }),
      },
    });

  it("captures duplicate_limit from the binding ratio tier", () => {
    const budgets = limitedSetBudgets(
      sharedDump([
        { modelCount: 10, choiceLimit: 2, duplicateLimit: 1 },
        { modelCount: 20, choiceLimit: 4, duplicateLimit: 2 },
      ]),
      "ds1",
      budgetResolve,
    );
    // Ratios tie (0.2); first-wins picks the {2,10,1} row → count 2, per_models 10, dup 1.
    expect(budgets).toEqual([{ items: ["alpha", "beta"], count: 2, per_models: 10, duplicate_limit: 1 }]);
  });

  it("captures a flat duplicate_limit when per_models is 0", () => {
    const budgets = limitedSetBudgets(
      sharedDump([{ modelCount: 0, choiceLimit: 4, duplicateLimit: 2 }]),
      "ds1",
      budgetResolve,
    );
    expect(budgets).toEqual([{ items: ["alpha", "beta"], count: 4, per_models: 0, duplicate_limit: 2 }]);
  });

  it("omits duplicate_limit entirely when the dump row has none", () => {
    const budgets = limitedSetBudgets(
      sharedDump([{ modelCount: 10, choiceLimit: 2, duplicateLimit: null }]),
      "ds1",
      budgetResolve,
    );
    expect(budgets).toEqual([{ items: ["alpha", "beta"], count: 2, per_models: 10 }]);
    expect("duplicate_limit" in budgets[0]).toBe(false);
  });

  it("a modelCount:0 row alongside scaling rows is NOT flat — the ratio binds", () => {
    // The Death Company / Legionaries / CSM Chaos Terminators shape: (0,1)+(10,2)
    // means "1 at minimum size, 2 at 10" = 1 per 5 — flattening to a per-unit 1
    // halved a 10-model squad's legal allowance (an ATC false-positive class).
    const budgets = limitedSetBudgets(
      sharedDump([
        { modelCount: 0, choiceLimit: 1, duplicateLimit: null },
        { modelCount: 10, choiceLimit: 2, duplicateLimit: null },
      ]),
      "ds1",
      budgetResolve,
    );
    expect(budgets).toEqual([{ items: ["alpha", "beta"], count: 2, per_models: 10 }]);
  });

  it("preserves an offset flat baseline and its scaling upper tier", () => {
    const budgets = limitedSetBudgets(
      sharedDump(
        [
          { modelCount: 0, choiceLimit: 2, duplicateLimit: null },
          { modelCount: 10, choiceLimit: 3, duplicateLimit: null },
        ],
        5,
      ),
      "ds1",
      budgetResolve,
    );
    expect(budgets).toEqual([
      { items: ["alpha", "beta"], count: 2, per_models: 5 },
      { items: ["alpha", "beta"], count: 3, per_models: 0 },
    ]);
  });
});

describe("limitedSetBudgets — choice bundles, copy counts, and exclusions", () => {
  const budgetResolve = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  it("a multi-item choice scales the cap: choiceLimit counts picks, not copies", () => {
    // Wolf Guard Terminators: one choice = [assault cannon + power fist],
    // limit (5,1)/(10,2) — two picks at 10 models legally sum to FOUR items.
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-ac", wargearType: "weapon", localisations: { en: { name: "Assault cannon" } } },
          { id: "wi-pf", wargearType: "weapon", localisations: { en: { name: "Power fist" } } },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [{ id: "lwc", limitedWargearChoiceSetId: "lim" }],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-ac", limitedWargearChoiceId: "lwc" },
          { id: "x2", count: 1, wargearItemId: "wi-pf", limitedWargearChoiceId: "lwc" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 5, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
          { id: "wl1", modelCount: 10, choiceLimit: 2, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    expect(limitedSetBudgets(dump, "ds1", budgetResolve)).toEqual([
      { items: ["assault-cannon", "power-fist"], count: 2, per_models: 5 },
    ]);
  });

  it("an item-row count: 2 scales the cap (the Seraphim 2-hand-flamer swap)", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-hf", wargearType: "weapon", localisations: { en: { name: "Hand flamer" } } },
          { id: "wi-ip", wargearType: "weapon", localisations: { en: { name: "Inferno pistol" } } },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [
          { id: "lwc-hf", limitedWargearChoiceSetId: "lim" },
          { id: "lwc-ip", limitedWargearChoiceSetId: "lim" },
        ],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 2, wargearItemId: "wi-hf", limitedWargearChoiceId: "lwc-hf" },
          { id: "x2", count: 2, wargearItemId: "wi-ip", limitedWargearChoiceId: "lwc-ip" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 0, choiceLimit: 2, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
          { id: "wl1", modelCount: 10, choiceLimit: 4, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    // 4 picks per 10 models × 2 copies per pick = 8 copies per 10 (4 at 5 models).
    expect(limitedSetBudgets(dump, "ds1", budgetResolve)).toEqual([
      { items: ["hand-flamer", "inferno-pistol"], count: 8, per_models: 10 },
    ]);
  });

  it("excludes derived-default items from the budget (the boltgun+simulacrum class)", () => {
    // The choice retains the model's default boltgun ("that model's boltgun cannot
    // be replaced") — counting it would make every STOCK squad flag.
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-bg", wargearType: "weapon", localisations: { en: { name: "Boltgun" } } },
          { id: "wi-si", wargearType: "wargear", localisations: { en: { name: "Simulacrum" } } },
        ],
        miniature: [{ id: "m1", localisations: { en: { name: "Battle Sister" } } }],
        wargear_option_group: [],
        unit_composition: [],
        wargear_option: [{ id: "wo-bg", wargearItemId: "wi-bg" }],
        base_miniature_loadout: [{ id: "bml1", datasheetId: "ds1", miniatureId: "m1" }],
        base_miniature_loadout_wargear_option: [
          { id: "bo1", count: 1, wargearOptionId: "wo-bg", baseMiniatureLoadoutId: "bml1" },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [{ id: "lwc", limitedWargearChoiceSetId: "lim" }],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-bg", limitedWargearChoiceId: "lwc" },
          { id: "x2", count: 1, wargearItemId: "wi-si", limitedWargearChoiceId: "lwc" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 0, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    expect(limitedSetBudgets(dump, "ds1", budgetResolve)).toEqual([
      { items: ["simulacrum"], count: 1, per_models: 0 },
    ]);
  });

  it("excludes items shared with another limited set (the Kommandos close-combat-weapon)", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-ccw", wargearType: "weapon", localisations: { en: { name: "Close combat weapon" } } },
          { id: "wi-rl", wargearType: "weapon", localisations: { en: { name: "Rokkit launcha" } } },
          { id: "wi-ks", wargearType: "weapon", localisations: { en: { name: "Kustom shoota" } } },
        ],
        limited_wargear_choice_set: [
          { id: "lim-rl", mandatory: false, datasheetId: "ds1", miniatureId: "m1" },
          { id: "lim-ks", mandatory: false, datasheetId: "ds1", miniatureId: "m1" },
        ],
        limited_wargear_choice: [
          { id: "lwc-rl", limitedWargearChoiceSetId: "lim-rl" },
          { id: "lwc-ks", limitedWargearChoiceSetId: "lim-ks" },
        ],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-ccw", limitedWargearChoiceId: "lwc-rl" },
          { id: "x2", count: 1, wargearItemId: "wi-rl", limitedWargearChoiceId: "lwc-rl" },
          { id: "x3", count: 1, wargearItemId: "wi-ccw", limitedWargearChoiceId: "lwc-ks" },
          { id: "x4", count: 1, wargearItemId: "wi-ks", limitedWargearChoiceId: "lwc-ks" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 0, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim-rl" },
          { id: "wl1", modelCount: 0, choiceLimit: 2, duplicateLimit: null, limitedWargearChoiceSetId: "lim-ks" },
        ],
      },
    });
    // The companion ccw rides in BOTH sets' bundles — its copies can't be
    // attributed to either allowance, so each budget keeps only its own weapon
    // (sets emit in id order: lim-ks before lim-rl).
    expect(limitedSetBudgets(dump, "ds1", budgetResolve)).toEqual([
      { items: ["kustom-shoota"], count: 2, per_models: 0 },
      { items: ["rokkit-launcha"], count: 1, per_models: 0 },
    ]);
  });

  it("excludes items another model type's option adds (the Plague champion plasma gun)", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-pg", wargearType: "weapon", localisations: { en: { name: "Plasma gun" } } },
          { id: "wi-mg", wargearType: "weapon", localisations: { en: { name: "Meltagun" } } },
          { id: "wi-pb", wargearType: "weapon", localisations: { en: { name: "Plague belcher" } } },
        ],
        miniature: [{ id: "m1", localisations: { en: { name: "Plague Marine" } } }],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [
          { id: "lwc-pg", limitedWargearChoiceSetId: "lim" },
          { id: "lwc-mg", limitedWargearChoiceSetId: "lim" },
          { id: "lwc-pb", limitedWargearChoiceSetId: "lim" },
        ],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-pg", limitedWargearChoiceId: "lwc-pg" },
          { id: "x2", count: 1, wargearItemId: "wi-mg", limitedWargearChoiceId: "lwc-mg" },
          { id: "x3", count: 1, wargearItemId: "wi-pb", limitedWargearChoiceId: "lwc-pb" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 5, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    const championOption = {
      id: "wgo-champ",
      unit_id: "plague-marines",
      faction_id: "death-guard",
      game_version: { edition: "11th", dataslate: "x" },
      model_constraint: { model_name: "Plague Champion", max_count: 1 },
      replaces: ["boltgun"],
      replacement: ["plasma-gun"],
    };
    // The champion's own swap must not spend the troopers' per-5 allowance —
    // plasma-gun copies are unattributable, so only the other specials stay
    // policed. (Had the set collapsed to ONE surviving item, the mini-scoped
    // single-weapon gate would drop the budget entirely.)
    expect(limitedSetBudgets(dump, "ds1", budgetResolve, [championOption])).toEqual([
      { items: ["meltagun", "plague-belcher"], count: 1, per_models: 5 },
    ]);
  });

  it("excludes items an uncapped option adds (the Boyz any-number shoota ccw)", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-ccw", wargearType: "weapon", localisations: { en: { name: "Close combat weapon" } } },
          { id: "wi-rl", wargearType: "weapon", localisations: { en: { name: "Rokkit launcha" } } },
          { id: "wi-bs", wargearType: "weapon", localisations: { en: { name: "Big shoota" } } },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [
          { id: "lwc-rl", limitedWargearChoiceSetId: "lim" },
          { id: "lwc-bs", limitedWargearChoiceSetId: "lim" },
        ],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-ccw", limitedWargearChoiceId: "lwc-rl" },
          { id: "x2", count: 1, wargearItemId: "wi-rl", limitedWargearChoiceId: "lwc-rl" },
          { id: "x3", count: 1, wargearItemId: "wi-ccw", limitedWargearChoiceId: "lwc-bs" },
          { id: "x4", count: 1, wargearItemId: "wi-bs", limitedWargearChoiceId: "lwc-bs" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 10, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    const shootaSwap = {
      id: "wgo-shoota",
      unit_id: "boyz",
      faction_id: "orks",
      game_version: { edition: "11th", dataslate: "x" },
      model_constraint: { any_number: true },
      replaces: ["slugga", "choppa"],
      replacement: ["shoota", "close-combat-weapon"],
    };
    expect(limitedSetBudgets(dump, "ds1", budgetResolve, [shootaSwap])).toEqual([
      { items: ["big-shoota", "rokkit-launcha"], count: 1, per_models: 10 },
    ]);
  });

  it("keeps items whose uncapped branch realizes one of the set's own choices", () => {
    // Budget-governed swaps are deliberately authored any_number (the budget IS
    // the enforcement). A WE Terminator branch [chainfist + combi-weapon] is the
    // set's own chainfist pick with the free combi-bolter swap alongside — NOT
    // an ungoverned path, so chainfist must stay policed.
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-cf", wargearType: "weapon", localisations: { en: { name: "Chainfist" } } },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: null }],
        limited_wargear_choice: [{ id: "lwc", limitedWargearChoiceSetId: "lim" }],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-cf", limitedWargearChoiceId: "lwc" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 5, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
          { id: "wl1", modelCount: 10, choiceLimit: 2, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    const trooperSwap = {
      id: "wgo-trooper",
      unit_id: "chaos-terminators",
      faction_id: "world-eaters",
      game_version: { edition: "11th", dataslate: "x" },
      model_constraint: { model_name: "World Eaters Terminator", any_number: true },
      replaces: ["combi-bolter", "accursed-weapon"],
      replacement_choice: [["chainfist", "combi-weapon"]],
    };
    // (5,1) and (10,2) tie at ratio 0.2 — first row wins, semantically identical.
    expect(limitedSetBudgets(dump, "ds1", budgetResolve, [trooperSwap])).toEqual([
      { items: ["chainfist"], count: 1, per_models: 5 },
    ]);
  });

  it("drops a set whose every item is excluded", () => {
    const dump = new MfmDump({
      data: {
        wargear_item: [
          { id: "wi-bg", wargearType: "weapon", localisations: { en: { name: "Boltgun" } } },
        ],
        miniature: [{ id: "m1", localisations: { en: { name: "Trooper" } } }],
        wargear_option_group: [],
        unit_composition: [],
        wargear_option: [{ id: "wo-bg", wargearItemId: "wi-bg" }],
        base_miniature_loadout: [{ id: "bml1", datasheetId: "ds1", miniatureId: "m1" }],
        base_miniature_loadout_wargear_option: [
          { id: "bo1", count: 1, wargearOptionId: "wo-bg", baseMiniatureLoadoutId: "bml1" },
        ],
        limited_wargear_choice_set: [{ id: "lim", mandatory: false, datasheetId: "ds1", miniatureId: "m1" }],
        limited_wargear_choice: [{ id: "lwc", limitedWargearChoiceSetId: "lim" }],
        limited_wargear_choice_wargear_item: [
          { id: "x1", count: 1, wargearItemId: "wi-bg", limitedWargearChoiceId: "lwc" },
        ],
        wargear_limit: [
          { id: "wl0", modelCount: 0, choiceLimit: 1, duplicateLimit: null, limitedWargearChoiceSetId: "lim" },
        ],
      },
    });
    expect(limitedSetBudgets(dump, "ds1", budgetResolve)).toEqual([]);
  });
});

describe("withinEditDistance1", () => {
  it("matches GW↔repo spelling drift", () => {
    expect(withinEditDistance1("absolvor-bolt-pistol", "absolver-bolt-pistol")).toBe(true); // substitution
    expect(withinEditDistance1("twin-killsaws", "twin-killsaw")).toBe(true); // deletion
    expect(withinEditDistance1("nuncio-acquila", "nuncio-aquila")).toBe(true); // insertion
  });
  it("rejects distance ≥2 and unequal stems", () => {
    expect(withinEditDistance1("lascannon", "autocannon")).toBe(false);
    expect(withinEditDistance1("meltagun", "plasma-gun")).toBe(false);
    expect(withinEditDistance1("bolt-rifle", "bolt-pistol")).toBe(false);
  });
});
