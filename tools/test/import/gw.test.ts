/**
 * GW app text-export adapter unit tests.
 *
 * The Games Workshop 40K app exports a plain-text roster: a `++++…++++` summary
 * header, ALL-CAPS battlefield-role sections, and units with `•`-bulleted
 * wargear. These tests pin the parse (header, model groups, annotations,
 * enhancement) and the disjointness from the NewRecruit WTC matchers that share
 * the same `+ FACTION KEYWORD:` header.
 */
import { describe, it, expect } from "vitest";
import { Dataset } from "../../src/data/dataset.js";
import { importRoster, tryImportRoster } from "../../src/import/import-roster.js";
import { gwAdapter } from "../../src/import/gw.js";

const ds = Dataset.embedded();

// The user's reference 2000pt Chaos Knights + Nurgle-allies list.
const GW_SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+
+ WARLORD: Char3: War Dog Executioner
+ ENHANCEMENT: Preyslayer's Mantle (on Batt1: War Dog Karnivore)
+ NUMBER OF UNITS: 16
+ SECONDARY: - Bring It Down: (13x2) - Assassination: 3 Characters
+++++++++++++++++++++++++++++++++++++++++++++++

BATTLELINE

War Dog Brigand (140 pts)
• 1x Armoured feet
• 1x Avenger chaincannon
• 1x Daemonbreath spear
• 1x Havoc multi-launcher

War Dog Executioner (130 pts)
• 1x Armoured feet
• 2x War Dog autocannon
• 1x Diabolus heavy stubber
• Houndpack Lance Character, Warlord

War Dog Executioner (130 pts)
• 1x Armoured feet
• 2x War Dog autocannon
• 1x Diabolus heavy stubber

War Dog Karnivore (165 pts)
• 1x Reaper chaintalon
• 1x Slaughterclaw
• 1x Havoc multi-launcher
• Houndpack Lance Character
• Preyslayer's Mantle (+15 pts)

War Dog Karnivore (150 pts)
• 1x Reaper chaintalon
• 1x Slaughterclaw
• 1x Havoc multi-launcher

ALLIED UNITS

Beasts of Nurgle (65 pts)
• 1x Beast of Nurgle
    • 1x Putrid appendages

Nurglings (40 pts)
• 3x Nurgling Swarm
    • 3x Diseased claws and teeth
`;

describe("gwAdapter.matches", () => {
  it("recognises the GW text export (faction keyword + bullets, no `N with`)", () => {
    expect(gwAdapter.matches(GW_SAMPLE)).toBe(true);
  });

  it("rejects a non-string payload", () => {
    expect(gwAdapter.matches({ roster: {} })).toBe(false);
  });

  it("rejects WTC text (bullets present but `N with` body lines)", () => {
    const wtcFull = `+++++
+ FACTION KEYWORD: Chaos Knights
+++++

BATTLELINE

