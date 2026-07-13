//! The expected-value damage engine.
//!
//! Mirrors `tools/src/cruncher/engine.ts`. Closed-form math over schema
//! profiles + a flat [`Buff`] stack. No sampling, no I/O. Auto-injects every
//! weapon-keyword on the attacker's profile as a buff (so callers don't have
//! to enumerate intrinsics), then resolves the stack via [`resolve_buffs`],
//! then walks attacks → hits → wounds → unsaved → damage → after-fnp →
//! models-killed.
//!
//! The dataset is required (and defaults to [`Dataset::embedded`]) — without
//! it the engine can't look up weapon-keyword effects.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::buffs::{
    resolve_buffs, Buff, EngineContext, FeelNoPainState, ResolvedModifiers, WeaponKeywordRef,
};
use super::from_keyword::buffs_from_keyword;
use crate::data::Dataset;
use crate::{KeywordList, StatValue, Unit, Weapon, WeaponProfilesItem, WeaponProfilesItemRange};

/// Whether a weapon profile is a melee profile (`range == "Melee"`). Mirror of
/// the TS `isMeleeProfile`: 11e weapons can mix ranged and melee profiles, so
/// melee/ranged is a per-profile property, not a weapon-level one.
fn is_melee_profile(profile: &WeaponProfilesItem) -> bool {
    matches!(&profile.range, Some(WeaponProfilesItemRange::String(s)) if s == "Melee")
}

/// A weapon + which of its `profiles[]` to fire. Borrows the catalog record
/// so the engine never owns the dataset.
#[derive(Clone, Copy, Debug)]
pub struct AttackProfileRef<'a> {
    pub weapon: &'a Weapon,
    pub profile_index: usize,
}

/// A target unit + which `profiles[]` is taking the hits. `model_count`
/// overrides `unit.model_count.min` when set.
#[derive(Clone, Copy, Debug)]
pub struct TargetProfileRef<'a> {
    pub unit: &'a Unit,
    pub profile_index: usize,
    pub model_count: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct EngineInput<'a> {
    pub attacker: AttackProfileRef<'a>,
    pub target: TargetProfileRef<'a>,
    pub models_firing: u64,
    /// User / ability / manual buffs. Weapon-keyword buffs are auto-injected.
    pub buffs: Vec<Buff>,
    pub context: EngineContext,
}

/// Named stages of the projection pipeline. Discriminants serialize to the
/// same kebab-case strings the conformance corpus uses.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StageName {
    Attacks,
    Hits,
    Wounds,
    Unsaved,
    Damage,
    AfterFnp,
    ModelsKilled,
}

/// One stage of the projection. `detail` is a human-readable trace string —
/// **byte-equality with TS is not a contract**; the conformance corpus pins
/// only `expected`.
#[derive(Clone, Debug)]
pub struct Stage {
    pub name: StageName,
    pub expected: f64,
    pub detail: String,
}

#[derive(Clone, Debug)]
pub struct EngineOutput {
    pub stages: Vec<Stage>,
    pub resolved: ResolvedModifiers,
}

/// Failures the engine can't recover from: out-of-range profile indexes,
/// missing required stats, or unparseable dice-notation strings. Better to
/// surface these than to silently return zero and produce a confidently wrong
/// projection.
#[derive(Clone, Debug)]
pub enum CruncherError {
    ProfileOutOfRange {
        weapon_id: String,
        profile_index: usize,
    },
    TargetProfileOutOfRange {
        unit_id: String,
        profile_index: usize,
    },
    MissingHitStat {
        weapon_id: String,
        profile_index: usize,
        melee: bool,
    },
    ParseStat(String),
}

impl fmt::Display for CruncherError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProfileOutOfRange {
                weapon_id,
                profile_index,
            } => write!(
                f,
                "crunch: attacker.profile_index={profile_index} is out of range for weapon {weapon_id}"
            ),
            Self::TargetProfileOutOfRange {
                unit_id,
                profile_index,
            } => write!(
                f,
                "crunch: target.profile_index={profile_index} is out of range for unit {unit_id}"
            ),
            Self::MissingHitStat {
                weapon_id,
                profile_index,
                melee,
            } => write!(
                f,
                "crunch: weapon {weapon_id} profile {profile_index} missing {}",
                if *melee { "WS" } else { "BS" }
            ),
            Self::ParseStat(s) => write!(f, "eval_stat_value: cannot parse {s:?}"),
        }
    }
}

