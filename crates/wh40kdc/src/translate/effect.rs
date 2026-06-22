//! Plain-English translation of Ability-DSL `effect` trees — the Rust mirror
//! of `tools/src/translate/effect.ts` (the "ability.print()" of the dataset).
//! Output is subject-first GW-datasheet prose, scope range + duration woven in,
//! single-leaf conditionals inlined. **ASCII-only** and byte-for-byte identical
//! to the TS oracle; the `conformance/effect-translation` corpus pins both
//! ports. Any phrasing change here is a semantic corpus change (bump
//! `conformance/SPEC_VERSION`).

use serde_json::{Map, Value};

use super::{dekebab, describe_node, describe_timing, event_clause};
use crate::generated::{
    Ability, AbilityAppliesTo, AbilityTrigger, AbilityTriggerProximityOf, AbilityUsage,
    AbilityUsageFrequency, AuraEffect, AuraEffectModifierRange, AuraEffectTarget,
    CompoundConditionOperator, ConditionNode, DiceGatedEffect, DiceGatedEffectComparison,
    DiceGatedEffectThreshold, DicePoolAllocationEffect, EffectNode, MovementModifierEffect,
    Scaling, ScalingOf, ScalingRound, Scope, ScopeRange, SelectUnitsEffectSelector,
    SelectUnitsEffectSelectorOwner, SimpleConditionType, SingleEffect, SingleEffectType,
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

/// `^anti[\s-]+(.*)$` (case-insensitive): returns the captured remainder when
/// `raw` starts with an `anti` prefix followed by ≥1 whitespace/hyphen.
fn strip_anti_prefix(raw: &str) -> Option<&str> {
    let prefix = raw.get(..4)?;
    if !prefix.eq_ignore_ascii_case("anti") {
        return None;
    }
    let after = &raw[4..];
    let rest = after.trim_start_matches(|c: char| c.is_whitespace() || c == '-');
    // The `[\s-]+` requires at least one separator char to have been consumed.
    if rest.len() == after.len() {
        return None;
    }
    Some(rest)
}

/// `^(.*?)[\s-]*(\d+)\s*(?:\+|plus)?$` (case-insensitive): the lazy split of a
/// keyword body into (name, trailing-number). Returns the earliest-matching cut.
fn split_trailing_number(s: &str) -> Option<(&str, &str)> {
    fn match_number_suffix(suffix: &str) -> Option<&str> {
        let body = suffix.trim_start_matches(|c: char| c.is_whitespace() || c == '-');
        let digits_end = body
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(body.len());
        if digits_end == 0 {
            return None;
        }
        let digits = &body[..digits_end];
        let tail = body[digits_end..].trim_start_matches(char::is_whitespace);
        if tail.is_empty() || tail == "+" || tail.eq_ignore_ascii_case("plus") {
            Some(digits)
        } else {
            None
        }
    }
    let cuts = s
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()));
    for p in cuts {
        if let Some(digits) = match_number_suffix(&s[p..]) {
            return Some((&s[..p], digits));
        }
    }
    None
}