1x War Dog Karnivore (150 pts)
1 with Reaper chaintalon, Slaughterclaw
`;
    expect(gwAdapter.matches(wtcFull)).toBe(false);
  });
});

describe("gwAdapter via tryImportRoster", () => {
  it("auto-detects the GW format (not a NewRecruit WTC variant)", () => {
    const result = tryImportRoster(GW_SAMPLE, { dataset: ds });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.format).toBe("gw");
  });
});

describe("gwAdapter.parse", () => {
  const parsed = gwAdapter.parse(GW_SAMPLE);

  it("reads the header (faction strips the super-prefix, detachment strips the rule)", () => {
    expect(parsed.faction_raw_name).toBe("Chaos Knights");
    expect(parsed.detachment_raw_names).toEqual(["Houndpack Lance"]);
    expect(parsed.total_reported).toBe(2000);
    // GW carries no separate POINTS LIMIT line — the total is the limit.
    expect(parsed.declared_limit).toBe(2000);
  });

  it("parses every unit and flags allied units as multi-force", () => {
    expect(parsed.units.length).toBe(7);
    expect(parsed.multi_force).toBe(true);
  });

  it("backs the enhancement points out of the unit header total", () => {
    const karnivores = parsed.units.filter((u) => u.raw_name === "War Dog Karnivore");
    const withEnh = karnivores.find((u) => u.enhancement_raw_name !== null);
    expect(withEnh).toBeDefined();
    expect(withEnh!.enhancement_raw_name).toBe("Preyslayer's Mantle");
    expect(withEnh!.enhancement_points).toBe(15);
    expect(withEnh!.points).toBe(150); // 165 displayed − 15 enhancement
    expect(withEnh!.is_character).toBe(true);
  });

  it("flags the warlord from the body annotation", () => {
    const warlords = parsed.units.filter((u) => u.is_warlord);
    expect(warlords.length).toBe(1);
    expect(warlords[0].raw_name).toBe("War Dog Executioner");
  });

  it("treats top-level `• Nx` bullets as wargear", () => {
    const exec = parsed.units.find(
      (u) => u.raw_name === "War Dog Executioner" && u.is_warlord,
    )!;
    const autocannon = exec.wargear.find((w) => w.raw_name === "War Dog autocannon");
    expect(autocannon?.count).toBe(2);
    expect(exec.model_count).toBe(1);
  });

  it("treats a `• Nx Model` bullet with child bullets as a model group", () => {
    const nurglings = parsed.units.find((u) => u.raw_name === "Nurglings")!;
    expect(nurglings.model_count).toBe(3);
    expect(nurglings.wargear).toEqual([{ raw_name: "Diseased claws and teeth", count: 3 }]);

    const beasts = parsed.units.find((u) => u.raw_name === "Beasts of Nurgle")!;
    expect(beasts.model_count).toBe(1);
    expect(beasts.wargear).toEqual([{ raw_name: "Putrid appendages", count: 1 }]);
  });
});

  it("uses hollow bullets as child depth without whitespace", () => {
    const [unit] = gwAdapter.parse(`++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Orks
+ DETACHMENT: Bully Boyz
+ TOTAL ARMY POINTS: 105pts
+++++++++++++++++++++++++++++++

OTHER DATASHEETS

Nobz (105 pts)
• 1x Boss Nob
◦ 1x Power klaw
• 4x Nob
◦ 4x Power klaw
`).units;

    expect(unit.model_count).toBe(5);
    expect(unit.wargear).toEqual([{ raw_name: "Power klaw", count: 5 }]);
  });

it("does not add a synthetic model to complete named model groups", () => {
  const roster = importRoster(`Fabricated roster (235 points)
Orks
Bully Boyz (1 Detachment Point)
Incursion (1000 Points)

CHARACTERS

