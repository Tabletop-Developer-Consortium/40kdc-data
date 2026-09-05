import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/schema-loader.js";
import { describeAbility } from "../src/translate/effect.js";
import { lintCanonical } from "../src/author-batch.js";
import { checkReferentialIntegrity } from "../src/integrity.js";
import { effectToBuffs } from "../src/cruncher/from-dsl.js";

// Read the faction file, not the globally deduplicated ability index.
// Several reviewed identifiers are shared across factions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const root = resolve(import.meta.dirname, "../..");
const abilities: Json[] = JSON.parse(readFileSync(join(root, "data/enrichment/grey-knights/abilities.json"), "utf8"));
const units: Json[] = JSON.parse(readFileSync(join(root, "data/core/grey-knights/units.json"), "utf8"));
const detachments: Json[] = JSON.parse(readFileSync(join(root, "data/core/grey-knights/detachments.json"), "utf8"));
const ability = (id: string): Json => {
  const found = abilities.filter((a) => a.ability_id === id);
  expect(found).toHaveLength(1);
  return found[0];
};
const validate = createValidator().getSchema("https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json")!;
const contracts: Record<string, string[]> = {
  "dauntless-champions": ["selected to fight", "PALADIN SQUAD", "S is less than", "Wound", "melee"],
  "attuned-onslaught-psychic": ["Charge move", "PALADIN SQUAD model", "in this model's unit", "Damage", "melee", "end of the turn"],
  "blessing-of-the-omnissiah": ["Command phase", "GREY KNIGHTS VEHICLE model", "3 inches", "D3 lost wounds", "+1 to Hit", "per turn across your army", "next Command phase"],
  "guardians-of-the-machine": ["enemy unit ends a Charge", '6"', "Engagement Range", "GREY KNIGHTS and VEHICLE", "Heroic Intervention", "1 less CP", "different unit", "later in this phase"],
  "techmarine": ['3"', "friendly", "GREY KNIGHTS and VEHICLE", "this model gains the Lone Operative"],
  "force-edge-psychic": ["not a MONSTER or VEHICLE", "melee weapons", "Armour Penetration"],
  "champion-of-the-order-of-purifiers-psychic": ["leading a unit", "Purifying Flame weapons", "Attacks"],
  "might-of-titan-psychic": ["start of the phase", "fight phase", "once per battle per model", "Add 3 to the Attacks", "Add 3 to the Strength", "melee weapons equipped by this model", "end of the phase"],
  "warrior-strategist": ["unit is targeted with a Stratagem", "once per battle round per army", "reduce", "that use", "1CP", "before paying"],
  "surge-of-wrath-psychic": ["MONSTER targets or", "VEHICLE targets", "Hit roll", "Wound roll", "Damage roll", "this model", "melee"],
  "sanctuary-psychic": ["unit gains the Stealth", "attacking unit", "-1 to Hit", "melee"],
  "hammer-aflame-psychic": ["selected to fight", "enemy unit", "Engagement Range of this model's unit", "On 1: Nothing", "On 2-3", "On 4-5", "On 6", "D3+3"],
  "personal-teleporters": ["resolves its attacks", "shooting phase", "your turn", "not (the unit is within Engagement Range)", "not (the unit made an ingress move (including a Deep Strike setup) this turn)", 'Normal move of up to 6"', "if it does", "cannot charge", "end of the turn"],
  "indomitable-spirit-psychic": ["This model", "shoot and declare a charge", "Fell Back", "shoot in a turn in which it Advanced", "declare a charge in a turn in which it Advanced"],
  "righteous-persecution": ["shooting phase", "your turn", "just-finished shooting sequence", "MONSTER", "VEHICLE", "pinned", "Subtract 2", "Move", "-2 to Charge", "start of your next turn"],
  "sanctity-of-purpose": ["Unless the target unit", "objective marker", "re-roll a Wound roll of 1", "you can re-roll the Wound roll"],
  "sanctifying-ritual-psychic": ["end of the phase", "Command phase", "your turn", "objective marker you control", "Level of Control", "greater than yours"],
  "guidance-of-the-ancients-psychic": ["shooting phase", "just-finished shooting sequence", "friendly GREY KNIGHTS model", "+1 to Hit", "end of the phase"],
  "litanies-of-sanctity": ["start of the phase", "once per battle per model", "GREY KNIGHTS unit", "12 inches", "that is Battle-shocked", "no longer Battle-shocked"],
  "channelled-force": ["friendly unit is selected to fight", "GREY KNIGHTS", "Leadership test", "current Leadership or higher", "if passed", "select one", "melee weapons with [PSYCHIC]", "[SUSTAINED HITS 1]", "[LETHAL HITS]", "end of the phase"],
  "hallowed-ground": ["deployment zone is always", "start of each phase", "at least half", "opponent's deployment zone", 'within 6"', "PURIFIER SQUAD units", "continuously", "ranged attacks and the target is visible to the attacking model", "GREY KNIGHTS", "Hit rolls of 1", '"PURIFIER SQUAD" or', "wholly within", "instead"],
  "fury-of-titan": ["friendly unit is set up by Deep Strike", "end of the turn", "Hit roll of 1", "Wound roll of 1"],
  "searing-soulflame": ["enemy unit is selected", "Righteous Persecution", "friendly PURGATION SQUAD unit", "must make a Battle-shock", "-1"],
};
function nodes(value: Json): Json[] {
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
}
function modifiers(id: string, type: string): Json[] {
  return nodes(ability(id).effect).filter((n) => n.type === type).map((n) => n.modifier);
}

