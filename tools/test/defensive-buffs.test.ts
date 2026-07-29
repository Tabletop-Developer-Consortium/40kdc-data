import { describe, expect, it } from "vitest";
import { Dataset } from "../src/data/dataset.js";
import { crunch, type EngineInput } from "../src/cruncher/index.js";

const ds = Dataset.embedded();

describe("Dataset.defensiveBuffsFor", () => {
  it("returns a list (possibly empty) without throwing for any unit", () => {
    const sample = ds.units.all.slice(0, 10);
    for (const u of sample) {
      expect(() => ds.defensiveBuffsFor({ unitId: u.id }, { phase: "shooting" })).not.toThrow();
    }
  });

  it("symmetric: same unit produces distinct buff stacks under each perspective", () => {
    // For a unit whose army rule is purely attacker-flavoured (Oath of Moment
    // — re-roll-hits + re-roll-wounds), the attacker walk yields reroll
    // buffs while the defensive walk drops them.
    const intercessor = ds.units.find("Intercessor Squad")!;
    const atk = ds.buffsFor(
      { unitId: intercessor.id, factionId: "adeptus-astartes" },
      { phase: "shooting" },
    );
    const def = ds.defensiveBuffsFor(
      { unitId: intercessor.id, factionId: "adeptus-astartes" },
      { phase: "shooting" },
    );
    const atkRerolls = atk.filter((b) => b.contribution.type === "reroll");
    const defRerolls = def.filter((b) => b.contribution.type === "reroll");
    expect(atkRerolls.length).toBeGreaterThan(0);
    expect(defRerolls.length).toBe(0);
  });

  it("weaponProfiles are ignored under target perspective", () => {
    // bolt-rifle's Heavy keyword would inject a hit-mod under attacker, but
    // defensiveBuffsFor's signature doesn't accept weaponProfiles — even if
    // a caller passes them inadvertently, the implementation omits them.
    const def = ds.defensiveBuffsFor(
      // The cast exercises the path: if a caller wedges weaponProfiles in,
      // the implementation should still ignore them under target perspective.
      {
        unitId: "intercessor-squad",
        factionId: "adeptus-astartes",
        ...({ weaponProfiles: [{ weaponId: "bolt-rifle", profileIndex: 0 }] } as object),
      },
      { phase: "shooting", attackerStationary: true },
    );
    const keywordBuffs = def.filter((b) => b.source.kind === "weapon-keyword");
    expect(keywordBuffs).toEqual([]);
  });
});

