import { describe, expect, it } from "vitest";
import { Dataset } from "../src/data/dataset.js";
import { crunch, type EngineInput } from "../src/cruncher/index.js";

const ds = Dataset.embedded();

const APPROX = 5e-4;
function near(actual: number, expected: number, msg = ""): void {
  if (Math.abs(actual - expected) > APPROX) {
    throw new Error(`${msg}: expected ${expected.toFixed(6)}, got ${actual.toFixed(6)}`);
  }
}

function stage(out: ReturnType<typeof crunch>, name: string): number {
  const s = out.stages.find((x) => x.name === name);
  if (!s) throw new Error(`no stage ${name}`);
  return s.expected;
}

function inputFor(
  weaponId: string,
  profileIndex: number,
  modelsFiring: number,
  unitId: string,
  context: EngineInput["context"],
  buffs: EngineInput["buffs"] = [],
  targetModelCount?: number,
): EngineInput {
  const weapon = ds.weapons.getAny(weaponId);
  const unit = ds.units.getAny(unitId);
  if (!weapon || !unit) throw new Error(`missing weapon=${weaponId} or unit=${unitId}`);
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

describe("crunch: bolt-rifle vs intercessor", () => {
  // bolt-rifle profile 0: A=2, S=4, AP=-1, D=1, BS=3; keywords [assault, heavy].
  // intercessor-squad profile 0: T=4, W=2, Sv=3, OC=2, Ld=6.
  // 5 firing models, not stationary (so Heavy is gated off).
  it("matches hand-derived numbers without rerolls or modifiers", () => {
    const out = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", {
        phase: "shooting",
        attackerStationary: false,
        withinHalfRange: false,
      }),
    );
    // attacks: 5 × 2 = 10
    near(stage(out, "attacks"), 10, "attacks");
    // hits: 10 × 4/6 = 6.6667
    near(stage(out, "hits"), 10 * 4 / 6, "hits");
    // wound: S4 vs T4 → 4+, P(wound)=3/6=0.5
    near(stage(out, "wounds"), (10 * 4 / 6) * 0.5, "wounds");
    // save: Sv3 - AP(-1) = 4+, P(save)=3/6=0.5; unsaved = wounds × 0.5
    const wounds = (10 * 4) / 6 * 0.5;
    const unsaved = wounds * 0.5;
    near(stage(out, "unsaved"), unsaved, "unsaved");
    // damage: 1 per hit
    near(stage(out, "damage"), unsaved, "damage");
    // no FNP
    near(stage(out, "after-fnp"), unsaved, "after-fnp");
    // models killed: damage / W; cap at model count (10 by default for intercessors min=10? unknown).
    const W = 2;
    const targetModels = ds.units.getAny("intercessor-squad")!.raw.model_count?.min ?? 1;
    near(stage(out, "models-killed"), Math.min(targetModels, unsaved / W), "models-killed");
  });

  it("Heavy fires +1 to hit when stationary", () => {
    const out = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", {
        phase: "shooting",
        attackerStationary: true,
        withinHalfRange: false,
      }),
    );
    // With +1 to hit, BS3 effectively → 2+, P(hit) = 5/6.
    near(stage(out, "hits"), 10 * 5 / 6, "hits");
  });
});

describe("crunch: torrent + ignores-cover via manual buffs", () => {
  // Use a real torrent weapon if available; otherwise emulate via manual extra-keyword buffs.
  it("torrent auto-hits", () => {
    // Hand-build a synthetic context: take any ranged weapon, then add a
    // manual torrent extra-keyword.
    const inp = inputFor(
      "bolt-rifle",
      0,
      1,
      "intercessor-squad",
      { phase: "shooting", attackerStationary: false, withinHalfRange: false },
      [
        {
          source: { kind: "manual", label: "test torrent" },
          contribution: { type: "extra-keyword", keywordRef: { keyword_id: "torrent" } },
        },
      ],
    );
    const out = crunch(inp);
    near(stage(out, "attacks"), 2, "attacks");
    near(stage(out, "hits"), 2, "hits"); // torrent: auto-hit
  });
});

