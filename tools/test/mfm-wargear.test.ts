import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import { deriveWargear, withinEditDistance1, dumpComposition, reconcileModels, makeResolver } from "../src/mfm/wargear.js";

/**
 * A hand-built minimal dump exercising the full derivation: two model types
 * (a capped leader + bulk), a base loadout each, a per-model loadout choice with
 * a heavy-weapon branch, and a 1-per-5 squad cap. Mirrors the shape verified
 * against World Eaters Chaos Terminators.
 */
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

describe("deriveWargear checkbox cap (wargear_option.inputType)", () => {
  const wi = (id: string, name: string) => ({ id, wargearType: "weapon", localisations: { en: { name } } });
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Two model types. A multi-model "Goremonger" offering its chainblade swapped for
  // one of {autopistol, blood-harpoon} — both CHECKBOX swaps (the GW "1 X → 1 Y"
  // shape). A "Trooper" with a STEPPER swap (any number) and a CHECKBOX swap that is
  // ALSO governed by a 1-per-5 wargear_limit (ratio must win over the checkbox).
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

  it("caps a checkbox swap at 1 instance unit-wide (max_count: 1)", () => {
    const o = byRemoved("chainblade")!;
    expect(o.replaces).toEqual(["chainblade"]);
    // the two checkbox alternatives merge under one option (same replaced weapon)
    expect(o.replacement_choice).toEqual([["autopistol"], ["blood-harpoon"]]);
    expect(o.model_constraint).toEqual({ model_name: "Goremonger", max_count: 1 });
  });

  it("leaves a stepper swap uncapped (any_number)", () => {
    const o = byRemoved("bolter")!;
    expect(o.replacement).toEqual(["special-weapon"]);
    expect(o.model_constraint).toEqual({ model_name: "Trooper", any_number: true });
  });

  it("lets a wargear_limit ratio win over the checkbox (per_n_models, not max_count)", () => {
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