// Core rule 19.04 — "abilities that affect a single specified model only ever
// apply to that model, even while part of an attached unit". The buff layer
// treats `self`/`bearer` as model-scoped and drops such effects when they arrive
// from an attached member; `unit`-scoped leader rules still reach the squad.
describe("attached members: model-scoped vs unit-scoped abilities", () => {
  const invulns = (buffs: ReturnType<Dataset["defensiveBuffsFor"]>, abilityId: string) =>
    buffs.filter(
      (b) =>
        b.contribution.type === "invulnerable-save" &&
        b.source.kind === "ability" &&
        b.source.abilityId === abilityId,
    );

  it("a leader's personal invulnerable save does not buff its bodyguard unit", () => {
    // Shadowfield reads "the bearer has a 4+ invulnerable save" — one model out
    // of eleven, so it is not the Kabalite squad's invuln.
    const attached = ds.defensiveBuffsFor(
      { unitId: "kabalite-warriors", factionId: "drukhari", attachedUnitIds: ["archon"] },
      { phase: "shooting" },
    );
    expect(invulns(attached, "shadowfield")).toEqual([]);

    // …but the Archon crunched as itself keeps it (source kind "unit").
    const own = ds.defensiveBuffsFor(
      { unitId: "archon", factionId: "drukhari" },
      { phase: "shooting" },
    );
    expect(invulns(own, "shadowfield")).toHaveLength(1);
    expect(invulns(own, "shadowfield")[0].contribution).toEqual({
      type: "invulnerable-save",
      threshold: 4,
    });
  });

  it("a unit-scoped leader rule still buffs the whole attached unit", () => {
    // Mental Fortress reads "models in that unit have a 4+ invulnerable save" —
    // authored `target: "unit"`, so the gate must not touch it (issue #105's
    // repro, which is a legitimately unit-wide rule).
    const attached = ds.defensiveBuffsFor(
      { unitId: "intercessor-squad", factionId: "adeptus-astartes", attachedUnitIds: ["librarian"] },
      { phase: "fight" },
    );
    const buffs = invulns(attached, "mental-fortress-psychic");
    expect(buffs).toHaveLength(1);
    expect(buffs[0].source).toMatchObject({ abilityKind: "attached", sourceUnitId: "librarian" });
  });

  it("the dropped effect is reported as unsupported, not silently discarded", () => {
    const shadowfield = ds.abilities.getAny("shadowfield")!;
    const translated = shadowfield.describeBuffs(
      { kind: "ability", abilityId: "shadowfield", abilityKind: "attached", sourceUnitId: "archon" },
      { phase: "shooting" },
      "target",
    );
    expect(translated.applied).toEqual([]);
    expect(translated.unsupported.map((u) => u.reason)).toEqual([
      "model-scoped effect from an attached model: applies to that model only (core rule 19.04)",
    ]);
  });

  it("the gate is attacker-side too, and spares unit-scoped grants", () => {
    const keywordsFrom = (
      buffs: ReturnType<Dataset["buffsFor"]>,
      abilityId: string,
    ): string[] =>
      buffs
        .filter((b) => b.source.kind === "ability" && b.source.abilityId === abilityId)
        .flatMap((b) =>
          b.contribution.type === "extra-keyword" ? [b.contribution.keywordRef.keyword_id] : [],
        );

    // Psychic Gifts reads "the bearer has the Psyker keyword" — model-scoped, so
    // it must not ride an attached Inquisitor onto the squad it joined…
    const led = ds.buffsFor(
      {
        unitId: "inquisitorial-agents",
        factionId: "agents-of-the-imperium",
        attachedUnitIds: ["inquisitor"],
      },
      { phase: "command" },
    );
    expect(keywordsFrom(led, "psychic-gifts")).toEqual([]);
    // …while the Inquisitor crunched as itself still carries it.
    const alone = ds.buffsFor(
      { unitId: "inquisitor", factionId: "agents-of-the-imperium" },
      { phase: "command" },
    );
    expect(keywordsFrom(alone, "psychic-gifts")).toEqual(["psyker"]);

    // Surgical Precision is unit-scoped ("that unit's ranged weapons have
    // [LETHAL HITS]"), so an attached Apothecary Biologis still grants it.
    const aggressors = ds.buffsFor(
      {
        unitId: "aggressor-squad",
        factionId: "adeptus-astartes",
        attachedUnitIds: ["apothecary-biologis"],
      },
      { phase: "shooting" },
    );
    expect(keywordsFrom(aggressors, "surgical-precision")).toEqual(["lethal-hits"]);
  });
});