describe("Grey Knights fidelity worklist", () => {
  for (const [id, phrases] of Object.entries(contracts)) {
    it(`${id}: valid canonical structure and mechanically diagnostic English`, () => {
      const a = ability(id);
      expect(validate(a), JSON.stringify(validate.errors)).toBe(true);
      expect(lintCanonical(a.effect)).toEqual({ canonical: true, issues: [] });
      const text = describeAbility(a);
      for (const phrase of phrases) expect(text).toContain(phrase);
      expect(text).not.toMatch(/\?|NaN|Once Per Battle Special|Post Attack Debuff|Shoot and Scoot/);
      expect(a.community_notes).toBeUndefined();
    });
  }
  it("accounts for all 25, removes only the obsolete active ability and its references", () => {
    expect(Object.keys(contracts)).toHaveLength(23);
    expect(abilities.some((a) => a.ability_id === "wisdom-of-the-ancients-aura")).toBe(false);
    expect(units.every((u) => !(u.ability_ids ?? []).includes("wisdom-of-the-ancients-aura"))).toBe(true);
    expect(ability("prescient-redeployment")).toBeDefined(); // Explicit unresolved ledger, not called repaired.
  });
  it("Paladin eligibility is evaluated on member MODELS, never Attached-unit keywords", () => {
    const e = ability("attuned-onslaught-psychic").effect;
    expect(e.type).toBe("for-each-unit");
    expect(e.selector).toMatchObject({ target_kind: "model", member_of: "bearer-unit", keywords: ["PALADIN SQUAD"], owner: "friendly" });
    expect(e.effect).toMatchObject({ target: "unit", modifier: { stat: "D", value: 1, weapon_type: "melee" } });
    expect(ability("attuned-onslaught-psychic").trigger.event).toBe("end-of-charge-move");
  });
  it("Might modifies both of this MODEL's melee characteristics and consumes model usage", () => {
    const a = ability("might-of-titan-psychic");
    expect(a.effect.steps.map((e: Json) => [e.target, e.modifier.stat, e.modifier.value, e.modifier.weapon_type])).toEqual([["self", "A", 3, "melee"], ["self", "S", 3, "melee"]]);
    expect(a.usage).toEqual({ frequency: "n-per-battle", count: 1, per: "model" });
    expect(a.trigger.optional).toBe(true);
  });
  it("repair selection shares a per-target counter across bearers and binds BOTH effects", () => {
    const e = ability("blessing-of-the-omnissiah").effect.effect;
    expect(e.selector).toMatchObject({ max_count: 1, target_kind: "model", range_inches: 3, keywords: ["GREY KNIGHTS", "VEHICLE"], selection_limit: { count: 1, period: "turn" } });
    expect(e.effect.steps.map((s: Json) => s.type)).toEqual(["heal-wounds", "roll-modifier"]);
    expect(e.effect.steps.every((s: Json) => s.target === "unit")).toBe(true);
  });
  it("cost reductions and both repeated-use directions are explicit permissions", () => {
    const a = ability("warrior-strategist");
    expect(a.usage).toEqual({ frequency: "once-per-battle-round", per: "army" });
    expect(a.effect.modifier).toMatchObject({ operation: "decrease", amount: 1, applies_to: "triggering-stratagem-use" });
    expect(modifiers("guardians-of-the-machine", "stratagem-cost-modifier")[0]).toMatchObject({ operation: "decrease", amount: 1, stratagem: "heroic-intervention" });
    expect(modifiers("guardians-of-the-machine", "stratagem-targeting-permission")).toEqual(expect.arrayContaining([
      expect.objectContaining({ exception: "already-targeted-different-unit-this-phase", stratagem: "heroic-intervention" }),
      expect.objectContaining({ exception: "does-not-prevent-targeting-different-unit-this-phase", stratagem: "heroic-intervention" }),
    ]));
    expect(JSON.stringify(ability("guardians-of-the-machine"))).not.toContain("overwatch");
    expect(JSON.stringify([a, ability("guardians-of-the-machine")])).not.toContain("cp-refund");
  });
  it("Grand Master and Dreadknight both really reference Warrior Strategist", () => {
    for (const id of ["grand-master", "grand-master-in-nemesis-dreadknight"]) {
      expect(units.find((u) => u.id === id).ability_ids).toContain("warrior-strategist");
      expect(ability("warrior-strategist").unit_ids).toContain(id);
    }
    for (const d of detachments.filter((d) => d.detachment_rule_id)) {
      expect(abilities.some((a) => a.ability_id === d.detachment_rule_id)).toBe(true);
    }
  });
  it("Sanctuary is not accidentally conditional on leading, or a generic ranged modifier", () => {
    const a = ability("sanctuary-psychic");
    expect(nodes(a.effect).some((n) => n.type === "is-attached")).toBe(false);
    expect(modifiers("sanctuary-psychic", "ability-grant")[0].grant_type).toBe("stealth");
    expect(modifiers("sanctuary-psychic", "roll-modifier")[0].weapon_type).toBe("melee");
  });
  it("Hammer covers every face once, without a second gate or fabricated zero damage", () => {
    const table = nodes(ability("hammer-aflame-psychic")).find((n) => n.type === "dice-table");
    expect(table.outcomes.flatMap((o: Json) => o.results)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(table.outcomes.map((o: Json) => o.effect.modifier?.count ?? o.effect.type)).toEqual(["no-effect", 1, "D3", "D3+3"]);
  });
  it("a declined teleport move does NOT prohibit charging", () => {
    const a = ability("personal-teleporters");
    expect(a.effect.type).toBe("movement-modifier");
    expect(a.effect.after_move).toMatchObject({ type: "attack-restriction", target: "unit", modifier: { restriction: "no-charge" } });
    expect(a.effect.steps).toBeUndefined();
    expect(a.trigger.optional).toBe(true);
    expect(a.scope.duration).toBe("turn");
  });
  it("Leadership uses an actual test against CURRENT Leadership, not a hard-coded 6", () => {
    const e = ability("channelled-force").effect;
    expect(e).toMatchObject({ type: "dice-gated", dice: "2D6", threshold: "leadership", comparison: "gte", test: { kind: "leadership", subject: "unit" } });
    expect(e.on_success.type).toBe("choice");
    expect(e.on_success.options).toHaveLength(2);
    for (const option of e.on_success.options) expect(option).toMatchObject({ target: "unit", modifier: { weapon_type: "melee", weapon_keyword: "Psychic" } });
  });
  it("full rerolls are any-result, and the objective upgrade is mutually exclusive", () => {
    for (const m of modifiers("surge-of-wrath-psychic", "re-roll")) {
      expect(m.result_scope).toBe("any-result");
      expect(m.subset).toBeUndefined();
    }
    const e = ability("sanctity-of-purpose").effect;
    expect(e.steps).toHaveLength(2);
    expect(e.steps[0].condition).toEqual({ operator: "not", operands: [e.steps[1].condition] });
    expect(e.steps[1].condition.negated ?? false).toBe(false);
    expect(e.steps[0].effect.modifier.optional).toBe(false);
    expect(e.steps[1].effect.modifier.result_scope).toBe("any-result");
  });
  it("post-shooting selections bind the just-finished attack sequence, not earlier hits", () => {
    for (const id of ["righteous-persecution", "guidance-of-the-ancients-psychic"]) {
      const a = ability(id);
      expect(a.trigger.event).toBe("after-unit-resolves-attacks");
      expect(typeof a.trigger.binds_event_variable).toBe("string");
      const hit = nodes(a.effect).find((n) => n.type === "was-hit-by-attack");
      expect(JSON.stringify(hit)).toContain(a.trigger.binds_event_variable);
    }
    expect(ability("guidance-of-the-ancients-psychic").effect.applies.attacker_keywords).toEqual(["GREY KNIGHTS"]);
  });
  it("the pinning reaction distinguishes the selecting Purgation unit from its target", () => {
    const a = ability("searing-soulflame");
    expect(a.trigger).toMatchObject({ event: "ability-target-selected", subject: "enemy-unit", source_ability: { ability_id: "righteous-persecution", owner: "friendly", keywords: ["PURGATION SQUAD"] } });
    expect(a.effect).toMatchObject({ type: "battle-shock-test", target: "target", modifier: { roll_modifier: -1 } });
    expect(units.find((u) => u.id === "purgation-squad").ability_ids).toContain("righteous-persecution");
  });
  it("regional production is continuous/snapshotted as appropriate, independent of attack gates", () => {
    const m = ability("hallowed-ground").effect.modifier;
    expect(m.producer.additive_extensions[0]).toMatchObject({ kind: "unit-proximity", radius_inches: 6, activation: { event: "continuous" }, source_gate: { owner: "owner-army", unit_predicate: { keywords: ["PURIFIER SQUAD"] } } });
    expect(m.consumer.attack_condition.operator).toBe("or");
    expect(m.consumer.qualified_condition.operator).toBe("or");
    expect(m.producer.phase_extensions.map((e: Json) => e.control_gate.threshold)).toEqual([
      { comparison: "at-least", fraction: 0.5 }, { comparison: "at-least", fraction: 0.5 },
    ]);
    for (const extension of m.producer.phase_extensions) {
      expect(extension.activation).toMatchObject({ event: "phase-start", evaluation: "snapshot-once" });
      expect(extension.expiry).toEqual({ event: "phase-end" });
    }
    expect(JSON.stringify(m.producer)).not.toContain("start-of-turn");
    expect(nodes(m).some((n) => n.type === "objective-majority")).toBe(false);
  });
  it.each(["blessing-of-the-omnissiah", "righteous-persecution", "guidance-of-the-ancients-psychic", "hallowed-ground"])("%s does not silently flatten unresolved bindings into a damage buff", (id) => {
    const a = ability(id);
    // Test the typed wrapper independently of outer event/phase guards.
    const effect = id === "blessing-of-the-omnissiah" ? a.effect.effect : a.effect;
    const result = effectToBuffs(effect, { kind: "ability", abilityId: id, abilityKind: "unit" }, { phase: "shooting", attackerStationary: false });
    expect(result.applied).toEqual([]);
    expect(result.unsupported.some((u) => u.reason.includes("predicates are not resolved"))).toBe(true);
  });
});

describe("new fidelity grammar rejects misleading alternatives", () => {
  const invalid = (id: string, mutate: (a: Json) => void): void => {
    const a = structuredClone(ability(id)); mutate(a);
    expect(validate(a), JSON.stringify(a)).toBe(false);
  };
  it("rejects whole-unit member selection", () => invalid("attuned-onslaught-psychic", (a) => { a.effect.selector.target_kind = "unit"; }));
  it("rejects enemy models masquerading as bearer-unit members", () => invalid("attuned-onslaught-psychic", (a) => { a.effect.selector.owner = "enemy"; }));
  it("rejects fixed 6 or reversed comparison on an actual Leadership test", () => {
    invalid("channelled-force", (a) => { a.effect.threshold = 6; });
    invalid("channelled-force", (a) => { a.effect.comparison = "lte"; });
  });
  it("rejects reduction without an amount", () => invalid("warrior-strategist", (a) => { delete a.effect.modifier.amount; }));
  it("rejects a generic repeated-Stratagem permission without its named restriction", () => invalid("guardians-of-the-machine", (a) => { delete a.effect.steps[1].modifier.stratagem; }));
  it("rejects an unbound source-ability selection event", () => invalid("searing-soulflame", (a) => { delete a.trigger.source_ability; }));
  it("rejects a source-ability filter on an unrelated event", () => invalid("searing-soulflame", (a) => { a.trigger.event = "selected-to-fight"; }));
  it("rejects invented keys inside the closed source-ability filter", () => invalid("searing-soulflame", (a) => { a.trigger.source_ability.pinned = true; }));
  it("rejects zero-distance or non-continuous unit-region production", () => {
    invalid("hallowed-ground", (a) => { a.effect.modifier.producer.additive_extensions[0].radius_inches = 0; });
    invalid("hallowed-ground", (a) => { delete a.effect.modifier.producer.additive_extensions[0].activation; });
  });
  it("rejects individual attacker filters on a target-only designation", () => invalid("guidance-of-the-ancients-psychic", (a) => { a.effect.applies.to = "target"; }));
  it("rejects fake extra outcomes in no-effect", () => invalid("hammer-aflame-psychic", (a) => { a.effect.effect.outcomes[0].effect.amount = 0; }));
  it("checks source-ability references against the source faction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-fidelity-"));
    try {
      mkdirSync(join(dir, "enrichment/grey-knights"), { recursive: true });
      const broken = structuredClone(ability("searing-soulflame"));
      broken.trigger.source_ability.ability_id = "missing-source-ability";
      writeFileSync(join(dir, "enrichment/grey-knights/abilities.json"), JSON.stringify([broken]));
      const result = await checkReferentialIntegrity(dir);
      expect(result.failed).toBeGreaterThan(0);
      expect(JSON.stringify(result.errors)).toContain('source_ability \\"missing-source-ability');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Grey Knights selection cardinality", () => {
  for (const id of ["hammer-aflame-psychic", "righteous-persecution", "litanies-of-sanctity"]) {
    it(`${id} requires exactly one target once activated`, () => {
      const selector = (ability(id).effect as unknown as { selector: Record<string, unknown> }).selector;
      expect(selector).toMatchObject({ min_count: 1, max_count: 1 });
      expect(selector.count).toBeUndefined();
    });
  }
});
