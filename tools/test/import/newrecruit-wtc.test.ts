import { describe, it, expect } from "vitest";
import { Dataset } from "../../src/data/dataset.js";
import { tryImportRoster } from "../../src/import/import-roster.js";
import {
  newRecruitWtcCompactAdapter,
  newRecruitWtcFullAdapter,
} from "../../src/import/newrecruit-wtc.js";

const COMPACT_SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+
+ WARLORD: Char3: War Dog Executioner
+ ENHANCEMENT: Preyslayer's Mantle (on Batt1: War Dog Karnivore)
+ NUMBER OF UNITS: 4
+ SECONDARY: - Bring It Down: (13x2) - Assassination: 3 Characters
+++++++++++++++++++++++++++++++++++++++++++++++

Char3: 1x War Dog Executioner (130 pts): Houndpack Lance Character, Warlord, Armoured feet, 2x War Dog autocannon, Diabolus heavy stubber
Char1: 1x War Dog Karnivore (165 pts): Houndpack Lance Character, Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
Enhancement: Preyslayer's Mantle (+15 pts)
1x War Dog Karnivore (150 pts): Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
3x Nurglings (40 pts): 3 with Diseased claws and teeth
`;

const FULL_SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+
+ WARLORD: Char3: War Dog Executioner
+ ENHANCEMENT: Preyslayer's Mantle (on Batt1: War Dog Karnivore)
+ NUMBER OF UNITS: 4
+ SECONDARY: - Bring It Down: (13x2) - Assassination: 3 Characters
+++++++++++++++++++++++++++++++++++++++++++++++

BATTLELINE

Char3: 1x War Dog Executioner (130 pts)
1 with Armoured feet, 2x War Dog autocannon, Diabolus heavy stubber, Houndpack Lance Character, Warlord

Char1: 1x War Dog Karnivore (165 pts)
1 with Reaper chaintalon, Slaughterclaw, Havoc multi-launcher, Houndpack Lance Character
Enhancement: Preyslayer's Mantle (+15 pts)

1x War Dog Karnivore (150 pts)
1 with Reaper chaintalon, Slaughterclaw, Havoc multi-launcher

ALLIED UNITS

3x Nurglings (40 pts)
• 3x Nurgling Swarm
    3 with Diseased claws and teeth
`;

describe("newRecruitWtcCompactAdapter", () => {
  it("matches compact text but rejects full text and JSON", () => {
    expect(newRecruitWtcCompactAdapter.matches(COMPACT_SAMPLE)).toBe(true);
    expect(newRecruitWtcCompactAdapter.matches(FULL_SAMPLE)).toBe(false);
    expect(newRecruitWtcCompactAdapter.matches({ roster: { forces: [] } })).toBe(false);
    expect(newRecruitWtcCompactAdapter.matches("not a wtc list")).toBe(false);
  });

  const parsed = newRecruitWtcCompactAdapter.parse(COMPACT_SAMPLE);

  it("extracts faction, detachment, and inferred battle size", () => {
    expect(parsed.faction_raw_name).toBe("Chaos Knights"); // last segment after " - "
    expect(parsed.detachment_raw_names).toEqual(["Houndpack Lance"]); // parenthetical stripped
    expect(parsed.declared_limit).toBe(2000);
    expect(parsed.total_reported).toBe(2000);
    expect(parsed.battle_size_raw).toContain("Strike Force");
  });

  it("is explicit-null for force_disposition_raw_name when the header has no line", () => {
    expect(parsed.force_disposition_raw_name).toBeNull();
  });

  it("captures a + FORCE DISPOSITION: header line", () => {
    const withDisposition = COMPACT_SAMPLE.replace(
      "+ DETACHMENT: Houndpack Lance (Marked Prey)",
      "+ DETACHMENT: Houndpack Lance (Marked Prey)\n+ FORCE DISPOSITION: Disruption",
    );
    const p = newRecruitWtcCompactAdapter.parse(withDisposition);
    expect(p.force_disposition_raw_name).toBe("Disruption");
  });

  it("captures units in declaration order with correct points and counts", () => {
    expect(parsed.units.map((u) => u.raw_name)).toEqual([
      "War Dog Executioner",
      "War Dog Karnivore",
      "War Dog Karnivore",
      "Nurglings",
    ]);

    const exec = parsed.units[0];
    expect(exec.points).toBe(130);
    expect(exec.is_warlord).toBe(true);
    expect(exec.is_character).toBe(true);
    expect(exec.model_count).toBe(1);

    const karWarlord = parsed.units[1];
    expect(karWarlord.points).toBe(150); // 165 displayed minus 15 enhancement = 150 base
    expect(karWarlord.enhancement_raw_name).toBe("Preyslayer's Mantle");
    expect(karWarlord.is_character).toBe(true);

    const nurglings = parsed.units[3];
    expect(nurglings.points).toBe(40);
    expect(nurglings.model_count).toBe(3); // "3x Nurglings" — leading count carries through
  });

  it("strips Warlord and detachment-Character markers from the wargear list", () => {
    const exec = parsed.units[0];
    const wargearNames = exec.wargear.map((w) => w.raw_name);
    expect(wargearNames).not.toContain("Warlord");
    expect(wargearNames).not.toContain("Houndpack Lance Character");
    expect(wargearNames).toContain("Armoured feet");
    expect(wargearNames).toContain("Diabolus heavy stubber");

    // Multiplicity preserved
    const autocannon = exec.wargear.find((w) => w.raw_name === "War Dog autocannon");
    expect(autocannon?.count).toBe(2);
  });

  it("sums total_computed across base unit pts + enhancement pts", () => {
    // 130 (exec) + 150 (karnivore-warlord base) + 15 (preyslayer) + 150 (karnivore-plain) + 40 (nurglings)
    expect(parsed.total_computed).toBe(485);
  });

  it("does not leak any prose fields", () => {
    expect(JSON.stringify(parsed)).not.toMatch(/description/i);
  });
});

