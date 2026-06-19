//! Whole-army roster legality: the per-unit loadout check on every resolved
//! unit, plus the nine army-construction dimensions (enhancements, leader
//! attachment, points, detachment points, force disposition, detachment
//! tags/restrictions, warlord, unit minimums).
//!
//! A roster is legal iff its `army` violations contain no `error`-severity entry
//! and every `units[].violations` is empty. Mirror of
//! `tools/src/data/roster-resolve.ts` (`validateRosterCore` / `checkRoster`).

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::data::battle_sizes::{detachment_cap_for_battle_size, points_limit_for_battle_size};
use crate::data::loadout::{check_unit_legality, loadout_models, loadout_tiers, Violation};
use crate::data::pricing::base_unit_points;
use crate::generated::{Unit, UnitRole};
use crate::import::{BattleSize, Roster};
use crate::Dataset;

/// Army-construction violation codes (distinct from per-unit loadout codes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RosterViolationCode {
    EnhancementWrongDetachment,
    EnhancementOnNonCharacter,
    EnhancementKeywordMismatch,
    EnhancementExcludedKeyword,
    EnhancementOverMaxTargets,
    LeaderAttachmentIllegal,
    LeaderMustAttach,
    PointsOverLimit,
    DetachmentPointsOver,
    DispositionNotPicked,
    DispositionInvalid,
    DetachmentTagConflict,
    DetachmentRestrictionRequired,
    DetachmentRestrictionExcluded,
    UnitExcludedFromFaction,
    NoWarlord,
    MultipleWarlords,
    UnitMinimumUnmet,
}

impl RosterViolationCode {
    pub fn as_str(self) -> &'static str {
        match self {
            RosterViolationCode::EnhancementWrongDetachment => "enhancement-wrong-detachment",
            RosterViolationCode::EnhancementOnNonCharacter => "enhancement-on-non-character",
            RosterViolationCode::EnhancementKeywordMismatch => "enhancement-keyword-mismatch",
            RosterViolationCode::EnhancementExcludedKeyword => "enhancement-excluded-keyword",
            RosterViolationCode::EnhancementOverMaxTargets => "enhancement-over-max-targets",
            RosterViolationCode::LeaderAttachmentIllegal => "leader-attachment-illegal",
            RosterViolationCode::LeaderMustAttach => "leader-must-attach",
            RosterViolationCode::PointsOverLimit => "points-over-limit",
            RosterViolationCode::DetachmentPointsOver => "detachment-points-over",
            RosterViolationCode::DispositionNotPicked => "disposition-not-picked",
            RosterViolationCode::DispositionInvalid => "disposition-invalid",
            RosterViolationCode::DetachmentTagConflict => "detachment-tag-conflict",
            RosterViolationCode::DetachmentRestrictionRequired => "detachment-restriction-required",
            RosterViolationCode::DetachmentRestrictionExcluded => "detachment-restriction-excluded",
            RosterViolationCode::UnitExcludedFromFaction => "unit-excluded-from-faction",
            RosterViolationCode::NoWarlord => "no-warlord",
            RosterViolationCode::MultipleWarlords => "multiple-warlords",
            RosterViolationCode::UnitMinimumUnmet => "unit-minimum-unmet",
        }
    }
}

/// Violation severity. A roster is legal iff it has no `Error` violations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warn,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warn => "warn",
        }
    }
}

/// One army-level legality violation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterViolation {
    pub code: RosterViolationCode,
    /// Offending entity id (enhancement/unit/keyword/tag), or "roster" for army-wide.
    pub id: String,
    pub message: String,
    /// Index into the roster's units for unit-scoped codes; `None` for army-wide.
    pub unit_index: Option<usize>,
    pub severity: Severity,
}

/// The loadout-legality verdict for one resolved roster unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitLegality {
    pub unit_id: String,
    pub unit_index: usize,
    pub model_count: u64,
    pub violations: Vec<Violation>,
}

/// The full roster-legality verdict: per-unit loadout + army-construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterLegality {
    pub units: Vec<UnitLegality>,
    pub army: Vec<RosterViolation>,
}

