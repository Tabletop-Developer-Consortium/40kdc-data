import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Dataset } from "../../src/data/dataset.js";
import { importRoster } from "../../src/import/import-roster.js";
import type { Roster } from "../../src/import/types.js";

const ds = Dataset.embedded();

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), "utf8"),
  );

const unitById = (r: Roster, id: string) => r.units.find((u) => u.ref.id === id);
const unitByRaw = (r: Roster, raw: string) => r.units.find((u) => u.ref.raw_name === raw);

describe("resolve (against embedded grey-knights data)", () => {
  const roster = importRoster(fixture("gk-banishers.payload.json"), { dataset: ds });

  it("resolves faction, detachment, and battle size", () => {
    expect(roster.faction_id).toBe("grey-knights");
    expect(roster.detachments.map((d) => d.ref.id)).toEqual(["banishers"]);
    expect(roster.battle_size).toBe("strike-force");
    expect(roster.points).toEqual({
      declared_limit: 2000,
      detachment_cap: 3,
      total_reported: 585,
      total_computed: 585,
    });
  });

  it("resolves units to their entity ids", () => {
    expect(unitById(roster, "castellan-crowe")).toBeDefined();
    expect(unitById(roster, "grand-master-in-nemesis-dreadknight")).toBeDefined();
    expect(unitById(roster, "purifier-squad")).toBeDefined();
  });

  it("resolves the enhancement scoped to the detachment", () => {
    const gm = unitById(roster, "grand-master-in-nemesis-dreadknight")!;
    expect(gm.is_warlord).toBe(true);
    expect(gm.enhancement?.id).toBe("pyresoul-psychic-banishers");
    expect(gm.enhancement?.resolved).toBe(true);
  });

  it("resolves wargear to weapon ids", () => {
    const gm = unitById(roster, "grand-master-in-nemesis-dreadknight")!;
    const ids = gm.wargear.map((w) => w.ref.id);
    expect(ids).toContain("heavy-psycannon");
    expect(ids).toContain("nemesis-daemon-greathammer");
    expect(gm.wargear.every((w) => w.ref.resolved)).toBe(true);
  });

  it("reports clean diagnostics for a fully-resolved list", () => {
    expect(roster.diagnostics.resolved_units).toBe(3);
    expect(roster.diagnostics.unresolved_units).toBe(0);
    expect(roster.diagnostics.unresolved_weapons).toBe(0);
  });

  it("does not auto-attach a solo-capable leader (support-only inference)", () => {
    // Grand Master can lead a Paladin Squad, but its dump-sourced attachment_role
    // is "leader" — solo-capable — so the importer leaves it unattached for the
    // user to place. Only "support" characters (which cannot be taken solo) are
    // auto-attached. See inferLeaderAttachments in import/resolve.ts.
    const payload = {
      name: "Leader Test",
      generatedBy: "List Forge",
      roster: {
        name: "Leader Test",
        costs: [{ name: "pts", value: 0 }],
        forces: [
          {
            id: "f1",
            name: "Army Roster",
            selections: [
              {
                id: "u-gm",
                name: "Grand Master",
                type: "model",
                number: 1,
                categories: [
                  { name: "Faction: Grey Knights" },
                  { name: "Character", primary: true },
                ],
              },
              {
                id: "u-paladins",
                name: "Paladin Squad",
                type: "unit",
                number: 1,
                categories: [
                  { name: "Faction: Grey Knights" },
                  { name: "Infantry", primary: true },
                ],
              },
            ],
          },
        ],
      },
    };
    const r = importRoster(payload, { dataset: ds });
    const gm = unitById(r, "grand-master")!;
    expect(gm.leader_attachment).toBeNull();
    expect(r.diagnostics.warnings.some((w) => w.code === "leader-attachment-inferred")).toBe(false);
  });

  it("auto-attaches a support character to an eligible bodyguard", () => {
    // A Painboy (dump-sourced attachment_role "support") cannot be fielded solo,
    // so the importer attaches it to an eligible bodyguard (Boyz) when one is in
    // the roster, flagged provisional with a diagnostic warning.
    const payload = {
      name: "Support Test",
      generatedBy: "List Forge",
      roster: {
        name: "Support Test",
        costs: [{ name: "pts", value: 0 }],
        forces: [
          {
            id: "f1",
            name: "Army Roster",
            selections: [
              {
                id: "u-painboy",
                name: "Painboy",
                type: "model",
                number: 1,
                categories: [{ name: "Faction: Orks" }, { name: "Character", primary: true }],
              },
              {
                id: "u-boyz",
                name: "Boyz",
                type: "unit",
                number: 10,
                categories: [{ name: "Faction: Orks" }, { name: "Infantry", primary: true }],
              },
            ],
          },
        ],
      },
    };
    const r = importRoster(payload, { dataset: ds });
    const pb = unitById(r, "painboy")!;
    expect(pb.leader_attachment).not.toBeNull();
    expect(pb.leader_attachment!.bodyguard_ref.id).toBe("boyz");
    expect(pb.leader_attachment!.provisional).toBe(true);
    expect(r.diagnostics.warnings.some((w) => w.code === "leader-attachment-inferred")).toBe(true);
  });

  it("retains an unresolved unit with candidates and a warning", () => {
    const payload = {
      name: "Miss Test",
      generatedBy: "List Forge",
      roster: {
        name: "Miss Test",
        costs: [{ name: "pts", value: 0 }],
        forces: [
          {
            id: "f1",
            name: "Army Roster",
            selections: [
              {
                id: "u-bogus",
                name: "Definitely Not A Real Unit",
                type: "model",
                number: 1,
                categories: [{ name: "Faction: Grey Knights" }, { name: "Character" }],
              },
            ],
          },
        ],
      },
    };
    const r = importRoster(payload, { dataset: ds });
    const miss = unitByRaw(r, "Definitely Not A Real Unit")!;
    expect(miss.ref.id).toBeNull();
    expect(miss.ref.resolved).toBe(false);
    expect(r.diagnostics.unresolved_units).toBe(1);
    expect(r.diagnostics.warnings.some((w) => w.code === "unit-unresolved")).toBe(true);
  });

  it("flags multi-force lists and resolves the primary faction", () => {
    const r = importRoster(fixture("gk-allied-multiforce.payload.json"), { dataset: ds });
    expect(r.faction_id).toBe("grey-knights");
    expect(r.diagnostics.warnings.some((w) => w.code === "multi-force")).toBe(true);
    expect(r.units.length).toBe(2);
  });
});

