/**
 * Wargear-loadout maths shared by every consumer of the dataset: how many
 * models may take an option, what the maximal (take-every-swap) loadout looks
 * like, the valid count range for each weapon, and whether an edited loadout is
 * legal.
 *
 * The base loadout is derived, not stored: a weapon in `unit.weapon_ids` that
 * never appears as the *replacement* of any option is a **base** weapon, carried
 * by every model; a weapon that does appear as a replacement is **optional**,
 * carried only by the models that took the swap. This holds for uniform infantry
 * squads (every model shares the base loadout) and is exactly right for the
 * cases the corpus pins. Mirror of `crates/wh40kdc/src/data/loadout.rs`.
 *
 * @packageDocumentation
 */
import type { Unit, WargearOption } from "../generated.js";

/** Inclusive count range a single weapon/wargear id may take in a loadout. */
export interface WeaponBound {
  min: number;
  max: number;
}

/** A resolved loadout: entity id (weapon or wargear) → count across the unit. */
export interface Loadout {
  counts: Map<string, number>;
}

/** A loadout-rule violation. `id` is the offending weapon/wargear id. */
export interface Violation {
  id: string;
  code: "exceeds-max" | "below-min" | "swap-conflict" | "exceeds-allowance" | "invalid-model-count";
  message: string;
}

/**
 * The maximum number of TIMES `option` may be taken in a unit of `modelCount`
 * models: `any_number` alone → once per model; `any_number` WITH `max_count: L`
 * → up to L per model (a multi-take mount: "up to 2 seeker missiles", "up to
 * three of the following, and can take duplicates"); else `per_n_models` →
 * floor(n / per), clamped by `max_count` when set; else `max_count ?? 1`
 * (a flat allowance). A null constraint is treated as unrestricted (every
 * model). Never negative.
 */
export function optionCap(
  option: WargearOption,
  modelCount: number,
  models?: readonly LoadoutModel[],
): number {
  const c = option.model_constraint;
  if (!c) return Math.max(0, modelCount);
  // Per-model multiplicity: >1 only for the any_number+max_count multi-take
  // shape; every other shape takes an option at most once per model.
  const perModel = c.any_number ? (c.max_count ?? 1) : 1;
  let cap: number;
  if (c.any_number) cap = modelCount * perModel;
  else if (c.per_n_models) cap = Math.floor(modelCount / c.per_n_models);
  else cap = c.max_count ?? 1;
  if (!c.any_number && c.max_count != null) cap = Math.min(cap, c.max_count);
  // Eligible-model clamp: an option scoped to a named model profile can be taken
  // by no more models than exist of that profile (× the per-model multiplicity) —
  // a lone champion caps the swap at 1 even when `per_n_models` would allow more.
  // The composition row name is the authority (it and the option's `model_name`
  // both come from the dump miniature); a name with no matching row leaves the
  // cap unclamped (never over-restrict).
  if (c.model_name && models?.length) {
    const eligible = eligibleModelCount(models, modelCount, c.model_name);
    if (eligible != null) cap = Math.min(cap, eligible * perModel);
  }
  // At most `perModel` takes per model, so never more than modelCount × perModel —
  // a flat `max_count` larger than the current squad size (e.g. a flat BSData cap
  // of 6 on a 5-model unit) must not drive a swapped weapon count negative.
  return Math.max(0, Math.min(cap, modelCount * perModel));
}

/**
 * How many models of profile `name` a unit of `modelCount` fields, per the
 * composition allocation ({@link allocateModels}). `null` when no row carries that
 * name — the caller then leaves the option uncapped by eligibility.
 */
function eligibleModelCount(
  models: readonly LoadoutModel[],
  modelCount: number,
  name: string,
): number | null {
  if (!models.some((m) => m.name === name)) return null;
  let n = 0;
  for (const { model, count } of allocateModels(models, modelCount)) {
    if (model.name === name) n += count;
  }
  return n;
}

/** The ids a single option can add, given the chosen choice branch (default 0). */
function addedIds(option: WargearOption, choiceIndex = 0): string[] {
  if (option.replacement) return option.replacement;
  return option.replacement_choice?.[choiceIndex] ?? [];
}

/** Every id that any option can add — across all choice branches. */
function allReplacementIds(options: readonly WargearOption[]): Set<string> {
  const out = new Set<string>();
  for (const o of options) {
    for (const id of o.replacement ?? []) out.add(id);
    for (const group of o.replacement_choice ?? []) for (const id of group) out.add(id);
  }
  return out;
}

/** Every id that any option swaps OUT (the base weapon a swap replaces). */
function allReplacedIds(options: readonly WargearOption[]): Set<string> {
  const out = new Set<string>();
  for (const o of options) for (const id of o.replaces ?? []) out.add(id);
  return out;
}

/**
 * Derived base (always-carried) weapon ids — the fallback when a unit has no
 * recorded {@link LoadoutModel.default_weapon_ids}. A `weapon_id` is base iff it
 * is swapped out by some option (`replaces`) OR it never appears on any option's
 * *added* side. The `replaces` clause is load-bearing: a base weapon can also be
 * re-added inside another option's choice branch (e.g. a Chaos Terminator
 * Champion keeps a combi-bolter while swapping its melee), and such a weapon is
 * still base — checking only the added side would wrongly drop it. An *orphan*
 * weapon (in `weapon_ids`, touched by no option) stays base, which is correct for
 * a vehicle's fixed main gun.
 */
function baseWeaponIds(unit: Unit, options: readonly WargearOption[]): string[] {
  const added = allReplacementIds(options);
  const replaced = allReplacedIds(options);
  return (unit.weapon_ids ?? []).filter((id) => replaced.has(id) || !added.has(id));
}

/**
 * A unit-composition model row, as far as loadout maths cares: its count range,
 * whether it is a leader (taken at a fixed small count), and the weapons every
 * such model carries by default. Pass the unit's `unit_composition.models` here.
 */
