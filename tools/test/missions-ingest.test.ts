import { describe, it, expect } from "vitest";
import { MfmDump } from "../src/mfm/loader.js";
import {
  buildMissionScoringCanon,
  reconcileCard,
  type DumpScoring,
} from "../src/mfm/missions.js";

/**
 * The missions ingest pulls dump-authoritative scoring numbers into the repo's
 * award blocks. Two seams are tested:
 *   - buildMissionScoringCanon: the relational join (mission → objective →
 *     scoring), the scoringType→mode mapping, displayOrder ordering, and the
 *     exclusion of detachment-scoped (crusade/narrative) primary reskins.
 *   - reconcileCard: the pure award↔row matcher — form-preserving vp updates, the
 *     vp_max set/remove, cumulative add/remove, the additive exclusive_group
 *     guard, and the shape-mismatch skip.
 * A synthetic dump keeps both runnable without _private/dump.json.
 */
function dump(): MfmDump {
  return new MfmDump({
    data: {
      // one secondary (two OR-tiers under one objective; higher tier flagged mutex)
      secondary_mission: [{ id: "sm1", localisations: { en: { name: "Beacon" } } }],
      secondary_mission_objective: [
        { id: "smo1", displayOrder: 1, secondaryMissionId: "sm1", localisations: { en: { name: "ANY" } } },
      ],
      secondary_mission_objective_scoring: [
        { id: "s2", displayOrder: 20, secondaryMissionObjectiveId: "smo1", scoringType: "standard", victoryPoints: 5, victoryPointsCap: null, isCumulative: false, isMutuallyExclusive: true },
        { id: "s1", displayOrder: 10, secondaryMissionObjectiveId: "smo1", scoringType: "standard", victoryPoints: 3, victoryPointsCap: null, isCumulative: false, isMutuallyExclusive: false },
      ],
      // two primaries: one generic (kept), one detachment-scoped reskin (excluded)
      primary_mission: [
        { id: "pm1", detachmentId: null, localisations: { en: { name: "Take And Hold" } } },
        { id: "pm2", detachmentId: "det-x", localisations: { en: { name: "For Cadia" } } },
      ],
      primary_mission_objective: [
        { id: "pmo1", displayOrder: 1, primaryMissionId: "pm1", localisations: { en: { name: "ANY" } } },
        { id: "pmo2", displayOrder: 1, primaryMissionId: "pm2", localisations: { en: { name: "ANY" } } },
      ],
      primary_mission_objective_scoring: [
        { id: "p1", displayOrder: 10, primaryMissionObjectiveId: "pmo1", victoryPoints: 5, isCumulative: false, isMutuallyExclusive: false },
        { id: "p2", displayOrder: 10, primaryMissionObjectiveId: "pmo2", victoryPoints: 99, isCumulative: false, isMutuallyExclusive: false },
      ],
    },
  });
}

describe("buildMissionScoringCanon", () => {
  it("joins secondary scoring, ordered by (objective, scoring) displayOrder", () => {
    const canon = buildMissionScoringCanon(dump());
    expect(canon.get("beacon")).toEqual([
      { mode: undefined, vp: 3, cap: null, cumulative: false, mutex: false, objKey: "1" },
      { mode: undefined, vp: 5, cap: null, cumulative: false, mutex: true, objKey: "1" },
    ]);
  });

  it("keeps generic primaries and excludes detachment-scoped reskins", () => {
    const canon = buildMissionScoringCanon(dump());
    expect(canon.has("take-and-hold")).toBe(true);
    expect(canon.has("for-cadia")).toBe(false);
  });
});

const rows = (...r: Partial<DumpScoring>[]): DumpScoring[] =>
  r.map((x) => ({ mode: undefined, vp: 0, cap: null, cumulative: false, mutex: false, objKey: "1", ...x }));