describe("name resolution: faction-prefixed shared chassis and unit aliases", () => {
  // GW/NewRecruit subfaction exports prefix the faction display name onto the
  // shared Chaos chassis, sometimes keeping "Chaos" ("Death Guard Chaos Spawn")
  // and sometimes replacing it ("Death Guard Rhino" ← dataset "Chaos Rhino"). The
  // resolver tries the name as-is, prefix-stripped, and prefix→"Chaos ", scoped to
  // the faction. This is a general rule, not per-unit aliases.
  const factionList = (factionLabel: string, ...unitNames: string[]) => ({
    name: "Test",
    generatedBy: "List Forge",
    roster: {
      name: "Test",
      costs: [{ name: "pts", value: 0 }],
      forces: [
        {
          id: "f1",
          name: "Army Roster",
          selections: unitNames.map((name, i) => ({
            id: `u-${i}`,
            name,
            type: "unit",
            number: 1,
            categories: [{ name: `Faction: ${factionLabel}` }, { name: "Infantry", primary: true }],
          })),
        },
      ],
    },
  });

  it("strips a kept-Chaos faction prefix (Death Guard Chaos Spawn → chaos-spawn)", () => {
    const r = importRoster(factionList("World Eaters", "World Eaters Chaos Spawn"), { dataset: ds });
    expect(unitByRaw(r, "World Eaters Chaos Spawn")!.ref.id).toBe("chaos-spawn");
    expect(unitByRaw(r, "World Eaters Chaos Spawn")!.ref.resolved).toBe(true);
  });

  it("substitutes the faction prefix with 'Chaos ' (World Eaters Rhino → chaos-rhino)", () => {
    const r = importRoster(factionList("World Eaters", "World Eaters Rhino"), { dataset: ds });
    expect(unitByRaw(r, "World Eaters Rhino")!.ref.id).toBe("chaos-rhino");
  });

  it("resolves the shared Rhino for EVERY Chaos cult, under the correct faction", () => {
    // The Rhino (and Spawn/Land Raider) is shared across all five Chaos cults. Each
    // cult's prefixed export must resolve to the shared chaos-* id AND land under
    // that cult's faction_id — so the faction-scoped variant (points/keywords) is
    // the cult's, not whichever copy registered first. This is the case per-unit
    // aliases would have missed.
    const cults: [string, string][] = [
      ["World Eaters", "world-eaters"],
      ["Death Guard", "death-guard"],
      ["Thousand Sons", "thousand-sons"],
      ["Emperor’s Children", "emperors-children"],
    ];
    for (const [label, factionId] of cults) {
      const r = importRoster(factionList(label, `${label} Rhino`), { dataset: ds });
      expect(r.faction_id, `${label} faction`).toBe(factionId);
      const rhino = unitByRaw(r, `${label} Rhino`)!;
      expect(rhino.ref.id, `${label} rhino id`).toBe("chaos-rhino");
      expect(rhino.ref.resolved).toBe(true);
      // The shared id resolves to the cult's own variant (distinct points per cult).
      expect(ds.units.getInFaction("chaos-rhino", factionId), `${label} variant`).toBeDefined();
    }
    // Base CSM export is bare (no faction prefix) and still resolves.
    const csm = importRoster(factionList("Chaos Space Marines", "Chaos Rhino", "Chaos Land Raider"), {
      dataset: ds,
    });
    expect(csm.faction_id).toBe("chaos-space-marines");
    expect(unitByRaw(csm, "Chaos Rhino")!.ref.id).toBe("chaos-rhino");
    expect(unitByRaw(csm, "Chaos Land Raider")!.ref.id).toBe("chaos-land-raider");

    // Mixed shared chassis in one list (kept-"Chaos" + dropped-"Chaos" forms).
    const dg = importRoster(factionList("Death Guard", "Death Guard Rhino", "Death Guard Chaos Spawn"), {
      dataset: ds,
    });
    expect(unitByRaw(dg, "Death Guard Rhino")!.ref.id).toBe("chaos-rhino");
    expect(unitByRaw(dg, "Death Guard Chaos Spawn")!.ref.id).toBe("chaos-spawn");
  });

  it("resolves a trademark spelling variant via the unit's aliases", () => {
    const r = importRoster(factionList("World Eaters", "Khorne Berserkers"), { dataset: ds });
    expect(unitByRaw(r, "Khorne Berserkers")!.ref.id).toBe("khorne-berzerkers");
    expect(r.diagnostics.unresolved_units).toBe(0);
  });

  it("does not strip a prefix that is not the resolved faction's name", () => {
    const r = importRoster(factionList("World Eaters", "Chaos Spawn"), { dataset: ds });
    expect(unitByRaw(r, "Chaos Spawn")!.ref.id).toBe("chaos-spawn");
  });

  it("still reports a genuinely unknown name as unresolved (no blind fuzzy match)", () => {
    const r = importRoster(factionList("World Eaters", "World Eaters Khorne Berserkrs"), { dataset: ds });
    expect(unitByRaw(r, "World Eaters Khorne Berserkrs")!.ref.resolved).toBe(false);
    expect(r.diagnostics.unresolved_units).toBe(1);
  });
});