export interface LoadoutModel {
  /** Model-profile name; matched against an option's `model_constraint.model_name`. */
  name?: string;
  min: number;
  max: number;
  default_weapon_ids?: readonly string[];
  is_leader_model?: boolean;
}

/** True when every model row records a non-empty default loadout. */
function hasRecordedDefaults(models: readonly LoadoutModel[] | undefined): models is LoadoutModel[] {
  return (
    !!models && models.length > 0 && models.every((m) => (m.default_weapon_ids?.length ?? 0) > 0)
  );
}

/**
 * Allocate `modelCount` models across the composition's model-types: each leader
 * is taken at its `min` (in declared order, never exceeding the remaining count),
 * then the non-leader "bulk" types absorb the rest — each its `min` first, then
 * any leftover to the bulk type with the largest `max`. Deterministic; mirrored
 * across implementations and pinned by the conformance corpus.
 */
function allocateModels(
  models: readonly LoadoutModel[],
  modelCount: number,
): { model: LoadoutModel; count: number }[] {
  const out = models.map((model) => ({ model, count: 0 }));
  let remaining = Math.max(0, modelCount);
  // Leaders first, at their declared minimum.
  for (const row of out) {
    if (!row.model.is_leader_model) continue;
    const c = Math.min(row.model.min ?? 0, remaining);
    row.count += c;
    remaining -= c;
  }
  const bulk = out.filter((r) => !r.model.is_leader_model);
  if (bulk.length === 0) {
    // No non-leader type: pour any remainder onto the leaders (largest max first).
    bulk.push(...out);
  }
  // Each bulk type takes its min, then the remainder lands on the largest-max type.
  for (const row of bulk) {
    const c = Math.min(row.model.min ?? 0, remaining);
    row.count += c;
    remaining -= c;
  }
  if (remaining > 0 && bulk.length > 0) {
    const sink = bulk.reduce((a, b) => ((b.model.max ?? 0) > (a.model.max ?? 0) ? b : a));
    sink.count += remaining;
  }
  return out;
}

/**
 * The base loadout counts: id → count across the unit with no swaps applied.
 * When the composition records per-model {@link LoadoutModel.default_weapon_ids},
 * those are authoritative — base = Σ over model-types of (allocated count ×
 * default weapons). Otherwise it falls back to {@link baseWeaponIds} × modelCount.
 */
function baseCounts(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  models?: readonly LoadoutModel[],
): Map<string, number> {
  const counts = new Map<string, number>();
  if (hasRecordedDefaults(models)) {
    for (const { model, count } of allocateModels(models, modelCount)) {
      if (count === 0) continue;
      for (const id of model.default_weapon_ids ?? []) {
        counts.set(id, (counts.get(id) ?? 0) + count);
      }
    }
    return counts;
  }
  for (const id of baseWeaponIds(unit, options)) {
    counts.set(id, (counts.get(id) ?? 0) + modelCount);
  }
  return counts;
}

/**
 * The base loadout: every model in its out-of-the-box configuration, no swaps
 * applied. This is the legal default a freshly-added unit ships with. Reads the
 * composition's recorded `default_weapon_ids` when present (authoritative),
 * otherwise derives the base set. {@link maximalLoadout} starts from this set and
 * then applies every option at full cap.
 */
export function baseLoadout(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  models?: readonly LoadoutModel[],
): Loadout {
  return { counts: baseCounts(unit, modelCount, options, models) };
}

/**
 * The maximal loadout: every base weapon on every model, then each option
 * applied at its full {@link optionCap} (choices take their first branch). Swaps
 * move count from the replaced id to the added id; add-ons only add.
 */
export function maximalLoadout(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  models?: readonly LoadoutModel[],
): Loadout {
  const counts = baseCounts(unit, modelCount, options, models);
  for (const option of options) {
    const cap = optionCap(option, modelCount, models);
    if (cap === 0) continue;
    for (const id of option.replaces ?? []) {
      counts.set(id, (counts.get(id) ?? 0) - cap);
    }
    for (const id of addedIds(option)) {
      counts.set(id, (counts.get(id) ?? 0) + cap);
    }
  }
  clampFlatBudgets(unit, counts);
  // Drop any id that nets to zero so the loadout reads cleanly.
  for (const [id, n] of counts) if (n === 0) counts.delete(id);
  return { counts };
}

/**
 * Cap each weapon's count by any single-weapon flat {@link Unit.wargear_budgets}
 * (a "this model takes at most N of weapon X" line, modelled as `items` of length
 * 1 with `per_models === 0`). A weapon reachable through several swap slots — e.g.
 * a Knight Destrier whose chastiser gatling cannon AND frag bombard can each be
 * swapped for a bellatus reaper chainsword — would otherwise sum to an illegal
 * count; clamping here makes {@link maximalLoadout}/{@link weaponBounds} agree with
 * the same invalid-loadout prevention the editor enforces, so a count consumer
 * (the salvo calculator) never seeds an over-cap value. Shared (multi-item) and
 * ratio (`per_models > 0`) budgets stay policed by {@link budgetViolations}.
 */
function clampFlatBudgets(unit: Unit, counts: Map<string, number>): void {
  for (const budget of unit.wargear_budgets ?? []) {
    if (budget.items.length !== 1 || budget.per_models !== 0) continue;
    const id = budget.items[0];
    const cur = counts.get(id);
    if (cur != null && cur > budget.count) counts.set(id, budget.count);
  }
}

/**
 * Inclusive valid count range for each weapon/wargear id, used to clamp a UI's
 * per-weapon inputs so invalid loadouts are unreachable. A base weapon ranges
 * `[modelCount − maxSwapsAway, modelCount]`; an optional (replacement) id ranges
 * `[0, Σ caps that add it]`.
 */
