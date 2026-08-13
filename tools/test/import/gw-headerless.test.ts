/**
 * Headerless plain-text adapter tests.
 *
 * The adapter is the lenient fallback for bullet-bearing plain text that no
 * framed adapter claims: the GW 40K app export (faction/detachment as bare
 * preamble lines, ALL-CAPS sections, `◦` child wargear), the `##` markdown
 * dialect, and the NewRecruit copy-text dialect. These pin the parse (preamble
 * capture, model groups, child wargear, enhancements) and its disjointness from
 * the framed text matchers.
 */
import { describe, it, expect } from "vitest";
import { Dataset } from "../../src/data/dataset.js";
import { importRoster, tryImportRoster } from "../../src/import/import-roster.js";
import { gwHeaderlessAdapter } from "../../src/import/gw-headerless.js";
import { gwAdapter } from "../../src/import/gw.js";
import { listForgeTextAdapter } from "../../src/import/listforge-text.js";
import { newRecruitSimpleAdapter } from "../../src/import/newrecruit-simple.js";

const ds = Dataset.embedded();

// GW app export (world-eaters dialect): `(N Points)`, bare faction/detachment
// preamble, ALL-CAPS sections, `◦` child wargear, single-model characters.
const GW_APP = `Ding dong (1995 Points)

World Eaters
Berzerker Warband
Strike Force (2,000 Points)

CHARACTERS

Khârn the Betrayer (100 Points)
  • Warlord
  • 1x Gorechild
  • 1x Plasma pistol

Master of Executions (95 Points)
  • 1x Axe of dismemberment
  • Enhancements: Berzerker Glaive

BATTLELINE

Khorne Berzerkers (180 Points)
  • 1x Khorne Berzerker Champion
     ◦ 1x Chainblade
  • 9x Khorne Berzerker
     ◦ 8x Bolt pistol
     ◦ 7x Chainblade

Exported with App Version: v1.48.0 (1), Data Version: v750
`;

// Markdown `##` fixture dialect: `(N pts)`, `• Nx Model: wargear`.
const MD_FIXTURE = `Test Army - Space Marines - Gladius Task Force (300 pts)

## Battleline (200 pts)
Intercessor Squad (200 pts)
  • 4x Intercessor: Bolt rifle
  • Intercessor Sergeant: Bolt rifle
`;

// NewRecruit text dialect WITH the ListForge `name - faction - detachment
// (N Points)` first line — listForgeTextAdapter claims this, so headerless must
// defer (used only for the disjointness assertion below).
const NR_TEXT = `all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)

Character:
Bloodmaster (65 pts)
  • Blade of blood
`;

// Same `Title:` + deeper-`•` children body, but a bare (1-part) title line, so
// it lacks the ListForge header and headerless does claim it. Exercises the
// nested model-group counting (a count-less bullet with children is a model).
const NR_TEXT_BARE = `Daemon Incursion (1995 Points)

Character:
Bloodmaster (65 pts)
  • Blade of blood

Battleline:
Bloodletters (110 pts)
  • Bloodreaper
    • Hellblade
  • Instrument of Chaos
  • 9x Bloodletter
    • 9x Hellblade
`;

// GW app v2.0.5 "Attached Units" export: models nest under `Attached as:`
// annotations, and each model bullets only its first weapon — the rest are
// unbulleted, deeper-indented continuation lines. Exercises the four cases the
// v2.0.5 parser must handle: continuation-line capture, `Attached as:`
// annotations, model + deeper-bulleted weapon, and a lone bulleted weapon with
// plain continuations (Fire Prism) that must NOT read as a model.
const GW_V2_ATTACHED = `Test List (2275 points)

Aeldari
Armoured Warhost

Attached Units
Attached Unit 1

Warlock Conclave (120 points)
• Attached as: Leader
• Leading: Eldrad Ulthran
  • 4x Warlock
    • 4x Destructor
      4x Shuriken pistol
      4x Singing Spear

Eldrad Ulthran (130 points)
• Attached as: Leader (Character)
• Leader: Warlock Conclave
  • Warlord
  • 1x Mind War
    1x Shuriken pistol
    1x The Staff of Ulthamar and witchblade

OTHER DATASHEETS

Fire Prism (150 points)
  • 1x Prism cannon
    1x Twin shuriken catapult
    1x Wraithbone hull

Fire Dragons (120 points)
  • 1x Fire Dragon Exarch
    • 1x Close combat weapon
      1x Firepike
  • 4x Fire Dragon
    • 4x Close combat weapon
      4x Dragon fusion gun

Exported with App Version: v2.0.5 (128), Data Version: v886
`;