impl std::error::Error for CruncherError {}

/// Compute the expected per-stage projection for one (attacker, target,
/// buffs) triple. The dataset defaults to [`Dataset::embedded`] when `None` —
/// pass an alternate when crunching against a different bundle.
pub fn crunch(
    input: &EngineInput,
    dataset: Option<&Dataset>,
) -> Result<EngineOutput, CruncherError> {
    let ds: &Dataset = match dataset {
        Some(d) => d,
        None => Dataset::embedded(),
    };

    let weapon_profile = input
        .attacker
        .weapon
        .profiles
        .get(input.attacker.profile_index)
        .ok_or_else(|| CruncherError::ProfileOutOfRange {
            weapon_id: input.attacker.weapon.id.to_string(),
            profile_index: input.attacker.profile_index,
        })?;
    let unit_profile = input
        .target
        .unit
        .profiles
        .get(input.target.profile_index)
        .ok_or_else(|| CruncherError::TargetProfileOutOfRange {
            unit_id: input.target.unit.id.to_string(),
            profile_index: input.target.profile_index,
        })?;

    let target_keywords = unit_keywords_lower(input.target.unit);
    let mut ctx = input.context.clone();
    if ctx.target_keywords.is_none() {
        ctx.target_keywords = Some(target_keywords.clone());
    }

    // Auto-inject weapon-keyword buffs from the attacker profile, then append
    // the caller-supplied stack. resolve_buffs deduplicates and ranks them.
    let mut all_buffs = profile_buffs_for(input.attacker, ds, &ctx);
    all_buffs.extend(input.buffs.iter().cloned());
    let resolved = resolve_buffs(&all_buffs, &ctx);

    let mut stages: Vec<Stage> = Vec::with_capacity(7);

    // 1. Attacks
    let is_melee = is_melee_profile(weapon_profile);
    let base_a = eval_stat_value(&weapon_profile.stats.a)?;
    let attacks_per_model = base_a + resolved.attacks_mod.value;
    let rapid_fire = find_extra_keyword(&resolved, "rapid-fire");
    let half_range = ctx.within_half_range == Some(true);
    let rapid_fire_extra_per_model = match (rapid_fire, half_range) {
        (Some(kw), true) => eval_param_value(parameter(kw, "value")),
        _ => 0.0,
    };
    let blast = find_extra_keyword(&resolved, "blast");
    let target_model_count = input.target.model_count.unwrap_or_else(|| {
        input
            .target
            .unit
            .model_count
            .as_ref()
            .map(|mc| mc.min.get())
            .unwrap_or(1)
    });
    let blast_extra_per_model = if blast.is_some() {
        (target_model_count / 5) as f64
    } else {
        0.0
    };
    let models_firing = input.models_firing as f64;
    let attacks =
        models_firing * (attacks_per_model + rapid_fire_extra_per_model + blast_extra_per_model);
    stages.push(Stage {
        name: StageName::Attacks,
        expected: attacks,
        detail: attacks_detail(
            models_firing,
            attacks_per_model,
            rapid_fire_extra_per_model,
            blast_extra_per_model,
        ),
    });

    // 2. Hits
    // Cover (11e): the benefit of cover is -1 to the attacker's hit roll, not a
    // save bonus. Ranged-only, negated by ignores-cover, moot for auto-hitting
    // Torrent weapons (no hit roll).
    let ignores_cover = find_extra_keyword(&resolved, "ignores-cover").is_some();
    let covered = resolved.cover.active && !ignores_cover && !is_melee;
    let cover_hit_penalty = if covered { -1.0 } else { 0.0 };
    let hit_stat_opt = if is_melee {
        weapon_profile.stats.ws
    } else {
        weapon_profile.stats.bs
    };
    let torrent = find_extra_keyword(&resolved, "torrent").is_some();
    let (hits_raw, crit_hits, mut hits_detail) = if torrent {
        (attacks, 0.0, format!("Torrent: auto-hits ({attacks:.4})"))
    } else {
        let hit_stat = hit_stat_opt.ok_or_else(|| CruncherError::MissingHitStat {
            weapon_id: input.attacker.weapon.id.to_string(),
            profile_index: input.attacker.profile_index,
            melee: is_melee,
        })?;
        let probs = check_probabilities(CheckArgs {
            unmodified_needed: hit_stat,
            modifier: resolved.hit_mod.value + cover_hit_penalty,
            reroll: resolved
                .rerolls
                .hit
                .as_ref()
                .map(|r| r.subset)
                .map_or(RerollKind::None, RerollKind::from_subset),
            auto_fail_on_one: true,
            auto_pass_on_six: true,
            crit_threshold: 6,
        });
        let hits = attacks * probs.pass;
        let crits = attacks * probs.crit;
        let detail = format!(
            "{}{}+ (mod {}{}, reroll {}) → P(hit)={:.4}, P(crit)={:.4}",
            if is_melee { "WS" } else { "BS" },
            hit_stat,
            signed(resolved.hit_mod.value),
            if covered { ", cover -1" } else { "" },
            resolved
                .rerolls
                .hit
                .as_ref()
                .map(|r| match r.subset {
                    super::buffs::RerollSubset::Ones => "ones",
                    super::buffs::RerollSubset::AllFailures => "all-failures",
                })
                .unwrap_or("none"),
            probs.pass,
            probs.crit,
        );
        (hits, crits, detail)
    };
    let mut hits = hits_raw;
    let sustained = find_extra_keyword(&resolved, "sustained-hits");
    if let Some(kw) = sustained {
        let sustained_value = eval_param_value(parameter(kw, "value"));
        hits += crit_hits * sustained_value;
        let label = parameter(kw, "value")
            .map(value_to_label)
            .unwrap_or_else(|| "1".to_string());
        hits_detail.push_str(&format!(
            "; +Sustained Hits {label} on {crit_hits:.4} crits"
        ));
    }
    stages.push(Stage {
        name: StageName::Hits,
        expected: hits,
        detail: hits_detail,
    });

    // 3. Wounds
    let s_val = eval_stat_value(&weapon_profile.stats.s)? + resolved.strength_mod.value;
    let t_val = unit_profile.t.get() as f64 + resolved.toughness_mod.value;
    let std_wound_needed = wound_threshold(s_val, t_val);
    let mut anti_threshold: i64 = 7; // unreachable
    if let Some(anti) = find_extra_keyword(&resolved, "anti") {
        let target_kw = parameter(anti, "target_keyword")
            .and_then(Value::as_str)
            .map(str::to_lowercase);
        if let Some(target_kw) = target_kw {
            if target_keywords.iter().any(|k| k == &target_kw) {
                if let Some(t) = parameter(anti, "threshold").and_then(Value::as_i64) {
                    anti_threshold = t;
                }
            }
        }
    }
    let crit_wound_threshold = anti_threshold.min(6);

    let has_lethal = find_extra_keyword(&resolved, "lethal-hits").is_some();
    let hits_for_wound_roll = if has_lethal { hits - crit_hits } else { hits };
    let lethal_auto_wounds = if has_lethal { crit_hits } else { 0.0 };

    let wound_probs = check_probabilities(CheckArgs {
        unmodified_needed: std_wound_needed,
        modifier: resolved.wound_mod.value,
        reroll: resolved
            .rerolls
            .wound
            .as_ref()
            .map(|r| r.subset)
            .map_or(RerollKind::None, RerollKind::from_subset),
        auto_fail_on_one: true,
        auto_pass_on_six: true,
        crit_threshold: crit_wound_threshold,
    });
    let regular_wounds_from_roll = hits_for_wound_roll * (wound_probs.pass - wound_probs.crit);
    let crit_wounds_from_roll = hits_for_wound_roll * wound_probs.crit;
    let total_regular_wounds = regular_wounds_from_roll + lethal_auto_wounds;
    let has_devastating = find_extra_keyword(&resolved, "devastating-wounds").is_some();
    let mortal_wounds_stream = if has_devastating {
        crit_wounds_from_roll
    } else {
        0.0
    };
    let regular_wounds_for_saves = if has_devastating {
        total_regular_wounds
    } else {
        total_regular_wounds + crit_wounds_from_roll
    };
    let total_wounds = regular_wounds_for_saves + mortal_wounds_stream;
    stages.push(Stage {
        name: StageName::Wounds,
        expected: total_wounds,
        detail: format!(
            "S{s_val} vs T{t_val} → need {std_wound_needed}+, anti {}, P(wound)={:.4} ({:.4} crit), lethal {}, devastating {}",
            if anti_threshold <= 6 {
                format!("{anti_threshold}+ (active)")
            } else {
                "n/a".to_string()
            },
            wound_probs.pass,
            crit_wounds_from_roll,
            if has_lethal {
                format!("+{lethal_auto_wounds:.4}")
            } else {
                "—".to_string()
            },
            if has_devastating {
                format!("{mortal_wounds_stream:.4} MW")
            } else {
                "—".to_string()
            },
        ),
    });

    // 4. Saves
    let ap_mod = resolved.ap_mod.value;
    let ap = weapon_profile.stats.ap as f64 + ap_mod;
    let save_mod = resolved.save_mod.value;
    let armor_target_raw = unit_profile.sv as f64 - ap - save_mod;
    // Cover is a hit penalty (11e), applied in the hits stage above — it no
    // longer touches the save here.
    let armor_final = clamp(armor_target_raw, 2.0, 7.0);
    // The unit's printed invuln (from the profile) and any ability-granted
    // invuln combine best-wins (lowest threshold). Invuln bypasses AP, so the
    // final save is min(armor-after-AP, effective-invuln).
    // Attack-scoped invuln (issue #87): a ranged-/melee-only save applies only to
    // that attack type; fall back to the unconditional invuln_sv when unscoped.
    let printed_invuln = if is_melee {
        unit_profile.invuln_sv_melee
    } else {
        unit_profile.invuln_sv_ranged
    }
    .or(unit_profile.invuln_sv)
    .map(|n| n as f64);
    let ability_invuln = resolved.invulnerable.as_ref().map(|i| i.threshold);
    let effective_invuln = match (printed_invuln, ability_invuln) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let effective_save_target = match effective_invuln {
        Some(inv) => armor_final.min(inv),
        None => armor_final,
    };

    let save_probs = check_probabilities(CheckArgs {
        unmodified_needed: effective_save_target as i64,
        modifier: 0.0,
        reroll: resolved
            .rerolls
            .save
            .as_ref()
            .map(|r| r.subset)
            .map_or(RerollKind::None, RerollKind::from_subset),
        auto_fail_on_one: true,
        auto_pass_on_six: false,
        crit_threshold: 7,
    });
    let p_saved = if effective_save_target >= 7.0 {
        0.0
    } else {
        save_probs.pass
    };
    let unsaved = regular_wounds_for_saves * (1.0 - p_saved);
    stages.push(Stage {
        name: StageName::Unsaved,
        expected: unsaved,
        detail: format!(
            "Sv{}+, AP{}{}{}{} → effective {}+ (P(save)={:.4})",
            unit_profile.sv,
            signed(ap),
            if ap_mod != 0.0 {
                format!(" (apmod {})", signed(ap_mod))
            } else {
                String::new()
            },
            if save_mod != 0.0 {
                format!(", savemod {}", signed(save_mod))
            } else {
                String::new()
            },
            match ability_invuln {
                Some(inv) => format!(", invuln {inv}+ (ability)"),
                None => String::new(),
            },
            effective_save_target,
            p_saved,
        ),
    });

    // 5. Damage
    let base_d = eval_stat_value(&weapon_profile.stats.d)?;
    let melta = find_extra_keyword(&resolved, "melta");
    let melta_bonus = match (melta, half_range) {
        (Some(kw), true) => eval_param_value(parameter(kw, "value")),
        _ => 0.0,
    };
    let before_reduction = (base_d + melta_bonus + resolved.damage_mod.value).max(0.0);
    let damage_reduction = resolved.damage_reduction.value;
    // 10e damage-reduction abilities always carry the canonical "to a minimum
    // of 1" clause, so the floor lives in the math, not the data. The clause
    // only applies when damage-reduction is active — without it, a D1 weapon
    // with a -1 attacker damage-mod still produces 0 damage.
    let damage_per_hit = if damage_reduction > 0.0 {
        (before_reduction - damage_reduction).max(1.0)
    } else {
        before_reduction
    };
    let damage_main = unsaved * damage_per_hit;
    let damage_mortal = mortal_wounds_stream * damage_per_hit;
    let damage = damage_main + damage_mortal;
    stages.push(Stage {
        name: StageName::Damage,
        expected: damage,
        detail: format!(
            "D {base_d}{}{}{} = {damage_per_hit} per hit; main {damage_main:.4}, mortal {damage_mortal:.4}",
            if melta_bonus != 0.0 {
                format!(" + Melta {melta_bonus} (half range)")
            } else {
                String::new()
            },
            if resolved.damage_mod.value != 0.0 {
                format!(" {} (mod)", signed(resolved.damage_mod.value))
            } else {
                String::new()
            },
            if damage_reduction > 0.0 {
                format!(" -{damage_reduction} (defender, min 1)")
            } else {
                String::new()
            },
        ),
    });

    // 6. FNP
    // Two scopes compose: an all-FNP fires on every unsaved wound; a
    // mortal-FNP fires only on the mortal-wound stream. A target carrying
    // both rolls both against mortals — independent Bernoulli trials, so
    // the surviving fractions multiply.
    let p_survive_all = fnp_survival_fraction(resolved.feel_no_pain.as_ref());
    let p_survive_mortal = fnp_survival_fraction(resolved.feel_no_pain_mortal.as_ref());
    let after_main = damage_main * p_survive_all;
    let after_mortal = damage_mortal * p_survive_all * p_survive_mortal;
    let after_fnp = after_main + after_mortal;
    let fnp_detail = describe_fnp(
        resolved.feel_no_pain.as_ref(),
        resolved.feel_no_pain_mortal.as_ref(),
    );
    stages.push(Stage {
        name: StageName::AfterFnp,
        expected: after_fnp,
        detail: fnp_detail,
    });

    // 7. Models killed
    let w = unit_profile.w.get() as f64;
    let expected_models_killed = if w > 0.0 {
        (after_fnp / w).min(target_model_count as f64)
    } else {
        0.0
    };
    stages.push(Stage {
        name: StageName::ModelsKilled,
        expected: expected_models_killed,
        detail: format!(
            "W{w} per model, {target_model_count} models in target; {after_fnp:.4} damage / {w} = {:.4} (capped at {target_model_count})",
            after_fnp / w,
        ),
    });

    Ok(EngineOutput { stages, resolved })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Lower-cased union of a unit's `keywords` + `faction_keywords`.
fn unit_keywords_lower(unit: &Unit) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(KeywordList(kws)) = &unit.keywords {
        for k in kws {
            out.push(k.to_lowercase());
        }
    }
    if let Some(KeywordList(kws)) = &unit.faction_keywords {
        for k in kws {
            out.push(k.to_lowercase());
        }
    }
    out
}

