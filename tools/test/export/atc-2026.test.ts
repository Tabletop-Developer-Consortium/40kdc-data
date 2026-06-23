/**
 * ATC 2026 export tests. The conformance fixtures all carry
 * `force_disposition: null` and no inferred leader attachments, so the
 * populated DISPOSITION / multi-ENHANCEMENT / LEADER-SUPPORT header paths are
 * exercised here against a hand-built Roster instead.
 */
import { describe, it, expect } from "vitest";
import { exportRoster } from "../../src/export/index.js";
import type { ResolvedRef, Roster, RosterUnit } from "../../src/import/types.js";

const ref = (id: string | null, raw_name: string): ResolvedRef => ({
  id,
  raw_name,
  resolved: id !== null,
  candidates: [],
});

const unit = (over: Partial<RosterUnit> & { ref: ResolvedRef }): RosterUnit => ({
  model_count: 1,
  points: 100,
  is_warlord: false,
  enhancement: null,
  enhancement_points: null,
  wargear: [],
  leader_attachment: null,
  ...over,
});

function roster(over: Partial<Roster>): Roster {
  return {
    name: "Test List",
    source: { format: "roster-json", generated_by: null },
    faction_id: "adeptus-astartes",
    detachments: [{ ref: ref("gladius-task-force", "Gladius Task Force"), dp_cost: null }],
    battle_size: null,
    force_disposition: null,
    points: { declared_limit: 2000, detachment_cap: null, total_reported: 500, total_computed: 500 },
    units: [],
    game_version: { edition: "10", dataslate: "test" },
    diagnostics: {
      resolved_units: 0,
      unresolved_units: 0,
      resolved_weapons: 0,
      unresolved_weapons: 0,
      warnings: [],
    },
    ...over,
  };
}

const populatedUnits: RosterUnit[] = [
  unit({
    ref: ref("captain", "Captain"),
    is_warlord: true,
    enhancement: ref("the-honour-vehement", "The Honour Vehement"),
    enhancement_points: 25,
    leader_attachment: { bodyguard_ref: ref("assault-intercessor-squad", "Assault Squad"), provisional: true },
    wargear: [{ ref: ref("power-fist", "Power fist"), count: 1 }],
  }),
  unit({
    ref: ref("lieutenant", "Lieutenant"),
    enhancement: ref("artificer-armour", "Artificer Armour"),
    enhancement_points: 10,
    leader_attachment: { bodyguard_ref: ref("infernus-squad", "Infernus Squad"), provisional: true },
  }),
  unit({ ref: ref("assault-intercessor-squad", "Assault Squad"), model_count: 5 }),
  unit({ ref: ref("infernus-squad", "Infernus Squad"), model_count: 5 }),
];

describe("ATC 2026 export header", () => {
  it("renders disposition, every enhancement, and leader/support attachments", () => {
    const out = exportRoster(roster({ force_disposition: "take-and-hold", units: populatedUnits }), "atc-2026-compact");
    const header = out.split("\n").slice(0, 13);
    expect(header).toEqual([
      "+++++++++++++++++++++++++++++++++++++++++++++++",
      "+ PLAYER NAME: —",
      "+ TEAM NAME: —",
      "+ FACTIONS USED: Adeptus Astartes",
      "+ DISPOSITION: Take And Hold",
      "+ DETACHMENT: Gladius Task Force",
      "+ ARMY POINTS: 500pts",
      "+",
      "+ WARLORD: Char1: Captain",
      "+ ENHANCEMENT: The Honour Vehement (on Char1: Captain); Artificer Armour (on Char2: Lieutenant)",
      "+ LEADER/SUPPORT: Captain attached to Assault Squad; Lieutenant attached to Infernus Squad",
      "+ NUMBER OF UNITS: 4",
      "+++++++++++++++++++++++++++++++++++++++++++++++",
    ]);
  });

  it("falls back to em dashes when disposition, enhancements, and attachments are absent", () => {
    const out = exportRoster(
      roster({ units: [unit({ ref: ref("intercessor-squad", "Intercessor Squad"), model_count: 5 })] }),
      "atc-2026-full",
    );
    expect(out).toContain("+ DISPOSITION: —");
    expect(out).toContain("+ ENHANCEMENT: —");
    expect(out).toContain("+ LEADER/SUPPORT: —");
    expect(out).toContain("+ PLAYER NAME: —");
    expect(out).toContain("+ TEAM NAME: —");
  });

  it("reuses the WTC body verbatim — only the header differs", () => {
    const r = roster({ force_disposition: "disruption", units: populatedUnits });
    const ATC_HEADER_LINES = 13; // fence + 11 fields + fence
    const WTC_HEADER_LINES = 11; // fence + 9 fields + fence

    const atcCompact = exportRoster(r, "atc-2026-compact").split("\n").slice(ATC_HEADER_LINES);
    const wtcCompact = exportRoster(r, "newrecruit-wtc-compact").split("\n").slice(WTC_HEADER_LINES);
    expect(atcCompact).toEqual(wtcCompact);

    const atcFull = exportRoster(r, "atc-2026-full").split("\n").slice(ATC_HEADER_LINES);
    const wtcFull = exportRoster(r, "newrecruit-wtc-full").split("\n").slice(WTC_HEADER_LINES);
    expect(atcFull).toEqual(wtcFull);
  });

  it("matches the WTC trailing-byte convention for each body style", () => {
    const r = roster({ units: populatedUnits });
    // ATC reuses the WTC bodies, so the trailing bytes must match exactly.
    expect(exportRoster(r, "atc-2026-compact").endsWith("\n")).toBe(
      exportRoster(r, "newrecruit-wtc-compact").endsWith("\n"),
    );
    expect(exportRoster(r, "atc-2026-full").endsWith("\n")).toBe(
      exportRoster(r, "newrecruit-wtc-full").endsWith("\n"),
    );
  });
});
