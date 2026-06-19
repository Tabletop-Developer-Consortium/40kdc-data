/**
 * Card-driven scoring engine (10th-edition tactical: score once, then discard),
 * exercised over the real embedded secondary deck (not mocks). Pins approach
 * filtering, OR-tier resolution, cumulative sums, the single-score cap,
 * per-round recording, the WTC result bands, and serialization.
 */
import { describe, it, expect } from "vitest";

import { Dataset } from "../src/data/dataset.js";
import type { SecondaryCard } from "../src/generated.js";
import {
  TACTICAL_CARD_CAP,
  ROUNDS,
  GAME_VP_CAP,
  awardsOf,
  awardsForApproach,
  scoreAward,
  scoreTurn,
  scoreCap,
  scoreSecondaryEvent,
  scorePrimaryEvent,
  emptyPlayerGame,
  recordSecondary,
  scoreSecondary,
  removeScore,
  setPrimary,
  addToHand,
  removeFromHand,
  playerPrimary,
  playerSecondary,
  playerTotal,
  wtcResult,
  type AssertedAward,
} from "../src/scoring/index.js";

const ds = Dataset.embedded();
const card = (id: string): SecondaryCard => {
  const c = ds.missionCards.get(id);
  if (!c) throw new Error(`fixture card missing from dataset: ${id}`);
  return c;
};

const assassination = card("assassination");
const engage = card("engage-on-all-fronts");
const noPrisoners = card("no-prisoners");
const burden = card("burden-of-trust");
const bringItDown = card("bring-it-down");

describe("scoreAward", () => {
  it("returns flat vp regardless of count", () => {
    expect(scoreAward({ vp: 5 }, 3)).toBe(5);
  });
  it("scales vp_per by count and clamps to per_max", () => {
    expect(scoreAward({ vp_per: 3, per: "kill" }, 4)).toBe(12);
    expect(scoreAward({ vp_per: 2, per: "kill", per_max: 3 }, 10)).toBe(6);
  });
  it("never goes negative", () => {
    expect(scoreAward({ vp_per: 3, per: "kill" }, -2)).toBe(0);
  });
});

describe("awardsForApproach", () => {
  it("splits Assassination into its fixed and tactical tracks", () => {
    expect(awardsForApproach(assassination, "fixed").length).toBe(2);
    expect(awardsForApproach(assassination, "tactical").length).toBe(1);
  });
  it("includes mode-less (flat) awards in both approaches", () => {
    const all = awardsOf(noPrisoners);
    expect(all.every((a) => a.mode == null)).toBe(true);
    expect(awardsForApproach(noPrisoners, "tactical")).toEqual(all);
  });
});

describe("scoreTurn", () => {
  it("takes only the highest award within an exclusive_group (OR tiers)", () => {
    // Engage tactical: 3 VP (3 fronts) OR 5 VP (4 fronts) — asserting both scores 5.
    const asserted: AssertedAward[] = awardsForApproach(engage, "tactical").map((award) => ({
      award,
    }));
    expect(scoreTurn(asserted)).toBe(5);
  });
  it("sums cumulative and independent awards", () => {
    // Assassination fixed: 3 VP/char (×2 = 6) + 1 VP/W4+ char (×1) = 7.
    const [perChar, perBig] = awardsForApproach(assassination, "fixed");
    expect(scoreTurn([{ award: perChar, count: 2 }, { award: perBig, count: 1 }])).toBe(7);
  });
});

