import { describe, it, expect } from "vitest";
import { Dataset } from "../../src/data/dataset.js";
import { exportRoster } from "../../src/export/index.js";
import { tryImportRoster } from "../../src/import/import-roster.js";
import type { Roster, RosterUnit } from "../../src/import/types.js";

const ds = Dataset.embedded();

/** A resolved-ref literal for a known entity id. */
const ref = (id: string, raw_name: string) => ({ id, raw_name, resolved: true, candidates: [] });

/** A minimal resolved unit row carrying just enough to round-trip. */
function unitRow(id: string, model_count: number): RosterUnit {
  return {
    ref: ref(id, ds.units.getAny(id)!.name),
    model_count,
    points: null,
    is_warlord: false,
    enhancement: null,
    enhancement_points: null,
    wargear: [],
    leader_attachment: null,
  };
}

describe("roster-json round-trip (canonical pivot)", () => {
  // Pick any Space Marine leader that can lead at least one bodyguard.
  const leader = ds.units
    .byFaction("adeptus-astartes")
    .find((u) => ds.bodyguardsAttachableFrom(u.id).length > 0);
  if (!leader) throw new Error("no SM leader with an attachable bodyguard in the dataset");
  const bodyguard = ds.bodyguardsAttachableFrom(leader.id)[0];

  it("preserves an explicit leader→bodyguard attachment through export→import", () => {
    const leaderRow = unitRow(leader.id, 1);
    const bodyRow = unitRow(bodyguard.id, bodyguard.raw.model_count?.min ?? 1);
    // The builder emits an explicit, non-provisional, leader-role attachment.
    leaderRow.leader_attachment = {
      bodyguard_ref: ref(bodyguard.id, bodyguard.name),
      role: "leader",
      provisional: false,
    };

    const roster: Roster = {
      name: "Attachment Round-trip",
      source: { format: "roster-json", generated_by: null },
      faction_id: "adeptus-astartes",
      detachments: [],
      battle_size: null,
      force_disposition: null,
      points: { declared_limit: null, detachment_cap: null, total_reported: null, total_computed: 0 },
      units: [leaderRow, bodyRow],
      game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
      diagnostics: {
        resolved_units: 0,
        unresolved_units: 0,
        resolved_weapons: 0,
        unresolved_weapons: 0,
        warnings: [],
      },
    };

    const json = exportRoster(roster, "roster-json");
    const result = tryImportRoster(json, { dataset: ds });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("roster-json");

    const back = result.roster.units.find((u) => u.ref.id === leader.id);
    // The leader-role attachment survives — inference would have dropped it,
    // since the leader's attachment_role is not "support".
    expect(back?.leader_attachment).not.toBeNull();
    expect(back?.leader_attachment?.bodyguard_ref.id).toBe(bodyguard.id);
    expect(back?.leader_attachment?.role).toBe("leader");
    expect(back?.leader_attachment?.provisional).toBe(false);
  });
});