describe("newRecruitWtcCompactAdapter — Leading/Attached to attachment prose", () => {
  // The plain-text NewRecruit copy export (newrecruit.eu) states leader
  // attachment in prose on either end of the link, not via the WTC-serialized
  // `Attachment: leader -> X` line: `Leading <bodyguard>` on the character's
  // own block, and/or `  Attached to <character>` (indented, no bullet) on
  // the bodyguard's own block.
  const SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+++++++++++++++++++++++++++++++++++++++++++++++

Char1: 1x War Dog Karnivore (165 pts): Houndpack Lance Character, Reaper chaintalon, Slaughterclaw, Havoc multi-launcher
Leading Nurglings

3x Nurglings (40 pts): 3 with Diseased claws and teeth
  Attached to War Dog Karnivore
`;

  const parsed = newRecruitWtcCompactAdapter.parse(SAMPLE);

  it("sets leader_attachment on the character from a 'Leading X' line", () => {
    const karnivore = parsed.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment).toEqual({
      role: "leader",
      bodyguard_raw_name: "Nurglings",
      provisional: false,
    });
  });

  it("does not duplicate or overwrite the attachment when 'Attached to' echoes the same pair", () => {
    // Only one signal should win — the explicit 'Leading' line found first.
    const karnivore = parsed.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment?.bodyguard_raw_name).toBe("Nurglings");
  });

  it("does not set leader_attachment on the bodyguard unit itself", () => {
    const nurglings = parsed.units.find((u) => u.raw_name === "Nurglings")!;
    expect(nurglings.leader_attachment).toBeNull();
  });

  it("falls back to 'Attached to' alone (defaulting to leader role) when no 'Leading' line is present", () => {
    const attachedToOnly = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+++++++++++++++++++++++++++++++++++++++++++++++

Char1: 1x War Dog Karnivore (165 pts): Houndpack Lance Character, Reaper chaintalon, Slaughterclaw, Havoc multi-launcher

3x Nurglings (40 pts): 3 with Diseased claws and teeth
  Attached to War Dog Karnivore
`;
    const p = newRecruitWtcCompactAdapter.parse(attachedToOnly);
    const karnivore = p.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment).toEqual({
      role: "leader",
      bodyguard_raw_name: "Nurglings",
      provisional: false,
    });
  });
});

