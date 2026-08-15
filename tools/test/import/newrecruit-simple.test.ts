import { describe, it, expect } from "vitest";
import { newRecruitSimpleAdapter } from "../../src/import/newrecruit-simple.js";

const SAMPLE = `Chaos - Chaos Knights - Dog Kill God? - [2000 pts]

# ++ Army Roster ++ [2000 pts]
## Configuration
Battle Size: Strike Force (2000 Point limit)
Detachment: Houndpack Lance
Show/Hide Options: Nurgle Daemons are visible

## Battleline [1855 pts]
War Dog Karnivore [165 pts]: Houndpack Lance Character, Preyslayer's Mantle [15 pts], Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
War Dog Karnivore [150 pts]: Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
War Dog Executioner [130 pts]: Houndpack Lance Character, Warlord, Armoured feet, 2x War Dog autocannon, Diabolus heavy stubber

## Allied Units [145 pts]
Nurglings [40 pts]:
• 3x Nurgling Swarm: Diseased claws and teeth
Beasts of Nurgle [65 pts]:
• 1x Beast of Nurgle [65 pts]: Putrid appendages
`;

describe("newRecruitSimpleAdapter", () => {
  it("matches simple text only", () => {
    expect(newRecruitSimpleAdapter.matches(SAMPLE)).toBe(true);
    expect(newRecruitSimpleAdapter.matches("+ FACTION KEYWORD: …")).toBe(false);
    expect(newRecruitSimpleAdapter.matches({ roster: { forces: [] } })).toBe(false);
  });

  const parsed = newRecruitSimpleAdapter.parse(SAMPLE);

  it("extracts name, faction, and declared limit from the first line", () => {
    expect(parsed.name).toBe("Dog Kill God?");
    expect(parsed.faction_raw_name).toBe("Chaos Knights");
    expect(parsed.declared_limit).toBe(2000);
    expect(parsed.total_reported).toBe(2000); // from `# ++ Army Roster ++ [2000 pts]`
  });

  it("reads battle size and detachment from the Configuration section", () => {
    expect(parsed.battle_size_raw).toBe("Strike Force (2000 Point limit)");
    expect(parsed.detachment_raw_names).toEqual(["Houndpack Lance"]);
  });

  it("captures units in declaration order", () => {
    expect(parsed.units.map((u) => u.raw_name)).toEqual([
      "War Dog Karnivore",
      "War Dog Karnivore",
      "War Dog Executioner",
      "Nurglings",
      "Beasts of Nurgle",
    ]);
  });

  it("recognises the inline Name [N pts] enhancement and subtracts its cost from unit points", () => {
    const karWarlord = parsed.units[0];
    expect(karWarlord.enhancement_raw_name).toBe("Preyslayer's Mantle");
    expect(karWarlord.points).toBe(150); // 165 displayed minus 15 enhancement
    expect(karWarlord.is_character).toBe(true);
    expect(karWarlord.is_warlord).toBe(false);
    expect(karWarlord.wargear.map((w) => w.raw_name)).not.toContain("Preyslayer's Mantle");
  });

  it("strips Warlord and detachment Character markers from wargear", () => {
    const exec = parsed.units[2];
    expect(exec.is_warlord).toBe(true);
    expect(exec.is_character).toBe(true);
    const names = exec.wargear.map((w) => w.raw_name);
    expect(names).not.toContain("Warlord");
    expect(names).not.toContain("Houndpack Lance Character");
    const autocannon = exec.wargear.find((w) => w.raw_name === "War Dog autocannon");
    expect(autocannon?.count).toBe(2);
  });

  it("expands a `• Nx ModelType` breakdown into model_count + per-model wargear", () => {
    const nurglings = parsed.units[3];
    expect(nurglings.model_count).toBe(3);
    expect(nurglings.wargear).toEqual([{ raw_name: "Diseased claws and teeth", count: 3 }]);

    const beasts = parsed.units[4];
    expect(beasts.model_count).toBe(1);
    expect(beasts.wargear).toEqual([{ raw_name: "Putrid appendages", count: 1 }]);
  });

  it("flags multi_force when an `Allied Units` section is present", () => {
    expect(parsed.multi_force).toBe(true);
  });

  it("sums total_computed including enhancement pts", () => {
    // 150 (kar-warlord base) + 15 (preyslayer) + 150 + 130 + 40 + 65 = 550
    expect(parsed.total_computed).toBe(550);
  });

  it("does not leak any prose fields", () => {
    expect(JSON.stringify(parsed)).not.toMatch(/description/i);
  });
});

