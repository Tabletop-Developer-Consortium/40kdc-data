/**
 * Humanize an Ability-DSL `effect` tree into natural English — the
 * `ability.print()` of the dataset. Output is an *approximation* generated
 * purely from the structured data (no external rules text): subject-first,
 * GW-datasheet voice, with scope range + duration woven into the sentence and
 * single-leaf conditionals inlined. ASCII-only. It is pinned byte-for-byte
 * across the TS / Rust / Python ports by the `conformance/effect-translation`
 * corpus, so any phrasing change here is a semantic corpus change (bump
 * `conformance/SPEC_VERSION`).
 *
 * Container nodes (`sequence`, `choice`, `dice-gated`, `dice-pool-allocation`,
 * and a `conditional` wrapping a container) render block-style with two-space
 * indentation; a `conditional` wrapping a single leaf inlines to one sentence.
 * Unknown leaf types degrade to a deterministic bracketed form (`[the-type]`).
 */

import { describeCondition, describeTiming, eventClause, dekebab, type Condition } from "./condition.js";

/**
 * Minimal structural view of an effect node. Matches the ability-dsl effect
 * schema: a single effect carries `type` + `target` + `modifier`; containers
 * carry their own shape (`steps`, `options`, `condition`/`effect`, dice
 * fields).
 */
export interface Effect {
  type?: string;
  target?: string;
  modifier?: Record<string, unknown>;
  condition?: Condition;
  effect?: Effect;
  steps?: Effect[];
  options?: (Effect & {
    name?: string;
    requirement?: Record<string, unknown>;
  })[];
  choice_label?: string;
  dice?: string;
  threshold?: number | string;
  comparison?: string;
  on_success?: Effect | null;
  on_fail?: Effect | null;
  pool?: { count: number; die: string };
  max_activations?: number;
  selector?: { max_count?: number; keywords?: string[]; owner?: string };
  scaling?: {
    per?: number;
    of?: string;
    within_inches?: number;
    round?: string;
    max_value?: number;
  };
}

/** Ability scope, as carried on enrichment ability entries. */
export interface AbilityScope {
  range?: string;
  duration?: string;
  range_inches?: number;
}

/** Curated keyword filter naming which units an ability benefits. */
export interface AbilityAppliesTo {
  required_keywords?: string[];
  excluded_keywords?: string[];
}

/** Usage-limit block (how often the ability may be used). */
export interface AbilityUsage {
  frequency?: string;
  count?: number;
  per?: string;
}

/** Reactive-trigger block: the event the ability fires on + structured guards. */
export interface AbilityTrigger {
  event?: string;
  subject?: string;
  proximity?: { of?: string; range?: number };
  condition?: Condition;
  optional?: boolean;
  cost?: { cp?: number };
  window?: string;
}

/** Minimal ability view for `describeAbility`. */
export interface AbilityLike {
  name?: string;
  effect?: Effect;
  scope?: AbilityScope;
  trigger?: AbilityTrigger | null;
  usage?: AbilityUsage | null;
  applies_to?: AbilityAppliesTo | null;
}

/** Rendering context threaded down from the ability (scope info the leaf needs). */
interface Ctx {
  /** Aura/blast radius in inches, for `*-within-aura` targets and within-range effects. */
  rangeInches?: number;
  /** True when the ability scope is `engagement-range`, so within-aura subjects read "within Engagement Range". */
  engagementRange?: boolean;
}

const CONTAINER_TYPES = new Set([
  "sequence",
  "choice",
  "dice-gated",
  "dice-pool-allocation",
  "select-units",
]);

/** "up to 3 friendly Orks Vehicle units" — the `select-units` selector phrase. */
function selectUnitsSubject(sel: Record<string, unknown> = {}): string {
  const kw = ((sel.keywords as unknown[]) ?? []).map((k) => titleCase(jstr(k))).join(" ");
  const noun = sel.max_count === 1 ? "unit" : "units";
  return `up to ${jstr(sel.max_count)} ${jstr(sel.owner)}${kw ? ` ${kw}` : ""} ${noun}`;
}

/** JS-template stringification (numbers print without trailing `.0`). */
function jstr(v: unknown): string {
  if (v == null) return "?";
  if (Array.isArray(v)) return v.map(jstr).join(", ");
  return String(v);
}

/** Uppercase the first character (idempotent; leaves the rest untouched). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Small words kept lowercase mid-phrase in Title Case (`Benefit of Cover`, not `Benefit Of Cover`). */
const TITLE_SMALL = new Set(["of", "or", "and", "the", "a", "an", "to", "in", "on", "for", "with"]);

/**
 * Curated display labels for granted-ability ids whose Title-Cased slug reads
 * wrong. The slug encodes the mechanic (`charge-after-advance`); the label is
 * the published name players know (`Advance & Charge`). Applied only to the
 * ability-grant describer — keyed on the resolved grant (`grant_type ??
 * ability_id`); ids absent here fall back to {@link titleCase}.
 */
const ABILITY_GRANT_LABELS: Record<string, string> = {
  "charge-after-advance": "Advance & Charge",
  "charge-after-fallback": "Fall Back & Charge",
  "charge-after-disembark": "Charge After Disembarking",
};

/** The display label for a granted ability id: a curated override, else Title Case. */
function grantLabel(id: string): string {
  return ABILITY_GRANT_LABELS[id] ?? titleCase(id);
}