describe("gwHeaderlessAdapter.matches", () => {
  it("accepts the GW app export", () => {
    expect(gwHeaderlessAdapter.matches(GW_APP)).toBe(true);
  });

  it("accepts the markdown `##` dialect", () => {
    expect(gwHeaderlessAdapter.matches(MD_FIXTURE)).toBe(true);
  });

  it("declines the framed GW export (belongs to gwAdapter)", () => {
    expect(
      gwHeaderlessAdapter.matches(
        "+ FACTION KEYWORD: X\n\nU (1 pts)\n• 1x W\n",
      ),
    ).toBe(false);
  });

  it("declines the ListForge-text header (belongs to listForgeTextAdapter)", () => {
    // NR_TEXT carries the `name - faction - detachment (N Points)` first line,
    // which listForgeTextAdapter claims; we must defer to keep matchers disjoint.
    expect(gwHeaderlessAdapter.matches(NR_TEXT)).toBe(false);
    expect(listForgeTextAdapter.matches(NR_TEXT)).toBe(true);
  });

  it("declines bullet-less text and non-strings", () => {
    expect(gwHeaderlessAdapter.matches("U (100 pts)\n")).toBe(false);
    expect(gwHeaderlessAdapter.matches({ roster: {} })).toBe(false);
  });

  it("stays disjoint from the other text matchers on the GW app sample", () => {
    expect(gwAdapter.matches(GW_APP)).toBe(false);
    expect(newRecruitSimpleAdapter.matches(GW_APP)).toBe(false);
    expect(listForgeTextAdapter.matches(GW_APP)).toBe(false);
  });
});

describe("gwHeaderlessAdapter.parse", () => {
  it("parses the GW app export with preamble faction/detachment", () => {
    const p = gwHeaderlessAdapter.parse(GW_APP);
    expect(p.name).toBe("Ding dong");
    // Faction / detachment are read from the bare preamble lines.
    expect(p.faction_raw_name).toBe("World Eaters");
    expect(p.detachment_raw_names).toEqual(["Berzerker Warband"]);
    expect(p.units).toHaveLength(3);

    const kharn = p.units[0];
    expect(kharn.raw_name).toBe("Khârn the Betrayer");
    expect(kharn.is_warlord).toBe(true);
    expect(kharn.is_character).toBe(true); // CHARACTERS section
    expect(kharn.model_count).toBe(1);
    expect(kharn.wargear.some((w) => w.raw_name === "Gorechild")).toBe(true);

    const moe = p.units[1];
    expect(moe.enhancement_raw_name).toBe("Berzerker Glaive");

    const zerks = p.units[2];
    expect(zerks.model_count).toBe(10); // 1 champion + 9
    const bolt = zerks.wargear.find((w) => w.raw_name === "Bolt pistol");
    expect(bolt?.count).toBe(8); // squad-wide `◦` child total
  });

  it("counts colon-wargear model groups in the markdown dialect", () => {
    const p = gwHeaderlessAdapter.parse(MD_FIXTURE);
    expect(p.units).toHaveLength(1);
    const squad = p.units[0];
    expect(squad.raw_name).toBe("Intercessor Squad");
    expect(squad.model_count).toBe(5); // 4 + 1
    const bolt = squad.wargear.find((w) => w.raw_name === "Bolt rifle");
    expect(bolt?.count).toBe(5);
  });

  it("counts nested model groups in the `Title:`-section dialect", () => {
    const p = gwHeaderlessAdapter.parse(NR_TEXT_BARE);
    expect(p.units).toHaveLength(2);
    expect(p.units[0].model_count).toBe(1);
    expect(p.units[0].wargear.some((w) => w.raw_name === "Blade of blood")).toBe(
      true,
    );
    expect(p.units[1].model_count).toBe(10); // Bloodreaper + 9 Bloodletter
    expect(p.units[1].wargear.some((w) => w.raw_name === "Hellblade")).toBe(true);
  });

  it("captures unbulleted continuation weapons in the GW v2.0.5 attached format", () => {
    const p = gwHeaderlessAdapter.parse(GW_V2_ATTACHED);
    const byName = (name: string) => p.units.find((u) => u.raw_name === name)!;
    const wg = (u: (typeof p.units)[number], name: string) =>
      u.wargear.find((w) => w.raw_name === name);

    // Model group with an `Attached as:` prefix: the model line is `Warlock`,
    // and both the bulleted and the two unbulleted continuation weapons attach.
    const conclave = byName("Warlock Conclave");
    expect(conclave.model_count).toBe(4);
    expect(wg(conclave, "Destructor")?.count).toBe(4);
    expect(wg(conclave, "Shuriken pistol")?.count).toBe(4); // was dropped pre-fix
    expect(wg(conclave, "Singing Spear")?.count).toBe(4); // was dropped pre-fix
    // The model name and the attachment role must not leak into wargear.
    expect(wg(conclave, "Warlock")).toBeUndefined();
    expect(conclave.wargear.some((w) => /attached as|leader/i.test(w.raw_name))).toBe(
      false,
    );
    expect(conclave.wargear.some((w) => /leading/i.test(w.raw_name))).toBe(false);

    // `Attached as: … (Character)` flags the unit; `Warlord` is still read.
    const eldrad = byName("Eldrad Ulthran");
    expect(eldrad.model_count).toBe(1);
    expect(eldrad.is_character).toBe(true);
    expect(eldrad.is_warlord).toBe(true);
    expect(wg(eldrad, "Shuriken pistol")?.count).toBe(1);
    expect(wg(eldrad, "The Staff of Ulthamar and witchblade")?.count).toBe(1);
    expect(eldrad.wargear.some((w) => /leader/i.test(w.raw_name))).toBe(false);

    // A lone bulleted weapon trailed by plain continuations is a single-model
    // unit whose bullet is wargear, not a model group.
    const prism = byName("Fire Prism");
    expect(prism.model_count).toBe(1);
    expect(wg(prism, "Prism cannon")?.count).toBe(1);
    expect(wg(prism, "Twin shuriken catapult")?.count).toBe(1);
    expect(wg(prism, "Wraithbone hull")?.count).toBe(1);

    // Two model groups, each `model → • weapon → plain weapon`.
    const dragons = byName("Fire Dragons");
    expect(dragons.model_count).toBe(5); // 1 Exarch + 4
    expect(wg(dragons, "Close combat weapon")?.count).toBe(5);
    expect(wg(dragons, "Firepike")?.count).toBe(1);
    expect(wg(dragons, "Dragon fusion gun")?.count).toBe(4);
  });
  it("recovers an unframed event preamble without creating a phantom unit", () => {
    const parsed = gwHeaderlessAdapter.parse(`Participant
Team
Drukhari
Recon (1995 points)
Skysplinter Assault (3 Detachment Points)

1995 points

CHARACTERS

Archon (100 points)
• Warlord
• 1x Huskblade
`);

    expect(parsed.name).toBe("Recon");
    expect(parsed.declared_limit).toBe(1995);
    expect(parsed.faction_raw_name).toBe("Drukhari");
    expect(parsed.detachment_raw_names).toEqual(["Skysplinter Assault"]);
    expect(parsed.units.map((unit) => unit.raw_name)).toEqual(["Archon"]);
  });
});