Ghazghkull Thraka (235 Points)
• Attached as: Leader (Character)
• 1x Ghazghkull Thraka
• Warlord
◦ 1x Gork’s Klaw
◦ 1x Mork’s Roar
• 1x Makari
◦ 1x Makari’s stabba
`, { dataset: ds });

  expect(roster.units[0]?.model_count).toBe(1);
});

describe("gwAdapter resolves against the embedded dataset", () => {
  const roster = importRoster(GW_SAMPLE, { dataset: ds });

  it("resolves the faction and detachment ids", () => {
    expect(roster.faction_id).toBe("chaos-knights");
    expect(roster.detachments.map((d) => d.ref.id)).toEqual(["houndpack-lance"]);
  });

  it("carries the warlord and the enhancement", () => {
    const warlord = roster.units.find((u) => u.is_warlord);
    expect(warlord?.ref.id).toBe("war-dog-executioner");
    const enhanced = roster.units.find((u) => u.enhancement !== null);
    expect(enhanced?.enhancement?.id).toBe("preyslayers-mantle-houndpack-lance");
  });
});

describe("gwAdapter captures non-bulleted `Nx` wargear lines", () => {
  // The GW app bullets only the FIRST wargear entry per unit and emits the
  // rest as plain `Nx …` lines (no `•`). All of them are still that unit's
  // wargear — the parser must not drop the unbulleted lines.
  const GW_PARTIAL_BULLETS = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Aeldari
+ DETACHMENT: Battle Host
+ TOTAL ARMY POINTS: 200pts
+
+ NUMBER OF UNITS: 1
++++++++++++++++++++++++++++++++++++++++++++++

OTHER DATASHEETS

Wraithlord (200 pts)
• 1x Prism Cannon
1x Wraithbone hull
1x Twin Shuriken Catapult
`;

  const parsed = gwAdapter.parse(GW_PARTIAL_BULLETS);

  it("treats plain `Nx` lines after the first bullet as wargear", () => {
    expect(parsed.units.length).toBe(1);
    const unit = parsed.units[0];
    expect(unit.raw_name).toBe("Wraithlord");
    expect(unit.wargear).toEqual([
      { raw_name: "Prism Cannon", count: 1 },
      { raw_name: "Wraithbone hull", count: 1 },
      { raw_name: "Twin Shuriken Catapult", count: 1 },
    ]);
    expect(unit.model_count).toBe(1);
  });
});