describe("scoreCap / scoreSecondaryEvent", () => {
  it("caps a single tactical scoring at 5 VP", () => {
    expect(scoreCap(burden, "tactical")).toBe(TACTICAL_CARD_CAP);
    // No Prisoners tactical: 2 VP per kill, but a single scoring clamps to 5.
    const perKill = awardsForApproach(noPrisoners, "tactical")[0];
    expect(scoreSecondaryEvent([{ award: perKill, count: 4 }], noPrisoners, "tactical")).toBe(5);
  });
  it("uses the printed vp_max under the fixed approach", () => {
    // Burden of Trust: 2 VP per guarded objective, capped at the printed 5 VP.
    expect(scoreCap(burden, "fixed")).toBe(5);
    const perObj = awardsForApproach(burden, "fixed")[0];
    expect(scoreSecondaryEvent([{ award: perObj, count: 10 }], burden, "fixed")).toBe(5);
  });
  it("is unbounded under fixed when no vp_max is printed", () => {
    expect(scoreCap(assassination, "fixed")).toBe(Infinity);
  });
  it("scores Bring It Down's tactical track higher per kill than fixed", () => {
    expect(scoreAward(awardsForApproach(bringItDown, "fixed")[0], 1)).toBe(4);
    expect(scoreAward(awardsForApproach(bringItDown, "tactical")[0], 1)).toBe(5);
  });
});

describe("scorePrimaryEvent", () => {
  it("clamps a round's asserted total to the per-round cap (no tactical 5 rule)", () => {
    const perKill = awardsForApproach(noPrisoners, "tactical")[0]; // 2 VP per
    // 2 VP × 8 = 16 raw, clamped to the 15 round cap.
    expect(scorePrimaryEvent([{ award: perKill, count: 8 }], 15)).toBe(15);
    // Under the cap passes through unchanged.
    expect(scorePrimaryEvent([{ award: perKill, count: 3 }], 15)).toBe(6);
  });
});