/// One unit in the normalised roster the core checker consumes.
#[derive(Debug, Clone)]
pub struct NormUnit {
    pub unit_id: String,
    pub model_count: u64,
    pub is_warlord: bool,
    pub enhancement_id: Option<String>,
    pub leader_bodyguard_id: Option<String>,
    pub counts: HashMap<String, i64>,
}

/// Normalised roster input shared by [`check_roster`] (from a full [`Roster`])
/// and the `check_roster_legality` runner op (from a compact spec), so the two
/// entry points run the exact same checks.
#[derive(Debug, Clone)]
pub struct NormRoster {
    pub faction_id: Option<String>,
    pub battle_size: Option<BattleSize>,
    pub force_disposition: Option<String>,
    pub detachment_ids: Vec<String>,
    pub units: Vec<NormUnit>,
}

/// Union of a unit's `keywords` and `faction_keywords` as a string set.
fn keyword_set(view: &Unit) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Some(kws) = &view.keywords {
        for k in &kws.0 {
            out.insert(k.as_str().to_string());
        }
    }
    if let Some(kws) = &view.faction_keywords {
        for k in &kws.0 {
            out.insert(k.as_str().to_string());
        }
    }
    out
}

/// Whether a unit counts as a Character for enhancement eligibility.
fn is_character(view: &Unit) -> bool {
    matches!(
        view.role,
        Some(UnitRole::Character) | Some(UnitRole::EpicHero)
    ) || view
        .keywords
        .as_ref()
        .map(|k| k.0.iter().any(|kw| kw.as_str() == "Character"))
        .unwrap_or(false)
}

