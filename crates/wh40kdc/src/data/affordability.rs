//! `candidate_affordability` — given the units already in a list and a points
//! budget, price the cheapest next copy of each candidate unit and flag whether
//! it still fits. Powers the list-builder's "sort cheapest-first / grey out the
//! unaffordable" catalog affordance, and is exposed as a cross-impl primitive so
//! the maths is pinned by `conformance/affordability/`.
//!
//! The cost of "one more copy" is ordinal-aware: 11e prices some datasheets by
//! army ordinal (see [`base_unit_points`]), so the next copy of a datasheet you
//! already field twice may cost more than the first. `next_copy_cost` is the
//! cheapest *entry point* — the minimum over the unit's points tiers of
//! `base_unit_points(unit, tier.models, next_ordinal)` — i.e. taking it at its
//! smallest legal size, at the ordinal it would enter the army.
//!
//! Mirror of `tools/src/data/affordability.ts`.

use std::collections::HashMap;

use crate::data::battle_sizes::points_limit_for_battle_size;
use crate::data::pricing::base_unit_points;
use crate::generated::Unit;
use crate::import::BattleSize;
use crate::Dataset;

/// One unit already in the list (fixes the running total + per-datasheet ordinals).
#[derive(Debug, Clone)]
pub struct AffordabilityUnit {
    pub unit_id: String,
    pub model_count: u64,
    pub enhancement_id: Option<String>,
}

/// Compact input shared by [`candidate_affordability`] and the runner op.
#[derive(Debug, Clone)]
pub struct AffordabilitySpec {
    pub faction_id: Option<String>,
    pub battle_size: Option<BattleSize>,
    /// Explicit points limit; overrides the battle-size default when set.
    pub points_limit_override: Option<u64>,
    pub units: Vec<AffordabilityUnit>,
    /// Units to price; defaults to every unit in `faction_id` when `None`.
    pub candidate_unit_ids: Option<Vec<String>>,
}

/// Affordability verdict for one candidate unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateCost {
    pub unit_id: String,
    pub next_copy_cost: u64,
    pub affordable: bool,
}

/// The cheapest cost to field one more copy of `unit` at army ordinal
/// `next_ordinal` — the minimum over its points tiers, taking it at its
/// smallest legal size. Zero when the unit has no points tiers.
fn cheapest_next_copy(unit: &Unit, next_ordinal: u64) -> u64 {
    unit.points
        .iter()
        .map(|t| base_unit_points(unit, t.models.get(), next_ordinal))
        .min()
        .unwrap_or(0)
}

/// Price the cheapest next copy of each candidate and flag affordability against
/// the remaining budget. Returns one [`CandidateCost`] per candidate that
/// resolves in the dataset, sorted ascending by `(next_copy_cost, unit_id)` —
/// deterministic for conformance. Mirror of TS `candidateAffordability`.
pub fn candidate_affordability(spec: &AffordabilitySpec, dataset: &Dataset) -> Vec<CandidateCost> {
    let faction = spec.faction_id.as_deref();
    let resolve = |unit_id: &str| -> Option<&Unit> {
        if unit_id.is_empty() {
            return None;
        }
        faction
            .and_then(|f| {
                dataset
                    .units
                    .by_faction(f)
                    .into_iter()
                    .find(|u| u.id.as_str() == unit_id)
            })
            .or_else(|| dataset.units.get_any(unit_id))
    };

    // Running total of the current list (ordinal-aware) + enhancement costs.
    let mut ordinals: HashMap<String, u64> = HashMap::new();
    let mut spent: u64 = 0;
    for u in &spec.units {
        let Some(view) = resolve(&u.unit_id) else {
            continue;
        };
        let ord = ordinals.entry(u.unit_id.clone()).or_insert(0);
        *ord += 1;
        spent += base_unit_points(view, u.model_count, *ord);
        if let Some(enh_id) = &u.enhancement_id {
            spent += dataset
                .enhancements
                .get(enh_id)
                .map(|e| e.cost)
                .unwrap_or(0);
        }
    }

    let limit = match spec.points_limit_override {
        Some(l) => Some(l),
        None => points_limit_for_battle_size(spec.battle_size),
    };
    // `None` limit ⇒ unbounded budget (the TS `Infinity`). Compute remaining as a
    // signed value so an over-budget list yields a negative remaining (everything
    // unaffordable) rather than wrapping.
    let remaining: Option<i64> = limit.map(|l| l as i64 - spent as i64);

    // Candidate set: explicit list, else every unit in the faction.
    let candidate_ids: Vec<String> = match &spec.candidate_unit_ids {
        Some(ids) => ids.clone(),
        None => match faction {
            Some(f) => dataset
                .units
                .by_faction(f)
                .into_iter()
                .map(|u| u.id.as_str().to_string())
                .collect(),
            None => Vec::new(),
        },
    };

    let mut out: Vec<CandidateCost> = Vec::new();
    for unit_id in candidate_ids {
        let Some(view) = resolve(&unit_id) else {
            continue;
        };
        let next_ordinal = ordinals.get(&unit_id).copied().unwrap_or(0) + 1;
        let next_copy_cost = cheapest_next_copy(view, next_ordinal);
        let affordable = match remaining {
            None => true,
            Some(r) => (next_copy_cost as i64) <= r,
        };
        out.push(CandidateCost {
            unit_id: view.id.as_str().to_string(),
            next_copy_cost,
            affordable,
        });
    }
    out.sort_by(|a, b| {
        a.next_copy_cost
            .cmp(&b.next_copy_cost)
            .then_with(|| a.unit_id.cmp(&b.unit_id))
    });
    out
}
