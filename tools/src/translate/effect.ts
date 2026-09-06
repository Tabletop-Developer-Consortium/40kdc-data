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

import { describeCondition, describeSelectionEligibility, describeTiming, negatedTiming, eventClause, dekebab, type Condition } from "./condition.js";

/** Independent all-required/none-excluded keyword predicate for aura roles. */
export interface KeywordFilter {
  required_keywords: string[];
  excluded_keywords?: string[];
}

/** Aura modifier surface, including direction-specific keyword predicates. */
export interface AuraModifier {
  range?: number | number[];
  range_bonus?: number;
  of?: string;
  emitter_filter?: KeywordFilter;
  recipient_filter?: KeywordFilter;
  effect?: Effect;
  [key: string]: unknown;
}

/**
 * Minimal structural view of an effect node. Matches the ability-dsl effect
 * schema: a single effect carries `type` + `target` + `modifier`; containers
 * carry their own shape (`steps`, `options`, `condition`/`effect`, dice
 * fields).
 */
export interface Effect {
  type?: string;
  name?: string;
  kind?: string;
  level?: number;
  target?: string;
  modifier?: Record<string, unknown> | AuraModifier;
  condition?: Condition;
  effect?: Effect;
  after_move?: Effect;
  steps?: Effect[];
  options?: (Effect & {
    name?: string;
    // single dice-requirement or an `any_of` set; read structurally by describeRequirement.
    requirement?: unknown;
  })[];
  choice_label?: string;
  choice_prompt?: string;
  dice?: string;
  threshold?: number | string;
  comparison?: string;
  optional?: boolean;
  test?: { kind: "leadership"; subject: "unit" | "self" };
  outcomes?: {
    results?: number[];
    effect?: Effect;
  }[];
  on_success?: Effect | null;
  on_fail?: Effect | null;
  pool?: { count: number; die: string };
  max_activations?: number;
  selector?: {
    count?: number;
    min_count?: number;
    max_count?: number;
    keywords?: string[];
    owner?: string;
    target_kind?: "unit" | "model";
    member_of?: "bearer-unit";
    reference?: "bearer" | "bearer-unit";
    selection_limit?: { count: number; period: string };
    within_inches?: number;
    range_inches?: number;
    visibility_required?: boolean;
    engagement_relation?: "any" | "engaged-with-bearer" | "not-engaged-with-bearer";
    eligibility?: Condition;
  };
  scaling?: {
    per?: number;
    of?: string;
    within_inches?: number;
    round?: string;
    max_value?: number;
  };
  // designate-target / persistent-designation
  designation?: string;
  select?: string | {
    scope?: string;
    count?: number;
    timing?: string;
    selection_policy?: string;
  };
  consumer?: {
    relation?: string;
    beneficiary?: string;
    effect?: Effect;
  };
  // leader-model-ability-grant
  source?: string;
  beneficiary?: string;
  leader_filter?: { identity?: string; keywords?: string[] };
  attached_unit_filter?: string[] | null;
  recipient_binding?: string;
  grant?: { recipient?: string; effect?: Effect };
  applies?: { to?: string; effect?: Effect; attacker_keywords?: string[] };
  duration?: string;
  // stance-select
  mode?: string;
  scope?: string;
  // risk-reward
  reward?: Effect;
  risk?: { test?: string; on_fail?: Effect };
  // issue-orders
  count?: number;
  range?: number;
  eligible?: { keyword?: string };
  // resource-action-menu
  menu_id?: string;
  pool_id?: string;
  shared_usage?: {
    unit_max_manoeuvres_per_phase?: number;
    default_manoeuvre_max_per_phase?: number;
  };
  actions?: MenuAction[];
}

/** One entry in a `resource-action-menu`'s `actions` array (a single reactive manoeuvre). */
export interface MenuAction {
  id?: string;
  label?: string;
  when?: AbilityTriggerSpec;
  cost?: { pool_id?: string; amount?: number; resource_label?: string };
  eligibility?: {
    requires_keyword?: string[];
    excludes_keyword?: string[];
    selector_count?: number;
    requires?: Condition[];
  };
  usage?: { repeatable_if_different_unit?: boolean };
  duration?: string;
  effect?: Effect;
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
  /** Restricts a move event (e.g. enemy-unit-ended-move) to the given move kinds. */
  move_types?: string[];
  condition?: Condition;
  optional?: boolean;
  cost?: { cp?: number };
  window?: string;
  /** Internal event-object binding; never rendered. */
  binds_event_variable?: string;
  source_ability?: { ability_id: string; owner: string; keywords: string[] };
}

/** A trigger is one object, or an array (the ability fires on ANY listed trigger). */
export type AbilityTriggerSpec = AbilityTrigger | AbilityTrigger[];

/** Normalize the polymorphic trigger field to a flat list (empty when absent). */
function normalizeTriggers(t?: AbilityTriggerSpec | null): AbilityTrigger[] {
  if (t == null) return [];
  return Array.isArray(t) ? t : [t];
}

/** Minimal ability view for `describeAbility`. */
export interface AbilityLike {
  name?: string;
  effect?: Effect;
  scope?: AbilityScope;
  trigger?: AbilityTriggerSpec | null;
  usage?: AbilityUsage | null;
  applies_to?: AbilityAppliesTo | null;
}

/** Rendering context threaded down from the ability (scope info the leaf needs). */
interface Ctx {
  /** Aura/blast radius in inches, for `*-within-aura` targets and within-range effects. */
  rangeInches?: number;
  /** True when the ability scope is `engagement-range`, so within-aura subjects read "within Engagement Range". */
  engagementRange?: boolean;
  /**
   * The raw scope range slug, for the non-radius scopes (`any-visible`,
   * `any-on-battlefield`) whose within-aura subjects have a real extent the
   * generic " nearby" fallback would drop.
   */
  scopeRange?: string;
  /** A `select-units` wrapper makes nested `target: unit` refer to its selection. */
  selectedUnit?: boolean;
  /** A model-targeting `select-units` wrapper makes nested `target: unit` refer to its selected model. */
  selectedModel?: boolean;
}

const CONTAINER_TYPES = new Set([
  "sequence",
  "rules-bundle",
  "named-effect",
  "choice",
  "dice-gated",
  "dice-table",
  "dice-pool-allocation",
  "select-units",
  "for-each-unit",
  "designate-target",
  "persistent-designation",
  "stance-select",
  "risk-reward",
  "issue-orders",
  "resource-action-menu",
]);

/** "one enemy Vehicle unit within 12\"" — the `select-units` selector phrase. */
function selectUnitsSubject(sel: Record<string, unknown> = {}): string {
  const kw = ((sel.keywords as unknown[]) ?? []).map((k) => titleCase(jstr(k))).join(" ");
  const exactCount = sel.count ?? (
    sel.min_count != null && Number(sel.min_count) === Number(sel.max_count)
      ? sel.max_count
      : undefined
  );
  const bounded = sel.min_count != null && exactCount == null;
  const count = exactCount ?? sel.max_count;
  const single = Number(count) === 1;
  const nounBase = sel.target_kind === "model" ? "model" : "unit";
  const noun = single ? nounBase : `${nounBase}s`;
  const quantity =
    exactCount != null
      ? single ? "one" : jstr(count)
      : bounded
        ? `from ${jstr(sel.min_count)} through ${jstr(sel.max_count)}`
        : `up to ${jstr(count)}`;
  const within =
    sel.within_inches != null
      ? ` within ${jstr(sel.within_inches)}"`
      : sel.range_inches != null
        ? ` within ${jstr(sel.range_inches)} inches of ${sel.reference === "bearer-unit" ? "this model's unit" : "the bearer"}`
        : "";
  const visible = sel.visibility_required === true ? " visible to the bearer" : "";
  const inclusive = bounded ? ", inclusive" : "";
  const eligibility =
    typeof sel.eligibility === "object" && sel.eligibility != null
      ? ` ${describeSelectionEligibility(sel.eligibility as Condition)}`
      : "";
  return `${quantity} ${jstr(sel.owner)}${kw ? ` ${kw}` : ""} ${noun}${inclusive}${within}${visible}${eligibility}`;
}

function selectUnitsEngagement(sel: Record<string, unknown> = {}): string {
  const parts: string[] = [];
  const noun = sel.target_kind === "model" ? "model" : "unit";
  const origin = sel.reference === "bearer-unit" ? "this model's unit" : "the bearer";
  if (sel.engagement_relation === "engaged-with-bearer") parts.push(`For each selected ${noun}, it must be within Engagement Range of ${origin}.`);
  if (sel.engagement_relation === "not-engaged-with-bearer") parts.push(`For each selected ${noun}, it must not be within Engagement Range of ${origin}.`);
  const limit = sel.selection_limit as { count: number; period: string } | undefined;
  if (limit) parts.push(`Each ${noun} can be selected for this ability at most ${limit.count === 1 ? "once" : `${limit.count} times`} per ${dekebab(limit.period)} across your army.`);
  return parts.join(" ");
}

function selectUnitsPlural(sel: Record<string, unknown> = {}): boolean {
  return Number(sel.count ?? sel.max_count) > 1;
}

