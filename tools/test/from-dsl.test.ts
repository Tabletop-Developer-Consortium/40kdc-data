import { describe, expect, it } from "vitest";
import { effectToBuffs, parseKeywordGrant } from "../src/cruncher/from-dsl.js";
import type { BuffSource, EngineContext } from "../src/cruncher/buffs.js";

const armyRule: BuffSource = {
  kind: "ability",
  abilityId: "oath-of-moment",
  abilityKind: "army",
};
const unitRule: BuffSource = {
  kind: "ability",
  abilityId: "fury",
  abilityKind: "unit",
};
const ctx: EngineContext = { phase: "shooting", attackerStationary: false };

describe("effectToBuffs: leaves", () => {
  it("re-roll → reroll buff", () => {
    const result = effectToBuffs(
      {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "hit", subset: "all-failures" },
      },
      armyRule,
      ctx,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({
      type: "reroll",
      roll: "hit",
      subset: "all-failures",
    });
    expect(result.unsupported).toEqual([]);
  });

  it("re-roll with value:1 means 'ones' even if subset says all-failures", () => {
    // Guard against the 2026-weapon-keywords migration mis-default: a `value: 1`
    // re-roll node is "re-roll rolls of 1", regardless of a stray subset.
    const result = effectToBuffs(
      {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "hit", value: 1, subset: "all-failures" },
      },
      armyRule,
      ctx,
    );
    expect(result.applied[0].contribution).toEqual({
      type: "reroll",
      roll: "hit",
      subset: "ones",
    });
  });

  it("roll-modifier add → matching mod buff", () => {
    const result = effectToBuffs(
      {
        type: "roll-modifier",
        target: "unit",
        modifier: { roll: "wound", operation: "add", value: 1 },
      },
      unitRule,
      ctx,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({ type: "wound-mod", value: 1 });
  });

  it("roll-modifier subtract → negative buff", () => {
    const result = effectToBuffs(
      {
        type: "roll-modifier",
        target: "unit",
        modifier: { roll: "hit", operation: "subtract", value: 1 },
      },
      unitRule,
      ctx,
    );
    expect(result.applied[0].contribution).toEqual({ type: "hit-mod", value: -1 });
  });

  it("stat-modifier S → strength-mod", () => {
    const result = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "S", operation: "add", value: 1 },
      },
      unitRule,
      ctx,
    );
    expect(result.applied[0].contribution).toEqual({ type: "strength-mod", value: 1 });
  });

  it("stat-modifier A → attacks-mod", () => {
    const result = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "A", operation: "add", value: 1 },
      },
      unitRule,
      ctx,
    );
    expect(result.applied[0].contribution).toEqual({ type: "attacks-mod", value: 1 });
  });

  it("feel-no-pain → FNP buff under target perspective", () => {
    const result = effectToBuffs(
      { type: "feel-no-pain", target: "unit", modifier: { threshold: 5 } },
      unitRule,
      ctx,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "feel-no-pain", threshold: 5 });
  });

  it("feel-no-pain drops silently under attacker perspective", () => {
    const result = effectToBuffs(
      { type: "feel-no-pain", target: "unit", modifier: { threshold: 5 } },
      unitRule,
      ctx,
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("keyword-grant 'Sustained Hits 1' → extra-keyword buff", () => {
    const result = effectToBuffs(
      {
        type: "keyword-grant",
        target: "unit",
        modifier: { keywords: ["Sustained Hits 1"] },
      },
      unitRule,
      ctx,
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({
      type: "extra-keyword",
      keywordRef: { keyword_id: "sustained-hits", parameters: { value: 1 } },
    });
  });
});

describe("effectToBuffs: named-region-state", () => {
  const namedRegion = (keywords: string[], operator: "and" | "or" = "or", defaultEffect: Record<string, unknown> = {
    type: "re-roll",
    target: "attacker",
    modifier: { roll: "hit", subset: "ones" },
  }) => ({
    type: "named-region-state",
    target: "all-friendly",
    modifier: {
      consumer: {
        beneficiary_gate: { operator, keywords },
        default_branch: { effect: defaultEffect },
        qualified_branch: {
          effect: {
            type: "re-roll",
            target: "attacker",
            modifier: { roll: "hit", result_scope: "any-result" },
          },
        },
      },
    },
  });

  it("applies the default branch for a matching case-insensitive OR gate", () => {
    const result = effectToBuffs(
      namedRegion(["CRYPTEK", "CANOPTEK"]),
      unitRule,
      { phase: "shooting", attackerKeywords: ["canoptek"] },
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({
      type: "reroll",
      roll: "hit",
      subset: "ones",
    });
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].reason).toContain("qualified replacement");
  });

  it("applies neither branch when the beneficiary gate does not match", () => {
    const result = effectToBuffs(
      namedRegion(["CRYPTEK", "CANOPTEK"]),
      unitRule,
      { phase: "shooting", attackerKeywords: ["WARRIOR"] },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("reports qualified replacement as unsupported instead of stacking it", () => {
    const result = effectToBuffs(
      namedRegion(["CRYPTEK"]),
      unitRule,
      { phase: "shooting", attackerKeywords: ["CRYPTEK"] },
    );
    expect(result.applied).toHaveLength(1);
    expect(result.unsupported.map((entry) => entry.reason)).toContain(
      "named-region-state qualified branch: region membership is unavailable in EngineContext; qualified replacement is unsupported",
    );
  });

  it("keeps Flow of Magic weapon narrowing unsupported", () => {
    const result = effectToBuffs(
      namedRegion(
        ["THOUSAND SONS"],
        "and",
        {
          type: "re-roll",
          target: "attacker",
          modifier: { roll: "wound", subset: "ones", weapon_keyword: "Psychic" },
        },
      ),
      unitRule,
      { phase: "shooting", attackerKeywords: ["thousand sons"] },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported.map((entry) => entry.reason)).toContain(
      're-roll: narrows by "weapon_keyword" which the cruncher can\'t resolve here',
    );
  });
});

describe("effectToBuffs: unhonorable narrowing filters fail safe", () => {
  // A weapon-name / model filter the cruncher can't resolve here must NOT apply
  // the buff unfiltered (silent over-apply); it surfaces as `unsupported`.
  it("stat-modifier with weapon_name → unsupported, not applied", () => {
    const r = effectToBuffs(
      { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1, weapon_name: "power fist" } },
      unitRule, { phase: "fight", attackerStationary: false },
    );
    expect(r.applied).toEqual([]);
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0].reason).toContain("weapon_name");
  });

  it("roll-modifier with model_filter → unsupported", () => {
    const r = effectToBuffs(
      { type: "roll-modifier", target: "unit", modifier: { roll: "hit", operation: "add", value: 1, model_filter: "not-character" } },
      unitRule, ctx,
    );
    expect(r.applied).toEqual([]);
    expect(r.unsupported[0].reason).toContain("model_filter");
  });

  it("re-roll with weapon_profile → unsupported", () => {
    const r = effectToBuffs(
      { type: "re-roll", target: "unit", modifier: { roll: "hit", subset: "all-failures", weapon_profile: "macro-scalpels" } },
      unitRule, ctx,
    );
    expect(r.applied).toEqual([]);
    expect(r.unsupported[0].reason).toContain("weapon_profile");
  });

  it("weapon_type is honorable — phase-gates the stat-modifier rather than blocking it", () => {
    const eff = { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1, weapon_type: "melee" } };
    const r = effectToBuffs(eff, unitRule, { phase: "fight", attackerStationary: false });
    expect(r.applied).toHaveLength(1);
    expect(r.unsupported).toEqual([]);
    expect(r.applied[0].applicableWhen).toEqual({ phases: ["fight"] });
  });
});

