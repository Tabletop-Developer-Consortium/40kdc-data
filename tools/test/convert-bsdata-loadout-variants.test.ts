import { describe, expect, it } from "vitest";
import { collectPeerGroups, makeEquipmentResolver, projectBudget, projectUnit } from "../src/convert-bsdata-loadout-variants.js";
import { normModelName } from "../src/convert-bsdata-wargear.js";

const model = (name: string, targetId: string) => ({ name, type: "model", constraints: [{ field: "selections", type: "max", value: 2 }], entryLinks: [{ name: targetId === "missing" ? "Missing" : "Gun", targetId, type: "selectionEntry", constraints: [{ field: "selections", type: "min", value: 1 }] }] });

describe("BSData loadout variant projection", () => {
  it("extracts direct model peers and resolves exact ids before unit-aware names", () => {
    const unit = { selectionEntryGroups: [{ selectionEntries: [model("Trooper", "exact"), model("Trooper w/ Gun", "missing")] }] };
    expect(collectPeerGroups(unit)).toHaveLength(1);
    const resolve = makeEquipmentResolver([{ id: "gun-unit", name: "Gun" }, { id: "other", external_refs: [{ namespace: "bsdata", id: "exact" }] }], "unit");
    expect(resolve({ name: "Gun", targetId: "exact" })).toBe("other");
    expect(resolve({ name: "Gun", targetId: "missing" })).toBe("gun-unit");
  });

  it("skips an unresolved peer and projects a shared scaling budget", () => {
    const group = { constraints: [{ field: "selections", type: "max", value: 1 }], modifiers: [{ type: "increment", value: 1, conditions: [{ childId: "model", type: "atLeast", value: 20 }] }], selectionEntries: [model("Boy", "gun"), model("Boy w/ Missing", "missing")] };
    const rows: Record<string, unknown>[] = [{ name: "Boy" }];
    const issues = projectUnit({ selectionEntryGroups: [group] }, rows, [{ id: "gun", external_refs: [{ namespace: "bsdata", id: "gun" }] }], "boyz");
    expect(issues).toHaveLength(1);
    expect(rows[0].loadout_variants).toEqual([{ name: "Boy", weapon_ids: ["gun"], max_count: 2 }]);
    expect(projectBudget(group, ["A", "B"])).toEqual({ variant_names: ["A", "B"], count: 1, per_models: 10, scope: "unit" });
  });

  it("normalizes both model-loadout suffix forms", () => {
    expect(normModelName("Boy w/ Shoota")).toBe("boy");
    expect(normModelName("Boy with Shoota")).toBe("boy");
  });
});