describe("reconcileCard", () => {
  it("lowers vp_max and preserves the vp_per form (Burden of Trust 9→5)", () => {
    const card = { id: "burden-of-trust", awards: [{ vp_per: 2, per: "x", vp_max: 9 }] };
    const res = reconcileCard(card, rows({ vp: 2, cap: 5 }));
    expect(res.shapeMismatch).toBeUndefined();
    expect(card.awards[0]).toEqual({ vp_per: 2, per: "x", vp_max: 5 });
    expect(res.changes).toEqual([{ cardId: "burden-of-trust", index: 0, field: "vp_max", from: 9, to: 5 }]);
  });

  it("removes a stale vp_max when the dump has no cap", () => {
    const card = { id: "c", awards: [{ vp_per: 2, per: "x", vp_max: 9 }] };
    reconcileCard(card, rows({ vp: 2, cap: null }));
    expect(card.awards[0]).toEqual({ vp_per: 2, per: "x" });
  });

  it("updates a flat vp value without converting it to vp_per", () => {
    const card = { id: "c", awards: [{ vp: 3 }] };
    reconcileCard(card, rows({ vp: 4 }));
    expect(card.awards[0]).toEqual({ vp: 4 });
  });

  it("adds and drops cumulative to match the dump", () => {
    const add = { id: "c", awards: [{ vp: 1 }] as any[] };
    reconcileCard(add, rows({ vp: 1, cumulative: true }));
    expect(add.awards[0]).toEqual({ vp: 1, cumulative: true });

    const drop = { id: "c", awards: [{ vp: 1, cumulative: true }] };
    reconcileCard(drop, rows({ vp: 1, cumulative: false }));
    expect(drop.awards[0]).toEqual({ vp: 1 });
  });

  it("fills a missing exclusive_group for a mutex objective but never overwrites one", () => {
    const missing = { id: "beacon", awards: [{ vp: 3 } as any, { vp: 5 } as any] };
    reconcileCard(missing, rows({ vp: 3, mutex: false, objKey: "1" }, { vp: 5, mutex: true, objKey: "1" }));
    // both awards map from the same mutex objective → both get the same derived key
    expect(missing.awards[0].exclusive_group).toBe("beacon-grp1");
    expect(missing.awards[1].exclusive_group).toBe("beacon-grp1");

    const authored = { id: "beacon", awards: [{ vp: 3, exclusive_group: "hand-key" }, { vp: 5, exclusive_group: "hand-key" }] };
    reconcileCard(authored, rows({ vp: 3, mutex: false, objKey: "1" }, { vp: 5, mutex: true, objKey: "1" }));
    expect(authored.awards[0].exclusive_group).toBe("hand-key");
  });

  it("flags an exclusive_group the dump does not corroborate without removing it", () => {
    const card = { id: "c", awards: [{ vp: 3, exclusive_group: "k" }] };
    const res = reconcileCard(card, rows({ vp: 3, mutex: false }));
    expect(card.awards[0].exclusive_group).toBe("k");
    expect(res.exclusiveReview).toEqual([{ index: 0, key: "k" }]);
  });

  it("aligns awards to rows per track regardless of interleaving", () => {
    // repo order: fixed, fixed, tactical, tactical ; dump order: fixed, tactical, fixed, tactical
    const card = {
      id: "engage",
      awards: [
        { vp: 2, mode: "fixed" },
        { vp: 9, mode: "fixed" },
        { vp: 3, mode: "tactical" },
        { vp: 9, mode: "tactical" },
      ],
    };
    reconcileCard(card, rows(
      { vp: 2, mode: "fixed" },
      { vp: 3, mode: "tactical" },
      { vp: 4, mode: "fixed" },
      { vp: 5, mode: "tactical" },
    ));
    expect(card.awards.map((a) => a.vp)).toEqual([2, 4, 3, 5]);
  });

  it("skips a card whole when award/row counts differ within a track", () => {
    const card = { id: "immovable-object", awards: [{ vp: 3 }, { vp: 5 }, { vp: 5 }] };
    const before = JSON.stringify(card);
    const res = reconcileCard(card, rows({ vp: 3 }, { vp: 5 }, { vp: 5 }, { vp: 4 }, { vp: 4 }));
    expect(res.shapeMismatch).toEqual([{ mode: "none", repo: 3, dump: 5 }]);
    expect(res.changes).toEqual([]);
    expect(JSON.stringify(card)).toBe(before); // untouched
  });
});
