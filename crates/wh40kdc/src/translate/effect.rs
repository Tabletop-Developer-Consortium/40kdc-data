//! Plain-English translation of Ability-DSL `effect` trees — the Rust mirror
//! of `tools/src/translate/effect.ts` (the "ability.print()" of the dataset).
//! Output is subject-first GW-datasheet prose, scope range + duration woven in,
//! single-leaf conditionals inlined. **ASCII-only** and byte-for-byte identical
//! to the TS oracle; the `conformance/effect-translation` corpus pins both
//! ports. Any phrasing change here is a semantic corpus change (bump
//! `conformance/SPEC_VERSION`).

use serde_json::{Map, Value};

use super::{dekebab, describe_node, describe_timing};
use crate::generated::{
    Ability, AbilityAppliesTo, CompoundConditionOperator, ConditionNode, DiceGatedEffect,
    DiceGatedEffectComparison, DiceGatedEffectThreshold, DicePoolAllocationEffect, EffectNode,
    Scope, SelectUnitsEffectSelector, SelectUnitsEffectSelectorOwner, SimpleConditionType,
    SingleEffect, SingleEffectType,
};

/// Rendering context threaded from the ability (scope info the leaf needs).
#[derive(Default, Clone, Copy)]
struct Ctx {
    range_inches: Option<f64>,
}

