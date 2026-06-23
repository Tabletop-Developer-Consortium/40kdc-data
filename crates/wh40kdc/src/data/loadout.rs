//! Wargear-loadout maths shared by every consumer of the dataset: how many
//! models may take an option, the maximal (take-every-swap) loadout, the valid
//! count range for each weapon, and whether an edited loadout is legal.
//!
//! The base loadout is derived, not stored: a weapon in `unit.weapon_ids` that
//! never appears as the *replacement* of any option is a **base** weapon, carried
//! by every model; a weapon that does appear as a replacement is **optional**,
//! carried only by the models that took the swap. This holds for uniform
//! infantry squads and is exactly what the conformance corpus pins. Mirror of
//! `tools/src/data/loadout.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::generated::{Unit, UnitCompositionModelsItem, UnitCompositionTiersItem, WargearOption};

/// Inclusive count range a single weapon/wargear id may take in a loadout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeaponBound {
    pub min: u64,
    pub max: u64,
}

/// A resolved loadout: entity id (weapon or wargear) → count across the unit.
/// Counts are signed because an intermediate swap can drive a malformed dataset
/// negative; valid data never does.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Loadout {
    pub counts: BTreeMap<String, i64>,
}

/// A loadout-rule violation. `id` is the offending weapon/wargear id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub id: String,
    pub code: ViolationCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViolationCode {
    ExceedsMax,
    BelowMin,
    SwapConflict,
    ExceedsAllowance,
    InvalidModelCount,
}

impl ViolationCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ViolationCode::ExceedsMax => "exceeds-max",
            ViolationCode::BelowMin => "below-min",
            ViolationCode::SwapConflict => "swap-conflict",
            ViolationCode::ExceedsAllowance => "exceeds-allowance",
            ViolationCode::InvalidModelCount => "invalid-model-count",
        }
    }
}

/// The maximum number of models that may take `option` in a unit of
/// `model_count` models. See [`super`] / the TS mirror for the semantics.
pub fn option_cap(
    option: &WargearOption,
    model_count: u64,
    models: Option<&[LoadoutModel]>,
) -> u64 {
    let Some(c) = option.model_constraint.as_ref() else {
        return model_count;
    };
    let mut cap = if c.any_number {
        model_count
    } else if let Some(per) = c.per_n_models {
        model_count / per.get()
    } else {
        c.max_count.map(|m| m.get()).unwrap_or(1)
    };
    if let Some(m) = c.max_count {
        cap = cap.min(m.get());
    }
    // Eligible-model clamp: an option scoped to a named model profile can be taken
    // by no more models than exist of that profile — a lone champion caps the swap
    // at 1 even when `per_n_models` would allow more. The composition row name is
    // the authority; a name with no matching row leaves the cap unclamped.
    if let (Some(name), Some(ms)) = (c.model_name.as_ref(), models) {
        if let Some(eligible) = eligible_model_count(ms, model_count, name) {
            cap = cap.min(eligible);
        }
    }
    // A swap is per-model: at most one per model, so never more than
    // model_count — a `max_count` larger than the current squad size must not
    // drive a weapon count negative. (u64 floors the lower bound at zero.)
    cap.min(model_count)
}

/// How many models of profile `name` a unit of `model_count` fields, per
/// [`allocate_models`]. `None` when no row carries that name — the caller then
/// leaves the option uncapped by eligibility.
fn eligible_model_count(models: &[LoadoutModel], model_count: u64, name: &str) -> Option<u64> {
    if !models.iter().any(|m| m.name.as_deref() == Some(name)) {
        return None;
    }
    let mut n = 0;
    for (model, count) in allocate_models(models, model_count) {
        if model.name.as_deref() == Some(name) {
            n += count;
        }
    }
    Some(n)
}

/// The ids a single option adds for the given choice branch (default 0).
fn added_ids(option: &WargearOption, choice_index: usize) -> Vec<&str> {
    if !option.replacement.is_empty() {
        return option.replacement.iter().map(|i| i.as_str()).collect();
    }
    option
        .replacement_choice
        .get(choice_index)
        .map(|g| g.iter().map(|i| i.as_str()).collect())
        .unwrap_or_default()
}

/// Every id that any option can add — across all choice branches.
fn all_replacement_ids(options: &[&WargearOption]) -> HashSet<String> {
    let mut out = HashSet::new();
    for o in options {
        for id in &o.replacement {
            out.insert(id.to_string());
        }
        for group in &o.replacement_choice {
            for id in group {
                out.insert(id.to_string());
            }
        }
    }
    out
}

/// Every id that any option swaps OUT (the base weapon a swap replaces).
fn all_replaced_ids(options: &[&WargearOption]) -> HashSet<String> {
    let mut out = HashSet::new();
    for o in options {
        for id in &o.replaces {
            out.insert(id.to_string());
        }
    }
    out
}

/// Derived base (always-carried) weapon ids — the fallback when a unit has no
/// recorded [`LoadoutModel::default_weapon_ids`]. A `weapon_id` is base iff it
/// is swapped out by some option (`replaces`) OR it never appears on any
/// option's *added* side. The `replaces` clause is load-bearing: a base weapon
/// can also be re-added inside another option's choice branch and is still base
/// — checking only the added side would wrongly drop it. An *orphan* weapon (in
/// `weapon_ids`, touched by no option) stays base, correct for a vehicle's fixed
/// main gun.
fn base_weapon_ids(unit: &Unit, options: &[&WargearOption]) -> Vec<String> {
    let added = all_replacement_ids(options);
    let replaced = all_replaced_ids(options);
    unit.weapon_ids
        .iter()
        .map(|i| i.to_string())
        .filter(|id| replaced.contains(id) || !added.contains(id))
        .collect()
}