/// GW weapon keyword token → bracketed caps (`lethal-hits` → `[LETHAL HITS]`).
/// `Anti-` keywords keep their hyphen and surface their `+`-threshold
/// (`anti-titanic-3plus` → `[ANTI-TITANIC 3+]`).
fn bracket_keyword(v: &Value) -> String {
    let raw = jval(v);
    let raw = raw.trim();
    if let Some(anti) = strip_anti_prefix(raw) {
        if let Some((name, num)) = split_trailing_number(anti) {
            return format!("[ANTI-{} {num}+]", dekebab(name).trim().to_uppercase());
        }
        return format!("[ANTI-{}]", dekebab(anti).trim().to_uppercase());
    }
    format!("[{}]", dekebab(raw).to_uppercase())
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
        "passes" => "pass".to_string(),
        "fails" => "fail".to_string(),
        "treats" => "treat".to_string(),
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
/// "against a unit that is not a Monster or Vehicle" from a run of excluded target keywords.
fn negated_target_keywords(keywords: &[String]) -> String {
    format!("against a unit that is not a {}", keywords.join(" or "))
}

/// Join the operands of an `and` lead-in. A run of consecutive negated
/// `target-has-keyword` exclusions collapses into one "against a unit that is not
/// a X or Y" clause, which attaches to the preceding clause with a space; all
/// other operands join with ", ".
fn join_and_lead_ins(operands: &[ConditionNode]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < operands.len() {
        if let ConditionNode::SimpleCondition(s) = &operands[i] {
            if s.negated && s.type_ == SimpleConditionType::TargetHasKeyword {
                let mut kws: Vec<String> = Vec::new();
                while i < operands.len() {
                    match &operands[i] {
                        ConditionNode::SimpleCondition(s2)
                            if s2.negated && s2.type_ == SimpleConditionType::TargetHasKeyword =>
                        {
                            kws.push(jv(&s2.parameters, "keyword"));
                            i += 1;
                        }
                        _ => break,
                    }
                }
                parts.push(negated_target_keywords(&kws));
                continue;
            }
        }
        parts.push(condition_lead_in(&operands[i]));
        i += 1;
    }
    let mut acc = String::new();
    for part in parts {
        if acc.is_empty() {
            acc = part;
        } else if part.starts_with("against ") {
            acc = format!("{acc} {part}");
        } else {
            acc = format!("{acc}, {part}");
        }
    }
    acc
}

fn condition_lead_in(n: &ConditionNode) -> String {
    match n {
        ConditionNode::CompoundCondition(c) => match c.operator {
            CompoundConditionOperator::And => join_and_lead_ins(&c.operands),
            CompoundConditionOperator::Or => c
                .operands
                .iter()
                .map(condition_lead_in)
                .collect::<Vec<_>>()
                .join(" or "),
            CompoundConditionOperator::Not => {
                let parts: Vec<String> = c.operands.iter().map(condition_lead_in).collect();
                format!(
                    "unless {}",
                    parts
                        .iter()
                        .map(|p| p.strip_prefix("if ").unwrap_or(p))
                        .collect::<Vec<_>>()
                        .join(" or ")
                )
            }
        },
        ConditionNode::SimpleCondition(s) => {
            if s.negated {
                // Negated keyword gates read as an exclusion clause, not "if not …".
                return match s.type_ {
                    SimpleConditionType::TargetHasKeyword => {
                        negated_target_keywords(&[jv(&s.parameters, "keyword")])
                    }
                    SimpleConditionType::UnitHasKeyword => {
                        format!(
                            "unless the unit has the {} keyword",
                            jv(&s.parameters, "keyword")
                        )
                    }
                    _ => format!("if {}", describe_node(n)),
                };
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
                T::UnitBelowHalfStrength => {
                    if nstr(p, "subject") == Some("target") {
                        "while the target unit is below half strength".to_string()
                    } else {
                        "while the unit is below half strength".to_string()
                    }
                }
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
                    None => format!("while making {} attacks", jv(p, "attack_type")),
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
                T::EngagementState => match nstr(p, "state") {
                    None => "while the unit is within Engagement Range".to_string(),
                    Some("on-battlefield") => "while the unit is on the battlefield".to_string(),
                    Some("embarked") => "while the unit is embarked".to_string(),
                    Some("engaged")
                    | Some("within-engagement-range")
                    | Some("in-engagement-range") => {
                        "while the unit is within Engagement Range".to_string()
                    }
                    Some("not-in-engagement-range") | Some("not-within-engagement-range") => {
                        "while the unit is not within Engagement Range".to_string()
                    }
                    Some(st) => format!("while the unit is {}", dekebab(st)),
                },
                T::DispositionMatches => match nstr(p, "disposition") {
                    Some("strategic-reserves") => {
                        "while the unit is in Strategic Reserves".to_string()
                    }
                    _ => format!(
                        "while the unit's disposition is {}",
                        dekebab(&jv(p, "disposition"))
                    ),
                },
                T::FightsFirst => "while the unit has the Fights First ability".to_string(),
                _ => format!("if {}", describe_node(n)),
            }
        }
    }
}

/// Per-slug GW-prose for `attack-restriction` (reads `restriction` or `restriction_type`).
/// `rule-state`: a named rule switched on/off for the subject. The faction-rule
/// + suppressed path reproduces the legacy `forgo-faction-rule` wording verbatim;
/// core-rule slugs get natural action/benefit phrasing; keyword/ability kinds fall
/// back to a regular gains/loses-the-X clause. Pinned across the four ports by
/// the conformance corpus.
fn describe_rule_state(m: &Map<String, Value>, subj: &str) -> String {
    let direction = jv(m, "direction");
    let kind = jv(m, "rule_kind");
    let rule = jv(m, "rule");
    let granted = direction == "granted";

    if kind == "faction-rule" && !granted {
        let scope = if notnull(m, "scope") {
            format!(" this {}", dekebab(&jv(m, "scope")))
        } else {
            String::new()
        };
        let cost = match m.get("cost") {
            Some(Value::Object(c)) if !c.get("dice").map(Value::is_null).unwrap_or(true) => {
                let from = match c.get("from") {
                    None | Some(Value::Null) => String::new(),
                    Some(v) if jval(v) == rule => " from that roll".to_string(),
                    Some(v) => format!(" from the {} roll", title_case(&jval(v))),
                };
                format!(
                    ", using a {}{from}",
                    dekebab(&c.get("dice").map(jval).unwrap_or_default())
                )
            }
            _ => String::new(),
        };
        return format!("forgo activating {}{scope}{cost}", title_case(&rule));
    }
    if kind == "faction-rule" {
        return format!("{subj} {} {}", agree(subj, "gains"), title_case(&rule));
    }

    match rule.as_str() {
        "benefit-of-cover" => {
            if granted {
                format!("{subj} {} the Benefit of Cover", agree(subj, "has"))
            } else {
                format!("{subj} cannot benefit from Cover")
            }
        }
        "charge" => {
            if granted {
                format!("{subj} can charge")
            } else {
                format!("{subj} cannot charge")
            }
        }
        "advance" => {
            if granted {
                format!("{subj} can Advance")
            } else {
                format!("{subj} cannot Advance")
            }
        }
        "fall-back" => {
            if granted {
                format!("{subj} can Fall Back")
            } else {
                format!("{subj} cannot Fall Back")
            }
        }
        "fire-overwatch" => {
            if granted {
                format!("{subj} can fire Overwatch")
            } else {
                format!("{subj} cannot fire Overwatch")
            }
        }
        "overwatch-against-bearer" => {
            if granted {
                format!("your opponent can target {subj} with Overwatch")
            } else {
                format!("your opponent cannot target {subj} with Overwatch")
            }
        }
        "desperate-escape" => {
            if granted {
                format!("{subj} must take Desperate Escape tests")
            } else {
                format!(
                    "{subj} {} not affected by Desperate Escape tests",
                    agree(subj, "is")
                )
            }
        }
        _ => {
            let noun = if kind == "keyword" {
                "keyword"
            } else {
                "ability"
            };
            if granted {
                format!(
                    "{subj} {} the {} {noun}",
                    agree(subj, "gains"),
                    title_case(&rule)
                )
            } else {
                format!(
                    "{subj} {} the {} {noun}",
                    agree(subj, "loses"),
                    title_case(&rule)
                )
            }
        }
    }
}

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

/// Movement-modifier passthrough enum → human phrase (`PASSTHROUGH_PHRASE`).
fn passthrough_phrase(p: &str) -> String {
    match p {
        "non-titanic-models" => "non-Titanic models".to_string(),
        "friendly-vehicles" => "friendly Vehicle models".to_string(),
        "friendly-monsters" => "friendly Monster models".to_string(),
        "terrain-le-4" => "terrain features 4\" or lower".to_string(),
        "tall-terrain" => "terrain features over 4\"".to_string(),
        "all-terrain" => "terrain features".to_string(),
        other => dekebab(other),
    }
}

/// Move-kind token → display noun (`MOVE_NOUN`, for `applies_to_moves`).
fn move_noun(x: &str) -> String {
    match x {
        "normal" => "Normal".to_string(),
        "advance" => "Advance".to_string(),
        "fall-back" => "Fall Back".to_string(),
        "charge" => "Charge".to_string(),
        other => dekebab(other),
    }
}

/// Oxford-free conjunction list ("a", "a and b", "a, b and c").
fn and_list(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} and {}", items[0], items[1]),
        n => format!("{} and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

/// Trailing inches clause for a movement distance (int or dice string); "" when absent/zero.
fn inch_clause(dist: Option<&Value>) -> String {
    match dist {
        None | Some(Value::Null) => String::new(),
        Some(d) => {
            let s = dice_case(d);
            if s == "0" {
                String::new()
            } else {
                format!(" {s}\"")
            }
        }
    }
}

/// Closed movement-modifier `modifier` → one lowercase-initial clause. Mirrors
/// `movementClause` in `tools/src/translate/effect.ts`.
fn movement_clause(m: &Map<String, Value>, subj: &str) -> String {
    let kind = nstr(m, "move_type");
    let dist = m.get("distance");
    let inches = inch_clause(dist);
    let of_up_to = if inches.is_empty() {
        String::new()
    } else {
        format!(" of up to{inches}")
    };
    let move_kinds: Option<String> = match m.get("applies_to_moves") {
        Some(Value::Array(a)) => Some(and_list(
            &a.iter().map(|x| move_noun(&jval(x))).collect::<Vec<_>>(),
        )),
        _ => None,
    };

    // Pure traversal capability (no move kind): passthrough / vertical / ignore-vertical.
    if kind.is_none() {
        let mut parts: Vec<String> = Vec::new();
        if let Some(Value::Array(a)) = m.get("passthrough") {
            if !a.is_empty() {
                parts.push(
                    a.iter()
                        .map(|p| passthrough_phrase(&jval(p)))
                        .collect::<Vec<_>>()
                        .join(" and "),
                );
            }
        }
        let mut clause = if !parts.is_empty() {
            let over = if notnull(m, "vertical_limit") {
                format!(" (up to {}\" high)", jv(m, "vertical_limit"))
            } else {
                String::new()
            };
            format!(
                "{subj} can move over {}{over} as though they were not there",
                parts.join(" and ")
            )
        } else if truthy(m, "ignore_vertical") {
            format!("{subj} ignores vertical distances when it moves")
        } else {
            format!("{subj} {} a movement capability", agree(subj, "has"))
        };
        if notnull(m, "excludes_keyword") {
            clause.push_str(&format!(
                " (excluding {} models)",
                title_case(&jv(m, "excludes_keyword"))
            ));
        }
        if let Some(mk) = &move_kinds {
            clause.push_str(&format!(", during its {mk} moves"));
        }
        return clause;
    }

    match kind.unwrap() {
        "scout" => format!("before the first battle round, {subj} can make a Scout move{of_up_to}"),
        "infiltrate" => format!("{subj} {} the Infiltrators ability", agree(subj, "has")),
        "advance" => format!(
            "add {} to {} Advance rolls",
            dice_case(dist.unwrap_or(&Value::Null)),
            possessive(subj)
        ),
        "pile-in" => format!(
            "{subj} can Pile In up to{}",
            if inches.is_empty() {
                " 3\"".to_string()
            } else {
                inches.clone()
            }
        ),
        "consolidation" => format!(
            "{subj} can Consolidate up to{}",
            if inches.is_empty() {
                " 3\"".to_string()
            } else {
                inches.clone()
            }
        ),
        "surge" => format!("{subj} can make a Surge move{of_up_to}"),
        "shoot-and-scoot" => {
            if inches.is_empty() {
                format!("{subj} can Shoot and Scoot")
            } else {
                format!("{subj} can shoot and then make a Normal move{of_up_to}")
            }
        }
        "reactive" => {
            let label = if notnull(m, "name") {
                format!(" ({})", jv(m, "name"))
            } else {
                String::new()
            };
            format!("{subj} can make a Reactive move{of_up_to}{label}")
        }
        "redeploy" => {
            if notnull(m, "marker") {
                if let Some(mk) = m.get("marker").and_then(Value::as_object) {
                    if notnull(mk, "location") {
                        let who = if notnull(mk, "unit_filter") {
                            format!("{} units", jv(mk, "unit_filter"))
                        } else {
                            "units".to_string()
                        };
                        return format!("{who} can be set up on {}", jv(mk, "location"));
                    }
                    let what = if notnull(mk, "affected") {
                        jv(mk, "affected")
                    } else {
                        "markers".to_string()
                    };
                    return format!("{what} can be repositioned{inches}");
                }
            }
            if truthy(m, "to_reserves") {
                let n = if notnull(m, "max_units") {
                    format!("up to {} units", jv(m, "max_units"))
                } else {
                    subj.to_string()
                };
                return format!("{n} can be placed into Strategic Reserves");
            }
            format!("{subj} can be redeployed{inches}")
        }
        // "normal" and any other kind fall to the default arm.
        _ => {
            if let Some(n) = dist.and_then(Value::as_f64) {
                if n < 0.0 {
                    return format!(
                        "{} Move characteristic is reduced by {}\"",
                        possessive(subj),
                        fmt_num(n.abs())
                    );
                }
            }
            if let Some(mk) = &move_kinds {
                return format!("add{inches} to {} {mk} moves", possessive(subj));
            }
            format!("{subj} can make a Normal move{of_up_to}")
        }
    }
}

/// Generic aura `modifier` → one lowercase-initial clause. Mirrors `auraClause`.
fn aura_clause(e: &AuraEffect, ctx: &Ctx) -> String {
    let m = &e.modifier;
    // Range-extension of a named aura (e.g. Gift of Poxes: contagion +3").
    if let Some(range_bonus) = m.range_bonus {
        let named = match &m.of {
            Some(of) => format!("{} ", title_case(of)),
            None => String::new(),
        };
        return format!(
            "the range of this model's {named}abilities is increased by {range_bonus}\""
        );
    }
    let range_text: Option<String> = match &m.range {
        Some(AuraEffectModifierRange::Array(arr)) => Some(format!(
            "{} (by battle round)",
            arr.iter()
                .map(|r| format!("{r}\""))
                .collect::<Vec<_>>()
                .join("/")
        )),
        Some(AuraEffectModifierRange::Integer(n)) => Some(format!("{n}\"")),
        None => None,
    };
    let who = if e.target == AuraEffectTarget::FriendlyWithinAura {
        "each friendly unit"
    } else {
        "each enemy unit"
    };
    let within = match &range_text {
        Some(rt) => format!("{who} within {rt}"),
        None => who.to_string(),
    };
    match &m.effect {
        Some(inner) => format!("{within} {}", inline(inner, ctx)),
        None => format!("{within} is affected"),
    }
}

/// Resurrection `placement` modifier → a "where it is set up" clause.
fn resurrection_placement(placement: Option<&Value>) -> String {
    match placement {
        None | Some(Value::Null) => String::new(),
        Some(v) => match jval(v).as_str() {
            "deep-strike" => "using its Deep Strike ability".to_string(),
            "battlefield-edge" => "at a battlefield edge".to_string(),
            "closest-to-destruction" => {
                "as close as possible to where it was destroyed".to_string()
            }
            "unengaged" => "not within Engagement Range of any enemy units".to_string(),
            other => format!("via {}", dekebab(other)),
        },
    }
}

/// Resurrection `timing` modifier → a "when it is set up" clause.
fn resurrection_timing(timing: Option<&Value>) -> String {
    match timing {
        None | Some(Value::Null) => String::new(),
        Some(v) => match jval(v).as_str() {
            "next-movement-phase" => "in your next Movement phase".to_string(),
            "end-of-phase" => "at the end of the phase".to_string(),
            other => dekebab(other),
        },
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
            let kw = if notnull(m, "anti_keyword") {
                let th = first(m, &["anti_threshold"])
                    .map(jval)
                    .unwrap_or_else(|| "?".to_string());
                format!(
                    "[ANTI-{} {th}+]",
                    dekebab(&jv(m, "anti_keyword")).to_uppercase()
                )
            } else if let Some(Value::Array(a)) = m.get("keywords") {
                a.iter()
                    .map(bracket_keyword)
                    .collect::<Vec<_>>()
                    .join(" and ")
            } else if notnull(m, "value") {
                let kw_name = first(m, &["keyword"])
                    .map(jval)
                    .unwrap_or_else(|| "keywords".to_string());
                format!("[{} {}]", dekebab(&kw_name).to_uppercase(), jv(m, "value"))
            } else {
                let kw_or_default = first(m, &["keyword"])
                    .cloned()
                    .unwrap_or_else(|| Value::String("keywords".to_string()));
                bracket_keyword(&kw_or_default)
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
            let wounds = first(m, &["wounds_remaining"])
                .map(jval)
                .unwrap_or_else(|| "full".to_string());
            let place = resurrection_placement(m.get("placement"));
            let when = resurrection_timing(m.get("timing"));
            let tail = [place, when]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let tail_clause = if tail.is_empty() {
                String::new()
            } else {
                format!(" {tail}")
            };
            // A self/bearer resurrection reads as the model returning, not "returning a model to itself".
            let tgt = e.target.to_string();
            if tgt == "self" || tgt == "bearer" {
                return format!(
                    "{subj} {} set up again{tail_clause} with {wounds} wounds remaining",
                    agree(&subj, "is")
                );
            }
            let noun = if count == "1" {
                "destroyed model"
            } else {
                "destroyed models"
            };
            format!("return {count} {noun} to {subj} with {wounds} wounds{tail_clause}")
        }
        T::ModelDestruction => {
            let count = first(m, &["count"])
                .map(dice_case)
                .unwrap_or_else(|| "1".to_string());
            let noun = if count == "1" { "model" } else { "models" };
            format!("destroy {count} {noun} in {subj}")
        }
        T::RuleState => describe_rule_state(m, &subj),
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
        T::DeepStrike => {
            if notnull(m, "min_distance") {
                format!(
                    "{subj} {} the Deep Strike ability and can be set up more than {}\" from enemy models",
                    agree(&subj, "has"),
                    jv(m, "min_distance")
                )
            } else {
                format!("{subj} has the Deep Strike ability")
            }
        }
        T::StrategicReservesArrival => {
            format!("{subj} can arrive from Strategic Reserves regardless of mission rules")
        }
        T::RemoveBattleShock => format!("{subj} {} no longer Battle-shocked", agree(&subj, "is")),
        T::FallbackAndAct => format!(
            "{subj} {} eligible to shoot and declare a charge in a turn in which it Fell Back",
            agree(&subj, "is")
        ),
        T::EngagementPassthrough => {
            if truthy(m, "no_end_in_engagement") {
                format!("{subj} can move through enemy models, but cannot end that move within Engagement Range of any enemy unit")
            } else {
                format!("{subj} can move through enemy models")
            }
        }
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
        T::AutoResult => {
            let result = nstr(m, "result");
            if notnull(m, "test") {
                let test = m.get("test").unwrap_or(&Value::Null);
                match result {
                    Some("pass") => format!(
                        "{subj} automatically {} {} tests",
                        agree(&subj, "passes"),
                        test_name(test)
                    ),
                    Some("fail") => format!(
                        "{subj} automatically {} {} tests",
                        agree(&subj, "fails"),
                        test_name(test)
                    ),
                    _ => format!(
                        "{subj} {} {} tests as {}",
                        agree(&subj, "treats"),
                        test_name(test),
                        jv(m, "result")
                    ),
                }
            } else {
                let roll = roll_name(m.get("roll").unwrap_or(&Value::Null));
                match result {
                    Some("pass") => {
                        format!("{} {roll} rolls automatically succeed", possessive(&subj))
                    }
                    Some("fail") => {
                        format!("{} {roll} rolls automatically fail", possessive(&subj))
                    }
                    _ => format!(
                        "{} {roll} rolls count as {}",
                        possessive(&subj),
                        jv(m, "result")
                    ),
                }
            }
        }
        T::FiringDeck => {
            format!(
                "{subj} {} Firing Deck {}",
                agree(&subj, "has"),
                jv(m, "value")
            )
        }
        T::DisembarkAfterMove => format!("units can disembark from {subj} after it has moved"),
    }
}

/// Single-clause translation for leaf effects (lowercase-initial, no period).
pub fn describe_effect_inline(e: &EffectNode) -> String {
    inline(e, &Ctx::default())
}

/// `for every 5 enemy models within 6"` — the trailing scaling clause woven
/// onto a single effect whose `modifier.value` scales. Mirrors `scalingClause`.
fn scaling_clause(s: &Scaling) -> String {
    let of_text = match s.of {
        ScalingOf::EnemyModelsInRange => "enemy models",
        ScalingOf::FriendlyModelsInRange => "friendly models",
        ScalingOf::ModelsInBearerUnit => "models in this unit",
        ScalingOf::EnemyUnitsInRange => "enemy units",
        ScalingOf::WoundsLost => "wounds lost",
    };
    let mut c = format!("for every {} {of_text}", s.per.get());
    if let Some(w) = s.within_inches {
        c.push_str(&format!(" within {}\"", fmt_num(w)));
    }
    if matches!(s.round, ScalingRound::Up) {
        c.push_str(" (rounding up)");
    }
    if let Some(mx) = s.max_value {
        c.push_str(&format!(" (to a maximum of {mx})"));
    }
    c
}

fn inline(e: &EffectNode, ctx: &Ctx) -> String {
    match e {
        EffectNode::SingleEffect(s) => match &s.scaling {
            Some(sc) => format!("{} {}", describe_single(s, ctx), scaling_clause(sc)),
            None => describe_single(s, ctx),
        },
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
        EffectNode::MovementModifierEffect(mm) => {
            let subj = subject(&mm.target.to_string(), ctx);
            movement_clause(&movement_modifier_map(mm), &subj)
        }
        EffectNode::AuraEffect(a) => aura_clause(a, ctx),
    }
}

/// Serialize a closed `MovementModifierEffect` modifier back to a JSON map so the
/// `movementClause` port can read it with the same `?? / != null` semantics the TS
/// oracle applies to its free-form `Record<string, unknown>`.
fn movement_modifier_map(mm: &MovementModifierEffect) -> Map<String, Value> {
    serde_json::to_value(&mm.modifier)
        .ok()
        .and_then(|v| match v {
            Value::Object(o) => Some(o),
            _ => None,
        })
        .unwrap_or_default()
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
                "{} ({} of {}+): {}",
                o.name,
                o.requirement.type_,
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
        EffectNode::SingleEffect(_)
        | EffectNode::MovementModifierEffect(_)
        | EffectNode::AuraEffect(_) => {
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

/// Reactive-trigger opener ("an enemy unit ends a move within 9" of this model,
/// if ..."). Mirrors `describeTrigger` for ability `trigger` blocks.
fn describe_ability_trigger(t: &AbilityTrigger) -> String {
    let mut s = event_clause(&t.event.to_string());
    if let Some(prox) = &t.proximity {
        let of = match prox.of {
            Some(AbilityTriggerProximityOf::AttachedUnit) => "the unit this model leads",
            Some(AbilityTriggerProximityOf::Self_) | Some(AbilityTriggerProximityOf::Bearer) => {
                "this model"
            }
            None => "this unit",
        };
        s.push_str(&format!(" within {}\" of {of}", fmt_num(prox.range)));
    }
    if let Some(cond) = &t.condition {
        s.push_str(&format!(", if {}", describe_node(&cond.0)));
    }
    s
}

/// Usage limit → front-of-sentence lead clause ("once per turn", "twice per
/// battle per unit"). Mirrors `usageClause`.
fn usage_clause(u: &AbilityUsage) -> String {
    let n = u.count.map(|c| c.get()).unwrap_or(1);
    let base = match u.frequency {
        AbilityUsageFrequency::OncePerTurn => "once per turn".to_string(),
        AbilityUsageFrequency::OncePerPhase => "once per phase".to_string(),
        AbilityUsageFrequency::OncePerCommandPhase => "once per Command phase".to_string(),
        AbilityUsageFrequency::OncePerOpponentTurn => "once per opponent's turn".to_string(),
        AbilityUsageFrequency::FirstThisBattle => "the first time this battle".to_string(),
        AbilityUsageFrequency::FirstTimeThisPhase => "the first time this phase".to_string(),
        AbilityUsageFrequency::NPerBattle => {
            if n == 1 {
                "once per battle".to_string()
            } else if n == 2 {
                "twice per battle".to_string()
            } else {
                format!("{n} times per battle")
            }
        }
    };
    match &u.per {
        Some(per) => format!("{base} per {per}"),
        None => base,
    }
}

/// Assemble the top-level sentence/block, weaving scope range + duration. An
/// explicit usage limit supersedes the duration's coarse "once per battle" lead.
/// Aura radius in inches: an explicit `range_inches`, else the integer baked into
/// a standard `aura-<n>` slug (`aura-6` -> 6), else None. Per the scope schema,
/// `aura-6/9/12` carry the radius in the slug and leave `range_inches` null; only
/// `aura-custom` sets `range_inches`. Non-aura ranges yield None, keeping the
/// subject helper's " nearby" fallback.
fn aura_radius(scope: Option<&Scope>) -> Option<f64> {
    let scope = scope?;
    if let Some(ri) = scope.range_inches {
        return Some(ri);
    }
    match scope.range {
        ScopeRange::Aura6 => Some(6.0),
        ScopeRange::Aura9 => Some(9.0),
        ScopeRange::Aura12 => Some(12.0),
        _ => None,
    }
}

fn render_top_level(
    e: &EffectNode,
    scope: Option<&Scope>,
    usage: Option<&AbilityUsage>,
    trigger: Option<&AbilityTrigger>,
) -> String {
    let ctx = Ctx {
        range_inches: aura_radius(scope),
    };
    let duration = scope.map(|s| s.duration.to_string()).unwrap_or_default();
    let (dur_lead, trail) = duration_clauses(&duration);
    let lead = match usage {
        Some(u) => usage_clause(u),
        None => dur_lead,
    };
    // A reactive trigger opens the sentence, ahead of the usage/duration lead.
    let trig = match trigger {
        Some(t) => describe_ability_trigger(t),
        None => String::new(),
    };

    match e {
        EffectNode::ConditionalEffect(c) => {
            let inner = &*c.effect;
            let lead_in = condition_lead_in(&c.condition.0);
            if is_container(inner) {
                let header = [trig, lead, lead_in, trail]
                    .into_iter()
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{}:\n{}", capitalize(&header), block(inner, 1, &ctx))
            } else {
                assemble_sentence(&[trig, lead, lead_in, trail, inline(inner, &ctx)])
            }
        }
        _ if is_container(e) => {
            let blk = block(e, 0, &ctx);
            let dur = if !lead.is_empty() { lead } else { trail };
            let head = [trig, dur]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            if head.is_empty() {
                blk
            } else {
                format!("{}:\n{}", capitalize(&head), blk)
            }
        }
        _ => assemble_sentence(&[trig, lead, trail, inline(e, &ctx)]),
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
    usage: Option<&AbilityUsage>,
    trigger: Option<&AbilityTrigger>,
) -> String {
    let base = render_top_level(e, scope, usage, trigger);
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
    describe_ability_parts(
        &a.effect,
        Some(&a.scope),
        a.applies_to.as_ref(),
        a.usage.as_ref(),
        a.trigger.as_ref(),
    )
}
