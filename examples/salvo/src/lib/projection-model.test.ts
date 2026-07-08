import { describe, expect, it } from "vitest";
import type { AttributedStage, BuffSource, Dataset, Stage, StageLift } from "@alpaca-software/40kdc-data";
import {
  STAGE_COLUMNS,
  aggregateStages,
  fmt,
  fmtSigned,
  labelForSource,
  srcKey,
  stageOf,
} from "./projection-model.js";

const manual = (label: string): BuffSource => ({ kind: "manual", label });

/** A full 7-stage attribution where only after-fnp carries interesting numbers. */
function lineWith(afterFnp: {
  expected: number;
  baseline: number;
  lifts?: StageLift[];
  residual?: number;
}): { attributed: AttributedStage[] } {
  const blank = (name: Stage["name"]): AttributedStage => ({
    name,
    expected: 1,
    detail: "",
    baseline: 1,
    lifts: [],
    residual: 0,
    intrinsics: [],
  });
  return {
    attributed: STAGE_COLUMNS.map((c) =>
      c.name === "after-fnp"
        ? {
            ...blank("after-fnp"),
            expected: afterFnp.expected,
            baseline: afterFnp.baseline,
            lifts: afterFnp.lifts ?? [],
            residual: afterFnp.residual ?? 0,
          }
        : blank(c.name),
    ),
  };
}

describe("STAGE_COLUMNS", () => {
  it("walks the 7 pipeline stages in engine order", () => {
    expect(STAGE_COLUMNS.map((c) => c.name)).toEqual([
      "attacks",
      "hits",
      "wounds",
      "unsaved",
      "damage",
      "after-fnp",
      "models-killed",
    ]);
  });
});

describe("srcKey", () => {
  it("is stable and distinct per source kind", () => {
    expect(srcKey(manual("Cover"))).toBe("m:Cover");
    expect(srcKey({ kind: "weapon-keyword", weaponId: "w1", keywordId: "lethal-hits" })).toBe(
      "w:w1:lethal-hits",
    );
    expect(srcKey({ kind: "ability", abilityId: "ab", sourceUnitId: "u1" } as BuffSource)).toBe(
      "a:ab:u1",
    );
    expect(srcKey({ kind: "ability", abilityId: "ab" } as BuffSource)).toBe("a:ab:");
  });
});

describe("labelForSource", () => {
  const fakeDs = {
    abilities: { getAny: (id: string) => (id === "known" ? { name: "Known Ability" } : undefined) },
    units: { getAny: (id: string) => (id === "u1" ? { name: "Captain" } : undefined) },
  } as unknown as Dataset;

  it("passes manual labels and weapon keywords through", () => {
    expect(labelForSource(fakeDs, manual("Cover"))).toBe("Cover");
    expect(
      labelForSource(fakeDs, { kind: "weapon-keyword", weaponId: "w", keywordId: "sustained-hits" }),
    ).toBe("sustained-hits");
  });

  it("resolves ability and attached-unit names, falling back to ids", () => {
    expect(labelForSource(fakeDs, { kind: "ability", abilityId: "known" } as BuffSource)).toBe(
      "Known Ability",
    );
    expect(labelForSource(fakeDs, { kind: "ability", abilityId: "missing" } as BuffSource)).toBe(
      "missing",
    );
    expect(
      labelForSource(fakeDs, {
        kind: "ability",
        abilityId: "known",
        abilityKind: "attached",
        sourceUnitId: "u1",
      } as BuffSource),
    ).toBe("Known Ability · Captain");
  });
});

describe("fmt / fmtSigned", () => {
  it("renders finite numbers to 2dp and dashes the rest", () => {
    expect(fmt(1.234)).toBe("1.23");
    expect(fmt(NaN)).toBe("—");
    expect(fmtSigned(1.2)).toBe("+1.20");
    expect(fmtSigned(-0.5)).toBe("-0.50");
    expect(fmtSigned(Infinity)).toBe("—");
  });
});

describe("aggregateStages", () => {
  it("sums the additive stages across lines", () => {
    const agg = aggregateStages([lineWith({ expected: 4, baseline: 2 }), lineWith({ expected: 4, baseline: 2 })], 2, 10);
    const hits = stageOf(agg, "hits")!;
    expect(hits.expected).toBe(2); // 1 + 1 from the blank stages
    const afterFnp = stageOf(agg, "after-fnp")!;
    expect(afterFnp.expected).toBe(8);
    expect(afterFnp.baseline).toBe(4);
    expect(stageOf(agg, "attacks")!.detail).toBe("2 weapon line(s)");
  });

  it("merges lifts from the same source across lines", () => {
    const src = manual("Lethal volley");
    const agg = aggregateStages(
      [
        lineWith({ expected: 3, baseline: 2, lifts: [{ source: src, delta: 1 }] }),
        lineWith({ expected: 4, baseline: 2, lifts: [{ source: src, delta: 2 }] }),
      ],
      1,
      100,
    );
    const lifts = stageOf(agg, "after-fnp")!.lifts;
    expect(lifts).toHaveLength(1);
    expect(lifts[0]!.delta).toBe(3);
  });

  it("recomputes models-killed through the wound cap instead of summing per-line kills", () => {
    // W=2, 3 models: the cap is 3 kills. Each line alone kills 2 (4 dmg / W2),
    // so a naive per-line sum would claim 4 kills off 3 models.
    const agg = aggregateStages(
      [
        lineWith({ expected: 4, baseline: 2, lifts: [{ source: manual("A"), delta: 2 }] }),
        lineWith({ expected: 4, baseline: 2, lifts: [{ source: manual("B"), delta: 2 }] }),
      ],
      2,
      3,
    );
    const killed = stageOf(agg, "models-killed")!;
    expect(killed.expected).toBe(3); // min(3, 8/2)
    expect(killed.baseline).toBe(2); // min(3, 4/2)
    // Leave-one-out: dropping either +2 source still saturates the cap, so the
    // lifts vanish and the capped remainder lands in the residual.
    expect(killed.lifts).toHaveLength(0);
    expect(killed.residual).toBeCloseTo(1);
  });

  it("attributes models-killed lifts when the cap is slack", () => {
    const agg = aggregateStages(
      [
        lineWith({ expected: 4, baseline: 2, lifts: [{ source: manual("A"), delta: 2 }] }),
        lineWith({ expected: 4, baseline: 2, lifts: [{ source: manual("B"), delta: 2 }] }),
      ],
      2,
      10,
    );
    const killed = stageOf(agg, "models-killed")!;
    expect(killed.expected).toBe(4);
    expect(killed.baseline).toBe(2);
    expect(killed.lifts).toHaveLength(2);
    for (const l of killed.lifts) expect(l.delta).toBeCloseTo(1);
    expect(killed.residual).toBe(0);
  });

  it("guards the zero-wounds target", () => {
    const agg = aggregateStages([lineWith({ expected: 4, baseline: 2 })], 0, 5);
    expect(stageOf(agg, "models-killed")!.expected).toBe(0);
  });

  it("handles an empty inclusion set", () => {
    const agg = aggregateStages([], 2, 5);
    expect(stageOf(agg, "after-fnp")!.expected).toBe(0);
    expect(stageOf(agg, "models-killed")!.expected).toBe(0);
  });
});
