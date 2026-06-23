import { describe, it, expect } from "vitest";
import type { AbilityView } from "@alpaca-software/40kdc-data";
import {
  parseReport,
  veracityKey,
  lookupScore,
  shapeOf,
  rankByVeracity,
  aggregateByShape,
  type VeracityIndex,
} from "./veracity-store.js";

/** A minimal AbilityView stand-in carrying only what the pure helpers read. */
function fakeAbility(id: string, shape: string, factionId: string | null = null): AbilityView {
  return {
    id,
    name: id,
    raw: { ability_id: id, faction_id: factionId, effect: { type: shape } },
  } as unknown as AbilityView;
}

const sampleReport = {
  scope: "world-eaters",
  model: "all-MiniLM-L6-v2",
  kind: "roundtrip",
  totals: { scored: 3, mean_score: 0.72, min_score: 0.55, max_score: 0.9 },
  abilities: [
    {
      ability_id: "blessings-of-khorne",
      faction: "world-eaters",
      ability_type: "faction",
      name: "Blessings of Khorne",
      score: 0.55,
      gw: "SECRET GW PROSE — must never reach app state",
      english: "describer english snippet",
    },
    {
      ability_id: "legendary-killer",
      faction: "world-eaters",
      ability_type: "unit",
      name: "Legendary Killer",
      score: 0.71,
    },
    {
      ability_id: "fortification",
      faction: "orks",
      ability_type: "unit",
      name: "Fortification",
      score: 0.9,
    },
  ],
};

describe("parseReport", () => {
  it("parses a valid report and keys every ability by faction+id", () => {
    const idx = parseReport(sampleReport);
    expect(idx.scores.size).toBe(sampleReport.abilities.length);
    expect(idx.scope).toBe("world-eaters");
    expect(idx.model).toBe("all-MiniLM-L6-v2");
    expect(idx.totals.min_score).toBe(0.55);
    expect(idx.scores.get(veracityKey("world-eaters", "blessings-of-khorne"))).toBe(0.55);
  });

  it("retains only scores — no GW prose snippets leak into app state (IP boundary)", () => {
    const idx = parseReport(sampleReport);
    const serialized = JSON.stringify([...idx.scores.entries()]);
    expect(serialized).not.toContain("SECRET GW PROSE");
    expect(serialized).not.toContain("describer english snippet");
    // Values are bare numbers, never objects with prose.
    for (const v of idx.scores.values()) expect(typeof v).toBe("number");
  });

  it("falls back to scores.size when totals are absent", () => {
    const { totals, ...noTotals } = sampleReport;
    void totals;
    expect(parseReport(noTotals).totals.scored).toBe(3);
  });

  it("rejects a non-object report", () => {
    expect(() => parseReport([1, 2, 3])).toThrow(/JSON object/);
    expect(() => parseReport(null)).toThrow(/JSON object/);
  });

  it("rejects a report with the wrong kind", () => {
    expect(() => parseReport({ ...sampleReport, kind: "clusters" })).toThrow(/roundtrip/);
  });

  it("rejects a missing abilities array", () => {
    expect(() => parseReport({ kind: "roundtrip" })).toThrow(/abilities/);
  });

  it("rejects a row missing a numeric score", () => {
    const bad = {
      kind: "roundtrip",
      abilities: [{ ability_id: "x", faction: "world-eaters" }],
    };
    expect(() => parseReport(bad)).toThrow(/numeric score/);
  });
});

describe("veracityKey", () => {
  it("is faction-qualified so colliding ability_ids do not clash", () => {
    expect(veracityKey("world-eaters", "fortification")).not.toBe(
      veracityKey("orks", "fortification"),
    );
  });
});

describe("lookupScore", () => {
  const idx: VeracityIndex = parseReport({
    kind: "roundtrip",
    abilities: [
      { ability_id: "fortification", faction: "world-eaters", score: 0.4 },
      { ability_id: "fortification", faction: "orks", score: 0.8 },
      { ability_id: "legendary-killer", faction: "world-eaters", score: 0.71 },
    ],
  });

  it("resolves a faction-typed ability by its own faction_id despite a colliding id", () => {
    expect(lookupScore(idx, "world-eaters", "world-eaters", "fortification")).toBe(0.4);
    expect(lookupScore(idx, "orks", "orks", "fortification")).toBe(0.8);
  });

  it("falls back to the scope faction when the ability carries no faction_id", () => {
    expect(lookupScore(idx, null, "world-eaters", "legendary-killer")).toBe(0.71);
  });

  it("returns undefined on a genuine miss or null index", () => {
    expect(lookupScore(idx, null, "world-eaters", "nope")).toBeUndefined();
    expect(lookupScore(null, "world-eaters", "world-eaters", "fortification")).toBeUndefined();
  });
});

describe("shapeOf", () => {
  it("returns the top-level effect type", () => {
    expect(shapeOf(fakeAbility("a", "conditional"))).toBe("conditional");
    expect(shapeOf(fakeAbility("b", "stat-modifier"))).toBe("stat-modifier");
  });
});

describe("rankByVeracity", () => {
  it("orders weakest first and sinks unscored abilities to the bottom (stable)", () => {
    const abilities = [
      fakeAbility("strong", "stat-modifier"),
      fakeAbility("unscored-a", "aura"),
      fakeAbility("weak", "conditional"),
      fakeAbility("unscored-b", "sequence"),
    ];
    const scores: Record<string, number> = { strong: 0.9, weak: 0.5 };
    const ranked = rankByVeracity(abilities, (a) => scores[a.id]);
    expect(ranked.map((a) => a.id)).toEqual(["weak", "strong", "unscored-a", "unscored-b"]);
  });
});

describe("aggregateByShape", () => {
  it("means per shape, weakest-shape first, zero-scored shapes last", () => {
    const abilities = [
      fakeAbility("c1", "conditional"),
      fakeAbility("c2", "conditional"),
      fakeAbility("s1", "stat-modifier"),
      fakeAbility("a1", "aura"), // no score → unscored shape
    ];
    const scores: Record<string, number> = { c1: 0.6, c2: 0.8, s1: 0.95 };
    const agg = aggregateByShape(abilities, (a) => scores[a.id]);

    expect(agg.map((g) => g.shape)).toEqual(["conditional", "stat-modifier", "aura"]);
    const cond = agg.find((g) => g.shape === "conditional")!;
    expect(cond.mean).toBeCloseTo(0.7);
    expect(cond.count).toBe(2);
    expect(cond.scored).toBe(2);
    const aura = agg.find((g) => g.shape === "aura")!;
    expect(Number.isNaN(aura.mean)).toBe(true);
    expect(aura.scored).toBe(0);
  });
});