describe("newRecruitWtcFullAdapter", () => {
  it("matches full text only and disambiguates from compact", () => {
    expect(newRecruitWtcFullAdapter.matches(FULL_SAMPLE)).toBe(true);
    expect(newRecruitWtcFullAdapter.matches(COMPACT_SAMPLE)).toBe(false);
  });

  const parsed = newRecruitWtcFullAdapter.parse(FULL_SAMPLE);

  it("captures a + FORCE DISPOSITION: header line (explicit null when absent)", () => {
    expect(parsed.force_disposition_raw_name).toBeNull();
    const withDisposition = FULL_SAMPLE.replace(
      "+ DETACHMENT: Houndpack Lance (Marked Prey)",
      "+ DETACHMENT: Houndpack Lance (Marked Prey)\n+ FORCE DISPOSITION: Take and Hold",
    );
    const p = newRecruitWtcFullAdapter.parse(withDisposition);
    expect(p.force_disposition_raw_name).toBe("Take and Hold");
  });

  it("reads section headers without recording them as units", () => {
    expect(parsed.units.map((u) => u.raw_name)).toEqual([
      "War Dog Executioner",
      "War Dog Karnivore",
      "War Dog Karnivore",
      "Nurglings",
    ]);
  });

  it("attaches an Enhancement line to the immediately preceding unit", () => {
    const karWarlord = parsed.units[1];
    expect(karWarlord.enhancement_raw_name).toBe("Preyslayer's Mantle");
    expect(karWarlord.points).toBe(150); // 165 - 15

    const karPlain = parsed.units[2];
    expect(karPlain.enhancement_raw_name).toBeNull();
  });

  it("collapses a `• Nx ModelType` breakdown into model_count + wargear", () => {
    const nurglings = parsed.units[3];
    expect(nurglings.model_count).toBe(3);
    expect(nurglings.wargear).toEqual([{ raw_name: "Diseased claws and teeth", count: 3 }]);
  });

  it("flags multi_force when an ALLIED UNITS section is present", () => {
    expect(parsed.multi_force).toBe(true);
  });
});

// Real NewRecruit full exports mix compact-style lines into the full layout:
// single-model units arrive as one `Unit (pts): wargear` line, and model-type
// bullets may inline their loadout after a colon. A World Eaters tournament
// list in this shape previously lost all seven of its single-line units.
const MIXED_FULL_SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - World Eaters
+ DETACHMENT: Possessed Slaughterband (Brazen Fury)
+ TOTAL ARMY POINTS: 2000pts
+
+ WARLORD: Char1: Angron
+ ENHANCEMENT: 
+ NUMBER OF UNITS: 14
+ SECONDARY: - Bring It Down: (2x2) + (1x4) - Assassination: 5 Characters
+++++++++++++++++++++++++++++++++++++++++++++++

Char1: 1x Angron (340 pts): Warlord, Samni'arius and Spinegrinder
Char2: 1x Khârn the Betrayer (100 pts): Gorechild, Plasma pistol
Char3: 1x Slaughterbound (100 pts): Lacerator and daemonic claw
Char4: 1x Slaughterbound (100 pts): Lacerator and daemonic claw
Char5: 1x Slaughterbound (100 pts): Lacerator and daemonic claw

6x Eightbound (270 pts)
• 1x Eightbound Champion: Chainblades
• 5x Eightbound: 5 with Chainblades
3x Eightbound (135 pts)
• 1x Eightbound Champion: Chainblades
• 2x Eightbound: 2 with Chainblades
3x Eightbound (135 pts)
• 1x Eightbound Champion: Chainblades
• 2x Eightbound: 2 with Chainblades
3x Exalted Eightbound (140 pts)
• 1x Exalted Eightbound Champion: Chainblades
• 2x Exalted Eightbound: 2 with Chainblades
3x Exalted Eightbound (140 pts)
• 1x Exalted Eightbound Champion: Chainblades
• 2x Exalted Eightbound: 2 with Chainblades
8x Goremongers (75 pts)
• 1x Blood Herald: Autopistol, Chainblade, Close combat weapon
• 7x Goremonger: 7 with Autopistol, Chainblade, Close combat weapon
10x Jakhals (65 pts)
• 8x Jakhal
    6 with Autopistol, Chainblades
    1 with Icon of Khorne, Autopistol, Chainblades
    1 with Autopistol, Mauler chainblade