function selectedRecipient(text: string, sel: Record<string, unknown> = {}): string {
  const noun = sel.target_kind === "model" ? "model" : "unit";
  const recipient = selectUnitsPlural(sel) ? `each selected ${noun}` : `the selected ${noun}`;
  return text
    .replace(/\b[Tt]he unit's\b/g, (match) => match[0] === "T" ? `Each selected ${noun}'s` : `${recipient}'s`)
    .replace(/\b[Tt]he unit\b/g, (match) => match[0] === "T" ? `Each selected ${noun}` : recipient);
}

function selectedContext(ctx: Ctx, sel: Record<string, unknown>): Ctx {
  const selectedModel = sel.target_kind === "model";
  return { ...ctx, selectedUnit: !selectedModel, selectedModel };
}

function selectUnitsInline(sel: Record<string, unknown>, effect: Effect, ctx: Ctx): string {
  const subject = selectUnitsSubject(sel);
  const engagement = selectUnitsEngagement(sel);
  const nested = selectedRecipient(describeEffectInline(effect, selectedContext(ctx, sel)), sel);
  return engagement
    ? `select ${subject}. ${engagement} ${capitalize(nested)}`
    : `select ${subject}: ${nested}`;
}

/** Render the beneficiary-only leader relation without exposing a bearer fallback. */
function leaderModelAbilityGrantClause(e: Effect, ctx: Ctx): string {
  const filter = e.leader_filter ?? {};
  const identity = filter.identity ? titleCase(filter.identity) : "";
  const keywords = (filter.keywords ?? []).map(bracketKeyword).join(" and ");
  const role =
    e.beneficiary === "attached-character-leader"
      ? "the attached CHARACTER leader model"
      : "the attached leader model";
  const leader = `${role}${identity ? ` identified as ${identity}` : ""}${keywords ? ` with ${keywords}` : ""}`;
  const unitKeywords = (e.attached_unit_filter ?? []).map(bracketKeyword).join(" and ");
  const source = `the bearer unit${unitKeywords ? ` with ${unitKeywords}` : ""}`;
  const nested = e.grant?.effect ?? {};
  const rendered = describeEffectInline({ ...nested, target: "self" }, ctx).replace(
    /^this model\b/,
    "that leader model",
  );
  return `while ${leader} leads ${source}, ${rendered}`;
}

/** "enemy unit within 6\"" — the `for-each-unit` selector phrase. */
function forEachUnitSubject(sel: Record<string, unknown> = {}): string {
  const keywords = Array.isArray(sel.keywords) ? `${sel.keywords.map((keyword) => titleCase(jstr(keyword))).join(" ")} ` : "";
  const within = sel.within_inches != null ? ` within ${jstr(sel.within_inches)}"` : "";
  const noun = sel.target_kind === "model" ? "model" : "unit";
  return `${jstr(sel.owner)} ${keywords}${noun}${sel.member_of === "bearer-unit" ? " in this model's unit" : ""}${within}`;
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
  "nurgle-s-gift-aura": "Nurgle's Gift (Aura)",
};

/** The display label for a granted ability id: a curated override, else Title Case. */
function grantLabel(id: string): string {
  return ABILITY_GRANT_LABELS[id] ?? titleCase(id);
}

/**
 * "(your Suppressed target)" — a designate-target mark's parenthetical. A
 * designation slug that already ends in "target" keeps its own noun
 * ("bio-stimulus-target" → "(your Bio Stimulus Target)", not "… Target target").
 */
function designationLabel(designation: unknown): string {
  const label = titleCase(jstr(designation));
  return /\bTarget$/.test(label) ? ` (your ${label})` : ` (your ${label} target)`;
}

type DesignationSelection = {
  scope?: string;
  timing?: string;
  within_inches?: number;
  keywords?: unknown[];
  keyword_match?: string;
  eligibility?: Condition;
};

function designationTargetSubjectBase(sel: DesignationSelection): string {
  const disposition = sel.scope === "friendly-unit" ? "friendly" : "enemy";
  const keywords = Array.isArray(sel.keywords) ? sel.keywords.map((keyword) => titleCase(jstr(keyword))) : [];
  const keywordJoin = sel.keyword_match === "any" ? " or " : " ";
  const keywordText = keywords.length > 0 ? ` ${keywords.join(keywordJoin)}` : "";
  const within = sel.within_inches != null ? ` within ${jstr(sel.within_inches)} inches` : "";
  return `${disposition}${keywordText} unit${within}`;
}
function designationTargetSubject(sel: DesignationSelection): string {
  return designationTargetSubjectBase(sel) + (sel.eligibility ? ` ${describeSelectionEligibility(sel.eligibility)}` : "");
}


function transportCapacityConversion(m: Record<string, unknown>): string {
  const keyword = m.model_keyword != null ? titleCase(jstr(m.model_keyword)) : "";
  const singleModel = m.subject_kind === "single-model";
  const model = keyword ? `${singleModel ? "this " : ""}${keyword} model` : singleModel ? "this model" : "model in this unit";
  const eachModel = singleModel ? model : `each ${model}`;
  const eligibility = m.transport_eligibility as Record<string, unknown> | undefined;
  const qualification =
    eligibility?.requires_capacity_keyword != null
      ? ` in a Transport able to carry ${titleCase(jstr(eligibility.requires_capacity_keyword))} models`
      : eligibility?.embark_as_keyword != null
        ? ` when embarking as ${titleCase(jstr(eligibility.embark_as_keyword))}`
        : "";

  if (m.occupancy_kind === "fixed-model-spaces") {
    const spaces = Number(m.spaces_per_model);
    return `for Transport capacity${qualification}, ${eachModel} occupies ${spaces} model space${spaces === 1 ? "" : "s"}`;
  }
  if (m.occupancy_kind === "equivalent-model") {
    const equivalent =
      m.equivalent_model_keyword != null
        ? `${titleCase(jstr(m.equivalent_model_keyword))} model`
        : "model";
    const count = Number(m.equivalent_model_count ?? 1);
    return `for Transport capacity${qualification}, ${eachModel} counts as ${count} ${equivalent}${count === 1 ? "" : "s"}`;
  }

  const models = Number(m.models_per_group);
  const spaces = Number(m.spaces_per_group);
  const groupModel = keyword ? `${keyword} model` : "model in this unit";
  const groupModels = keyword ? `${keyword} models` : "models in this unit";
  const subject = singleModel
    ? model
    : models === 1
      ? `each ${groupModel}`
      : `each group of ${models} ${groupModels}`;
  const spaceNoun = spaces === 1 ? "model space" : "model spaces";
  return `for Transport capacity${qualification}, ${subject} occupies ${spaces} ${spaceNoun}, rounding ${jstr(m.rounding)}`;
}
function persistentDesignationName(designation: unknown, scope: unknown): string {
  const label = titleCase(jstr(designation));
  if (scope === "objective-marker")
    return /\bMarker$/.test(label) ? `your ${label}` : `your ${label} Marker`;
  return /\bTarget$/.test(label) ? `your ${label}` : `your ${label} target`;
}

function persistentDesignationLabel(designation: unknown, scope: unknown): string {
  return ` (${persistentDesignationName(designation, scope)})`;
}

function persistentDesignationSupported(e: Effect): boolean {
  const select = typeof e.select === "object" && e.select ? e.select : {};
  const consumer = e.consumer ?? {};
  return (
    consumer.beneficiary === "bearer" &&
    ((select.scope === "enemy-unit" && consumer.relation === "attacks-selected-unit") ||
      (select.scope === "objective-marker" && consumer.relation === "within-selected-marker"))
  );
}

function persistentDesignationLead(e: Effect): string {
  const select = typeof e.select === "object" && e.select ? e.select : {};
  const scopeNoun = select.scope === "objective-marker" ? "objective marker" : "enemy unit";
  const label = persistentDesignationLabel(e.designation, select.scope);
  const selectLead = select.timing ? `${describeTiming(select.timing)}, select` : "select";
  return `${selectLead} one ${scopeNoun}${label}.`;
}

function persistentDesignationWhen(e: Effect): string {
  const select = typeof e.select === "object" && e.select ? e.select : {};
  const consumer = e.consumer ?? {};
  const name = persistentDesignationName(e.designation, select.scope);
  const relation =
    consumer.relation === "within-selected-marker"
      ? `while this model is within range of ${name}`
      : "each time this model makes an attack against it";
  const { trail } = durationClauses(e.duration);
  return trail ? `${capitalize(trail)}, ${relation}` : relation;
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
  return / units\b/.test(subj) || /^all /.test(subj) || /^(enemy|friendly) units/.test(subj) || /^targets /.test(subj);
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

/**
 * Player-facing noun for a `resource-gain`/`resource-spend`/`resource-clear`
 * modifier's pool, or a menu action's `cost`. `resource_label` (a singular
 * noun, e.g. "Battle Focus token") is an author-provided override that
 * pluralizes by count and NEVER leaks the internal `pool_id`; absent, falls
 * back to the established `poolName` title-casing (backward compatible with
 * every pre-existing resource node).
 */
function resourceNoun(m: { pool_id?: unknown; resource?: unknown; resource_label?: unknown }, count?: unknown): string {
  const label = typeof m.resource_label === "string" && m.resource_label.length > 0 ? m.resource_label : null;
  if (!label) return poolName(m.pool_id ?? m.resource);
  const n = count != null ? Number(jstr(count)) : NaN;
  return n === 1 ? label : `${label}s`;
}

/** Roll noun for a roll token (`hit` → `Hit`, `attacks-characteristic` → `Attacks characteristic`). */
// Narrowed feel-no-pain scopes -> trailing qualifier. Absent/`all` renders bare.
const FNP_SCOPES: Record<string, string> = {
  mortal: " against mortal wounds",
  psychic: " against Psychic Attacks",
  "psychic-and-mortal": " against Psychic Attacks and mortal wounds",
};

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
        : ctx.scopeRange === "any-visible"
          ? " that are visible"
          : ctx.scopeRange === "any-on-battlefield"
            ? " anywhere on the battlefield"
            : " nearby";
  switch (target) {
    case "self":
    case "bearer":
      return "this model";
    case "unit":
      return ctx.selectedModel ? "that model" : ctx.selectedUnit ? "that unit" : "the unit";
    case "attached-unit":
      return "the unit this model leads";
    case "selected-models-unit":
      return "that model's unit";
    case "target":
      return "the target";
    case "attacker":
      return "the attacking unit";
    case "defender":
      // The defending unit in an attack is the enemy from the bearer's view.
      return "the target";
    case "targets-of-selected-unit-attacks":
      return ctx.selectedModel ? "targets of that model's attacks" : "targets of that unit's attacks";
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

/**
 * `<subj>'s <rest>` for a simple subject; `the <rest> of <subj>` when the subject
 * is a clause (an aura target ending in an inch mark), where a trailing possessive
 * reads as garbage (`friendly units within 6"'s weapons`).
 */
function ofOrPossessive(subj: string, rest: string): string {
  return subj.endsWith('"') ? `the ${rest} of ${subj}` : `${possessive(subj)} ${rest}`;
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
    case "attack-sequence":
      return { lead: "", trail: "until that unit finishes resolving its attacks" };
    case "resolution":
      return { lead: "", trail: "when resolving this use" };
    case "phase":
      return { lead: "", trail: "until the end of the phase" };
    case "turn":
      return { lead: "", trail: "until the end of the turn" };
    case "battle":
      return { lead: "", trail: "for the rest of the battle" };
    case "battle-round":
      return { lead: "", trail: "until the end of the battle round" };
    case "until-next-command-phase":
      return { lead: "", trail: "until the start of your next Command phase" };
    case "until-next-movement-phase":
      return { lead: "", trail: "until the start of your next Movement phase" };
    case "until-next-battle-round":
      return { lead: "", trail: "until the start of the next battle round" };
    case "until-start-next-turn":
      return { lead: "", trail: "until the start of your next turn" };
    case "one-use":
      return { lead: "once per battle", trail: "" };
    default: // permanent / absent
      return { lead: "", trail: "" };
  }
}

function endOfPhaseDisembarkBattleShockCondition(c: Condition | undefined): boolean {
  if (c?.operator !== "and" || c.operands?.length !== 2) return false;
  const [first, second] = c.operands;
  return (
    !first.negated &&
    !second.negated &&
    first.type === "disembarked-from-transport" &&
    second.type === "is-battle-shocked"
  );
}

/** Reactive trigger → front-of-sentence lead clause ("an enemy unit ends a move within 9\" of this model"). */
function describeTrigger(t: AbilityTrigger): string {
  let s = eventClause(t.event);
  if (t.subject === "friendly-unit") s = s.replace("the unit", "a friendly unit");
  if (t.subject === "enemy-unit") s = s.replace("the unit", "an enemy unit");
  if (t.event === "stratagem-targeted") s = "when this model's unit is targeted with a Stratagem";
  if (t.event === "ability-target-selected" && t.source_ability) {
    const source = t.source_ability;
    s = `when ${t.subject === "friendly-unit" ? "a friendly unit" : t.subject === "enemy-unit" ? "an enemy unit" : "a unit"} is selected by the ${titleCase(source.ability_id)} ability of a ${source.owner} ${source.keywords.join(" ")} unit`;
  }
  if (t.event === "falls-back" && t.subject === "enemy-unit") s = "an enemy unit Falls Back";
  // Narrow a move event to its move kinds: "ends a move" → "ends a Normal,
  // Advance or Fall Back move".
  if (t.move_types?.length) {
    const kinds = orList(t.move_types.map((mt) => (mt === "fall-back" ? "Fall Back" : capWord(mt))));
    s = s.replace(/\bmove\b/, `${kinds} move`);
  }
  if (t.proximity?.range != null) {
    const of =
      t.proximity.of === "bearer-unit"
        ? "this model's unit"
        : t.proximity.of === "attached-unit"
        ? "the unit this model leads"
        : t.proximity.of === "self" || t.proximity.of === "bearer"
          ? "this model"
          : "this unit";
    s += ` within ${jstr(t.proximity.range)}" of ${of}`;
  }
  if (t.event === "end-of-phase" && endOfPhaseDisembarkBattleShockCondition(t.condition))
    s += ", if the unit disembarked from a Transport this turn and is Battle-shocked";
  else if (t.condition) s += `, if ${describeCondition(t.condition)}`;
  if (t.optional) s += ", you may use this ability";
  return s;
}

/** `excludes_keyword`/`requires_keyword` → the eligible-unit noun phrase for a menu action ("one friendly non-TITANIC unit" / "a friendly VEHICLE unit"). Absent eligibility keywords fall back to the plain subject. */
function menuActionSubject(elig: MenuAction["eligibility"]): string {
  const requires = elig?.requires_keyword ?? [];
  const excludes = elig?.excludes_keyword ?? [];
  if (excludes.length) return `one friendly non-${excludes.map(jstr).join("/")} unit`;
  if (requires.length) return `a friendly ${requires.map(jstr).join(" ")} unit`;
  return "the unit";
}

/** A menu action's `eligibility` → a trailing parenthetical naming which unit may use it and any extra requirements (`eligibility.requires` conditions, rendered via the shared `describeCondition` and joined with "and"). `""` when the action is open to any unit with no further gate. */
function menuActionEligibilityClause(elig: MenuAction["eligibility"]): string {
  if (!elig) return "";
  const hasKeywordGate = (elig.requires_keyword?.length ?? 0) > 0 || (elig.excludes_keyword?.length ?? 0) > 0;
  const requirementPhrases = (elig.requires ?? []).map(describeCondition);
  if (!hasKeywordGate && requirementPhrases.length === 0) return "";
  const parts: string[] = [];
  if (hasKeywordGate) parts.push(`only usable by ${menuActionSubject(elig)}`);
  if (requirementPhrases.length) parts.push(requirementPhrases.join(" and "));
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** A menu action's `duration` → a trailing clause. `immediate` (and absent) render with NO clause — a one-off action whose only lasting result is the board position it leaves behind. */
function menuActionDurationClause(duration: string | undefined): string {
  switch (duration) {
    case "until-end-of-phase":
      return "until the end of the phase";
    case "until-end-of-turn":
      return "until the end of the turn";
    default:
      return "";
  }
}

/** One `resource-action-menu` action → a bullet body ("Label: trigger, spend N tokens, effect, duration (notes)."). */
function describeMenuAction(a: MenuAction, ctx: Ctx): string {
  const label = jstr(a.label ?? a.id);
  const triggers = normalizeTriggers(a.when);
  const trig = triggers.map(describeTrigger).filter((s) => s.length > 0).join(" or ");
  const cost = a.cost ?? {};
  const costPhrase = `spend ${jstr(cost.amount)} ${resourceNoun(cost, cost.amount)}`;
  const effClause = describeEffectInline(a.effect ?? {}, ctx);
  const durClause = menuActionDurationClause(a.duration);
  const usageNote = a.usage?.repeatable_if_different_unit
    ? " (may be triggered more than once per phase if a different unit performs it each time)"
    : "";
  const body = [`${trig}${menuActionEligibilityClause(a.eligibility)}`, costPhrase, effClause, durClause]
    .filter((p) => p.length > 0)
    .join(", ");
  return `${label}: ${body}${usageNote}.`;
}

/** `shared_usage` → a menu-level sentence fragment ("a unit may perform at most one action per phase; unless stated otherwise, a given action may be triggered once per phase"). `""` when absent. */
function sharedUsageClause(su: Effect["shared_usage"]): string {
  if (!su) return "";
  const parts: string[] = [];
  if (su.unit_max_manoeuvres_per_phase != null) {
    parts.push(
      su.unit_max_manoeuvres_per_phase === 1
        ? "a unit may perform at most one action per phase"
        : `a unit may perform at most ${jstr(su.unit_max_manoeuvres_per_phase)} actions per phase`,
    );
  }
  if (su.default_manoeuvre_max_per_phase != null) {
    parts.push(
      su.default_manoeuvre_max_per_phase === 1
        ? "unless stated otherwise, a given action may be triggered once per phase"
        : `unless stated otherwise, a given action may be triggered up to ${jstr(su.default_manoeuvre_max_per_phase)} times per phase`,
    );
  }
  return parts.join("; ");
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
    case "once-per-battle-round":
      base = "once per battle round";
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
    if (!op.negated && op.type === "unit-has-keyword") {
      const kws: string[] = [];
      while (i < operands.length && !operands[i].negated && operands[i].type === "unit-has-keyword") {
        kws.push(jstr((operands[i].parameters ?? {}).keyword));
        i++;
      }
      parts.push(kws.length >= 2 ? `if the unit is a ${kws.join(" ")} unit` : `if the unit has the ${kws[0]} keyword`);
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
  if (c.operator === "or" && c.operands) {
    const keywordOperands = c.operands.every((o) => !o.negated && o.type === "unit-has-keyword");
    if (keywordOperands)
      return `if the unit has the ${orList(c.operands.map((o) => jstr((o.parameters ?? {}).keyword)))} keywords`;
    return c.operands.map(conditionLeadIn).join(" or ");
  }
  if (c.operator === "not" && c.operands)
    return `unless ${c.operands.map((o) => conditionLeadIn(o).replace(/^if /, "")).join(" or ")}`;
  // Negated keyword gates read as an exclusion clause, not the generic "if not …".
  if (c.negated && c.type === "target-has-keyword")
    return negatedTargetKeywords([jstr((c.parameters ?? {}).keyword)]);
  if (c.negated && c.type === "unit-has-keyword")
    return `unless the unit has the ${jstr((c.parameters ?? {}).keyword)} keyword`;
  if (c.negated && c.type === "timing-is") return negatedTiming((c.parameters ?? {}).timing);
  if (c.negated) return `if ${describeCondition(c)}`;

  const p = c.parameters ?? {};
  switch (c.type) {
    case "phase-is":
      return jstr(p.phase) === "command" || jstr(p.phase) === "command-phase"
        ? "during the Command phase"
        : `during the ${titleCase(jstr(p.phase))} phase`;
    case "is-attached":
      return `while this model is leading a ${p.keyword ? `${jstr(p.keyword)} ` : ""}unit`;
    case "timing-is":
      return describeTiming(p.timing);
    case "player-turn-is": {
      const t = jstr(p.turn);
      const phrase =
        t === "your-turn" || t === "your" || t === "own"
          ? "your"
          : t === "opponent-turn" || t === "opponent"
            ? "the opponent's"
            : "either player's";
      return `in ${phrase} turn`;
    }
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
    case "battle-round": {
      const bMin = p.min != null ? Number(p.min) : undefined;
      const bMax = p.max != null ? Number(p.max) : undefined;
      const bOrd = (n: number): string =>
        ["zeroth", "first", "second", "third", "fourth", "fifth"][n] ?? `${n}th`;
      if (bMin != null && bMax != null)
        return bMin === bMax ? `during the ${bOrd(bMin)} battle round` : `during battle rounds ${bMin}-${bMax}`;
      if (bMin != null) return `from the ${bOrd(bMin)} battle round onward`;
      if (bMax != null) return `during the first ${bMax} battle rounds`;
      return "during the battle round";
    }
    case "token-count-at-or-above":
      return `while the unit has ${jstr(p.threshold)}+ ${poolName(p.pool_id)}`;
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
      return p.attack_type === "any"
        ? "when destroyed by any attack"
        : `when destroyed by a ${jstr(p.attack_type)} attack`;
    case "unit-model-count":
      return `if the unit contains ${jstr(p.count_min)}+ ${jstr(p.keyword)} models`;
    case "uniform-ranged-loadout":
      return `if all ranged weapons equipped by each ${p.model_keyword ? `${jstr(p.model_keyword)} ` : ""}model in the unit are the same`;
    case "all-attacks-target-same-unit":
      return `when all of the unit's ${p.attack_type ? `${jstr(p.attack_type)} ` : ""}attacks target the same enemy unit`;
    case "opponent-unit-within-range": {
      let where: string;
      if (p.weapon_name != null) where = `range of ${dekebab(jstr(p.weapon_name))}`;
      else if (p.range_multiplier != null) where = "half range of its ranged weapons";
      else {
        const range = p.range ?? p.range_inches ?? p.within_inches;
        where = range === "engagement" ? "engagement range" : `${jstr(range)}"`;
      }
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
  "models-in-or-embarked-in-bearer": "models in or embarked within this model",
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

function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
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
      return `add ${diceCase(jstr(dist))} to ${ofOrPossessive(subj, "Advance rolls")}`;
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
        return `${ofOrPossessive(subj, "Move characteristic")} is reduced by ${Math.abs(n)}"`;
      if (moveKinds) return `add${inches} to ${ofOrPossessive(subj, `${moveKinds} moves`)}`;
      return `${subj} can make a Normal move${ofUpTo}`;
    }
  }
}

function auraEligibleSubject(who: string, eligible: unknown): string {
  if (typeof eligible !== "object" || eligible == null) return who;
  const e = eligible as Record<string, unknown>;
  const required = Array.isArray(e.required_keywords) ? e.required_keywords.map(jstr) : [];
  const excluded = Array.isArray(e.excluded_keywords) ? e.excluded_keywords.map(jstr) : [];
  const base = required.length ? `${who.slice(0, -4)}${required.join(" ")} unit` : who;
  return `${base}${excluded.length ? ` (excluding ${excluded.join(" ")} units)` : ""}`;
}

/** Generic aura `modifier` → one lowercase-initial clause. */
/** Render one independent aura-role keyword predicate without changing legacy auras. */
function keywordFilterClause(value: unknown, noun: string): string {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return noun;
  const filter = value as Partial<KeywordFilter>;
  const required = Array.isArray(filter.required_keywords)
    ? filter.required_keywords.map(jstr).join(" and ")
    : "";
  const excluded = Array.isArray(filter.excluded_keywords)
    ? filter.excluded_keywords.map(jstr).join(" or ")
    : "";
  return `${noun}${required ? ` with ${required}` : ""}${excluded ? ` without ${excluded}` : ""}`;
}

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
  const eligibleWho = auraEligibleSubject(who, m.eligible);
  const recipient = m.recipient_filter != null ? keywordFilterClause(m.recipient_filter, eligibleWho) : eligibleWho;
  const within = rangeText != null ? `${recipient} within ${rangeText}` : recipient;
  const filtered = m.emitter_filter != null || m.recipient_filter != null;
  const effectText =
    m.effect != null
      ? filtered
        ? `, and each such unit ${describeEffectInline(m.effect as Effect, { ...ctx, selectedUnit: true }).replace(/^the unit\b\s*/, "")}`
        : ` ${describeEffectInline(m.effect as Effect, m.eligible != null ? { ...ctx, selectedUnit: true } : { ...ctx })}`
      : filtered
        ? ", and each such unit is affected"
        : " is affected";
  if (m.emitter_filter != null) {
    const emitter = keywordFilterClause(m.emitter_filter, "this model");
    return `${emitter} projects an aura to ${within}${effectText}`;
  }
  return `${within}${effectText}`;
}

/**
 * Single-clause translation for leaf effects (lowercase-initial, no period),
 * with any `scaling` block woven on as a trailing "for every …" clause.
 */
export function describeEffectInline(e: Effect, ctx: Ctx = {}): string {
  let base = describeEffectInlineBase(e, ctx);
  if (e.type === "movement-modifier" && e.after_move) base += `; if it does, ${describeEffectInline(e.after_move, ctx)}`;
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
/**
 * Render a dice-pool option requirement as a noun phrase: `pair of 4+`, or, for an
 * `any_of` set (a blessing that triggers on a double of X OR a triple of Y — World
 * Eaters Blessings of Khorne), the alternatives joined with " or ":
 * `pair of 6+ or triple of 3+`. The single-requirement output is byte-identical to
 * the pre-`any_of` phrasing (no leading article) so existing goldens don't move.
 */
function describeRequirement(req: unknown): string {
  const one = (r: { type?: unknown; min_value?: unknown } | undefined) =>
    `${jstr(r?.type)} of ${jstr(r?.min_value)}+`;
  const anyOf = (req as { any_of?: unknown } | undefined)?.any_of;
  if (Array.isArray(anyOf)) return anyOf.map(one).join(" or ");
  return one(req as { type?: unknown; min_value?: unknown } | undefined);
}

function diceTableResultLabel(results: unknown): string {
  if (!Array.isArray(results)) return "";
  const faces = results.filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
  if (faces.length > 1 && faces.every((face, index) => index === 0 || face === faces[index - 1] + 1)) {
    return `${faces[0]}-${faces[faces.length - 1]}`;
  }
  return faces.join(", ");
}

function diceTableInline(e: Effect, ctx: Ctx): string {
  const outcomes = (e.outcomes ?? []).map(
    (outcome) => `on ${diceTableResultLabel(outcome.results)}, ${describeEffectInline(outcome.effect ?? {}, ctx)}`
  );
  return `roll one ${diceCase(e.dice)}: ${outcomes.join("; ")}`;
}

function describeEffectInlineBase(e: Effect, ctx: Ctx = {}): string {
  const m = e.modifier ?? {};
  const subj = subject(e.target, ctx);

  switch (e.type) {
    case "stat-modifier": {
      if (m.stat != null && (m.weapon_type != null || m.weapon_name != null || m.weapon_keyword != null)) {
        const equipment = `${weaponNoun(m)} equipped by ${weaponHolder(e.target, ctx)}`;
        if (m.operation === "set") return `set the ${statName(m.stat)} characteristic of ${equipment} to ${jstr(m.value)}`;
        if (m.operation === "improve") return `improve the ${statName(m.stat)} characteristic of ${equipment} by ${jstr(m.value)}`;
        if (!Number.isFinite(Number(m.value))) {
          const subtract = m.operation === "subtract" || m.operation === "worsen";
          return `${subtract ? "subtract" : "add"} ${jstr(m.value)} ${subtract ? "from" : "to"} the ${statName(m.stat)} characteristic of ${equipment}`;
        }
        const amount = Number(m.value) * (m.operation === "subtract" || m.operation === "worsen" ? -1 : 1);
        return `${amount < 0 ? "subtract" : "add"} ${jstr(Math.abs(amount))} ${amount < 0 ? "from" : "to"} the ${statName(m.stat)} characteristic of ${equipment}`;
      }
      const scope = m.attack_type ? ` (${jstr(m.attack_type)})` : "";
      if (m.stat == null) return `modify ${ofOrPossessive(subj, "characteristics")}${scope}`;
      if (m.operation === "set")
        return `modify ${ofOrPossessive(subj, `${statName(m.stat)} characteristic`)} to ${jstr(m.value)}${scope}`;
      if (m.operation === "improve")
        return `improve ${ofOrPossessive(subj, `${statName(m.stat)} characteristic`)} by ${jstr(m.value)}${scope}`;
      let val = m.value;
      let verb = m.operation === "subtract" || m.operation === "worsen" ? "subtract" : "add";
      const n = Number(val); // a negative value flips the verb so we never say "add -1"
      if (!Number.isNaN(n) && n < 0) {
        verb = verb === "add" ? "subtract" : "add";
        val = Math.abs(n);
      }
      const prep = verb === "add" ? "to" : "from";
      return `${verb} ${jstr(val)} ${prep} ${ofOrPossessive(subj, `${statName(m.stat)} characteristic`)}${scope}`;
    }
    case "detection-range-modifier":
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to detection range`;
    case "roll-modifier": {
      const roll = m.roll ?? m.test;
      const ctxNote = (m.context ? ` (${jstr(m.context)})` : "") + weaponRollScope(m);
      if (m.critical_on != null) {
        const crit = roll === "wound" ? "Critical Wounds" : "Critical Hits";
        return `${subj} ${v(subj, "scores")} ${crit} on ${rollName(roll)} rolls of ${jstr(m.critical_on)}+`;
      }
      if (m.operation === "set")
        return `${subj} can change ${rollName(roll)} rolls to a ${jstr(m.value)}`;
      if (m.value == null) return `${dekebab(jstr(m.operation))} ${ofOrPossessive(subj, `${rollName(roll)} rolls`)}${ctxNote}`;
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to ${rollName(roll)} rolls${ctxNote}`;
    }
    case "re-roll": {
      const rn = jstr(m.roll);
      const which =
        rn === "any"
          ? m.subset === "ones"
            ? "any roll of 1"
            : "any roll"
          : m.subset === "ones"
            ? `a ${rollName(m.roll)} roll of 1`
            : `the ${rollName(m.roll)} roll`;
      const permission = m.optional === false ? "re-roll" : "you can re-roll";
      const owner = e.target === "self" || e.target === "bearer" || ctx.selectedModel ? ` for ${["hit", "wound", "damage"].includes(jstr(m.roll)) ? "attacks made by " : ""}${weaponHolder(e.target, ctx)}` : "";
      return `${permission} ${which}${owner}${weaponRollScope(m)}`;
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
          const where =
            m.model_relation === "engaged-with-target"
              ? "this unit that is within Engagement Range of the target unit"
              : m.per_model === "target"
                ? "the target unit"
                : "this unit";
          return `roll one ${diceCase(m.dice)} for each model in ${where}: for each ${hit}, ${subjMW} ${verb} ${per} ${perNoun}`;
        }
        return `roll ${diceCase(m.dice)}: for each ${hit}, ${subjMW} ${verb} ${per} ${perNoun}`;
      }
      // Escalating table ("on a 2-3, 1 mortal wound; on a 4-5, D3 ..."): the
      // roll decides the amount, so render the rows, not "a number of".
      const table = (m.amount_table ?? m.table) as { roll?: unknown; amount?: unknown }[] | undefined;
      if (Array.isArray(table) && table.length) {
        const rows = table
          .map((r, i) => {
            const amt = diceCase(r.amount);
            const noun = amt === "1" ? "mortal wound" : "mortal wounds";
            return i === 0
              ? `on a ${jstr(r.roll)}, ${subjMW} ${verb} ${amt} ${noun}`
              : `on a ${jstr(r.roll)}, ${amt} ${noun}`;
          })
          .join("; ");
        return `roll one ${diceCase(m.dice ?? "D6")}: ${rows}`;
      }
      const a =
        m.count != null
          ? jstr(m.count)
          : m.amount != null
            ? jstr(m.amount)
            : m.dice != null
              ? diceCase(m.dice)
              : null;
      const bindCountAs = m.bind_count_as != null ? jstr(m.bind_count_as) : null;
      const boundAmount = a != null ? diceCase(a) : "?";
      if (bindCountAs != null)
        return `roll one ${boundAmount}: ${subjMW} ${verb} that many mortal wounds`;
      // Deadly-Demise-style triggers carry no count here — the amount is the
      // model's Deadly Demise rating, so describe the trigger instead of "?".
      if (a == null && m.trigger != null)
        return `when this model is destroyed, ${subjMW} ${verb} mortal wounds (${titleCase(jstr(m.trigger))})`;
      const amt = a ?? "?";
      const noun = amt === "1" ? "mortal wound" : "mortal wounds";
      return `${subjMW} ${verb} ${amt} ${noun}`;
    }
    case "recovery-pool": {
      if (e.target === "all-friendly" && m.per_target_unit === true)
        return `roll ${diceCase(m.dice)} recovery points independently for each friendly unit, first using them to regain lost wounds on wounded models and then using any remaining points to return destroyed models to the unit with 1 wound remaining, stopping when the unit is at full strength and all its models have their full wounds; any unallocated points are lost`;
      return `roll ${diceCase(m.dice)} recovery points for ${subj}, first using them to regain lost wounds on wounded models and then using any remaining points to return destroyed models to the unit with 1 wound remaining, stopping when the unit is at full strength and all its models have their full wounds; any unallocated points are lost`;
    }
    case "feel-no-pain": {
      const vs = FNP_SCOPES[jstr(m.scope)] ?? "";
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
      if (m.weapon_name != null || m.weapon_type != null || m.weapon_keyword != null)
        return `${weaponNoun(m)} equipped by ${weaponHolder(e.target, ctx)} gain ${kw}`;
      return `${ofOrPossessive(subj, "weapons")} gain ${kw}`;
    }
    case "ability-grant": {
      const grant = m.grant_type ?? m.ability_id;
      // Reserves-arrival grant slugs read as full clauses in GW voice — the
      // generic "gains the X ability" form would bury the mechanic in a name.
      switch (jstr(grant)) {
        case "shoot-after-advance": return `${subj} is eligible to shoot in a turn in which it Advanced`;
        case "charge-after-advance": return `${subj} is eligible to declare a charge in a turn in which it Advanced`;
        case "must-start-in-reserves":
          return `${subj} must start the battle in Reserves`;
        case "reinforcement-any-of-turns-1-to-3":
          return `${subj} can be set up in the Reinforcements step of your first, second or third Movement phase, regardless of any mission rules`;
        case "reserves-limit-exempt":
          return `${subj} ${v(subj, "is")} not counted towards any limits on the number of units that can start the battle in Reserves`;
        case "reserves-limit-exempt-with-cargo":
          return `neither ${subj} nor any units embarked within it are counted towards any limits on the number of units that can start the battle in Reserves`;
        case "may-start-in-reserves":
          return `${subj} can start the battle in Reserves`;
        case "battle-round-plus-one-for-arrival":
          return `${subj} ${v(subj, "treats")} the current battle round number as being one higher than it actually is when arriving from Reserves`;
        case "flavor-text":
          return "this ability is a descriptive note (no additional rules effect)";
        case "crew-tokens": {
          const n = jstr(m.count ?? 1);
          const token = m.token_name != null ? `${jstr(m.token_name)} tokens` : "Crew tokens";
          return `place ${n} ${token} next to ${subj} when ${pronoun(subj)=== "their" ? "they are" : "it is"} first set up, removing one each time ${subj} ${v(subj, "loses")} a wound (the model itself represents ${pronoun(subj)} final wound)`;
        }
      }
      const cap = m.capacity != null ? ` (${jstr(m.capacity)})` : "";
      // A grant's `timing` modifier scopes when the granted ability applies.
      const when = m.timing != null ? `${describeTiming(jstr(m.timing))}, ` : "";
      if (grant != null && m.enabled === false) return `${subj} cannot use the ${grantLabel(jstr(grant))} ability`;
      return grant != null
        ? `${when}${subj} ${v(subj, "gains")} the ${grantLabel(jstr(grant))} ability${cap}`
        : `${when}${subj} ${v(subj, "gains")} an ability${cap}`;
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
      // `type: "wounds"` is a heal (regained wounds), not a revive.
      if (m.type === "wounds" || m.wounds != null) {
        const healed = m.count_from != null ? "that many" : m.wounds != null ? diceCase(m.wounds) : count;
        const noun = healed === "1" ? "lost wound" : "lost wounds";
        return `${subj} ${v(subj, "regains")} up to ${healed} ${noun}`;
      }
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
    case "heal-wounds": {
      const amount = diceCase(m.amount ?? m.value ?? "1");
      const noun = amount === "1" ? "lost wound" : "lost wounds";
      return `${subj} ${v(subj, "regains")} up to ${amount} ${noun}`;
    }
    case "model-destruction": {
      const count = m.count != null ? diceCase(m.count) : "1";
      const kind = m.model_keyword != null ? `${titleCase(jstr(m.model_keyword))} model` : "model";
      const noun = count === "1" ? kind : `${kind}s`;
      return `destroy ${count} ${noun} in ${subj}`;
    }
    case "named-region-state":
      return describeNamedRegionState(m, ctx);
    case "rule-state":
      return describeRuleState(m, subj);
    case "cp-gain":
      return `you gain ${jstr(m.amount ?? 1)}CP`;
    case "cp-on-destroy": {
      const kw = m.enemy_keyword != null ? `${jstr(m.enemy_keyword)} model` : "enemy model";
      const who = subj === "this model" ? "this model's unit" : subj;
      return `each time ${who} destroys a ${kw}, you gain ${jstr(m.amount ?? 1)}CP`;
    }
    case "battle-shock-test":
      if (m.dice != null)
        return `${subj} ${v(subj, "takes")} Battle-shock tests on ${diceCase(m.dice)} instead of 2D6`;
      if (m.operation != null && m.value != null)
        return `${subj} must make a Battle-shock roll with ${signed(jstr(m.operation), m.value)}`;
      if (m.roll_modifier != null)
        return `${subj} must make a Battle-shock roll with ${signed("add", m.roll_modifier)}`;
      return `${subj} must make a Battle-shock roll`;
    case "set-battle-shock":
      return `${subj} ${v(subj, "is")} Battle-shocked`;
    case "flyover": {
      const hit = poolThreshold(jstr(m.comparison ?? "gte"), m.threshold);
      const per = jstr(m.mortal_wounds ?? 1);
      const perNoun = per === "1" ? "mortal wound" : "mortal wounds";
      return `each time this model ends a Normal move, select one enemy unit it moved over and roll ${diceCase(m.dice)}: for each ${hit}, that unit suffers ${per} ${perNoun}`;
    }
    case "hazard-rolls": {
      const count = jstr(m.additional_per_engaged_unit);
      const keyword = titleCase(jstr(m.engaged_keyword));
      const penalty =
        m.roll_modifier_if_battle_shocked != null
          ? `, with ${signed("add", m.roll_modifier_if_battle_shocked)} to those rolls while ${subj} ${v(subj, "is")} Battle-shocked`
          : "";
      return `${subj} ${v(subj, "makes")} ${count} additional Hazard rolls for each ${keyword} unit ${pronoun(subj)} ${v(subj, "is")} engaged with${penalty}`;
    }
    case "cp-refund": {
      const strat = m.stratagem != null ? `the ${titleCase(jstr(m.stratagem))} Stratagem` : "one Stratagem";
      return `you can use ${strat} on ${subj} for 0CP`;
    }
    case "modifier-immunity": {
      const scope = jstr(m.scope);
      if (scope === "enemy-stratagems") return `${subj} cannot be affected by enemy Stratagems`;
      if (scope === "enemy-abilities") return `${subj} cannot be affected by enemy abilities`;
      const exc =
        Array.isArray(m.exclude) && m.exclude.length
          ? ` (except ${(m.exclude as unknown[]).map((s) => statName(jstr(s))).join(" and ")})`
          : "";
      return `${subj} ${v(subj, "ignores")} any modifiers to ${pronoun(subj)} characteristics${exc}`;
    }
    case "no-effect": return "nothing happens";
    case "stratagem-cost-modifier": {
      if (m.applies_to === "triggering-stratagem-use" && m.operation === "decrease")
        return `reduce the CP cost of that use of the Stratagem by ${jstr(m.amount)}CP (to a minimum of 0CP), before paying its cost`;
      const which = m.stratagem != null ? `the ${titleCase(jstr(m.stratagem))} Stratagem` : "Stratagems";
      const whose = m.applies_to === "stratagems-used-by-bearer" ? `used by ${subj}` : `that ${m.stratagem ? "targets" : "target"} ${subj}`;
      const verb = m.stratagem != null ? "costs" : "cost";
      const val = m.operation === "set-to" ? `${jstr(m.set_to)}CP` : `${jstr(m.amount ?? 1)} ${m.operation === "decrease" ? "less" : "more"} CP`;
      return `${which} ${whose} ${verb} ${val}`;
    }
    case "targeting-permission": {
      const at = m.attack_type === "ranged" ? "ranged attacks" : "attacks";
      const r = m.range != null ? `${jstr(m.range)}"` : "?";
      let gate: string;
      switch (jstr(m.gate)) {
        case "within-range":
          gate = `the attacking unit is within ${r}`;
          break;
        case "closest-eligible":
          gate = "it is the closest eligible target";
          break;
        case "closest-or-within-range":
          gate = `it is the closest eligible target or the attacking unit is within ${r}`;
          break;
        default:
          gate = dekebab(jstr(m.gate));
      }
      return `${subj} can only be selected as the target of ${at} if ${gate}`;
    }
    case "stratagem-targeting-permission":
      if (m.exception === "already-targeted-different-unit-this-phase")
        return `${subj} can be targeted with the ${titleCase(jstr(m.stratagem))} Stratagem even if a different unit has already been targeted with that Stratagem this phase`;
      if (m.exception === "does-not-prevent-targeting-different-unit-this-phase")
        return `after ${subj} is targeted with the ${titleCase(jstr(m.stratagem))} Stratagem, a different unit can still be targeted with that Stratagem later in this phase`;
      return `${subj} can be targeted with Stratagems even while Battle-shocked`;
    case "resource-gain": {
      if (m.count_mode === "by-battle-size" || m.count_by_battle_size != null)
        return `you gain ${resourceNoun(m)} based on the current battle size (see the accompanying table)`;
      return `you gain ${jstr(m.amount ?? m.value)} ${resourceNoun(m, m.amount ?? m.value)}`;
    }
    case "resource-spend": {
      const base = `spend ${jstr(m.amount ?? m.value)} ${resourceNoun(m, m.amount ?? m.value)}`;
      const cap = m.cap as Record<string, unknown> | undefined;
      if (cap != null && cap.count != null && cap.per != null)
        return `${base} (no more than ${jstr(cap.count)} per ${jstr(cap.per)})`;
      return base;
    }
    case "resource-clear": {
      const scope = m.scope === "all" ? "all" : "all unspent";
      return `${scope} ${resourceNoun(m, 2)} are lost`;
    }
    case "pool-add-die": {
      const pool = poolName(m.pool_id);
      const rolled = m.value === "rolled";
      if (m.count_per_pool != null) {
        // One die per point currently in the counting pool (Icon of Khorne).
        const per = poolName(m.count_per_pool);
        const perPlural = per.endsWith("s") ? per : `${per}s`;
        const shown = m.value === "highest" ? "the highest result" : jstr(m.value);
        const die = rolled ? "one rolled D6" : `one die showing ${shown}`;
        const tail = m.consumes_pool ? `, after which all your ${perPlural} are lost` : "";
        return `add ${die} to your ${pool} for each ${per} you have${tail}`;
      }
      const cnt = m.count != null ? diceCase(m.count) : "1";
      if (rolled) {
        const dice = cnt === "1" ? "a rolled D6" : `${cnt} rolled D6`;
        return `add ${dice} to your ${pool}`;
      }
      const val = m.value === "highest" ? "the highest result" : jstr(m.value);
      const dice = cnt === "1" ? "a die" : `${cnt} dice`;
      return `add ${dice} showing ${val} to your ${pool}`;
    }
    case "replace-roll-from-pool": {
      const rolls = Array.isArray(m.rolls) ? (m.rolls as unknown[]).map((r) => dekebab(jstr(r))) : [];
      return `discard a die from your ${poolName(m.pool_id)} and substitute its value for a ${orList(rolls)} roll`;
    }
    case "leadership-modifier": {
      const test = m.test != null ? `${testName(m.test)} test` : null;
      if (test != null && m.operation == null) return `${subj} must take a ${test}`;
      if (test != null && m.operation === "re-roll") return `${subj} can re-roll ${testName(m.test)} tests`;
      if (test != null && m.operation === "set" && m.test === "battle-shock")
        return `${subj} ${v(subj, "is")} Battle-shocked`;
      if (test != null && m.value != null)
        return `${m.operation === "add" ? "add" : "subtract"} ${jstr(m.value)} ${m.operation === "add" ? "to" : "from"} the ${testName(m.test)} test of ${subj}`;
      if (m.operation != null && m.value != null)
        return `${m.operation === "add" || m.operation === "improve" ? "add" : "subtract"} ${jstr(m.value)} ${m.operation === "add" || m.operation === "improve" ? "to" : "from"} the Leadership characteristic of ${subj}`;
      return `modify ${ofOrPossessive(subj, "Leadership characteristic")}`;
    }
    case "tracking-token": {
      const token = `${titleCase(jstr(m.token))} token`;
      if (m.count_per_model != null) {
        const model = m.model_keyword != null ? `${titleCase(jstr(m.model_keyword))} model` : "model";
        const finalWound = m.model_represents_final_wound ? `; each ${model} represents its final wound` : "";
        return `place ${jstr(m.count_per_model)} ${token}s next to each ${model} in ${subj}; remove one whenever that model loses a wound${finalWound}`;
      }
      const count = m.count ?? 1;
      const noun = Number(count) === 1 ? token : `${token}s`;
      const placement = m.placement === "next-to-target" ? ` next to ${subj}` : "";
      return `place ${Number(count) === 1 ? "one" : jstr(count)} ${noun}${placement} as a reminder`;
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
      // Without a `to_keywords` filter the grant lands on the effect subject.
      return m.to_keywords != null
        ? `${jstr(m.to_keywords)} units gain the ${jstr(m.keyword)} keyword`
        : `${subj} ${v(subj, "gains")} the ${jstr(m.keyword)} keyword`;
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
      if (r === "pass") return `${ofOrPossessive(subj, `${roll} rolls`)} automatically succeed`;
      if (r === "fail") return `${ofOrPossessive(subj, `${roll} rolls`)} automatically fail`;
      return `${ofOrPossessive(subj, `${roll} rolls`)} count as ${jstr(r)}`;
    }
    case "firing-deck":
      return `${subj} ${v(subj, "has")} Firing Deck ${jstr(m.value)}`;
    case "transport-capacity-conversion":
      return transportCapacityConversion(m);
    case "disembark-after-move": {
      if (m.after == null) return `units can disembark from ${subj} after it has moved`;
      const who =
        m.requires_keyword != null
          ? `units with the ${titleCase(jstr(m.requires_keyword))} ability`
          : "units";
      const when =
        m.after === "advance"
          ? "after it has Advanced"
          : m.after === "deployment"
            ? "after it has been set up on the battlefield"
            : m.after === "before-move"
              ? "before it moves"
              : "after it has made a Normal move";
      // `mandatory`: a Reserves-transport whose cargo MUST disembark on arrival.
      const verb = m.mandatory ? "must immediately disembark" : "can disembark";
      const away =
        m.min_enemy_distance != null
          ? `, and must be set up more than ${jstr(m.min_enemy_distance)}" away from all enemy models`
          : "";
      const counts = m.counts_as_normal_move ? "; such units count as having made a Normal move" : "";
      // A deployment-step disembark has no meaningful charge window; only an
      // explicit `can_charge` renders the charge tail there.
      const charge = m.can_charge
        ? ", and are still eligible to declare a charge this turn"
        : m.after === "deployment" && m.can_charge == null
          ? ""
          : ", but cannot declare a charge this turn";
      return `${who} ${verb} from ${subj} ${when}${away}${counts}${charge}`;
    }
    case "disembark": {
      const where = m.distance != null ? ` and be set up wholly within ${jstr(m.distance)}" of the transport` : "";
      const eng = m.allow_engagement_range ? ", even within Engagement Range of enemy units" : "";
      return `${subj} can disembark${where}${eng}`;
    }
    case "unit-attachment": {
      if (m.mandatory) return `${subj} must be attached to a Leader, or it counts as destroyed`;
      const led = m.led_by != null ? ` led by a ${titleCase(jstr(m.led_by))} model` : "";
      return `at the start of the Declare Battle Formations step, ${subj} can join one friendly unit${led}, becoming part of that Bodyguard unit`;
    }
    case "fallback-and-act": {
      const acts = m.can_charge === true ? "shoot and declare a charge" : "shoot";
      return `${subj} is eligible to ${acts} in a turn in which it Fell Back`;
    }
    case "fight-eligibility-extension": {
      const r = jstr(m.range);
      return (
        `when determining which models in ${subj} are eligible to fight, ` +
        `models within ${r}" of one or more enemy models are eligible ` +
        `and can target enemy units within ${r}"`
      );
    }
    case "engagement-passthrough": {
      const base = m.no_end_in_engagement
        ? `${subj} can move through enemy models, but cannot end that move within Engagement Range of any enemy unit`
        : `${subj} can move through enemy models`;
      const moveKinds = Array.isArray(m.applies_to_moves)
        ? andList((m.applies_to_moves as string[]).map((x) => MOVE_NOUN[x] ?? dekebab(x)))
        : null;
      return moveKinds ? `${base}, during its ${moveKinds} moves` : base;
    }
    case "attack-restriction":
      return describeAttackRestriction(m, subj);
    case "objective-control-modifier": {
      if (m.sticky && m.retake === "opponent-control-greater-at-phase-end")
        return "that objective marker remains under your control until, at the end of a phase, your opponent's Level of Control over it is greater than yours";
      if (m.sticky)
        return `${subj} ${v(subj, "retains")} control of objective markers even after no models remain in range, until the enemy retakes them (sticky objectives)`;
      if (m.operation === "halve") return `halve the Objective Control characteristic of ${subj}`;
      // An absolute set (Black Rage's OC 0) mirrors stat-modifier's wording.
      if (m.operation === "set")
        return `modify ${ofOrPossessive(subj, "Objective Control characteristic")} to ${jstr(m.value)}`;
      if (m.operation != null)
        return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to ${pronoun(subj)} Objective Control characteristic`;
      return `modify ${ofOrPossessive(subj, "Objective Control characteristic")}`;
    }
    case "bs-modifier":
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to Ballistic Skill`;
    case "charge-roll-modifier":
      return `${subj} ${v(subj, "gets")} ${signed(m.operation, m.value)} to Charge rolls`;
    case "terrain-area-tag":
      return m.tag != null
        ? `the terrain area is marked as ${dekebab(jstr(m.tag))}`
        : "the terrain area is marked";
    case "objective-tag":
      return m.tag != null
        ? `the objective is marked as ${dekebab(jstr(m.tag))}`
        : "the objective is marked";
    case "unit-tag":
      return m.tag != null
        ? `${subj} ${v(subj, "is")} marked as ${dekebab(jstr(m.tag))}`
        : `${subj} ${v(subj, "is")} marked`;

    // Container types — inline forms.
    case "conditional":
      if (e.effect?.type === "named-region-state")
        return describeNamedRegionConditional(e.effect.modifier ?? {}, e.condition ?? {}, ctx);
      return `${conditionLeadIn(e.condition ?? {})}, ${describeEffectInline(e.effect ?? {}, ctx)}`;
    case "rules-bundle":
    case "sequence":
      return (e.steps ?? []).map((s) => describeEffectInline(s, ctx)).join("; ");
    case "named-effect": {
      const level = e.kind === "psychic" && e.level != null ? ` (Psychic level ${jstr(e.level)})` : "";
      const prefix = e.optional ? "you can use " : "";
      return `${prefix}${jstr(e.name)}${level}: ${describeEffectInline(e.effect ?? {}, ctx)}`;
    }
    case "choice": {
      const prompt = e.choice_prompt ?? `select one of the following${e.choice_label ? ` (${titleCase(e.choice_label)})` : ""}`;
      return `${prompt}: ${(e.options ?? []).map((o) => describeEffectInline(o, ctx)).join(" / ")}`;
    }
    case "dice-gated": {
      if (e.test) return leadershipTest(e, ctx);
      const comp = formatComparison(e.comparison ?? "gte", e.threshold);
      const success = e.on_success ? describeEffectInline(e.on_success, ctx) : "nothing happens";
      const fail = e.on_fail ? `; otherwise, ${describeEffectInline(e.on_fail, ctx)}` : "";
      return `roll one ${diceCase(e.dice)}: on ${comp}, ${success}${fail}`;
    }
    case "dice-table":
      return diceTableInline(e, ctx);
    case "dice-pool-allocation": {
      const pool = e.pool ? `${jstr(e.pool.count)}${jstr(e.pool.die)}` : "your dice pool";
      const opts = (e.options ?? [])
        .map((o) => `${jstr(o.name)} (requires ${describeRequirement(o.requirement)}): ${describeEffectInline(o.effect ?? {}, ctx)}`)
        .join(" / ");
      return `roll ${pool}: ${opts}`;
    }
    case "select-units":
      return selectUnitsInline(e.selector ?? {}, e.effect ?? {}, ctx);
    case "leader-model-ability-grant":
      return leaderModelAbilityGrantClause(e, ctx);
    case "persistent-designation":
      if (!persistentDesignationSupported(e)) return "[persistent-designation]";
      return `${persistentDesignationLead(e)} ${persistentDesignationWhen(e)}, ${describeEffectInline(e.consumer?.effect ?? {}, ctx)}`;
    case "for-each-unit": {
      const selectedCtx = selectedContext(ctx, e.selector ?? {});
      return `for each ${forEachUnitSubject(e.selector)}: ${describeEffectInline(e.effect ?? {}, selectedCtx)}`;
    }
    case "designate-target": {
      const sel = (typeof e.select === "object" && e.select ? e.select : {}) as DesignationSelection;
      const desig = e.designation ? designationLabel(e.designation) : "";
      const selectLead = sel.timing ? `${describeTiming(sel.timing)}, select` : "select";
      const { trail: durTrail } = durationClauses(e.duration);
      const when =
        e.applies?.to === "target"
          ? "while it is your target"
          : e.applies?.to === "bearer-attacks-target"
            ? "each time this unit attacks it"
            : e.applies?.attacker_keywords?.length
              ? `each time a friendly ${e.applies.attacker_keywords.join(" ")} model attacks it`
              : "each time a friendly unit attacks it";
      const whenClause = durTrail ? `${durTrail}, ${when}` : when;
      return `${selectLead} one ${designationTargetSubject(sel)}${desig}; ${whenClause}, ${describeEffectInline(e.applies?.effect ?? {}, ctx)}`;
    }
    case "stance-select":
      return `select one: ${(e.options ?? []).map((o) => `${jstr(o.name)} (${describeEffectInline(o.effect ?? {}, ctx)})`).join(" / ")}`;
    case "risk-reward":
      return `take a ${testName(e.risk?.test)} test (on a failure, ${e.risk?.on_fail ? describeEffectInline(e.risk.on_fail, ctx) : "suffer a consequence"}), then ${describeEffectInline(e.reward ?? {}, ctx)}`;
    case "issue-orders":
      return `issue Orders, each one of: ${(e.options ?? []).map((o) => jstr(o.name)).join(" / ")}`;
    case "resource-action-menu":
      return `actions may be performed when their conditions are met: ${(e.actions ?? []).map((a) => describeMenuAction(a, ctx)).join(" / ")}`;




    default:
      return `[${e.type ?? "unknown"}]`;
  }
}

function namedRegionRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function namedRegionTitle(value: unknown): string {
  return titleCase(jstr(value));
}

function namedRegionRelation(value: unknown): string {
  return jstr(value) === "wholly-within" ? "wholly within" : dekebab(jstr(value));
}

function namedRegionKeywords(value: unknown): string {
  return Array.isArray(value) ? value.map(jstr).join(" or ") : "?";
}

function namedRegionPrefix(m: Record<string, unknown>): string {
  const ref = namedRegionRecord(m.region_ref);
  const region = namedRegionTitle(ref.region_id);
  const producer = namedRegionRecord(m.producer);
  const sentences: string[] = [];
  const baseline = Array.isArray(producer.baseline) ? producer.baseline : [];
  for (const entry of baseline) {
    const zone = jstr(namedRegionRecord(entry).zone);
    if (zone === "own-deployment-zone") {
      sentences.push(`Your deployment zone is always within ${region}.`);
    } else if (zone !== "?") {
      sentences.push(`${namedRegionTitle(zone)} is always within ${region}.`);
    }
  }
  const phaseExtensions = Array.isArray(producer.phase_extensions) ? producer.phase_extensions : [];
  let hasPhaseExtension = false;
  for (const entry of phaseExtensions) {
    const zone = jstr(namedRegionRecord(entry).zone);
    if (zone === "no-mans-land") {
      sentences.push(
        `At the start of each phase, No Man's Land is within ${region} until the end of that phase if you control at least half of its objective markers.`,
      );
      hasPhaseExtension = true;
    } else if (zone === "opponent-deployment-zone") {
      sentences.push(
        hasPhaseExtension
          ? "The same applies separately to your opponent's deployment zone."
          : `At the start of each phase, your opponent's deployment zone is within ${region} until the end of that phase if you control at least half of its objective markers.`,
      );
      hasPhaseExtension = true;
    } else if (zone !== "?") {
      const label = namedRegionTitle(zone);
      sentences.push(
        `At the start of each phase, ${label} is within ${region} until the end of that phase if you control at least half of its objective markers.`,
      );
      hasPhaseExtension = true;
    }
  }
  const additions = Array.isArray(producer.additive_extensions) ? producer.additive_extensions : [];
  for (const entry of additions) {
    const addition = namedRegionRecord(entry);
    if (addition.kind !== "unit-proximity") continue;
    const gate = namedRegionRecord(addition.source_gate);
    const predicate = namedRegionRecord(gate.unit_predicate);
    const keywords = Array.isArray(predicate.keywords) ? predicate.keywords.map(jstr).join(" and ") : "?";
    sentences.push(`The area within ${jstr(addition.radius_inches)}" of one or more friendly ${keywords} units is within ${region}, continuously as those units move.`);
  }
  const sourceParts = additions.filter((entry) => namedRegionRecord(entry).kind !== "unit-proximity")
    .map((entry) => {
      const addition = namedRegionRecord(entry);
      const gate = namedRegionRecord(addition.source_gate);
      const predicate = namedRegionRecord(gate.unit_predicate);
      if (Object.keys(predicate).length === 0) return "";
      const faction = namedRegionTitle(predicate.faction);
      const keywords = namedRegionKeywords(predicate.keywords);
      const radius = addition.radius_inches != null ? ` within ${jstr(addition.radius_inches)}"` : "";
      return `${faction} units with ${keywords}${radius}`;
    })
    .filter((part) => part.length > 0);
  const uniqueSourceParts = [...new Set(sourceParts)];
  if (uniqueSourceParts.length > 0) {
    sentences.push(`Selected objective markers extend ${region} around ${uniqueSourceParts.join(" or ")}.`);
  }
  return sentences.join(" ");
}

function namedRegionSubject(m: Record<string, unknown>): string {
  const consumer = namedRegionRecord(m.consumer);
  const gate = namedRegionRecord(consumer.beneficiary_gate);
  const faction = gate.faction != null ? namedRegionTitle(gate.faction) : "";
  const keywords = namedRegionKeywords(gate.keywords);
  const factionPart = faction ? ` from your ${faction} army` : " from your army";
  return `Models in ${keywords} units${factionPart}`;
}

function namedRegionEffect(branch: Record<string, unknown>, qualified: boolean, ctx: Ctx = {}): string {
  const effect = namedRegionRecord(branch.effect);
  const modifier = namedRegionRecord(effect.modifier);
  const roll = rollName(modifier.roll);
  let text: string;
  if (effect.type === "re-roll") {
    text =
      modifier.result_scope === "any-result"
        ? `can re-roll the ${roll} roll`
        : modifier.subset === "ones"
          ? `can re-roll ${roll} rolls of 1`
          : `can re-roll ${roll} rolls`;
  } else if (effect.type === "roll-modifier" && modifier.value != null) {
    text = `gets ${signed(modifier.operation, modifier.value)} to ${roll}`;
  } else {
    text = describeEffectInline(effect as Effect, ctx);
  }
  if (branch.optional === false) text = text.replace(/^can re-roll/, "re-roll");
  if (modifier.weapon_keyword != null) {
    text += ` for ${qualified ? "those " : ""}${jstr(modifier.weapon_keyword)} attacks`;
  }
  return text;
}

function namedRegionBranchText(
  m: Record<string, unknown>,
  wholeUnit: boolean,
  qualified: boolean,
  conditional = false,
  ctx: Ctx = {},
): string {
  const consumer = namedRegionRecord(m.consumer);
  const branch = namedRegionRecord(consumer[qualified ? "qualified_branch" : "default_branch"]);
  const effect = namedRegionEffect(branch, qualified, ctx);
  if (conditional) return `${namedRegionSubject(m)} ${effect}`;
  if (!qualified) return `${namedRegionSubject(m)} ${effect}.`;
  const condition = namedRegionRecord(consumer.qualified_condition);
  if (condition.operator != null) return `If ${describeCondition(condition as Condition)}, those models ${effect} instead`;
  const membership = namedRegionRecord(consumer.membership);
  const region = namedRegionTitle(namedRegionRecord(m.region_ref).region_id);
  const relation = namedRegionRelation(membership.relation);
  const subject = wholeUnit
    ? `If such a unit is ${relation} ${region}, those models`
    : `If such a model is ${relation} ${region}, it`;
  return `${subject} ${effect} instead`;
}

function describeNamedRegionState(m: Record<string, unknown>, ctx: Ctx = {}): string {
  const consumer = namedRegionRecord(m.consumer);
  const membership = namedRegionRecord(consumer.membership);
  const wholeUnit = membership.unit_scope === "whole-unit";
  const attackGate = consumer.attack_condition ? `For each qualifying attack (${describeCondition(consumer.attack_condition as Condition)}): ` : "";
  return `${namedRegionPrefix(m)} ${attackGate}${namedRegionBranchText(m, wholeUnit, false, false, ctx)} ${namedRegionBranchText(m, wholeUnit, true, false, ctx)}`;
}

function describeNamedRegionConditional(m: Record<string, unknown>, condition: Condition, ctx: Ctx = {}): string {
  const consumer = namedRegionRecord(m.consumer);
  const membership = namedRegionRecord(consumer.membership);
  const wholeUnit = membership.unit_scope === "whole-unit";
  const positive: Condition = { ...condition, negated: false };
  const predicate = describeCondition(positive);
  const defaultText = namedRegionBranchText(m, wholeUnit, false, true, ctx);
  const qualifiedText = namedRegionBranchText(m, wholeUnit, true, true, ctx);
  if (condition.negated) {
    return `${namedRegionPrefix(m)} Unless ${predicate}, ${defaultText}. If ${predicate}, ${qualifiedText}.`;
  }
  return `${namedRegionPrefix(m)} When ${predicate}, ${qualifiedText}. Otherwise, ${defaultText}.`;
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
    case "rules-bundle":
    case "sequence":
      return (e.steps ?? [])
        .map((s) => describeEffect(s, depth, ctx))
        .join("\n");
    case "named-effect": {
      const level = e.kind === "psychic" && e.level != null ? ` (Psychic level ${jstr(e.level)})` : "";
      const inner = e.effect ?? {};
      const prefix = e.optional ? "You can use " : "";
      if (CONTAINER_TYPES.has(inner.type ?? ""))
        return `${indent}${prefix}${jstr(e.name)}${level}:\n` + describeEffect(inner, depth + 1, ctx);
      return `${indent}${arrow}${prefix}${jstr(e.name)}${level}: ${capitalize(describeEffectInline(inner, ctx))}.`;
    }
    case "choice": {
      const prompt = e.choice_prompt ?? `select one of the following${e.choice_label ? ` (${titleCase(e.choice_label)})` : ""}`;
      return (
        `${indent}${capitalize(prompt)}:\n` +
        (e.options ?? []).map((o) => `${indent}  - ${capitalize(describeEffectInline(o, ctx))}.`).join("\n")
      );
    }
    case "dice-gated": {
      if (e.test) return `${indent}${arrow}${capitalize(leadershipTest(e, ctx))}.`;
      const comp = formatComparison(e.comparison ?? "gte", e.threshold);
      const success = e.on_success ? describeEffectInline(e.on_success, ctx) : "nothing happens";
      const fail = e.on_fail ? `; otherwise, ${describeEffectInline(e.on_fail, ctx)}` : "";
      return `${indent}${arrow}Roll one ${diceCase(e.dice)}: on ${comp}, ${success}${fail}.`;
    }
    case "dice-table": {
      const lines = [`${indent}${arrow}Roll one ${diceCase(e.dice)}:`];
      for (const outcome of e.outcomes ?? []) {
        lines.push(`${indent}  - On ${diceTableResultLabel(outcome.results)}: ${capitalize(describeEffectInline(outcome.effect ?? {}, ctx))}.`);
      }
      return lines.join("\n");
    }
    case "dice-pool-allocation": {
      const pool = e.pool ? `${jstr(e.pool.count)}${jstr(e.pool.die)}` : "your dice pool";
      const upTo =
        e.max_activations != null
          ? ` to activate up to ${jstr(e.max_activations)} of the following`
          : " to activate the following";
      const lines = [`${indent}${arrow}Roll ${pool}; allocate dice${upTo}:`];
      for (const opt of e.options ?? []) {
        lines.push(
          `${indent}  - ${jstr(opt.name)} (requires ${describeRequirement(opt.requirement)}): ${describeEffectInline(opt.effect ?? {}, ctx)}.`
        );
      }
      return lines.join("\n");
    }
    case "select-units": {
      const selector = e.selector ?? {};
      const inner = e.effect ?? {};
      const selectedCtx = selectedContext(ctx, selector);
      const engagement = selectUnitsEngagement(selector);
      const lead = `Select ${selectUnitsSubject(selector)}`;
      const header = engagement ? `${indent}${arrow}${lead}. ${engagement}` : `${indent}${arrow}${lead}`;
      if (CONTAINER_TYPES.has(inner.type ?? "")) {
        if (selectUnitsPlural(selector)) {
          const nested = describeEffect(inner, depth + 2, selectedCtx);
          return `${header.replace(/\.$/, "")}:\n${indent}  ${depth + 1 > 0 ? "-> " : ""}For each selected ${selector.target_kind === "model" ? "model" : "unit"}:\n${nested}`;
        }
        return `${header.replace(/\.$/, "")}:\n` + describeEffect(inner, depth + 1, selectedCtx);
      }
      const nested = selectedRecipient(describeEffectInline(inner, selectedCtx), selector);
      return engagement
        ? `${header} ${capitalize(nested)}.`
        : `${header}: ${nested}.`;
    }
    case "leader-model-ability-grant":
      return `${indent}${arrow}${capitalize(leaderModelAbilityGrantClause(e, ctx))}.`;
    case "persistent-designation": {
      if (!persistentDesignationSupported(e))
        return `${indent}${arrow}[persistent-designation].`;
      const inner = e.consumer?.effect ?? {};
      const head = `${indent}${arrow}${capitalize(persistentDesignationLead(e))} ${persistentDesignationWhen(e)}`;
      if (CONTAINER_TYPES.has(inner.type ?? "")) {
        return `${head}:\n` + describeEffect(inner, depth + 1, ctx);
      }
      return `${head}, ${describeEffectInline(inner, ctx)}.`;
    }
    case "for-each-unit": {
      const inner = e.effect ?? {};
      const selectedCtx = selectedContext(ctx, e.selector ?? {});
      const lead = `For each ${forEachUnitSubject(e.selector)}`;
      if (CONTAINER_TYPES.has(inner.type ?? ""))
        return `${indent}${lead}:\n` + describeEffect(inner, depth + 1, selectedCtx);
      return `${indent}${lead}: ${capitalize(describeEffectInline(inner, selectedCtx))}.`;
    }
    case "designate-target": {
      const sel = (typeof e.select === "object" && e.select ? e.select : {}) as DesignationSelection;
      const desig = e.designation ? designationLabel(e.designation) : "";
      const applies = e.applies ?? {};
      const inner = applies.effect ?? {};
      // The mark's timing and duration are content: "After this unit shoots,
      // select …. Until your next Command phase, each time …".
      const selectLead = sel.timing ? `${capitalize(describeTiming(sel.timing))}, select` : "Select";
      const { trail: durTrail } = durationClauses(e.duration);
      const when =
        applies.to === "target"
          ? "while it is your target"
          : applies.to === "bearer-attacks-target"
            ? "each time this unit makes an attack against it"
            : applies.attacker_keywords?.length
              ? `each time a friendly ${applies.attacker_keywords.join(" ")} model makes an attack against it`
              : "each time a friendly unit makes an attack against it";
      const whenClause = durTrail ? `${capitalize(durTrail)}, ${when}` : capitalize(when);
      const head = `${indent}${arrow}${selectLead} one ${designationTargetSubject(sel)}${desig}. ${whenClause}`;
      if (CONTAINER_TYPES.has(inner.type ?? "")) {
        return `${head}:\n` + describeEffect(inner, depth + 1, ctx);
      }
      return `${head}, ${describeEffectInline(inner, ctx)}.`;
    }
    case "stance-select": {
      const when = typeof e.select === "string" ? capitalize(eventClause(e.select)) : "At the start of your turn";
      const consum = e.mode === "consumable" ? " (each may be chosen once per battle)" : "";
      const lines = [`${indent}${arrow}${when}, select one${consum}:`];
      for (const opt of e.options ?? []) {
        lines.push(`${indent}  - ${jstr(opt.name)}: ${describeEffectInline(opt.effect ?? {}, ctx)}.`);
      }
      return lines.join("\n");
    }
    case "risk-reward": {
      const risk = e.risk ?? {};
      const onFail = risk.on_fail ? describeEffectInline(risk.on_fail, ctx) : "there is a consequence";
      const reward = describeEffectInline(e.reward ?? {}, ctx);
      return `${indent}${arrow}First take a ${testName(risk.test)} test — on a failure, ${onFail}; then ${reward}.`;
    }
    case "issue-orders": {
      const n = e.count != null ? jstr(e.count) : "one or more";
      const rng = e.range != null ? ` within ${jstr(e.range)}"` : "";
      const elig = e.eligible?.keyword ? ` ${jstr(e.eligible.keyword)}` : "";
      const lines = [`${indent}${arrow}Issue up to ${n} Orders to eligible friendly${elig} units${rng}, each one of:`];
      for (const opt of e.options ?? []) {
        lines.push(`${indent}  - ${jstr(opt.name)}: ${describeEffectInline(opt.effect ?? {}, ctx)}.`);
      }
      return lines.join("\n");
    }
    case "resource-action-menu": {
      const su = sharedUsageClause(e.shared_usage);
      const intro = su ? `Actions may be performed when their conditions are met. ${capitalize(su)}` : "Actions may be performed when their conditions are met";
      const lines = [`${indent}${arrow}${intro}:`];
      for (const action of e.actions ?? []) {
        lines.push(`${indent}  - ${describeMenuAction(action, ctx)}`);
      }
      return lines.join("\n");
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
  const duration =
    s.duration === "until-next-battle-round"
      ? "until the start of the next battle round"
      : s.duration === "until-start-next-turn"
        ? "until the start of your next turn"
        : dekebab(s.duration ?? "");
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

/** The timing value of a bare `timing-is` condition, else undefined. */
function timingOfCondition(c?: Condition): string | undefined {
  return c?.type === "timing-is" ? jstr((c.parameters ?? {}).timing) : undefined;
}

/** The numeric range of a top-level within-range condition, else undefined. */
function conditionWithinRange(c?: Condition): number | undefined {
  if (c?.type !== "unit-within-range-of" && c?.type !== "opponent-unit-within-range") return undefined;
  const params = c.parameters ?? {};
  const r = params.range ?? params.range_inches ?? params.within_inches;
  return typeof r === "number" ? r : undefined;
}

function renderTopLevel(
  e: Effect,
  scope?: AbilityScope,
  usage?: AbilityUsage | null,
  trigger?: AbilityTriggerSpec | null,
): string {
  const ctx: Ctx = {
    rangeInches: auraRadius(scope),
    engagementRange: scope?.range === "engagement-range",
    scopeRange: scope?.range,
  };
  const { lead: durLead, trail } = durationClauses(scope?.duration);
  // An explicit usage limit supersedes the duration's coarse "once per battle" lead.
  const lead = usage && usage.frequency != null ? usageClause(usage) : durLead;

  // A reactive trigger (or several — the ability fires on any) opens the
  // sentence ("Each time …"). B2: when a trigger's proximity just restates a
  // within-range condition on the effect, render the range once (drop it here).
  const triggers = normalizeTriggers(trigger).filter((t) => t.event != null);
  const triggerEvents = new Set(triggers.map((t) => t.event));
  const condRange = conditionWithinRange(e.type === "conditional" ? e.condition : undefined);
  const trig = triggers
    .map((t) =>
      describeTrigger(condRange != null && t.proximity?.range === condRange ? { ...t, proximity: undefined } : t),
    )
    .filter((s) => s.length > 0)
    .join(" or ");

  if (e.type === "conditional") {
    const inner = e.effect ?? {};
    // B1: drop the condition lead-in when it merely restates a trigger's timing
    // (e.g. trigger start-of-phase + condition timing-is start-of-phase).
    const condTiming = timingOfCondition(e.condition);
    const leadIn = condTiming != null && triggerEvents.has(condTiming) ? "" : conditionLeadIn(e.condition ?? {});
    if (CONTAINER_TYPES.has(inner.type ?? "")) {
      // Block: "<trigger>[, <lead-in>][, <duration>]:" then the indented container.
      const header = [trig, lead, leadIn, trail].filter((p) => p.length > 0).join(", ");
      return capitalize(header) + ":\n" + describeEffect(inner, 1, ctx);
    }
    return assembleSentence([trig, lead, leadIn, trail, describeEffectInline(inner, ctx)]);
  }

  if (CONTAINER_TYPES.has(e.type ?? "")) {
    // Containers render block; a trigger/duration lead-in prefixes the block when
    // present. A designate-target carrying its own `duration` renders that
    // duration itself — repeating the scope duration in the head would double it.
    const ownDuration =
      (e.type === "designate-target" || e.type === "persistent-designation") && e.duration != null;
    const block = describeEffect(e, 0, ctx);
    const head = [trig, lead, ownDuration ? "" : trail].filter((p) => p.length > 0).join(", ");
    return head ? capitalize(head) + ":\n" + block : block;
  }

  return assembleSentence([trig, lead, trail, describeEffectInline(e, ctx)]);
}

/** Weapon qualifiers are conjunctive, and the owner remains a model or a unit. */
function weaponNoun(m: Record<string, unknown>): string {
  const kind = m.weapon_type ? `${jstr(m.weapon_type)} ` : "";
  const name = m.weapon_name ? `${jstr(m.weapon_name)} ` : "";
  const keyword = m.weapon_keyword ? ` with [${jstr(m.weapon_keyword).toUpperCase()}]` : "";
  return `${kind}${name}weapons${keyword}`;
}
function weaponHolder(target: string | undefined, ctx: Ctx): string {
  if (target === "self" || target === "bearer") return "this model";
  if (ctx.selectedModel) return "that model";
  if (target === "unit" || target === "attached-unit") return ctx.selectedUnit ? "models in that unit" : "models in this unit";
  return subject(target, ctx);
}
function weaponRollScope(m: Record<string, unknown>): string {
  if (m.weapon_type != null || m.weapon_name != null || m.weapon_keyword != null) return ` with ${weaponNoun(m)}`;
  if (m.attack_type != null && m.attack_type !== "any") return ` for ${jstr(m.attack_type)} attacks`;
  return "";
}
function leadershipTest(e: Effect, ctx: Ctx): string {
  const who = e.test?.subject === "self" ? "this model" : "that unit";
  const success = e.on_success ? describeEffectInline(e.on_success, ctx) : "nothing happens";
  const fail = e.on_fail ? `; otherwise, ${describeEffectInline(e.on_fail, ctx)}` : "";
  return `${who} takes a Leadership test (2D6, passing on its current Leadership or higher); if passed, ${success}${fail}`;
}
