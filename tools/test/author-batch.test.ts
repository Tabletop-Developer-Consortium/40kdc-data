import { describe, expect, it } from "vitest";
import { assembleEffect, buildEntry, buildRepairedEntry, canReplaceEffect, conditionNode, lintCanonical, parseClaudeEnvelope, passesGate, type Proposal } from "../src/author-batch.js";
import { createValidator } from "../src/schema-loader.js";

const ABILITY_SCHEMA_ID = "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json";

/** A minimally-valid original entry to graft repaired effects onto. */
const ORIGINAL = {
  ability_id: "test-ability",
  name: "X",
  authored_by: "40kdc-community",
  game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
  unit_ids: ["test-unit"],
  ability_type: "unit",
  effect: { type: "stat-modifier", target: "self", modifier: {} },
  scope: { range: "self", duration: "phase" },
  community_notes: "stub",
};

describe("parseClaudeEnvelope", () => {
  it("ignores trailing client warnings without truncating braces inside strings", () => {
    const expected = {
      is_error: false,
      structured_output: { message: 'keeps } and "quoted" text' },
    };
    const envelope = `${JSON.stringify(expected)}\nClient.listTools() warning`;
    expect(parseClaudeEnvelope(envelope)).toEqual(expected);
  });
});

describe("conditionNode", () => {
  it("maps known kinds to condition objects and 'none' to null", () => {
    expect(conditionNode("none", null)).toBeNull();
    expect(conditionNode("vs-keyword", "MONSTER")).toEqual({ type: "target-has-keyword", parameters: { keyword: "MONSTER" } });
    expect(conditionNode("charged", null)).toEqual({ type: "charged-this-turn" });
    expect(conditionNode("phase", "shooting")).toEqual({ type: "phase-is", parameters: { phase: "shooting" } });
  });
});

describe("assembleEffect", () => {
  it("builds an unconditional leaf when condition_kind is none", () => {
    const { effect, scope } = assembleEffect({
      effect_type: "roll-modifier", target: "unit", modifier: { operation: "add", roll: "hit", value: 1 },
      attack_type: "any", condition_kind: "none", scope_range: "unit", scope_duration: "phase",
    });
    expect(effect).toEqual({ type: "roll-modifier", target: "unit", modifier: { operation: "add", roll: "hit", value: 1 } });
    expect(scope).toEqual({ range: "unit", duration: "phase" });
  });

  it("wraps in a conditional when a condition is set", () => {
    const { effect } = assembleEffect({
      effect_type: "re-roll", target: "unit", modifier: { roll: "wound", subset: "all-failures" },
      attack_type: "any", condition_kind: "vs-keyword", condition_param: "VEHICLE", scope_range: "unit", scope_duration: "phase",
    });
    expect(effect.type).toBe("conditional");
    expect(effect.condition).toEqual({ type: "target-has-keyword", parameters: { keyword: "VEHICLE" } });
    expect(effect.effect.type).toBe("re-roll");
  });

  it("injects attack_type into the modifier for combat effects only", () => {
    const melee = assembleEffect({ effect_type: "stat-modifier", target: "unit", modifier: { stat: "A", operation: "add", value: 1 }, attack_type: "melee", condition_kind: "none", scope_range: "unit", scope_duration: "phase" });
    expect(melee.effect.modifier.attack_type).toBe("melee");
    // ability-grant is not a combat effect — no attack_type injection
    const grant = assembleEffect({ effect_type: "ability-grant", target: "unit", modifier: { ability_id: "x" }, attack_type: "melee", condition_kind: "none", scope_range: "unit", scope_duration: "permanent" });
    expect(grant.effect.modifier.attack_type).toBeUndefined();
  });

  it("forces an empty modifier for parameterless flag effects", () => {
    const { effect } = assembleEffect({ effect_type: "deep-strike", target: "unit", modifier: { junk: 1 }, attack_type: "any", condition_kind: "none", scope_range: "unit", scope_duration: "permanent" });
    expect(effect.modifier).toEqual({});
  });
});