/// The shared roster-legality core. Runs the per-unit loadout check on every
/// resolved unit, then the nine army-construction dimensions. `unit_index` on a
/// unit-scoped violation indexes `spec.units` (= the roster's unit order).
/// Mirror of TS `validateRosterCore`.
pub fn validate_roster_core(spec: &NormRoster, dataset: &Dataset) -> RosterLegality {
    let mut army: Vec<RosterViolation> = Vec::new();
    let faction = spec.faction_id.as_deref();

    let resolve_unit = |unit_id: &str| -> Option<&Unit> {
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
            .or_else(|| dataset.units.get(unit_id))
    };

    let views: Vec<Option<&Unit>> = spec
        .units
        .iter()
        .map(|u| resolve_unit(&u.unit_id))
        .collect();

    // --- Per-unit loadout (reuse the tier/bounds checker). --------------------
    let mut units: Vec<UnitLegality> = Vec::new();
    for (idx, su) in spec.units.iter().enumerate() {
        let Some(view) = views[idx] else { continue };
        let options = dataset.wargear_options_of(view);
        let comp = dataset.unit_compositions.iter().find(|c| {
            c.unit_id.as_str() == view.id.as_str()
                && c.faction_id.as_str() == view.faction_id.as_str()
        });
        let models = comp.map(|c| loadout_models(&c.models));
        let tiers = comp.map(|c| loadout_tiers(&c.tiers));
        let violations = check_unit_legality(
            view,
            su.model_count,
            &options,
            &su.counts,
            models.as_deref(),
            tiers.as_deref(),
        );
        units.push(UnitLegality {
            unit_id: view.id.as_str().to_string(),
            unit_index: idx,
            model_count: su.model_count,
            violations,
        });
    }

    let detachments: Vec<&crate::generated::Detachment> = spec
        .detachment_ids
        .iter()
        .filter_map(|id| dataset.detachments.get(id))
        .collect();
    let primary = detachments.first().copied();

    // --- Enhancements: per-unit eligibility + army-wide uniqueness. -----------
    let mut enh_uses: BTreeMap<String, u64> = BTreeMap::new();
    for (idx, su) in spec.units.iter().enumerate() {
        let Some(enh_id) = &su.enhancement_id else {
            continue;
        };
        *enh_uses.entry(enh_id.clone()).or_insert(0) += 1;
        let (Some(enh), Some(view)) = (dataset.enhancements.get(enh_id), views[idx]) else {
            continue;
        };
        if !spec
            .detachment_ids
            .iter()
            .any(|d| d == enh.detachment_id.as_str())
        {
            army.push(RosterViolation {
                code: RosterViolationCode::EnhancementWrongDetachment,
                id: enh.id.as_str().to_string(),
                message: format!(
                    "{} is not from a detachment in this roster",
                    enh.id.as_str()
                ),
                unit_index: Some(idx),
                severity: Severity::Error,
            });
        }
        if !is_character(view) && !enh.upgrade_tag {
            army.push(RosterViolation {
                code: RosterViolationCode::EnhancementOnNonCharacter,
                id: enh.id.as_str().to_string(),
                message: format!("{} can only be taken by a Character", enh.id.as_str()),
                unit_index: Some(idx),
                severity: Severity::Error,
            });
        }
        let kws = keyword_set(view);
        if let Some(req) = &enh.keyword_restrictions {
            if req.0.iter().any(|k| !kws.contains(k.as_str())) {
                army.push(RosterViolation {
                    code: RosterViolationCode::EnhancementKeywordMismatch,
                    id: enh.id.as_str().to_string(),
                    message: format!(
                        "{} lacks a keyword required by {}",
                        view.id.as_str(),
                        enh.id.as_str()
                    ),
                    unit_index: Some(idx),
                    severity: Severity::Error,
                });
            }
        }
        if let Some(excl) = &enh.exclusion_keywords {
            if excl.0.iter().any(|k| kws.contains(k.as_str())) {
                army.push(RosterViolation {
                    code: RosterViolationCode::EnhancementExcludedKeyword,
                    id: enh.id.as_str().to_string(),
                    message: format!(
                        "{} carries a keyword excluded by {}",
                        view.id.as_str(),
                        enh.id.as_str()
                    ),
                    unit_index: Some(idx),
                    severity: Severity::Error,
                });
            }
        }
    }
    for (enh_id, uses) in &enh_uses {
        let max = dataset
            .enhancements
            .get(enh_id)
            .map(|e| e.max_targets.get())
            .unwrap_or(1);
        if *uses > max {
            army.push(RosterViolation {
                code: RosterViolationCode::EnhancementOverMaxTargets,
                id: enh_id.clone(),
                message: format!("{enh_id} taken {uses} times, max {max}"),
                unit_index: None,
                severity: Severity::Error,
            });
        }
    }

    // --- Leader attachment. ----------------------------------------------------
    for (idx, su) in spec.units.iter().enumerate() {
        let Some(view) = views[idx] else { continue };
        if let Some(bodyguard_id) = &su.leader_bodyguard_id {
            let eligible: Vec<String> = dataset
                .bodyguards_attachable_from(view.id.as_str())
                .into_iter()
                .map(|v| v.id.as_str().to_string())
                .collect();
            if !eligible.iter().any(|e| e == bodyguard_id) {
                army.push(RosterViolation {
                    code: RosterViolationCode::LeaderAttachmentIllegal,
                    id: view.id.as_str().to_string(),
                    message: format!("{} cannot attach to {}", view.id.as_str(), bodyguard_id),
                    unit_index: Some(idx),
                    severity: Severity::Error,
                });
            }
        } else if view.attachment_role == Some(crate::generated::UnitAttachmentRole::Support) {
            army.push(RosterViolation {
                code: RosterViolationCode::LeaderMustAttach,
                id: view.id.as_str().to_string(),
                message: format!(
                    "{} is a Support character and must attach to a unit",
                    view.id.as_str()
                ),
                unit_index: Some(idx),
                severity: Severity::Error,
            });
        }
    }

    // --- Points total (ordinal-aware) + enhancement costs. --------------------
    let mut ordinals: HashMap<String, u64> = HashMap::new();
    let mut total: u64 = 0;
    for (idx, su) in spec.units.iter().enumerate() {
        let Some(view) = views[idx] else { continue };
        let ord = ordinals.entry(su.unit_id.clone()).or_insert(0);
        *ord += 1;
        total += base_unit_points(view, su.model_count, *ord);
        if let Some(enh_id) = &su.enhancement_id {
            total += dataset
                .enhancements
                .get(enh_id)
                .map(|e| e.cost)
                .unwrap_or(0);
        }
    }
    if let Some(limit) = points_limit_for_battle_size(spec.battle_size) {
        if total > limit {
            army.push(RosterViolation {
                code: RosterViolationCode::PointsOverLimit,
                id: "roster".to_string(),
                message: format!("army totals {total}, over the {limit} limit"),
                unit_index: None,
                severity: Severity::Error,
            });
        }
    }

    // --- Detachment-point budget. ---------------------------------------------
    if let Some(cap) = detachment_cap_for_battle_size(spec.battle_size) {
        let dp_used: u64 = detachments
            .iter()
            .map(|d| d.detachment_points.map(|n| n.get()).unwrap_or(0))
            .sum();
        if dp_used > cap {
            army.push(RosterViolation {
                code: RosterViolationCode::DetachmentPointsOver,
                id: "roster".to_string(),
                message: format!("detachments cost {dp_used} DP, over the {cap} budget"),
                unit_index: None,
                severity: Severity::Error,
            });
        }
    }

    // --- Force disposition (advisory / warn). ---------------------------------
    match &spec.force_disposition {
        None => army.push(RosterViolation {
            code: RosterViolationCode::DispositionNotPicked,
            id: "roster".to_string(),
            message: "no Force Disposition selected".to_string(),
            unit_index: None,
            severity: Severity::Warn,
        }),
        Some(disp) => {
            if let Some(p) = primary {
                if let Some(fds) = &p.force_dispositions {
                    if !fds.iter().any(|d| d.as_str() == disp) {
                        army.push(RosterViolation {
                            code: RosterViolationCode::DispositionInvalid,
                            id: disp.clone(),
                            message: format!("{disp} is not offered by {}", p.id.as_str()),
                            unit_index: None,
                            severity: Severity::Warn,
                        });
                    }
                }
            }
        }
    }

    // --- Detachment tag uniqueness (one per shared tag). ----------------------
    let mut tag_counts: BTreeMap<String, u64> = BTreeMap::new();
    for d in &detachments {
        if let Some(tags) = &d.tags {
            for t in tags {
                *tag_counts.entry(t.clone()).or_insert(0) += 1;
            }
        }
    }
    for (tag, n) in &tag_counts {
        if *n > 1 {
            army.push(RosterViolation {
                code: RosterViolationCode::DetachmentTagConflict,
                id: tag.clone(),
                message: format!("{n} detachments share the '{tag}' tag"),
                unit_index: None,
                severity: Severity::Error,
            });
        }
    }

    // --- Detachment restrictions (required/excluded army keywords, per unit). -
    for d in &detachments {
        let Some(r) = &d.restrictions else { continue };
        for (idx, _su) in spec.units.iter().enumerate() {
            let Some(view) = views[idx] else { continue };
            let kws = keyword_set(view);
            if let Some(req) = &r.required_keywords {
                if req.0.iter().any(|k| !kws.contains(k.as_str())) {
                    army.push(RosterViolation {
                        code: RosterViolationCode::DetachmentRestrictionRequired,
                        id: view.id.as_str().to_string(),
                        message: format!(
                            "{} lacks a keyword required by {}",
                            view.id.as_str(),
                            d.id.as_str()
                        ),
                        unit_index: Some(idx),
                        severity: Severity::Error,
                    });
                }
            }
            if let Some(excl) = &r.excluded_keywords {
                if excl.0.iter().any(|k| kws.contains(k.as_str())) {
                    army.push(RosterViolation {
                        code: RosterViolationCode::DetachmentRestrictionExcluded,
                        id: view.id.as_str().to_string(),
                        message: format!(
                            "{} carries a keyword excluded by {}",
                            view.id.as_str(),
                            d.id.as_str()
                        ),
                        unit_index: Some(idx),
                        severity: Severity::Error,
                    });
                }
            }
        }
    }

    // --- Faction exclusions (a generic unit barred from this army's chapter). --
    // The shared Space Marine pool can't drop a generic datasheet for one chapter,
    // so a removed-without-replacement unit (e.g. Librarians for Black Templars)
    // carries `excluded_faction_keywords`; it is illegal when the army's faction
    // keywords intersect that list. Mirror of TS `unit-excluded-from-faction`.
    let faction_keywords: HashSet<String> = faction
        .and_then(|f| dataset.factions.get(f))
        .and_then(|fac| fac.keywords.as_ref())
        .map(|k| k.0.iter().map(|kw| kw.as_str().to_string()).collect())
        .unwrap_or_default();
    if !faction_keywords.is_empty() {
        for (idx, _su) in spec.units.iter().enumerate() {
            let Some(view) = views[idx] else { continue };
            let Some(excl) = &view.excluded_faction_keywords else {
                continue;
            };
            let barred: Vec<&str> = excl
                .0
                .iter()
                .map(|k| k.as_str())
                .filter(|k| faction_keywords.contains(*k))
                .collect();
            if !barred.is_empty() {
                army.push(RosterViolation {
                    code: RosterViolationCode::UnitExcludedFromFaction,
                    id: view.id.as_str().to_string(),
                    message: format!(
                        "{} cannot be taken by {} (barred by {})",
                        view.id.as_str(),
                        faction.unwrap_or(""),
                        barred.join(", ")
                    ),
                    unit_index: Some(idx),
                    severity: Severity::Error,
                });
            }
        }
    }

    // --- Warlord present (exactly one). ---------------------------------------
    let warlords = spec.units.iter().filter(|su| su.is_warlord).count();
    if warlords == 0 {
        army.push(RosterViolation {
            code: RosterViolationCode::NoWarlord,
            id: "roster".to_string(),
            message: "army has no warlord".to_string(),
            unit_index: None,
            severity: Severity::Error,
        });
    } else if warlords > 1 {
        army.push(RosterViolation {
            code: RosterViolationCode::MultipleWarlords,
            id: "roster".to_string(),
            message: format!("army has {warlords} warlords"),
            unit_index: None,
            severity: Severity::Error,
        });
    }

    // --- Unit minimums (e.g. Houndpack: 3+ WAR DOG units). --------------------
    for d in &detachments {
        for um in &d.unit_minimums {
            let keyword = um.keyword.as_str();
            let count = views
                .iter()
                .filter(|v| {
                    v.map(|view| keyword_set(view).contains(keyword))
                        .unwrap_or(false)
                })
                .count() as u64;
            if count < um.min.get() {
                army.push(RosterViolation {
                    code: RosterViolationCode::UnitMinimumUnmet,
                    id: keyword.to_string(),
                    message: format!(
                        "{} requires {}+ {} units, found {}",
                        d.id.as_str(),
                        um.min.get(),
                        keyword,
                        count
                    ),
                    unit_index: None,
                    severity: Severity::Error,
                });
            }
        }
    }

    army.sort_by(|a, b| {
        if a.code == b.code {
            a.id.cmp(&b.id)
        } else {
            a.code.as_str().cmp(b.code.as_str())
        }
    });
    RosterLegality { units, army }
}