export function weaponBounds(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  models?: readonly LoadoutModel[],
): Map<string, WeaponBound> {
  const bounds = new Map<string, WeaponBound>();
  for (const [id, count] of baseCounts(unit, modelCount, options, models)) {
    bounds.set(id, { min: count, max: count });
  }
  for (const option of options) {
    const cap = optionCap(option, modelCount, models);
    for (const id of option.replaces ?? []) {
      const b = bounds.get(id) ?? { min: 0, max: 0 };
      bounds.set(id, { min: Math.max(0, b.min - cap), max: b.max });
    }
    // A replacement id can appear in multiple options / both choice branches;
    // sum the caps so its ceiling reflects every way to add it. Within one
    // branch, multiplicity counts: a twin-mount swap authored
    // ['lascannon','lascannon'] adds TWO per take (maximalLoadout already
    // honors this — collapsing to a Set here capped every paired sponson,
    // Forgefiend ectoplasma, and 2-particle-beamer Spyder at half its legal
    // count). Across branches an id's ceiling uses its largest single branch.
    const addMult = new Map<string, number>();
    const branches = option.replacement ? [option.replacement] : (option.replacement_choice ?? []);
    for (const group of branches) {
      const per = new Map<string, number>();
      for (const id of group) per.set(id, (per.get(id) ?? 0) + 1);
      for (const [id, n] of per) addMult.set(id, Math.max(addMult.get(id) ?? 0, n));
    }
    for (const [id, n] of addMult) {
      const b = bounds.get(id) ?? { min: 0, max: 0 };
      bounds.set(id, { min: b.min, max: b.max + cap * n });
    }
  }
  // A single-weapon flat budget caps the weapon's ceiling regardless of how many
  // swap slots can add it (see {@link clampFlatBudgets}), so an editor/salvo input
  // clamped against these bounds can never reach an over-cap, illegal count.
  for (const budget of unit.wargear_budgets ?? []) {
    if (budget.items.length !== 1 || budget.per_models !== 0) continue;
    const b = bounds.get(budget.items[0]);
    if (b && b.max > budget.count) {
      bounds.set(budget.items[0], { min: Math.min(b.min, budget.count), max: budget.count });
    }
  }
  return bounds;
}

/**
 * Clamp a single weapon's requested count into its valid range. Ids with no
 * bound (not part of this unit's loadout) are returned unchanged but floored at
 * zero.
 */
export function clampWeaponCount(
  bounds: Map<string, WeaponBound>,
  id: string,
  requested: number,
): number {
  const b = bounds.get(id);
  const n = Math.max(0, Math.floor(requested) || 0);
  if (!b) return n;
  return Math.min(b.max, Math.max(b.min, n));
}

/** One weapon line within a {@link LoadoutGroup}: entity id and its count *per model* in the group. */
export interface LoadoutGroupWeapon {
  id: string;
  count: number;
}

/**
 * A set of identically-equipped models within a unit: `count` models of model-type
 * `model_name`, each carrying `weapons` (counts are *per model*). Produced by
 * {@link groupLoadout} so an exporter can render "Nx <model>: <loadout>" lines
 * instead of one unit-wide weapon bag. Mirror of `crates/wh40kdc/src/data/loadout.rs`.
 */
export interface LoadoutGroup {
  model_name: string | null;
  count: number;
  weapons: LoadoutGroupWeapon[];
}

function toMultiset(ids: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/** Group weapons in a stable, language-agnostic order (by id) for cross-impl parity. */
function sortedGroupWeapons(m: Map<string, number>): LoadoutGroupWeapon[] {
  return [...m.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, count }));
}

/**
 * Assign each composition row a model count, summing to `modelCount`. Rows are
 * seeded at their `min`; a row with a *distinctive* default weapon (one carried by
 * no other row) present in `counts` grows toward that weapon's implied count (this
 * recovers opt-in weapon-variant rows like a Deathwatch kill-team's plasma models,
 * which sit at `min: 0`); the leftover budget pours into the bulk row (the
 * non-leader, non-distinctive row with the most headroom). Deterministic.
 */
function assignRowCounts(
  models: readonly LoadoutModel[],
  modelCount: number,
  counts: Map<string, number>,
): number[] {
  const rowDefaults = models.map((m) => toMultiset(m.default_weapon_ids ?? []));
  const rowsWith = new Map<string, number>();
  for (const def of rowDefaults) for (const id of def.keys()) rowsWith.set(id, (rowsWith.get(id) ?? 0) + 1);
  const minOf = (i: number) => Math.max(0, models[i].min ?? 0);
  const maxOf = (i: number) => Math.max(minOf(i), models[i].max ?? minOf(i));

  const out = models.map((_, i) => minOf(i));
  let budget = modelCount - out.reduce((a, b) => a + b, 0);
  if (budget < 0) {
    // Σmin exceeds the unit's size: trim from the end, deterministically.
    let over = -budget;
    for (let i = models.length - 1; i >= 0 && over > 0; i--) {
      const cut = Math.min(over, out[i]);
      out[i] -= cut;
      over -= cut;
    }
    budget = 0;
  }

  const distinctive = models.map(() => false);
  for (let i = 0; i < models.length && budget > 0; i++) {
    let cap = Infinity;
    let saw = false;
    for (const [id, mult] of rowDefaults[i]) {
      if ((rowsWith.get(id) ?? 0) === 1 && mult > 0 && (counts.get(id) ?? 0) > 0) {
        saw = true;
        cap = Math.min(cap, Math.floor((counts.get(id) ?? 0) / mult));
      }
    }
    if (!saw) continue;
    distinctive[i] = true;
    const add = Math.max(0, Math.min(Math.min(cap, maxOf(i)) - out[i], budget));
    out[i] += add;
    budget -= add;
  }

  const headroom = (i: number) => maxOf(i) - out[i];
  while (budget > 0) {
    let pick = -1;
    for (let i = 0; i < models.length; i++) {
      if (headroom(i) <= 0 || models[i].is_leader_model || distinctive[i]) continue;
      if (pick < 0 || headroom(i) > headroom(pick)) pick = i;
    }
    if (pick < 0)
      for (let i = 0; i < models.length; i++) {
        if (headroom(i) <= 0) continue;
        if (pick < 0 || headroom(i) > headroom(pick)) pick = i;
      }
    if (pick < 0) break;
    const add = Math.min(budget, headroom(pick));
    out[pick] += add;
    budget -= add;
  }
  return out;
}