describe("buildEntry", () => {
  it("preserves the original metadata and replaces effect/scope/notes", () => {
    const original = { ability_id: "x", name: "X", authored_by: "40kdc-community", game_version: { edition: "11th", dataslate: "pre-launch-provisional" }, unit_ids: ["u"], ability_type: "unit", effect: { type: "stat-modifier", target: "unit", modifier: {} }, community_notes: "stub" };
    const entry = buildEntry(original, { effect_type: "feel-no-pain", target: "unit", modifier: { threshold: 5 }, attack_type: "any", condition_kind: "none", scope_range: "unit", scope_duration: "phase" });
    expect(entry.ability_id).toBe("x");
    expect(entry.authored_by).toBe("40kdc-community");
    expect(entry.unit_ids).toEqual(["u"]);
    expect(entry.effect).toEqual({ type: "feel-no-pain", target: "unit", modifier: { threshold: 5 } });
    expect(entry.community_notes).toBe("community-authored from 10e source (provisional 11e); see #21");
  });

  it("labels a non-provisional 11e snapshot as an 11e source", () => {
    const original = {
      ability_id: "x",
      game_version: { edition: "11th", dataslate: "codex-fixture" },
      effect: { type: "deep-strike", target: "unit", modifier: {} },
    };
    const entry = buildEntry(original, {
      effect_type: "deep-strike",
      target: "unit",
      modifier: {},
      attack_type: "any",
      condition_kind: "none",
      scope_range: "unit",
      scope_duration: "permanent",
    });
    expect(entry.community_notes).toBe("community-authored from 11e source");
  });
});

describe("buildRepairedEntry", () => {
  const nested = {
    type: "conditional",
    condition: { operator: "not", operands: [{ type: "is-battle-shocked" }] },
    effect: { type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1 } },
  };

  it("grafts a pre-formed nested effect tree verbatim and preserves metadata", () => {
    const entry = buildRepairedEntry(ORIGINAL, nested, { range: "self", duration: "phase" }, "passive");
    expect(entry.ability_id).toBe("test-ability");
    expect(entry.authored_by).toBe("40kdc-community");
    expect(entry.unit_ids).toEqual(["test-unit"]);
    expect(entry.effect).toBe(nested); // no flat-form assembly — the tree is used as-is
    expect(entry.behavior).toBe("passive");
    expect(entry.community_notes).not.toBe("stub");
  });

  it("only sets behavior when it is a valid enum value", () => {
    expect(buildRepairedEntry(ORIGINAL, nested, { range: "self", duration: "phase" }, "made-up").behavior).toBeUndefined();
    expect(buildRepairedEntry(ORIGINAL, nested, { range: "self", duration: "phase" }, undefined).behavior).toBeUndefined();
  });

  it("grafts and removes ability-level repair fields explicitly", () => {
    const original = {
      ...ORIGINAL,
      trigger: { event: "enemy-unit-ended-move", subject: "enemy-unit" },
      usage: { frequency: "once-per-turn", per: "unit" },
    };
    const entry = buildRepairedEntry(
      original,
      nested,
      { range: "self", duration: "phase" },
      "reactive",
      {
        trigger: { event: "unit-selected-to-shoot", subject: "self" },
        usage: null,
        applies_to: { required_keywords: ["WARBOSS"] },
      },
    );
    expect(entry.trigger).toEqual({ event: "unit-selected-to-shoot", subject: "self" });
    expect(entry.usage).toBeUndefined();
    expect(entry.applies_to).toEqual({ required_keywords: ["WARBOSS"] });
  });
});

describe("buildRepairedEntry → AJV gate", () => {
  const ajv = createValidator();
  const validate = (x: unknown): boolean => !!ajv.getSchema(ABILITY_SCHEMA_ID)!(x);

  it("accepts a faithful nested tree (compound condition + leaf)", () => {
    const entry = buildRepairedEntry(ORIGINAL, {
      type: "conditional",
      condition: { operator: "and", operands: [{ type: "phase-is", parameters: { phase: "command" } }, { type: "unit-has-keyword", parameters: { keyword: "INFANTRY" } }] },
      effect: { type: "ability-grant", target: "self", modifier: { ability_id: "temple-relics" } },
    }, { range: "self", duration: "turn" }, "passive");
    expect(validate(entry)).toBe(true);
  });

  it("rejects an invented condition type — the loose LLM envelope can't smuggle bad enums past AJV", () => {
    const entry = buildRepairedEntry(ORIGINAL, {
      type: "conditional",
      condition: { type: "when-the-stars-align" },
      effect: { type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1 } },
    }, { range: "self", duration: "phase" });
    expect(validate(entry)).toBe(false);
  });
  it("rejects rerolls carrying both result-selection forms", () => {
    const entry = buildRepairedEntry(ORIGINAL, {
      type: "re-roll",
      target: "self",
      modifier: { roll: "advance", subset: "all-failures", result_scope: "any-result" },
    }, { range: "self", duration: "phase" });
    expect(validate(entry)).toBe(false);
  });
});