/// Walk the attacker's weapon profile keywords through
/// [`buffs_from_keyword`], looking each one up in the dataset's
/// weapon-keyword catalog. Keywords missing from the catalog drop silently
/// (matches TS `manualWeaponKeywordBuffs`).
fn profile_buffs_for(
    attacker: AttackProfileRef<'_>,
    dataset: &Dataset,
    ctx: &EngineContext,
) -> Vec<Buff> {
    let Some(profile) = attacker.weapon.profiles.get(attacker.profile_index) else {
        return Vec::new();
    };
    let weapon_id = attacker.weapon.id.to_string();
    let mut out: Vec<Buff> = Vec::new();
    for kref in &profile.keywords {
        let keyword_id = kref.keyword_id.to_string();
        let Some(catalog) = dataset.weapon_keywords.get(&keyword_id) else {
            continue;
        };
        let effect_value = catalog
            .effect
            .as_ref()
            .and_then(|e| serde_json::to_value(e).ok());
        let params_value = kref
            .parameters
            .as_ref()
            .and_then(|p| serde_json::to_value(p).ok());
        out.extend(buffs_from_keyword(
            &keyword_id,
            &weapon_id,
            effect_value.as_ref(),
            params_value.as_ref(),
            ctx,
        ));
    }
    out
}