/// A unit-composition model row, as far as loadout maths cares: its count range,
/// whether it is a leader (taken at a fixed small count), and the weapons every
/// such model carries by default. Pass the unit's `unit_composition.models`
/// mapped into this shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadoutModel {
    /// Model-profile name; matched against an option's `model_constraint.model_name`.
    pub name: Option<String>,
    pub min: u64,
    pub max: u64,
    pub default_weapon_ids: Vec<String>,
    pub is_leader_model: bool,
}

impl From<&UnitCompositionModelsItem> for LoadoutModel {
    fn from(m: &UnitCompositionModelsItem) -> Self {
        LoadoutModel {
            name: Some((*m.name).clone()),
            min: m.min,
            max: m.max.get(),
            default_weapon_ids: m.default_weapon_ids.iter().map(|i| i.to_string()).collect(),
            is_leader_model: m.is_leader_model,
        }
    }
}

/// Map a unit-composition's model rows into the [`LoadoutModel`] shape the
/// loadout maths consumes.
pub fn loadout_models(models: &[UnitCompositionModelsItem]) -> Vec<LoadoutModel> {
    models.iter().map(LoadoutModel::from).collect()
}

/// True when every model row records a non-empty default loadout.
fn has_recorded_defaults(models: Option<&[LoadoutModel]>) -> bool {
    match models {
        Some(ms) => !ms.is_empty() && ms.iter().all(|m| !m.default_weapon_ids.is_empty()),
        None => false,
    }
}

/// Allocate `model_count` models across the composition's model-types: each
/// leader is taken at its `min` (in declared order, never exceeding the
/// remaining count), then the non-leader "bulk" types absorb the rest — each its
/// `min` first, then any leftover to the bulk type with the largest `max`. If
/// there are no non-leader rows the leaders act as the bulk sink. Deterministic;
/// mirrored across implementations and pinned by the conformance corpus.
fn allocate_models<'a>(
    models: &'a [LoadoutModel],
    model_count: u64,
) -> Vec<(&'a LoadoutModel, u64)> {
    let mut out: Vec<(&LoadoutModel, u64)> = models.iter().map(|m| (m, 0u64)).collect();
    let mut remaining = model_count;
    // Leaders first, at their declared minimum.
    for row in out.iter_mut() {
        if !row.0.is_leader_model {
            continue;
        }
        let c = row.0.min.min(remaining);
        row.1 += c;
        remaining -= c;
    }
    // Indices of the non-leader bulk rows; if none, the leaders are the sink.
    let mut bulk_idx: Vec<usize> = (0..out.len())
        .filter(|&i| !out[i].0.is_leader_model)
        .collect();
    if bulk_idx.is_empty() {
        bulk_idx = (0..out.len()).collect();
    }
    // Each bulk type takes its min, then the remainder lands on the largest-max type.
    for &i in &bulk_idx {
        let c = out[i].0.min.min(remaining);
        out[i].1 += c;
        remaining -= c;
    }
    if remaining > 0 && !bulk_idx.is_empty() {
        let sink = bulk_idx
            .iter()
            .copied()
            .reduce(|a, b| if out[b].0.max > out[a].0.max { b } else { a })
            .expect("bulk_idx is non-empty");
        out[sink].1 += remaining;
    }
    out
}

/// The base loadout counts: id → count across the unit with no swaps applied.
/// When the composition records per-model [`LoadoutModel::default_weapon_ids`],
/// those are authoritative — base = Σ over model-types of (allocated count ×
/// default weapons). Otherwise it falls back to [`base_weapon_ids`] × model_count.
fn base_counts(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    models: Option<&[LoadoutModel]>,
) -> BTreeMap<String, i64> {
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    if has_recorded_defaults(models) {
        let models = models.expect("has_recorded_defaults implies Some");
        for (model, count) in allocate_models(models, model_count) {
            if count == 0 {
                continue;
            }
            for id in &model.default_weapon_ids {
                *counts.entry(id.to_string()).or_insert(0) += count as i64;
            }
        }
        return counts;
    }
    for id in base_weapon_ids(unit, options) {
        *counts.entry(id).or_insert(0) += model_count as i64;
    }
    counts
}

/// The base loadout: every model in its out-of-the-box configuration, no swaps
/// applied. This is the legal default a freshly-added unit ships with. Reads the
/// composition's recorded `default_weapon_ids` when present (authoritative),
/// otherwise derives the base set. [`maximal_loadout`] starts from this set and
/// then applies every option at full cap.
pub fn base_loadout(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    models: Option<&[LoadoutModel]>,
) -> Loadout {
    Loadout {
        counts: base_counts(unit, model_count, options, models),
    }
}