/**
 * Every feasible per-row model allocation for `modelCount`, with the existing
 * heuristic allocation first so established grouping output stays stable.
 * Optional weapon-variant rows cannot be inferred reliably from their defaults
 * alone because a replacement may remove the distinctive weapon; the exact
 * loadout solver must therefore try the other bounded allocations too.
 */
function candidateRowCounts(
  models: readonly LoadoutModel[],
  modelCount: number,
  counts: Map<string, number>,
): number[][] {
  const preferred = assignRowCounts(models, modelCount, counts);
  const out: number[][] = [];
  const seen = new Set<string>();
  const add = (counts: number[]) => {
    const key = counts.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(counts);
    }
  };
  if (preferred.reduce((sum, count) => sum + count, 0) === modelCount) add(preferred);

  const mins = models.map((model) => Math.max(0, model.min ?? 0));
  const maxs = models.map((model, i) => Math.max(mins[i], model.max ?? mins[i]));
  const suffixMin = Array(models.length + 1).fill(0) as number[];
  const suffixMax = Array(models.length + 1).fill(0) as number[];
  for (let i = models.length - 1; i >= 0; i--) {
    suffixMin[i] = suffixMin[i + 1] + mins[i];
    suffixMax[i] = suffixMax[i + 1] + maxs[i];
  }

  const current = Array(models.length).fill(0) as number[];
  const visit = (i: number, remaining: number) => {
    if (i === models.length) {
      if (remaining === 0) add([...current]);
      return;
    }
    const lo = Math.max(mins[i], remaining - suffixMax[i + 1]);
    const hi = Math.min(maxs[i], remaining - suffixMin[i + 1]);
    for (let count = hi; count >= lo; count--) {
      current[i] = count;
      visit(i + 1, remaining - count);
    }
  };
  visit(0, Math.max(0, Math.floor(modelCount) || 0));
  return out;
}

/** The bundles (added-id sets) an option offers: a fixed `replacement`, else each `replacement_choice` branch. */
function optionBundles(option: WargearOption): string[][] {
  if (option.replacement) return [option.replacement];
  return (option.replacement_choice ?? []).map((b) => [...b]);
}

/**
 * A stable key for a weapon multiset: `count:id` parts in id order, joined by `|`.
 * Zero/negative entries are dropped. Identical multisets yield identical keys
 * across implementations, so it drives deterministic candidate ordering + grouping.
 */
function multisetKey(m: Map<string, number>): string {
  return [...m.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, c]) => `${c}:${id}`)
    .join("|");
}

/**
 * One legal single-model loadout for a composition row: the `weapons` a model can
 * carry, plus the global option indices whose application produced it (`usedOptions`;
 * repeated indices represent repeated no-replacement additions) so the assignment
 * search can charge per-option {@link optionCap}s.
 */
interface RowCandidate {
  weapons: Map<string, number>;
  usedOptions: number[];
  key: string;
}

function candidateCanBeSelected(
  candidate: RowCandidate,
  upper: ReadonlyMap<string, number>,
  optionCaps: readonly number[],
): boolean {
  for (const [id, per] of candidate.weapons) {
    if (per > 0 && (upper.get(id) ?? 0) < per) return false;
  }
  return candidate.usedOptions.every((optionIndex) => optionCaps[optionIndex] >= 1);
}

/**
 * Enumerate every legal single-model loadout for one composition row: start from the
 * row's base defaults and apply any *compatible* subset of the options that scope to
 * this row (unscoped options, or those whose `model_constraint.model_name` matches the
 * row). An option applies only when all its `replaces` weapons are currently present
 * (so a slot is swapped at most once) and is used at most once per model; each
 * `replacement_choice` branch is a distinct transformation. Reachable
 * `(weapons, usedOptions)` states are deduped and returned — bounded, since options and
 * their branches are few. Caps are *not* applied here; the assignment search charges
 * them globally, so two derivations of the same weapon-set with different option usage
 * are kept as distinct candidates (one may fit the caps where the other can't).
 */
function enumerateRowCandidates(
  base: Map<string, number>,
  rowName: string | null,
  options: readonly WargearOption[],
): RowCandidate[] {
  const applicable: number[] = [];
  for (let i = 0; i < options.length; i++) {
    const name = options[i].model_constraint?.model_name ?? null;
    if (name == null || name === rowName) applicable.push(i);
  }

  const stateKey = (w: Map<string, number>, used: readonly number[]) =>
    `${multisetKey(w)}#${[...used].sort((a, b) => a - b).join(",")}`;

  const result: RowCandidate[] = [];
  const seen = new Set<string>();
  const queue: { weapons: Map<string, number>; used: number[] }[] = [
    { weapons: new Map(base), used: [] },
  ];
  seen.add(stateKey(base, []));

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    result.push({ weapons: cur.weapons, usedOptions: cur.used, key: multisetKey(cur.weapons) });
    for (const oi of applicable) {
      const option = options[oi];
      const replaces = option.replaces ?? [];
      let uses = 0;
      for (const used of cur.used) if (used === oi) uses++;
      const perModelLimit =
        replaces.length === 0 ? option.model_constraint?.max_count ?? 1 : 1;
      if (uses >= perModelLimit) continue;
      if (!replaces.every((id) => (cur.weapons.get(id) ?? 0) >= 1)) continue;
      for (const bundle of optionBundles(option)) {
        if (bundle.length === 0) continue;
        const w = new Map(cur.weapons);
        for (const id of replaces) w.set(id, (w.get(id) ?? 0) - 1);
        for (const id of bundle) w.set(id, (w.get(id) ?? 0) + 1);
        for (const [id, c] of [...w]) if (c <= 0) w.delete(id);
        const used = [...cur.used, oi].sort((a, b) => a - b);
        const k = stateKey(w, used);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push({ weapons: w, used });
      }
    }
  }
  return result;
}