fn find_extra_keyword<'a>(
    resolved: &'a ResolvedModifiers,
    keyword_id: &str,
) -> Option<&'a WeaponKeywordRef> {
    resolved
        .extra_keywords
        .iter()
        .find(|e| e.keyword_ref.keyword_id == keyword_id)
        .map(|e| &e.keyword_ref)
}

fn parameter<'a>(kw: &'a WeaponKeywordRef, key: &str) -> Option<&'a Value> {
    kw.parameters.as_ref().and_then(|p| p.get(key))
}

/// Mean value of a stat (number or dice expression). Unrecognised strings
/// return [`CruncherError::ParseStat`] — better to surface than to silently
/// return 0 and produce a confidently wrong damage projection.
fn eval_stat_value(v: &StatValue) -> Result<f64, CruncherError> {
    match v {
        StatValue::Integer(n) => Ok(*n as f64),
        StatValue::String(s) => parse_dice_or_number(s),
    }
}

/// Permissive variant for [`Value`]-typed parameters
/// (`WeaponKeywordRef.parameters.value` etc.); unrecognised values resolve
/// to 0 to match TS's `evalStatValue(undefined) → 0` fallback for missing
/// keyword params.
fn eval_param_value(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => parse_dice_or_number(s).unwrap_or(0.0),
        _ => 0.0,
    }
}

