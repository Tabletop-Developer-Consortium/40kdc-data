import { describe, expect, it } from "vitest";
import { Dataset } from "../src/data/dataset.js";
import {
  attributeStages,
  crunch,
  type AttributedStage,
  type Buff,
  type EngineInput,
  type Stage,
} from "../src/cruncher/index.js";

const ds = Dataset.embedded();

const APPROX = 5e-4;
function near(actual: number, expected: number, msg = ""): void {
  if (Math.abs(actual - expected) > APPROX) {
    throw new Error(`${msg}: expected ${expected.toFixed(6)}, got ${actual.toFixed(6)}`);
  }
}

function inputFor(
  weaponId: string,
  profileIndex: number,
  modelsFiring: number,
  targetUnitId: string,
  context: EngineInput["context"],
  buffs: Buff[] = [],
  targetModelCount?: number,
): EngineInput {
  const weapon = ds.weapons.getAny(weaponId);
  const unit = ds.units.getAny(targetUnitId);
  if (!weapon || !unit) throw new Error(`missing weapon=${weaponId} or unit=${targetUnitId}`);
  return {
    attacker: { weapon: weapon.raw, profileIndex },
    target: {
      unit: unit.raw,
      profileIndex: 0,
      ...(targetModelCount !== undefined ? { modelCount: targetModelCount } : {}),
    },
    modelsFiring,
    buffs,
    context,
  };
}

function att(stages: AttributedStage[], name: Stage["name"]): AttributedStage {
  const s = stages.find((x) => x.name === name);
  if (!s) throw new Error(`no attributed stage ${name}`);
  return s;
}

function crunchStage(out: ReturnType<typeof crunch>, name: Stage["name"]): number {
  const s = out.stages.find((x) => x.name === name);
  if (!s) throw new Error(`no stage ${name}`);
  return s.expected;
}

const hitMod = (abilityId: string, value: number): Buff => ({
  source: { kind: "ability", abilityId, abilityKind: "unit" },
  contribution: { type: "hit-mod", value },
});

describe("attributeStages: single buff", () => {
  it("one ability hit-mod's lift equals expected − baseline, residual ≈ 0", () => {
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        hitMod("plus-one-hit", 1),
      ]),
      ds,
    );
    const hits = att(stages, "hits");
    expect(hits.lifts).toHaveLength(1);
    near(hits.lifts[0].delta, hits.expected - hits.baseline, "single lift = expected−baseline");
    near(hits.residual, 0, "single-group residual");
    // The lift is positive (a +1 to hit raises hits).
    expect(hits.lifts[0].delta).toBeGreaterThan(0);
  });
});

describe("attributeStages: cap collision", () => {
  it("two +1 hit-mods each show ≈0 lift; the capped +1 lands in residual", () => {
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        hitMod("buff-a", 1),
        hitMod("buff-b", 1),
      ]),
      ds,
    );
    const hits = att(stages, "hits");
    // Removing either +1 leaves the sum still capped at +1 → each marginal ≈ 0,
    // so both are filtered out by epsilon.
    expect(hits.lifts).toHaveLength(0);
    // The real elevation over the all-off baseline is the +1 cap effect.
    expect(hits.expected - hits.baseline).toBeGreaterThan(0.1);
    near(hits.residual, hits.expected - hits.baseline, "overlap residual carries the cap");
  });
});

describe("attributeStages: downstream propagation", () => {
  it("a hit-mod lifts damage and models-killed, not only hits", () => {
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        hitMod("plus-one-hit", 1),
      ]),
      ds,
    );
    expect(att(stages, "damage").lifts[0]?.delta ?? 0).toBeGreaterThan(0);
    expect(att(stages, "models-killed").lifts[0]?.delta ?? 0).toBeGreaterThan(0);
  });
});

describe("attributeStages: grouping", () => {
  it("a buff that flatMaps to several Buffs is removed as one unit", () => {
    // One ability ("frenzy") contributing TWO hit-affecting buffs that share an
    // abilityId: a +1 to hit and a reroll of failed hits. They must collapse to
    // a single lift entry, and (being the only group) its lift must equal the
    // full expected − baseline gap.
    const frenzy: Buff[] = [
      { source: { kind: "ability", abilityId: "frenzy", abilityKind: "unit" }, contribution: { type: "hit-mod", value: 1 } },
      {
        source: { kind: "ability", abilityId: "frenzy", abilityKind: "unit" },
        contribution: { type: "reroll", roll: "hit", subset: "all-failures" },
      },
    ];
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, frenzy),
      ds,
    );
    const hits = att(stages, "hits");
    expect(hits.lifts).toHaveLength(1);
    near(hits.lifts[0].delta, hits.expected - hits.baseline, "whole group's lift");
    near(hits.residual, 0, "single-group residual");
  });
});

