import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { collectPeerGroups, collectSourceNodes, makeEquipmentResolver, projectBudget, projectUnit } from "../src/convert-bsdata-loadout-variants.js";
import { normModelName } from "../src/convert-bsdata-wargear.js";

const model = (name: string, targetId: string) => ({ name, type: "model", constraints: [{ field: "selections", type: "max", value: 2 }], entryLinks: [{ name: targetId === "missing" ? "Missing" : "Gun", targetId, type: "selectionEntry", constraints: [{ field: "selections", type: "min", value: 1 }] }] });

describe("BSData loadout variant projection", () => {
  it("indexes units stored in shared catalogue containers", () => {
    const shared = { id: "shared-unit", name: "Shared unit", type: "unit" };
    const nodes = collectSourceNodes([{ catalogue: { id: "catalogue", sharedSelectionEntries: [shared] } }]);
    expect(nodes.get("shared-unit")).toBe(shared);
  });

  it("rejects composition model types that are not loadout peers", () => {
    const sergeant = { ...model("Sergeant", "a"), constraints: [{ field: "selections", type: "min", value: 1 }] };
    const trooper = { ...model("Trooper", "b"), constraints: [{ field: "selections", type: "min", value: 4 }] };
    const unit = { selectionEntryGroups: [{ selectionEntries: [sergeant, trooper] }] };
    expect(collectPeerGroups(unit)).toEqual([]);
  });

  it("extracts direct model peers and resolves exact ids before unit-aware names", () => {
    const unit = { selectionEntryGroups: [{ selectionEntries: [model("Trooper", "exact"), model("Trooper w/ Gun", "missing")] }] };
    expect(collectPeerGroups(unit)).toHaveLength(1);
    const resolve = makeEquipmentResolver([{ id: "gun-unit", name: "Gun" }, { id: "other", external_refs: [{ namespace: "bsdata", id: "exact" }] }], "unit");
    expect(resolve({ name: "Gun", targetId: "exact" })).toBe("other");
    expect(resolve({ name: "Gun", targetId: "missing" })).toBe("gun-unit");
  });

  it("prefers the owning unit when an exact BSData id is shared", () => {
    const entities = [
      { id: "gun-other-unit", external_refs: [{ namespace: "bsdata", id: "shared" }] },
      { id: "gun-own-unit", external_refs: [{ namespace: "bsdata", id: "shared" }] },
    ];
    const resolve = makeEquipmentResolver(entities, "own-unit", ["other-unit", "own-unit"]);
    expect(resolve({ name: "Gun", targetId: "shared" })).toBe("gun-own-unit");
  });

  it("skips an unresolved peer and projects a shared scaling budget", () => {
    const group = { constraints: [{ field: "selections", type: "max", value: 1 }], modifiers: [{ type: "increment", value: 1, conditions: [{ childId: "model", type: "atLeast", value: 20 }] }], selectionEntries: [model("Boy", "gun"), model("Boy w/ Missing", "missing")] };
    const rows: Record<string, unknown>[] = [{ name: "Boy" }];
    const issues = projectUnit({ selectionEntryGroups: [group] }, rows, [{ id: "gun", external_refs: [{ namespace: "bsdata", id: "gun" }] }], "boyz");
    expect(issues).toHaveLength(1);
    expect(rows[0].loadout_variants).toEqual([{ name: "Boy", weapon_ids: ["gun"], max_count: 2 }]);
    expect(projectBudget(group, ["A", "B"])).toEqual({ variant_names: ["A", "B"], count: 1, per_models: 10, scope: "unit" });
  });

  it("projects fixed inline weapon profiles", () => {
    const inline = (name: string, id: string) => ({
      name,
      type: "model",
      selectionEntries: [{ id, name: "Blade", type: "upgrade", profiles: [{ typeName: "Melee Weapons" }] }],
    });
    const rows: Record<string, unknown>[] = [{ name: "Trooper" }];
    const issues = projectUnit(
      { selectionEntryGroups: [{ selectionEntries: [inline("Trooper", "blade-a"), inline("Trooper w/ Blade", "blade-b")] }] },
      rows,
      [
        { id: "blade-a", external_refs: [{ namespace: "bsdata", id: "blade-a" }] },
        { id: "blade-b", external_refs: [{ namespace: "bsdata", id: "blade-b" }] },
      ],
      "troopers",
    );
    expect(issues).toEqual([]);
    expect(rows[0].loadout_variants).toEqual([
      { name: "Trooper", weapon_ids: ["blade-a"] },
      { name: "Trooper w/ Blade", weapon_ids: ["blade-b"] },
    ]);
  });

  it("normalizes both model-loadout suffix forms", () => {
    expect(normModelName("Boy w/ Shoota")).toBe("boy");
    expect(normModelName("Boy with Shoota")).toBe("boy");
  });

  it("retains generated variants on a real non-Boyz composition", () => {
    const compositions = JSON.parse(fs.readFileSync("../data/core/adepta-sororitas/unit-compositions.json", "utf8"));
    const unit = compositions.find((item: { unit_id: string }) => item.unit_id === "battle-sisters-squad");
    const row = unit.models.find((item: { name: string }) => item.name === "Battle Sister");
    expect(row.loadout_variants).toHaveLength(4);
    expect(row.loadout_variant_budgets).toHaveLength(1);
    expect({ name: row.name, min: row.min, max: row.max, default_weapon_ids: row.default_weapon_ids }).toEqual({
      name: "Battle Sister",
      min: 9,
      max: 9,
      default_weapon_ids: ["boltgun", "bolt-pistol", "close-combat-weapon-battle-sisters-squad"],
    });
  });
});
