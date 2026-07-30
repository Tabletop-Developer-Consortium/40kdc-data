/**
 * Translate an Ability DSL `effect` tree into the {@link Buff} stack it
 * contributes (for an attacker-perspective crunch) along with a list of
 * effect fragments the translator could not auto-apply.
 *
 * The buff layer is intentionally a subset of the DSL: it covers the math the
 * cruncher's expected-value engine reads (rerolls, die-roll modifiers, S/A/T
 * stat shifts, FNP, granted weapon keywords, cover) and reports everything
 * else — choice nodes (player decisions), dice-gated effects (stochastic),
 * defender-side bs-modifier, attack-restrictions, ability grants, mortal
 * wound triggers — as `unsupported` so the SPA can surface "this ability has
 * effects we can't auto-apply" rather than silently dropping them.
 *
 * The walker classifies an effect's `target` against the attacker
 * perspective: `self`, `bearer`, `unit`, `attached-unit`, `attacker`, and
 * `friendly-within-aura` are all treated as "applies to my unit". `defender`,
 * `enemy-within-aura`, and `all-enemy` are dropped without being marked
 * unsupported — those are defender-side mods and would surface from the
 * target's perspective (M3 work), not the attacker's.
 *
 * @packageDocumentation
 */
import type {
  Buff,
  BuffApplicability,
  BuffContribution,
  BuffSource,
  EngineContext,
  WeaponKeywordRef,
} from "./buffs.js";
import type { Phase } from "../generated.js";

/** A fragment we couldn't translate. The SPA can render these as warnings. */
export type UnsupportedFragment = {
  reason: string;
  effectFragment: unknown;
};

/**
 * A mutually-limited pool of {@link ActivatableBuff} levers. Dice-pool
 * allocations cap how many options fire at once (`max_activations`); a `choice`
 * lets the player pick exactly one. Levers sharing a `group.id` are subject to
 * that cap — the SPA greys out further checkboxes once it's reached, and an
 * optimizer enumerates subsets within it.
 */
export type ActivatableGroupRef = {
  id: string;
  maxActivations: number;
};

/**
 * A buff-bearing *player decision* the cruncher can't make on its own: a
 * dice-pool option, a `choice` branch, or an activation gated on a timing the
 * player controls (e.g. "start of phase"). It is not auto-applied — the
 * consumer opts in (a checkbox, or an optimizer's search) and then folds
 * {@link buffs} into the crunch. Conditions the activation still carries (a
 * target keyword, a phase) ride on each buff's `applicableWhen`, so the
 * resolver gates them per-target rather than the lever vanishing.
 */
export type ActivatableBuff = {
  /** Stable toggle id, e.g. `"blessings-of-khorne#Warp Blades"`. */
  id: string;
  /** Human label for the lever (option name, or a summary of its buffs). */
  label: string;
  /** Contributions this activation adds when the player opts in (≥1). */
  buffs: Buff[];
  /** Set when the lever belongs to a mutually-limited pool. */
  group?: ActivatableGroupRef;
};

export type EffectTranslation = {
  applied: Buff[];
  unsupported: UnsupportedFragment[];
  /** Buffs sitting behind a player decision — see {@link ActivatableBuff}. */
  activatable: ActivatableBuff[];
};

/**
 * Whose perspective the translation runs from.
 *
 * - `"attacker"`: the buffed unit is *firing*. `target: "unit"/"self"` etc.
 *   become attacker-side mods (re-rolls, hit/wound mods, A/S shifts, granted
 *   keywords). `target: "defender"` is silently dropped — that's incoming
 *   penalty math relevant when the buffed unit is the *target*, surfaced via
 *   the `"target"` perspective instead.
 *
 * - `"target"`: the buffed unit is *being shot at*. Defensive mods on the
 *   buffed unit (`stat-modifier T`, `stat-modifier Sv`, `feel-no-pain`,
 *   `roll-modifier save`) become defender-side buffs. Conversely, attacker-
 *   only mods (re-rolls, hit/wound mods, A/S shifts) drop silently because
 *   they describe what the buffed unit does when *attacking*.
 *
 * The bs-modifier effect (a -1 to incoming hit rolls, e.g. Benefit of Cover)
 * becomes a `hit-mod` buff under target perspective so it stacks correctly
 * with attacker-side modifiers in the resolver's ±1 cap.
 */
export type TranslationPerspective = "attacker" | "target";

/** Targets that resolve to the buffed unit itself. */
const SELF_TARGETS = new Set([
  "self",
  "bearer",
  "unit",
  "attached-unit",
  "friendly-within-aura",
  "all-friendly",
]);

/** Aliases the DSL uses when a node specifically calls out "the attacker". */
const ATTACKER_TARGET = "attacker";
/** Aliases the DSL uses when a node specifically calls out "the defender". */
const DEFENDER_TARGETS = new Set(["defender", "enemy-within-aura", "all-enemy"]);

/**
 * Walk an ability DSL `effect` tree and produce the buff stack it contributes
 * against `context` from the given `perspective`, plus an `unsupported` list
 * naming any branches the buff layer can't express today.
 */
export function effectToBuffs(
  effect: unknown,
  source: BuffSource,
  context: EngineContext,
  perspective: TranslationPerspective = "attacker",
): EffectTranslation {
  const out: EffectTranslation = { applied: [], unsupported: [], activatable: [] };
  const abilityId = source.kind === "ability" ? source.abilityId : "effect";
  walk(effect, source, { context, perspective, abilityId }, out);
  return out;
}

type WalkOpts = {
  context: EngineContext;
  perspective: TranslationPerspective;
  /** Owning ability id — seeds the stable ids of activatable levers. */
  abilityId: string;
};