describe("newRecruitSimpleAdapter edge cases", () => {
  it("parses points brackets carrying comma-separated faction resources", () => {
    const cabal = `Chaos - Thousand Sons - Tester - [4485pts, 29Cabal Points]

# ++ Army Roster ++ [4485pts, 29Cabal Points]
## Epic Hero [895pts, 13Cabal Points]
Ahriman [140pts, 3Cabal Points]: Black Staff of Ahriman, Inferno bolt pistol
`;
    expect(newRecruitSimpleAdapter.matches(cabal)).toBe(true);
    const parsed = newRecruitSimpleAdapter.parse(cabal);
    expect(parsed.declared_limit).toBe(4485);
    expect(parsed.total_reported).toBe(4485);
    expect(parsed.units.length).toBe(1);
    expect(parsed.units[0].raw_name).toBe("Ahriman");
    expect(parsed.units[0].points).toBe(140);
  });

  it("matches exports that omit the Army Roster line but carry ## sections", () => {
    const headerless = `Chaos - World Eaters - Proxy List - [2000pts]

## Epic Hero [675pts]
Angron [435pts]: Samni'arius and Spinegrinder, Warlord
`;
    expect(newRecruitSimpleAdapter.matches(headerless)).toBe(true);
    const parsed = newRecruitSimpleAdapter.parse(headerless);
    expect(parsed.faction_raw_name).toBe("World Eaters");
    expect(parsed.total_reported).toBeNull();
    expect(parsed.units.length).toBe(1);
    expect(parsed.units[0].is_warlord).toBe(true);
  });

  it("treats a unit line directly after Configuration as ending that section", () => {
    const noUnitsHeader = `Xenos - T'au Empire - Base Tau - [2000pts]

# ++ Army Roster ++ [2000pts]
## Configuration
Battle Size: Strike Force (2000 Point limit)
Detachment: Auxiliary Cadre
Show/Hide Options: Legends are visible

Broadside Battlesuits [90pts]:
• 1x Broadside Shas'vre: Crushing bulk, 2x Shield Drone, Heavy rail rifle
Broadside Battlesuits [90pts]:
• 1x Broadside Shas'vre: Crushing bulk, 2x Shield Drone, Heavy rail rifle
`;
    const parsed = newRecruitSimpleAdapter.parse(noUnitsHeader);
    expect(parsed.detachment_raw_names).toEqual(["Auxiliary Cadre"]);
    expect(parsed.units.length).toBe(2);
    expect(parsed.units[0].raw_name).toBe("Broadside Battlesuits");
    expect(parsed.units[0].model_count).toBe(1);
    const gear = Object.fromEntries(
      parsed.units[0].wargear.map((w) => [w.raw_name, w.count]),
    );
    expect(gear["Shield Drone"]).toBe(2);
    expect(gear["Heavy rail rifle"]).toBe(1);
  });

  it("preserves explicit empty breakdown groups while retaining aggregate Unit total wargear", () => {
    const roster = `Fabricated - Test Faction - Empty Groups - [100 pts]

## Battleline [100 pts]
Empty First [10 pts]:
• 1x First Body: 
• 2x Second Body: Fabricated tool
Empty Middle [10 pts]:
• 1x First Body: Fabricated tool
• 2x Middle Body: 
• 1x Last Body: Fabricated tool
All Empty [10 pts]:
• 1x First Body: 
• 2x Second Body: 
Unit Total [10 pts]:
• 3x Aggregate Body: Unit total: Squad-wide fabricated tool
`;

    const parsed = newRecruitSimpleAdapter.parse(roster);
    const [emptyFirst, emptyMiddle, allEmpty, unitTotal] = parsed.units;

    expect(emptyFirst.model_count).toBe(3);
    expect(emptyFirst.loadout_groups).toEqual([
      { model_name: "First Body", count: 1, wargear: [] },
      {
        model_name: "Second Body",
        count: 2,
        wargear: [{ raw_name: "Fabricated tool", count: 1 }],
      },
    ]);
    expect(emptyFirst.wargear).toEqual([{ raw_name: "Fabricated tool", count: 2 }]);

    expect(emptyMiddle.model_count).toBe(4);
    expect(emptyMiddle.loadout_groups?.map((group) => group.wargear)).toEqual([
      [{ raw_name: "Fabricated tool", count: 1 }],
      [],
      [{ raw_name: "Fabricated tool", count: 1 }],
    ]);
    expect(emptyMiddle.wargear).toEqual([{ raw_name: "Fabricated tool", count: 2 }]);

    expect(allEmpty.model_count).toBe(3);
    expect(allEmpty.loadout_groups).toEqual([
      { model_name: "First Body", count: 1, wargear: [] },
      { model_name: "Second Body", count: 2, wargear: [] },
    ]);
    expect(allEmpty.wargear).toEqual([]);

    expect(unitTotal.model_count).toBe(3);
    expect(unitTotal.loadout_groups).toBeUndefined();
    expect(unitTotal.wargear).toEqual([
      { raw_name: "Squad-wide fabricated tool", count: 1 },
    ]);
  });
});