describe("lintCanonical", () => {
  it("accepts canonical leaves nested under wrappers", () => {
    const eff = {
      type: "conditional",
      condition: { type: "unit-has-keyword", parameters: { keyword: "WAR DOG" } },
      effect: { type: "sequence", steps: [
        { type: "stat-modifier", target: "unit", modifier: { stat: "T", operation: "add", value: 1 } },
        { type: "keyword-grant", target: "unit", modifier: { keywords: ["Lethal Hits"], weapon_type: "melee" } },
      ] },
    };
    expect(lintCanonical(eff)).toEqual({ canonical: true, issues: [] });
  });

  it("rejects non-canonical leaves beneath every nested wrapper shape", () => {
    const invalidLeaf = {
      type: "stat-modifier",
      target: "unit",
      modifier: { stat: "A", operation: "add", value: 1, model_filter: "not-character" },
    };
    const wrappers = [
      { name: "aura", effect: { type: "aura", modifier: { effect: invalidLeaf } } },
      { name: "risk reward", effect: { type: "risk-reward", reward: invalidLeaf } },
      { name: "risk failure", effect: { type: "risk-reward", risk: { on_fail: invalidLeaf } } },
      { name: "resource action", effect: { type: "resource-action-menu", actions: [{ effect: invalidLeaf }] } },
      { name: "region default", effect: { type: "named-region-state", modifier: { consumer: { default_branch: { effect: invalidLeaf } } } } },
      { name: "region qualified", effect: { type: "named-region-state", modifier: { consumer: { qualified_branch: { effect: invalidLeaf } } } } },
    ];
    for (const wrapper of wrappers) {
      const result = lintCanonical(wrapper.effect);
      expect(result.canonical, wrapper.name).toBe(false);
      expect(result.issues.join(), wrapper.name).toContain("model_filter");
    }
  });

  it("rejects non-canonical conditions beneath action eligibility", () => {
    const result = lintCanonical({
      type: "resource-action-menu",
      actions: [{
        eligibility: { requires: [{ type: "unit-has-keyword", keyword: "FABRICATED" }] },
        effect: { type: "no-effect" },
      }],
    });
    expect(result.canonical).toBe(false);
    expect(result.issues.join()).toContain("parameters");
  });

  it("accepts any-result rerolls and rejects ambiguous or unknown result scopes", () => {
    expect(lintCanonical({ type: "re-roll", target: "self", modifier: { roll: "advance", result_scope: "any-result" } }).canonical).toBe(true);
    expect(lintCanonical({ type: "re-roll", target: "self", modifier: { roll: "advance", result_scope: "all-results" } }).canonical).toBe(false);
    expect(lintCanonical({ type: "re-roll", target: "self", modifier: { roll: "advance" } }).canonical).toBe(false);
    expect(lintCanonical({ type: "re-roll", target: "self", modifier: { roll: "advance", subset: "all-failures", result_scope: "any-result" } }).canonical).toBe(false);
  });

  it("rejects invented modifier keys on cruncher-interpreted leaves (the silent-over-apply trap)", () => {
    const r = lintCanonical({ type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 2, model_filter: "not-character" } });
    expect(r.canonical).toBe(false);
    expect(r.issues.join()).toContain("model_filter");
  });

  it("rejects out-of-vocabulary stat / attack_type", () => {
    expect(lintCanonical({ type: "stat-modifier", target: "self", modifier: { stat: "Move", operation: "subtract", value: 2 } }).canonical).toBe(false);
    expect(lintCanonical({ type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1, attack_type: "arco-flail" } }).canonical).toBe(false);
  });

  it("stays permissive on non-interpreted leaf types (ability-grant keys are a consistency nit, not corruption)", () => {
    expect(lintCanonical({ type: "ability-grant", target: "self", modifier: { ability: "observer-unit", bypass_restrictions: ["advanced-this-turn"] } }).canonical).toBe(true);
  });

  it("rejects condition params placed top-level instead of under `parameters` (cruncher can't read them)", () => {
    const bad = lintCanonical({ type: "conditional", condition: { type: "unit-has-keyword", keyword: "TECH-PRIEST" }, effect: { type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1 } } });
    expect(bad.canonical).toBe(false);
    expect(bad.issues.join()).toContain("parameters");
    const good = lintCanonical({ type: "conditional", condition: { type: "unit-has-keyword", parameters: { keyword: "TECH-PRIEST" } }, effect: { type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1 } } });
    expect(good.canonical).toBe(true);
  });

  it("rejects non-canonical phase condition values", () => {
    const effect = (phase: string) => ({
      type: "conditional",
      condition: { type: "phase-is", parameters: { phase } },
      effect: { type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1 } },
    });
    expect(lintCanonical(effect("command")).canonical).toBe(true);
    const bad = lintCanonical(effect("Shooting"));
    expect(bad.canonical).toBe(false);
    expect(bad.issues.join()).toContain("unknown phase");
  });

  it("rejects non-canonical player-turn condition values", () => {
    const effect = (turn: unknown) => ({
      type: "conditional",
      condition: { type: "player-turn-is", parameters: { turn } },
      effect: { type: "stat-modifier", target: "self", modifier: { stat: "A", operation: "add", value: 1 } },
    });
    expect(lintCanonical(effect("your")).canonical).toBe(true);
    const bad = lintCanonical(effect(1));
    expect(bad.canonical).toBe(false);
    expect(bad.issues.join()).toContain("unknown turn");
  });

  it("recurses compound-condition operands for stray top-level params", () => {
    const bad = lintCanonical({ type: "conditional", condition: { operator: "and", operands: [{ type: "phase-is", parameters: { phase: "command" } }, { type: "units-destroyed", side: "friendly", count_min: 1 }] }, effect: { type: "stat-modifier", target: "self", modifier: { stat: "S", operation: "add", value: 1 } } });
    expect(bad.canonical).toBe(false);
  });
});