describe("effectToBuffs: compound", () => {
  it("sequence walks every step", () => {
    const oath = {
      type: "sequence",
      steps: [
        {
          type: "re-roll",
          target: "unit",
          modifier: { roll: "hit", subset: "all-failures" },
        },
        {
          type: "re-roll",
          target: "unit",
          modifier: { roll: "wound", subset: "all-failures" },
        },
      ],
    };
    const result = effectToBuffs(oath, armyRule, ctx);
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0].contribution).toMatchObject({ roll: "hit" });
    expect(result.applied[1].contribution).toMatchObject({ roll: "wound" });
  });

  it("conditional gated by phase: fires only in matching phase", () => {
    const effect = {
      type: "conditional",
      condition: { type: "phase-is", parameters: { phase: "fight" } },
      effect: {
        type: "roll-modifier",
        target: "unit",
        modifier: { roll: "wound", operation: "add", value: 1 },
      },
    };
    const shooting = effectToBuffs(effect, unitRule, { phase: "shooting" });
    expect(shooting.applied).toEqual([]);
    const fight = effectToBuffs(effect, unitRule, { phase: "fight" });
    expect(fight.applied[0].contribution).toEqual({ type: "wound-mod", value: 1 });
  });

  it("choice branches become opt-in levers (pick one)", () => {
    const result = effectToBuffs(
      {
        type: "choice",
        options: [
          { type: "re-roll", target: "unit", modifier: { roll: "hit", subset: "ones" } },
          { type: "re-roll", target: "unit", modifier: { roll: "wound", subset: "ones" } },
        ],
      },
      unitRule,
      ctx,
    );
    // Player decision — not auto-applied, surfaced as activatable instead.
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.activatable).toHaveLength(2);
    expect(result.activatable.map((a) => a.id)).toEqual(["fury?0", "fury?1"]);
    // A choice is a pick-one group.
    expect(result.activatable[0].group).toEqual({ id: "fury?choice", maxActivations: 1 });
    expect(result.activatable[0].buffs[0].contribution).toEqual({
      type: "reroll",
      roll: "hit",
      subset: "ones",
    });
  });

  it("dice-gated fragments are routed to unsupported", () => {
    const result = effectToBuffs(
      {
        type: "dice-gated",
        dice: "D6",
        threshold: 6,
        on_success: { type: "mortal-wounds", target: "defender", modifier: { count: "1" } },
      },
      unitRule,
      ctx,
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
  });

  it("conditional whose condition the engine can't evaluate is unsupported", () => {
    const result = effectToBuffs(
      {
        type: "conditional",
        condition: { type: "is-attached" },
        effect: {
          type: "roll-modifier",
          target: "unit",
          modifier: { roll: "wound", operation: "add", value: 1 },
        },
      },
      unitRule,
      ctx,
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported[0].reason).toMatch(/cannot evaluate condition/);
  });

  it("was-hit-by-attack reactive trigger is surfaced, never silently applied", () => {
    // A static damage calc can't know whether the buffed unit was hit, so the
    // condition stays "unknown" and the gated buff routes to `unsupported`
    // rather than firing unconditionally — the parity-neutral guarantee that
    // lets us add the trigger without touching any cruncher numerics.
    const result = effectToBuffs(
      {
        type: "conditional",
        condition: { type: "was-hit-by-attack", parameters: { subject: "self" } },
        effect: {
          type: "roll-modifier",
          target: "unit",
          modifier: { roll: "hit", operation: "subtract", value: 1 },
        },
      },
      unitRule,
      ctx,
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported[0].reason).toMatch(/cannot evaluate condition/);
  });
});

