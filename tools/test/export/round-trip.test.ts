/**
 * Round-trip property tests: for each of the four NewRecruit formats, the
 * pipeline `Roster → export → import → Roster'` must produce the same Roster
 * (a fixed point). Faction/detachment display names lose case nuance through
 * `titleCaseId` round-tripping, but the *resolved* `faction_id` /
 * `detachment_id` survive untouched — so we compare on IDs and unit data.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Dataset } from "../../src/data/dataset.js";
import { importRoster } from "../../src/import/import-roster.js";
import { exportRoster } from "../../src/export/index.js";
import type { ExportFormat, Roster } from "../../src/index.js";

const ds = Dataset.embedded();

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)),
      "utf8",
    ),
  );

/** Strip fields that aren't expected to survive round-tripping: the
 * `source.format` discriminator naturally changes per hop, and the diagnostic
 * warning list shifts when the multi-force flag is inferred differently. */
function stable(r: Roster) {
  return {
    name: r.name,
    faction_id: r.faction_id,
    detachments: r.detachments,
    battle_size: r.battle_size,
    force_disposition: r.force_disposition,
    points: r.points,
    units: r.units,
    game_version: r.game_version,
  };
}

describe("export → import round-trips", () => {
  const seed = importRoster(
    fixture("chaos-knights-houndpack.newrecruit.payload.json"),
    { dataset: ds },
  );

  const formats: ExportFormat[] = [
    "newrecruit-json",
    "newrecruit-wtc-compact",
    "newrecruit-wtc-full",
    "newrecruit-simple",
    "roster-json",
    "rosterizer",
  ];

  const jsonFormats: Partial<Record<ExportFormat, true>> = {
    "newrecruit-json": true,
    "roster-json": true,
    rosterizer: true,
  };

  for (const format of formats) {
    it(`Roster → ${format} → Roster is a fixed point`, () => {
      const out = exportRoster(seed, format);
      expect(out.length).toBeGreaterThan(0);
      // Re-import: JSON formats parse through importRoster directly; text
      // formats too (the orchestrator dispatches on string vs. object).
      const reparsed = jsonFormats[format]
        ? importRoster(JSON.parse(out), { dataset: ds })
        : importRoster(out, { dataset: ds });
      expect(stable(reparsed)).toEqual(stable(seed));
    });
  }
  it.each(formats)("preserves explicit 11e metadata through %s", (format) => {
    const rich = structuredClone(seed);
    rich.name = "Fabricated Roundtrip Roster";
    rich.force_disposition = "disruption";
    rich.detachments.push({
      ref: {
        id: "lords-of-dread",
        raw_name: "Lords of Dread",
        resolved: true,
        candidates: [],
      },
      dp_cost: 2,
    });
    rich.units[0].leader_attachment = {
      bodyguard_ref: structuredClone(rich.units[1].ref),
      role: "leader",
      provisional: false,
    };

    const out = exportRoster(rich, format);
    const reparsed = jsonFormats[format]
      ? importRoster(JSON.parse(out), { dataset: ds })
      : importRoster(out, { dataset: ds });
    expect(stable(reparsed)).toEqual(stable(rich));
  });


  it.each(["newrecruit-json", "newrecruit-simple"] as const)(
    "preserves a named single-model loadout group through %s",
    (format) => {
      const grouped = structuredClone(seed);
      const unit = grouped.units.find((candidate) => candidate.model_count === 1);
      if (!unit) throw new Error("fixture has no single-model unit");
      unit.loadout_groups = [{
        model_name: "Fabricated Pilot",
        count: 1,
        wargear: structuredClone(unit.wargear),
      }];

      const out = exportRoster(grouped, format, ds);
      const reparsed = importRoster(
        format === "newrecruit-json" ? JSON.parse(out) : out,
        { dataset: ds },
      );
      expect(stable(reparsed)).toEqual(stable(grouped));
    },
  );

  it("preserves fabricated empty exact loadout groups through newrecruit-simple", () => {
    const grouped = structuredClone(seed);
    const [emptyFirst, emptyMiddle, allEmpty] = grouped.units;
    if (!emptyFirst || !emptyMiddle || !allEmpty) {
      throw new Error("fixture needs three units");
    }

    const firstWeapon = structuredClone(emptyFirst.wargear[0]);
    const middleWeapon = structuredClone(emptyMiddle.wargear[0]);
    if (!firstWeapon || !middleWeapon) {
      throw new Error("fixture units need wargear");
    }
    firstWeapon.count = 1;
    middleWeapon.count = 1;

    emptyFirst.model_count = 3;
    emptyFirst.wargear = [{ ...firstWeapon, count: 2 }];
    emptyFirst.loadout_groups = [
      { model_name: "Fabricated Empty First", count: 1, wargear: [] },
      { model_name: "Fabricated Equipped Second", count: 2, wargear: [firstWeapon] },
    ];

    emptyMiddle.model_count = 3;
    emptyMiddle.wargear = [{ ...middleWeapon, count: 2 }];
    emptyMiddle.loadout_groups = [
      { model_name: "Fabricated Equipped First", count: 1, wargear: [middleWeapon] },
      { model_name: "Fabricated Empty Middle", count: 1, wargear: [] },
      { model_name: "Fabricated Equipped Last", count: 1, wargear: [middleWeapon] },
    ];

    allEmpty.model_count = 3;
    allEmpty.wargear = [];
    allEmpty.loadout_groups = [
      { model_name: "Fabricated Empty First", count: 1, wargear: [] },
      { model_name: "Fabricated Empty Last", count: 2, wargear: [] },
    ];

    const out = exportRoster(grouped, "newrecruit-simple", ds);
    const reparsed = importRoster(out, { dataset: ds });
    expect(stable(reparsed)).toEqual(stable(grouped));
  });

  it("never emits prose in any text format", () => {
    for (const format of formats) {
      const out = exportRoster(seed, format);
      expect(out).not.toMatch(/Aura\)\*\*/);
      expect(out).not.toMatch(/Each time an attack/);
      expect(out).not.toMatch(/\$text/);
    }
  });
});
