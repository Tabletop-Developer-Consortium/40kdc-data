/**
 * Humanize an Ability-DSL / scoring `condition` into plain English.
 *
 * Shared by the ability-text CLI (`commands/translate.ts`) and the scoring-card
 * translator (`scoring.ts`). Output is **ASCII-only** with a fixed clause and
 * parameter order: it is pinned byte-for-byte across the TS and Rust ports by
 * the `conformance/scoring-translation` corpus, so any phrasing change here is a
 * semantic corpus change (bump `conformance/SPEC_VERSION`).
 */

/**
 * Minimal structural view of a condition node. Matches both the ability-dsl
 * condition schema and the `secondary-card` award `when` field (a simple node
 * carries `type` + `parameters` + `negated`; a compound node carries
 * `operator` + `operands`).
 */
export interface Condition {
  type?: string;
  operator?: "and" | "or" | "not";
  operands?: Condition[];
  parameters?: Record<string, unknown>;
  negated?: boolean;
}

/** kebab-case → space-separated words (`enemy-territory` → `enemy territory`). */
export function dekebab(s: string): string {
  return s.replace(/-/g, " ");
}

function str(v: unknown): string {
  if (v == null) return "?";
  return typeof v === "string" ? v : String(v);
}

/**
 * A `timing-is` event token → natural GW-voice clause ("each time a model in
 * this unit is destroyed", "at the start of the phase"). Structural phase/turn
 * markers and the common trigger families are mapped explicitly; the fallback
 * routes `after-*`/`on-*` prefixes to "after …"/"when …" (so the old "at on …"
 * double-preposition can't occur) and everything else to "at <event>".
 */
const TIMING_PHRASES: Record<string, string> = {
  "start-of-phase": "at the start of the phase",
  "end-of-phase": "at the end of the phase",
  "start-of-turn": "at the start of the turn",
  "end-of-turn": "at the end of the turn",
  "end-of-opponent-turn": "at the end of the opponent's turn",
  "start-of-battle-round": "at the start of the battle round",
  start: "at the start of the turn",
  end: "at the end of the turn",
  "command-phase": "in the Command phase",
  "shooting-phase": "in the Shooting phase",
  "on-model-destroyed": "each time a model in this unit is destroyed",
  "before-this-model-removed": "before removing this model from the battlefield",
  "model-destroyed": "each time a model in this unit is destroyed",
  "first-model-destroyed": "the first time a model in this unit is destroyed",
  "first-this-battle": "the first time this battle",
  "first-time-this-phase": "the first time this phase",
  "on-unit-destroyed": "each time this unit is destroyed",
  "on-destroyed": "each time this unit is destroyed",
  "enemy-unit-destroyed-in-melee": "each time an enemy unit is destroyed in melee",
  "in-reserves": "while it is in Reserves",
  "game-start-in-reserves": "if it begins the battle in Reserves",
  "starts-in-strategic-reserves": "if it starts in Strategic Reserves",
  "deep-strike-setup": "when it is set up by Deep Strike",
  "deep-strike": "when it is set up by Deep Strike",
  "set-up-from-reserves": "when it arrives from Reserves",
  "arrives-from-strategic-reserves": "when it arrives from Strategic Reserves",
  reinforcements: "when it arrives as Reinforcements",
  "reinforcements-step": "during the Reinforcements step",
  "post-deployment": "after deployment",
  "declare-battle-formations": "when declaring Battle Formations",
  "normal-move": "when it makes a Normal move",
  "advance-move": "when it makes an Advance move",
  advance: "when it Advances",
  "fall-back-move": "when it makes a Fall Back move",
  "fall-back": "when it Falls Back",
  "charge-move": "when it makes a Charge move",
  "once-per-battle": "once per battle",
  "once-per-phase": "once per phase",
  "once-per-opponent-turn": "once per opponent's turn",
};

