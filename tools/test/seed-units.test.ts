import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { MfmDump, DEFAULT_DUMP_PATH, REPO_ROOT, loadDump } from "../src/mfm/loader.js";
import { buildSeedUnit, runSeedUnits } from "../src/mfm/seed-units.js";

/**
 * buildSeedUnit is pure over the dump tables (no filesystem), so it runs without
 * _private/dump.json. mkDump fills every table the builder touches with a default
 * [] so MfmDump.table()'s typo-guard never throws on an absent table.
 */
function mkDump(tables: Record<string, unknown[]>): MfmDump {
  const empty = [
    "datasheet",
    "miniature",
    "miniature_keyword",
    "keyword",
    "datasheet_faction_keyword",
    "faction_keyword",
    "unit_composition",
    "unit_composition_miniature",
    "datasheet_points_step",
    "publication",
  ];
  const data: Record<string, unknown[]> = {};
  for (const t of empty) data[t] = [];
  Object.assign(data, tables);
  return new MfmDump({ data: data as never });
}

function mini(over: Record<string, unknown>) {
  return {
    id: "m1",
    datasheetId: "ds1",
    displayOrder: 1,
    statlineHidden: false,
    isIndividualModels: false,
    movement: '6"',
    toughness: "4",
    save: "3+",
    wounds: "2",
    leadership: "6+",
    objectiveControl: "2",
    localisations: { en: { name: "Trooper" } },
    ...over,
  };
}

const DS = { id: "ds1", publicationId: "p1", isLegends: false, displayOrder: 1, maxModelCount: null };

describe("buildSeedUnit", () => {
  it("seeds a single-model unit with normalized stats, keywords, role, model_count", () => {
    const dump = mkDump({
      datasheet: [{ ...DS, localisations: { en: { name: "Knight Destrier", lore: "SECRET PROSE" } } }],
      miniature: [
        mini({
          movement: '12"',
          toughness: "10",
          save: "3+",
          wounds: "18",
          leadership: "6+",
          objectiveControl: "8",
          localisations: { en: { name: "Knight Destrier" } },
        }),
      ],
      miniature_keyword: [
        { id: "mk1", displayOrder: 1, miniatureId: "m1", keywordId: "k-veh" },
        { id: "mk2", displayOrder: 2, miniatureId: "m1", keywordId: "k-char" },
      ],
      keyword: [
        { id: "k-veh", localisations: { en: { name: "Vehicle" } } },
        { id: "k-char", localisations: { en: { name: "Character" } } },
      ],
      datasheet_faction_keyword: [{ id: "f1", displayOrder: 1, datasheetId: "ds1", factionKeywordId: "fk-ik" }],
      faction_keyword: [{ id: "fk-ik", localisations: { en: { name: "Imperial Knights" } } }],
      unit_composition: [{ id: "c1", datasheetId: "ds1", points: 420, displayOrder: 1, referenceGroupingKeywordId: null }],
      unit_composition_miniature: [{ id: "ucm1", min: 1, max: 1, unitCompositionId: "c1", miniatureId: "m1" }],
    });

    const u = buildSeedUnit(dump, dump.byId("datasheet").get("ds1") as never, "imperial-knights");
    expect(u.id).toBe("knight-destrier");
    expect(u.name).toBe("Knight Destrier");
    expect(u.faction_id).toBe("imperial-knights");
    expect(u.profiles).toHaveLength(1);
    expect(u.profiles[0]).toMatchObject({ M: 12, T: 10, W: 18, Sv: 3, invuln_sv: null, Ld: 6, OC: 8 });
    expect(u.keywords).toEqual(["Vehicle", "Character"]);
    expect(u.faction_keywords).toEqual(["Imperial Knights"]);
    expect(u.role).toBe("character");
    expect(u.model_count).toEqual({ min: 1, max: 1 });
    // points come straight from the dump composition (420), so it is not provisional
    expect(u.points).toEqual([{ models: 1, cost: 420 }]);
    expect(u.points_provisional).toBe(false);
    expect(u.is_legend).toBe(false);
    // loadout + abilities are follow-ups, so absent
    expect(u).not.toHaveProperty("weapon_ids");
    expect(u).not.toHaveProperty("ability_ids");
  });

  it("normalizes stat strings and skips a unit with a non-numeric ('-') stat", () => {
    const ds = (mv: string) =>
      mkDump({
        datasheet: [{ ...DS, localisations: { en: { name: "Test Unit" } } }],
        miniature: [mini({ movement: mv, save: "2", leadership: "6+" })],
        faction_keyword: [],
      });
    // '2' (no plus) parses fine; '-' is unrepresentable → throws.
    expect(buildSeedUnit(ds('10"'), ds('10"').byId("datasheet").get("ds1") as never, "orks").profiles[0].M).toBe(10);
    const bad = ds("-");
    expect(() => buildSeedUnit(bad, bad.byId("datasheet").get("ds1") as never, "orks")).toThrow();
  });

  it("collapses miniatures sharing a statline and drops hidden statlines", () => {
    const dump = mkDump({
      datasheet: [{ ...DS, localisations: { en: { name: "Squad" } } }],
      miniature: [
        mini({ id: "m1", displayOrder: 1, localisations: { en: { name: "Trooper" } } }),
        // sergeant: same stats, statline hidden → no new profile
        mini({ id: "m2", displayOrder: 2, statlineHidden: true, localisations: { en: { name: "Sergeant" } } }),
        // another trooper variant with identical stats → deduped
        mini({ id: "m3", displayOrder: 3, localisations: { en: { name: "Gunner" } } }),
      ],
    });
    const u = buildSeedUnit(dump, dump.byId("datasheet").get("ds1") as never, "orks");
    expect(u.profiles).toHaveLength(1);
    expect(u.profiles[0].name).toBe("Trooper");
  });

  it("emits two profiles for two distinct visible statlines, in display order", () => {
    const dump = mkDump({
      datasheet: [{ ...DS, localisations: { en: { name: "Command Squad" } } }],
      miniature: [
        mini({ id: "m1", displayOrder: 2, wounds: "1", localisations: { en: { name: "Guardsman" } } }),
        mini({ id: "m2", displayOrder: 1, wounds: "3", localisations: { en: { name: "Leader" } } }),
      ],
    });
    const u = buildSeedUnit(dump, dump.byId("datasheet").get("ds1") as never, "astra-militarum");
    expect(u.profiles).toHaveLength(2);
    expect(u.profiles.map((p) => p.name)).toEqual(["Leader", "Guardsman"]); // by displayOrder
    expect(u.profiles.map((p) => p.W)).toEqual([3, 1]);
  });

  it("filters faction_keywords to the home keyword for single-token Chaos factions", () => {
    const dump = mkDump({
      datasheet: [{ ...DS, localisations: { en: { name: "Chaos Rhino" } } }],
      miniature: [mini({})],
      datasheet_faction_keyword: [
        { id: "f1", displayOrder: 1, datasheetId: "ds1", factionKeywordId: "fk-we" },
        { id: "f2", displayOrder: 2, datasheetId: "ds1", factionKeywordId: "fk-ha" },
      ],
      faction_keyword: [
        { id: "fk-we", localisations: { en: { name: "World Eaters" } } },
        { id: "fk-ha", localisations: { en: { name: "Heretic Astartes" } } },
      ],
    });
    const u = buildSeedUnit(dump, dump.byId("datasheet").get("ds1") as never, "world-eaters");
    expect(u.faction_keywords).toEqual(["World Eaters"]);
  });

  it("never leaks GW prose (lore) into the seeded unit", () => {
    const dump = mkDump({
      datasheet: [
        {
          ...DS,
          localisations: { en: { name: "Lore Unit", lore: "FORBIDDEN_LORE_TEXT", unitComposition: "FORBIDDEN_COMP" } },
        },
      ],
      miniature: [mini({})],
    });
    const u = buildSeedUnit(dump, dump.byId("datasheet").get("ds1") as never, "orks");
    const json = JSON.stringify(u);
    expect(json).not.toContain("FORBIDDEN_LORE_TEXT");
    expect(json).not.toContain("FORBIDDEN_COMP");
  });
});