/** A composition row prepared for the assignment search: its model count + legal loadouts. */
interface SolverRow {
  name: string | null;
  count: number;
  candidates: RowCandidate[];
}

/**
 * A complete, deterministic bounded-cover search: distribute each row's models
 * across its candidate loadouts so every item count lands between `lower` and
 * `upper`, never exceeding an option's usage cap. Exact grouping passes the
 * same bag for both bounds; source-loadout completion gives omitted defaults a
 * wider upper bound. Rows are taken in order; within a row, candidates in their
 * pre-sorted order, trying the largest feasible count first. Returns the first
 * solution found, or `null` when no bounded partition exists.
 */
function solveAssignment(
  rows: readonly SolverRow[],
  lower: Map<string, number>,
  upper: Map<string, number>,
  optionCaps: readonly number[],
): { ri: number; name: string | null; weapons: Map<string, number>; count: number }[] | null {
  const remainingLower = new Map(lower);
  const remainingUpper = new Map(upper);
  const usage = optionCaps.map(() => 0);
  const picks: { ri: number; ci: number; count: number }[] = [];

  const assignRow = (ri: number): boolean => {
    if (ri === rows.length) {
      for (const c of remainingLower.values()) if (c > 0) return false;
      return true;
    }
    return distribute(ri, 0, rows[ri].count);
  };

  const distribute = (ri: number, ci: number, left: number): boolean => {
    const row = rows[ri];
    if (ci === row.candidates.length) return left === 0 && assignRow(ri + 1);
    const cand = row.candidates[ci];
    let hi = left;
    for (const [id, per] of cand.weapons) {
      if (per > 0) hi = Math.min(hi, Math.floor((remainingUpper.get(id) ?? 0) / per));
    }
    const optionUses = new Map<number, number>();
    for (const oi of cand.usedOptions) {
      optionUses.set(oi, (optionUses.get(oi) ?? 0) + 1);
    }
    for (const [oi, perModel] of optionUses) {
      hi = Math.min(
        hi,
        Math.floor((optionCaps[oi] - usage[oi]) / perModel),
      );
    }
    hi = Math.max(0, hi);
    for (let take = hi; take >= 0; take--) {
      for (const [id, per] of cand.weapons) {
        remainingLower.set(id, (remainingLower.get(id) ?? 0) - per * take);
        remainingUpper.set(id, (remainingUpper.get(id) ?? 0) - per * take);
      }
      for (const oi of cand.usedOptions) usage[oi] += take;
      if (take > 0) picks.push({ ri, ci, count: take });
      if (distribute(ri, ci + 1, left - take)) return true;
      if (take > 0) picks.pop();
      for (const oi of cand.usedOptions) usage[oi] -= take;
      for (const [id, per] of cand.weapons) {
        remainingLower.set(id, (remainingLower.get(id) ?? 0) + per * take);
        remainingUpper.set(id, (remainingUpper.get(id) ?? 0) + per * take);
      }
    }
    return false;
  };

  if (!assignRow(0)) return null;
  return picks.map((p) => ({
    ri: p.ri,
    name: rows[p.ri].name,
    weapons: rows[p.ri].candidates[p.ci].weapons,
    count: p.count,
  }));
}

function groupsFromSolution(
  solution: readonly {
    ri: number;
    name: string | null;
    weapons: Map<string, number>;
    count: number;
  }[],
): LoadoutGroup[] {
  const byGroup = new Map<
    string,
    { ri: number; name: string | null; weapons: Map<string, number>; count: number; key: string }
  >();
  for (const item of solution) {
    const key = multisetKey(item.weapons);
    const groupKey = `${item.name ?? ""}##${key}`;
    const current = byGroup.get(groupKey);
    if (current) current.count += item.count;
    else {
      byGroup.set(groupKey, {
        ri: item.ri,
        name: item.name,
        weapons: item.weapons,
        count: item.count,
        key,
      });
    }
  }
  return [...byGroup.values()]
    .filter((group) => group.count > 0)
    .sort((a, b) => a.ri - b.ri || b.count - a.count || a.key.localeCompare(b.key))
    .map((group) => ({
      model_name: group.name,
      count: group.count,
      weapons: sortedGroupWeapons(group.weapons),
    }));
}

function optionsWithPrintedUnitAbilities(
  unit: Unit,
  options: readonly WargearOption[],
  counts: ReadonlyMap<string, number>,
): WargearOption[] {
  const reachable = new Set<string>();
  for (const option of options) {
    for (const id of option.replaces ?? []) reachable.add(id);
    for (const id of option.replacement ?? []) reachable.add(id);
    for (const branch of option.replacement_choice ?? []) {
      for (const id of branch) reachable.add(id);
    }
  }
  const additions = (unit.ability_ids ?? [])
    .filter((id) => (counts.get(id) ?? 0) > 0 && !reachable.has(id))
    .map(
      (id): WargearOption => ({
        id: `${unit.id}-printed-ability-${id}`,
        unit_id: unit.id,
        faction_id: unit.faction_id,
        game_version: unit.game_version,
        is_free: true,
        replacement: [id],
        model_constraint: { max_count: counts.get(id)! },
      }),
    );
  return additions.length === 0 ? [...options] : [...options, ...additions];
}