describe("leading-`The` weapon resolution + Jain Zar rename (issues #3a/#3b)", () => {
  // A GW list whose wargear lines exercise both leading-"The" directions and
  // the renamed Jain Zar melee weapon (was the id/name `strike`).
  const GW_THE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Aeldari
+ DETACHMENT: Battle Host
+ TOTAL ARMY POINTS: 100pts
+
+ NUMBER OF UNITS: 1
++++++++++++++++++++++++++++++++++++++++++++++

CHARACTERS

Jain Zar (100 pts)
• 1x The Blade of Destruction
1x The Bloody Twins
1x Fire Axe
`;
  const roster = importRoster(GW_THE, { dataset: ds });
  const jz = roster.units[0];

  it("resolves Jain Zar's renamed melee weapon (was `strike`)", () => {
    // export "The Blade of Destruction" ← data "Blade of Destruction"
    const ids = jz.wargear.map((w) => w.ref.id);
    expect(ids).toContain("blade-of-destruction");
  });

  it("matches a data name against a `The`-prefixed export (NewRecruit direction)", () => {
    // data "Bloody Twins" ← export "The Bloody Twins"
    const twins = jz.wargear.find((w) => w.ref.raw_name === "The Bloody Twins");
    expect(twins?.ref.id).toBe("bloody-twins");
  });

  it("matches a `The`-prefixed data name against a bare export (GW direction)", () => {
    // data "The Fire Axe" ← export "Fire Axe"
    const axe = jz.wargear.find((w) => w.ref.raw_name === "Fire Axe");
    expect(axe?.ref.id).toBe("the-fire-axe");
  });

  it("exposes the renamed weapon name on the unit view, not `strike`", () => {
    const names = ds.units.find("Jain Zar")!.weapons.map((w) => w.name);
    expect(names).toContain("Blade of Destruction");
    expect(names).not.toContain("strike");
  });
});

describe("gwAdapter — Attached Units preamble", () => {
  // GW app export groups a Leader/Support character with its bodyguard unit
  // under "Attached Units" > "Attached Unit N" before the ALL-CAPS role
  // sections begin, marking each entry's role via "• Attached as: Leader
  // (Character)" / "• Attached as: Bodyguard". This block previously carried
  // no attachment signal at all (silently dropped, matched as two standalone
  // units).
  const SAMPLE = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+++++++++++++++++++++++++++++++++++++++++++++++

Attached Units
Attached Unit 1

War Dog Karnivore (165 pts)
• Attached as: Leader (Character)
• 1x Reaper chaintalon
• 1x Slaughterclaw
• 1x Havoc multi-launcher

Nurglings (40 pts)
• Attached as: Bodyguard
• 3x Nurgling Swarm
    • 3x Diseased claws and teeth

BATTLELINE

War Dog Brigand (140 pts)
• 1x Armoured feet
• 1x Avenger chaincannon
`;

  const parsed = gwAdapter.parse(SAMPLE);

  it("sets leader_attachment on the character (Leader role) pointing at its bodyguard", () => {
    const karnivore = parsed.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment).toEqual({
      role: "leader",
      bodyguard_raw_name: "Nurglings",
      provisional: false,
    });
  });

  it("flags the attached character as is_character even without a trailing 'Character' token", () => {
    const karnivore = parsed.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.is_character).toBe(true);
  });

  it("does not set leader_attachment on the bodyguard unit itself", () => {
    const nurglings = parsed.units.find((u) => u.raw_name === "Nurglings")!;
    expect(nurglings.leader_attachment).toBeUndefined();
  });

  it("does not misparse 'Attached as: Bodyguard' as wargear or an annotation", () => {
    const nurglings = parsed.units.find((u) => u.raw_name === "Nurglings")!;
    const wargearNames = nurglings.wargear.map((w) => w.raw_name);
    expect(wargearNames).not.toContain("Attached as: Bodyguard");
    expect(nurglings.model_count).toBe(3);
  });

  it("still parses units outside the Attached Units preamble normally", () => {
    const brigand = parsed.units.find((u) => u.raw_name === "War Dog Brigand")!;
    expect(brigand.leader_attachment).toBeUndefined();
    expect(brigand.points).toBe(140);
  });

  it("keeps every unit — 3 total (2 attached + 1 battleline)", () => {
    expect(parsed.units).toHaveLength(3);
  });

  it("resolves end-to-end via tryImportRoster with the bodyguard_ref matched", () => {
    const result = tryImportRoster(SAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const karnivore = result.roster.units.find((u) => u.ref.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment).not.toBeNull();
    expect(karnivore.leader_attachment?.role).toBe("leader");
    expect(karnivore.leader_attachment?.bodyguard_ref.raw_name).toBe("Nurglings");
    expect(karnivore.leader_attachment?.bodyguard_ref.resolved).toBe(true);
  });

  it("resolves an Attached Unit group with a Support-role character", () => {
    const supportSample = SAMPLE.replace(
      "• Attached as: Leader (Character)",
      "• Attached as: Support (Character)",
    );
    const p = gwAdapter.parse(supportSample);
    const karnivore = p.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    expect(karnivore.leader_attachment?.role).toBe("support");
  });

  it("does not pair across two separate Attached Unit blocks", () => {
    const twoBlocks = `+++++++++++++++++++++++++++++++++++++++++++++++
+ FACTION KEYWORD: Chaos - Chaos Knights
+ DETACHMENT: Houndpack Lance (Marked Prey)
+ TOTAL ARMY POINTS: 2000pts
+++++++++++++++++++++++++++++++++++++++++++++++

Attached Units
Attached Unit 1

War Dog Karnivore (165 pts)
• Attached as: Leader (Character)
• 1x Reaper chaintalon

Nurglings (40 pts)
• Attached as: Bodyguard
• 3x Nurgling Swarm
    • 3x Diseased claws and teeth

Attached Unit 2

War Dog Executioner (130 pts)
• Attached as: Leader (Character)
• 1x Armoured feet

Beasts of Nurgle (140 pts)
• Attached as: Bodyguard
• 3x Beast of Nurgle
    • 3x Fleshy Claws
`;
    const p = gwAdapter.parse(twoBlocks);
    const karnivore = p.units.find((u) => u.raw_name === "War Dog Karnivore")!;
    const executioner = p.units.find((u) => u.raw_name === "War Dog Executioner")!;
    expect(karnivore.leader_attachment?.bodyguard_raw_name).toBe("Nurglings");
    expect(executioner.leader_attachment?.bodyguard_raw_name).toBe("Beasts of Nurgle");
  });
});