describe("crunch: rerolls", () => {
  it("reroll-failed-hits boosts the hit rate", () => {
    const baseline = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }),
    );
    const buffed = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        {
          source: { kind: "ability", abilityId: "guide", abilityKind: "support" },
          contribution: { type: "reroll", roll: "hit", subset: "all-failures" },
        },
      ]),
    );
    expect(stage(buffed, "hits")).toBeGreaterThan(stage(baseline, "hits"));
    // BS3+, P(hit_initial) = 4/6. With reroll all-failures: 4/6 + 2/6 × 4/6 = 4/6 + 8/36 = 32/36 = 0.8889
    near(stage(buffed, "hits"), 10 * (4 / 6 + (2 / 6) * (4 / 6)), "hits with rerolls");
  });

  it("Kharn's Legendary Killer rerolls flow through the attachment API to a crunch", () => {
    // End-to-end: sourcing buffs via the public stackableBuffsFor API, attaching
    // Kharn to Berzerkers surfaces his melee hit/wound rerolls (model-is-leader),
    // which must lift both hits and wounds for the combined unit.
    const enabled = (input: Parameters<typeof ds.stackableBuffsFor>[0]) =>
      ds
        .stackableBuffsFor(input, { phase: "fight" })
        .buffs.filter((b) => b.enabled)
        .flatMap((b) => b.buffs);

    const ledByKharn = {
      unitId: "khorne-berzerkers",
      factionId: "world-eaters",
      attachedUnitIds: ["kharn-the-betrayer"],
    };
    const alone = { unitId: "khorne-berzerkers", factionId: "world-eaters" };

    const baseline = crunch(
      inputFor("chainblade", 0, 5, "khorne-berzerkers", { phase: "fight" }, enabled(alone)),
    );
    const attached = crunch(
      inputFor("chainblade", 0, 5, "khorne-berzerkers", { phase: "fight" }, enabled(ledByKharn)),
    );
    expect(stage(attached, "hits")).toBeGreaterThan(stage(baseline, "hits"));
    expect(stage(attached, "wounds")).toBeGreaterThan(stage(baseline, "wounds"));
  });
});

describe("crunch: cover (11e — -1 to hit)", () => {
  it("cover applies -1 to the hit roll, not a save bonus", () => {
    const baseline = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }),
    );
    const covered = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        { source: { kind: "manual", label: "in cover" }, contribution: { type: "cover" } },
      ]),
    );
    // BS3+ → with cover -1 the hit needs 4+: P(hit) drops 4/6 → 3/6. Attacks
    // are unchanged, so covered hits = attacks × 3/6.
    near(stage(covered, "hits"), stage(covered, "attacks") * (3 / 6), "covered hits");
    expect(stage(covered, "hits")).toBeLessThan(stage(baseline, "hits"));
    // The save is untouched: the unsaved-per-wound fraction is identical.
    near(
      stage(covered, "unsaved") / stage(covered, "wounds"),
      stage(baseline, "unsaved") / stage(baseline, "wounds"),
      "save fraction unchanged by cover",
    );
  });
});

describe("crunch: ap-mod buff", () => {
  it("ap-mod -1 worsens the defender's effective save by 1", () => {
    // Baseline: bolt-rifle AP-1 vs Sv3+ → effective 4+, P(save)=3/6=0.5.
    // With ap-mod -1: AP-2 → effective 5+, P(save)=2/6.
    const baseline = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }),
    );
    const piercing = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        {
          source: { kind: "ability", abilityId: "test-ap", abilityKind: "unit" },
          contribution: { type: "ap-mod", value: -1 },
        },
      ]),
    );
    const wounds = stage(baseline, "wounds");
    const expectedPiercing = wounds * (1 - 2 / 6);
    near(stage(piercing, "unsaved"), expectedPiercing, "ap-mod unsaved");
  });
});

describe("crunch: FNP", () => {
  it("FNP 5+ reduces damage by P(success)", () => {
    const baseline = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }),
    );
    const withFnp = crunch(
      inputFor("bolt-rifle", 0, 5, "intercessor-squad", { phase: "shooting" }, [
        {
          source: { kind: "ability", abilityId: "test-fnp", abilityKind: "unit" },
          contribution: { type: "feel-no-pain", threshold: 5 },
        },
      ]),
    );
    // FNP 5+: P(succ) = 2/6, so damage × 4/6.
    near(stage(withFnp, "after-fnp"), stage(baseline, "damage") * (4 / 6), "FNP applies");
  });
});

describe("crunch: attack-scoped invulnerable save (issue #87)", () => {
  // judiciar is a scoped-only defender: invuln_sv null, invuln_sv_melee 4, no
  // ranged invuln. Sv3 vs an AP-3 weapon → armour 6+, so the 4++ (melee-only)
  // must bind for a melee attack and must NOT bind for a ranged one. The
  // unsaved-per-wound fraction isolates the effective save (no devastating/mortal
  // streams on these plain profiles, so unsaved/wounds == 1 − P(save)).
  it("a melee attack applies the melee-scoped invuln (4++ over armour 6+)", () => {
    const out = crunch(
      inputFor("sword-of-the-high-marshals", 0, 1, "judiciar", { phase: "fight" }),
    );
    // effective save min(6+, 4++) = 4+ → P(save)=3/6 → unsaved fraction 0.5.
    near(stage(out, "unsaved") / stage(out, "wounds"), 0.5, "melee-scoped invuln applied");
  });

  it("a ranged attack does NOT apply the melee-scoped invuln (armour 6+ only)", () => {
    const out = crunch(
      inputFor("las-talon", 0, 1, "judiciar", { phase: "shooting" }),
    );
    // no ranged/unconditional invuln → effective save armour 6+ → unsaved 5/6.
    near(stage(out, "unsaved") / stage(out, "wounds"), 5 / 6, "melee invuln not leaked to ranged");
  });
});