/// Whole-army legality for a resolved [`Roster`]. A roster is legal iff `army`
/// has no `Error`-severity entries and every `units[].violations` is empty.
/// Mirror of TS `checkRoster`.
pub fn check_roster(roster: &Roster, dataset: &Dataset) -> RosterLegality {
    let units = roster
        .units
        .iter()
        .map(|u| {
            let mut counts: HashMap<String, i64> = HashMap::new();
            for w in &u.wargear {
                if let Some(id) = &w.ref_.id {
                    *counts.entry(id.clone()).or_insert(0) += w.count as i64;
                }
            }
            NormUnit {
                unit_id: u.ref_.id.clone().unwrap_or_default(),
                model_count: u.model_count,
                is_warlord: u.is_warlord,
                enhancement_id: u.enhancement.as_ref().and_then(|e| e.id.clone()),
                leader_bodyguard_id: u
                    .leader_attachment
                    .as_ref()
                    .and_then(|la| la.bodyguard_ref.id.clone()),
                counts,
            }
        })
        .collect();
    let spec = NormRoster {
        faction_id: roster.faction_id.clone(),
        battle_size: roster.battle_size,
        force_disposition: roster.force_disposition.clone(),
        detachment_ids: roster
            .detachments
            .iter()
            .filter_map(|d| d.ref_.id.clone())
            .collect(),
        units,
    };
    validate_roster_core(&spec, dataset)
}