/// The maximal loadout: every base weapon on every model, then each option
/// applied at its full [`option_cap`] (choices take their first branch).
pub fn maximal_loadout(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    models: Option<&[LoadoutModel]>,
) -> Loadout {
    let mut counts = base_counts(unit, model_count, options, models);
    for option in options {
        let cap = option_cap(option, model_count, models) as i64;
        if cap == 0 {
            continue;
        }
        for id in &option.replaces {
            *counts.entry(id.to_string()).or_insert(0) -= cap;
        }
        for id in added_ids(option, 0) {
            *counts.entry(id.to_string()).or_insert(0) += cap;
        }
    }
    clamp_flat_budgets(unit, &mut counts);
    counts.retain(|_, n| *n != 0);
    Loadout { counts }
}

/// Cap each weapon's count by any single-weapon flat `wargear_budgets` entry (a
/// "this model takes at most N of weapon X" line, modelled as `items` of length 1
/// with `per_models == 0`). A weapon reachable through several swap slots — e.g. a
/// Knight Destrier whose chastiser gatling cannon AND frag bombard can each be
/// swapped for a bellatus reaper chainsword — would otherwise sum to an illegal
/// count; clamping here makes [`maximal_loadout`]/[`weapon_bounds`] agree with the
/// same invalid-loadout prevention the editor enforces. Shared (multi-item) and
/// ratio (`per_models > 0`) budgets stay policed by [`validate_loadout`].
fn clamp_flat_budgets(unit: &Unit, counts: &mut BTreeMap<String, i64>) {
    for budget in &unit.wargear_budgets {
        if budget.items.len() != 1 || budget.per_models != 0 {
            continue;
        }
        let cap = budget.count.get() as i64;
        if let Some(cur) = counts.get_mut(&budget.items[0].to_string()) {
            if *cur > cap {
                *cur = cap;
            }
        }
    }
}

/// Inclusive valid count range for each weapon/wargear id, used to clamp a UI's
/// per-weapon inputs so invalid loadouts are unreachable.
pub fn weapon_bounds(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    models: Option<&[LoadoutModel]>,
) -> BTreeMap<String, WeaponBound> {
    let mut bounds: BTreeMap<String, WeaponBound> = BTreeMap::new();
    for (id, count) in base_counts(unit, model_count, options, models) {
        let n = count.max(0) as u64;
        bounds.insert(id, WeaponBound { min: n, max: n });
    }
    for option in options {
        let cap = option_cap(option, model_count, models);
        for id in &option.replaces {
            let b = bounds
                .entry(id.to_string())
                .or_insert(WeaponBound { min: 0, max: 0 });
            b.min = b.min.saturating_sub(cap);
        }
        let mut adds: HashSet<String> = HashSet::new();
        for id in &option.replacement {
            adds.insert(id.to_string());
        }
        for group in &option.replacement_choice {
            for id in group {
                adds.insert(id.to_string());
            }
        }
        for id in adds {
            let b = bounds.entry(id).or_insert(WeaponBound { min: 0, max: 0 });
            b.max += cap;
        }
    }
    // A single-weapon flat budget caps the weapon's ceiling regardless of how many
    // swap slots can add it (see `clamp_flat_budgets`), so an editor/salvo input
    // clamped against these bounds can never reach an over-cap, illegal count.
    for budget in &unit.wargear_budgets {
        if budget.items.len() != 1 || budget.per_models != 0 {
            continue;
        }
        let cap = budget.count.get();
        if let Some(b) = bounds.get_mut(&budget.items[0].to_string()) {
            if b.max > cap {
                b.max = cap;
                b.min = b.min.min(cap);
            }
        }
    }
    bounds
}

/// One weapon line within a [`LoadoutGroup`]: entity id and its count *per model*.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadoutGroupWeapon {
    pub id: String,
    pub count: u64,
}

/// A set of identically-equipped models within a unit: `count` models of model-type
/// `model_name`, each carrying `weapons` (counts are *per model*). Produced by
/// [`group_loadout`] for grouped "Nx <model>: <loadout>" export rendering. Mirror of
/// the TS `LoadoutGroup`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadoutGroup {
    pub model_name: Option<String>,
    pub count: u64,
    pub weapons: Vec<LoadoutGroupWeapon>,
}

#[derive(Debug, Clone)]
struct MutGroup {
    model_name: Option<String>,
    count: u64,
    weapons: BTreeMap<String, i64>,
}

fn to_multiset(ids: &[String]) -> BTreeMap<String, u64> {
    let mut m: BTreeMap<String, u64> = BTreeMap::new();
    for id in ids {
        *m.entry(id.clone()).or_insert(0) += 1;
    }
    m
}

/// Group weapons in a stable, language-agnostic order (by id — `BTreeMap` already
/// sorts) for cross-impl parity.
fn sorted_group_weapons(m: &BTreeMap<String, i64>) -> Vec<LoadoutGroupWeapon> {
    m.iter()
        .filter(|(_, c)| **c > 0)
        .map(|(id, c)| LoadoutGroupWeapon {
            id: id.clone(),
            count: *c as u64,
        })
        .collect()
}

/// The bundles (added-id sets) an option offers: a fixed `replacement`, else each
/// `replacement_choice` branch.
fn option_bundles(option: &WargearOption) -> Vec<Vec<String>> {
    if !option.replacement.is_empty() {
        return vec![option.replacement.iter().map(|s| s.to_string()).collect()];
    }
    option
        .replacement_choice
        .iter()
        .map(|b| b.iter().map(|s| s.to_string()).collect())
        .collect()
}