/** kebab/space token → Title Case (`deep-strike` → `Deep Strike`, `shoot-and-scoot` → `Shoot and Scoot`). */
function titleCase(s: string): string {
  return dekebab(s)
    .split(" ")
    .map((w, i) => {
      if (w.length === 0) return w;
      if (i > 0 && TITLE_SMALL.has(w.toLowerCase())) return w.toLowerCase();
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * A GW weapon keyword token → bracketed caps (`lethal-hits` → `[LETHAL HITS]`).
 * Anti-X keywords keep their hyphen and normalize the threshold to `N+`
 * (`anti-titanic-3plus` / `anti-monster 4+` → `[ANTI-TITANIC 3+]` / `[ANTI-MONSTER 4+]`).
 */
function bracketKeyword(k: unknown): string {
  const raw = jstr(k).trim();
  const anti = /^anti[\s-]+(.*)$/i.exec(raw);
  if (anti) {
    const m = /^(.*?)[\s-]*(\d+)\s*(?:\+|plus)?$/i.exec(anti[1]);
    if (m) return `[ANTI-${dekebab(m[1]).trim().toUpperCase()} ${m[2]}+]`;
    return `[ANTI-${dekebab(anti[1]).trim().toUpperCase()}]`;
  }
  return `[${dekebab(raw).toUpperCase()}]`;
}

/** Dice tokens print with a capital `D` (`d3` → `D3`, `2d6` → `2D6`). */
function diceCase(v: unknown): string {
  return jstr(v).replace(/d/gi, "D");
}

/** A leadership/escape test token → GW name (`battle-shock` → `Battle-shock`). */
const TEST_NAMES: Record<string, string> = {
  "battle-shock": "Battle-shock",
  "desperate-escape": "Desperate Escape",
};
function testName(test: unknown): string {
  const t = jstr(test);
  return TEST_NAMES[t] ?? titleCase(t);
}

/** Does a subject noun phrase take a plural verb? (`enemy units within 6"`, `all friendly units`). */
function isPlural(subj: string): boolean {
  return / units\b/.test(subj) || /^all /.test(subj) || /^(enemy|friendly) units/.test(subj);
}

/** Subject-verb agreement: pick the plural form of a present-tense verb when the subject is plural. */
const PLURAL_VERBS: Record<string, string> = {
  has: "have",
  is: "are",
  gets: "get",
  gains: "gain",
  suffers: "suffer",
  retains: "retain",
  makes: "make",
  passes: "pass",
  fails: "fail",
  treats: "treat",
};
function v(subj: string, singular: string): string {
  if (!isPlural(subj)) return singular;
  return PLURAL_VERBS[singular] ?? singular.replace(/s$/, "");
}

/** Full characteristic name for a stat token (`Sv` → `Save`). */
const STAT_NAMES: Record<string, string> = {
  M: "Move",
  T: "Toughness",
  Sv: "Save",
  W: "Wounds",
  A: "Attacks",
  Ld: "Leadership",
  OC: "Objective Control",
  S: "Strength",
  WS: "Weapon Skill",
  BS: "Ballistic Skill",
  AP: "Armour Penetration",
  D: "Damage",
  Range: "Range",
};

function statName(stat: unknown): string {
  const s = jstr(stat);
  return STAT_NAMES[s] ?? titleCase(s);
}

/** Resource-pool token → display name (`cp` → `CP`, otherwise Title Case). */
function poolName(pool: unknown): string {
  const p = jstr(pool);
  return p.toLowerCase() === "cp" ? "CP" : titleCase(p);
}

/** Roll noun for a roll token (`hit` → `Hit`, `attacks-characteristic` → `Attacks characteristic`). */
const ROLL_NAMES: Record<string, string> = {
  hit: "Hit",
  wound: "Wound",
  charge: "Charge",
  damage: "Damage",
  advance: "Advance",
  save: "Saving throw",
  leadership: "Leadership",
};

function rollName(roll: unknown): string {
  const r = jstr(roll);
  return ROLL_NAMES[r] ?? titleCase(r);
}

/** `+1` / `-1` from an operation + value (a negative value flips the sign, so never `+-1`). */
function signed(operation: unknown, value: unknown): string {
  const positive = operation === "add" || operation === "improve";
  let sign = positive ? 1 : -1;
  const n = Number(value);
  if (!Number.isNaN(n) && n < 0) {
    sign = -sign;
    value = Math.abs(n);
  }
  return `${sign > 0 ? "+" : "-"}${jstr(value)}`;
}

/**
 * Dice-pool success phrase → "4+", "6", "3 or less", etc. (for the per-die
 * threshold in a `mortal-wounds` dice pool — "for each 4+, …"). Unlike
 * {@link formatComparison} this carries no leading "a", because it follows
 * "for each".
 */
function poolThreshold(comp: string, threshold: unknown): string {
  const th = jstr(threshold);
  switch (comp) {
    case "lte":
      return `${th} or less`;
    case "gt":
      return `more than ${th}`;
    case "lt":
      return `less than ${th}`;
    case "eq":
      return th;
    default: // gte
      return `${th}+`;
  }
}

/** Dice comparison → "a 4+", "a 3 or less", etc. (for dice-gated thresholds). */
function formatComparison(comp: string, threshold: unknown): string {
  const th = jstr(threshold);
  switch (comp) {
    case "gte":
      return `a ${th}+`;
    case "lte":
      return `a ${th} or less`;
    case "gt":
      return `greater than ${th}`;
    case "lt":
      return `less than ${th}`;
    case "eq":
      return `exactly ${th}`;
    default:
      return `a ${th}+`;
  }
}

/**
 * Humanized subject for an effect `target`. Aura targets resolve their radius
 * from the ability scope (threaded via {@link Ctx}); everything else is a fixed
 * noun phrase in GW datasheet voice.
 */
function subject(target: string | undefined, ctx: Ctx): string {
  const within =
    ctx.rangeInches != null
      ? ` within ${jstr(ctx.rangeInches)}"`
      : ctx.engagementRange
        ? " within Engagement Range"
        : " nearby";
  switch (target) {
    case "self":
    case "bearer":
      return "this model";
    case "unit":
      return "the unit";
    case "attached-unit":
      return "the unit this model leads";
    case "target":
      return "the target";
    case "attacker":
      return "the attacking unit";
    case "defender":
      return "your unit";
    case "all-friendly":
      return "all friendly units";
    case "all-enemy":
      return "all enemy units";
    case "friendly-within-aura":
      return `friendly units${within}`;
    case "enemy-within-aura":
      return `enemy units${within}`;
    default:
      return "the unit";
  }
}

/** Possessive form of a subject noun phrase (`the unit` → `the unit's`). */
function possessive(s: string): string {
  return s.endsWith("s") ? `${s}'` : `${s}'s`;
}

/** Possessive pronoun agreeing with the subject (`its` / `their`). */
function pronoun(subj: string): string {
  return isPlural(subj) ? "their" : "its";
}

/**
 * Duration → woven clause. `lead` sits at the very front of the sentence
 * ("Once per battle, …"); `trail` sits after the trigger/condition and before
 * the effect ("…, until the end of the phase, …"). `permanent` adds nothing.
 */
function durationClauses(duration: string | undefined): { lead: string; trail: string } {
  switch (duration) {
    case "phase":
      return { lead: "", trail: "until the end of the phase" };
    case "turn":
      return { lead: "", trail: "until the end of the turn" };
    case "battle":
      return { lead: "", trail: "for the rest of the battle" };
    case "battle-round":
      return { lead: "", trail: "until the end of the battle round" };
    case "until-next-command-phase":
      return { lead: "", trail: "until your next Command phase" };
    case "one-use":
      return { lead: "once per battle", trail: "" };
    default: // permanent / absent
      return { lead: "", trail: "" };
  }
}

/** Reactive trigger → front-of-sentence lead clause ("an enemy unit ends a move within 9\" of this model"). */
function describeTrigger(t: AbilityTrigger): string {
  let s = eventClause(t.event);
  if (t.proximity?.range != null) {
    const of =
      t.proximity.of === "attached-unit"
        ? "the unit this model leads"
        : t.proximity.of === "self" || t.proximity.of === "bearer"
          ? "this model"
          : "this unit";
    s += ` within ${jstr(t.proximity.range)}" of ${of}`;
  }
  if (t.condition) s += `, if ${describeCondition(t.condition)}`;
  return s;
}

/** Usage limit → front-of-sentence lead clause ("once per turn", "twice per battle per unit"). */
function usageClause(u: AbilityUsage): string {
  const n = Number(u.count ?? 1);
  let base: string;
  switch (u.frequency) {
    case "once-per-turn":
      base = "once per turn";
      break;
    case "once-per-phase":
      base = "once per phase";
      break;
    case "once-per-command-phase":
      base = "once per Command phase";
      break;
    case "once-per-opponent-turn":
      base = "once per opponent's turn";
      break;
    case "first-this-battle":
      base = "the first time this battle";
      break;
    case "first-time-this-phase":
      base = "the first time this phase";
      break;
    case "n-per-battle":
      base = n === 1 ? "once per battle" : n === 2 ? "twice per battle" : `${jstr(n)} times per battle`;
      break;
    default:
      base = dekebab(jstr(u.frequency));
  }
  return u.per != null ? `${base} per ${jstr(u.per)}` : base;
}

/** "against a unit that is not a Monster or Vehicle" from a run of excluded target keywords. */
function negatedTargetKeywords(keywords: string[]): string {
  return `against a unit that is not a ${keywords.join(" or ")}`;
}

/** Capitalize the first character and lowercase the rest (`MONSTER` -> `Monster`). */
function capWord(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * The keyword of a `not`-wrapping-a-single-`target-has-keyword` operand, else
 * `null`. This is the aura-subject exclusion encoding (`not[target-has-keyword X]`),
 * distinct from the bare `{negated:true, type:"target-has-keyword"}` form.
 */
function notWrappedTargetKeyword(op: Condition): string | null {
  if (op.operator !== "not" || !op.operands || op.operands.length !== 1) return null;
  const inner = op.operands[0];
  if (inner.type !== "target-has-keyword" || inner.negated) return null;
  return jstr((inner.parameters ?? {}).keyword);
}

/** "(excluding Monster or Vehicle units)" from a run of `not`-wrapped target-keyword exclusions. */
function excludedTargetKeywords(keywords: string[]): string {
  return `(excluding ${keywords.map(capWord).join(" or ")} units)`;
}

/**
 * Join the operands of an `and` lead-in. Two exclusion encodings collapse into a
 * single clause: a run of bare-negated `target-has-keyword` becomes "against a
 * unit that is not a X or Y" (attack-context voice), and a run of `not`-wrapped
 * `target-has-keyword` becomes "(excluding X or Y units)" (aura-subject voice,
 * matching the `applies_to` "(excluding …)" idiom). Either collapsed clause
 * attaches to the preceding clause with a space; all other operands join with ", ".
 */
function joinAndLeadIns(operands: Condition[]): string {
  const parts: string[] = [];
  for (let i = 0; i < operands.length; ) {
    const op = operands[i];
    if (op.negated && op.type === "target-has-keyword") {
      const kws: string[] = [];
      while (i < operands.length && operands[i].negated && operands[i].type === "target-has-keyword") {
        kws.push(jstr((operands[i].parameters ?? {}).keyword));
        i++;
      }
      parts.push(negatedTargetKeywords(kws));
      continue;
    }
    if (notWrappedTargetKeyword(op) != null) {
      const kws: string[] = [];
      let kw: string | null;
      while (i < operands.length && (kw = notWrappedTargetKeyword(operands[i])) != null) {
        kws.push(kw);
        i++;
      }
      parts.push(excludedTargetKeywords(kws));
      continue;
    }
    parts.push(conditionLeadIn(op));
    i++;
  }
  return parts.reduce(
    (acc, part) =>
      acc === ""
        ? part
        : part.startsWith("against ") || part.startsWith("(excluding ")
          ? `${acc} ${part}`
          : `${acc}, ${part}`,
    ""
  );
}

/**
 * A condition rendered as a natural lead-in clause (lowercase-initial — the
 * caller capitalizes at the sentence boundary). Falls back to `if <condition>`
 * for shapes without a dedicated framing.
 */
function conditionLeadIn(c: Condition): string {
  // Compound nodes recurse so each part reads in its natural framing.
  if (c.operator === "and" && c.operands) return joinAndLeadIns(c.operands);
  if (c.operator === "or" && c.operands) return c.operands.map(conditionLeadIn).join(" or ");
  if (c.operator === "not" && c.operands)
    return `unless ${c.operands.map((o) => conditionLeadIn(o).replace(/^if /, "")).join(" or ")}`;
  // Negated keyword gates read as an exclusion clause, not the generic "if not …".
  if (c.negated && c.type === "target-has-keyword")
    return negatedTargetKeywords([jstr((c.parameters ?? {}).keyword)]);
  if (c.negated && c.type === "unit-has-keyword")
    return `unless the unit has the ${jstr((c.parameters ?? {}).keyword)} keyword`;
  if (c.negated) return `if ${describeCondition(c)}`;

  const p = c.parameters ?? {};
  switch (c.type) {
    case "phase-is":
      return `during the ${titleCase(jstr(p.phase))} phase`;
    case "is-attached":
      return `after being attached to a ${p.keyword ? `${jstr(p.keyword)} ` : ""}unit`;
    case "timing-is":
      return describeTiming(p.timing);
    case "player-turn-is":
      return p.turn === "your-turn"
        ? "in your turn"
        : p.turn === "opponent-turn"
          ? "in the opponent's turn"
          : "in either player's turn";
    case "model-is-leader":
      return "while this model leads a unit";
    case "charged-this-turn":
      return "if the unit charged this turn";
    case "advanced-this-turn":
      return "if the unit Advanced this turn";
    case "disembarked-from-transport":
      return "if the unit disembarked from a Transport this turn";
    case "faction-rule-active":
      return `while the ${titleCase(jstr(p.rule))} is active`;
    case "battle-round":
      return `during the first ${jstr(p.max)} battle rounds`;
    case "remained-stationary":
      return "if the unit Remained Stationary";
    case "target-has-keyword":
      return `against ${jstr(p.keyword)} targets`;
    case "unit-has-keyword":
      return `if the unit has the ${jstr(p.keyword)} keyword`;
    case "is-battle-shocked":
      return "while the unit is Battle-shocked";
    case "unit-below-half-strength":
      return p.subject === "target"
        ? "while the target unit is below half strength"
        : "while the unit is below half strength";
    case "unit-below-starting-strength":
      return "while the unit is below its starting strength";
    case "has-lost-wounds":
      return "while the model has lost wounds";
    case "attack-is-type":
      if (p.comparison === "strength-greater-than-toughness")
        return "when this attack's Strength is greater than the target's Toughness";
      if (p.comparison != null) return `when ${dekebab(jstr(p.comparison))}`;
      return `while making ${jstr(p.attack_type)} attacks`;
    case "destroyed-by-attack-type":
      return `when destroyed by a ${jstr(p.attack_type)} attack`;
    case "opponent-unit-within-range": {
      let where: string;
      if (p.weapon_name != null) where = `range of ${dekebab(jstr(p.weapon_name))}`;
      else if (p.range_multiplier != null) where = "half range of its ranged weapons";
      else where = p.range === "engagement" ? "engagement range" : `${jstr(p.range)}"`;
      return `while an enemy unit is within ${where}`;
    }
    case "engagement-state": {
      if (p.state == null) return "while the unit is within Engagement Range";
      const st = jstr(p.state);
      if (st === "on-battlefield") return "while the unit is on the battlefield";
      if (st === "embarked") return "while the unit is embarked";
      if (st === "engaged" || st === "within-engagement-range" || st === "in-engagement-range")
        return "while the unit is within Engagement Range";
      if (st === "not-in-engagement-range" || st === "not-within-engagement-range")
        return "while the unit is not within Engagement Range";
      return `while the unit is ${dekebab(st)}`;
    }
    case "disposition-matches": {
      const d = jstr(p.disposition);
      if (d === "strategic-reserves") return "while the unit is in Strategic Reserves";
      return `while the unit's disposition is ${dekebab(d)}`;
    }
    case "fights-first":
      return "while the unit has the Fights First ability";
    default:
      return `if ${describeCondition(c)}`;
  }
}

/** Humanized noun for a scaling `of` dimension (`enemy-models-in-range` → `enemy models`). */
const SCALE_OF: Record<string, string> = {
  "enemy-models-in-range": "enemy models",
  "friendly-models-in-range": "friendly models",
  "models-in-bearer-unit": "models in this unit",
  "enemy-units-in-range": "enemy units",
  "wounds-lost": "wounds lost",
};

/** A `scaling` block → trailing clause ("for every 5 enemy models within 6\""). */
function scalingClause(s: NonNullable<Effect["scaling"]>): string {
  const ofText = SCALE_OF[jstr(s.of)] ?? dekebab(jstr(s.of));
  let c = `for every ${jstr(s.per)} ${ofText}`;
  if (s.within_inches != null) c += ` within ${jstr(s.within_inches)}"`;
  if (s.round === "up") c += " (rounding up)";
  if (s.max_value != null) c += ` (to a maximum of ${jstr(s.max_value)})`;
  return c;
}

/** Movement-modifier passthrough enum → human phrase. */
const PASSTHROUGH_PHRASE: Record<string, string> = {
  "non-titanic-models": "non-Titanic models",
  "friendly-vehicles": "friendly Vehicle models",
  "friendly-monsters": "friendly Monster models",
  "terrain-le-4": 'terrain features 4" or lower',
  "tall-terrain": 'terrain features over 4"',
  "all-terrain": "terrain features",
};

/** Move-kind token → display noun (for `applies_to_moves`). */
const MOVE_NOUN: Record<string, string> = {
  normal: "Normal",
  advance: "Advance",
  "fall-back": "Fall Back",
  charge: "Charge",
};

/** Oxford-free conjunction list ("a", "a and b", "a, b and c"). */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Trailing inches clause for a movement distance (int or dice string); "" when absent/zero. */
function inchClause(dist: unknown): string {
  if (dist == null) return "";
  const s = diceCase(jstr(dist));
  return s === "0" ? "" : ` ${s}"`;
}

/** Closed movement-modifier `modifier` → one lowercase-initial clause. */
function movementClause(m: Record<string, unknown>, subj: string): string {
  const kind = m.move_type as string | undefined;
  const dist = m.distance;
  const inches = inchClause(dist);
  const ofUpTo = inches ? ` of up to${inches}` : "";
  const moveKinds = Array.isArray(m.applies_to_moves)
    ? andList((m.applies_to_moves as string[]).map((x) => MOVE_NOUN[x] ?? dekebab(x)))
    : null;

  // Pure traversal capability (no move kind): passthrough / vertical / ignore-vertical.
  if (kind == null) {
    const parts: string[] = [];
    if (Array.isArray(m.passthrough) && m.passthrough.length) {
      parts.push((m.passthrough as string[]).map((p) => PASSTHROUGH_PHRASE[p] ?? dekebab(p)).join(" and "));
    }
    let clause: string;
    if (parts.length) {
      const over = m.vertical_limit != null ? ` (up to ${jstr(m.vertical_limit)}" high)` : "";
      clause = `${subj} can move over ${parts.join(" and ")}${over} as though they were not there`;
    } else if (m.ignore_vertical) {
      clause = `${subj} ignores vertical distances when it moves`;
    } else {
      clause = `${subj} ${v(subj, "has")} a movement capability`;
    }
    if (m.excludes_keyword != null) clause += ` (excluding ${titleCase(jstr(m.excludes_keyword))} models)`;
    if (moveKinds) clause += `, during its ${moveKinds} moves`;
    return clause;
  }

  switch (kind) {
    case "scout":
      return `before the first battle round, ${subj} can make a Scout move${ofUpTo}`;
    case "infiltrate":
      return `${subj} ${v(subj, "has")} the Infiltrators ability`;
    case "advance":
      return `add ${diceCase(jstr(dist))} to ${possessive(subj)} Advance rolls`;
    case "pile-in":
      return `${subj} can Pile In up to${inches || ' 3"'}`;
    case "consolidation":
      return `${subj} can Consolidate up to${inches || ' 3"'}`;
    case "surge":
      return `${subj} can make a Surge move${ofUpTo}`;
    case "shoot-and-scoot":
      return inches
        ? `${subj} can shoot and then make a Normal move${ofUpTo}`
        : `${subj} can Shoot and Scoot`;
    case "reactive": {
      const label = m.name != null ? ` (${jstr(m.name)})` : "";
      return `${subj} can make a Reactive move${ofUpTo}${label}`;
    }
    case "redeploy": {
      if (m.marker != null) {
        const mk = m.marker as Record<string, unknown>;
        if (mk.location != null) {
          const who = mk.unit_filter != null ? `${jstr(mk.unit_filter)} units` : "units";
          return `${who} can be set up on ${jstr(mk.location)}`;
        }
        const what = mk.affected != null ? jstr(mk.affected) : "markers";
        return `${what} can be repositioned${inches}`;
      }
      if (m.to_reserves) {
        const n = m.max_units != null ? `up to ${jstr(m.max_units)} units` : subj;
        return `${n} can be placed into Strategic Reserves`;
      }
      return `${subj} can be redeployed${inches}`;
    }
    case "normal":
    default: {
      const n = Number(dist);
      if (!Number.isNaN(n) && n < 0)
        return `${possessive(subj)} Move characteristic is reduced by ${Math.abs(n)}"`;
      if (moveKinds) return `add${inches} to ${possessive(subj)} ${moveKinds} moves`;
      return `${subj} can make a Normal move${ofUpTo}`;
    }
  }
}

/** Generic aura `modifier` → one lowercase-initial clause. */
function auraClause(e: Effect, m: Record<string, unknown>, ctx: Ctx): string {
  // Range-extension of a named aura (e.g. Gift of Poxes: contagion +3").
  if (m.range_bonus != null) {
    const named = m.of != null ? `${titleCase(jstr(m.of))} ` : "";
    return `the range of this model's ${named}abilities is increased by ${jstr(m.range_bonus)}"`;
  }
  const range = m.range;
  const rangeText = Array.isArray(range)
    ? `${(range as number[]).map((r) => `${r}"`).join("/")} (by battle round)`
    : range != null
      ? `${jstr(range)}"`
      : null;
  const who = e.target === "friendly-within-aura" ? "each friendly unit" : "each enemy unit";
  const within = rangeText != null ? `${who} within ${rangeText}` : who;
  if (m.effect != null) {
    return `${within} ${describeEffectInline(m.effect as Effect, { ...ctx })}`;
  }
  return `${within} is affected`;
}

/**
 * Single-clause translation for leaf effects (lowercase-initial, no period),
 * with any `scaling` block woven on as a trailing "for every …" clause.
 */
export function describeEffectInline(e: Effect, ctx: Ctx = {}): string {
  const base = describeEffectInlineBase(e, ctx);
  return e.scaling ? `${base} ${scalingClause(e.scaling)}` : base;
}

/** Resurrection `placement` modifier → a "where it is set up" clause. */
function resurrectionPlacement(placement: unknown): string {
  if (placement == null) return "";
  switch (jstr(placement)) {
    case "deep-strike":
      return "using its Deep Strike ability";
    case "battlefield-edge":
      return "at a battlefield edge";
    case "closest-to-destruction":
      return "as close as possible to where it was destroyed";
    case "unengaged":
      return "not within Engagement Range of any enemy units";
    default:
      return `via ${dekebab(jstr(placement))}`;
  }
}

/** Resurrection `timing` modifier → a "when it is set up" clause. */
function resurrectionTiming(timing: unknown): string {
  if (timing == null) return "";
  switch (jstr(timing)) {
    case "next-movement-phase":
      return "in your next Movement phase";
    case "end-of-phase":
      return "at the end of the phase";
    default:
      return dekebab(jstr(timing));
  }
}

/** The leaf/container switch; {@link describeEffectInline} wraps it to append scaling. */
function describeEffectInlineBase(e: Effect, ctx: Ctx = {}): string {
  const m = e.modifier ?? {};
  const subj = subject(e.target, ctx);

  switch (e.type) {
    case "stat-modifier": {
      const scope = m.attack_type ? ` (${jstr(m.attack_type)})` : "";
      if (m.stat == null) return `modify ${possessive(subj)} characteristics${scope}`;
      if (m.operation === "set")
        return `modify ${possessive(subj)} ${statName(m.stat)} characteristic to ${jstr(m.value)}${scope}`;
      let val = m.value;
      let verb = m.operation === "subtract" || m.operation === "worsen" ? "subtract" : "add";
      const n = Number(val); // a negative value flips the verb so we never say "add -1"
      if (!Number.isNaN(n) && n < 0) {
        verb = verb === "add" ? "subtract" : "add";
        val = Math.abs(n);
      }
      const prep = verb === "add" ? "to" : "from";
      return `${verb} ${jstr(val)} ${prep} ${possessive(subj)} ${statName(m.stat)} characteristic${scope}`;
    }
    case "roll-modifier": {
      const ctxNote = m.context ? ` (${jstr(m.context)})` : "";
      if (m.critical_on != null) {
        const crit = m.roll === "wound" ? "Critical Wounds" : "Critical Hits";
        return `${subj} ${v(subj, "scores")} ${crit} on ${rollName(m.roll)} rolls of ${jstr(m.critical_on)}+`;
      }
      if (m.operation === "set")
        return `${subj} can change ${rollName(m.roll)} rolls to a ${jstr(m.value)}`;
      if (m.value == null) return `${dekebab(jstr(m.operation))} ${possessive(subj)} ${rollName(m.roll)} rolls${ctxNote}`;
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to ${rollName(m.roll)} rolls${ctxNote}`;
    }
    case "re-roll": {
      const noun = rollName(m.roll);
      const which = m.subset === "ones" ? `a ${noun} roll of 1` : `the ${noun} roll`;
      return `you can re-roll ${which}`;
    }
    case "mortal-wounds": {
      const range = m.range ?? m.range_inches ?? ctx.rangeInches;
      const subjMW =
        e.target === "enemy-within-aura" && range != null
          ? `each enemy unit within ${jstr(range)}"`
          : subj;
      const verb = subjMW.startsWith("each ") ? "suffers" : v(subjMW, "suffers");
      // Dice-pool form (e.g. "roll six D6: for each 4+, that unit suffers 1
      // mortal wound"): N dice rolled, each success worth `mortal_per_success`
      // mortal wounds. Distinct from a flat count — the amount IS the pool.
      if (m.mortal_per_success != null) {
        const per = jstr(m.mortal_per_success);
        const perNoun = per === "1" ? "mortal wound" : "mortal wounds";
        const hit = poolThreshold(jstr(m.comparison ?? "gte"), m.threshold);
        // Per-model pool: one die per model in this/the target unit (e.g.
        // "roll one D6 for each model in this unit: for each 4+, …").
        if (m.per_model != null) {
          const where = m.per_model === "target" ? "the target unit" : "this unit";
          return `roll one ${diceCase(m.dice)} for each model in ${where}: for each ${hit}, ${subjMW} ${verb} ${per} ${perNoun}`;
        }
        return `roll ${diceCase(m.dice)}: for each ${hit}, ${subjMW} ${verb} ${per} ${perNoun}`;
      }
      const a =
        m.count != null
          ? jstr(m.count)
          : m.amount != null
            ? jstr(m.amount)
            : m.dice != null
              ? diceCase(m.dice)
              : m.table || m.amount_table
                ? "a number of"
                : null;
      // Deadly-Demise-style triggers carry no count here — the amount is the
      // model's Deadly Demise rating, so describe the trigger instead of "?".
      if (a == null && m.trigger != null)
        return `when this model is destroyed, ${subjMW} ${verb} mortal wounds (${titleCase(jstr(m.trigger))})`;
      const amt = a ?? "?";
      const noun = amt === "1" ? "mortal wound" : "mortal wounds";
      return `${subjMW} ${verb} ${amt} ${noun}`;
    }
    case "feel-no-pain": {
      const vs = m.scope === "mortal" ? " against mortal wounds" : "";
      return `${subj} ${v(subj, "has")} the Feel No Pain ${jstr(m.threshold)}+ ability${vs}`;
    }
    case "ward":
      return `${subj} ${v(subj, "has")} the Ward ${jstr(m.threshold ?? m.value)}+ ability`;
    case "invulnerable-save":
      return `${subj} ${v(subj, "has")} a ${jstr(m.invuln_sv ?? m.value ?? m.threshold)}+ invulnerable save`;
    case "keyword-grant": {
      let kw: string;
      if (m.anti_keyword != null) {
        kw = `[ANTI-${dekebab(jstr(m.anti_keyword)).toUpperCase()} ${jstr(m.anti_threshold ?? "?")}+]`;
      } else if (Array.isArray(m.keywords)) {
        kw = m.keywords.map(bracketKeyword).join(" and ");
      } else if (m.value != null) {
        // Rated keyword carried structurally (Sustained Hits N / Rapid Fire N / Melta N).
        kw = `[${dekebab(jstr(m.keyword ?? "keywords")).toUpperCase()} ${jstr(m.value)}]`;
      } else {
        kw = bracketKeyword(m.keyword ?? "keywords");
      }
      if (m.weapon_name != null) return `${possessive(subj)} ${jstr(m.weapon_name)} gains ${kw}`;
      if (m.weapon_type != null) return `${possessive(subj)} ${jstr(m.weapon_type)} weapons gain ${kw}`;
      return `${possessive(subj)} weapons gain ${kw}`;
    }
    case "ability-grant": {
      const grant = m.grant_type ?? m.ability_id;
      const cap = m.capacity != null ? ` (${jstr(m.capacity)})` : "";
      return grant != null
        ? `${subj} ${v(subj, "gains")} the ${grantLabel(jstr(grant))} ability${cap}`
        : `${subj} ${v(subj, "gains")} an ability${cap}`;
    }
    case "movement-modifier":
      return movementClause(m, subj);
    case "aura":
      return auraClause(e, m, ctx);
    case "damage-reduction": {
      const r = jstr(m.reduction ?? m.amount ?? m.value);
      const how =
        r === "half"
          ? "halve the Damage of that attack"
          : r === "to-zero"
            ? "reduce the Damage of that attack to 0"
            : `reduce the Damage of that attack by ${r}`;
      return `each time an attack targets ${subj}, ${how}`;
    }
    case "resurrection": {
      const count = m.count != null ? diceCase(m.count) : "1";
      const wounds = m.wounds_remaining ?? "full";
      const place = resurrectionPlacement(m.placement);
      const when = resurrectionTiming(m.timing);
      const tail = [place, when].filter((s) => s.length > 0).join(" ");
      const tailClause = tail ? ` ${tail}` : "";
      // A self/bearer resurrection reads as the model returning, not "returning a model to itself".
      if (e.target === "self" || e.target === "bearer") {
        return `${subj} ${v(subj, "is")} set up again${tailClause} with ${jstr(wounds)} wounds remaining`;
      }
      const noun = count === "1" ? "destroyed model" : "destroyed models";
      return `return ${count} ${noun} to ${subj} with ${jstr(wounds)} wounds${tailClause}`;
    }
    case "model-destruction": {
      const count = m.count != null ? diceCase(m.count) : "1";
      const noun = count === "1" ? "model" : "models";
      return `destroy ${count} ${noun} in ${subj}`;
    }
    case "rule-state":
      return describeRuleState(m, subj);
    case "cp-gain":
      return `you gain ${jstr(m.amount ?? 1)}CP`;
    case "cp-refund": {
      const strat = m.stratagem != null ? `the ${titleCase(jstr(m.stratagem))} Stratagem` : "one Stratagem";
      return `you can use ${strat} on ${subj} for 0CP`;
    }
    case "resource-gain":
      return `you gain ${jstr(m.amount ?? m.value)} ${poolName(m.pool_id ?? m.resource)}`;
    case "resource-spend":
      return `spend ${jstr(m.amount ?? m.value)} ${poolName(m.pool_id ?? m.resource)}`;
    case "leadership-modifier": {
      const test = m.test != null ? `${testName(m.test)} test` : null;
      if (test != null && m.operation == null) return `${subj} must take a ${test}`;
      if (test != null && m.operation === "re-roll") return `${subj} can re-roll ${testName(m.test)} tests`;
      if (test != null && m.value != null)
        return `${m.operation === "add" ? "add" : "subtract"} ${jstr(m.value)} ${m.operation === "add" ? "to" : "from"} the ${testName(m.test)} test of ${subj}`;
      if (m.operation != null && m.value != null)
        return `${m.operation === "add" || m.operation === "improve" ? "add" : "subtract"} ${jstr(m.value)} ${m.operation === "add" || m.operation === "improve" ? "to" : "from"} the Leadership characteristic of ${subj}`;
      return `modify ${possessive(subj)} Leadership characteristic`;
    }
    case "fight-first":
      return `${subj} ${v(subj, "has")} the Fights First ability`;
    case "fight-last":
      return `${subj} ${v(subj, "has")} the Fights Last ability`;
    case "fight-on-death":
      return subj === "this model"
        ? `each time this model is destroyed, it can fight before being removed from play`
        : `each time a model in ${subj} is destroyed, it can fight before being removed from play`;
    case "shoot-on-death":
      return subj === "this model"
        ? `each time this model is destroyed, it can shoot before being removed from play`
        : `each time a model in ${subj} is destroyed, it can shoot before being removed from play`;
    case "unit-keyword": {
      const name = titleCase(jstr(m.keyword_id));
      const val = m.value != null ? ` ${jstr(m.value)}` : "";
      return `${subj} has the ${name}${val} ability`;
    }
    case "unit-keyword-grant":
      return `${jstr(m.to_keywords)} units gain the ${jstr(m.keyword)} keyword`;
    case "deep-strike":
      return m.min_distance != null
        ? `${subj} ${v(subj, "has")} the Deep Strike ability and can be set up more than ${jstr(m.min_distance)}" from enemy models`
        : `${subj} has the Deep Strike ability`;
    case "strategic-reserves-arrival":
      return `${subj} can arrive from Strategic Reserves regardless of mission rules`;
    case "remove-battle-shock":
      return `${subj} ${v(subj, "is")} no longer Battle-shocked`;
    case "auto-result": {
      const r = m.result;
      if (m.test != null) {
        if (r === "pass") return `${subj} automatically ${v(subj, "passes")} ${testName(m.test)} tests`;
        if (r === "fail") return `${subj} automatically ${v(subj, "fails")} ${testName(m.test)} tests`;
        return `${subj} ${v(subj, "treats")} ${testName(m.test)} tests as ${jstr(r)}`;
      }
      const roll = rollName(m.roll);
      if (r === "pass") return `${possessive(subj)} ${roll} rolls automatically succeed`;
      if (r === "fail") return `${possessive(subj)} ${roll} rolls automatically fail`;
      return `${possessive(subj)} ${roll} rolls count as ${jstr(r)}`;
    }
    case "firing-deck":
      return `${subj} ${v(subj, "has")} Firing Deck ${jstr(m.value)}`;
    case "disembark-after-move":
      return `units can disembark from ${subj} after it has moved`;
    case "fallback-and-act":
      return `${subj} is eligible to shoot and declare a charge in a turn in which it Fell Back`;
    case "engagement-passthrough":
      return m.no_end_in_engagement
        ? `${subj} can move through enemy models, but cannot end that move within Engagement Range of any enemy unit`
        : `${subj} can move through enemy models`;
    case "attack-restriction":
      return describeAttackRestriction(m, subj);
    case "objective-control-modifier": {
      if (m.sticky)
        return `${subj} ${v(subj, "retains")} control of objective markers even after no models remain in range, until the enemy retakes them (sticky objectives)`;
      if (m.operation === "halve") return `halve the Objective Control characteristic of ${subj}`;
      if (m.operation != null)
        return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to ${pronoun(subj)} Objective Control characteristic`;
      return `modify ${possessive(subj)} Objective Control characteristic`;
    }
    case "bs-modifier":
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to Ballistic Skill`;
    case "charge-roll-modifier":
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to Charge rolls`;
    case "terrain-area-tag":
      return `the terrain area is marked as ${dekebab(jstr(m.tag))}`;
    case "objective-tag":
      return `the objective is marked as ${dekebab(jstr(m.tag))}`;
    case "unit-tag":
      return `${subj} ${v(subj, "is")} marked as ${dekebab(jstr(m.tag))}`;

    // Container types — inline forms.
    case "conditional":
      return `${conditionLeadIn(e.condition ?? {})}, ${describeEffectInline(e.effect ?? {}, ctx)}`;
    case "sequence":
      return (e.steps ?? []).map((s) => describeEffectInline(s, ctx)).join("; ");
    case "choice": {
      const label = e.choice_label ? ` (${titleCase(e.choice_label)})` : "";
      return `select one of the following${label}: ${(e.options ?? []).map((o) => describeEffectInline(o, ctx)).join(" / ")}`;
    }
    case "dice-gated": {
      const comp = formatComparison(e.comparison ?? "gte", e.threshold);
      const success = e.on_success ? describeEffectInline(e.on_success, ctx) : "nothing happens";
      const fail = e.on_fail ? `; otherwise, ${describeEffectInline(e.on_fail, ctx)}` : "";
      return `roll one ${diceCase(e.dice)}: on ${comp}, ${success}${fail}`;
    }
    case "dice-pool-allocation": {
      const pool = e.pool ? `${jstr(e.pool.count)}${jstr(e.pool.die)}` : "?";
      const opts = (e.options ?? [])
        .map((o) => `${jstr(o.name)} (${jstr(o.requirement?.type)} of ${jstr(o.requirement?.min_value)}+): ${describeEffectInline(o.effect ?? {}, ctx)}`)
        .join(" / ");
      return `roll ${pool}: ${opts}`;
    }
    case "select-units":
      return `select ${selectUnitsSubject(e.selector)}: ${describeEffectInline(e.effect ?? {}, ctx)}`;

    default:
      return `[${e.type ?? "unknown"}]`;
  }
}

/** Per-slug GW-prose for `attack-restriction` (reads `restriction` or `restriction_type`). */
/**
 * `rule-state`: a named rule switched on/off for the subject. The `faction-rule`
 * + `suppressed` path reproduces the legacy `forgo-faction-rule` phrasing
 * verbatim (Angron "Reborn in Blood"); the core-rule slugs get natural
 * action/benefit phrasing; keyword/ability kinds fall back to a regular
 * gains/loses-the-X clause. Phrasing is pinned byte-for-byte across the four
 * language ports by the conformance corpus.
 */
function describeRuleState(m: Record<string, unknown>, subj: string): string {
  const dir = jstr(m.direction);
  const kind = jstr(m.rule_kind);
  const rule = jstr(m.rule);
  const granted = dir === "granted";

  // Faction-rule suppression keeps the original "forgo activating …" wording.
  if (kind === "faction-rule" && !granted) {
    const scope = m.scope != null ? ` this ${dekebab(jstr(m.scope))}` : "";
    let cost = "";
    const c = m.cost;
    if (c != null && typeof c === "object" && (c as Record<string, unknown>).dice != null) {
      const cc = c as Record<string, unknown>;
      const from =
        cc.from == null
          ? ""
          : jstr(cc.from) === rule
            ? " from that roll"
            : ` from the ${titleCase(jstr(cc.from))} roll`;
      cost = `, using a ${dekebab(jstr(cc.dice))}${from}`;
    }
    return `forgo activating ${titleCase(rule)}${scope}${cost}`;
  }
  if (kind === "faction-rule") return `${subj} ${v(subj, "gains")} ${titleCase(rule)}`;

  // Natural phrasing for the closed core-rule slug vocabulary.
  switch (rule) {
    case "benefit-of-cover":
      return granted ? `${subj} ${v(subj, "has")} the Benefit of Cover` : `${subj} cannot benefit from Cover`;
    case "charge":
      return granted ? `${subj} can charge` : `${subj} cannot charge`;
    case "advance":
      return granted ? `${subj} can Advance` : `${subj} cannot Advance`;
    case "fall-back":
      return granted ? `${subj} can Fall Back` : `${subj} cannot Fall Back`;
    case "ordered-retreat":
      // GW frames this lever by its effect on Desperate Escape tests: suppressing
      // Ordered Retreat forces the tests; granting it (e.g. while Battle-shocked)
      // exempts the unit. Mirrors the `desperate-escape` slug wording.
      return granted
        ? `${subj} ${v(subj, "is")} not affected by Desperate Escape tests`
        : `${subj} must take Desperate Escape tests`;
    case "fire-overwatch":
      return granted ? `${subj} can fire Overwatch` : `${subj} cannot fire Overwatch`;
    case "overwatch-against-bearer":
      return granted ? `your opponent can target ${subj} with Overwatch` : `your opponent cannot target ${subj} with Overwatch`;
    case "desperate-escape":
      return granted
        ? `${subj} must take Desperate Escape tests`
        : `${subj} ${v(subj, "is")} not affected by Desperate Escape tests`;
  }

  // Ability / keyword kinds (every core-rule slug is cased above): regular clause.
  const noun = kind === "keyword" ? "keyword" : "ability";
  return granted
    ? `${subj} ${v(subj, "gains")} the ${titleCase(rule)} ${noun}`
    : `${subj} ${v(subj, "loses")} the ${titleCase(rule)} ${noun}`;
}

function describeAttackRestriction(m: Record<string, unknown>, subj: string): string {
  // Some entries express the restriction as a forbidden action (`attack_type: charge`).
  if (m.restriction == null && m.restriction_type == null && m.attack_type != null)
    return `${subj} cannot ${jstr(m.attack_type)}`;
  const slug = jstr(m.restriction ?? m.restriction_type);
  const range = m.range != null ? jstr(m.range) : null;
  switch (slug) {
    case "worsen-incoming-ap":
      return `each time an attack targets ${subj}, worsen the Armour Penetration of that attack by ${jstr(m.value ?? 1)}`;
    case "cannot-be-targeted-unless-closest-or-within-12":
      return `${subj} can only be targeted if it is the closest eligible target or within 12"`;
    case "targeting-range-limit":
      return `${subj} can only target enemy units within ${range ?? "?"}"`;
    case "reinforcement-denial":
      return `enemy units cannot be set up from Reserves within ${range ?? "?"}" of ${subj}`;
    case "must-be-warlord":
      return "this model must be your Warlord";
    case "cannot-be-warlord":
      return "this model cannot be your Warlord";
    case "unique-unit-limit":
      return "you can include only one of this unit in your army";
    case "no-charge":
      return `${subj} cannot charge`;
    default:
      return `${subj}: ${dekebab(slug)}${range != null ? ` (within ${range}")` : ""}`;
  }
}

/**
 * Block translation of a *container* effect tree (multi-line, two-space
 * indentation). Leaves and conditionals are handled inline by the caller.
 */
export function describeEffect(e: Effect, depth: number = 0, ctx: Ctx = {}): string {
  const indent = "  ".repeat(depth);
  const arrow = depth > 0 ? "-> " : "";

  switch (e.type) {
    case "conditional": {
      const inner = e.effect ?? {};
      if (CONTAINER_TYPES.has(inner.type ?? "")) {
        return `${indent}${capitalize(conditionLeadIn(e.condition ?? {}))}:\n` + describeEffect(inner, depth + 1, ctx);
      }
      return `${indent}${arrow}${capitalize(conditionLeadIn(e.condition ?? {}))}, ${describeEffectInline(inner, ctx)}.`;
    }
    case "sequence":
      return (e.steps ?? [])
        .map((s) => describeEffect(s, depth, ctx))
        .join("\n");
    case "choice": {
      const label = e.choice_label ? ` (${titleCase(e.choice_label)})` : "";
      return (
        `${indent}Select one of the following${label}:\n` +
        (e.options ?? []).map((o) => `${indent}  - ${capitalize(describeEffectInline(o, ctx))}.`).join("\n")
      );
    }
    case "dice-gated": {
      const comp = formatComparison(e.comparison ?? "gte", e.threshold);
      const success = e.on_success ? describeEffectInline(e.on_success, ctx) : "nothing happens";
      const fail = e.on_fail ? `; otherwise, ${describeEffectInline(e.on_fail, ctx)}` : "";
      return `${indent}${arrow}Roll one ${diceCase(e.dice)}: on ${comp}, ${success}${fail}.`;
    }
    case "dice-pool-allocation": {
      const pool = e.pool ? `${jstr(e.pool.count)}${jstr(e.pool.die)}` : "?";
      const lines = [`${indent}${arrow}Roll ${pool} (max ${jstr(e.max_activations)} activations):`];
      for (const opt of e.options ?? []) {
        lines.push(
          `${indent}  - ${jstr(opt.name)}: need ${jstr(opt.requirement?.type)} of ${jstr(opt.requirement?.min_value)}+ -> ${describeEffectInline(opt.effect ?? {}, ctx)}`
        );
      }
      return lines.join("\n");
    }
    case "select-units": {
      const inner = e.effect ?? {};
      const lead = `Select ${selectUnitsSubject(e.selector)}`;
      if (CONTAINER_TYPES.has(inner.type ?? "")) {
        return `${indent}${arrow}${lead}:\n` + describeEffect(inner, depth + 1, ctx);
      }
      return `${indent}${arrow}${lead}: ${describeEffectInline(inner, ctx)}.`;
    }
    default:
      // Leaf at block position — render as a single capitalized sentence.
      return `${indent}${arrow}${capitalize(describeEffectInline(e, ctx))}.`;
  }
}

/** `Scope: aura (6"). Duration: phase.` — retained for the legacy translate CLI footer. */
export function describeScope(s?: AbilityScope): string {
  if (!s || (!s.range && !s.duration)) return "";
  const range = dekebab(s.range ?? "");
  const inches = s.range_inches != null ? ` (${jstr(s.range_inches)}")` : "";
  const duration = dekebab(s.duration ?? "");
  return `Scope: ${range}${inches}. Duration: ${duration}.`;
}

/**
 * `Applies to: units with Possessed.` — the roster-highlighting audience named
 * by a curated `applies_to` filter. Empty string when the filter is absent or
 * carries no keywords (nothing to say). `required_keywords` reads as an AND set;
 * `excluded_keywords` render as a trailing `(excluding …)`.
 */
export function describeAppliesTo(a?: AbilityAppliesTo | null): string {
  if (!a) return "";
  const required = a.required_keywords ?? [];
  const excluded = a.excluded_keywords ?? [];
  if (required.length === 0 && excluded.length === 0) return "";
  const base = required.length ? `units with ${required.join(", ")}` : "all units";
  const exc = excluded.length ? ` (excluding ${excluded.join(", ")})` : "";
  return `Applies to: ${base}${exc}.`;
}

/** Join non-empty clauses with ", ", capitalize the sentence, and end with a period. */
function assembleSentence(parts: string[]): string {
  const body = parts.filter((p) => p.length > 0).join(", ");
  if (body.length === 0) return "";
  const period = body.endsWith(".") || body.endsWith(":") ? "" : ".";
  return capitalize(body) + period;
}

/**
 * Full generated text for an ability: a natural-English sentence (effect with
 * scope range + duration woven in, single-leaf conditionals inlined) plus a
 * trailing `Applies to:` line when the ability carries a curated `applies_to`
 * filter. This is the `ability.print()` consumers render when the dataset
 * carries no rules prose.
 */
export function describeAbility(a: AbilityLike): string {
  const core = a.effect ? renderTopLevel(a.effect, a.scope, a.usage, a.trigger) : "";
  const applies = describeAppliesTo(a.applies_to);
  return [core, applies].filter(Boolean).join("\n");
}

/** Assemble the top-level sentence/block, weaving trigger + usage + scope duration + range. */
/**
 * Aura radius in inches: an explicit `range_inches` when present, else the
 * integer baked into a standard `aura-<n>` slug (`aura-6` -> 6), else undefined.
 * Per the scope schema, `aura-6/9/12` carry the radius in the slug and leave
 * `range_inches` null; only `aura-custom` sets `range_inches`. Non-aura ranges
 * (`unit`, `engagement-range`, ...) yield undefined, so the subject helper keeps
 * its `" nearby"` fallback for them.
 */
function auraRadius(scope?: AbilityScope): number | undefined {
  if (scope?.range_inches != null) return scope.range_inches;
  const m = /^aura-(\d+)$/.exec(scope?.range ?? "");
  return m ? Number(m[1]) : undefined;
}

function renderTopLevel(
  e: Effect,
  scope?: AbilityScope,
  usage?: AbilityUsage | null,
  trigger?: AbilityTrigger | null,
): string {
  const ctx: Ctx = { rangeInches: auraRadius(scope), engagementRange: scope?.range === "engagement-range" };
  const { lead: durLead, trail } = durationClauses(scope?.duration);
  // An explicit usage limit supersedes the duration's coarse "once per battle" lead.
  const lead = usage && usage.frequency != null ? usageClause(usage) : durLead;
  // A reactive trigger opens the sentence ("Each time …").
  const trig = trigger && trigger.event != null ? describeTrigger(trigger) : "";

  if (e.type === "conditional") {
    const inner = e.effect ?? {};
    const leadIn = conditionLeadIn(e.condition ?? {});
    if (CONTAINER_TYPES.has(inner.type ?? "")) {
      // Block: "<trigger>[, <lead-in>][, <duration>]:" then the indented container.
      const header = [trig, lead, leadIn, trail].filter((p) => p.length > 0).join(", ");
      return capitalize(header) + ":\n" + describeEffect(inner, 1, ctx);
    }
    return assembleSentence([trig, lead, leadIn, trail, describeEffectInline(inner, ctx)]);
  }

  if (CONTAINER_TYPES.has(e.type ?? "")) {
    // Containers render block; a trigger/duration lead-in prefixes the block when present.
    const block = describeEffect(e, 0, ctx);
    const head = [trig, lead || trail].filter((p) => p.length > 0).join(", ");
    return head ? capitalize(head) + ":\n" + block : block;
  }

  return assembleSentence([trig, lead, trail, describeEffectInline(e, ctx)]);
}