describe("passesGate", () => {
  const base: Proposal = {
    ability_id: "a",
    name: "A",
    faction: "f",
    schema_valid: true,
    final_faithful: true,
    confidence: "high",
    complex: false,
    verdict: { faithful: true, severity: "ok", issue: "" },
  };
  it("passes a schema-valid, faithful, high-confidence, non-complex proposal", () => {
    expect(passesGate(base, { minConfidence: "medium", includeComplex: false })).toBe(true);
  });
  it("rejects schema-invalid or unfaithful proposals", () => {
    expect(passesGate({ ...base, schema_valid: false }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, final_faithful: false }, { minConfidence: "medium", includeComplex: false })).toBe(false);
  });

  it("requires an explicit faithful, ok verifier verdict even when the saved summary says faithful", () => {
    expect(passesGate({ ...base, verdict: null }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, verdict: { faithful: true, severity: "minor", issue: "scope" } }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, verdict: { faithful: false, severity: "ok", issue: "condition" } }, { minConfidence: "medium", includeComplex: false })).toBe(false);
  });
  it("rejects low confidence always, and medium when min-confidence is high", () => {
    expect(passesGate({ ...base, confidence: "low" }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, confidence: "medium" }, { minConfidence: "high", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, confidence: "medium" }, { minConfidence: "medium", includeComplex: false })).toBe(true);
  });
  it("gates complex unless explicitly included", () => {
    expect(passesGate({ ...base, complex: true }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, complex: true }, { minConfidence: "medium", includeComplex: true })).toBe(true);
  });
  it("lets a repaired+faithful+canonical proposal through even when complex (the tree expresses it)", () => {
    const repaired: Proposal = { ...base, complex: true, repaired: true, canonical: true };
    expect(passesGate(repaired, { minConfidence: "medium", includeComplex: false })).toBe(true);
  });
  it("still blocks a repaired proposal that is unfaithful, low-confidence, non-canonical, or unencodable", () => {
    expect(passesGate({ ...base, repaired: true, canonical: true, final_faithful: false }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, repaired: true, canonical: true, confidence: "low" }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, repaired: true, canonical: false }, { minConfidence: "medium", includeComplex: false })).toBe(false);
    expect(passesGate({ ...base, repaired: true, canonical: true, unencodable: true }, { minConfidence: "medium", includeComplex: false })).toBe(false);
  });
});

describe("canReplaceEffect", () => {
  const proposal: Proposal = {
    ability_id: "a",
    name: "A",
    faction: "f",
    schema_valid: true,
    final_faithful: true,
    confidence: "high",
    verdict: { faithful: true, severity: "ok", issue: "" },
  };
  const gateOptions = { minConfidence: "medium" as const, includeComplex: false };
  it("fills a structural stub by default but protects an authored effect", () => {
    expect(canReplaceEffect(proposal, { type: "stat-modifier", modifier: {} }, { ...gateOptions, reauthor: false })).toBe(true);
    expect(canReplaceEffect(proposal, { type: "stat-modifier", modifier: { stat: "A", operation: "add", value: 1 } }, { ...gateOptions, reauthor: false })).toBe(false);
  });

  it("replaces an authored effect only when --reauthor is explicit", () => {
    expect(canReplaceEffect(proposal, { type: "stat-modifier", modifier: { stat: "A", operation: "add", value: 1 } }, { ...gateOptions, reauthor: true })).toBe(true);
  });
});