/// Assign each composition row a model count summing to `model_count`. Rows seed at
/// `min`; a row with a *distinctive* default weapon (one carried by no other row)
/// present in `counts` grows toward that weapon's implied count (recovers opt-in
/// weapon-variant rows at `min: 0`); the leftover budget pours into the bulk row.
/// Deterministic. Mirror of the TS `assignRowCounts`.
fn assign_row_counts(
    models: &[LoadoutModel],
    model_count: u64,
    counts: &BTreeMap<String, i64>,
) -> Vec<u64> {
    let row_defaults: Vec<BTreeMap<String, u64>> = models
        .iter()
        .map(|m| to_multiset(&m.default_weapon_ids))
        .collect();
    let mut rows_with: HashMap<String, u64> = HashMap::new();
    for def in &row_defaults {
        for id in def.keys() {
            *rows_with.entry(id.clone()).or_insert(0) += 1;
        }
    }
    let max_of = |i: usize| models[i].max.max(models[i].min);

    let mut out: Vec<u64> = (0..models.len()).map(|i| models[i].min).collect();
    let sum: u64 = out.iter().sum();
    let mut budget = model_count.saturating_sub(sum);
    if sum > model_count {
        // Σmin exceeds the unit's size: trim from the end, deterministically.
        let mut over = sum - model_count;
        for i in (0..out.len()).rev() {
            if over == 0 {
                break;
            }
            let cut = over.min(out[i]);
            out[i] -= cut;
            over -= cut;
        }
        budget = 0;
    }

    let mut distinctive = vec![false; models.len()];
    for i in 0..models.len() {
        if budget == 0 {
            break;
        }
        let mut cap = u64::MAX;
        let mut saw = false;
        for (id, mult) in &row_defaults[i] {
            if rows_with.get(id).copied().unwrap_or(0) == 1 && *mult > 0 {
                let avail = counts.get(id).copied().unwrap_or(0);
                if avail > 0 {
                    saw = true;
                    cap = cap.min(avail as u64 / *mult);
                }
            }
        }
        if !saw {
            continue;
        }
        distinctive[i] = true;
        let add = cap.min(max_of(i)).saturating_sub(out[i]).min(budget);
        out[i] += add;
        budget -= add;
    }

    while budget > 0 {
        let headroom = |i: usize, out: &[u64]| max_of(i).saturating_sub(out[i]);
        let mut pick: Option<usize> = None;
        for i in 0..models.len() {
            if headroom(i, &out) == 0 || models[i].is_leader_model || distinctive[i] {
                continue;
            }
            if pick.map_or(true, |p| headroom(i, &out) > headroom(p, &out)) {
                pick = Some(i);
            }
        }
        if pick.is_none() {
            for i in 0..models.len() {
                if headroom(i, &out) == 0 {
                    continue;
                }
                if pick.map_or(true, |p| headroom(i, &out) > headroom(p, &out)) {
                    pick = Some(i);
                }
            }
        }
        let Some(p) = pick else { break };
        let add = budget.min(headroom(p, &out));
        out[p] += add;
        budget -= add;
    }
    out
}

fn group_holds(g: &MutGroup, replaces: &[String]) -> bool {
    g.count > 0
        && replaces
            .iter()
            .all(|id| g.weapons.get(id).copied().unwrap_or(0) >= 1)
}

/// The group to peel a swap-variant off: a group of the scoped model-type still
/// holding every replaced weapon (fall back to any such holder when the scoped name
/// matches nothing).
fn find_source(
    groups: &[MutGroup],
    scoped_name: Option<&str>,
    replaces: &[String],
) -> Option<usize> {
    if let Some(name) = scoped_name {
        if let Some(i) = groups
            .iter()
            .position(|g| group_holds(g, replaces) && g.model_name.as_deref() == Some(name))
        {
            return Some(i);
        }
        return groups.iter().position(|g| group_holds(g, replaces));
    }
    groups.iter().position(|g| group_holds(g, replaces))
}

/// Explain leftover weapon counts as option swaps, peeling a variant sub-group off
/// the base group of the model-type each option is scoped to. Mirror of the TS
/// `applySwaps`.
fn apply_swaps(
    groups: &mut Vec<MutGroup>,
    models: &[LoadoutModel],
    options: &[&WargearOption],
    model_count: u64,
    remaining: &mut BTreeMap<String, i64>,
) {
    for option in options {
        let cap = option_cap(option, model_count, Some(models)) as i64;
        if cap <= 0 {
            continue;
        }
        let replaces: Vec<String> = option.replaces.iter().map(|s| s.to_string()).collect();
        let scoped_name: Option<&str> = option
            .model_constraint
            .as_ref()
            .and_then(|c| c.model_name.as_deref())
            .map(|s| s.as_str());
        for bundle in option_bundles(option) {
            if bundle.is_empty() {
                continue;
            }
            let add_m = to_multiset(&bundle);
            let mut k = cap;
            for (id, mult) in &add_m {
                let avail = remaining.get(id).copied().unwrap_or(0).max(0);
                k = k.min(avail / *mult as i64);
            }
            if k <= 0 {
                continue;
            }
            let Some(idx) = find_source(groups, scoped_name, &replaces) else {
                continue;
            };
            let take = (k as u64).min(groups[idx].count);
            if take == 0 {
                continue;
            }
            let mut w = groups[idx].weapons.clone();
            for id in &replaces {
                *w.entry(id.clone()).or_insert(0) -= 1;
            }
            for (id, mult) in &add_m {
                *w.entry(id.clone()).or_insert(0) += *mult as i64;
            }
            w.retain(|_, c| *c > 0);
            groups[idx].count -= take;
            let model_name = groups[idx].model_name.clone();
            groups.push(MutGroup {
                model_name,
                count: take,
                weapons: w,
            });
            for (id, mult) in &add_m {
                *remaining.entry(id.clone()).or_insert(0) -= *mult as i64 * take as i64;
            }
            for id in &replaces {
                *remaining.entry(id.clone()).or_insert(0) += take as i64;
            }
        }
    }
}