describe("end-to-end: defensive FNP buff plumbed through crunch", () => {
  it("FNP buff added manually to the engine input reduces damage", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    const target = ds.units.find("Cultist Mob")!;
    const base: EngineInput = {
      attacker: { weapon: bolt.raw, profileIndex: 0 },
      target: { unit: target.raw, profileIndex: 0 },
      modelsFiring: 5,
      buffs: [],
      context: { phase: "shooting" },
    };
    const baseline = crunch(base);
    const withFnp = crunch({
      ...base,
      // Defensive buff stack the SPA would compose via defensiveBuffsFor.
      buffs: [
        {
          source: { kind: "ability", abilityId: "fnp-test", abilityKind: "unit" },
          contribution: { type: "feel-no-pain", threshold: 5 },
        },
      ],
    });
    const baseAfterFnp = baseline.stages.find((s) => s.name === "after-fnp")!.expected;
    const fnpAfterFnp = withFnp.stages.find((s) => s.name === "after-fnp")!.expected;
    // FNP 5+: 1/3 chance of success → 2/3 damage remains.
    expect(fnpAfterFnp / baseAfterFnp).toBeCloseTo(4 / 6, 4);
  });

  it("damage-reduction buff trims damage per hit with a 'min 1' floor", () => {
    const lascannon = ds.weapons.getAny("lascannon")!; // D = D6+1 → EV 4.5
    const knight = ds.units.find("Questoris Knight Magaera")!;
    const base: EngineInput = {
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: knight.raw, profileIndex: 0 },
      modelsFiring: 1,
      buffs: [],
      context: { phase: "shooting", withinHalfRange: false },
    };
    const baseline = crunch(base);
    const reduced = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "dr-test", abilityKind: "unit" },
          contribution: { type: "damage-reduction", value: 1 },
        },
      ],
    });
    const baseDamage = baseline.stages.find((s) => s.name === "damage")!.expected;
    const reducedDamage = reduced.stages.find((s) => s.name === "damage")!.expected;
    // Per-hit damage drops from 4.5 to 3.5; ratio = 3.5/4.5.
    expect(reducedDamage / baseDamage).toBeCloseTo(3.5 / 4.5, 4);
  });

  it("damage-reduction floors at 1 even when reduction exceeds base damage", () => {
    // Bolt rifle: D 1. With damage-reduction 2, damage per hit must clamp to 1,
    // not -1 or 0 — the "min 1" rule from the canonical damage-reduction text.
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    const cultists = ds.units.find("Cultist Mob")!;
    const out = crunch({
      attacker: { weapon: bolt.raw, profileIndex: 0 },
      target: { unit: cultists.raw, profileIndex: 0 },
      modelsFiring: 1,
      buffs: [
        {
          source: { kind: "ability", abilityId: "dr-floor", abilityKind: "unit" },
          contribution: { type: "damage-reduction", value: 2 },
        },
      ],
      context: { phase: "shooting" },
    });
    // damage detail line announces "1 per hit" — the floor held.
    expect(out.stages.find((s) => s.name === "damage")!.detail).toContain("1 per hit");
  });

  it("damage-reduction does not stack: highest-wins across buffs", () => {
    const lascannon = ds.weapons.getAny("lascannon")!;
    const knight = ds.units.find("Questoris Knight Magaera")!;
    const base: EngineInput = {
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: knight.raw, profileIndex: 0 },
      modelsFiring: 1,
      buffs: [],
      context: { phase: "shooting" },
    };
    const single = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "dr-a", abilityKind: "unit" },
          contribution: { type: "damage-reduction", value: 1 },
        },
      ],
    });
    const stacked = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "dr-a", abilityKind: "unit" },
          contribution: { type: "damage-reduction", value: 1 },
        },
        {
          source: { kind: "ability", abilityId: "dr-b", abilityKind: "detachment" },
          contribution: { type: "damage-reduction", value: 1 },
        },
      ],
    });
    expect(stacked.stages.find((s) => s.name === "damage")!.expected).toBeCloseTo(
      single.stages.find((s) => s.name === "damage")!.expected,
      4,
    );
  });

  it("ability-granted invulnerable save beats AP and stays through cover", () => {
    // Lascannon AP-3 vs Cultists (Sv 6+, no printed invuln). Without an
    // invuln, the effective save is 9+ (always fails). Granting a 4+ invuln
    // pulls the effective save to 4+ — saves go from 0% to 50%.
    const lascannon = ds.weapons.getAny("lascannon")!;
    const cultists = ds.units.find("Cultist Mob")!;
    const base: EngineInput = {
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: cultists.raw, profileIndex: 0, modelCount: 10 },
      modelsFiring: 1,
      buffs: [],
      context: { phase: "shooting" },
    };
    const baseline = crunch(base);
    const withInvuln = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "invuln-test", abilityKind: "unit" },
          contribution: { type: "invulnerable-save", threshold: 4 },
        },
      ],
    });
    const baseUnsaved = baseline.stages.find((s) => s.name === "unsaved")!.expected;
    const invulnUnsaved = withInvuln.stages.find((s) => s.name === "unsaved")!.expected;
    // 4+ invuln saves half of wounds; unsaved should be roughly half.
    expect(invulnUnsaved / baseUnsaved).toBeCloseTo(0.5, 4);
  });

  it("best ability invuln wins; better printed invuln still preferred", () => {
    // Questoris Knight has a printed 5+ invuln. Granting a 4+ ability invuln
    // should improve to 4+; granting a 6+ should NOT degrade past 5+.
    const lascannon = ds.weapons.getAny("lascannon")!;
    const knight = ds.units.find("Questoris Knight Magaera")!;
    const base: EngineInput = {
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: knight.raw, profileIndex: 0 },
      modelsFiring: 1,
      buffs: [],
      context: { phase: "shooting" },
    };
    const better = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "i-better", abilityKind: "unit" },
          contribution: { type: "invulnerable-save", threshold: 4 },
        },
      ],
    });
    const worse = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "i-worse", abilityKind: "unit" },
          contribution: { type: "invulnerable-save", threshold: 6 },
        },
      ],
    });
    expect(better.stages.find((s) => s.name === "unsaved")!.detail).toContain(
      "invuln 4+ (ability)",
    );
    // The 6+ ability invuln is worse than the printed 5+, so the effective
    // save target shouldn't have moved past 5+. The Knight Sv3 - AP3 = 6+
    // armor branch would have been the active save in the no-buff case; the
    // printed 5+ invuln still drives the effective save here.
    expect(worse.stages.find((s) => s.name === "unsaved")!.detail).toContain("effective 5+");
  });

  it("mortal-scoped FNP fires only on the mortal-wound stream", () => {
    // Lascannon + manual devastating-wounds keyword → ~11% of wounds are
    // mortal. A 4+ mortal-FNP should halve those mortals; the main stream is
    // untouched (no all-FNP in play).
    const lascannon = ds.weapons.getAny("lascannon")!;
    const cultists = ds.units.find("Cultist Mob")!;
    const baseBuffs = [
      {
        source: { kind: "manual" as const, label: "Devastating Wounds (test)" },
        contribution: {
          type: "extra-keyword" as const,
          keywordRef: { keyword_id: "devastating-wounds" },
        },
      },
    ];
    const baseline = crunch({
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: cultists.raw, profileIndex: 0, modelCount: 10 },
      modelsFiring: 1,
      buffs: baseBuffs,
      context: { phase: "shooting" },
    });
    const withMortalFnp = crunch({
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: cultists.raw, profileIndex: 0, modelCount: 10 },
      modelsFiring: 1,
      buffs: [
        ...baseBuffs,
        {
          source: { kind: "ability" as const, abilityId: "fnp-m", abilityKind: "unit" as const },
          contribution: {
            type: "feel-no-pain" as const,
            threshold: 4,
            scope: "mortal" as const,
          },
        },
      ],
      context: { phase: "shooting" },
    });
    // Detail line for the FNP stage names the mortal-scope.
    expect(withMortalFnp.stages.find((s) => s.name === "after-fnp")!.detail).toContain(
      "vs mortals",
    );
    // The mortal stream is 20% of damage (0.5 of 2.5); halving it with a 4+
    // mortal FNP shaves exactly 10% off the total.
    const ratio =
      withMortalFnp.stages.find((s) => s.name === "after-fnp")!.expected /
      baseline.stages.find((s) => s.name === "after-fnp")!.expected;
    expect(ratio).toBeCloseTo(0.9, 4);
  });

  it("FNP-mortal stacks with FNP-all (independent rolls)", () => {
    // Two FNP buffs at different scopes fire against the mortal stream
    // independently: surviving fraction = (1 - pAll) * (1 - pMortal).
    const lascannon = ds.weapons.getAny("lascannon")!;
    const cultists = ds.units.find("Cultist Mob")!;
    const out = crunch({
      attacker: { weapon: lascannon.raw, profileIndex: 0 },
      target: { unit: cultists.raw, profileIndex: 0, modelCount: 10 },
      modelsFiring: 1,
      buffs: [
        {
          source: { kind: "manual", label: "Devastating Wounds (test)" },
          contribution: {
            type: "extra-keyword",
            keywordRef: { keyword_id: "devastating-wounds" },
          },
        },
        {
          source: { kind: "ability", abilityId: "fnp-all", abilityKind: "unit" },
          contribution: { type: "feel-no-pain", threshold: 5 },
        },
        {
          source: { kind: "ability", abilityId: "fnp-m", abilityKind: "unit" },
          contribution: { type: "feel-no-pain", threshold: 4, scope: "mortal" },
        },
      ],
      context: { phase: "shooting" },
    });
    // Detail line mentions both — sanity check the labelling.
    const detail = out.stages.find((s) => s.name === "after-fnp")!.detail;
    expect(detail).toContain("FNP 5+");
    expect(detail).toContain("FNP 4+ vs mortals");
  });

  it("toughness-mod buff hardens the target (wound threshold shifts)", () => {
    const bolt = ds.weapons.getAny("bolt-rifle")!;
    const target = ds.units.find("Cultist Mob")!; // T3
    const base: EngineInput = {
      attacker: { weapon: bolt.raw, profileIndex: 0 },
      target: { unit: target.raw, profileIndex: 0 },
      modelsFiring: 5,
      buffs: [],
      context: { phase: "shooting" },
    };
    const baseline = crunch(base);
    const tougher = crunch({
      ...base,
      buffs: [
        {
          source: { kind: "ability", abilityId: "t-buff", abilityKind: "unit" },
          contribution: { type: "toughness-mod", value: 1 }, // T3 → T4
        },
      ],
    });
    const baseWounds = baseline.stages.find((s) => s.name === "wounds")!.expected;
    const toughWounds = tougher.stages.find((s) => s.name === "wounds")!.expected;
    // S4 vs T3 = 3+; S4 vs T4 = 4+. So P drops from 4/6 → 3/6 = ratio 3/4.
    expect(toughWounds / baseWounds).toBeCloseTo(3 / 4, 4);
  });
});