fn parse_dice_or_number(input: &str) -> Result<f64, CruncherError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(0.0);
    }
    if let Ok(n) = trimmed.parse::<f64>() {
        return Ok(n);
    }
    parse_dice(trimmed).ok_or_else(|| CruncherError::ParseStat(input.to_string()))
}

/// Closed-form mean of a dice expression like `D6`, `2D3+1`, `D6-1`.
/// Returns `count * (die + 1) / 2 + offset`, or `None` if the form is
/// unrecognised. Case-insensitive `D`.
fn parse_dice(input: &str) -> Option<f64> {
    let bytes = input.as_bytes();
    let mut i = 0;

    let count_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let count_str = &input[count_start..i];

    if i >= bytes.len() || (bytes[i] != b'D' && bytes[i] != b'd') {
        return None;
    }
    i += 1;

    let die_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let die_str = &input[die_start..i];
    if die_str.is_empty() {
        return None;
    }

    let offset = if i < bytes.len() {
        let sign: f64 = match bytes[i] {
            b'+' => 1.0,
            b'-' => -1.0,
            _ => return None,
        };
        i += 1;
        let off_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i != bytes.len() || i == off_start {
            return None;
        }
        sign * input[off_start..i].parse::<f64>().ok()?
    } else {
        0.0
    };
    if i != bytes.len() {
        return None;
    }
    let count: f64 = if count_str.is_empty() {
        1.0
    } else {
        count_str.parse().ok()?
    };
    let die: f64 = die_str.parse().ok()?;
    Some(count * (die + 1.0) / 2.0 + offset)
}