• 1x Jakhal Pack Leader: Autopistol, Chainblades
• 1x Dishonoured: Skullsmasher and mangler
1x Maulerfiend (150 pts): Maulerfiend fists, Lasher tendrils
1x Maulerfiend (150 pts): Maulerfiend fists, Lasher tendrils
`;

describe("newRecruitWtcFullAdapter with mixed compact-style lines", () => {
  it("matches as full format", () => {
    expect(newRecruitWtcFullAdapter.matches(MIXED_FULL_SAMPLE)).toBe(true);
  });

  const parsed = newRecruitWtcFullAdapter.parse(MIXED_FULL_SAMPLE);

  it("keeps every unit, including single-line characters and vehicles", () => {
    expect(parsed.units).toHaveLength(14);
    const names = parsed.units.map((u) => u.raw_name);
    expect(names.filter((n) => n === "Slaughterbound")).toHaveLength(3);
    expect(names.filter((n) => n === "Maulerfiend")).toHaveLength(2);
    expect(names).toContain("Angron");
    expect(names).toContain("Khârn the Betrayer");
  });

  it("classifies single-line characters and strips the Warlord marker", () => {
    const angron = parsed.units.find((u) => u.raw_name === "Angron");
    expect(angron?.is_character).toBe(true);
    expect(angron?.is_warlord).toBe(true);
    expect(angron?.points).toBe(340);
    expect(angron?.wargear).toEqual([
      { raw_name: "Samni'arius and Spinegrinder", count: 1 },
    ]);
  });

  it("captures inline loadouts on model-type bullets", () => {
    const bigEightbound = parsed.units.find(
      (u) => u.raw_name === "Eightbound" && u.model_count === 6,
    );
    expect(bigEightbound?.wargear).toEqual([{ raw_name: "Chainblades", count: 6 }]);

    const goremongers = parsed.units.find((u) => u.raw_name === "Goremongers");
    expect(goremongers?.model_count).toBe(8);
    expect(goremongers?.wargear).toEqual([
      { raw_name: "Autopistol", count: 8 },
      { raw_name: "Chainblade", count: 8 },
      { raw_name: "Close combat weapon", count: 8 },
    ]);
  });

  it("still handles plain breakdowns with indented `N with` continuations", () => {
    const jakhals = parsed.units.find((u) => u.raw_name === "Jakhals");
    expect(jakhals?.model_count).toBe(10);
    const byName = Object.fromEntries(
      (jakhals?.wargear ?? []).map((w) => [w.raw_name, w.count]),
    );
    expect(byName["Autopistol"]).toBe(9); // 6 + 1 icon-bearer + 1 mauler + pack leader
    expect(byName["Chainblades"]).toBe(8); // 6 + 1 icon-bearer + pack leader
    expect(byName["Mauler chainblade"]).toBe(1);
    expect(byName["Skullsmasher and mangler"]).toBe(1);
  });

  it("computes the full 2000-point total", () => {
    expect(parsed.total_computed).toBe(2000);
  });
});

describe("newRecruitWtcFullAdapter repeated model continuations", () => {
  const parsed = newRecruitWtcFullAdapter.parse(`+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Practice - Sample Faction
+ DETACHMENT: Sample Detachment
+ TOTAL ARMY POINTS: 100pts
+ NUMBER OF UNITS: 3
+++++++++++++++++++++++++++++++++++++++++++++++

10x Repetition Squad (100 pts)
• 9x Repetition Model
    6 with Practice carbine
    1 with Practice beacon, Practice carbine
    1 with Practice launcher
    1 with Practice blade
• 1x Officer Model: Practice carbine

3x Fallback Squad (0 pts)
• 3x Fallback Model
    2 with Practice kit