function walk(
  node: unknown,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  if (!isObject(node)) return;
  const type = node.type;
  switch (type) {
    case "re-roll":
      translateReroll(node, source, opts, out);
      return;
    case "roll-modifier":
      translateRollModifier(node, source, opts, out);
      return;
    case "stat-modifier":
      translateStatModifier(node, source, opts, out);
      return;
    case "feel-no-pain":
      translateFeelNoPain(node, source, opts, out);
      return;
    case "keyword-grant":
      translateKeywordGrant(node, source, opts, out);
      return;
    case "bs-modifier":
      translateBsModifier(node, source, opts, out);
      return;
    case "damage-reduction":
      translateDamageReduction(node, source, opts, out);
      return;
    case "invulnerable-save":
      translateInvulnerableSave(node, source, opts, out);
      return;
    case "conditional":
      translateConditional(node, source, opts, out);
      return;
    case "sequence":
      for (const step of (node.steps as unknown[]) ?? []) walk(step, source, opts, out);
      return;
    case "choice":
      // Player decision — each branch becomes an opt-in lever (pick one).
      enumerateChoice(node, source, opts, out);
      return;
    case "dice-gated":
      // Probabilistic; the buff layer is deterministic.
      out.unsupported.push({
        reason: "dice-gated effect: stochastic; not expressible as a buff",
        effectFragment: node,
      });
      return;
    case "dice-pool-allocation":
      // Player spends dice on options at runtime — each buff-bearing option
      // becomes an opt-in lever, grouped under the pool's activation cap.
      enumerateDicePool(node, source, opts, out);
      return;
    case "select-units":
      // Targeting wrapper — the selected units receive the nested effect.
      walk(node.effect, source, opts, out);
      return;
    case "designate-target": {
      // Mark an enemy unit; when `to: attackers-of-target` the nested effect is
      // a buff every friendly attack against that unit receives (Oath of Moment).
      // A `to: target` debuff lands on the enemy, not the bearer, so it is not a
      // buff in this perspective.
      const applies = isObject(node.applies) ? node.applies : {};
      if (applies.to === "attackers-of-target") {
        walk(applies.effect, source, opts, out);
      } else {
        out.unsupported.push({
          reason: "designate-target debuff on the marked unit: not a buff on the bearer",
          effectFragment: node,
        });
      }
      return;
    }
    case "risk-reward":
      // The reward is the buff; the risk (self-damage on a failed test) is not.
      walk(node.reward, source, opts, out);
      return;
    case "stance-select":
      // Pick-one modal buff — each option is an opt-in lever (pick one).
      enumerateNamedOptions(node, source, opts, out, `${opts.abilityId}?stance`, 1);
      return;
    case "issue-orders":
      // Officer issues one Order from the menu — each is an opt-in lever.
      enumerateNamedOptions(node, source, opts, out, `${opts.abilityId}?order`, 1);
      return;
    case "resource-action-menu":
      // Each action is an INDEPENDENT reactive lever, not a pick-one group:
      // unlike stance-select/issue-orders, multiple actions (and repeats of
      // the same action by different units — see `usage.repeatable_if_different_unit`)
      // can fire in the same phase, so no shared `group`/`maxActivations` cap
      // is attached here.
      enumerateMenuActions(node, source, opts, out);
      return;
    default:
      // Unknown effect — record it. Covers ability-grant, deep-strike,
      // mortal-wounds, cp-gain, movement-modifier, etc.; the buff layer
      // doesn't model these as deterministic mods to a single shot.
      out.unsupported.push({
        reason: `effect type "${String(type)}" is not modelled by the buff layer`,
        effectFragment: node,
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Leaf translators
// ---------------------------------------------------------------------------

/**
 * Classify a node's `target` field against the perspective we're translating
 * for. Returns:
 *  - `"self"`: the node targets the buffed unit (apply attacker-side or
 *    defender-side translation, depending on perspective + stat).
 *  - `"attacker"` / `"defender"`: the node targets the other party explicitly.
 *  - `"unknown"`: missing/malformed target.
 */
function classifyTarget(
  node: Record<string, unknown>,
): "self" | "attacker" | "defender" | "unknown" {
  const target = node.target;
  if (typeof target !== "string") return "unknown";
  if (target === ATTACKER_TARGET) return "attacker";
  if (DEFENDER_TARGETS.has(target)) return "defender";
  if (SELF_TARGETS.has(target)) return "self";
  return "unknown";
}

/**
 * Does this node's target match the buffed unit under the current
 * perspective? Used for symmetric roll/keyword translations where the same
 * effect is "self" in either direction.
 */
function appliesToBuffedUnit(
  node: Record<string, unknown>,
  perspective: TranslationPerspective,
): boolean {
  const cls = classifyTarget(node);
  if (cls === "self") return true;
  if (cls === "attacker") return perspective === "attacker";
  if (cls === "defender") return perspective === "target";
  return false;
}

function translateReroll(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  // Rerolls are inherently attacker-side (you re-roll your own hit/wound/
  // damage; save rerolls fire when *you* are the target). Apply only under
  // the matching perspective so a target-perspective walk doesn't grab the
  // attacker's reroll-failed-hits buff.
  if (opts.perspective === "attacker" && !appliesToBuffedUnit(node, "attacker")) return;
  const modifier = node.modifier;
  if (!isObject(modifier)) {
    out.unsupported.push({ reason: "re-roll: missing modifier object", effectFragment: node });
    return;
  }
  const narrowed = unhonorableNarrowing(modifier);
  if (narrowed) {
    out.unsupported.push({ reason: `re-roll: narrows by "${narrowed}" which the cruncher can't resolve here`, effectFragment: node });
    return;
  }
  const roll = modifier.roll;
  // A `value: 1` on a re-roll modifier unambiguously means "re-roll rolls of 1".
  // A historical migration (2026-weapon-keywords) mis-defaulted such nodes to
  // `subset: "all-failures"`; honor the value as the source of truth so any
  // stray data of that shape can't silently over-apply the reroll.
  const subset = modifier.value === 1 ? "ones" : modifier.subset;
  // Under target perspective, only "save" rerolls fire on the buffed unit.
  if (opts.perspective === "target" && roll !== "save") return;
  if (
    (roll === "hit" || roll === "wound" || roll === "save" || roll === "damage") &&
    (subset === "ones" || subset === "all-failures")
  ) {
    out.applied.push({ source, contribution: { type: "reroll", roll, subset } });
    return;
  }
  out.unsupported.push({
    reason: `re-roll on "${String(roll)}" (subset "${String(subset)}") is outside the damage path`,
    effectFragment: node,
  });
}

function translateRollModifier(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const modifier = node.modifier;
  if (!isObject(modifier)) {
    out.unsupported.push({
      reason: "roll-modifier: missing modifier object",
      effectFragment: node,
    });
    return;
  }
  const narrowed = unhonorableNarrowing(modifier);
  if (narrowed) {
    out.unsupported.push({ reason: `roll-modifier: narrows by "${narrowed}" which the cruncher can't resolve here`, effectFragment: node });
    return;
  }
  const value = signedValue(modifier);
  if (value === null) {
    out.unsupported.push({
      reason: `roll-modifier: operation "${String(modifier.operation)}" not supported`,
      effectFragment: node,
    });
    return;
  }
  const roll = modifier.roll;
  // Each roll type is intrinsically on one side. Hit / wound / damage are
  // attacker-side; save is defender-side. The perspective decides whether the
  // buffed unit's `target` is the right party for that roll type.
  if (opts.perspective === "attacker") {
    if (!appliesToBuffedUnit(node, "attacker")) return;
    if (roll === "save") return; // saves apply to the defender, not the attacker.
  } else {
    // Target perspective accepts two shapes:
    //  - `target: "self"/"unit"/...` + `roll: "save"` — the buffed unit's
    //    own save rolls (mirrors the attacker path's reroll/stat handling).
    //  - `target: "attacker"` + `roll: "hit"/"wound"` — a defender-side
    //    rule that penalises the *incoming* attacker's hit/wound rolls (e.g.
    //    "subtract 1 from hit rolls targeting this unit"). Functionally
    //    identical to a `bs-modifier {target:"attacker"}` but with the
    //    canonical `roll-modifier` shape; the data uses both forms.
    const cls = classifyTarget(node);
    if (cls === "attacker") {
      if (roll !== "hit" && roll !== "wound") return; // damage/save against the attacker make no sense here.
    } else if (cls === "self") {
      if (roll !== "save") return;
    } else {
      return;
    }
  }
  switch (roll) {
    case "hit":
      out.applied.push({ source, contribution: { type: "hit-mod", value } });
      return;
    case "wound":
      out.applied.push({ source, contribution: { type: "wound-mod", value } });
      return;
    case "save":
      out.applied.push({ source, contribution: { type: "save-mod", value } });
      return;
    case "damage":
      out.applied.push({ source, contribution: { type: "damage-mod", value } });
      return;
    default:
      out.unsupported.push({
        reason: `roll-modifier on "${String(roll)}" is outside the damage path`,
        effectFragment: node,
      });
  }
}

function translateStatModifier(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const modifier = node.modifier;
  if (!isObject(modifier)) {
    out.unsupported.push({
      reason: "stat-modifier: missing modifier object",
      effectFragment: node,
    });
    return;
  }
  const narrowed = unhonorableNarrowing(modifier);
  if (narrowed) {
    out.unsupported.push({ reason: `stat-modifier: narrows by "${narrowed}" which the cruncher can't resolve here`, effectFragment: node });
    return;
  }
  const stat = modifier.stat;
  const isOnBuffedUnit = appliesToBuffedUnit(node, opts.perspective);
  // `attack_type: melee|ranged` scopes the mod to that attack — express it as a
  // phase gate so e.g. a melee +1 Attack doesn't fire in the shooting phase.
  const applicability = attackTypeApplicability(modifier);
  const emit = (contribution: BuffContribution): void => {
    const buff: Buff = { source, contribution };
    out.applied.push(applicability ? { ...buff, applicableWhen: applicability } : buff);
  };

  // AP has an inverted sign convention (stored negative; more negative = more
  // piercing) and offensive/defensive variants, so it computes its own delta
  // and routes by attacker/defender rather than going through `signedValue`.
  if (stat === "AP") {
    translateApModifier(node, modifier, opts, out, emit);
    return;
  }

  const value = signedValue(modifier);
  if (value === null) {
    out.unsupported.push({
      reason: `stat-modifier: operation "${String(modifier.operation)}" not supported`,
      effectFragment: node,
    });
    return;
  }
  switch (stat) {
    case "A":
      if (opts.perspective !== "attacker" || !isOnBuffedUnit) return;
      emit({ type: "attacks-mod", value });
      return;
    case "S":
      if (opts.perspective !== "attacker" || !isOnBuffedUnit) return;
      emit({ type: "strength-mod", value });
      return;
    case "T":
      // Defender stat. Only relevant under target perspective.
      if (opts.perspective !== "target") {
        out.unsupported.push({
          reason: "stat-modifier T: defender-side stat; applies when the buffed unit is the target",
          effectFragment: node,
        });
        return;
      }
      if (!isOnBuffedUnit) return;
      emit({ type: "toughness-mod", value });
      return;
    case "Sv":
      // Saves improve when the *defender* gets +Sv. A +1 to Sv in printed
      // rules means "improve the save by 1", which maps to a `save-mod` of
      // `-value` since save-mod is signed against the *needed roll*.
      // (Equivalent: a -1 Sv penalty is a +1 save-mod.) We translate
      // "Sv add 1" → save-mod -1 to keep the resolver's sign convention.
      if (opts.perspective !== "target") {
        out.unsupported.push({
          reason: "stat-modifier Sv: defender-side stat; applies when the buffed unit is the target",
          effectFragment: node,
        });
        return;
      }
      if (!isOnBuffedUnit) return;
      emit({ type: "save-mod", value: -value });
      return;
    default:
      out.unsupported.push({
        reason: `stat-modifier on "${String(stat)}" is outside the damage path`,
        effectFragment: node,
      });
  }
}

/**
 * Translate an `AP` stat-modifier. AP rides on the attacker's weapon profile and
 * is stored as a negative number (e.g. AP -1); more negative = more piercing.
 *
 * Two variants exist in the data:
 *  - **offensive** (`target` self/unit): the buffed unit's own weapons gain AP —
 *    an attacker-side `ap-mod`. `improve N` → `-N` (more piercing), `worsen N` →
 *    `+N`, and the legacy `add`/`subtract` forms (which already pass a signed,
 *    usually negative, value) flow through `apDelta` unchanged.
 *  - **defensive** (`target: "attacker"`): "enemy weapons targeting this unit
 *    have AP worsened". This applies when the buffed unit is the *target*; we do
 *    not model it as an attacker-side buff (that would wrongly weaken the buffed
 *    unit's own attacks), so it is surfaced as `unsupported`.
 */
function translateApModifier(
  node: Record<string, unknown>,
  modifier: Record<string, unknown>,
  opts: WalkOpts,
  out: EffectTranslation,
  emit: (contribution: BuffContribution) => void,
): void {
  if (classifyTarget(node) === "attacker") {
    out.unsupported.push({
      reason:
        "stat-modifier AP on the attacker: defender-side AP reduction is not modelled by the buff layer",
      effectFragment: node,
    });
    return;
  }
  if (opts.perspective !== "attacker" || !appliesToBuffedUnit(node, "attacker")) return;
  const delta = apDelta(modifier);
  if (delta === null) {
    out.unsupported.push({
      reason: `stat-modifier AP: operation "${String(modifier.operation)}" not supported`,
      effectFragment: node,
    });
    return;
  }
  emit({ type: "ap-mod", value: delta });
}

function translateFeelNoPain(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  // FNP applies when the buffed unit is the *target* — it ablates incoming
  // damage. Under attacker perspective the FNP is irrelevant (the unit is
  // firing, not taking damage). Drop silently rather than as `unsupported`
  // so attacker-perspective walks don't surface a spurious diagnostic for
  // every unit that happens to have a FNP rule.
  if (opts.perspective !== "target") return;
  const modifier = node.modifier;
  if (!isObject(modifier)) {
    out.unsupported.push({
      reason: "feel-no-pain: missing modifier object",
      effectFragment: node,
    });
    return;
  }
  const threshold = Number(modifier.threshold);
  if (!Number.isFinite(threshold)) {
    out.unsupported.push({
      reason: "feel-no-pain: threshold not numeric",
      effectFragment: node,
    });
    return;
  }
  // `modifier.scope` ∈ {"all", "mortal", "psychic", "psychic-and-mortal"}
  // (default "all"). Schema's `modifier` is `additionalProperties: true`, so
  // any string lands here; we accept the documented values and route
  // everything else to unsupported so a typo ("mortals", "mortal-wound")
  // can't silently masquerade as an all-FNP. `psychic-and-mortal` folds into
  // the mortal stream (its mortal-wound coverage is exact; the psychic-attack
  // half is invisible to the buff layer); bare `psychic` has no stream to
  // attach to, so it stays unsupported rather than overstating defence.
  const rawScope = modifier.scope;
  let scope: "all" | "mortal" = "all";
  if (rawScope !== undefined) {
    if (rawScope === "all" || rawScope === "mortal") {
      scope = rawScope;
    } else if (rawScope === "psychic-and-mortal") {
      scope = "mortal";
    } else if (rawScope === "psychic") {
      out.unsupported.push({
        reason: 'feel-no-pain: scope "psychic" (psychic attacks are not tracked by the buff layer)',
        effectFragment: node,
      });
      return;
    } else {
      out.unsupported.push({
        reason: `feel-no-pain: unrecognised scope "${String(rawScope)}" (expected "all" or "mortal")`,
        effectFragment: node,
      });
      return;
    }
  }
  const contribution =
    scope === "mortal"
      ? ({ type: "feel-no-pain", threshold, scope: "mortal" } as const)
      : ({ type: "feel-no-pain", threshold } as const);
  out.applied.push({ source, contribution });
}

function translateKeywordGrant(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  // Weapon-keyword grants ride with the attacker's profile (e.g. "your
  // weapons gain [Sustained Hits 1]"). Defender-perspective walks ignore
  // them — the keyword applies when the buffed unit fires, not when it's
  // shot at.
  if (opts.perspective !== "attacker") return;
  if (!appliesToBuffedUnit(node, "attacker")) return;
  const modifier = node.modifier;
  if (!isObject(modifier)) return;
  // The DSL grants keywords in two shapes: a singular `keyword` string (often
  // with a `weapon_type`) or a `keywords` array. Accept both.
  const raws = keywordGrantList(modifier);
  if (raws.length === 0) return;
  // `weapon_type: melee|ranged` scopes the grant to that attack — a melee-only
  // keyword shouldn't fire in the shooting phase. Express it as a phase gate.
  const applicability = weaponTypeApplicability(modifier);
  for (const raw of raws) {
    const ref = parseKeywordGrant(raw);
    if (!ref) {
      out.unsupported.push({
        reason: `keyword-grant: cannot parse "${raw}" to a catalog keyword`,
        effectFragment: { keyword: raw },
      });
      continue;
    }
    const buff: Buff = { source, contribution: { type: "extra-keyword", keywordRef: ref } };
    out.applied.push(applicability ? { ...buff, applicableWhen: applicability } : buff);
  }
}

/** Normalise a keyword-grant modifier's singular `keyword` and/or `keywords` array. */
function keywordGrantList(modifier: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof modifier.keyword === "string") out.push(modifier.keyword);
  if (Array.isArray(modifier.keywords)) {
    for (const k of modifier.keywords) if (typeof k === "string") out.push(k);
  }
  return out;
}

/** Map a keyword-grant's `weapon_type` to the phase its weapons fire in. */
function weaponTypeApplicability(modifier: Record<string, unknown>): BuffApplicability | undefined {
  if (modifier.weapon_type === "melee") return { phases: ["fight"] };
  if (modifier.weapon_type === "ranged") return { phases: ["shooting"] };
  return undefined;
}

/**
 * Map a stat-modifier's `attack_type` (or the equivalent `weapon_type`) to the
 * phase that attack happens in. Both spellings carry the same melee/ranged
 * intent; honoring `weapon_type` lets a "+1 A to melee weapons" mod phase-gate
 * correctly instead of leaking into the shooting phase.
 */
function attackTypeApplicability(modifier: Record<string, unknown>): BuffApplicability | undefined {
  const kind = modifier.attack_type ?? modifier.weapon_type;
  if (kind === "melee") return { phases: ["fight"] };
  if (kind === "ranged") return { phases: ["shooting"] };
  return undefined;
}

/**
 * Narrowing keys that scope a buff to a named weapon or a model subset the
 * cruncher can't resolve at translation time (it has no weapon/model context
 * here). When present on a damage-path leaf, applying the buff unfiltered would
 * silently OVER-APPLY it, so we surface it as `unsupported` instead — the data
 * stays faithful for other consumers; the optimizer just doesn't assume it.
 * `weapon_type`/`attack_type` are NOT here — those map cleanly to a phase gate.
 */
const UNHONORABLE_NARROWING = ["weapon_name", "weapon_profile", "weapon_keyword", "weapon_filter", "model_filter", "model_scope"];
function unhonorableNarrowing(modifier: Record<string, unknown>): string | undefined {
  return UNHONORABLE_NARROWING.find((k) => modifier[k] != null);
}

/**
 * Defender-side damage-reduction (`{type: "damage-reduction", modifier:
 * {reduction: N | "half" | "to-zero"}}`). The buff layer only models the
 * additive numeric form — `"half"` and `"to-zero"` are one-use ablation
 * effects that don't fold into a deterministic expected-value crunch, so
 * they surface as `unsupported`. Attacker-perspective walks drop silently
 * (this is a defender stat).
 */
function translateDamageReduction(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  if (opts.perspective !== "target") return;
  if (!appliesToBuffedUnit(node, "target")) return;
  const modifier = node.modifier;
  if (!isObject(modifier)) {
    out.unsupported.push({
      reason: "damage-reduction: missing modifier object",
      effectFragment: node,
    });
    return;
  }
  const reduction = modifier.reduction;
  if (typeof reduction === "number" && Number.isFinite(reduction) && reduction > 0) {
    out.applied.push({ source, contribution: { type: "damage-reduction", value: reduction } });
    return;
  }
  if (reduction === "half" || reduction === "to-zero") {
    out.unsupported.push({
      reason: `damage-reduction: "${reduction}" is a one-use ablation effect, not modelled by the expected-value engine`,
      effectFragment: node,
    });
    return;
  }
  out.unsupported.push({
    reason: `damage-reduction: unrecognised reduction "${String(reduction)}"`,
    effectFragment: node,
  });
}

/**
 * Defender-side ability-granted invulnerable save (`{type: "invulnerable-save",
 * modifier: {invuln_sv: N}}`). Best (lowest threshold) wins, combined with the
 * unit's printed invuln by the engine. Attacker-perspective walks drop
 * silently (this is a defender stat).
 */
function translateInvulnerableSave(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  if (opts.perspective !== "target") return;
  if (!appliesToBuffedUnit(node, "target")) return;
  const modifier = node.modifier;
  if (!isObject(modifier)) {
    out.unsupported.push({
      reason: "invulnerable-save: missing modifier object",
      effectFragment: node,
    });
    return;
  }
  const threshold = Number(modifier.invuln_sv);
  if (!Number.isFinite(threshold) || threshold < 2 || threshold > 7) {
    out.unsupported.push({
      reason: `invulnerable-save: invuln_sv "${String(modifier.invuln_sv)}" is not a valid save threshold (2–7)`,
      effectFragment: node,
    });
    return;
  }
  out.applied.push({ source, contribution: { type: "invulnerable-save", threshold } });
}

function translateBsModifier(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  // A bs-modifier on `target: "attacker"` is a defender-side rule: it
  // penalises *incoming* hit rolls (e.g. Benefit of Cover). Translate it
  // as a `hit-mod` buff under target perspective so the resolver's ±1 cap
  // composes with attacker-side mods.
  if (opts.perspective !== "target") return;
  const cls = classifyTarget(node);
  if (cls !== "attacker") return; // a bs-modifier on self wouldn't make sense.
  const modifier = node.modifier;
  if (!isObject(modifier)) return;
  const value = signedValue(modifier);
  if (value === null) return;
  out.applied.push({ source, contribution: { type: "hit-mod", value } });
}

function translateConditional(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const condition = node.condition;
  const effect = node.effect;
  if (!isObject(condition)) return;
  const negated = condition.negated === true;
  const verdict = evaluateCondition(condition, opts.context);
  if (verdict === "unknown") {
    // A timing the player controls (e.g. "start of phase") isn't a wall — it's
    // an activation the player can opt into. Surface it as a lever rather than
    // dropping it. Other unevaluatable conditions stay unsupported.
    if (conditionMentionsTiming(condition)) {
      enumerateTimingGate(node, source, opts, out);
    } else {
      out.unsupported.push({
        reason: `conditional: cannot evaluate condition "${String(condition.type)}" against current context`,
        effectFragment: node,
      });
    }
    return;
  }
  const active = negated ? !verdict : verdict;
  if (!active) return;
  walk(effect, source, opts, out);
}

// ---------------------------------------------------------------------------
// Activatable-lever enumeration
//
// Player-controlled gates — a `timing-is` the context can't pin down, each
// `dice-pool-allocation` option, each `choice` branch — aren't walls for a
// damage optimizer; they're the search space. Instead of dropping them to
// `unsupported`, we descend through them and surface every buff-bearing branch
// as an opt-in {@link ActivatableBuff}. The descent reuses the normal leaf
// translators (so a lever applies exactly what it advertises) and turns the
// conditions a branch still carries (target keyword, phase) into declarative
// `applicableWhen` so the resolver gates them per-target.
// ---------------------------------------------------------------------------

/** Emit one lever per `choice` branch that yields a buff (pick exactly one). */
function enumerateChoice(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const options = Array.isArray(node.options) ? node.options : [];
  options.forEach((opt, i) => {
    const buffs: Buff[] = [];
    collectGatedBuffs(opt, source, opts, {}, buffs);
    if (buffs.length === 0) return;
    out.activatable.push({
      id: `${opts.abilityId}?${i}`,
      label: labelForBuffs(buffs),
      buffs,
      group: { id: `${opts.abilityId}?choice`, maxActivations: 1 },
    });
  });
}

/** Emit one lever per buff-bearing dice-pool option, capped by `max_activations`. */
function enumerateDicePool(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const options = Array.isArray(node.options) ? node.options : [];
  const maxActivations =
    typeof node.max_activations === "number" ? node.max_activations : options.length;
  for (const opt of options) {
    if (!isObject(opt)) continue;
    const buffs: Buff[] = [];
    collectGatedBuffs(opt.effect, source, opts, {}, buffs);
    if (buffs.length === 0) continue;
    const name = typeof opt.name === "string" && opt.name ? opt.name : labelForBuffs(buffs);
    out.activatable.push({
      id: `${opts.abilityId}#${name}`,
      label: name,
      buffs,
      group: { id: opts.abilityId, maxActivations },
    });
  }
}

/** Emit one opt-in lever per buff-bearing named option (stance-select / issue-orders). */
function enumerateNamedOptions(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
  groupId: string,
  maxActivations: number,
): void {
  const options = Array.isArray(node.options) ? node.options : [];
  for (const opt of options) {
    if (!isObject(opt)) continue;
    const buffs: Buff[] = [];
    collectGatedBuffs(opt.effect, source, opts, {}, buffs);
    if (buffs.length === 0) continue;
    const name = typeof opt.name === "string" && opt.name ? opt.name : labelForBuffs(buffs);
    out.activatable.push({
      id: `${opts.abilityId}#${name}`,
      label: name,
      buffs,
      group: { id: groupId, maxActivations },
    });
  }
}

/**
 * Emit one opt-in lever per buff-bearing `resource-action-menu` action.
 * Unlike {@link enumerateNamedOptions} (stance-select / issue-orders, a
 * pick-one group), each action here is an INDEPENDENT decision with its own
 * trigger and cost — no shared `group`/`maxActivations` cap, since a unit's
 * per-phase manoeuvre limit isn't a mutual-exclusion pool the cruncher can
 * enforce (and `usage.repeatable_if_different_unit` explicitly allows the
 * same action to recur via a different unit in one phase). A single
 * `eligibility.requires_keyword` narrows the lever to attackers carrying that
 * keyword; multiple required keywords have no single-field applicability
 * representation today and are left ungated (correctness-conservative: the
 * lever still surfaces, just without that extra restriction attached).
 */
function enumerateMenuActions(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const actions = Array.isArray(node.actions) ? node.actions : [];
  for (const action of actions) {
    if (!isObject(action)) continue;
    const eligibility = isObject(action.eligibility) ? action.eligibility : undefined;
    const requiresKeyword = eligibility && Array.isArray(eligibility.requires_keyword) ? eligibility.requires_keyword : undefined;
    const applicability: BuffApplicability =
      requiresKeyword?.length === 1 && typeof requiresKeyword[0] === "string"
        ? { requiresAttackerKeyword: requiresKeyword[0] }
        : {};
    const buffs: Buff[] = [];
    collectGatedBuffs(action.effect, source, opts, applicability, buffs);
    if (buffs.length === 0) continue;
    const label = typeof action.label === "string" && action.label ? action.label : labelForBuffs(buffs);
    const id = typeof action.id === "string" && action.id ? action.id : label;
    out.activatable.push({ id: `${opts.abilityId}#${id}`, label, buffs });
  }
}

/**
 * Surface a timing-gated activation. The timing itself is just "when" — opting
 * in satisfies it — so we descend into the body: an inner `dice-pool-allocation`
 * or `choice` surfaces its *own* option levers (e.g. Blessings of Khorne's
 * three keyword grants), while inner always-on buffs bundle into a single
 * timing lever. A body with no modelable combat buff (a `resurrection` or
 * `dice-gated`, like Berzerker Frenzy) yields nothing.
 */
function enumerateTimingGate(
  node: Record<string, unknown>,
  source: BuffSource,
  opts: WalkOpts,
  out: EffectTranslation,
): void {
  const condition = node.condition;
  if (!isObject(condition)) return;
  const sub: EffectTranslation = { applied: [], unsupported: [], activatable: [] };
  walk(node.effect, source, opts, sub);
  // Inner independent decisions (dice-pool options, choice branches) pass
  // straight through as their own levers.
  out.activatable.push(...sub.activatable);
  // Inner unconditional buffs become one lever gated only on the timing.
  if (sub.applied.length > 0) {
    const timing = extractTiming(condition) ?? "timing";
    out.activatable.push({
      id: `${opts.abilityId}@${timing}`,
      label: labelForBuffs(sub.applied),
      buffs: sub.applied,
    });
  }
}

/**
 * Walk the body of a player gate, collecting the buffs it would contribute.
 * Conditions are deferred to `applicableWhen` where expressible; nested
 * decisions and stochastic rolls inside an activation are not modelled.
 */
function collectGatedBuffs(
  node: unknown,
  source: BuffSource,
  opts: WalkOpts,
  applicability: BuffApplicability,
  outBuffs: Buff[],
): void {
  if (!isObject(node)) return;
  switch (node.type) {
    case "conditional": {
      const condition = node.condition;
      if (!isObject(condition)) return;
      const app = conditionToApplicability(condition);
      if (app === "gate") {
        // A nested timing gate: opting into the activation satisfies it, so
        // keep descending without adding a constraint.
        collectGatedBuffs(node.effect, source, opts, applicability, outBuffs);
        return;
      }
      if (app === "context") {
        // Can't express as a buff gate — fall back to the current context and
        // only descend when the condition is definitely active.
        if (evaluateCondition(condition, opts.context) === true) {
          collectGatedBuffs(node.effect, source, opts, applicability, outBuffs);
        }
        return;
      }
      collectGatedBuffs(node.effect, source, opts, combineApplicability(applicability, app), outBuffs);
      return;
    }
    case "sequence":
      for (const step of (node.steps as unknown[]) ?? []) {
        collectGatedBuffs(step, source, opts, applicability, outBuffs);
      }
      return;
    case "choice":
    case "dice-pool-allocation":
    case "dice-gated":
      // A decision (or stochastic roll) nested inside an activation. The outer
      // lever already stands for a player choice; we don't model the inner one.
      return;
    default: {
      // Leaf effect — run the normal leaf translators into a throwaway sink,
      // then attach the accumulated applicability so target/phase gating
      // defers to the resolver instead of vanishing the lever.
      const tmp: EffectTranslation = { applied: [], unsupported: [], activatable: [] };
      walk(node, source, opts, tmp);
      for (const b of tmp.applied) outBuffs.push(applyApplicability(b, applicability));
      return;
    }
  }
}

/** Does this condition (or any operand) gate on a player-controlled timing? */
function conditionMentionsTiming(condition: Record<string, unknown>): boolean {
  if (condition.type === "timing-is") return true;
  if (typeof condition.operator === "string" && Array.isArray(condition.operands)) {
    return condition.operands.some((o) => isObject(o) && conditionMentionsTiming(o));
  }
  return false;
}

/** Pull the first `timing-is` timing value out of a (possibly compound) condition. */
function extractTiming(condition: Record<string, unknown>): string | undefined {
  if (condition.type === "timing-is") {
    const t = (condition.parameters as Record<string, unknown> | undefined)?.timing;
    return typeof t === "string" ? t : undefined;
  }
  if (Array.isArray(condition.operands)) {
    for (const o of condition.operands) {
      if (isObject(o)) {
        const t = extractTiming(o);
        if (t) return t;
      }
    }
  }
  return undefined;
}

/**
 * Translate a condition into a {@link BuffApplicability} the resolver can gate
 * on. Returns `"gate"` for a player-controlled timing (satisfied by opting in),
 * or `"context"` when the condition has no declarative buff representation and
 * must fall back to context evaluation.
 */
function conditionToApplicability(
  condition: Record<string, unknown>,
): BuffApplicability | "context" | "gate" {
  if (condition.negated === true) return "context";
  if (typeof condition.operator === "string" && Array.isArray(condition.operands)) {
    if (condition.operator !== "and") return "context";
    let merged: BuffApplicability = {};
    for (const operand of condition.operands) {
      if (!isObject(operand)) return "context";
      const a = conditionToApplicability(operand);
      if (a === "gate") continue; // timing operand: satisfied by opting in.
      if (a === "context") return "context";
      merged = combineApplicability(merged, a);
    }
    return merged;
  }
  const params = condition.parameters as Record<string, unknown> | undefined;
  switch (condition.type) {
    case "timing-is":
      return "gate";
    case "phase-is": {
      const phase = params?.phase;
      return typeof phase === "string" ? { phases: [phase as Phase] } : "context";
    }
    case "target-has-keyword": {
      const kw = params?.keyword;
      return typeof kw === "string" ? { requiresTargetKeyword: kw } : "context";
    }
    case "unit-has-keyword": {
      const kw = params?.keyword;
      return typeof kw === "string" ? { requiresAttackerKeyword: kw } : "context";
    }
    case "attack-is-type": {
      const t = params?.attack_type;
      if (t === "melee") return { phases: ["fight"] };
      if (t === "ranged") return { phases: ["shooting"] };
      return "context";
    }
    default:
      return "context";
  }
}

/** Merge two applicabilities; `phases` intersect, the rest narrow. */
function combineApplicability(a: BuffApplicability, b: BuffApplicability): BuffApplicability {
  const out: BuffApplicability = { ...a };
  if (b.phases) {
    out.phases = a.phases ? a.phases.filter((p) => b.phases!.includes(p)) : b.phases;
  }
  if (b.rollType) out.rollType = b.rollType;
  if (b.requiresTargetKeyword) out.requiresTargetKeyword = b.requiresTargetKeyword;
  if (b.requiresAttackerKeyword) out.requiresAttackerKeyword = b.requiresAttackerKeyword;
  return out;
}

/** Attach an accumulated applicability to a buff (no-op when empty). */
function applyApplicability(buff: Buff, applicability: BuffApplicability): Buff {
  if (Object.keys(applicability).length === 0) return buff;
  const merged = buff.applicableWhen
    ? combineApplicability(buff.applicableWhen, applicability)
    : applicability;
  return { ...buff, applicableWhen: merged };
}

/** A short, deduped human label summarising a lever's contributions. */
function labelForBuffs(buffs: Buff[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const b of buffs) {
    const p = describeContribution(b.contribution);
    if (!seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(", ") || "buff";
}

function describeContribution(c: BuffContribution): string {
  switch (c.type) {
    case "extra-keyword":
      return keywordLabel(c.keywordRef);
    case "hit-mod":
      return `${signed(c.value)} to hit`;
    case "wound-mod":
      return `${signed(c.value)} to wound`;
    case "save-mod":
      return `${signed(c.value)} to save`;
    case "damage-mod":
      return `${signed(c.value)} damage`;
    case "attacks-mod":
      return `${signed(c.value)} attacks`;
    case "strength-mod":
      return `${signed(c.value)} strength`;
    case "toughness-mod":
      return `${signed(c.value)} toughness`;
    case "ap-mod":
      return `AP ${c.value}`;
    case "reroll":
      return `re-roll ${c.roll}${c.subset === "ones" ? " 1s" : ""}`;
    case "feel-no-pain":
      return c.scope === "mortal"
        ? `feel no pain ${c.threshold}+ vs mortals`
        : `feel no pain ${c.threshold}+`;
    case "damage-reduction":
      return `-${c.value} damage`;
    case "invulnerable-save":
      return `${c.threshold}+ invuln`;
    case "cover":
      return "cover";
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Render a weapon-keyword ref back to its printed form (best-effort). */
function keywordLabel(ref: WeaponKeywordRef): string {
  const params = ref.parameters ?? {};
  if (ref.keyword_id === "anti" && typeof params.target_keyword === "string") {
    const th = params.threshold;
    return `Anti-${params.target_keyword}${typeof th === "number" ? ` ${th}+` : ""}`;
  }
  const base = ref.keyword_id
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  return typeof params.value === "number" ? `${base} ${params.value}` : base;
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

function evaluateCondition(
  condition: Record<string, unknown>,
  ctx: EngineContext,
): boolean | "unknown" {
  // Compound conditions use {operator, operands} rather than {type, parameters}.
  // The schema's `condition-node` oneOf doesn't guarantee discrimination by a
  // single field, so dispatch on shape: presence of `operator` + `operands`
  // wins over the simple-condition switch below.
  if (
    typeof condition.operator === "string" &&
    Array.isArray(condition.operands)
  ) {
    return evaluateCompound(condition.operator, condition.operands, ctx);
  }
  switch (condition.type) {
    case "phase-is": {
      const wanted = (condition.parameters as Record<string, unknown> | undefined)?.phase;
      if (typeof wanted !== "string") return "unknown";
      return ctx.phase === wanted;
    }
    case "timing-is": {
      const wanted = (condition.parameters as Record<string, unknown> | undefined)?.timing;
      if (typeof wanted !== "string") return "unknown";
      if (ctx.timing === undefined) return "unknown";
      return ctx.timing === wanted;
    }
    case "remained-stationary":
      return ctx.attackerStationary === true;
    case "charged-this-turn":
      // A player-controlled context flag (did the buffed unit charge this turn?),
      // mirroring `remained-stationary`. Undefined → the caller couldn't pin it
      // down, so stay "unknown" and let the SPA surface the gap.
      if (ctx.attackerCharged === undefined) return "unknown";
      return ctx.attackerCharged;
    case "target-has-keyword": {
      const kw = (condition.parameters as Record<string, unknown> | undefined)?.keyword;
      if (typeof kw !== "string") return "unknown";
      return (ctx.targetKeywords ?? []).includes(kw.toLowerCase());
    }
    case "unit-has-keyword": {
      const kw = (condition.parameters as Record<string, unknown> | undefined)?.keyword;
      if (typeof kw !== "string") return "unknown";
      return (ctx.attackerKeywords ?? []).includes(kw.toLowerCase());
    }
    case "is-attached":
    case "model-is-leader":
      // True whenever the buffed unit is a combined ("attached") unit. We do
      // not thread per-member leader identity — "attachment present" is the
      // signal both conditions gate on. Undefined flag (caller couldn't
      // determine attachment) stays "unknown" so the SPA surfaces the gap.
      if (ctx.attackerAttached === undefined) return "unknown";
      return ctx.attackerAttached;
    default:
      return "unknown";
  }
}

/**
 * Kleene three-valued evaluator for compound conditions. `and` short-circuits
 * to `false` as soon as any operand is false (an unknown operand is then
 * irrelevant); `or` short-circuits to `true` symmetrically. `not` flips its
 * single operand and leaves `"unknown"` as `"unknown"`. Unknown operands that
 * don't get short-circuited propagate as `"unknown"` so the SPA can surface
 * the gap rather than collapsing it into a misleading false.
 */
function evaluateCompound(
  operator: string,
  operands: unknown[],
  ctx: EngineContext,
): boolean | "unknown" {
  if (operator === "not") {
    const first = operands[0];
    if (!isObject(first)) return "unknown";
    const v = evaluateCondition(first, ctx);
    if (v === "unknown") return "unknown";
    return !v;
  }
  if (operator !== "and" && operator !== "or") return "unknown";
  let sawUnknown = false;
  for (const operand of operands) {
    if (!isObject(operand)) {
      sawUnknown = true;
      continue;
    }
    const v = evaluateCondition(operand, ctx);
    if (v === "unknown") {
      sawUnknown = true;
      continue;
    }
    if (operator === "and" && v === false) return false;
    if (operator === "or" && v === true) return true;
  }
  if (sawUnknown) return "unknown";
  return operator === "and"; // all true for AND, all false for OR
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a signed numeric value out of a modifier `{operation, value}` pair.
 * "add"/"subtract" become the matching sign; "set" / "multiply" / etc. return
 * `null` (translator surfaces them as unsupported).
 */
function signedValue(modifier: Record<string, unknown>): number | null {
  const value = Number(modifier.value);
  if (!Number.isFinite(value)) return null;
  switch (modifier.operation) {
    case "add":
      return value;
    case "subtract":
      return -value;
    // For the symmetric stats (A/S/T) and roll-/bs-modifiers, "improve" moves
    // the number up (beneficial) and "worsen" down. AP is handled separately by
    // `apDelta`, which inverts this because AP's beneficial direction is more
    // negative.
    case "improve":
      return value;
    case "worsen":
      return -value;
    default:
      // set / halve / multiply: not a single signed delta — left unsupported.
      return null;
  }
}

/**
 * Read the AP delta out of a stat-modifier `{operation, value}` pair. AP is
 * stored negative (more negative = more piercing), so "improve" makes it more
 * negative and "worsen" less. The legacy `add`/`subtract` forms pass a signed
 * value through directly (the data already encodes the sign).
 */
function apDelta(modifier: Record<string, unknown>): number | null {
  const value = Number(modifier.value);
  if (!Number.isFinite(value)) return null;
  switch (modifier.operation) {
    case "improve":
      return -Math.abs(value);
    case "worsen":
      return Math.abs(value);
    case "add":
      return value;
    case "subtract":
      return -value;
    default:
      return null;
  }
}

/**
 * Parse a printed weapon-keyword string (e.g. `"Sustained Hits 1"`,
 * `"Anti-INFANTRY 4+"`, `"Lethal Hits"`) into a `{keyword_id, parameters?}`
 * catalog reference, or `null` if the form is unrecognised.
 *
 * Reverses the conventions baked into the M0 catalog: kebab-case ids,
 * trailing number → `value`, embedded keyword + threshold → `target_keyword`
 * + `threshold`.
 */
export function parseKeywordGrant(raw: string): WeaponKeywordRef | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Anti-X N+ → { anti, target_keyword: X, threshold: N }
  const antiMatch = /^anti-([A-Z][A-Z\s-]*)\s+(\d+)\+?$/i.exec(trimmed);
  if (antiMatch) {
    return {
      keyword_id: "anti",
      parameters: { target_keyword: antiMatch[1].trim(), threshold: Number(antiMatch[2]) },
    };
  }

  // "Lethal Hits", "Twin-linked", "Heavy" → kebab-case lookup, no params.
  // "Sustained Hits 1", "Rapid Fire 2", "Melta 2" → kebab-case + value.
  const valueMatch = /^(.+?)\s+(\d+)$/.exec(trimmed);
  if (valueMatch) {
    return {
      keyword_id: toKebabCase(valueMatch[1]),
      parameters: { value: Number(valueMatch[2]) },
    };
  }
  return { keyword_id: toKebabCase(trimmed) };
}

function toKebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