export function describeTiming(timing: unknown): string {
  const t = str(timing);
  if (TIMING_PHRASES[t]) return TIMING_PHRASES[t];
  if (t.startsWith("after-")) return `after ${dekebab(t.slice(6))}`;
  if (t.startsWith("on-")) return `when ${dekebab(t.slice(3))}`;
  if (t.endsWith("-destroyed")) return `each time ${dekebab(t)}`;
  return `at ${dekebab(t)}`;
}

/** `2` + `objective` → `2+ objectives`. Nouns here are all regular plurals. */
function count(n: unknown, noun: string): string {
  return `${str(n)}+ ${noun}s`;
}

export function describeCondition(c: Condition): string {
  // Compound nodes first — join the operands with lowercase connectives so the
  // result reads naturally inside a "... when X and Y" clause.
  if (c.operator === "and" && c.operands) {
    return c.operands.map(describeCondition).join(" and ");
  }
  if (c.operator === "or" && c.operands) {
    return c.operands.map(describeCondition).join(" or ");
  }
  if (c.operator === "not" && c.operands) {
    return `not (${c.operands.map(describeCondition).join(", ")})`;
  }

  const negate = c.negated ? "not " : "";
  const p = c.parameters ?? {};

  switch (c.type) {
    // ── Ability-DSL conditions (ported from commands/translate.ts) ──────────
    case "phase-is":
      return `${negate}during the ${str(p.phase)} phase`;
    case "timing-is":
      return `${negate}${describeTiming(p.timing)}`;
    case "player-turn-is":
      return `${negate}in ${p.turn === "your-turn" ? "your" : p.turn === "opponent-turn" ? "the opponent's" : "either player's"} turn`;
    case "charged-this-turn":
      return `${negate}the unit charged this turn`;
    case "advanced-this-turn":
      return `${negate}the unit advanced this turn`;
    case "remained-stationary":
      return `${negate}the unit remained stationary`;
    case "unit-below-starting-strength":
      return `${negate}the unit is below starting strength`;
    case "unit-below-half-strength":
      return `${negate}the unit is below half strength`;
    case "unit-has-keyword":
      return `${negate}the unit has "${str(p.keyword)}"`;
    case "target-has-keyword":
      return `${negate}the target has "${str(p.keyword)}"`;
    case "model-is-leader":
      return `${negate}the model is leading a unit`;
    case "is-attached":
      return `${negate}attached to a ${p.keyword ? `${str(p.keyword)} ` : ""}unit`;
    case "attack-is-type":
      if (p.comparison === "strength-greater-than-toughness")
        return `${negate}when this attack's Strength is greater than the target's Toughness`;
      if (p.comparison != null) return `${negate}when ${dekebab(str(p.comparison))}`;
      return `${negate}for ${str(p.attack_type)} attacks`;
    case "is-battle-shocked":
      return `${negate}the unit is battle-shocked`;
    case "has-lost-wounds":
      return `${negate}the model has lost wounds`;
    case "wounds-remaining-at-or-below":
      return `${negate}the model has ${Number(p.threshold ?? 0)} or fewer wounds remaining`;
    case "was-hit-by-attack": {
      const subject = p.subject === "target" ? "the target" : "the unit";
      const atk = p.attack_type ? `${str(p.attack_type)} ` : "";
      const weapon = p.weapon_name ? ` by ${str(p.weapon_name)}` : "";
      const n = Number(p.count_min ?? 1);
      if (n > 1) return `${negate}${subject} was hit by ${n}+ ${atk}attacks${weapon} this phase`;
      return `${negate}${subject} was hit by ${atk === "" ? "an attack" : `a ${atk}attack`}${weapon} this phase`;
    }
    case "opponent-unit-within-range": {
      let where: string;
      if (p.weapon_name != null) where = `range of ${dekebab(str(p.weapon_name))}`;
      else if (p.range_multiplier != null) where = "half range of its ranged weapons";
      else if (p.range === "engagement") where = "engagement range";
      else where = `${str(p.range)}"`;
      return `${negate}an enemy unit is within ${where}`;
    }
    case "unit-within-range-of": {
      const tt = str(p.target_type ?? "target");
      // Targets that name a specific model, not a radius — no inches apply.
      if (tt === "closest-eligible") return `${negate}the target is the closest eligible target`;
      if (tt === "area-terrain") return `${negate}within an area terrain feature`;
      const who =
        tt === "friendly-keyword" && p.keyword
          ? `a friendly ${str(p.keyword)} unit`
          : tt === "friendly"
            ? "a friendly unit"
            : dekebab(tt);
      // A missing range stays as `?"` so the audit still flags it as a data gap.
      const dist = p.range != null ? `${str(p.range)}"` : '?"';
      return `${negate}within ${dist} of ${who}`;
    }
    case "within-range-of-objective":
      return `${negate}within range of an objective`;
    case "has-fought-this-phase":
      return `${negate}has fought this phase`;
    case "destroyed-by-attack-type":
      return `${negate}destroyed by a ${str(p.attack_type)} attack`;
    case "attack-stat-compare": {
      // Mirrors the Rust arm byte-for-byte: missing params render as "" (not "?").
      const sv = (v: unknown): string => (v == null ? "" : str(v));
      return `${negate}the attack's ${sv(p.attacker_stat)} is ${dekebab(sv(p.comparison))} the target's ${sv(p.target_stat)}`;
    }
    case "made-ingress-move-this-turn":
      return `${negate}the unit made an ingress move this turn`;

    // ── Scoring conditions (secondary-card award `when`) ────────────────────
    case "objective-majority":
      return `${negate}you hold more objectives than the ${dekebab(str(p.relative_to ?? "opponent"))}`;
    case "controls-objective": {
      const noun = p.objective_role ? `${dekebab(str(p.objective_role))} objective` : "objective";
      let s = `${negate}you control ${count(p.count_min ?? 1, noun)}`;
      if (p.objective != null) s += ` (${dekebab(str(p.objective))})`;
      if (p.scope != null) s += ` in ${dekebab(str(p.scope))}`;
      if (p.exclude != null) s += ` (excluding ${dekebab(str(p.exclude))})`;
      return s;
    }
    case "units-destroyed": {
      let s = `${negate}${count(p.count_min ?? 1, `${str(p.side)} unit`)} destroyed`;
      if (p.window != null) s += ` ${dekebab(str(p.window))}`;
      return s;
    }
    case "units-destroyed-comparison": {
      const subj = (p.subject ?? {}) as Record<string, unknown>;
      const ref = (p.reference ?? {}) as Record<string, unknown>;
      const cmp = p.comparator === "greater-or-equal" ? "at least as many" : "more";
      const link = p.comparator === "greater-or-equal" ? "as" : "than";
      return `${negate}you destroyed ${cmp} ${str(subj.side)} units ${dekebab(str(subj.window))} ${link} ${str(ref.side)} units ${dekebab(str(ref.window))}`;
    }
    case "new-objective-controlled":
      return `${negate}you newly control ${count(p.count_min ?? 1, "objective")} this turn`;
    case "destroyed-while-on-objective": {
      const obj = p.objective_role ? `a ${dekebab(str(p.objective_role))} objective` : "an objective";
      let s = `${negate}${count(p.count_min ?? 1, "enemy unit")} destroyed`;
      if (p.destroyer_on_objective) s += ` by a unit on ${obj}`;
      if (p.victim_on_objective) s += ` while on ${obj}`;
      if (p.victim_started_turn_on_objective) s += ` that started the turn on ${obj}`;
      return s;
    }
    case "destroyed-in-tagged-terrain": {
      const where = p.at_start_of_turn ? "that started the turn in" : "while in";
      const terrain = p.tag != null ? `${dekebab(str(p.tag))} terrain` : "a terrain area";
      return `${negate}${count(p.count_min ?? 1, "enemy unit")} destroyed ${where} ${terrain}`;
    }
    case "operation-markers": {
      const side = p.side != null ? `${str(p.side)} ` : "";
      const min = typeof p.count_min === "number" ? p.count_min : undefined;
      const max = typeof p.count_max === "number" ? p.count_max : undefined;
      let s: string;
      if (max === 0) {
        s = `no ${side}operation markers on the battlefield`;
      } else if (min != null && max != null && min === max) {
        s = `exactly ${min} ${side}operation marker${min === 1 ? "" : "s"} on the battlefield`;
      } else {
        s = `${str(min ?? 1)}+ ${side}operation markers on the battlefield`;
      }
      if (p.within_range_of != null) s += ` within range of ${dekebab(str(p.within_range_of))}`;
      if (p.friendly_unit_in_same_terrain_area) s += " with a friendly unit in the same terrain area";
      if (p.no_enemy_in_terrain_area) s += " and no enemy units in that terrain area";
      return `${negate}${s}`;
    }
    case "action-completed": {
      let s = `${negate}${count(p.count_min ?? 1, "action")} completed`;
      if (p.action_id != null) s += ` (${dekebab(str(p.action_id))})`;
      if (p.target_kind != null) s += ` on ${dekebab(str(p.target_kind))}`;
      const tf = (p.target_filter ?? {}) as Record<string, unknown>;
      if (tf.objective_role != null) s += ` (${dekebab(str(tf.objective_role))})`;
      if (tf.in_enemy_territory) s += " in enemy territory";
      if (tf.exclude != null) s += ` (excluding ${dekebab(str(tf.exclude))})`;
      if (p.window != null) s += ` ${dekebab(str(p.window))}`;
      return s;
    }
    case "objective-has-tag": {
      let s = `${negate}${count(p.count_min ?? 1, "objective")} tagged ${dekebab(str(p.tag))}`;
      if (p.count_max != null) s += ` (at most ${str(p.count_max)})`;
      if (p.objective != null) s += ` (${dekebab(str(p.objective))})`;
      if (p.scope != null) s += ` in ${dekebab(str(p.scope))}`;
      if (p.last_marked) s += " (most recently marked)";
      return s;
    }
    case "unit-has-tag": {
      // Ability-gate use (no side/count) reads as a unit state; scoring use counts tagged units.
      if (p.side == null && p.count_min == null)
        return `${negate}the unit is tagged ${dekebab(str(p.tag))}`;
      let s = `${negate}${count(p.count_min ?? 1, `${str(p.side)} unit`)} tagged ${dekebab(str(p.tag))}`;
      if (p.window != null) s += ` (${dekebab(str(p.window))})`;
      return s;
    }
    case "terrain-has-tag": {
      let s = `${negate}terrain tagged ${dekebab(str(p.tag))}`;
      if (p.friendly_units_min != null) s += ` with ${str(p.friendly_units_min)}+ friendly units`;
      if (p.enemy_units_max != null) s += ` and at most ${str(p.enemy_units_max)} enemy units`;
      if (p.last_marked) s += " (most recently marked)";
      if (p.in_enemy_dz) s += " in the enemy deployment zone";
      return s;
    }
    case "terrain-area-control":
      return `${negate}you control a terrain area with ${str(p.min_models ?? 1)}+ models`;
    case "territory-control": {
      let s = `${negate}you control ${dekebab(str(p.territory_ref ?? "your-territory"))}`;
      if (p.enemy_units_max != null) s += ` with at most ${str(p.enemy_units_max)} enemy units`;
      return s;
    }
    case "engagement-fronts":
      return `${negate}you are engaged on ${str(p.count_min ?? 1)}+ fronts`;

    default:
      return `${negate}${dekebab(c.type ?? "unknown")}`;
  }
}