describe("PlayerGame round recording", () => {
  it("starts empty with one cell per round", () => {
    const pg = emptyPlayerGame();
    expect(pg.rounds.length).toBe(ROUNDS);
    expect(playerTotal(pg)).toBe(0);
  });

  it("records a scored secondary against the named round only", () => {
    let pg = emptyPlayerGame("tactical");
    const perKill = awardsForApproach(noPrisoners, "tactical")[0];
    const vp = scoreSecondaryEvent([{ award: perKill, count: 2 }], noPrisoners, "tactical"); // 4
    pg = recordSecondary(pg, 2, vp);
    expect(pg.rounds[1].secondary).toBe(4);
    expect(pg.rounds[0].secondary).toBe(0);
    expect(playerSecondary(pg)).toBe(4);
  });

  it("sets primary per round and sums into the total", () => {
    let pg = emptyPlayerGame();
    pg = setPrimary(pg, 1, 10);
    pg = setPrimary(pg, 2, 15);
    expect(playerPrimary(pg)).toBe(25);
    pg = recordSecondary(pg, 1, 5);
    expect(playerTotal(pg)).toBe(30);
  });

  it("caps the grand total at 100", () => {
    let pg = emptyPlayerGame();
    for (let r = 1; r <= ROUNDS; r++) pg = setPrimary(pg, r, 30);
    expect(playerPrimary(pg)).toBe(150);
    expect(playerTotal(pg)).toBe(GAME_VP_CAP);
  });

  it("clamps a round's primary to the per-round cap", () => {
    const pg = setPrimary(emptyPlayerGame(), 1, 30, { roundCap: 15 });
    expect(pg.rounds[0].primary).toBe(15);
  });

  it("clamps primary so the per-game cap is never exceeded across rounds", () => {
    let pg = emptyPlayerGame();
    // Three rounds at the round cap reach the 45 game cap exactly...
    for (const r of [1, 2, 3]) pg = setPrimary(pg, r, 15, { roundCap: 15, gameCap: 45 });
    expect(playerPrimary(pg)).toBe(45);
    // ...so a fourth round has no room left and clamps to 0.
    pg = setPrimary(pg, 4, 15, { roundCap: 15, gameCap: 45 });
    expect(pg.rounds[3].primary).toBe(0);
    expect(playerPrimary(pg)).toBe(45);
  });

  it("game-cap room is computed against the other rounds, so re-scoring a round is stable", () => {
    let pg = emptyPlayerGame();
    pg = setPrimary(pg, 1, 15, { roundCap: 15, gameCap: 45 });
    pg = setPrimary(pg, 2, 15, { roundCap: 15, gameCap: 45 });
    // Round 3 has 45 - 30 = 15 room; full 15 fits.
    pg = setPrimary(pg, 3, 20, { roundCap: 15, gameCap: 45 });
    expect(pg.rounds[2].primary).toBe(15);
    // Re-scoring round 1 lower frees room without compounding.
    pg = setPrimary(pg, 1, 5, { roundCap: 15, gameCap: 45 });
    expect(pg.rounds[0].primary).toBe(5);
    expect(playerPrimary(pg)).toBe(35);
  });

  it("hand add/remove is the score-then-discard path", () => {
    let pg = emptyPlayerGame();
    pg = addToHand(pg, "no-prisoners");
    pg = addToHand(pg, "no-prisoners"); // no duplicates
    expect(pg.handIds).toEqual(["no-prisoners"]);
    pg = removeFromHand(pg, "no-prisoners");
    expect(pg.handIds).toEqual([]);
  });

  it("does not mutate the input state", () => {
    const before = emptyPlayerGame();
    const after = recordSecondary(before, 1, 5);
    expect(before.rounds[0].secondary).toBe(0);
    expect(after.rounds[0].secondary).toBe(5);
  });

  it("scoreSecondary logs the card, banks VP to the round, and discards it", () => {
    let pg = addToHand(emptyPlayerGame(), "no-prisoners");
    pg = scoreSecondary(pg, 2, "no-prisoners", 4);
    expect(pg.rounds[1].secondary).toBe(4);
    expect(pg.handIds).toEqual([]);
    expect(pg.log).toEqual([{ cardId: "no-prisoners", round: 2, vp: 4 }]);
  });

  it("removeScore undoes the VP and returns the card to hand", () => {
    let pg = scoreSecondary(addToHand(emptyPlayerGame(), "centre-ground"), 1, "centre-ground", 5);
    pg = removeScore(pg, 0);
    expect(pg.rounds[0].secondary).toBe(0);
    expect(pg.log).toEqual([]);
    expect(pg.handIds).toEqual(["centre-ground"]);
  });

  it("removeScore is a no-op for an out-of-range index", () => {
    const pg = scoreSecondary(addToHand(emptyPlayerGame(), "centre-ground"), 1, "centre-ground", 5);
    expect(removeScore(pg, 9)).toEqual(pg);
  });

  it("round-trips through JSON unchanged", () => {
    let pg = emptyPlayerGame("tactical");
    pg = setPrimary(pg, 1, 8);
    pg = addToHand(pg, "centre-ground");
    pg = recordSecondary(pg, 1, 5);
    expect(JSON.parse(JSON.stringify(pg))).toEqual(pg);
  });
});

describe("wtcResult", () => {
  it("is a 10-10 draw at equal totals and within the 0-5 band", () => {
    expect(wtcResult(50, 50)).toEqual({ a: 10, b: 10 });
    expect(wtcResult(48, 45)).toEqual({ a: 10, b: 10 }); // diff 3
    expect(wtcResult(45, 50)).toEqual({ a: 10, b: 10 }); // diff 5
  });
  it("steps a band every 5 VP from 6 upward", () => {
    expect(wtcResult(56, 50)).toEqual({ a: 11, b: 9 }); // diff 6
    expect(wtcResult(50, 61)).toEqual({ a: 8, b: 12 }); // diff 11
    expect(wtcResult(100, 50)).toEqual({ a: 19, b: 1 }); // diff 50
  });
  it("maxes at 20-0 for a 51+ differential", () => {
    expect(wtcResult(100, 49)).toEqual({ a: 20, b: 0 }); // diff 51
    expect(wtcResult(0, 100)).toEqual({ a: 0, b: 20 }); // diff 100
  });
});