/// Decompose a unit's flat loadout into per-model-type groups, reusing
/// [`allocate_models`]'s partition and per-model-type option scoping. Returns `None`
/// when the decomposition is not *exact* (single model, no recorded per-model
/// defaults, or leftover counts no swap explains) so callers omit `loadout_groups`
/// and renderers keep their unit-wide rendering. Mirror of the TS `groupLoadout`.
pub fn group_loadout(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    models: Option<&[LoadoutModel]>,
    counts: &BTreeMap<String, i64>,
) -> Option<Vec<LoadoutGroup>> {
    let _ = unit;
    if model_count <= 1 || !has_recorded_defaults(models) {
        return None;
    }
    let models = models.expect("has_recorded_defaults implies Some");
    let mut remaining: BTreeMap<String, i64> = BTreeMap::new();
    for (id, c) in counts {
        if *c > 0 {
            remaining.insert(id.clone(), *c);
        }
    }
    let row_n = assign_row_counts(models, model_count, &remaining);
    let mut groups: Vec<MutGroup> = Vec::new();
    for (i, model) in models.iter().enumerate() {
        let k = row_n[i];
        if k == 0 {
            continue;
        }
        let def = to_multiset(&model.default_weapon_ids);
        for (id, c) in &def {
            *remaining.entry(id.clone()).or_insert(0) -= *c as i64 * k as i64;
        }
        let weapons: BTreeMap<String, i64> =
            def.into_iter().map(|(id, c)| (id, c as i64)).collect();
        groups.push(MutGroup {
            model_name: model.name.clone(),
            count: k,
            weapons,
        });
    }
    apply_swaps(&mut groups, models, options, model_count, &mut remaining);
    if remaining.values().any(|c| *c != 0) {
        return None;
    }
    let live: Vec<LoadoutGroup> = groups
        .into_iter()
        .filter(|g| g.count > 0)
        .map(|g| LoadoutGroup {
            model_name: g.model_name,
            count: g.count,
            weapons: sorted_group_weapons(&g.weapons),
        })
        .collect();
    if live.is_empty() {
        None
    } else {
        Some(live)
    }
}

/// Clamp a single weapon's requested count into its valid range. Ids with no
/// bound are returned unchanged (floored at zero).
pub fn clamp_weapon_count(bounds: &BTreeMap<String, WeaponBound>, id: &str, requested: u64) -> u64 {
    match bounds.get(id) {
        Some(b) => requested.min(b.max).max(b.min),
        None => requested,
    }
}

/// Report every weapon/wargear count outside its valid range, sorted by
/// `(id, code)` for stable cross-impl comparison.
pub fn validate_loadout(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    counts: &HashMap<String, i64>,
    models: Option<&[LoadoutModel]>,
) -> Vec<Violation> {
    let bounds = weapon_bounds(unit, model_count, options, models);
    let mut out = Vec::new();
    // Items governed by a shared-allowance budget are policed solely by
    // `budget_violations`; their per-id `weapon_bounds` max is derived from the
    // dump's cross-product loadout branches (the unreliable signal the budget
    // replaces), so skip the per-id check for them. Mirror of the TS reference.
    let budgeted: HashSet<&str> = unit
        .wargear_budgets
        .iter()
        .flat_map(|b| b.items.iter().map(|i| &***i))
        .collect();
    for (id, &n) in counts {
        if budgeted.contains(id.as_str()) {
            continue;
        }
        let Some(b) = bounds.get(id) else { continue };
        if n > b.max as i64 {
            out.push(Violation {
                id: id.clone(),
                code: ViolationCode::ExceedsMax,
                message: format!("{id}: {n} exceeds max {}", b.max),
            });
        } else if n < b.min as i64 {
            out.push(Violation {
                id: id.clone(),
                code: ViolationCode::BelowMin,
                message: format!("{id}: {n} below min {}", b.min),
            });
        }
    }
    out.extend(swap_conflicts(unit, model_count, options, counts, models));
    out.extend(budget_violations(unit, model_count, counts));
    out.sort_by(|a, b| a.id.cmp(&b.id).then(a.code.as_str().cmp(b.code.as_str())));
    out
}