3x Inline Squad (0 pts)
• 2x Inline Model: 2 with Inline kit
• 1x Empty Model
`);

  it("keeps every repeated continuation as an exact parent-model group", () => {
    const repetition = parsed.units[0];
    expect(repetition.loadout_groups).toEqual([
      {
        model_name: "Repetition Model",
        count: 6,
        wargear: [{ raw_name: "Practice carbine", count: 1 }],
      },
      {
        model_name: "Repetition Model",
        count: 1,
        wargear: [
          { raw_name: "Practice beacon", count: 1 },
          { raw_name: "Practice carbine", count: 1 },
        ],
      },
      {
        model_name: "Repetition Model",
        count: 1,
        wargear: [{ raw_name: "Practice launcher", count: 1 }],
      },
      {
        model_name: "Repetition Model",
        count: 1,
        wargear: [{ raw_name: "Practice blade", count: 1 }],
      },
      {
        model_name: "Officer Model",
        count: 1,
        wargear: [{ raw_name: "Practice carbine", count: 1 }],
      },
    ]);
    expect(repetition.wargear).toEqual([
      { raw_name: "Practice carbine", count: 8 },
      { raw_name: "Practice beacon", count: 1 },
      { raw_name: "Practice launcher", count: 1 },
      { raw_name: "Practice blade", count: 1 },
    ]);
  });

  it("preserves unassigned parent models as one empty fallback group", () => {
    expect(parsed.units[1].loadout_groups).toEqual([
      {
        model_name: "Fallback Model",
        count: 2,
        wargear: [{ raw_name: "Practice kit", count: 1 }],
      },
      { model_name: "Fallback Model", count: 1, wargear: [] },
    ]);
    expect(parsed.units[2].loadout_groups).toEqual([
      {
        model_name: "Inline Model",
        count: 2,
        wargear: [{ raw_name: "Inline kit", count: 1 }],
      },
      { model_name: "Empty Model", count: 1, wargear: [] },
    ]);
  });
});

// End-to-end resolution of the WTC-only header/body features: the
// `+ FORCE DISPOSITION:` header (new in the 11e WTC template) and wargear
// ITEMS (non-weapon entries like the Simulacrum Imperialis) that must resolve
// against the wargear collection once both weapon lookups miss.
describe("wtc resolution end-to-end", () => {
  const ds = Dataset.embedded();

  const SORORITAS_LIST = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Imperium - Adepta Sororitas
+ DETACHMENT: Champions of Faith (Righteous Purpose)
+ FORCE DISPOSITION: Disruption
+ TOTAL ARMY POINTS: 150pts
+
+ WARLORD: Char1: Palatine
+ NUMBER OF UNITS: 2
+++++++++++++++++++++++++++++++++++++++++++++++

Char1: 1x Palatine (50 pts): Palatine blade, Plasma pistol, Warlord

10x Battle Sisters Squad (100 pts)
• 9x Battle Sister
    7 with Bolt pistol, Boltgun, Close combat weapon
    1 with Simulacrum Imperialis, Bolt pistol, Boltgun, Close combat weapon
    1 with Bolt pistol, Close combat weapon, Multi-melta
• 1x Sister Superior: Bolt pistol, Close combat weapon, Power weapon, Boltgun
`;

  const result = tryImportRoster(SORORITAS_LIST, { dataset: ds });

  it("resolves the FORCE DISPOSITION header to a disposition id", () => {
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.format).toBe("newrecruit-wtc-full");
      expect(result.roster.force_disposition).toBe("disruption");
    }
  });

  it("warns disposition-unresolved on an unknown disposition name", () => {
    const bad = SORORITAS_LIST.replace("Disruption", "Total Mayhem");
    const r = tryImportRoster(bad, { dataset: ds });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.roster.force_disposition).toBeNull();
      const codes = r.roster.diagnostics.warnings.map((w) => w.code);
      expect(codes).toContain("disposition-unresolved");
    }
  });

  it("resolves a wargear ITEM (Simulacrum Imperialis) via the wargear fallback", () => {
    expect(result.ok).toBe(true);
    if (result.ok) {
      const squad = result.roster.units.find((u) => u.ref.id === "battle-sisters-squad")!;
      const simulacrum = squad.wargear.find((w) => w.ref.raw_name === "Simulacrum Imperialis")!;
      expect(simulacrum.ref.id).toBe("simulacrum-imperialis");
      expect(result.roster.diagnostics.unresolved_weapons).toBe(0);
    }
  });

  it("keeps weapon precedence for names that exist in BOTH collections", () => {
    // "Multi-melta" is a weapon AND could shadow wargear entries; the fallback
    // only runs after the weapon lookups miss, so it must resolve as a weapon.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const squad = result.roster.units.find((u) => u.ref.id === "battle-sisters-squad")!;
      const melta = squad.wargear.find((w) => w.ref.raw_name === "Multi-melta")!;
      expect(melta.ref.id).not.toBeNull();
      expect(ds.weapons.getAny(melta.ref.id!)).toBeTruthy();
    }
  });
});

describe("newRecruitWtcFullAdapter — Leading/Attached to attachment prose", () => {
  // Same prose-based attachment signal as the compact-parser test above, but
  // in the full-body (section-header) dialect — exercises the second copy of
  // the LEADING_LINE/ATTACHED_TO_LINE handling in parseFullBody.
  const SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+++++++++++++++++++++++++++++++++++++++++++++++

BATTLELINE

Char1: 1x War Dog Karnivore (165 pts)
1 with Reaper chaintalon, Slaughterclaw, Havoc multi-launcher, Houndpack Lance Character
Leading Nurglings

3x Nurglings (40 pts)
• 3x Nurgling Swarm
    3 with Diseased claws and teeth
  Attached to War Dog Karnivore
`;

  const parsed = newRecruitWtcFullAdapter.parse(SAMPLE);

  it("sets leader_attachment on the character from a 'Leading X' line", () => {
    const karnivore = parsed.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment).toEqual({
      role: "leader",
      bodyguard_raw_name: "Nurglings",
      provisional: false,
    });
  });

  it("does not set leader_attachment on the bodyguard unit itself", () => {
    const nurglings = parsed.units.find((u) => u.raw_name === "Nurglings")!;
    expect(nurglings.leader_attachment).toBeNull();
  });
});