/**
 * Decompose a unit's flat loadout into per-model-type groups (e.g. "1x Blood Herald:
 * …" + "6x Goremongers: …" + "1x Goremongers: …"). The composition's
 * {@link assignRowCounts} fixes how many models each row fields; {@link solveAssignment}
 * then searches, completely and deterministically, for an assignment of each row's
 * models to legal per-model loadouts ({@link enumerateRowCandidates}) whose weapons sum
 * to `counts` exactly while respecting every option's {@link optionCap}. Returns `null`
 * only when no such exact partition exists (a single model, no recorded per-model
 * defaults, or a genuinely indivisible bag) — callers then omit `loadout_groups` and
 * renderers fall back to their unit-wide rendering unchanged. Mirror of
 * `crates/wh40kdc/src/data/loadout.rs`.
 */
export function groupLoadout(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  models: readonly LoadoutModel[] | undefined,
  counts: Map<string, number>,
): LoadoutGroup[] | null {
  const n = Math.max(0, Math.floor(modelCount) || 0);
  // Single-model units and units without recorded per-model defaults render fine
  // from the aggregate; don't synthesise groups for them.
  if (n <= 1 || !hasRecordedDefaults(models)) return null;

  const bag = new Map<string, number>();
  for (const [id, c] of counts) if (c > 0) bag.set(id, c);
  const effectiveOptions = optionsWithPrintedUnitAbilities(unit, options, bag);

  for (const rowN of candidateRowCounts(models, n, bag)) {
    const fixedModels = models.map((model, i) => ({
      ...model,
      min: rowN[i],
      max: rowN[i],
    }));
    const optionCaps = effectiveOptions.map((option) =>
      optionCap(option, n, fixedModels),
    );
    const rows: SolverRow[] = [];
    for (let i = 0; i < models.length; i++) {
      const count = rowN[i];
      if (count <= 0) continue;
      const base = toMultiset(models[i].default_weapon_ids ?? []);
      const candidates = enumerateRowCandidates(
        base,
        models[i].name ?? null,
        effectiveOptions,
      )
        // A candidate that cannot be selected even once can contribute only a
        // zero-count branch. Removing it preserves exact-cover solutions and
        // prevents addon-heavy units from recursing through dead states.
        .filter((candidate) => candidateCanBeSelected(candidate, bag, optionCaps))
        .sort(
          (a, b) =>
            a.key.localeCompare(b.key) ||
            a.usedOptions.length - b.usedOptions.length ||
            a.usedOptions.join(",").localeCompare(b.usedOptions.join(",")),
        );
      rows.push({ name: models[i].name ?? null, count, candidates });
    }

    const solution = solveAssignment(rows, bag, bag, optionCaps);
    if (!solution) continue;
    const groups = groupsFromSolution(solution);
    if (groups.length > 0) return groups;
  }
  return null;
}

/** A source loadout completed with only omitted per-model defaults. */
export interface CompletedLoadout {
  counts: Map<string, number>;
  groups: LoadoutGroup[] | null;
}

/**
 * Complete a partial source loadout without inventing optional selections.
 *
 * Roster text commonly omits weapons every model carries implicitly. For each
 * valid composition allocation, this searches the same legal per-model
 * candidates as {@link groupLoadout}, but permits each item up to the greater
 * of its explicit count and its aggregate default count. Items absent from both
 * the source and the defaults remain forbidden. The result therefore fills
 * only defaults displaced as required by explicitly printed swaps.
 */
export function completeLoadout(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  models: readonly LoadoutModel[] | undefined,
  explicitCounts: Map<string, number>,
): CompletedLoadout | null {
  const n = Math.max(0, Math.floor(modelCount) || 0);
  if (n === 0 || !hasRecordedDefaults(models)) return null;

  const strictLower = new Map<string, number>();
  for (const [id, count] of explicitCounts) {
    if (count > 0) strictLower.set(id, count);
  }
  const lowerVariants = [strictLower];

  // Some source exporters double-count a secondary item shared by several
  // branches of one choice (the primary selections are still exact). A weapon
  // repeated in at least two multi-item branches is mechanically determined by
  // those primary selections, so a second pass may derive its count rather than
  // requiring the duplicated aggregate. Defaults are never relaxed.
  const defaultIds = new Set(
    models.flatMap((model) => model.default_weapon_ids ?? []),
  );
  const repeatedCoItems = new Set<string>();
  for (const option of options) {
    const occurrences = new Map<string, number>();
    for (const branch of option.replacement_choice ?? []) {
      if (branch.length < 2) continue;
      for (const id of new Set(branch)) {
        occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
      }
    }
    for (const [id, count] of occurrences) {
      if (count >= 2 && !defaultIds.has(id)) repeatedCoItems.add(id);
    }
  }
  const relaxedLower = new Map(strictLower);
  for (const id of repeatedCoItems) relaxedLower.delete(id);
  if (relaxedLower.size !== strictLower.size) lowerVariants.push(relaxedLower);

  const effectiveOptions = optionsWithPrintedUnitAbilities(
    unit,
    options,
    explicitCounts,
  );

  for (const lower of lowerVariants) {
    for (const rowCounts of candidateRowCounts(models, n, lower)) {
      const fixedModels = models.map((model, index) => ({
        ...model,
        min: rowCounts[index],
        max: rowCounts[index],
      }));
      const defaultCounts = new Map<string, number>();
      for (let index = 0; index < fixedModels.length; index++) {
        const count = rowCounts[index];
        if (count <= 0) continue;
        for (const id of fixedModels[index].default_weapon_ids ?? []) {
          defaultCounts.set(id, (defaultCounts.get(id) ?? 0) + count);
        }
      }
      const upper = new Map(defaultCounts);
      for (const [id, explicit] of explicitCounts) {
        upper.set(id, Math.max(explicit, upper.get(id) ?? 0));
      }

      const optionCaps = effectiveOptions.map((option) =>
        optionCap(option, n, fixedModels),
      );
      const rows: SolverRow[] = [];
      for (let index = 0; index < fixedModels.length; index++) {
        const count = rowCounts[index];
        if (count <= 0) continue;
        const base = toMultiset(fixedModels[index].default_weapon_ids ?? []);
        const candidates = enumerateRowCandidates(
          base,
          fixedModels[index].name ?? null,
          effectiveOptions,
        )
          .filter((candidate) => candidateCanBeSelected(candidate, upper, optionCaps))
          .sort(
            (a, b) =>
              a.usedOptions.length - b.usedOptions.length ||
              a.key.localeCompare(b.key) ||
              a.usedOptions.join(",").localeCompare(b.usedOptions.join(",")),
          );
        rows.push({
          name: fixedModels[index].name ?? null,
          count,
          candidates,
        });
      }

      const solution = solveAssignment(rows, lower, upper, optionCaps);
      if (!solution) continue;
      const groups = groupsFromSolution(solution);
      const counts = new Map<string, number>();
      for (const group of groups) {
        for (const weapon of group.weapons) {
          counts.set(
            weapon.id,
            (counts.get(weapon.id) ?? 0) + weapon.count * group.count,
          );
        }
      }
      return { counts, groups: n > 1 ? groups : null };
    }
  }
  return null;
}