/// Shared-allowance violations: each [`Unit::wargear_budgets`] entry lets its
/// listed items take at most `floor(model_count * count / per_models)` copies
/// between them. Summing the final counts is robust to *how* the items are
/// equipped — unlike per-option caps, which the dump's cross-product loadout
/// branches defeat. The violation `id` is the budget's sorted items joined by `+`.
/// Mirror of `tools/src/data/loadout.ts`.
fn budget_violations(
    unit: &Unit,
    model_count: u64,
    counts: &HashMap<String, i64>,
) -> Vec<Violation> {
    let mut out = Vec::new();
    for budget in &unit.wargear_budgets {
        if budget.items.is_empty() {
            continue;
        }
        let used: i64 = budget
            .items
            .iter()
            .map(|id| counts.get(&***id).copied().unwrap_or(0))
            .sum();
        // `per_models == 0` is a flat per-unit cap of `count`; otherwise a ratio.
        let (cap, limit) = if budget.per_models == 0 {
            (
                budget.count.get() as i64,
                format!("{} per unit", budget.count.get()),
            )
        } else {
            (
                (model_count * budget.count.get() / budget.per_models) as i64,
                format!("{} per {} models", budget.count.get(), budget.per_models),
            )
        };
        if used > cap {
            let mut items: Vec<String> = budget.items.iter().map(|i| i.to_string()).collect();
            items.sort();
            let id = items.join("+");
            out.push(Violation {
                code: ViolationCode::ExceedsAllowance,
                message: format!("{id}: {used} exceeds shared allowance {cap} ({limit})"),
                id,
            });
        }
    }
    out
}

/// One discrete buildable squad size: per-model count ranges keyed by model name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadoutTier {
    pub models: Vec<LoadoutTierModel>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadoutTierModel {
    pub name: String,
    pub min: u64,
    pub max: u64,
}

impl From<&UnitCompositionTiersItem> for LoadoutTier {
    fn from(t: &UnitCompositionTiersItem) -> Self {
        LoadoutTier {
            models: t
                .models
                .iter()
                .map(|m| LoadoutTierModel {
                    name: (*m.name).clone(),
                    min: m.min,
                    max: m.max.get(),
                })
                .collect(),
        }
    }
}

/// Map a unit-composition's tier rows into the [`LoadoutTier`] shape.
pub fn loadout_tiers(tiers: &[UnitCompositionTiersItem]) -> Vec<LoadoutTier> {
    tiers.iter().map(LoadoutTier::from).collect()
}

/// Merge a tier's per-model count ranges onto the composition's `models` metadata
/// by name, producing the [`LoadoutModel`] list for that tier.
fn tier_models(tier: &LoadoutTier, base: &[LoadoutModel]) -> Vec<LoadoutModel> {
    tier.models
        .iter()
        .map(|tm| {
            let mut lm = base
                .iter()
                .find(|b| b.name.as_deref() == Some(tm.name.as_str()))
                .cloned()
                .unwrap_or(LoadoutModel {
                    name: None,
                    min: 0,
                    max: 0,
                    default_weapon_ids: Vec::new(),
                    is_leader_model: false,
                });
            lm.name = Some(tm.name.clone());
            lm.min = tm.min;
            lm.max = tm.max;
            lm
        })
        .collect()
}

/// Whole-unit legality, tier-aware — the building block for a roster check. A
/// roster records only the *total* `model_count`, so we select every tier whose
/// total range `[Σmin, Σmax]` contains it and run [`validate_loadout`] against
/// each tier's allocation. The unit is legal iff **some** containing tier
/// validates clean. Deterministic reporting: the empty result of the first clean
/// tier (in tier order), else the violations of the first containing tier; an
/// `invalid-model-count` violation when the size matches no tier. With no tiers it
/// falls back to a plain [`validate_loadout`]. Mirror of `tools/src/data/loadout.ts`.
pub fn check_unit_legality(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    counts: &HashMap<String, i64>,
    models: Option<&[LoadoutModel]>,
    tiers: Option<&[LoadoutTier]>,
) -> Vec<Violation> {
    let tiers = match tiers {
        Some(t) if !t.is_empty() => t,
        _ => return validate_loadout(unit, model_count, options, counts, models),
    };
    let base = models.unwrap_or(&[]);
    let candidates: Vec<Vec<LoadoutModel>> = tiers
        .iter()
        .map(|tier| tier_models(tier, base))
        .filter(|tm| {
            let min: u64 = tm.iter().map(|m| m.min).sum();
            let max: u64 = tm.iter().map(|m| m.max).sum();
            model_count >= min && model_count <= max
        })
        .collect();
    if candidates.is_empty() {
        let id = unit.id.as_str().to_string();
        return vec![Violation {
            message: format!("{id}: {model_count} models matches no composition tier"),
            code: ViolationCode::InvalidModelCount,
            id,
        }];
    }
    let mut first: Option<Vec<Violation>> = None;
    for tm in &candidates {
        let violations = validate_loadout(unit, model_count, options, counts, Some(tm));
        if violations.is_empty() {
            return Vec::new();
        }
        if first.is_none() {
            first = Some(violations);
        }
    }
    first.unwrap_or_default()
}