describe("effectToBuffs: target filtering", () => {
  it("defender-side rolls are dropped without going to unsupported", () => {
    // A roll-modifier targeting "defender" describes "+1 to opponent's wound
    // rolls against me" — irrelevant when *I* am the attacker.
    const result = effectToBuffs(
      {
        type: "roll-modifier",
        target: "defender",
        modifier: { roll: "wound", operation: "subtract", value: 1 },
      },
      unitRule,
      ctx,
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("attacker-perspective targets are accepted", () => {
    for (const target of ["self", "bearer", "unit", "attacker", "attached-unit", "friendly-within-aura"]) {
      const result = effectToBuffs(
        {
          type: "roll-modifier",
          target,
          modifier: { roll: "hit", operation: "add", value: 1 },
        },
        unitRule,
        ctx,
      );
      expect(result.applied, `target ${target}`).toHaveLength(1);
    }
  });
});

describe("oath-of-moment full effect", () => {
  it("produces hit + wound rerolls and no diagnostics", () => {
    const oath = {
      type: "sequence",
      steps: [
        {
          type: "re-roll",
          target: "unit",
          modifier: { roll: "hit", subset: "all-failures" },
        },
        {
          type: "re-roll",
          target: "unit",
          modifier: { roll: "wound", subset: "all-failures" },
        },
      ],
    };
    const result = effectToBuffs(oath, armyRule, ctx);
    expect(result.unsupported).toEqual([]);
    expect(result.applied.map((b) => b.contribution)).toEqual([
      { type: "reroll", roll: "hit", subset: "all-failures" },
      { type: "reroll", roll: "wound", subset: "all-failures" },
    ]);
  });
});

describe("effectToBuffs: target perspective", () => {
  const ctxT: EngineContext = { phase: "shooting" };

  it("stat-modifier T translates to toughness-mod", () => {
    const result = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "T", operation: "add", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "toughness-mod", value: 1 });
  });

  it("stat-modifier Sv translates to save-mod with sign inversion", () => {
    // "+1 Sv" improves the save → makes the needed roll *lower* → save-mod -1.
    const improve = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "Sv", operation: "add", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(improve.applied[0].contribution).toEqual({ type: "save-mod", value: -1 });

    // "-1 Sv" worsens the save → needed roll goes up → save-mod +1.
    const worsen = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "Sv", operation: "subtract", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(worsen.applied[0].contribution).toEqual({ type: "save-mod", value: 1 });
  });

  it("roll-modifier save translates under target perspective only", () => {
    const node = {
      type: "roll-modifier",
      target: "unit",
      modifier: { roll: "save", operation: "add", value: 1 },
    };
    const tgt = effectToBuffs(node, unitRule, ctxT, "target");
    expect(tgt.applied[0].contribution).toEqual({ type: "save-mod", value: 1 });
    const atk = effectToBuffs(node, unitRule, ctxT, "attacker");
    expect(atk.applied).toEqual([]); // saves aren't attacker-side.
  });

  it('roll-modifier {target:"attacker", roll:"hit"} translates to hit-mod (incoming-hit penalty)', () => {
    // Functionally identical to bs-modifier {target:"attacker"} — both shapes
    // appear in the corpus for "-1 to hit rolls targeting this unit". The
    // translator now accepts both.
    const result = effectToBuffs(
      {
        type: "roll-modifier",
        target: "attacker",
        modifier: { roll: "hit", operation: "subtract", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "hit-mod", value: -1 });
    expect(result.unsupported).toEqual([]);
  });

  it('roll-modifier {target:"attacker", roll:"wound"} translates to wound-mod', () => {
    const result = effectToBuffs(
      {
        type: "roll-modifier",
        target: "attacker",
        modifier: { roll: "wound", operation: "subtract", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "wound-mod", value: -1 });
  });

  it('roll-modifier {target:"attacker", roll:"damage"} is not a defender knob', () => {
    // Damage rolls belong to the attacker's weapon; a defender-side
    // "-1 to damage rolls" would be expressed as damage-reduction instead.
    const result = effectToBuffs(
      {
        type: "roll-modifier",
        target: "attacker",
        modifier: { roll: "damage", operation: "subtract", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied).toEqual([]);
  });

  it("bs-modifier on target: attacker translates to hit-mod under target perspective", () => {
    const result = effectToBuffs(
      {
        type: "bs-modifier",
        target: "attacker",
        modifier: { operation: "subtract", value: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "hit-mod", value: -1 });
  });

  it("attacker-side rerolls are dropped under target perspective", () => {
    const result = effectToBuffs(
      {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "hit", subset: "all-failures" },
      },
      armyRule,
      ctxT,
      "target",
    );
    expect(result.applied).toEqual([]);
  });

  it("save reroll under target perspective passes through", () => {
    const result = effectToBuffs(
      {
        type: "re-roll",
        target: "unit",
        modifier: { roll: "save", subset: "ones" },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({
      type: "reroll",
      roll: "save",
      subset: "ones",
    });
  });

  it("keyword-grant is attacker-side, drops under target perspective", () => {
    const result = effectToBuffs(
      {
        type: "keyword-grant",
        target: "unit",
        modifier: { keywords: ["Lethal Hits"] },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied).toEqual([]);
  });

  it("damage-reduction numeric translates to damage-reduction buff", () => {
    const result = effectToBuffs(
      {
        type: "damage-reduction",
        target: "unit",
        modifier: { reduction: 1 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "damage-reduction", value: 1 });
    expect(result.unsupported).toEqual([]);
  });

  it("damage-reduction drops silently under attacker perspective", () => {
    // The effect is defender-side; an attacker-perspective walk shouldn't
    // surface it as either applied or unsupported (mirrors feel-no-pain).
    const result = effectToBuffs(
      {
        type: "damage-reduction",
        target: "unit",
        modifier: { reduction: 1 },
      },
      unitRule,
      { phase: "shooting" },
      "attacker",
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("invulnerable-save translates to invulnerable-save buff", () => {
    const result = effectToBuffs(
      {
        type: "invulnerable-save",
        target: "self",
        modifier: { invuln_sv: 4 },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({ type: "invulnerable-save", threshold: 4 });
    expect(result.unsupported).toEqual([]);
  });

  it("invulnerable-save drops silently under attacker perspective", () => {
    const result = effectToBuffs(
      {
        type: "invulnerable-save",
        target: "self",
        modifier: { invuln_sv: 4 },
      },
      unitRule,
      { phase: "shooting" },
      "attacker",
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("invulnerable-save with out-of-range threshold routes to unsupported", () => {
    for (const invuln_sv of [1, 8, "garbage"]) {
      const result = effectToBuffs(
        {
          type: "invulnerable-save",
          target: "self",
          modifier: { invuln_sv },
        },
        unitRule,
        ctxT,
        "target",
      );
      expect(result.applied).toEqual([]);
      expect(result.unsupported).toHaveLength(1);
    }
  });

  it('feel-no-pain modifier.scope:"mortal" carries through to the buff', () => {
    const result = effectToBuffs(
      {
        type: "feel-no-pain",
        target: "self",
        modifier: { threshold: 5, scope: "mortal" },
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied[0].contribution).toEqual({
      type: "feel-no-pain",
      threshold: 5,
      scope: "mortal",
    });
  });

  it("feel-no-pain with unrecognised scope routes to unsupported", () => {
    const result = effectToBuffs(
      {
        type: "feel-no-pain",
        target: "self",
        modifier: { threshold: 5, scope: "mortals" }, // typo
      },
      unitRule,
      ctxT,
      "target",
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].reason).toContain("scope");
  });

  it('damage-reduction "half" and "to-zero" route to unsupported', () => {
    for (const reduction of ["half", "to-zero"]) {
      const result = effectToBuffs(
        {
          type: "damage-reduction",
          target: "unit",
          modifier: { reduction },
        },
        unitRule,
        ctxT,
        "target",
      );
      expect(result.applied).toEqual([]);
      expect(result.unsupported).toHaveLength(1);
      expect(result.unsupported[0].reason).toContain(reduction);
    }
  });
});

describe("effectToBuffs: compound conditions", () => {
  const woundEffect = {
    type: "roll-modifier",
    target: "unit",
    modifier: { roll: "wound", operation: "add", value: 1 },
  };
  function conditional(condition: unknown) {
    return { type: "conditional", condition, effect: woundEffect };
  }

  it("AND: all operands true → effect fires", () => {
    const result = effectToBuffs(
      conditional({
        operator: "and",
        operands: [
          { type: "phase-is", parameters: { phase: "fight" } },
          { type: "remained-stationary" },
        ],
      }),
      unitRule,
      { phase: "fight", attackerStationary: true },
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({ type: "wound-mod", value: 1 });
  });

  it("AND: a false operand short-circuits and drops the effect without diagnostic", () => {
    const result = effectToBuffs(
      conditional({
        operator: "and",
        operands: [
          { type: "phase-is", parameters: { phase: "fight" } },
          { type: "remained-stationary" },
        ],
      }),
      unitRule,
      { phase: "shooting", attackerStationary: true },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("AND: a false operand short-circuits over an unknown operand (no diagnostic)", () => {
    const result = effectToBuffs(
      conditional({
        operator: "and",
        operands: [
          { type: "phase-is", parameters: { phase: "fight" } }, // false
          { type: "is-attached" }, // unknown
        ],
      }),
      unitRule,
      { phase: "shooting" },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("AND: unknown operand without short-circuit propagates to unsupported", () => {
    const result = effectToBuffs(
      conditional({
        operator: "and",
        operands: [
          { type: "phase-is", parameters: { phase: "fight" } }, // true
          { type: "is-attached" }, // unknown
        ],
      }),
      unitRule,
      { phase: "fight" },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported[0].reason).toMatch(/cannot evaluate condition/);
  });

  it("OR: any true operand fires the effect", () => {
    const result = effectToBuffs(
      conditional({
        operator: "or",
        operands: [
          { type: "phase-is", parameters: { phase: "shooting" } }, // false
          { type: "phase-is", parameters: { phase: "fight" } }, // true
        ],
      }),
      unitRule,
      { phase: "fight" },
    );
    expect(result.applied).toHaveLength(1);
  });

  it("OR: all-false drops cleanly (no diagnostic)", () => {
    const result = effectToBuffs(
      conditional({
        operator: "or",
        operands: [
          { type: "phase-is", parameters: { phase: "shooting" } },
          { type: "phase-is", parameters: { phase: "movement" } },
        ],
      }),
      unitRule,
      { phase: "fight" },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("NOT: inverts a true operand to false", () => {
    const result = effectToBuffs(
      conditional({
        operator: "not",
        operands: [{ type: "phase-is", parameters: { phase: "fight" } }],
      }),
      unitRule,
      { phase: "fight" },
    );
    expect(result.applied).toEqual([]);
  });

  it("NOT: inverts a false operand to true", () => {
    const result = effectToBuffs(
      conditional({
        operator: "not",
        operands: [{ type: "phase-is", parameters: { phase: "shooting" } }],
      }),
      unitRule,
      { phase: "fight" },
    );
    expect(result.applied).toHaveLength(1);
  });

  it("nested compound: AND of (OR + simple) evaluates recursively", () => {
    const result = effectToBuffs(
      conditional({
        operator: "and",
        operands: [
          {
            operator: "or",
            operands: [
              { type: "phase-is", parameters: { phase: "shooting" } },
              { type: "phase-is", parameters: { phase: "fight" } },
            ],
          },
          { type: "remained-stationary" },
        ],
      }),
      unitRule,
      { phase: "fight", attackerStationary: true },
    );
    expect(result.applied).toHaveLength(1);
  });
});

describe("effectToBuffs: timing-is condition", () => {
  const effect = {
    type: "conditional",
    condition: { type: "timing-is", parameters: { timing: "end-of-phase" } },
    effect: {
      type: "roll-modifier",
      target: "unit",
      modifier: { roll: "wound", operation: "add", value: 1 },
    },
  };

  it("fires when context timing matches", () => {
    const result = effectToBuffs(effect, unitRule, {
      phase: "fight",
      timing: "end-of-phase",
    });
    expect(result.applied).toHaveLength(1);
  });

  it("drops cleanly when context timing differs", () => {
    const result = effectToBuffs(effect, unitRule, {
      phase: "fight",
      timing: "start-of-phase",
    });
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("becomes an opt-in lever when context timing is missing", () => {
    // A timing the player controls isn't a wall — it's an activation they can
    // toggle on. No diagnostic; a lever instead.
    const result = effectToBuffs(effect, unitRule, { phase: "fight" });
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.activatable).toHaveLength(1);
    expect(result.activatable[0].id).toBe("fury@end-of-phase");
    expect(result.activatable[0].buffs[0].contribution).toEqual({ type: "wound-mod", value: 1 });
  });
});

describe("effectToBuffs: activatable gates", () => {
  it("dice-pool options become grouped levers capped by max_activations", () => {
    const result = effectToBuffs(
      {
        type: "dice-pool-allocation",
        pool: { count: 8, die: "D6" },
        max_activations: 2,
        options: [
          {
            name: "Martial Excellence",
            requirement: { type: "pair", min_value: 4 },
            effect: {
              type: "keyword-grant",
              target: "all-friendly",
              modifier: { keywords: ["Sustained Hits 1"] },
            },
          },
          {
            name: "Warp Blades",
            requirement: { type: "pair", min_value: 5 },
            effect: {
              type: "keyword-grant",
              target: "all-friendly",
              modifier: { keywords: ["Lethal Hits"] },
            },
          },
        ],
      },
      unitRule,
      { phase: "fight" },
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.activatable.map((a) => a.id)).toEqual([
      "fury#Martial Excellence",
      "fury#Warp Blades",
    ]);
    // Every lever is grouped under the pool, capped at the activation count.
    expect(result.activatable.every((a) => a.group?.id === "fury" && a.group?.maxActivations === 2)).toBe(
      true,
    );
    expect(result.activatable[1].buffs[0].contribution).toEqual({
      type: "extra-keyword",
      keywordRef: { keyword_id: "lethal-hits" },
    });
  });

  it("a dice-pool option that yields no combat buff is not a lever", () => {
    const result = effectToBuffs(
      {
        type: "dice-pool-allocation",
        pool: { count: 8, die: "D6" },
        max_activations: 2,
        options: [
          {
            name: "Rage-Fuelled Invigoration",
            requirement: { type: "pair", min_value: 2 },
            effect: { type: "movement-modifier", target: "all-friendly", modifier: {} },
          },
        ],
      },
      unitRule,
      { phase: "fight" },
    );
    expect(result.activatable).toEqual([]);
    expect(result.applied).toEqual([]);
  });

  it("target/phase conditions inside a gate defer to applicableWhen", () => {
    // Decapitating Strikes shape: Devastating Wounds, but only vs Infantry in melee.
    const result = effectToBuffs(
      {
        type: "dice-pool-allocation",
        pool: { count: 8, die: "D6" },
        max_activations: 2,
        options: [
          {
            name: "Decapitating Strikes",
            requirement: { type: "triple", min_value: 6 },
            effect: {
              type: "conditional",
              condition: {
                operator: "and",
                operands: [
                  { type: "target-has-keyword", parameters: { keyword: "Infantry" } },
                  { type: "attack-is-type", parameters: { attack_type: "melee" } },
                ],
              },
              effect: {
                type: "keyword-grant",
                target: "all-friendly",
                modifier: { keywords: ["Devastating Wounds"] },
              },
            },
          },
        ],
      },
      unitRule,
      { phase: "fight" },
    );
    expect(result.activatable).toHaveLength(1);
    const buff = result.activatable[0].buffs[0];
    expect(buff.contribution).toEqual({
      type: "extra-keyword",
      keywordRef: { keyword_id: "devastating-wounds" },
    });
    // The "vs Infantry, in the fight phase" gate rides on the buff so the
    // resolver applies it per-target rather than the lever vanishing.
    expect(buff.applicableWhen).toEqual({ requiresTargetKeyword: "Infantry", phases: ["fight"] });
  });

  it("a timing gate around a sequence yields one lever bundling its buffs", () => {
    // Possessed Lord shape: start-of-phase → A+3 and Devastating Wounds together.
    const result = effectToBuffs(
      {
        type: "conditional",
        condition: { type: "timing-is", parameters: { timing: "start-of-phase" } },
        effect: {
          type: "sequence",
          steps: [
            { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 3 } },
            { type: "keyword-grant", target: "unit", modifier: { keywords: ["Devastating Wounds"] } },
          ],
        },
      },
      unitRule,
      { phase: "fight" },
    );
    expect(result.activatable).toHaveLength(1);
    expect(result.activatable[0].id).toBe("fury@start-of-phase");
    expect(result.activatable[0].buffs.map((b) => b.contribution.type)).toEqual([
      "attacks-mod",
      "extra-keyword",
    ]);
  });

  it("a timing gate whose body has no combat buff yields no lever", () => {
    // Berzerker Frenzy shape: on-destroyed → dice-gated → resurrection.
    const result = effectToBuffs(
      {
        type: "conditional",
        condition: { type: "timing-is", parameters: { timing: "on-destroyed" } },
        effect: {
          type: "dice-gated",
          dice: "D6",
          threshold: 2,
          on_success: { type: "resurrection", target: "self", modifier: {} },
          on_fail: null,
        },
      },
      unitRule,
      { phase: "fight" },
    );
    expect(result.activatable).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });
});

describe("effectToBuffs: AP stat-modifier", () => {
  const apEffect = {
    type: "stat-modifier",
    target: "unit",
    modifier: { stat: "AP", operation: "add", value: -1 },
  };

  it("attacker perspective: +1 piercing → ap-mod -1", () => {
    const result = effectToBuffs(apEffect, unitRule, ctx, "attacker");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({ type: "ap-mod", value: -1 });
  });

  it("target perspective: drops silently (AP is attacker-side)", () => {
    const result = effectToBuffs(apEffect, unitRule, ctx, "target");
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("attacker perspective, defender-side target: drops without diagnostic", () => {
    const result = effectToBuffs(
      {
        type: "stat-modifier",
        target: "defender",
        modifier: { stat: "AP", operation: "add", value: -1 },
      },
      unitRule,
      ctx,
      "attacker",
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("operation 'improve' → more piercing (ap-mod negative)", () => {
    // Hack and Slash shape: improve AP by 1 → one more negative.
    const result = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "AP", operation: "improve", value: 1, attack_type: "melee" },
      },
      unitRule,
      { phase: "fight" },
      "attacker",
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].contribution).toEqual({ type: "ap-mod", value: -1 });
    // melee attack_type rides on the buff as a fight-phase gate.
    expect(result.applied[0].applicableWhen).toEqual({ phases: ["fight"] });
    expect(result.unsupported).toEqual([]);
  });

  it("operation 'worsen' on the attacker is not applied as an attacker buff", () => {
    // Defensive shape (orks/tau/custodes): "enemy weapons targeting this unit
    // have AP worsened" — must not weaken the buffed unit's own attacks.
    const result = effectToBuffs(
      {
        type: "stat-modifier",
        target: "attacker",
        modifier: { stat: "AP", operation: "worsen", value: 1 },
      },
      unitRule,
      ctx,
      "attacker",
    );
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0].reason).toMatch(/defender-side AP reduction/);
  });
});

describe("effectToBuffs: improve/worsen on symmetric stats", () => {
  it("A improve → +value, S worsen → -value", () => {
    const improve = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "A", operation: "improve", value: 2 },
      },
      unitRule,
      ctx,
    );
    expect(improve.applied[0].contribution).toEqual({ type: "attacks-mod", value: 2 });

    const worsen = effectToBuffs(
      {
        type: "stat-modifier",
        target: "unit",
        modifier: { stat: "S", operation: "worsen", value: 1 },
      },
      unitRule,
      ctx,
    );
    expect(worsen.applied[0].contribution).toEqual({ type: "strength-mod", value: -1 });
  });
});

describe("effectToBuffs: charged-this-turn condition", () => {
  // Relentless Rage shape: charged this turn → +1 A, +2 S in melee.
  const relentlessRage = {
    type: "conditional",
    condition: { type: "charged-this-turn" },
    effect: {
      type: "sequence",
      steps: [
        { type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1, attack_type: "melee" } },
        { type: "stat-modifier", target: "unit", modifier: { stat: "S", operation: "add", value: 2, attack_type: "melee" } },
      ],
    },
  };

  it("applies when attackerCharged is true", () => {
    const result = effectToBuffs(relentlessRage, unitRule, {
      phase: "fight",
      attackerCharged: true,
    });
    expect(result.applied.map((b) => b.contribution)).toEqual([
      { type: "attacks-mod", value: 1 },
      { type: "strength-mod", value: 2 },
    ]);
    expect(result.applied.every((b) => b.applicableWhen?.phases?.[0] === "fight")).toBe(true);
    expect(result.unsupported).toEqual([]);
  });

  it("drops cleanly when attackerCharged is false", () => {
    const result = effectToBuffs(relentlessRage, unitRule, {
      phase: "fight",
      attackerCharged: false,
    });
    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  it("is unsupported when attackerCharged is undefined", () => {
    const result = effectToBuffs(relentlessRage, unitRule, { phase: "fight" });
    expect(result.applied).toEqual([]);
    expect(result.unsupported[0].reason).toMatch(/cannot evaluate condition/);
  });
});

describe("parseKeywordGrant", () => {
  it.each([
    ["Lethal Hits", { keyword_id: "lethal-hits" }],
    ["Sustained Hits 1", { keyword_id: "sustained-hits", parameters: { value: 1 } }],
    ["Sustained Hits 2", { keyword_id: "sustained-hits", parameters: { value: 2 } }],
    ["Twin-linked", { keyword_id: "twin-linked" }],
    ["Precision", { keyword_id: "precision" }],
    ["Rapid Fire 1", { keyword_id: "rapid-fire", parameters: { value: 1 } }],
    [
      "Anti-INFANTRY 4+",
      { keyword_id: "anti", parameters: { target_keyword: "INFANTRY", threshold: 4 } },
    ],
  ])("%s → %j", (input, expected) => {
    expect(parseKeywordGrant(input)).toEqual(expected);
  });
});