/** Report every weapon/wargear count that falls outside its valid range. */
export function validateLoadout(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  counts: Map<string, number>,
  models?: readonly LoadoutModel[],
): Violation[] {
  const budgets = budgetViolations(unit, modelCount, counts);
  // A complete per-model partition proves every ordinary weapon count and
  // replacement slot is legal. Shared unit-wide allowances remain independent.
  if ((models?.length ?? 0) > 1 && groupLoadout(unit, modelCount, options, models, counts) !== null) {
    return budgets;
  }
  const bounds = weaponBounds(unit, modelCount, options, models);
  const out: Violation[] = [];
  // Items governed by a shared-allowance budget are policed solely by
  // `budgetViolations` (the GW `limited_wargear_choice_set` cap). Their per-id
  // `weaponBounds` max is derived from the dump's cross-product loadout branches
  // — the unreliable signal the budget exists to replace (a weapon in several
  // option branches sums an inflated bound) — so skip the per-id check for them.
  const budgeted = new Set<string>();
  for (const b of unit.wargear_budgets ?? []) for (const id of b.items ?? []) budgeted.add(id);
  for (const [id, n] of counts) {
    if (budgeted.has(id)) continue;
    const b = bounds.get(id);
    if (!b) continue;
    if (n > b.max) {
      out.push({ id, code: "exceeds-max", message: `${id}: ${n} exceeds max ${b.max}` });
    } else if (n < b.min) {
      out.push({ id, code: "below-min", message: `${id}: ${n} below min ${b.min}` });
    }
  }
  out.push(...swapConflicts(unit, modelCount, options, counts, models));
  out.push(...budgets);
  // Deterministic order so the result is stable for cross-impl comparison.
  out.sort((a, b) => (a.id === b.id ? a.code.localeCompare(b.code) : a.id.localeCompare(b.id)));
  return out;
}

/**
 * Shared-allowance violations: each {@link Unit.wargear_budgets} entry lets its
 * listed items take at most `floor(modelCount * count / per_models)` copies between
 * them (a GW "for every N models, X can take one of …" line). Summing the final
 * counts is robust to *how* the items are equipped — unlike per-option caps, which
 * the dump's cross-product loadout branches defeat. The violation `id` is the
 * budget's sorted items joined by `+`, so it is stable and identifies the group.
 */
function budgetViolations(
  unit: Unit,
  modelCount: number,
  counts: Map<string, number>,
): Violation[] {
  const out: Violation[] = [];
  for (const budget of unit.wargear_budgets ?? []) {
    const items = budget.items ?? [];
    if (!items.length) continue;
    const used = items.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
    // `per_models === 0` is a flat per-unit cap of `count`; otherwise a ratio.
    const cap = budget.per_models
      ? Math.floor((modelCount * budget.count) / budget.per_models)
      : budget.count;
    if (used > cap) {
      const id = [...items].sort().join("+");
      const limit = budget.per_models
        ? `${budget.count} per ${budget.per_models} models`
        : `${budget.count} per unit`;
      out.push({
        id,
        code: "exceeds-allowance",
        message: `${id}: ${used} exceeds shared allowance ${cap} (${limit})`,
      });
    }
    // Per-item sub-cap: at most `duplicate_limit` copies of any ONE item, over and
    // above the shared allowance (GW's "…and no more than N of the same" clause).
    const dup = budget.duplicate_limit;
    if (dup != null) {
      const dupCap = budget.per_models
        ? Math.floor((modelCount * dup) / budget.per_models)
        : dup;
      const dupLimit = budget.per_models
        ? `${dup} per ${budget.per_models} models`
        : `${dup} per unit`;
      for (const id of [...items].sort()) {
        const n = counts.get(id) ?? 0;
        if (n > dupCap) {
          out.push({
            id,
            code: "exceeds-allowance",
            message: `${id}: ${n} exceeds per-item duplicate cap ${dupCap} (${dupLimit})`,
          });
        }
      }
    }
  }
  return out;
}

/** One discrete buildable squad size: a per-model count range, keyed by model name. */
export interface LoadoutTier {
  models: readonly { name?: string; min: number; max: number }[];
}

/**
 * Merge a tier's per-model count ranges onto the composition's `models[]` metadata
 * (default weapons, leader flag, base) by name, producing the {@link LoadoutModel}
 * list the loadout maths consume for that tier. A tier row with no matching base
 * model keeps just its name/min/max.
 */
function tierModels(tier: LoadoutTier, base: readonly LoadoutModel[]): LoadoutModel[] {
  const byName = new Map(base.map((m) => [m.name, m]));
  return tier.models.map((tm) => {
    const b = tm.name != null ? byName.get(tm.name) : undefined;
    return { ...(b ?? {}), name: tm.name, min: tm.min, max: tm.max };
  });
}