/// Swap-conservation violations the independent per-id [`weapon_bounds`] can't
/// see: a model's replaceable slot holds the base weapon OR one of its swap
/// replacements, never both, so `count(base) + Σ count(replacements)` cannot
/// exceed `model_count`. Enforced only for the unambiguous shape — a base weapon
/// swapped out by plain (non-choice) options that replace it alone, whose
/// replacement ids are unique within this unit's option set and aren't
/// themselves base weapons. Mirror of `tools/src/data/loadout.ts`.
fn swap_conflicts(
    unit: &Unit,
    model_count: u64,
    options: &[&WargearOption],
    counts: &HashMap<String, i64>,
    models: Option<&[LoadoutModel]>,
) -> Vec<Violation> {
    let base_map = base_counts(unit, model_count, options, models);
    let base_ids: HashSet<String> = base_map.keys().cloned().collect();
    let mut added_by: HashMap<String, u32> = HashMap::new();
    for o in options {
        for id in &o.replacement {
            *added_by.entry(id.to_string()).or_insert(0) += 1;
        }
        for group in &o.replacement_choice {
            for id in group {
                *added_by.entry(id.to_string()).or_insert(0) += 1;
            }
        }
    }
    let mut out = Vec::new();
    for base in &base_ids {
        let mut clean_adds: HashSet<String> = HashSet::new();
        let mut messy = false;
        for o in options {
            if !o.replaces.iter().any(|r| r.as_str() == base.as_str()) {
                continue;
            }
            // Only a plain, single-target swap of this exact base weapon is unambiguous.
            if o.replaces.len() != 1 || !o.replacement_choice.is_empty() {
                messy = true;
                break;
            }
            for b in &o.replacement {
                if base_ids.contains(b.as_str())
                    || added_by.get(b.as_str()).copied().unwrap_or(0) > 1
                {
                    messy = true;
                    break;
                }
                clean_adds.insert(b.to_string());
            }
            if messy {
                break;
            }
        }
        if messy || clean_adds.is_empty() {
            continue;
        }
        // The slot can hold at most as many weapons as there are models carrying
        // this base weapon by default — its base count (model_count when not
        // per-model).
        let cap = base_map.get(base).copied().unwrap_or(model_count as i64);
        let mut total = counts.get(base).copied().unwrap_or(0);
        for b in &clean_adds {
            total += counts.get(b).copied().unwrap_or(0);
        }
        if total > cap {
            out.push(Violation {
                id: base.clone(),
                code: ViolationCode::SwapConflict,
                message: format!(
                    "{base} and its swap replacement(s) total {total}, exceeding {cap} \
                     (a model takes the base weapon or a swap, not both)"
                ),
            });
        }
    }
    out
}

#[cfg(all(test, feature = "bundled-data"))]
mod tests {
    use super::*;
    use crate::Dataset;

    fn berzerkers() -> (&'static crate::generated::Unit, Vec<&'static WargearOption>) {
        let ds = Dataset::embedded();
        let bz = ds
            .units
            .get("khorne-berzerkers")
            .expect("berzerkers in dataset");
        (bz, ds.wargear_options_of(bz))
    }

    /// A synthetic unit carrying only the given weapon ids — for data-independent
    /// loadout-maths tests (dump-primary wargear data is regenerated per ingest, so
    /// a real unit's advisory maximal would couple these tests to churning data).
    fn syn_unit(weapon_ids: &[&str]) -> crate::generated::Unit {
        serde_json::from_value(serde_json::json!({
            "id": "syn-unit", "name": "Synthetic", "faction_id": "test",
            "game_version": { "edition": "10th", "dataslate": "2025-q3" },
            "is_legend": false, "points_provisional": false,
            "weapon_ids": weapon_ids, "ability_ids": [], "profiles": [],
            "points": [], "allied_points": [],
        }))
        .expect("synthetic unit deserializes")
    }
    fn syn_opt(mut j: serde_json::Value) -> WargearOption {
        // faction_id is required on wargear-option (Stage A); inject a default so the
        // data-independent fixtures stay terse.
        if j.get("faction_id").is_none() {
            j["faction_id"] = serde_json::json!("test");
        }
        serde_json::from_value(j).expect("synthetic option deserializes")
    }

    #[test]
    fn maximal_loadout_applies_every_swap_at_cap_plus_addon() {
        // 10-model squad: bolt-pistol + chainblade base, two per-5 swaps, one add-on.
        let unit = syn_unit(&["bolt-pistol", "chainblade"]);
        let gv = serde_json::json!({ "edition": "10th", "dataslate": "2025-q3" });
        let opts = vec![
            syn_opt(
                serde_json::json!({ "id": "o1", "unit_id": "syn-unit", "game_version": gv,
                "replaces": ["bolt-pistol"], "replacement": ["plasma-pistol"], "model_constraint": { "per_n_models": 5 } }),
            ),
            syn_opt(
                serde_json::json!({ "id": "o2", "unit_id": "syn-unit", "game_version": gv,
                "replaces": ["chainblade"], "replacement": ["khornate-eviscerator"], "model_constraint": { "per_n_models": 5 } }),
            ),
            syn_opt(
                serde_json::json!({ "id": "o3", "unit_id": "syn-unit", "game_version": gv,
                "replacement": ["icon-of-khorne"], "model_constraint": { "max_count": 1 } }),
            ),
        ];
        let refs: Vec<&WargearOption> = opts.iter().collect();
        let lo = maximal_loadout(&unit, 10, &refs, None);
        let get = |k: &str| lo.counts.get(k).copied().unwrap_or(0);
        assert_eq!(get("bolt-pistol"), 8);
        assert_eq!(get("plasma-pistol"), 2);
        assert_eq!(get("chainblade"), 8);
        assert_eq!(get("khornate-eviscerator"), 2);
        assert_eq!(get("icon-of-khorne"), 1);
    }