/// Standard 10e S-vs-T table → unmodified wound threshold (2..6).
fn wound_threshold(s: f64, t: f64) -> i64 {
    if s >= 2.0 * t {
        2
    } else if s > t {
        3
    } else if s == t {
        4
    } else if s * 2.0 > t {
        5
    } else {
        6
    }
}

#[derive(Clone, Copy)]
enum RerollKind {
    None,
    Ones,
    AllFailures,
}

impl RerollKind {
    fn from_subset(s: super::buffs::RerollSubset) -> Self {
        match s {
            super::buffs::RerollSubset::Ones => RerollKind::Ones,
            super::buffs::RerollSubset::AllFailures => RerollKind::AllFailures,
        }
    }
}

struct CheckArgs {
    unmodified_needed: i64,
    modifier: f64,
    reroll: RerollKind,
    auto_fail_on_one: bool,
    auto_pass_on_six: bool,
    /// Natural roll ≥ this is a crit. Use 7 to disable crits.
    crit_threshold: i64,
}

struct CheckProbs {
    pass: f64,
    crit: f64,
}

/// Probability a single die check passes (and the conditional crit rate).
fn check_probabilities(args: CheckArgs) -> CheckProbs {
    let outcome = |face: i64| -> (f64, f64) {
        if args.auto_fail_on_one && face == 1 {
            return (0.0, 0.0);
        }
        if face >= args.crit_threshold {
            return (1.0, 1.0);
        }
        if args.auto_pass_on_six && face == 6 {
            return (1.0, 0.0);
        }
        let pass = (face as f64 + args.modifier) >= args.unmodified_needed as f64;
        if pass {
            (1.0, 0.0)
        } else {
            (0.0, 0.0)
        }
    };

    let mut pass = 0.0;
    let mut crit = 0.0;
    for face in 1..=6 {
        let (p, c) = outcome(face);
        if p == 1.0 {
            pass += 1.0 / 6.0;
            crit += c / 6.0;
            continue;
        }
        let eligible = matches!(args.reroll, RerollKind::AllFailures)
            || (matches!(args.reroll, RerollKind::Ones) && face == 1);
        if !eligible {
            continue;
        }
        let mut reroll_pass = 0.0;
        let mut reroll_crit = 0.0;
        for f2 in 1..=6 {
            let (p2, c2) = outcome(f2);
            reroll_pass += p2 / 6.0;
            reroll_crit += c2 / 6.0;
        }
        pass += reroll_pass / 6.0;
        crit += reroll_crit / 6.0;
    }
    CheckProbs { pass, crit }
}

fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    n.max(lo).min(hi)
}

fn signed(n: f64) -> String {
    if n > 0.0 {
        format!("+{n}")
    } else if n < 0.0 {
        format!("{n}")
    } else {
        "0".to_string()
    }
}

/// Fraction of damage that survives a single FNP roll (1 if no FNP).
fn fnp_survival_fraction(fnp: Option<&FeelNoPainState>) -> f64 {
    match fnp {
        None => 1.0,
        Some(f) => 1.0 - ((7.0 - f.threshold) / 6.0).clamp(0.0, 1.0),
    }
}

fn describe_fnp(all: Option<&FeelNoPainState>, mortal: Option<&FeelNoPainState>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(f) = all {
        let p_succ = (7.0 - f.threshold) / 6.0;
        parts.push(format!("FNP {}+ (P={:.4})", f.threshold, p_succ));
    }
    if let Some(f) = mortal {
        let p_succ = (7.0 - f.threshold) / 6.0;
        parts.push(format!("FNP {}+ vs mortals (P={:.4})", f.threshold, p_succ));
    }
    if parts.is_empty() {
        "no FNP".to_string()
    } else {
        parts.join(", ")
    }
}

fn attacks_detail(models: f64, per: f64, rapid_fire: f64, blast: f64) -> String {
    let mut parts = vec![format!("{models} × {per}")];
    if rapid_fire != 0.0 {
        parts.push(format!("+ Rapid Fire {rapid_fire} (half range)"));
    }
    if blast != 0.0 {
        parts.push(format!("+ Blast {blast}/model"));
    }
    parts.join(" ")
}

fn value_to_label(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_numbers() {
        assert_eq!(parse_dice_or_number("3").unwrap(), 3.0);
        assert_eq!(parse_dice_or_number(" 0 ").unwrap(), 0.0);
    }

    #[test]
    fn parses_dice_notation() {
        assert!((parse_dice_or_number("D6").unwrap() - 3.5).abs() < 1e-9);
        assert!((parse_dice_or_number("2D6").unwrap() - 7.0).abs() < 1e-9);
        assert!((parse_dice_or_number("D3+1").unwrap() - 3.0).abs() < 1e-9);
        assert!((parse_dice_or_number("D6-1").unwrap() - 2.5).abs() < 1e-9);
    }

    #[test]
    fn unparseable_stat_is_error() {
        assert!(parse_dice_or_number("nope").is_err());
        assert!(parse_dice_or_number("D").is_err());
        assert!(parse_dice_or_number("D6*2").is_err());
    }

    #[test]
    fn wound_thresholds_follow_the_table() {
        assert_eq!(wound_threshold(8.0, 4.0), 2); // 2*T
        assert_eq!(wound_threshold(5.0, 4.0), 3); // S > T
        assert_eq!(wound_threshold(4.0, 4.0), 4); // S == T
        assert_eq!(wound_threshold(3.0, 4.0), 5); // S*2 > T
        assert_eq!(wound_threshold(2.0, 5.0), 6); // bottom of table
    }
}