/**
 * Whole-unit legality, tier-aware — the building block for a roster check. GW
 * models a datasheet's buildable sizes as discrete tiers (e.g. Neurogaunts: 1
 * Nodebeast + 10, or 1 + 11–20, or 2 + 20). A roster records only the *total*
 * `modelCount`, so we select every tier whose total range `[Σmin, Σmax]` contains
 * it and run {@link validateLoadout} against each tier's per-model allocation. The
 * unit is legal iff **some** containing tier validates clean — that's the faithful
 * "does a legal build exist" semantics, and it lets the maths allocate (say) 2
 * Nodebeasts at 22 models, which the single-envelope allocation cannot.
 *
 * Deterministic reporting (stable for cross-impl conformance): return the empty
 * result of the first clean tier (in tier order); else the violations of the first
 * containing tier. When `modelCount` falls in no tier, a single
 * `invalid-model-count` violation. When no `tiers` are supplied, falls back to a
 * plain {@link validateLoadout} (no size check) — preserving behaviour for units
 * the tier ingest didn't populate. Mirror of `crates/wh40kdc/src/data/loadout.rs`.
 */
export function checkUnitLegality(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  counts: Map<string, number>,
  models?: readonly LoadoutModel[],
  tiers?: readonly LoadoutTier[],
): Violation[] {
  if (!tiers?.length) {
    return validateLoadout(unit, modelCount, options, counts, models);
  }
  const base = models ?? [];
  const candidates: LoadoutModel[][] = [];
  for (const tier of tiers) {
    const tm = tierModels(tier, base);
    const min = tm.reduce((s, m) => s + (m.min ?? 0), 0);
    const max = tm.reduce((s, m) => s + (m.max ?? 0), 0);
    if (modelCount >= min && modelCount <= max) candidates.push(tm);
  }
  if (candidates.length === 0) {
    return [
      {
        id: unit.id,
        code: "invalid-model-count",
        message: `${unit.id}: ${modelCount} models matches no composition tier`,
      },
    ];
  }
  let firstViolations: Violation[] | null = null;
  for (const tm of candidates) {
    const violations = validateLoadout(unit, modelCount, options, counts, tm);
    if (violations.length === 0) return [];
    if (firstViolations === null) firstViolations = violations;
  }
  return firstViolations ?? [];
}

/**
 * Swap-conservation violations the independent per-id {@link weaponBounds} can't
 * see: a model's replaceable slot holds the base weapon OR one of its swap
 * replacements, never both, so `count(base) + Σ count(its replacements)` cannot
 * exceed `modelCount`. Without this, keeping a base weapon *and* adding its
 * replacement passes every per-id bound while being illegal (e.g. War Dog
 * Brigand with both diabolus heavy stubber and havoc multi-launcher).
 *
 * Enforced only for the unambiguous shape — a base weapon swapped out by plain
 * (non-choice) options that replace it alone, whose replacement ids are unique
 * within this unit's option set and aren't themselves base weapons. Choice /
 * multi-replace / shared-replacement options can't be attributed to one slot
 * pool, so they stay on the looser per-id bounds rather than risk a false
 * positive. Mirror of `crates/wh40kdc/src/data/loadout.rs`.
 */
function swapConflicts(
  unit: Unit,
  modelCount: number,
  options: readonly WargearOption[],
  counts: Map<string, number>,
  models?: readonly LoadoutModel[],
): Violation[] {
  const baseMap = baseCounts(unit, modelCount, options, models);
  const baseIds = new Set(baseMap.keys());
  const addedBy = new Map<string, number>();
  for (const o of options) {
    for (const id of o.replacement ?? []) addedBy.set(id, (addedBy.get(id) ?? 0) + 1);
    for (const g of o.replacement_choice ?? []) {
      for (const id of g) addedBy.set(id, (addedBy.get(id) ?? 0) + 1);
    }
  }
  const out: Violation[] = [];
  for (const base of baseIds) {
    const cleanAdds = new Set<string>();
    let messy = false;
    for (const o of options) {
      const replaces: readonly string[] = o.replaces ?? [];
      if (!replaces.includes(base)) continue;
      // Only a plain, single-target, single-item swap of this exact base weapon
      // is unambiguous. A 1→N bundle (Lychguard warscythe → shield + sword)
      // yields TWO added copies per freed slot — summing each against the slot
      // pool double-counts every bundle swap, so it stays on the looser bounds.
      if (
        replaces.length !== 1 ||
        (o.replacement_choice?.length ?? 0) > 0 ||
        (o.replacement?.length ?? 0) > 1
      ) {
        messy = true;
        break;
      }
      for (const b of o.replacement ?? []) {
        if (baseIds.has(b) || (addedBy.get(b) ?? 0) > 1) {
          messy = true;
          break;
        }
        cleanAdds.add(b);
      }
      if (messy) break;
    }
    // A base weapon that is itself ADDABLE by another option lives on several
    // models' slots at once (the Krieg power weapon: the Commissar's default
    // AND a Veteran's chainsword upgrade) — the single-slot pool can't attribute
    // its copies, so it too stays on the per-id bounds.
    if (messy || cleanAdds.size === 0 || (addedBy.get(base) ?? 0) > 0) continue;
    // The slot can hold at most as many weapons as there are models carrying this
    // base weapon by default — its base count (modelCount when not per-model).
    const cap = baseMap.get(base) ?? modelCount;
    let total = counts.get(base) ?? 0;
    for (const b of cleanAdds) total += counts.get(b) ?? 0;
    if (total > cap) {
      out.push({
        id: base,
        code: "swap-conflict",
        message: `${base} and its swap replacement(s) total ${total}, exceeding ${cap} (a model takes the base weapon or a swap, not both)`,
      });
    }
  }
  return out;
}