describe("gwHeaderlessAdapter via tryImportRoster", () => {
  it("auto-detects the GW app export and resolves against the dataset", () => {
    const result = tryImportRoster(GW_APP, { dataset: ds });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("gw");
    // Preamble capture lets resolve scope faction + detachment.
    expect(result.roster.faction_id).toBe("world-eaters");
    expect(result.roster.detachments.map((d) => d.ref.id)).toEqual([
      "berzerker-warband",
    ]);
    expect(result.roster.units.length).toBe(3);
    const zerks = result.roster.units.find(
      (u) => u.ref.id === "khorne-berzerkers",
    );
    expect(zerks?.model_count).toBe(10);
  });

  it("resolves the GW app units even via importRoster directly", () => {
    const roster = importRoster(GW_APP, { dataset: ds });
    expect(roster.faction_id).toBe("world-eaters");
    expect(roster.units.some((u) => u.ref.id === "kharn-the-betrayer")).toBe(true);
  });
});

// BCP prepends a `++…++` summary block (Player Name / Factions Used / Army Points
// / …) to text-type lists. Regression: its fence line was consumed as the roster
// title, so the real title line ("Ding dong (1995 Points)") became a phantom unit
// whose points doubled the computed total (a 1995pt list read as 3990). The block
// must be stripped so the body parses as if pasted straight from the GW app.
const BCP_WRAPPED = `++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Player Name:
Team Name: Example Team
Factions Used: World Eaters
Disposition Used: Purge the Foe
Detachment Used: Berzerker Warband
Army Upgrades and Enhancements (list on which model):
Master of Executions: Berzerker Glaive
Army Points: 375
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

${GW_APP}`;

describe("gwHeaderlessAdapter — BCP summary preamble", () => {
  it("matches despite the leading BCP `++…++` block", () => {
    expect(gwHeaderlessAdapter.matches(BCP_WRAPPED)).toBe(true);
  });

  it("strips the block: real title isn't a unit and points aren't doubled", () => {
    const p = gwHeaderlessAdapter.parse(BCP_WRAPPED);
    // Title consumed (not left as a phantom unit), faction read from the body.
    expect(p.name).toBe("Ding dong");
    expect(p.faction_raw_name).toBe("World Eaters");
    expect(p.units).toHaveLength(3);
    expect(p.units.some((u) => u.raw_name === "Ding dong")).toBe(false);
    // 375 (Khârn 100 + MoE 95 + Berzerkers 180), NOT 375 + 1995.
    expect(p.total_computed).toBe(375);
    // Parsing the wrapped and unwrapped text yields the same units + total.
    const plain = gwHeaderlessAdapter.parse(GW_APP);
    expect(p.units.map((u) => u.raw_name)).toEqual(plain.units.map((u) => u.raw_name));
    expect(p.total_computed).toBe(plain.total_computed);
  });

  it("resolves through tryImportRoster like the unwrapped export", () => {
    const result = tryImportRoster(BCP_WRAPPED, { dataset: ds });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("gw");
    expect(result.roster.faction_id).toBe("world-eaters");
    expect(result.roster.units.length).toBe(3);
  });
});