/// JS-template stringification (`String(v)`; numbers print without `.0`, null → `?`).
pub(super) fn jval(v: &Value) -> String {
    match v {
        Value::Null => "?".to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                fmt_num(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(jval).collect::<Vec<_>>().join(", "),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS number formatting for an `f64` (whole numbers print without a decimal).
fn fmt_num(f: f64) -> String {
    if f.fract() == 0.0 && f.is_finite() && f.abs() < 9e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// `jstr(m.key)` — `?` when the key is absent or null.
fn jv(m: &Map<String, Value>, k: &str) -> String {
    m.get(k).map(jval).unwrap_or_else(|| "?".to_string())
}

/// TS `m.key != null` (present and not null).
fn notnull(m: &Map<String, Value>, k: &str) -> bool {
    matches!(m.get(k), Some(v) if !v.is_null())
}

/// TS truthiness for `m.key ? ... : ...` sites.
fn truthy(m: &Map<String, Value>, k: &str) -> bool {
    match m.get(k) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// TS `m.a ?? m.b` over the modifier map (first present-and-not-null value).
fn first<'a>(m: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| m.get(*k)).find(|v| !v.is_null())
}

fn nstr<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

/// Uppercase the first character (idempotent).
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

const TITLE_SMALL: &[&str] = &[
    "of", "or", "and", "the", "a", "an", "to", "in", "on", "for", "with",
];

/// Curated display label for a granted ability id, else Title Case. The slug
/// encodes the mechanic (`charge-after-advance`); the label is the published
/// name players know (`Advance & Charge`). Mirror of `ABILITY_GRANT_LABELS` in
/// `tools/src/translate/effect.ts`; applied only by the ability-grant describer.
fn grant_label(id: &str) -> String {
    match id {
        "charge-after-advance" => "Advance & Charge".to_string(),
        "charge-after-fallback" => "Fall Back & Charge".to_string(),
        "charge-after-disembark" => "Charge After Disembarking".to_string(),
        _ => title_case(id),
    }
}

/// kebab/space → Title Case (`deep-strike` → `Deep Strike`, small words stay lowercase mid-phrase).
fn title_case(s: &str) -> String {
    dekebab(s)
        .split(' ')
        .enumerate()
        .map(|(i, w)| {
            if w.is_empty() {
                w.to_string()
            } else if i > 0 && TITLE_SMALL.contains(&w.to_lowercase().as_str()) {
                w.to_lowercase()
            } else {
                capitalize(w)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// GW weapon keyword token → bracketed caps (`lethal-hits` → `[LETHAL HITS]`).
fn bracket_keyword(v: &Value) -> String {
    format!("[{}]", dekebab(&jval(v)).to_uppercase())
}

/// Dice tokens print with a capital `D` (`d3` → `D3`).
fn dice_case(v: &Value) -> String {
    jval(v).replace('d', "D")
}

fn test_name(v: &Value) -> String {
    match jval(v).as_str() {
        "battle-shock" => "Battle-shock".to_string(),
        "desperate-escape" => "Desperate Escape".to_string(),
        other => title_case(other),
    }
}

fn stat_name(v: &Value) -> String {
    match jval(v).as_str() {
        "M" => "Move",
        "T" => "Toughness",
        "Sv" => "Save",
        "W" => "Wounds",
        "A" => "Attacks",
        "Ld" => "Leadership",
        "OC" => "Objective Control",
        "S" => "Strength",
        "WS" => "Weapon Skill",
        "BS" => "Ballistic Skill",
        "AP" => "Armour Penetration",
        "D" => "Damage",
        "Range" => "Range",
        other => return title_case(other),
    }
    .to_string()
}

fn pool_name(v: &Value) -> String {
    let p = jval(v);
    if p.to_lowercase() == "cp" {
        "CP".to_string()
    } else {
        title_case(&p)
    }
}

fn roll_name(v: &Value) -> String {
    match jval(v).as_str() {
        "hit" => "Hit",
        "wound" => "Wound",
        "charge" => "Charge",
        "damage" => "Damage",
        "advance" => "Advance",
        "save" => "Saving throw",
        "leadership" => "Leadership",
        other => return title_case(other),
    }
    .to_string()
}

/// Does a subject noun phrase take a plural verb?
fn is_plural(s: &str) -> bool {
    s.contains(" units")
        || s.starts_with("all ")
        || s.starts_with("enemy units")
        || s.starts_with("friendly units")
}

/// Subject-verb agreement: plural form of a present-tense verb when the subject is plural.
fn agree(subj: &str, singular: &str) -> String {
    if !is_plural(subj) {
        return singular.to_string();
    }
    match singular {
        "has" => "have".to_string(),
        "is" => "are".to_string(),
        "gets" => "get".to_string(),
        "gains" => "gain".to_string(),
        "suffers" => "suffer".to_string(),
        "retains" => "retain".to_string(),
        "makes" => "make".to_string(),
        other => other.strip_suffix('s').unwrap_or(other).to_string(),
    }
}

fn pronoun(subj: &str) -> &'static str {
    if is_plural(subj) {
        "their"
    } else {
        "its"
    }
}

/// Humanized subject for an effect `target`. Aura targets resolve their radius from scope.
fn subject(target: &str, ctx: &Ctx) -> String {
    let within = match ctx.range_inches {
        Some(r) => format!(" within {}\"", fmt_num(r)),
        None => " nearby".to_string(),
    };
    match target {
        "self" | "bearer" => "this model".to_string(),
        "unit" => "the unit".to_string(),
        "attached-unit" => "the unit this model leads".to_string(),
        "target" => "the target".to_string(),
        "attacker" => "the attacking unit".to_string(),
        "defender" => "your unit".to_string(),
        "all-friendly" => "all friendly units".to_string(),
        "all-enemy" => "all enemy units".to_string(),
        "friendly-within-aura" => format!("friendly units{within}"),
        "enemy-within-aura" => format!("enemy units{within}"),
        _ => "the unit".to_string(),
    }
}

fn possessive(s: &str) -> String {
    if s.ends_with('s') {
        format!("{s}'")
    } else {
        format!("{s}'s")
    }
}

/// `+1` / `-1` from operation + value (a negative value flips the sign).
fn signed(m: &Map<String, Value>) -> String {
    let op = nstr(m, "operation");
    let positive = op == Some("add") || op == Some("improve");
    let mut sign: i32 = if positive { 1 } else { -1 };
    let mut val = m.get("value").cloned().unwrap_or(Value::Null);
    if let Some(n) = val.as_f64() {
        if n < 0.0 {
            sign = -sign;
            val = Value::from(n.abs());
        }
    }
    format!("{}{}", if sign > 0 { "+" } else { "-" }, jval(&val))
}

/// Dice comparison → "a 4+", "a 3 or less", etc.
/// Dice-pool success phrase → "4+", "6", "3 or less" (per-die threshold in a
/// `mortal-wounds` pool — follows "for each", so no leading "a").
fn pool_threshold(comp: &str, threshold: Option<&Value>) -> String {
    let th = threshold.map(jval).unwrap_or_else(|| "?".to_string());
    match comp {
        "lte" => format!("{th} or less"),
        "gt" => format!("more than {th}"),
        "lt" => format!("less than {th}"),
        "eq" => th,
        _ => format!("{th}+"),
    }
}

fn format_comparison(
    comp: DiceGatedEffectComparison,
    threshold: &DiceGatedEffectThreshold,
) -> String {
    let th = match threshold {
        DiceGatedEffectThreshold::Integer(i) => i.to_string(),
        DiceGatedEffectThreshold::String(s) => s.to_string(),
    };
    match comp {
        DiceGatedEffectComparison::Gte => format!("a {th}+"),
        DiceGatedEffectComparison::Lte => format!("a {th} or less"),
        DiceGatedEffectComparison::Gt => format!("greater than {th}"),
        DiceGatedEffectComparison::Lt => format!("less than {th}"),
        DiceGatedEffectComparison::Eq => format!("exactly {th}"),
    }
}

/// Duration → (lead, trail) woven clauses. permanent adds nothing.
fn duration_clauses(duration: &str) -> (String, String) {
    match duration {
        "phase" => (String::new(), "until the end of the phase".to_string()),
        "turn" => (String::new(), "until the end of the turn".to_string()),
        "battle" => (String::new(), "for the rest of the battle".to_string()),
        "battle-round" => (
            String::new(),
            "until the end of the battle round".to_string(),
        ),
        "until-next-command-phase" => (String::new(), "until your next Command phase".to_string()),
        "one-use" => ("once per battle".to_string(), String::new()),
        _ => (String::new(), String::new()),
    }
}

/// A condition rendered as a natural lead-in clause (lowercase-initial).
fn condition_lead_in(n: &ConditionNode) -> String {
    match n {
        ConditionNode::CompoundCondition(c) => {
            let parts: Vec<String> = c.operands.iter().map(condition_lead_in).collect();
            match c.operator {
                CompoundConditionOperator::And => parts.join(", "),
                CompoundConditionOperator::Or => parts.join(" or "),
                CompoundConditionOperator::Not => format!(
                    "unless {}",
                    parts
                        .iter()
                        .map(|p| p.strip_prefix("if ").unwrap_or(p))
                        .collect::<Vec<_>>()
                        .join(" or ")
                ),
            }
        }
        ConditionNode::SimpleCondition(s) => {
            if s.negated {
                return format!("if {}", describe_node(n));
            }
            let p = &s.parameters;
            use SimpleConditionType as T;
            match s.type_ {
                T::PhaseIs => format!("during the {} phase", title_case(&jv(p, "phase"))),
                T::IsAttached => {
                    let kw = match nstr(p, "keyword") {
                        Some(k) => format!("{k} "),
                        None => String::new(),
                    };
                    format!("after being attached to a {kw}unit")
                }
                T::TimingIs => describe_timing(nstr(p, "timing").unwrap_or("?")),
                T::PlayerTurnIs => match nstr(p, "turn") {
                    Some("your-turn") => "in your turn".to_string(),
                    Some("opponent-turn") => "in the opponent's turn".to_string(),
                    _ => "in either player's turn".to_string(),
                },
                T::ModelIsLeader => "while this model leads a unit".to_string(),
                T::ChargedThisTurn => "if the unit charged this turn".to_string(),
                T::AdvancedThisTurn => "if the unit Advanced this turn".to_string(),
                T::DisembarkedFromTransport => {
                    "if the unit disembarked from a Transport this turn".to_string()
                }
                T::FactionRuleActive => {
                    format!("while the {} is active", title_case(&jv(p, "rule")))
                }
                T::BattleRound => {
                    format!("during the first {} battle rounds", jv(p, "max"))
                }
                T::RemainedStationary => "if the unit Remained Stationary".to_string(),
                T::TargetHasKeyword => format!("against {} targets", jv(p, "keyword")),
                T::UnitHasKeyword => format!("if the unit has the {} keyword", jv(p, "keyword")),
                T::IsBattleShocked => "while the unit is Battle-shocked".to_string(),
                T::UnitBelowHalfStrength => "while the unit is below half strength".to_string(),
                T::UnitBelowStartingStrength => {
                    "while the unit is below its starting strength".to_string()
                }
                T::HasLostWounds => "while the model has lost wounds".to_string(),
                T::AttackIsType => match nstr(p, "comparison") {
                    Some("strength-greater-than-toughness") => {
                        "when this attack's Strength is greater than the target's Toughness"
                            .to_string()
                    }
                    Some(c) => format!("when {}", dekebab(c)),
                    None => format!("with {} attacks", jv(p, "attack_type")),
                },
                T::DestroyedByAttackType => {
                    format!("when destroyed by a {} attack", jv(p, "attack_type"))
                }
                T::OpponentUnitWithinRange => {
                    let where_ = if notnull(p, "weapon_name") {
                        format!("range of {}", dekebab(&jv(p, "weapon_name")))
                    } else if notnull(p, "range_multiplier") {
                        "half range of its ranged weapons".to_string()
                    } else if nstr(p, "range") == Some("engagement") {
                        "engagement range".to_string()
                    } else {
                        format!("{}\"", jv(p, "range"))
                    };
                    format!("while an enemy unit is within {where_}")
                }
                _ => format!("if {}", describe_node(n)),
            }
        }
    }
}

/// Per-slug GW-prose for `attack-restriction` (reads `restriction` or `restriction_type`).
fn describe_attack_restriction(m: &Map<String, Value>, subj: &str) -> String {
    if !notnull(m, "restriction") && !notnull(m, "restriction_type") && notnull(m, "attack_type") {
        return format!("{subj} cannot {}", jv(m, "attack_type"));
    }
    let slug = first(m, &["restriction", "restriction_type"])
        .map(jval)
        .unwrap_or_else(|| "?".to_string());
    let range = if notnull(m, "range") {
        Some(jv(m, "range"))
    } else {
        None
    };
    match slug.as_str() {
        "worsen-incoming-ap" => {
            let amount = if notnull(m, "value") {
                jv(m, "value")
            } else {
                "1".to_string()
            };
            format!("each time an attack targets {subj}, worsen the Armour Penetration of that attack by {amount}")
        }
        "cannot-be-targeted-unless-closest-or-within-12" => {
            format!(
                "{subj} can only be targeted if it is the closest eligible target or within 12\""
            )
        }
        "targeting-range-limit" => format!(
            "{subj} can only target enemy units within {}\"",
            range.as_deref().unwrap_or("?")
        ),
        "reinforcement-denial" => format!(
            "enemy units cannot be set up from Reserves within {}\" of {subj}",
            range.as_deref().unwrap_or("?")
        ),
        "must-be-warlord" => "this model must be your Warlord".to_string(),
        "cannot-be-warlord" => "this model cannot be your Warlord".to_string(),
        "unique-unit-limit" => "you can include only one of this unit in your army".to_string(),
        "no-charge" => format!("{subj} cannot charge"),
        _ => {
            let rng = range
                .map(|r| format!(" (within {r}\")"))
                .unwrap_or_default();
            format!("{subj}: {}{rng}", dekebab(&slug))
        }
    }
}

fn describe_single(e: &SingleEffect, ctx: &Ctx) -> String {
    let m = &e.modifier;
    let subj = subject(&e.target.to_string(), ctx);
    use SingleEffectType as T;

    match e.type_ {
        T::StatModifier => {
            let scope = if truthy(m, "attack_type") {
                format!(" ({})", jv(m, "attack_type"))
            } else {
                String::new()
            };
            if !notnull(m, "stat") {
                return format!("modify {} characteristics{scope}", possessive(&subj));
            }
            if nstr(m, "operation") == Some("set") {
                return format!(
                    "modify {} {} characteristic to {}{scope}",
                    possessive(&subj),
                    stat_name(m.get("stat").unwrap_or(&Value::Null)),
                    jv(m, "value")
                );
            }
            let mut verb = if matches!(nstr(m, "operation"), Some("subtract") | Some("worsen")) {
                "subtract"
            } else {
                "add"
            };
            let mut val = m.get("value").cloned().unwrap_or(Value::Null);
            if let Some(n) = val.as_f64() {
                if n < 0.0 {
                    verb = if verb == "add" { "subtract" } else { "add" };
                    val = Value::from(n.abs());
                }
            }
            let prep = if verb == "add" { "to" } else { "from" };
            format!(
                "{verb} {} {prep} {} {} characteristic{scope}",
                jval(&val),
                possessive(&subj),
                stat_name(m.get("stat").unwrap_or(&Value::Null))
            )
        }
        T::RollModifier => {
            let ctx_note = if truthy(m, "context") {
                format!(" ({})", jv(m, "context"))
            } else {
                String::new()
            };
            if notnull(m, "critical_on") {
                let crit = if nstr(m, "roll") == Some("wound") {
                    "Critical Wounds"
                } else {
                    "Critical Hits"
                };
                return format!(
                    "{subj} {} {crit} on {} rolls of {}+",
                    agree(&subj, "scores"),
                    roll_name(m.get("roll").unwrap_or(&Value::Null)),
                    jv(m, "critical_on")
                );
            }
            if nstr(m, "operation") == Some("set") {
                return format!(
                    "{subj} can change {} rolls to a {}",
                    roll_name(m.get("roll").unwrap_or(&Value::Null)),
                    jv(m, "value")
                );
            }
            if !notnull(m, "value") {
                format!(
                    "{} {} {} rolls{ctx_note}",
                    dekebab(&jv(m, "operation")),
                    possessive(&subj),
                    roll_name(m.get("roll").unwrap_or(&Value::Null))
                )
            } else {
                format!(
                    "{subj} {} {} to {} rolls{ctx_note}",
                    agree(&subj, "gets"),
                    signed(m),
                    roll_name(m.get("roll").unwrap_or(&Value::Null))
                )
            }
        }
        T::ReRoll => {
            let noun = roll_name(m.get("roll").unwrap_or(&Value::Null));
            let which = if nstr(m, "subset") == Some("ones") {
                format!("a {noun} roll of 1")
            } else {
                format!("the {noun} roll")
            };
            format!("you can re-roll {which}")
        }
        T::MortalWounds => {
            let range = first(m, &["range", "range_inches"])
                .map(jval)
                .or_else(|| ctx.range_inches.map(fmt_num));
            let subj_mw = if e.target.to_string() == "enemy-within-aura" && range.is_some() {
                format!("each enemy unit within {}\"", range.unwrap())
            } else {
                subj.clone()
            };
            let verb = if subj_mw.starts_with("each ") {
                "suffers".to_string()
            } else {
                agree(&subj_mw, "suffers")
            };
            // Dice-pool form: N dice rolled, each success worth
            // `mortal_per_success` mortal wounds (distinct from a flat count).
            if notnull(m, "mortal_per_success") {
                let per = jv(m, "mortal_per_success");
                let per_noun = if per == "1" {
                    "mortal wound"
                } else {
                    "mortal wounds"
                };
                let comp = nstr(m, "comparison").unwrap_or("gte");
                let hit = pool_threshold(comp, m.get("threshold"));
                let die = dice_case(m.get("dice").unwrap_or(&Value::Null));
                // Per-model pool: one die per model in this/the target unit.
                if notnull(m, "per_model") {
                    let where_ = if nstr(m, "per_model") == Some("target") {
                        "the target unit"
                    } else {
                        "this unit"
                    };
                    return format!(
                        "roll one {die} for each model in {where_}: for each {hit}, {subj_mw} {verb} {per} {per_noun}"
                    );
                }
                return format!("roll {die}: for each {hit}, {subj_mw} {verb} {per} {per_noun}");
            }
            let a: Option<String> = if notnull(m, "count") {
                Some(jv(m, "count"))
            } else if notnull(m, "amount") {
                Some(jv(m, "amount"))
            } else if notnull(m, "dice") {
                Some(dice_case(m.get("dice").unwrap_or(&Value::Null)))
            } else if truthy(m, "table") || truthy(m, "amount_table") {
                Some("a number of".to_string())
            } else {
                None
            };
            if a.is_none() && notnull(m, "trigger") {
                return format!(
                    "when this model is destroyed, {subj_mw} {verb} mortal wounds ({})",
                    title_case(&jv(m, "trigger"))
                );
            }
            let amt = a.unwrap_or_else(|| "?".to_string());
            let noun = if amt == "1" {
                "mortal wound"
            } else {
                "mortal wounds"
            };
            format!("{subj_mw} {verb} {amt} {noun}")
        }
        T::FeelNoPain => {
            let vs = if nstr(m, "scope") == Some("mortal") {
                " against mortal wounds"
            } else {
                ""
            };
            format!(
                "{subj} {} the Feel No Pain {}+ ability{vs}",
                agree(&subj, "has"),
                jv(m, "threshold")
            )
        }
        T::Ward => {
            let th = first(m, &["threshold", "value"])
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            format!("{subj} {} the Ward {th}+ ability", agree(&subj, "has"))
        }
        T::InvulnerableSave => {
            let sv = first(m, &["invuln_sv", "value", "threshold"])
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            format!("{subj} {} a {sv}+ invulnerable save", agree(&subj, "has"))
        }
        T::KeywordGrant => {
            let kw = match m.get("keywords") {
                Some(Value::Array(a)) => a
                    .iter()
                    .map(bracket_keyword)
                    .collect::<Vec<_>>()
                    .join(" and "),
                _ => first(m, &["keyword"])
                    .map(bracket_keyword)
                    .unwrap_or_else(|| "[KEYWORDS]".to_string()),
            };
            if notnull(m, "weapon_name") {
                format!("{} {} gains {kw}", possessive(&subj), jv(m, "weapon_name"))
            } else if notnull(m, "weapon_type") {
                format!(
                    "{} {} weapons gain {kw}",
                    possessive(&subj),
                    jv(m, "weapon_type")
                )
            } else {
                format!("{} weapons gain {kw}", possessive(&subj))
            }
        }
        T::AbilityGrant => {
            let cap = if notnull(m, "capacity") {
                format!(" ({})", jv(m, "capacity"))
            } else {
                String::new()
            };
            match first(m, &["grant_type", "ability_id"]) {
                Some(g) => format!(
                    "{subj} {} the {} ability{cap}",
                    agree(&subj, "gains"),
                    grant_label(&jval(g))
                ),
                None => format!("{subj} {} an ability{cap}", agree(&subj, "gains")),
            }
        }
        T::MovementModifier => {
            let kind = first(m, &["move_type", "type"]);
            if kind.map(jval).as_deref() == Some("move-through") {
                return format!("{subj} can move through enemy models and terrain");
            }
            let inches = first(m, &["distance", "value"])
                .filter(|d| jval(d) != "0")
                .map(|d| format!(" {}\"", jval(d)))
                .unwrap_or_default();
            match kind {
                Some(k) => format!(
                    "{subj} {} the {}{inches} ability",
                    agree(&subj, "has"),
                    title_case(&jval(k))
                ),
                None => format!("{subj} {} a movement ability", agree(&subj, "gains")),
            }
        }
        T::DamageReduction => {
            let r = first(m, &["reduction", "amount", "value"])
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            let how = if r == "half" {
                "halve the Damage of that attack".to_string()
            } else if r == "to-zero" {
                "reduce the Damage of that attack to 0".to_string()
            } else {
                format!("reduce the Damage of that attack by {r}")
            };
            format!("each time an attack targets {subj}, {how}")
        }
        T::Resurrection => {
            let count = first(m, &["count"])
                .map(dice_case)
                .unwrap_or_else(|| "1".to_string());
            let noun = if count == "1" {
                "destroyed model"
            } else {
                "destroyed models"
            };
            let wounds = first(m, &["wounds_remaining"])
                .map(jval)
                .unwrap_or_else(|| "full".to_string());
            format!("return {count} {noun} to {subj} with {wounds} wounds")
        }
        T::ModelDestruction => {
            let count = first(m, &["count"])
                .map(dice_case)
                .unwrap_or_else(|| "1".to_string());
            let noun = if count == "1" { "model" } else { "models" };
            format!("destroy {count} {noun} in {subj}")
        }
        T::CpGain => {
            let amount = first(m, &["amount"])
                .map(jval)
                .unwrap_or_else(|| "1".to_string());
            format!("you gain {amount}CP")
        }
        T::CpRefund => {
            let strat = if notnull(m, "stratagem") {
                format!("the {} Stratagem", title_case(&jv(m, "stratagem")))
            } else {
                "one Stratagem".to_string()
            };
            format!("you can use {strat} on {subj} for 0CP")
        }
        T::ResourceGain => {
            let amount = first(m, &["amount", "value"])
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            let pool = first(m, &["pool_id", "resource"])
                .map(pool_name)
                .unwrap_or_else(|| "?".to_string());
            format!("you gain {amount} {pool}")
        }
        T::ResourceSpend => {
            let amount = first(m, &["amount", "value"])
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            let pool = first(m, &["pool_id", "resource"])
                .map(pool_name)
                .unwrap_or_else(|| "?".to_string());
            format!("spend {amount} {pool}")
        }
        T::LeadershipModifier => {
            let has_test = notnull(m, "test");
            let op = nstr(m, "operation");
            if has_test && !notnull(m, "operation") {
                format!(
                    "{subj} must take a {} test",
                    test_name(m.get("test").unwrap())
                )
            } else if has_test && op == Some("re-roll") {
                format!(
                    "{subj} can re-roll {} tests",
                    test_name(m.get("test").unwrap())
                )
            } else if has_test && notnull(m, "value") {
                let (verb, prep) = if op == Some("add") {
                    ("add", "to")
                } else {
                    ("subtract", "from")
                };
                format!(
                    "{verb} {} {prep} the {} test of {subj}",
                    jv(m, "value"),
                    test_name(m.get("test").unwrap())
                )
            } else if notnull(m, "operation") && notnull(m, "value") {
                let positive = op == Some("add") || op == Some("improve");
                let (verb, prep) = if positive {
                    ("add", "to")
                } else {
                    ("subtract", "from")
                };
                format!(
                    "{verb} {} {prep} the Leadership characteristic of {subj}",
                    jv(m, "value")
                )
            } else {
                format!("modify {} Leadership characteristic", possessive(&subj))
            }
        }
        T::FightFirst => format!("{subj} {} the Fights First ability", agree(&subj, "has")),
        T::FightLast => format!("{subj} {} the Fights Last ability", agree(&subj, "has")),
        T::FightOnDeath => {
            if subj == "this model" {
                "each time this model is destroyed, it can fight before being removed from play"
                    .to_string()
            } else {
                format!("each time a model in {subj} is destroyed, it can fight before being removed from play")
            }
        }
        T::ShootOnDeath => {
            if subj == "this model" {
                "each time this model is destroyed, it can shoot before being removed from play"
                    .to_string()
            } else {
                format!("each time a model in {subj} is destroyed, it can shoot before being removed from play")
            }
        }
        T::UnitKeyword => {
            let name = title_case(&jv(m, "keyword_id"));
            let val = if notnull(m, "value") {
                format!(" {}", jv(m, "value"))
            } else {
                String::new()
            };
            format!("{subj} {} the {name}{val} ability", agree(&subj, "has"))
        }
        T::UnitKeywordGrant => format!(
            "{} units gain the {} keyword",
            jv(m, "to_keywords"),
            jv(m, "keyword")
        ),
        T::DeepStrike => format!("{subj} {} the Deep Strike ability", agree(&subj, "has")),
        T::StrategicReservesArrival => {
            format!("{subj} can arrive from Strategic Reserves regardless of mission rules")
        }
        T::RemoveBattleShock => format!("{subj} {} no longer Battle-shocked", agree(&subj, "is")),
        T::FallbackAndAct => format!(
            "{subj} {} eligible to shoot and declare a charge in a turn in which it Fell Back",
            agree(&subj, "is")
        ),
        T::EngagementPassthrough => format!("{subj} can move through enemy models"),
        T::AttackRestriction => describe_attack_restriction(m, &subj),
        T::ObjectiveControlModifier => {
            if truthy(m, "sticky") {
                format!("{subj} {} control of objective markers even after no models remain in range, until the enemy retakes them (sticky objectives)", agree(&subj, "retains"))
            } else if nstr(m, "operation") == Some("halve") {
                format!("halve the Objective Control characteristic of {subj}")
            } else if notnull(m, "operation") {
                format!(
                    "{subj} {} {} to {} Objective Control characteristic",
                    agree(&subj, "gets"),
                    signed(m),
                    pronoun(&subj)
                )
            } else {
                format!(
                    "modify {} Objective Control characteristic",
                    possessive(&subj)
                )
            }
        }
        T::BsModifier => format!(
            "{subj} {} {} to Ballistic Skill",
            agree(&subj, "gets"),
            signed(m)
        ),
        T::ChargeRollModifier => {
            format!(
                "{subj} {} {} to Charge rolls",
                agree(&subj, "gets"),
                signed(m)
            )
        }
        T::TerrainAreaTag => {
            format!("the terrain area is marked as {}", dekebab(&jv(m, "tag")))
        }
        T::ObjectiveTag => format!("the objective is marked as {}", dekebab(&jv(m, "tag"))),
        T::UnitTag => format!(
            "{subj} {} marked as {}",
            agree(&subj, "is"),
            dekebab(&jv(m, "tag"))
        ),
    }
}

/// Single-clause translation for leaf effects (lowercase-initial, no period).
pub fn describe_effect_inline(e: &EffectNode) -> String {
    inline(e, &Ctx::default())
}

fn inline(e: &EffectNode, ctx: &Ctx) -> String {
    match e {
        EffectNode::SingleEffect(s) => describe_single(s, ctx),
        EffectNode::ConditionalEffect(c) => {
            format!(
                "{}, {}",
                condition_lead_in(&c.condition.0),
                inline(&c.effect, ctx)
            )
        }
        EffectNode::SequenceEffect(s) => s
            .steps
            .iter()
            .map(|st| inline(st, ctx))
            .collect::<Vec<_>>()
            .join("; "),
        EffectNode::ChoiceEffect(c) => {
            let label = c
                .choice_label
                .as_deref()
                .map(|l| format!(" ({})", title_case(l)))
                .unwrap_or_default();
            format!(
                "select one of the following{label}: {}",
                c.options
                    .iter()
                    .map(|o| inline(o, ctx))
                    .collect::<Vec<_>>()
                    .join(" / ")
            )
        }
        EffectNode::DiceGatedEffect(d) => dice_gated_inline(d, ctx),
        EffectNode::DicePoolAllocationEffect(d) => format!(
            "roll {}{}: {}",
            d.pool.count,
            d.pool.die,
            dice_pool_options_inline(d, ctx)
        ),
        EffectNode::SelectUnitsEffect(s) => format!(
            "select {}: {}",
            select_units_subject(&s.selector),
            inline(&s.effect, ctx)
        ),
    }
}

/// "up to 3 friendly Orks Vehicle units" — the `select-units` selector phrase.
fn select_units_subject(sel: &SelectUnitsEffectSelector) -> String {
    let kw = sel
        .keywords
        .iter()
        .map(|k| title_case(k))
        .collect::<Vec<_>>()
        .join(" ");
    let owner = match sel.owner {
        SelectUnitsEffectSelectorOwner::Friendly => "friendly",
        SelectUnitsEffectSelectorOwner::Enemy => "enemy",
    };
    let noun = if sel.max_count.get() == 1 {
        "unit"
    } else {
        "units"
    };
    let kw = if kw.is_empty() {
        String::new()
    } else {
        format!(" {kw}")
    };
    format!("up to {} {owner}{kw} {noun}", sel.max_count)
}

fn dice_gated_inline(d: &DiceGatedEffect, ctx: &Ctx) -> String {
    let comp = format_comparison(d.comparison, &d.threshold);
    let success = d
        .on_success
        .as_deref()
        .map(|s| inline(s, ctx))
        .unwrap_or_else(|| "nothing happens".to_string());
    let fail = d
        .on_fail
        .as_deref()
        .map(|f| format!("; otherwise, {}", inline(f, ctx)))
        .unwrap_or_default();
    format!(
        "roll one {}: on {comp}, {success}{fail}",
        dice_case(&Value::String(d.dice.clone()))
    )
}

fn dice_pool_options_inline(d: &DicePoolAllocationEffect, ctx: &Ctx) -> String {
    d.options
        .iter()
        .map(|o| {
            format!(
                "{} ({}+): {}",
                o.name,
                o.requirement.min_value,
                inline(&o.effect, ctx)
            )
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

fn is_container(e: &EffectNode) -> bool {
    matches!(
        e,
        EffectNode::SequenceEffect(_)
            | EffectNode::ChoiceEffect(_)
            | EffectNode::DiceGatedEffect(_)
            | EffectNode::DicePoolAllocationEffect(_)
            | EffectNode::SelectUnitsEffect(_)
    )
}

/// Block translation of a container effect tree (multi-line, two-space indentation).
pub fn describe_effect(e: &EffectNode) -> String {
    block(e, 0, &Ctx::default())
}

fn block(e: &EffectNode, depth: usize, ctx: &Ctx) -> String {
    let indent = "  ".repeat(depth);
    let arrow = if depth > 0 { "-> " } else { "" };

    match e {
        EffectNode::ConditionalEffect(c) => {
            let inner = &*c.effect;
            if is_container(inner) {
                format!(
                    "{indent}{}:\n{}",
                    capitalize(&condition_lead_in(&c.condition.0)),
                    block(inner, depth + 1, ctx)
                )
            } else {
                format!(
                    "{indent}{arrow}{}, {}.",
                    capitalize(&condition_lead_in(&c.condition.0)),
                    inline(inner, ctx)
                )
            }
        }
        EffectNode::SequenceEffect(s) => s
            .steps
            .iter()
            .map(|step| block(step, depth, ctx))
            .collect::<Vec<_>>()
            .join("\n"),
        EffectNode::ChoiceEffect(c) => {
            let label = c
                .choice_label
                .as_deref()
                .map(|l| format!(" ({})", title_case(l)))
                .unwrap_or_default();
            let options = c
                .options
                .iter()
                .map(|o| format!("{indent}  - {}.", capitalize(&inline(o, ctx))))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{indent}Select one of the following{label}:\n{options}")
        }
        EffectNode::DiceGatedEffect(d) => {
            let comp = format_comparison(d.comparison, &d.threshold);
            let success = d
                .on_success
                .as_deref()
                .map(|s| inline(s, ctx))
                .unwrap_or_else(|| "nothing happens".to_string());
            let fail = d
                .on_fail
                .as_deref()
                .map(|f| format!("; otherwise, {}", inline(f, ctx)))
                .unwrap_or_default();
            format!(
                "{indent}{arrow}Roll one {}: on {comp}, {success}{fail}.",
                dice_case(&Value::String(d.dice.clone()))
            )
        }
        EffectNode::DicePoolAllocationEffect(d) => {
            let mut lines = vec![format!(
                "{indent}{arrow}Roll {}{} (max {} activations):",
                d.pool.count, d.pool.die, d.max_activations
            )];
            for opt in &d.options {
                lines.push(format!(
                    "{indent}  - {}: need {} of {}+ -> {}",
                    opt.name,
                    opt.requirement.type_,
                    opt.requirement.min_value,
                    inline(&opt.effect, ctx)
                ));
            }
            lines.join("\n")
        }
        EffectNode::SelectUnitsEffect(s) => {
            let inner = &*s.effect;
            let lead = format!("Select {}", select_units_subject(&s.selector));
            if is_container(inner) {
                format!("{indent}{arrow}{lead}:\n{}", block(inner, depth + 1, ctx))
            } else {
                format!("{indent}{arrow}{lead}: {}.", inline(inner, ctx))
            }
        }
        EffectNode::SingleEffect(_) => {
            format!("{indent}{arrow}{}.", capitalize(&inline(e, ctx)))
        }
    }
}

/// Join non-empty clauses with ", ", capitalize, and end with a period.
fn assemble_sentence(parts: &[String]) -> String {
    let body = parts
        .iter()
        .filter(|p| !p.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if body.is_empty() {
        return String::new();
    }
    let period = if body.ends_with('.') || body.ends_with(':') {
        ""
    } else {
        "."
    };
    format!("{}{period}", capitalize(&body))
}

/// Assemble the top-level sentence/block, weaving scope range + duration.
fn render_top_level(e: &EffectNode, scope: Option<&Scope>) -> String {
    let ctx = Ctx {
        range_inches: scope.and_then(|s| s.range_inches),
    };
    let duration = scope.map(|s| s.duration.to_string()).unwrap_or_default();
    let (lead, trail) = duration_clauses(&duration);

    match e {
        EffectNode::ConditionalEffect(c) => {
            let inner = &*c.effect;
            let lead_in = condition_lead_in(&c.condition.0);
            if is_container(inner) {
                let header = [lead, lead_in, trail]
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{}:\n{}", capitalize(&header), block(inner, 1, &ctx))
            } else {
                assemble_sentence(&[lead, lead_in, trail, inline(inner, &ctx)])
            }
        }
        _ if is_container(e) => {
            let blk = block(e, 0, &ctx);
            let dur = if !lead.is_empty() { lead } else { trail };
            if dur.is_empty() {
                blk
            } else {
                format!("{}:\n{}", capitalize(&dur), blk)
            }
        }
        _ => assemble_sentence(&[lead, trail, inline(e, &ctx)]),
    }
}

/// `Scope: aura (6"). Duration: phase.` Retained for legacy callers.
pub fn describe_scope(s: &Scope) -> String {
    let range = dekebab(&s.range.to_string());
    let inches = s
        .range_inches
        .map(|r| format!(" ({}\")", fmt_num(r)))
        .unwrap_or_default();
    let duration = dekebab(&s.duration.to_string());
    format!("Scope: {range}{inches}. Duration: {duration}.")
}

/// Effect text plus an optional trailing scope line — legacy composition.
pub fn describe_effect_with_scope(e: &EffectNode, scope: Option<&Scope>) -> String {
    let effect = describe_effect(e);
    match scope {
        Some(s) => {
            let scope_line = describe_scope(s);
            if effect.is_empty() {
                scope_line
            } else {
                format!("{effect}\n{scope_line}")
            }
        }
        None => effect,
    }
}

/// `Applies to: units with Possessed.` Mirrors `describeAppliesTo`.
pub fn describe_applies_to(filter: Option<&AbilityAppliesTo>) -> String {
    let Some(filter) = filter else {
        return String::new();
    };
    let required: Vec<&str> = filter
        .required_keywords
        .iter()
        .flat_map(|kl| kl.0.iter())
        .map(|k| k.as_str())
        .collect();
    let excluded: Vec<&str> = filter
        .excluded_keywords
        .iter()
        .flat_map(|kl| kl.0.iter())
        .map(|k| k.as_str())
        .collect();
    if required.is_empty() && excluded.is_empty() {
        return String::new();
    }
    let base = if required.is_empty() {
        "all units".to_string()
    } else {
        format!("units with {}", required.join(", "))
    };
    let exc = if excluded.is_empty() {
        String::new()
    } else {
        format!(" (excluding {})", excluded.join(", "))
    };
    format!("Applies to: {base}{exc}.")
}

/// Compose the full ability print: woven effect sentence + an optional
/// `Applies to:` line. The single assembler used by both [`describe_ability`]
/// and the runner's `translate_effect` op.
pub fn describe_ability_parts(
    e: &EffectNode,
    scope: Option<&Scope>,
    applies_to: Option<&AbilityAppliesTo>,
) -> String {
    let base = render_top_level(e, scope);
    let applies = describe_applies_to(applies_to);
    if applies.is_empty() {
        base
    } else if base.is_empty() {
        applies
    } else {
        format!("{base}\n{applies}")
    }
}

/// Full generated text for an ability. Mirrors `describeAbility`.
pub fn describe_ability(a: &Ability) -> String {
    describe_ability_parts(&a.effect, Some(&a.scope), a.applies_to.as_ref())
}