// Integration over the real dump — only when _private/dump.json is present
// (it is gitignored, so CI without it skips this). Guards the committed end-state:
// the 21 matched-play units are seeded, the 98 Combat-Patrol-only units stay held
// back, and a re-run is idempotent. (Count assertions are steady-state, not deltas,
// so they hold after the seed has been committed.)
describe.skipIf(!fs.existsSync(DEFAULT_DUMP_PATH))("runSeedUnits over the real dump", () => {
  it("holds back exactly 98 Combat-Patrol-only units, never skips, and is idempotent once seeded", () => {
    const r = runSeedUnits(loadDump());
    const created = r.dirs.reduce((a, d) => a + d.created.length, 0);
    const cpExcluded = r.dirs.reduce((a, d) => a + d.cpExcluded.length, 0);
    const skipped = r.dirs.reduce((a, d) => a + d.skipped.length, 0);
    // The 98 CP-only units are never in the matched-play repo, so they are always
    // held back. Nothing is unusable. created is 0 once the 21 are committed.
    expect({ created, cpExcluded, skipped }).toEqual({ created: 0, cpExcluded: 98, skipped: 0 });
  });

  it("routes SM-chapter dirs to their adeptus-astartes parent", () => {
    const r = runSeedUnits(loadDump(), { includeCombatPatrol: true });
    const bt = r.dirs.find((d) => d.dir === "black-templars");
    expect(bt?.routedTo).toBe("adeptus-astartes");
  });

  it("has the 21 matched-play units in the repo, Knight Destrier priced", () => {
    const dataRoot = `${REPO_ROOT}/data/core`;
    const destrier = JSON.parse(
      fs.readFileSync(`${dataRoot}/imperial-knights/units.json`, "utf8"),
    ).find((u: { id: string }) => u.id === "knight-destrier");
    expect(destrier).toBeDefined();
    expect(destrier.points_provisional).toBe(false);
    expect(destrier.points.length).toBeGreaterThan(0);
  });
});