describe("attributeStages: intrinsics", () => {
  it("weapon keywords are reported, never split out as lifts", () => {
    // twin-heavy-bolter: sustained-hits 1, twin-linked, rapid-fire 2 — all
    // intrinsic. No toggleable buffs in play.
    const stages = attributeStages(
      inputFor("twin-heavy-bolter", 0, 3, "intercessor-squad", { phase: "shooting" }),
      ds,
    );
    const hits = att(stages, "hits");
    // `intrinsics` lists keyword passthroughs the engine reads via findKeyword
    // (sustained-hits is always present). twin-linked translates to a
    // reroll-wound contribution and rapid-fire's passthrough is gated on half
    // range, so neither shows here — that's correct, not a gap.
    expect(hits.intrinsics).toContain("sustained-hits");
    expect(hits.lifts).toHaveLength(0);
    // No groupable buffs → baseline equals expected everywhere.
    for (const s of stages) near(s.baseline, s.expected, `${s.name} baseline == expected`);
  });
});

describe("attributeStages: non-additive keyword grant", () => {
  it("granting a keyword the weapon already has yields ≈0 lift (no double-count)", () => {
    // twin-heavy-bolter already has Sustained Hits 1. An ability that grants
    // another Sustained Hits 1 is deduped by resolveBuffs → no extra crits, so
    // its marginal effect on hits is zero. (Sustained 1 ×2 ≠ Sustained 2.)
    const ctx: EngineInput["context"] = { phase: "shooting", withinHalfRange: false };
    const noBuff = crunch(inputFor("twin-heavy-bolter", 0, 3, "intercessor-squad", ctx), ds);
    const grant: Buff = {
      source: { kind: "ability", abilityId: "redundant-sustained", abilityKind: "unit" },
      contribution: { type: "extra-keyword", keywordRef: { keyword_id: "sustained-hits", parameters: { value: 1 } } },
    };
    const withGrant = crunch(inputFor("twin-heavy-bolter", 0, 3, "intercessor-squad", ctx, [grant]), ds);
    near(crunchStage(withGrant, "hits"), crunchStage(noBuff, "hits"), "grant changes nothing");

    const stages = attributeStages(
      inputFor("twin-heavy-bolter", 0, 3, "intercessor-squad", ctx, [grant]),
      ds,
    );
    // The redundant grant produces no lift on any stage.
    for (const s of stages) {
      expect(s.lifts.find((l) => l.source.kind === "ability" && l.source.abilityId === "redundant-sustained")).toBeUndefined();
    }
  });
});

describe("attributeStages: FNP best-threshold", () => {
  it("removing the dominant FNP lifts after-fnp; removing the dominated one does not", () => {
    const fnp = (abilityId: string, threshold: number): Buff => ({
      source: { kind: "ability", abilityId, abilityKind: "unit" },
      contribution: { type: "feel-no-pain", threshold },
    });
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        fnp("fnp5", 5), // dominant (resolver keeps the lowest threshold)
        fnp("fnp6", 6), // dominated
      ]),
      ds,
    );
    const afterFnp = att(stages, "after-fnp");
    expect(afterFnp.lifts).toHaveLength(1);
    const lift = afterFnp.lifts[0];
    expect(lift.source.kind === "ability" && lift.source.abilityId).toBe("fnp5");
    // FNP lowers after-fnp; removing the active FNP raises it, so the marginal
    // (expected − without) is negative.
    expect(lift.delta).toBeLessThan(0);
  });
});

describe("attributeStages: models-killed cap compresses lift", () => {
  it("a damage buff against an already-wiped target shows after-fnp lift but ~no models-killed lift", () => {
    // 1-model, W=1 target overkilled many times over → models-killed pinned at
    // the cap with or without the buff, so its marginal lift is ≈0 even though
    // after-fnp clearly rises. Demonstrates the cap's non-linearity (and why
    // per-line models-killed lifts can't be summed across lines).
    const damageBuff: Buff = {
      source: { kind: "ability", abilityId: "big-damage", abilityKind: "unit" },
      contribution: { type: "damage-mod", value: 3 },
    };
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 10, "intercessor-squad", { phase: "shooting" }, [damageBuff], 1),
      ds,
    );
    expect((att(stages, "after-fnp").lifts[0]?.delta ?? 0)).toBeGreaterThan(0);
    const killed = att(stages, "models-killed");
    near(killed.expected, 1, "target pinned at the 1-model cap");
    expect(killed.lifts).toHaveLength(0); // cap binds both ways → no marginal lift
  });
});

describe("attributeStages: epsilon / gating", () => {
  it("a buff gated off by phase produces no lift", () => {
    const gated: Buff = {
      source: { kind: "ability", abilityId: "fight-only", abilityKind: "unit" },
      applicableWhen: { phases: ["fight"] },
      contribution: { type: "hit-mod", value: 1 },
    };
    const stages = attributeStages(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [gated]),
      ds,
    );
    for (const s of stages) expect(s.lifts).toHaveLength(0);
  });
});