    #[test]
    fn base_loadout_berzerkers_at_10_is_the_legal_default() {
        let (bz, opts) = berzerkers();
        let lo = base_loadout(bz, 10, &opts, None);
        // Base weapons only (never a replacement) — none of the swap/add-on ids.
        assert_eq!(lo.counts.get("bolt-pistol").copied(), Some(10));
        assert_eq!(lo.counts.get("chainblade").copied(), Some(10));
        assert_eq!(lo.counts.get("plasma-pistol").copied(), None);
        assert_eq!(lo.counts.len(), 2);
        // The legal default validates clean (the maximal set is what gets edited).
        let counts: HashMap<String, i64> = lo.counts.into_iter().collect();
        assert!(validate_loadout(bz, 10, &opts, &counts, None).is_empty());
    }

    #[test]
    fn option_cap_floors_a_ratio() {
        let (_bz, opts) = berzerkers();
        let ratio = opts
            .iter()
            .find(|o| {
                o.model_constraint
                    .as_ref()
                    .and_then(|c| c.per_n_models)
                    .is_some()
            })
            .expect("a per_n_models option");
        assert_eq!(option_cap(ratio, 10, None), 2);
        assert_eq!(option_cap(ratio, 9, None), 1);
    }

    #[test]
    fn validate_flags_over_cap_and_accepts_base() {
        let (bz, opts) = berzerkers();
        // plasma-pistol is a single-weapon per-N allowance (not a shared budget):
        // 2 on the troopers + 1 on the champion = 3 at 10 models, so 4 trips the
        // per-weapon bound. (The maximal loadout is a per-weapon upper bound and is
        // intentionally budget-blind, so it is not asserted legal here.)
        let mut over = HashMap::new();
        over.insert("plasma-pistol".to_string(), 4i64);
        let v = validate_loadout(bz, 10, &opts, &over, None);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "plasma-pistol");
        assert_eq!(v[0].code, ViolationCode::ExceedsMax);

        // The base loadout (the legal default) always validates clean.
        let lo = base_loadout(bz, 10, &opts, None);
        let counts: HashMap<String, i64> = lo.counts.into_iter().collect();
        assert!(validate_loadout(bz, 10, &opts, &counts, None).is_empty());
    }

    #[test]
    fn validate_flags_swap_conflict() {
        // A lone plain single-target swap (base → one replacement, max 1): one or
        // the other, never both. Per-id bounds pass (each in [0,1]); only the
        // swap-conservation check catches keeping both.
        let unit = syn_unit(&["diabolus-heavy-stubber"]);
        let opts = vec![syn_opt(serde_json::json!({
            "id": "o1", "unit_id": "syn-unit",
            "game_version": { "edition": "10th", "dataslate": "2025-q3" },
            "replaces": ["diabolus-heavy-stubber"], "replacement": ["havoc-multi-launcher"],
            "model_constraint": { "max_count": 1 },
        }))];
        let refs: Vec<&WargearOption> = opts.iter().collect();
        let mut both = HashMap::new();
        both.insert("diabolus-heavy-stubber".to_string(), 1i64);
        both.insert("havoc-multi-launcher".to_string(), 1i64);
        let v = validate_loadout(&unit, 1, &refs, &both, None);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "diabolus-heavy-stubber");
        assert_eq!(v[0].code, ViolationCode::SwapConflict);

        let mut keep = HashMap::new();
        keep.insert("diabolus-heavy-stubber".to_string(), 1i64);
        assert!(validate_loadout(&unit, 1, &refs, &keep, None).is_empty());
        let mut swap = HashMap::new();
        swap.insert("havoc-multi-launcher".to_string(), 1i64);
        assert!(validate_loadout(&unit, 1, &refs, &swap, None).is_empty());
    }

    #[test]
    fn single_weapon_flat_budget_caps_bounds_and_maximal() {
        // 1-model unit, two slots that can each add "sword" (cf. Knight Destrier).
        // Without the flat-budget clamp the weapon sums to 2 across the slots.
        let unit: crate::generated::Unit = serde_json::from_value(serde_json::json!({
            "id": "syn-unit", "name": "Synthetic", "faction_id": "test",
            "game_version": { "edition": "10th", "dataslate": "2025-q3" },
            "is_legend": false, "points_provisional": false,
            "weapon_ids": ["gun-a", "gun-b"], "ability_ids": [], "profiles": [],
            "points": [], "allied_points": [],
            "wargear_budgets": [{ "items": ["sword"], "count": 1, "per_models": 0 }],
        }))
        .expect("unit deserializes");
        let gv = serde_json::json!({ "edition": "10th", "dataslate": "2025-q3" });
        let opts = vec![
            syn_opt(
                serde_json::json!({ "id": "o1", "unit_id": "syn-unit", "game_version": gv,
                "replaces": ["gun-a"], "replacement": ["sword"], "model_constraint": { "any_number": true } }),
            ),
            syn_opt(
                serde_json::json!({ "id": "o2", "unit_id": "syn-unit", "game_version": gv,
                "replaces": ["gun-b"], "replacement": ["sword"], "model_constraint": { "any_number": true } }),
            ),
        ];
        let refs: Vec<&WargearOption> = opts.iter().collect();
        let bounds = weapon_bounds(&unit, 1, &refs, None);
        assert_eq!(bounds.get("sword"), Some(&WeaponBound { min: 0, max: 1 }));
        let lo = maximal_loadout(&unit, 1, &refs, None);
        assert_eq!(lo.counts.get("sword").copied().unwrap_or(0), 1);
        assert_eq!(clamp_weapon_count(&bounds, "sword", 2), 1);
    }
}
