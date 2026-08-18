//! Plain-English translation of Ability-DSL `effect` trees — the Rust mirror
//! of `tools/src/translate/effect.ts` (the "ability.print()" of the dataset).
//! Output is subject-first GW-datasheet prose, scope range + duration woven in,
//! single-leaf conditionals inlined. **ASCII-only** and byte-for-byte identical
//! to the TS oracle; the `conformance/effect-translation` corpus pins both
//! ports. Any phrasing change here is a semantic corpus change (bump
//! `conformance/SPEC_VERSION`).

use serde_json::{Map, Value};

use super::{
    battle_round_ordinal, dekebab, describe_node, describe_timing, event_clause, negated_timing,
    num_param,
};
use crate::generated::{
    Ability, AbilityAppliesTo, AbilityTrigger, AbilityUsage, AbilityUsageFrequency, AuraEffect,
    AuraEffectModifierRange, AuraEffectTarget, BeneficiaryBoundEffectNode,
    CompoundConditionOperator, Condition, ConditionNode, DesignateTargetEffectAppliesTo,
    DesignateTargetEffectSelectScope, DiceGatedEffect, DiceGatedEffectComparison,
    DiceGatedEffectThreshold, DicePoolAllocationEffect, DiceRequirementSpec, EffectNode,
    KeywordFilter, LeaderModelAbilityGrantEffect, LeaderModelAbilityGrantEffectBeneficiary,
    MovementModifierEffect, PersistentDesignationEffect,
    PersistentDesignationEffectConsumerRelation, PersistentDesignationEffectSelectScope,
    ResourceActionMenuEffect, ResourceActionMenuEffectActionsItem,
    ResourceActionMenuEffectActionsItemDuration, ResourceActionMenuEffectActionsItemWhen,
    ResourceActionMenuEffectSharedUsage, ResourceActionMenuTrigger,
    ResourceActionMenuTriggerMoveTypesItem, ResourceActionMenuTriggerProximityOf,
    ResourceActionMenuTriggerSubject, Scaling, ScalingOf, ScalingRound, Scope, ScopeRange,
    SelectUnitsEffectSelector, SimpleConditionType, SingleEffect, SingleEffectTarget,
    SingleEffectType, StanceSelectEffectMode, Trigger, TriggerMoveTypesItem, TriggerProximityOf,
    TriggerSubject,
};

/// Rendering context threaded from the ability (scope info the leaf needs).
#[derive(Default, Clone, Copy)]
struct Ctx {
    range_inches: Option<f64>,
    /// True when the ability scope is `engagement-range`, so within-aura subjects read "within Engagement Range".
    engagement_range: bool,
    /// The raw scope range, for the non-radius scopes (`any-visible`,
    /// `any-on-battlefield`) whose within-aura subjects have a real extent the
    /// generic " nearby" fallback would drop.
    scope_range: Option<ScopeRange>,
    /// True inside a `select-units` nested effect: a bare `unit` target refers
    /// to the selected unit ("that unit"), not the ability's generic subject.
    selected_unit: bool,
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
        "nurgle-s-gift-aura" => "Nurgle's Gift (Aura)".to_string(),
        _ => title_case(id),
    }
}

/// "(your Suppressed target)" — a designate-target mark's parenthetical. A
/// designation slug that already ends in "target" keeps its own noun
/// ("bio-stimulus-target" → "(your Bio Stimulus Target)", not "… Target target").
fn designation_label(designation: &str) -> String {
    let label = title_case(designation);
    if label == "Target" || label.ends_with(" Target") {
        format!(" (your {label})")
    } else {
        format!(" (your {label} target)")
    }
}

fn persistent_designation_name(
    designation: &str,
    scope: PersistentDesignationEffectSelectScope,
) -> String {
    let label = title_case(designation);
    if scope == PersistentDesignationEffectSelectScope::ObjectiveMarker {
        if label.ends_with(" Marker") {
            format!("your {label}")
        } else {
            format!("your {label} Marker")
        }
    } else if label == "Target" || label.ends_with(" Target") {
        format!("your {label}")
    } else {
        format!("your {label} target")
    }
}

fn persistent_designation_label(
    designation: &str,
    scope: PersistentDesignationEffectSelectScope,
) -> String {
    format!(" ({})", persistent_designation_name(designation, scope))
}

fn persistent_designation_supported(p: &PersistentDesignationEffect) -> bool {
    matches!(
        (p.select.scope, p.consumer.relation),
        (
            PersistentDesignationEffectSelectScope::EnemyUnit,
            PersistentDesignationEffectConsumerRelation::AttacksSelectedUnit
        ) | (
            PersistentDesignationEffectSelectScope::ObjectiveMarker,
            PersistentDesignationEffectConsumerRelation::WithinSelectedMarker
        )
    )
}

fn persistent_designation_lead(p: &PersistentDesignationEffect) -> String {
    let scope_noun = match p.select.scope {
        PersistentDesignationEffectSelectScope::EnemyUnit => "enemy unit",
        PersistentDesignationEffectSelectScope::ObjectiveMarker => "objective marker",
    };
    let label = persistent_designation_label(p.designation.as_str(), p.select.scope);
    format!(
        "{}, select one {scope_noun}{label}.",
        describe_timing(&p.select.timing)
    )
}

fn persistent_designation_when(p: &PersistentDesignationEffect) -> String {
    let name = persistent_designation_name(p.designation.as_str(), p.select.scope);
    let relation = match p.consumer.relation {
        PersistentDesignationEffectConsumerRelation::WithinSelectedMarker => {
            format!("while this model is within range of {name}")
        }
        PersistentDesignationEffectConsumerRelation::AttacksSelectedUnit => {
            "each time this model makes an attack against it".to_string()
        }
    };
    let duration = p.duration.to_string();
    let (_, trail) = duration_clauses(&duration);
    if trail.is_empty() {
        relation
    } else {
        format!("{}, {relation}", capitalize(&trail))
    }
}

fn beneficiary_bound_inline(effect: &BeneficiaryBoundEffectNode, ctx: &Ctx) -> String {
    let mut object = Map::new();
    object.insert(
        "type".to_string(),
        Value::String(effect.type_.as_str().to_string()),
    );
    object.insert("target".to_string(), Value::String("self".to_string()));
    object.insert(
        "modifier".to_string(),
        Value::Object(effect.modifier.clone()),
    );
    if let Some(scaling) = &effect.scaling {
        if let Ok(value) = serde_json::to_value(scaling) {
            object.insert("scaling".to_string(), value);
        }
    }
    match serde_json::from_value::<EffectNode>(Value::Object(object)) {
        Ok(node) => inline(&node, ctx).replacen("this model", "that leader model", 1),
        Err(_) => format!("[{}]", effect.type_.as_str()),
    }
}

fn leader_model_ability_grant_clause(p: &LeaderModelAbilityGrantEffect, ctx: &Ctx) -> String {
    let (identity, keywords) = match &p.leader_filter {
        Some(filter) => (
            filter
                .identity
                .as_ref()
                .map(|identity| format!(" identified as {}", title_case(identity.as_str())))
                .unwrap_or_default(),
            filter
                .keywords
                .iter()
                .map(|keyword| bracket_keyword(&Value::String(keyword.as_str().to_string())))
                .collect::<Vec<_>>()
                .join(" and "),
        ),
        None => (String::new(), String::new()),
    };
    let role = match p.beneficiary {
        LeaderModelAbilityGrantEffectBeneficiary::AttachedCharacterLeader => {
            "the attached CHARACTER leader model"
        }
        LeaderModelAbilityGrantEffectBeneficiary::LeadingLeaderModel => "the attached leader model",
    };
    let leader = format!(
        "{role}{identity}{}",
        if keywords.is_empty() {
            String::new()
        } else {
            format!(" with {keywords}")
        }
    );
    let unit_keywords = p
        .attached_unit_filter
        .as_ref()
        .map(|filters| {
            filters
                .iter()
                .map(|keyword| bracket_keyword(&Value::String(keyword.as_str().to_string())))
                .collect::<Vec<_>>()
                .join(" and ")
        })
        .unwrap_or_default();
    let source = if unit_keywords.is_empty() {
        "the bearer unit".to_string()
    } else {
        format!("the bearer unit with {unit_keywords}")
    };
    let nested = beneficiary_bound_inline(&p.grant.effect, ctx);
    format!("while {leader} leads {source}, {nested}")
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

/// Player-facing noun for a resource pool. An explicit singular label is
/// pluralized by count; otherwise the internal pool id is title-cased.
fn resource_noun(m: &Map<String, Value>, count: Option<&Value>) -> String {
    let label = m
        .get("resource_label")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let Some(label) = label else {
        return first(m, &["pool_id", "resource"])
            .map(pool_name)
            .unwrap_or_else(|| "?".to_string());
    };
    let singular = count
        .map(jval)
        .and_then(|s| s.parse::<f64>().ok())
        .is_some_and(|n| n == 1.0);
    if singular {
        label.to_string()
    } else {
        format!("{label}s")
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
        None if ctx.engagement_range => " within Engagement Range".to_string(),
        None if ctx.scope_range == Some(ScopeRange::AnyVisible) => " that are visible".to_string(),
        None if ctx.scope_range == Some(ScopeRange::AnyOnBattlefield) => {
            " anywhere on the battlefield".to_string()
        }
        None => " nearby".to_string(),
    };
    match target {
        "self" | "bearer" => "this model".to_string(),
        "unit" if ctx.selected_unit => "that unit".to_string(),
        "unit" => "the unit".to_string(),
        "attached-unit" => "the unit this model leads".to_string(),
        "target" => "the target".to_string(),
        "attacker" => "the attacking unit".to_string(),
        "defender" => "the target".to_string(),
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

/// `<subj>'s <rest>` for a simple subject; `the <rest> of <subj>` when the subject
/// is a clause (an aura target ending in an inch mark), where a trailing possessive
/// reads as garbage (`friendly units within 6"'s weapons`).
fn of_or_possessive(subj: &str, rest: &str) -> String {
    if subj.ends_with('"') {
        format!("the {rest} of {subj}")
    } else {
        format!("{} {rest}", possessive(subj))
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
        "until-next-command-phase" => (
            String::new(),
            "until the start of your next Command phase".to_string(),
        ),
        "until-next-battle-round" => (
            String::new(),
            "until the start of the next battle round".to_string(),
        ),
        "one-use" => ("once per battle".to_string(), String::new()),
        _ => (String::new(), String::new()),
    }
}

/// A condition rendered as a natural lead-in clause (lowercase-initial).
/// "against a unit that is not a Monster or Vehicle" from a run of excluded target keywords.
fn negated_target_keywords(keywords: &[String]) -> String {
    format!("against a unit that is not a {}", keywords.join(" or "))
}

/// Capitalize the first character and lowercase the rest (`MONSTER` -> `Monster`).
fn cap_word(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// The keyword of a `not`-wrapping-a-single-`target-has-keyword` operand, else None.
/// The aura-subject exclusion encoding, distinct from the bare negated form.
fn not_wrapped_target_keyword(n: &ConditionNode) -> Option<String> {
    if let ConditionNode::CompoundCondition(c) = n {
        if matches!(c.operator, CompoundConditionOperator::Not) && c.operands.len() == 1 {
            if let ConditionNode::SimpleCondition(s) = &c.operands[0] {
                if s.type_ == SimpleConditionType::TargetHasKeyword && !s.negated {
                    return Some(jv(&s.parameters, "keyword"));
                }
            }
        }
    }
    None
}

/// "(excluding Monster or Vehicle units)" from a run of `not`-wrapped exclusions.
fn excluded_target_keywords(keywords: &[String]) -> String {
    format!(
        "(excluding {} units)",
        keywords
            .iter()
            .map(|k| cap_word(k))
            .collect::<Vec<_>>()
            .join(" or ")
    )
}

/// Join the operands of an `and` lead-in. Two exclusion encodings collapse: a run
/// of bare-negated `target-has-keyword` becomes "against a unit that is not a X or
/// Y", and a run of `not`-wrapped `target-has-keyword` becomes "(excluding X or Y
/// units)". Either attaches to the preceding clause with a space; all other
/// operands join with ", ".
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
        if not_wrapped_target_keyword(&operands[i]).is_some() {
            let mut kws: Vec<String> = Vec::new();
            while i < operands.len() {
                match not_wrapped_target_keyword(&operands[i]) {
                    Some(kw) => {
                        kws.push(kw);
                        i += 1;
                    }
                    None => break,
                }
            }
            parts.push(excluded_target_keywords(&kws));
            continue;
        }
        if let ConditionNode::SimpleCondition(s) = &operands[i] {
            if !s.negated && s.type_ == SimpleConditionType::UnitHasKeyword {
                let mut kws: Vec<String> = Vec::new();
                while i < operands.len() {
                    match &operands[i] {
                        ConditionNode::SimpleCondition(s2)
                            if !s2.negated && s2.type_ == SimpleConditionType::UnitHasKeyword =>
                        {
                            kws.push(jv(&s2.parameters, "keyword"));
                            i += 1;
                        }
                        _ => break,
                    }
                }
                parts.push(if kws.len() >= 2 {
                    format!("if the unit is a {} unit", kws.join(" "))
                } else {
                    format!("if the unit has the {} keyword", kws[0])
                });
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
        } else if part.starts_with("against ") || part.starts_with("(excluding ") {
            acc = format!("{acc} {part}");
        } else {
            acc = format!("{acc}, {part}");
        }
    }
    acc
}

/// Join `or` operands exactly as the TypeScript lead-in renderer: an
/// all-keyword disjunction becomes a shared keyword list; mixed disjunctions
/// retain each operand's natural framing.
fn join_or_lead_ins(operands: &[ConditionNode]) -> String {
    let keyword_operands = operands.iter().all(|operand| {
        matches!(
            operand,
            ConditionNode::SimpleCondition(s)
                if !s.negated && s.type_ == SimpleConditionType::UnitHasKeyword
        )
    });
    if keyword_operands {
        let keywords = operands
            .iter()
            .filter_map(|operand| match operand {
                ConditionNode::SimpleCondition(s) => Some(jv(&s.parameters, "keyword")),
                _ => None,
            })
            .collect::<Vec<_>>();
        return format!("if the unit has the {} keywords", or_list(&keywords));
    }
    operands
        .iter()
        .map(condition_lead_in)
        .collect::<Vec<_>>()
        .join(" or ")
}

fn condition_lead_in(n: &ConditionNode) -> String {
    match n {
        ConditionNode::CompoundCondition(c) => match c.operator {
            CompoundConditionOperator::And => join_and_lead_ins(&c.operands),
            CompoundConditionOperator::Or => join_or_lead_ins(&c.operands),
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
                    SimpleConditionType::TimingIs => {
                        negated_timing(nstr(&s.parameters, "timing").unwrap_or("?"))
                    }
                    SimpleConditionType::RegionMembership => {
                        format!(
                            "unless {}",
                            super::region_membership_phrase(&s.parameters, false)
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
                    format!("while this model is leading a {kw}unit")
                }
                T::RegionMembership => {
                    format!("when {}", super::region_membership_phrase(p, false))
                }
                T::TimingIs => describe_timing(nstr(p, "timing").unwrap_or("?")),
                T::PlayerTurnIs => match nstr(p, "turn") {
                    Some("your-turn") | Some("your") | Some("own") => "in your turn".to_string(),
                    Some("opponent-turn") | Some("opponent") => {
                        "in the opponent's turn".to_string()
                    }
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
                T::BattleRound => match (num_param(p, "min"), num_param(p, "max")) {
                    (Some(min), Some(max)) => {
                        if min == max {
                            format!("during the {} battle round", battle_round_ordinal(min))
                        } else {
                            format!("during battle rounds {min}-{max}")
                        }
                    }
                    (Some(min), None) => {
                        format!("from the {} battle round onward", battle_round_ordinal(min))
                    }
                    (None, Some(max)) => format!("during the first {max} battle rounds"),
                    (None, None) => "during the battle round".to_string(),
                },
                T::TokenCountAtOrAbove => format!(
                    "while the unit has {}+ {}",
                    jv(p, "threshold"),
                    p.get("pool_id")
                        .map(pool_name)
                        .unwrap_or_else(|| "?".to_string())
                ),
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
                    if jv(p, "attack_type") == "any" {
                        "when destroyed by any attack".to_string()
                    } else {
                        format!("when destroyed by a {} attack", jv(p, "attack_type"))
                    }
                }
                T::OpponentUnitWithinRange => {
                    let where_ = if notnull(p, "weapon_name") {
                        format!("range of {}", dekebab(&jv(p, "weapon_name")))
                    } else if notnull(p, "range_multiplier") {
                        "half range of its ranged weapons".to_string()
                    } else {
                        let rv = first(p, &["range", "range_inches", "within_inches"]);
                        if rv.and_then(Value::as_str) == Some("engagement") {
                            "engagement range".to_string()
                        } else {
                            format!("{}\"", rv.map(jval).unwrap_or_else(|| "?".to_string()))
                        }
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

fn named_region_title(v: Option<&Value>) -> String {
    title_case(&v.map(jval).unwrap_or_else(|| "?".to_string()))
}

fn named_region_relation(v: Option<&Value>) -> String {
    match v.map(jval).as_deref() {
        Some("wholly-within") => "wholly within".to_string(),
        Some(value) => dekebab(value),
        None => "?".to_string(),
    }
}

fn named_region_keywords(v: Option<&Value>) -> String {
    v.and_then(Value::as_array)
        .map(|values| values.iter().map(jval).collect::<Vec<_>>().join(" or "))
        .unwrap_or_else(|| "?".to_string())
}

fn named_region_prefix(m: &Map<String, Value>) -> String {
    let region_ref = m.get("region_ref").and_then(Value::as_object);
    let region = named_region_title(region_ref.and_then(|r| r.get("region_id")));
    let producer = m.get("producer").and_then(Value::as_object);
    let mut sentences = Vec::new();
    if let Some(entries) = producer
        .and_then(|p| p.get("baseline"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            let zone = entry
                .as_object()
                .and_then(|e| e.get("zone"))
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            if zone == "own-deployment-zone" {
                sentences.push(format!("Your deployment zone is always within {region}."));
            } else if zone != "?" {
                sentences.push(format!("{} is always within {region}.", title_case(&zone)));
            }
        }
    }
    let mut has_phase_extension = false;
    if let Some(entries) = producer
        .and_then(|p| p.get("phase_extensions"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            let zone = entry
                .as_object()
                .and_then(|e| e.get("zone"))
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            match zone.as_str() {
                "no-mans-land" => {
                    sentences.push(format!(
                        "At the start of each phase, No Man's Land is within {region} until the end of that phase if you control at least half of its objective markers."
                    ));
                    has_phase_extension = true;
                }
                "opponent-deployment-zone" => {
                    if has_phase_extension {
                        sentences.push(
                            "The same applies separately to your opponent's deployment zone."
                                .to_string(),
                        );
                    } else {
                        sentences.push(format!(
                            "At the start of each phase, your opponent's deployment zone is within {region} until the end of that phase if you control at least half of its objective markers."
                        ));
                    }
                    has_phase_extension = true;
                }
                "?" => {}
                _ => {
                    let label = title_case(&zone);
                    sentences.push(format!(
                        "At the start of each phase, {label} is within {region} until the end of that phase if you control at least half of its objective markers."
                    ));
                    has_phase_extension = true;
                }
            }
        }
    }
    let mut source_parts = Vec::new();
    if let Some(additions) = producer
        .and_then(|p| p.get("additive_extensions"))
        .and_then(Value::as_array)
    {
        for entry in additions {
            let addition = entry.as_object();
            let predicate = addition
                .and_then(|e| e.get("source_gate"))
                .and_then(Value::as_object)
                .and_then(|g| g.get("unit_predicate"))
                .and_then(Value::as_object);
            let Some(predicate) = predicate else {
                continue;
            };
            let faction = named_region_title(predicate.get("faction"));
            let keywords = named_region_keywords(predicate.get("keywords"));
            let radius = addition
                .and_then(|e| e.get("radius_inches"))
                .filter(|v| !v.is_null())
                .map(|v| format!(" within {}\"", jval(v)))
                .unwrap_or_default();
            let rendered = format!("{faction} units with {keywords}{radius}");
            if !source_parts.iter().any(|part| part == &rendered) {
                source_parts.push(rendered);
            }
        }
    }
    if !source_parts.is_empty() {
        sentences.push(format!(
            "Selected objective markers extend {region} around {}.",
            source_parts.join(" or ")
        ));
    }
    sentences.join(" ")
}

fn named_region_subject(m: &Map<String, Value>) -> String {
    let gate = m
        .get("consumer")
        .and_then(Value::as_object)
        .and_then(|c| c.get("beneficiary_gate"))
        .and_then(Value::as_object);
    let faction = gate
        .and_then(|g| g.get("faction"))
        .map(|v| title_case(&jval(v)))
        .unwrap_or_default();
    let faction_part = if faction.is_empty() {
        " from your army".to_string()
    } else {
        format!(" from your {faction} army")
    };
    format!(
        "Models in {} units{faction_part}",
        named_region_keywords(gate.and_then(|g| g.get("keywords")))
    )
}

fn named_region_effect(branch: &Map<String, Value>, qualified: bool, ctx: &Ctx) -> String {
    let effect_value = branch.get("effect");
    let effect_map = effect_value.and_then(Value::as_object);
    let modifier = effect_map
        .and_then(|effect| effect.get("modifier"))
        .and_then(Value::as_object);
    let roll = roll_name(modifier.and_then(|m| m.get("roll")).unwrap_or(&Value::Null));
    let mut text = match effect_map
        .and_then(|effect| effect.get("type"))
        .map(jval)
        .as_deref()
    {
        Some("re-roll") => {
            if modifier
                .and_then(|m| m.get("result_scope"))
                .map(jval)
                .as_deref()
                == Some("any-result")
            {
                format!("can re-roll the {roll} roll")
            } else if modifier.and_then(|m| m.get("subset")).map(jval).as_deref() == Some("ones") {
                format!("can re-roll {roll} rolls of 1")
            } else {
                format!("can re-roll {roll} rolls")
            }
        }
        Some("roll-modifier") if modifier.and_then(|m| m.get("value")).is_some() => {
            format!("gets {} to {roll}", signed(modifier.unwrap_or(&Map::new())))
        }
        _ => effect_value
            .cloned()
            .and_then(|value| serde_json::from_value::<EffectNode>(value).ok())
            .map(|effect| inline(&effect, ctx))
            .unwrap_or_else(|| "?".to_string()),
    };
    if let Some(keyword) = modifier.and_then(|m| m.get("weapon_keyword")) {
        text.push_str(&format!(
            " for {}{} attacks",
            if qualified { "those " } else { "" },
            jval(keyword)
        ));
    }
    text
}

fn named_region_branch(
    m: &Map<String, Value>,
    whole_unit: bool,
    qualified: bool,
    conditional: bool,
    ctx: &Ctx,
) -> String {
    let branch = m
        .get("consumer")
        .and_then(Value::as_object)
        .and_then(|c| {
            c.get(if qualified {
                "qualified_branch"
            } else {
                "default_branch"
            })
        })
        .and_then(Value::as_object);
    let Some(branch) = branch else {
        return "?".to_string();
    };
    let effect = named_region_effect(branch, qualified, ctx);
    if conditional {
        return format!("{} {effect}", named_region_subject(m));
    }
    if !qualified {
        return format!("{} {effect}.", named_region_subject(m));
    }
    let consumer = m.get("consumer").and_then(Value::as_object);
    let membership = consumer
        .and_then(|c| c.get("membership"))
        .and_then(Value::as_object);
    let relation = named_region_relation(membership.and_then(|m| m.get("relation")));
    let region = named_region_title(
        m.get("region_ref")
            .and_then(Value::as_object)
            .and_then(|r| r.get("region_id")),
    );
    let subject = if whole_unit {
        format!("If such a unit is {relation} {region}, those models")
    } else {
        format!("If such a model is {relation} {region}, it")
    };
    format!("{subject} {effect} instead")
}

fn describe_named_region_state(m: &Map<String, Value>, ctx: &Ctx) -> String {
    let whole_unit = m
        .get("consumer")
        .and_then(Value::as_object)
        .and_then(|c| c.get("membership"))
        .and_then(Value::as_object)
        .and_then(|membership| membership.get("unit_scope"))
        .map(jval)
        .as_deref()
        == Some("whole-unit");
    format!(
        "{} {} {}",
        named_region_prefix(m),
        named_region_branch(m, whole_unit, false, false, ctx),
        named_region_branch(m, whole_unit, true, false, ctx)
    )
}

fn describe_named_region_conditional(
    m: &Map<String, Value>,
    condition: &ConditionNode,
    ctx: &Ctx,
) -> String {
    let predicate = match condition {
        ConditionNode::SimpleCondition(s) if s.type_ == SimpleConditionType::RegionMembership => {
            super::region_membership_phrase(&s.parameters, false)
        }
        _ => super::describe_node(condition),
    };
    let negated = matches!(
        condition,
        ConditionNode::SimpleCondition(s)
            if s.type_ == SimpleConditionType::RegionMembership && s.negated
    );
    let whole_unit = m
        .get("consumer")
        .and_then(Value::as_object)
        .and_then(|c| c.get("membership"))
        .and_then(Value::as_object)
        .and_then(|membership| membership.get("unit_scope"))
        .map(jval)
        .as_deref()
        == Some("whole-unit");
    let default = named_region_branch(m, whole_unit, false, true, ctx);
    let qualified = named_region_branch(m, whole_unit, true, true, ctx);
    if negated {
        format!(
            "{} Unless {predicate}, {default}. If {predicate}, {qualified}.",
            named_region_prefix(m)
        )
    } else {
        format!(
            "{} When {predicate}, {qualified}. Otherwise, {default}.",
            named_region_prefix(m)
        )
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
        "ordered-retreat" => {
            // GW frames this lever by its effect on Desperate Escape tests: suppressing
            // Ordered Retreat forces the tests; granting it (e.g. while Battle-shocked)
            // exempts the unit. Mirrors the `desperate-escape` slug wording.
            if granted {
                format!(
                    "{subj} {} not affected by Desperate Escape tests",
                    agree(subj, "is")
                )
            } else {
                format!("{subj} must take Desperate Escape tests")
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

fn or_list(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} or {}", items[0], items[1]),
        n => format!("{} or {}", items[..n - 1].join(", "), items[n - 1]),
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
            "add {} to {}",
            dice_case(dist.unwrap_or(&Value::Null)),
            of_or_possessive(subj, "Advance rolls")
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
                        "{} is reduced by {}\"",
                        of_or_possessive(subj, "Move characteristic"),
                        fmt_num(n.abs())
                    );
                }
            }
            if let Some(mk) = &move_kinds {
                return format!(
                    "add{inches} to {}",
                    of_or_possessive(subj, &format!("{mk} moves"))
                );
            }
            format!("{subj} can make a Normal move{of_up_to}")
        }
    }
}

/// Generic aura `modifier` → one lowercase-initial clause. Mirrors `auraClause`.
fn keyword_filter_clause(filter: &KeywordFilter, noun: &str) -> String {
    let required = filter
        .required_keywords
        .iter()
        .map(|k| k.as_str())
        .collect::<Vec<_>>()
        .join(" and ");
    let excluded = filter
        .excluded_keywords
        .iter()
        .map(|k| k.as_str())
        .collect::<Vec<_>>()
        .join(" or ");
    format!(
        "{noun}{}{}",
        if required.is_empty() {
            String::new()
        } else {
            format!(" with {required}")
        },
        if excluded.is_empty() {
            String::new()
        } else {
            format!(" without {excluded}")
        }
    )
}

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
    let eligibility = aura_eligibility(m.eligible.as_ref());
    let who = if e.target == AuraEffectTarget::FriendlyWithinAura {
        format!("each friendly{eligibility} unit")
    } else {
        format!("each enemy{eligibility} unit")
    };
    let recipient = match &m.recipient_filter {
        Some(filter) => keyword_filter_clause(filter, &who),
        None => who,
    };
    let within = match &range_text {
        Some(rt) => format!("{recipient} within {rt}"),
        None => recipient,
    };
    let filtered = m.emitter_filter.is_some() || m.recipient_filter.is_some();
    let effect_text = match &m.effect {
        Some(inner) if filtered => {
            let nested = inline(inner, ctx);
            format!(
                ", and each such unit {}",
                nested
                    .strip_prefix("the unit")
                    .unwrap_or(&nested)
                    .trim_start()
            )
        }
        Some(inner) => {
            let recipient_ctx = Ctx {
                selected_unit: m.eligible.is_some(),
                ..*ctx
            };
            format!(" {}", inline(inner, &recipient_ctx))
        }
        None if filtered => ", and each such unit is affected".to_string(),
        None => " is affected".to_string(),
    };
    match &m.emitter_filter {
        Some(filter) => format!(
            "{} projects an aura to {within}{effect_text}",
            keyword_filter_clause(filter, "this model")
        ),
        None => format!("{within}{effect_text}"),
    }
}

/// Keyword constraints on an aura recipient, rendered as part of its noun phrase.
fn aura_eligibility(eligible: Option<&impl serde::Serialize>) -> String {
    let Some(eligible) = eligible else {
        return String::new();
    };
    let Ok(Value::Object(eligible)) = serde_json::to_value(eligible) else {
        return String::new();
    };
    let required = eligible
        .get("required_keywords")
        .and_then(Value::as_array)
        .map(|keywords| keywords.iter().map(jval).collect::<Vec<_>>().join(" "))
        .filter(|keywords| !keywords.is_empty())
        .map(|keywords| format!(" {keywords}"))
        .unwrap_or_default();
    let excluded = eligible
        .get("excluded_keywords")
        .and_then(Value::as_array)
        .map(|keywords| keywords.iter().map(jval).collect::<Vec<_>>().join(" "))
        .filter(|keywords| !keywords.is_empty())
        .map(|keywords| format!(" (excluding {keywords} units)"))
        .unwrap_or_default();
    format!("{required}{excluded}")
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
            let scope = if notnull(m, "weapon_type") {
                format!(" for {} weapons", jv(m, "weapon_type"))
            } else if truthy(m, "attack_type") {
                format!(" ({})", jv(m, "attack_type"))
            } else {
                String::new()
            };
            if !notnull(m, "stat") {
                return format!(
                    "modify {}{scope}",
                    of_or_possessive(&subj, "characteristics")
                );
            }
            if nstr(m, "operation") == Some("set") {
                return format!(
                    "modify {} to {}{scope}",
                    of_or_possessive(
                        &subj,
                        &format!(
                            "{} characteristic",
                            stat_name(m.get("stat").unwrap_or(&Value::Null))
                        )
                    ),
                    jv(m, "value")
                );
            }
            if nstr(m, "operation") == Some("improve") {
                return format!(
                    "improve {} by {}{scope}",
                    of_or_possessive(
                        &subj,
                        &format!(
                            "{} characteristic",
                            stat_name(m.get("stat").unwrap_or(&Value::Null))
                        )
                    ),
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
                "{verb} {} {prep} {}{scope}",
                jval(&val),
                of_or_possessive(
                    &subj,
                    &format!(
                        "{} characteristic",
                        stat_name(m.get("stat").unwrap_or(&Value::Null))
                    )
                )
            )
        }
        T::RollModifier => {
            let roll_value = first(m, &["roll", "test"]).unwrap_or(&Value::Null);
            let ctx_note = if truthy(m, "context") {
                format!(" ({})", jv(m, "context"))
            } else {
                String::new()
            };
            if notnull(m, "critical_on") {
                let crit = if jval(roll_value) == "wound" {
                    "Critical Wounds"
                } else {
                    "Critical Hits"
                };
                return format!(
                    "{subj} {} {crit} on {} rolls of {}+",
                    agree(&subj, "scores"),
                    roll_name(roll_value),
                    jv(m, "critical_on")
                );
            }
            if nstr(m, "operation") == Some("set") {
                return format!(
                    "{subj} can change {} rolls to a {}",
                    roll_name(roll_value),
                    jv(m, "value")
                );
            }
            if !notnull(m, "value") {
                format!(
                    "{} {}{ctx_note}",
                    dekebab(&jv(m, "operation")),
                    of_or_possessive(&subj, &format!("{} rolls", roll_name(roll_value)))
                )
            } else {
                format!(
                    "{subj} {} {} to {} rolls{ctx_note}",
                    agree(&subj, "gets"),
                    signed(m),
                    roll_name(roll_value)
                )
            }
        }
        T::ReRoll => {
            let which = if nstr(m, "roll") == Some("any") {
                if nstr(m, "subset") == Some("ones") {
                    "any roll of 1".to_string()
                } else {
                    "any roll".to_string()
                }
            } else {
                let noun = roll_name(m.get("roll").unwrap_or(&Value::Null));
                if nstr(m, "subset") == Some("ones") {
                    format!("a {noun} roll of 1")
                } else {
                    format!("the {noun} roll")
                }
            };
            // An attack_type scopes the re-roll to melee/ranged attacks (Black
            // Rage's melee hit re-rolls); weapon_type keeps its wording precedence.
            let weapon = if notnull(m, "weapon_type") {
                format!(" with {} weapons", jv(m, "weapon_type"))
            } else if notnull(m, "attack_type") && nstr(m, "attack_type") != Some("any") {
                format!(" for {} attacks", jv(m, "attack_type"))
            } else {
                String::new()
            };
            format!("you can re-roll {which}{weapon}")
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
            // Escalating table ("on a 2-3, 1 mortal wound; on a 4-5, D3 ..."): the
            // roll decides the amount, so render the rows, not "a number of".
            let table = m
                .get("amount_table")
                .or_else(|| m.get("table"))
                .and_then(|t| t.as_array());
            if let Some(rows) = table {
                if !rows.is_empty() {
                    let parts: Vec<String> = rows
                        .iter()
                        .enumerate()
                        .map(|(i, r)| {
                            let amt = dice_case(r.get("amount").unwrap_or(&Value::Null));
                            let noun = if amt == "1" {
                                "mortal wound"
                            } else {
                                "mortal wounds"
                            };
                            let roll = jval(r.get("roll").unwrap_or(&Value::Null));
                            if i == 0 {
                                format!("on a {roll}, {subj_mw} {verb} {amt} {noun}")
                            } else {
                                format!("on a {roll}, {amt} {noun}")
                            }
                        })
                        .collect();
                    let die = if notnull(m, "dice") {
                        dice_case(m.get("dice").unwrap_or(&Value::Null))
                    } else {
                        "D6".to_string()
                    };
                    return format!("roll one {die}: {}", parts.join("; "));
                }
            }
            let a: Option<String> = if notnull(m, "count") {
                Some(jv(m, "count"))
            } else if notnull(m, "amount") {
                Some(jv(m, "amount"))
            } else if notnull(m, "dice") {
                Some(dice_case(m.get("dice").unwrap_or(&Value::Null)))
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
            if notnull(m, "bind_count_as") {
                return format!("roll one {amt}: {subj_mw} {verb} that many mortal wounds");
            }
            let noun = if amt == "1" {
                "mortal wound"
            } else {
                "mortal wounds"
            };
            format!("{subj_mw} {verb} {amt} {noun}")
        }
        T::FeelNoPain => {
            let vs = match nstr(m, "scope") {
                Some("mortal") => " against mortal wounds",
                Some("psychic") => " against Psychic Attacks",
                Some("psychic-and-mortal") => " against Psychic Attacks and mortal wounds",
                _ => "",
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
                format!(
                    "{} gains {kw}",
                    of_or_possessive(&subj, &jv(m, "weapon_name"))
                )
            } else if notnull(m, "weapon_type") {
                format!(
                    "{} gain {kw}",
                    of_or_possessive(&subj, &format!("{} weapons", jv(m, "weapon_type")))
                )
            } else {
                format!("{} gain {kw}", of_or_possessive(&subj, "weapons"))
            }
        }
        T::AbilityGrant => {
            // Reserves-arrival grant slugs read as full clauses in GW voice — the
            // generic "gains the X ability" form would bury the mechanic in a name.
            let grant = first(m, &["grant_type", "ability_id"]);
            match grant.map(jval).as_deref() {
                Some("must-start-in-reserves") => {
                    return format!("{subj} must start the battle in Reserves");
                }
                Some("reinforcement-any-of-turns-1-to-3") => {
                    return format!(
                        "{subj} can be set up in the Reinforcements step of your first, second or third Movement phase, regardless of any mission rules"
                    );
                }
                Some("reserves-limit-exempt") => {
                    return format!(
                        "{subj} {} not counted towards any limits on the number of units that can start the battle in Reserves",
                        agree(&subj, "is")
                    );
                }
                Some("reserves-limit-exempt-with-cargo") => {
                    return format!(
                        "neither {subj} nor any units embarked within it are counted towards any limits on the number of units that can start the battle in Reserves"
                    );
                }
                Some("may-start-in-reserves") => {
                    return format!("{subj} can start the battle in Reserves");
                }
                Some("battle-round-plus-one-for-arrival") => {
                    return format!(
                        "{subj} {} the current battle round number as being one higher than it actually is when arriving from Reserves",
                        agree(&subj, "treats")
                    );
                }
                Some("flavor-text") => {
                    return "this ability is a descriptive note (no additional rules effect)"
                        .to_string();
                }
                Some("crew-tokens") => {
                    let n = first(m, &["count"])
                        .map(jval)
                        .unwrap_or_else(|| "1".to_string());
                    let token = if notnull(m, "token_name") {
                        format!("{} tokens", jv(m, "token_name"))
                    } else {
                        "Crew tokens".to_string()
                    };
                    let being = if pronoun(&subj) == "their" {
                        "they are"
                    } else {
                        "it is"
                    };
                    return format!(
                        "place {n} {token} next to {subj} when {being} first set up, removing one each time {subj} {} a wound (the model itself represents {} final wound)",
                        agree(&subj, "loses"),
                        pronoun(&subj)
                    );
                }
                _ => {}
            }
            let cap = if notnull(m, "capacity") {
                format!(" ({})", jv(m, "capacity"))
            } else {
                String::new()
            };
            // A grant's `timing` modifier scopes when the granted ability applies.
            let when = if notnull(m, "timing") {
                format!("{}, ", describe_timing(&jv(m, "timing")))
            } else {
                String::new()
            };
            match grant {
                Some(g) => format!(
                    "{when}{subj} {} the {} ability{cap}",
                    agree(&subj, "gains"),
                    grant_label(&jval(g))
                ),
                None => format!("{when}{subj} {} an ability{cap}", agree(&subj, "gains")),
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
            // `type: "wounds"` is a heal (regained wounds), not a revive.
            if nstr(m, "type") == Some("wounds") || notnull(m, "wounds") {
                // A bound scalar count (Matter Absorption-style): the healed
                // amount was already rolled and reported upstream by a
                // `bind_count_as` producer; refer to it instead of repeating
                // the dice expression.
                if notnull(m, "count_from") {
                    return format!(
                        "{subj} {} up to that many lost wounds",
                        agree(&subj, "regains")
                    );
                }
                let healed = first(m, &["wounds"]).map(dice_case).unwrap_or(count);
                let noun = if healed == "1" {
                    "lost wound"
                } else {
                    "lost wounds"
                };
                return format!("{subj} {} up to {healed} {noun}", agree(&subj, "regains"));
            }
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
        T::RecoveryPool => {
            let allocation = "first using them to regain lost wounds on wounded models and then using any remaining points to return destroyed models to the unit with 1 wound remaining, stopping when the unit is at full strength and all its models have their full wounds; any unallocated points are lost";
            if e.target == SingleEffectTarget::AllFriendly {
                format!(
                    "roll {} recovery points independently for each friendly unit, {allocation}",
                    dice_case(m.get("dice").unwrap_or(&Value::Null))
                )
            } else {
                format!(
                    "roll {} recovery points for the unit, {allocation}",
                    dice_case(m.get("dice").unwrap_or(&Value::Null))
                )
            }
        }
        T::ModelDestruction => {
            let count = first(m, &["count"])
                .map(dice_case)
                .unwrap_or_else(|| "1".to_string());
            let noun = if count == "1" { "model" } else { "models" };
            format!("destroy {count} {noun} in {subj}")
        }
        T::NamedRegionState => describe_named_region_state(m, ctx),
        T::RuleState => describe_rule_state(m, &subj),
        T::PoolAddDie => {
            let pool = m
                .get("pool_id")
                .map(pool_name)
                .unwrap_or_else(|| "?".to_string());
            let rolled = nstr(m, "value") == Some("rolled");
            if let Some(per_pool) = m.get("count_per_pool") {
                // One die per point currently in the counting pool (Icon of Khorne).
                let per = pool_name(per_pool);
                let per_plural = if per.ends_with('s') {
                    per.clone()
                } else {
                    format!("{per}s")
                };
                let die = if rolled {
                    "one rolled D6".to_string()
                } else {
                    let shown = match m.get("value") {
                        Some(Value::String(s)) if s == "highest" => {
                            "the highest result".to_string()
                        }
                        Some(v) => jval(v),
                        None => "?".to_string(),
                    };
                    format!("one die showing {shown}")
                };
                let tail = if m.get("consumes_pool").and_then(Value::as_bool) == Some(true) {
                    format!(", after which all your {per_plural} are lost")
                } else {
                    String::new()
                };
                return format!("add {die} to your {pool} for each {per} you have{tail}");
            }
            let cnt = m
                .get("count")
                .map(dice_case)
                .unwrap_or_else(|| "1".to_string());
            if rolled {
                let dice = if cnt == "1" {
                    "a rolled D6".to_string()
                } else {
                    format!("{cnt} rolled D6")
                };
                return format!("add {dice} to your {pool}");
            }
            let val = match m.get("value") {
                Some(Value::String(s)) if s == "highest" => "the highest result".to_string(),
                Some(v) => jval(v),
                None => "?".to_string(),
            };
            let dice = if cnt == "1" {
                "a die".to_string()
            } else {
                format!("{cnt} dice")
            };
            format!("add {dice} showing {val} to your {pool}")
        }
        T::ReplaceRollFromPool => {
            let rolls: Vec<String> = match m.get("rolls") {
                Some(Value::Array(a)) => a.iter().map(|r| dekebab(&jval(r))).collect(),
                _ => Vec::new(),
            };
            let pool = m
                .get("pool_id")
                .map(pool_name)
                .unwrap_or_else(|| "?".to_string());
            format!(
                "discard a die from your {pool} and substitute its value for a {} roll",
                or_list(&rolls)
            )
        }
        T::CpGain => {
            let amount = first(m, &["amount"])
                .map(jval)
                .unwrap_or_else(|| "1".to_string());
            format!("you gain {amount}CP")
        }
        T::CpOnDestroy => {
            let kw = if notnull(m, "enemy_keyword") {
                format!("{} model", jv(m, "enemy_keyword"))
            } else {
                "enemy model".to_string()
            };
            let who = if subj == "this model" {
                "this model's unit".to_string()
            } else {
                subj.clone()
            };
            let amount = first(m, &["amount"])
                .map(jval)
                .unwrap_or_else(|| "1".to_string());
            format!("each time {who} destroys a {kw}, you gain {amount}CP")
        }
        T::BattleShockTest => format!(
            "{subj} {} Battle-shock tests on {} instead of 2D6",
            agree(&subj, "takes"),
            dice_case(m.get("dice").unwrap_or(&Value::Null))
        ),
        T::Flyover => {
            let comp = nstr(m, "comparison").unwrap_or("gte");
            let hit = pool_threshold(comp, m.get("threshold"));
            let per = first(m, &["mortal_wounds"])
                .map(jval)
                .unwrap_or_else(|| "1".to_string());
            let per_noun = if per == "1" {
                "mortal wound"
            } else {
                "mortal wounds"
            };
            let die = dice_case(m.get("dice").unwrap_or(&Value::Null));
            format!(
                "each time this model ends a Normal move, select one enemy unit it moved over and roll {die}: for each {hit}, that unit suffers {per} {per_noun}"
            )
        }
        T::CpRefund => {
            let strat = if notnull(m, "stratagem") {
                format!("the {} Stratagem", title_case(&jv(m, "stratagem")))
            } else {
                "one Stratagem".to_string()
            };
            format!("you can use {strat} on {subj} for 0CP")
        }
        T::ModifierImmunity => match nstr(m, "scope") {
            Some("enemy-stratagems") => format!("{subj} cannot be affected by enemy Stratagems"),
            Some("enemy-abilities") => format!("{subj} cannot be affected by enemy abilities"),
            _ => {
                let exc = m
                    .get("exclude")
                    .and_then(Value::as_array)
                    .filter(|a| !a.is_empty())
                    .map(|a| {
                        let names: Vec<String> = a.iter().map(stat_name).collect();
                        format!(" (except {})", names.join(" and "))
                    })
                    .unwrap_or_default();
                format!(
                    "{subj} {} any modifiers to {} characteristics{exc}",
                    agree(&subj, "ignores"),
                    pronoun(&subj)
                )
            }
        },
        T::StratagemCostModifier => {
            let which = if notnull(m, "stratagem") {
                format!("the {} Stratagem", title_case(&jv(m, "stratagem")))
            } else {
                "Stratagems".to_string()
            };
            let whose = if nstr(m, "applies_to") == Some("stratagems-used-by-bearer") {
                format!("used by {subj}")
            } else {
                format!("that target {subj}")
            };
            let verb = if notnull(m, "stratagem") {
                "costs"
            } else {
                "cost"
            };
            let val = if nstr(m, "operation") == Some("set-to") {
                format!("{}CP", jv(m, "set_to"))
            } else {
                let amount = if notnull(m, "amount") {
                    jv(m, "amount")
                } else {
                    "1".to_string()
                };
                format!("{amount} more CP")
            };
            format!("{which} {whose} {verb} {val}")
        }
        T::TargetingPermission => {
            let at = if nstr(m, "attack_type") == Some("ranged") {
                "ranged attacks"
            } else {
                "attacks"
            };
            let r = if notnull(m, "range") {
                format!("{}\"", jv(m, "range"))
            } else {
                "?".to_string()
            };
            let gate = match nstr(m, "gate") {
                Some("within-range") => format!("the attacking unit is within {r}"),
                Some("closest-eligible") => "it is the closest eligible target".to_string(),
                Some("closest-or-within-range") => {
                    format!("it is the closest eligible target or the attacking unit is within {r}")
                }
                _ => dekebab(&jv(m, "gate")),
            };
            format!("{subj} can only be selected as the target of {at} if {gate}")
        }
        T::StratagemTargetingPermission => match nstr(m, "exception") {
            Some("battle-shocked") => {
                format!("{subj} can be targeted with Stratagems even while Battle-shocked")
            }
            _ => format!("{subj} can be targeted with Stratagems"),
        },
        T::ResourceGain => {
            if nstr(m, "count_mode") == Some("by-battle-size")
                || m.get("count_by_battle_size").is_some()
            {
                format!(
                    "you gain {} based on the current battle size (see the accompanying table)",
                    resource_noun(m, None)
                )
            } else {
                let amount = first(m, &["amount", "value"])
                    .map(jval)
                    .unwrap_or_else(|| "?".to_string());
                format!(
                    "you gain {amount} {}",
                    resource_noun(m, first(m, &["amount", "value"]))
                )
            }
        }
        T::ResourceSpend => {
            let amount = first(m, &["amount", "value"])
                .map(jval)
                .unwrap_or_else(|| "?".to_string());
            let base = format!(
                "spend {amount} {}",
                resource_noun(m, first(m, &["amount", "value"]))
            );
            match m.get("cap") {
                Some(Value::Object(cap))
                    if cap.get("count").is_some_and(|v| !v.is_null())
                        && cap.get("per").is_some_and(|v| !v.is_null()) =>
                {
                    format!(
                        "{base} (no more than {} per {})",
                        jv(cap, "count"),
                        jv(cap, "per")
                    )
                }
                _ => base,
            }
        }
        T::ResourceClear => {
            let scope = if nstr(m, "scope") == Some("all") {
                "all"
            } else {
                "all unspent"
            };
            format!("{scope} {} are lost", resource_noun(m, None))
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
                format!(
                    "modify {}",
                    of_or_possessive(&subj, "Leadership characteristic")
                )
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
        T::UnitKeywordGrant => {
            // Without a `to_keywords` filter the grant lands on the effect subject.
            if notnull(m, "to_keywords") {
                format!(
                    "{} units gain the {} keyword",
                    jv(m, "to_keywords"),
                    jv(m, "keyword")
                )
            } else {
                format!(
                    "{subj} {} the {} keyword",
                    agree(&subj, "gains"),
                    jv(m, "keyword")
                )
            }
        }
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
        T::FallbackAndAct => {
            let acts = if m.get("can_charge").and_then(Value::as_bool) == Some(true) {
                "shoot and declare a charge"
            } else {
                "shoot"
            };
            format!(
                "{subj} {} eligible to {acts} in a turn in which it Fell Back",
                agree(&subj, "is")
            )
        }
        T::FightEligibilityExtension => {
            let r = jv(m, "range");
            format!(
                "when determining which models in {subj} are eligible to fight, \
                 models within {r}\" of one or more enemy models are eligible \
                 and can target enemy units within {r}\""
            )
        }
        T::EngagementPassthrough => {
            let base = if truthy(m, "no_end_in_engagement") {
                format!("{subj} can move through enemy models, but cannot end that move within Engagement Range of any enemy unit")
            } else {
                format!("{subj} can move through enemy models")
            };
            match m.get("applies_to_moves") {
                Some(Value::Array(a)) if !a.is_empty() => {
                    let move_kinds =
                        and_list(&a.iter().map(|x| move_noun(&jval(x))).collect::<Vec<_>>());
                    format!("{base}, during its {move_kinds} moves")
                }
                _ => base,
            }
        }
        T::AttackRestriction => describe_attack_restriction(m, &subj),
        T::ObjectiveControlModifier => {
            if truthy(m, "sticky") {
                format!("{subj} {} control of objective markers even after no models remain in range, until the enemy retakes them (sticky objectives)", agree(&subj, "retains"))
            } else if nstr(m, "operation") == Some("halve") {
                format!("halve the Objective Control characteristic of {subj}")
            } else if nstr(m, "operation") == Some("set") {
                // An absolute set (Black Rage's OC 0) mirrors stat-modifier's wording.
                format!(
                    "modify {} to {}",
                    of_or_possessive(&subj, "Objective Control characteristic"),
                    jv(m, "value")
                )
            } else if notnull(m, "operation") {
                format!(
                    "{subj} {} {} to {} Objective Control characteristic",
                    agree(&subj, "gets"),
                    signed(m),
                    pronoun(&subj)
                )
            } else {
                format!(
                    "modify {}",
                    of_or_possessive(&subj, "Objective Control characteristic")
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
            if notnull(m, "tag") {
                format!("the terrain area is marked as {}", dekebab(&jv(m, "tag")))
            } else {
                "the terrain area is marked".to_string()
            }
        }
        T::ObjectiveTag => {
            if notnull(m, "tag") {
                format!("the objective is marked as {}", dekebab(&jv(m, "tag")))
            } else {
                "the objective is marked".to_string()
            }
        }
        T::UnitTag => {
            if notnull(m, "tag") {
                format!(
                    "{subj} {} marked as {}",
                    agree(&subj, "is"),
                    dekebab(&jv(m, "tag"))
                )
            } else {
                format!("{subj} {} marked", agree(&subj, "is"))
            }
        }
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
                        format!(
                            "{} automatically succeed",
                            of_or_possessive(&subj, &format!("{roll} rolls"))
                        )
                    }
                    Some("fail") => {
                        format!(
                            "{} automatically fail",
                            of_or_possessive(&subj, &format!("{roll} rolls"))
                        )
                    }
                    _ => format!(
                        "{} count as {}",
                        of_or_possessive(&subj, &format!("{roll} rolls")),
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
        T::DisembarkAfterMove => {
            if !notnull(m, "after") {
                format!("units can disembark from {subj} after it has moved")
            } else {
                let who = if notnull(m, "requires_keyword") {
                    format!(
                        "units with the {} ability",
                        title_case(&jv(m, "requires_keyword"))
                    )
                } else {
                    "units".to_string()
                };
                let when = match nstr(m, "after") {
                    Some("advance") => "after it has Advanced",
                    Some("deployment") => "after it has been set up on the battlefield",
                    Some("before-move") => "before it moves",
                    _ => "after it has made a Normal move",
                };
                // `mandatory`: a Reserves-transport whose cargo MUST disembark on arrival.
                let verb = if truthy(m, "mandatory") {
                    "must immediately disembark"
                } else {
                    "can disembark"
                };
                let away = if notnull(m, "min_enemy_distance") {
                    format!(
                        ", and must be set up more than {}\" away from all enemy models",
                        jv(m, "min_enemy_distance")
                    )
                } else {
                    String::new()
                };
                let counts = if truthy(m, "counts_as_normal_move") {
                    "; such units count as having made a Normal move"
                } else {
                    ""
                };
                // A deployment-step disembark has no meaningful charge window; only
                // an explicit `can_charge` renders the charge tail there.
                let charge = if truthy(m, "can_charge") {
                    ", and are still eligible to declare a charge this turn"
                } else if nstr(m, "after") == Some("deployment") && !notnull(m, "can_charge") {
                    ""
                } else {
                    ", but cannot declare a charge this turn"
                };
                format!("{who} {verb} from {subj} {when}{away}{counts}{charge}")
            }
        }
        T::Disembark => {
            let where_ = if notnull(m, "distance") {
                format!(
                    " and be set up wholly within {}\" of the transport",
                    jv(m, "distance")
                )
            } else {
                String::new()
            };
            let eng = if truthy(m, "allow_engagement_range") {
                ", even within Engagement Range of enemy units"
            } else {
                ""
            };
            format!("{subj} can disembark{where_}{eng}")
        }
        T::UnitAttachment => {
            if truthy(m, "mandatory") {
                format!("{subj} must be attached to a Leader, or it counts as destroyed")
            } else {
                let led = if notnull(m, "led_by") {
                    format!(" led by a {} model", title_case(&jv(m, "led_by")))
                } else {
                    String::new()
                };
                format!(
                    "at the start of the Declare Battle Formations step, {subj} can join one friendly unit{led}, becoming part of that Bodyguard unit"
                )
            }
        }
    }
}
fn describe_menu_trigger(t: &ResourceActionMenuTrigger) -> String {
    let mut s = event_clause(&t.event.to_string());
    if t.event.to_string() == "falls-back"
        && t.subject == Some(ResourceActionMenuTriggerSubject::EnemyUnit)
    {
        s = "an enemy unit Falls Back".to_string();
    }
    if !t.move_types.is_empty() {
        let kinds = or_list(
            &t.move_types
                .iter()
                .map(|mt| match mt {
                    ResourceActionMenuTriggerMoveTypesItem::FallBack => "Fall Back".to_string(),
                    other => cap_word(&other.to_string()),
                })
                .collect::<Vec<_>>(),
        );
        s = replace_first_word(&s, "move", &format!("{kinds} move"));
    }
    if let Some(prox) = &t.proximity {
        let of = match prox.of {
            Some(ResourceActionMenuTriggerProximityOf::AttachedUnit) => "the unit this model leads",
            Some(ResourceActionMenuTriggerProximityOf::Self_)
            | Some(ResourceActionMenuTriggerProximityOf::Bearer) => "this model",
            None => "this unit",
        };
        s.push_str(&format!(" within {}\" of {of}", fmt_num(prox.range)));
    }
    if let Some(cond) = &t.condition {
        s.push_str(&format!(", if {}", describe_node(&cond.0)));
    }
    s
}

fn normalize_menu_triggers(
    when: &ResourceActionMenuEffectActionsItemWhen,
) -> Vec<&ResourceActionMenuTrigger> {
    match when {
        ResourceActionMenuEffectActionsItemWhen::ResourceActionMenuTrigger(t) => vec![t],
        ResourceActionMenuEffectActionsItemWhen::Array(ts) => ts.iter().collect(),
    }
}

fn menu_action_subject(
    eligibility: Option<&crate::generated::ResourceActionMenuEffectActionsItemEligibility>,
) -> String {
    let Some(eligibility) = eligibility else {
        return "the unit".to_string();
    };
    if !eligibility.excludes_keyword.is_empty() {
        return format!(
            "one friendly non-{} unit",
            eligibility.excludes_keyword.join("/")
        );
    }
    if !eligibility.requires_keyword.is_empty() {
        return format!("a friendly {} unit", eligibility.requires_keyword.join(" "));
    }
    "the unit".to_string()
}

fn menu_action_eligibility_clause(
    eligibility: Option<&crate::generated::ResourceActionMenuEffectActionsItemEligibility>,
) -> String {
    let Some(eligibility) = eligibility else {
        return String::new();
    };
    let has_keyword_gate =
        !eligibility.requires_keyword.is_empty() || !eligibility.excludes_keyword.is_empty();
    if !has_keyword_gate && eligibility.requires.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    if has_keyword_gate {
        parts.push(format!(
            "only usable by {}",
            menu_action_subject(Some(eligibility))
        ));
    }
    if !eligibility.requires.is_empty() {
        parts.push(
            eligibility
                .requires
                .iter()
                .map(|c| describe_node(&c.0))
                .collect::<Vec<_>>()
                .join(" and "),
        );
    }
    format!(" ({})", parts.join(", "))
}

fn menu_resource_noun(cost: &crate::generated::ResourceActionMenuEffectActionsItemCost) -> String {
    let pool = pool_name(&Value::String(cost.pool_id.as_str().to_string()));
    match &cost.resource_label {
        Some(label) if cost.amount.get() == 1 => label.as_str().to_string(),
        Some(label) => format!("{}s", label.as_str()),
        None => pool,
    }
}

fn describe_menu_action(a: &ResourceActionMenuEffectActionsItem, ctx: &Ctx) -> String {
    let label = a.label.as_str();
    let trig = normalize_menu_triggers(&a.when)
        .iter()
        .map(|t| describe_menu_trigger(t))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" or ");
    let cost = format!("spend {} {}", a.cost.amount, menu_resource_noun(&a.cost));
    let duration = match a.duration {
        Some(ResourceActionMenuEffectActionsItemDuration::UntilEndOfPhase) => {
            "until the end of the phase"
        }
        Some(ResourceActionMenuEffectActionsItemDuration::UntilEndOfTurn) => {
            "until the end of the turn"
        }
        _ => "",
    };
    let usage = if a
        .usage
        .as_ref()
        .and_then(|u| u.repeatable_if_different_unit)
        .unwrap_or(false)
    {
        " (may be triggered more than once per phase if a different unit performs it each time)"
    } else {
        ""
    };
    let mut parts = vec![
        format!(
            "{trig}{}",
            menu_action_eligibility_clause(a.eligibility.as_ref())
        ),
        cost,
        inline(&a.effect, ctx),
    ];
    if !duration.is_empty() {
        parts.push(duration.to_string());
    }
    format!("{label}: {}{usage}.", parts.join(", "))
}

fn shared_usage_clause(shared: Option<&ResourceActionMenuEffectSharedUsage>) -> String {
    let Some(shared) = shared else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(max) = shared.unit_max_manoeuvres_per_phase {
        parts.push(if max.get() == 1 {
            "a unit may perform at most one action per phase".to_string()
        } else {
            format!("a unit may perform at most {} actions per phase", max)
        });
    }
    if let Some(max) = shared.default_manoeuvre_max_per_phase {
        parts.push(if max.get() == 1 {
            "unless stated otherwise, a given action may be triggered once per phase".to_string()
        } else {
            format!(
                "unless stated otherwise, a given action may be triggered up to {} times per phase",
                max
            )
        });
    }
    parts.join("; ")
}

fn describe_menu_inline(e: &ResourceActionMenuEffect, ctx: &Ctx) -> String {
    format!(
        "actions may be performed when their conditions are met: {}",
        e.actions
            .iter()
            .map(|a| describe_menu_action(a, ctx))
            .collect::<Vec<_>>()
            .join(" / ")
    )
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
            if let EffectNode::SingleEffect(s) = c.effect.as_ref() {
                if s.type_ == SingleEffectType::NamedRegionState {
                    return describe_named_region_conditional(&s.modifier, &c.condition.0, ctx);
                }
            }
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
            let prompt = c
                .choice_prompt
                .as_deref()
                .map(|prompt| prompt.to_string())
                .unwrap_or_else(|| {
                    let label = c
                        .choice_label
                        .as_deref()
                        .map(|l| format!(" ({})", title_case(l)))
                        .unwrap_or_default();
                    format!("select one of the following{label}")
                });
            format!(
                "{prompt}: {}",
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
        EffectNode::SelectUnitsEffect(s) => {
            let inner_ctx = Ctx {
                selected_unit: true,
                ..*ctx
            };
            select_units_inline(&s.selector, &s.effect, &inner_ctx)
        }
        EffectNode::LeaderModelAbilityGrantEffect(p) => leader_model_ability_grant_clause(p, ctx),
        EffectNode::PersistentDesignationEffect(p) => {
            if !persistent_designation_supported(p) {
                return "[persistent-designation]".to_string();
            }
            format!(
                "{} {}, {}",
                persistent_designation_lead(p),
                persistent_designation_when(p),
                inline(&p.consumer.effect, ctx)
            )
        }
        EffectNode::ForEachUnitEffect(f) => {
            let inner_ctx = Ctx {
                selected_unit: true,
                ..*ctx
            };
            format!(
                "for each {}: {}",
                for_each_unit_subject(&f.selector),
                inline(&f.effect, &inner_ctx)
            )
        }
        EffectNode::DesignateTargetEffect(d) => {
            let scope_noun = match d.select.scope {
                DesignateTargetEffectSelectScope::FriendlyUnit => "friendly",
                DesignateTargetEffectSelectScope::EnemyUnit => "enemy",
            };
            let desig = if d.designation.as_str().is_empty() {
                String::new()
            } else {
                designation_label(d.designation.as_str())
            };
            let select_lead = match &d.select.timing {
                Some(t) => format!("{}, select", describe_timing(t)),
                None => "select".to_string(),
            };
            let dur = d.duration.map(|x| x.to_string()).unwrap_or_default();
            let (_, dur_trail) = duration_clauses(&dur);
            let when = match d.applies.to {
                DesignateTargetEffectAppliesTo::Target => "while it is your target",
                DesignateTargetEffectAppliesTo::AttackersOfTarget => {
                    "each time a friendly unit attacks it"
                }
            };
            let when_clause = if dur_trail.is_empty() {
                when.to_string()
            } else {
                format!("{dur_trail}, {when}")
            };
            format!(
                "{select_lead} one {scope_noun} unit{desig}; {when_clause}, {}",
                inline(&d.applies.effect, ctx)
            )
        }
        EffectNode::StanceSelectEffect(s) => {
            let opts = s
                .options
                .iter()
                .map(|o| format!("{} ({})", o.name.as_str(), inline(&o.effect, ctx)))
                .collect::<Vec<_>>()
                .join(" / ");
            format!("select one: {opts}")
        }
        EffectNode::RiskRewardEffect(r) => format!(
            "take a {} test (on a failure, {}), then {}",
            test_name(&Value::String(r.risk.test.to_string())),
            inline(&r.risk.on_fail, ctx),
            inline(&r.reward, ctx)
        ),
        EffectNode::IssueOrdersEffect(i) => {
            let names = i
                .options
                .iter()
                .map(|o| o.name.as_str().to_string())
                .collect::<Vec<_>>()
                .join(" / ");
            format!("issue Orders, each one of: {names}")
        }
        EffectNode::ResourceActionMenuEffect(e) => describe_menu_inline(e, ctx),
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
/// Render count and bearer-relative candidate gates for `select-units`.
fn selector_map(sel: &SelectUnitsEffectSelector) -> Map<String, Value> {
    serde_json::to_value(sel)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn select_units_subject(sel: &SelectUnitsEffectSelector) -> String {
    let value = selector_map(sel);
    let exact = value.get("count").and_then(Value::as_u64);
    let min = value.get("min_count").and_then(Value::as_u64);
    let max = value.get("max_count").and_then(Value::as_u64).or(exact);
    let count = exact.or(max).unwrap_or(0);
    let bounded = min.is_some() && exact.is_none() && min != max;
    let quantity = if exact.is_some() {
        if count == 1 {
            "one".to_string()
        } else {
            count.to_string()
        }
    } else if bounded {
        format!("from {} through {}", min.unwrap_or(0), max.unwrap_or(0))
    } else if min.is_some() && min == max {
        if count == 1 {
            "one".to_string()
        } else {
            count.to_string()
        }
    } else {
        format!("up to {count}")
    };
    let owner = value
        .get("owner")
        .map(jval)
        .unwrap_or_else(|| "?".to_string());
    let keywords = value
        .get("keywords")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(jval)
                .map(|keyword| title_case(&keyword))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let keywords = if keywords.is_empty() {
        String::new()
    } else {
        format!(" {keywords}")
    };
    let noun = if count == 1 { "unit" } else { "units" };
    let inclusive = if bounded { ", inclusive" } else { "" };
    let within = if let Some(range) = value.get("within_inches").and_then(Value::as_f64) {
        format!(" within {}\"", fmt_num(range))
    } else if let Some(range) = value.get("range_inches").and_then(Value::as_f64) {
        format!(" within {} inches of the bearer", fmt_num(range))
    } else {
        String::new()
    };
    let visible = if value.get("visibility_required").and_then(Value::as_bool) == Some(true) {
        " visible to the bearer"
    } else {
        ""
    };
    let eligibility = value
        .get("eligibility")
        .and_then(|raw| serde_json::from_value::<Condition>(raw.clone()).ok())
        .map(|condition| format!(" that {}", selection_eligibility(&condition)))
        .unwrap_or_default();
    format!("{quantity} {owner}{keywords} {noun}{inclusive}{within}{visible}{eligibility}")
}

fn select_units_engagement(sel: &SelectUnitsEffectSelector) -> &'static str {
    match selector_map(sel)
        .get("engagement_relation")
        .and_then(Value::as_str)
    {
        Some("engaged-with-bearer") => {
            "For each selected unit, it must be engaged with the bearer."
        }
        Some("not-engaged-with-bearer") => {
            "For each selected unit, it must not be engaged with the bearer."
        }
        _ => "",
    }
}

fn selected_recipient(mut text: String, sel: &SelectUnitsEffectSelector) -> String {
    let value = selector_map(sel);
    let count = value
        .get("count")
        .or_else(|| value.get("max_count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let recipient = if count > 1 {
        "each selected unit"
    } else {
        "the selected unit"
    };
    text = text.replace("The unit's", "Each selected unit's");
    text = text.replace("the unit's", &format!("{recipient}'s"));
    text = text.replace("The unit", "Each selected unit");
    text.replace("the unit", recipient)
}

fn select_units_inline(sel: &SelectUnitsEffectSelector, effect: &EffectNode, ctx: &Ctx) -> String {
    let nested = selected_recipient(inline(effect, ctx), sel);
    let engagement = select_units_engagement(sel);
    if engagement.is_empty() {
        format!("select {}: {nested}", select_units_subject(sel))
    } else {
        format!(
            "select {}. {engagement} {}",
            select_units_subject(sel),
            capitalize(&nested)
        )
    }
}

fn selection_eligibility(condition: &Condition) -> String {
    if matches!(
        &condition.0,
        ConditionNode::SimpleCondition(simple)
            if !simple.negated && simple.type_ == SimpleConditionType::IsBattleShocked
    ) {
        return "is Battle-shocked".to_string();
    }
    let predicate = describe_node(&condition.0);
    predicate
        .strip_prefix("the unit ")
        .unwrap_or(&predicate)
        .to_string()
}

/// "each enemy unit within 6\"" — the `for-each-unit` selector phrase.
fn for_each_unit_subject(selector: &impl serde::Serialize) -> String {
    let selector = serde_json::to_value(selector).unwrap_or(Value::Null);
    let owner = selector
        .get("owner")
        .map(jval)
        .unwrap_or_else(|| "?".to_string());
    let within = selector
        .get("within_inches")
        .map(|range| format!(" within {}\"", jval(range)))
        .unwrap_or_default();
    format!("{owner} unit{within}")
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

/// Render a dice-pool option requirement as a noun phrase: `pair of 4+`, or, for
/// an `any_of` set (a blessing that triggers on a double of X OR a triple of Y —
/// World Eaters Blessings of Khorne), the alternatives joined with " or ":
/// `pair of 6+ or triple of 3+`. The single-requirement output is byte-identical
/// to the pre-`any_of` phrasing (no leading article) so existing goldens don't
/// move. Mirror of `describeRequirement` in `tools/src/translate/effect.ts`; the
/// requirement is read structurally (via its serialized JSON) so the shape is
/// `{type,min_value}` or `{any_of:[{type,min_value},...]}`.
fn describe_requirement(req: &Value) -> String {
    fn one(r: &Value) -> String {
        let m = r.as_object();
        let type_ = m
            .and_then(|m| m.get("type"))
            .map(jval)
            .unwrap_or_else(|| "?".to_string());
        let min_value = m
            .and_then(|m| m.get("min_value"))
            .map(jval)
            .unwrap_or_else(|| "?".to_string());
        format!("{type_} of {min_value}+")
    }
    match req.get("any_of") {
        Some(Value::Array(arr)) => arr.iter().map(one).collect::<Vec<_>>().join(" or "),
        _ => one(req),
    }
}

/// Serialize an option requirement to JSON so `describe_requirement` can read it
/// structurally (single `{type,min_value}` or `{any_of:[...]}`), matching the way
/// the TS oracle treats its free-form requirement value.
fn requirement_value(req: &DiceRequirementSpec) -> Value {
    serde_json::to_value(req).unwrap_or(Value::Null)
}

fn dice_pool_options_inline(d: &DicePoolAllocationEffect, ctx: &Ctx) -> String {
    d.options
        .iter()
        .map(|o| {
            format!(
                "{} (requires {}): {}",
                o.name,
                describe_requirement(&requirement_value(&o.requirement)),
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
            | EffectNode::ForEachUnitEffect(_)
            | EffectNode::DesignateTargetEffect(_)
            | EffectNode::PersistentDesignationEffect(_)
            | EffectNode::LeaderModelAbilityGrantEffect(_)
            | EffectNode::StanceSelectEffect(_)
            | EffectNode::RiskRewardEffect(_)
            | EffectNode::IssueOrdersEffect(_)
            | EffectNode::ResourceActionMenuEffect(_)
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
            if let EffectNode::SingleEffect(s) = inner {
                if s.type_ == SingleEffectType::NamedRegionState {
                    let text = capitalize(&describe_named_region_conditional(
                        &s.modifier,
                        &c.condition.0,
                        ctx,
                    ));
                    if text.ends_with('.') {
                        return format!("{indent}{arrow}{text}");
                    }
                    return format!("{indent}{arrow}{text}.");
                }
            }
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
            let prompt = c
                .choice_prompt
                .as_deref()
                .map(|prompt| prompt.to_string())
                .unwrap_or_else(|| {
                    let label = c
                        .choice_label
                        .as_deref()
                        .map(|l| format!(" ({})", title_case(l)))
                        .unwrap_or_default();
                    format!("select one of the following{label}")
                });
            let options = c
                .options
                .iter()
                .map(|o| format!("{indent}  - {}.", capitalize(&inline(o, ctx))))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{indent}{}:\n{options}", capitalize(&prompt))
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
                "{indent}{arrow}Roll {}{}; allocate dice to activate up to {} of the following:",
                d.pool.count, d.pool.die, d.max_activations
            )];
            for opt in &d.options {
                lines.push(format!(
                    "{indent}  - {} (requires {}): {}.",
                    opt.name,
                    describe_requirement(&requirement_value(&opt.requirement)),
                    inline(&opt.effect, ctx)
                ));
            }
            lines.join("\n")
        }
        EffectNode::SelectUnitsEffect(s) => {
            let inner = &*s.effect;
            let inner_ctx = Ctx {
                selected_unit: true,
                ..*ctx
            };
            let engagement = select_units_engagement(&s.selector);
            let lead = format!("Select {}", select_units_subject(&s.selector));
            let header = if engagement.is_empty() {
                format!("{indent}{arrow}{lead}")
            } else {
                format!("{indent}{arrow}{lead}. {engagement}")
            };
            if is_container(inner) {
                let selector = selector_map(&s.selector);
                let count = selector
                    .get("count")
                    .or_else(|| selector.get("max_count"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if count > 1 {
                    format!(
                        "{header}:\n{indent}  -> For each selected unit:\n{}",
                        block(inner, depth + 2, &inner_ctx)
                    )
                } else {
                    format!("{header}:\n{}", block(inner, depth + 1, &inner_ctx))
                }
            } else {
                let nested = selected_recipient(inline(inner, &inner_ctx), &s.selector);
                if engagement.is_empty() {
                    format!("{header}: {nested}.")
                } else {
                    format!("{header} {}.", capitalize(&nested))
                }
            }
        }
        EffectNode::LeaderModelAbilityGrantEffect(p) => {
            format!(
                "{indent}{arrow}{}.",
                capitalize(&leader_model_ability_grant_clause(p, ctx))
            )
        }
        EffectNode::PersistentDesignationEffect(p) => {
            if !persistent_designation_supported(p) {
                return format!("{indent}{arrow}[persistent-designation].");
            }
            let inner = &*p.consumer.effect;
            let head = format!(
                "{indent}{arrow}{} {}",
                capitalize(&persistent_designation_lead(p)),
                persistent_designation_when(p)
            );
            if is_container(inner) {
                format!("{head}:\n{}", block(inner, depth + 1, ctx))
            } else {
                format!("{head}, {}.", inline(inner, ctx))
            }
        }
        EffectNode::ForEachUnitEffect(f) => {
            let inner = &*f.effect;
            let inner_ctx = Ctx {
                selected_unit: true,
                ..*ctx
            };
            let lead = format!("For each {}", for_each_unit_subject(&f.selector));
            if is_container(inner) {
                format!("{indent}{lead}:\n{}", block(inner, depth + 1, &inner_ctx))
            } else {
                format!(
                    "{indent}{lead}: {}.",
                    capitalize(&inline(inner, &inner_ctx))
                )
            }
        }
        EffectNode::DesignateTargetEffect(d) => {
            let scope_noun = match d.select.scope {
                DesignateTargetEffectSelectScope::FriendlyUnit => "friendly",
                DesignateTargetEffectSelectScope::EnemyUnit => "enemy",
            };
            let desig = if d.designation.as_str().is_empty() {
                String::new()
            } else {
                designation_label(d.designation.as_str())
            };
            // The mark's timing and duration are content: "After this unit shoots,
            // select …. Until your next Command phase, each time …".
            let select_lead = match &d.select.timing {
                Some(t) => format!("{}, select", capitalize(&describe_timing(t))),
                None => "Select".to_string(),
            };
            let dur = d.duration.map(|x| x.to_string()).unwrap_or_default();
            let (_, dur_trail) = duration_clauses(&dur);
            let when = match d.applies.to {
                DesignateTargetEffectAppliesTo::Target => "while it is your target",
                DesignateTargetEffectAppliesTo::AttackersOfTarget => {
                    "each time a friendly unit makes an attack against it"
                }
            };
            let when_clause = if dur_trail.is_empty() {
                capitalize(when)
            } else {
                format!("{}, {when}", capitalize(&dur_trail))
            };
            let inner = &*d.applies.effect;
            let head =
                format!("{indent}{arrow}{select_lead} one {scope_noun} unit{desig}. {when_clause}");
            if is_container(inner) {
                format!("{head}:\n{}", block(inner, depth + 1, ctx))
            } else {
                format!("{head}, {}.", inline(inner, ctx))
            }
        }
        EffectNode::StanceSelectEffect(s) => {
            let when = match &s.select {
                Some(sel) => capitalize(&event_clause(sel)),
                None => "At the start of your turn".to_string(),
            };
            let consum = match s.mode {
                StanceSelectEffectMode::Consumable => " (each may be chosen once per battle)",
                StanceSelectEffectMode::ReSelectable => "",
            };
            let mut lines = vec![format!("{indent}{arrow}{when}, select one{consum}:")];
            for opt in &s.options {
                lines.push(format!(
                    "{indent}  - {}: {}.",
                    opt.name.as_str(),
                    inline(&opt.effect, ctx)
                ));
            }
            lines.join("\n")
        }
        EffectNode::RiskRewardEffect(r) => {
            let on_fail = inline(&r.risk.on_fail, ctx);
            let reward = inline(&r.reward, ctx);
            format!(
                "{indent}{arrow}First take a {} test \u{2014} on a failure, {on_fail}; then {reward}.",
                test_name(&Value::String(r.risk.test.to_string()))
            )
        }
        EffectNode::IssueOrdersEffect(i) => {
            let n = match &i.count {
                Some(c) => c.get().to_string(),
                None => "one or more".to_string(),
            };
            let rng = match i.range {
                Some(r) => format!(" within {}\"", fmt_num(r)),
                None => String::new(),
            };
            let elig = match i.eligible.as_ref().and_then(|e| e.keyword.as_ref()) {
                Some(k) => format!(" {}", k.as_str()),
                None => String::new(),
            };
            let mut lines = vec![format!(
                "{indent}{arrow}Issue up to {n} Orders to eligible friendly{elig} units{rng}, each one of:"
            )];
            for opt in &i.options {
                lines.push(format!(
                    "{indent}  - {}: {}.",
                    opt.name.as_str(),
                    inline(&opt.effect, ctx)
                ));
            }
            lines.join("\n")
        }
        EffectNode::ResourceActionMenuEffect(e) => {
            let su = shared_usage_clause(e.shared_usage.as_ref());
            let intro = if su.is_empty() {
                "Actions may be performed when their conditions are met".to_string()
            } else {
                format!(
                    "Actions may be performed when their conditions are met. {}",
                    capitalize(&su)
                )
            };
            let mut lines = vec![format!("{indent}{arrow}{intro}:")];
            for action in &e.actions {
                lines.push(format!("{indent}  - {}", describe_menu_action(action, ctx)));
            }
            lines.join("\n")
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

/// Is `b` a JS regex `\w` character (used for the `\bmove\b` word boundary)?
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Replace the first whole-word occurrence of `word` in `haystack` with
/// `replacement` — the Rust equivalent of JS `s.replace(/\bword\b/, replacement)`
/// (single replacement, ASCII word boundaries).
fn replace_first_word(haystack: &str, word: &str, replacement: &str) -> String {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(word) {
        let start = from + rel;
        let end = start + word.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return format!("{}{}{}", &haystack[..start], replacement, &haystack[end..]);
        }
        from = start + 1;
    }
    haystack.to_string()
}
fn is_end_of_phase_disembark_battle_shock(t: &Trigger) -> bool {
    if t.event.to_string() != "end-of-phase" {
        return false;
    }
    let Some(condition) = &t.condition else {
        return false;
    };
    let ConditionNode::CompoundCondition(compound) = &condition.0 else {
        return false;
    };
    if compound.operator != CompoundConditionOperator::And || compound.operands.len() != 2 {
        return false;
    }
    matches!(
        (&compound.operands[0], &compound.operands[1]),
        (
            ConditionNode::SimpleCondition(first),
            ConditionNode::SimpleCondition(second),
        ) if !first.negated
            && !second.negated
            && first.type_ == SimpleConditionType::DisembarkedFromTransport
            && second.type_ == SimpleConditionType::IsBattleShocked
    )
}

/// Reactive-trigger opener ("an enemy unit ends a move within 9" of this model,
/// if ..."). Mirrors `describeTrigger` for ability `trigger` blocks.
fn describe_ability_trigger(t: &Trigger) -> String {
    let mut s = event_clause(&t.event.to_string());
    if t.event.to_string() == "falls-back" && t.subject == Some(TriggerSubject::EnemyUnit) {
        s = "an enemy unit Falls Back".to_string();
    }
    // Narrow a move event to its move kinds: "ends a move" → "ends a Normal,
    // Advance or Fall Back move".
    if !t.move_types.is_empty() {
        let kinds = or_list(
            &t.move_types
                .iter()
                .map(|mt| match mt {
                    TriggerMoveTypesItem::FallBack => "Fall Back".to_string(),
                    other => cap_word(&other.to_string()),
                })
                .collect::<Vec<_>>(),
        );
        s = replace_first_word(&s, "move", &format!("{kinds} move"));
    }
    if let Some(prox) = &t.proximity {
        let of = match prox.of {
            Some(TriggerProximityOf::AttachedUnit) => "the unit this model leads",
            Some(TriggerProximityOf::Self_) | Some(TriggerProximityOf::Bearer) => "this model",
            None => "this unit",
        };
        s.push_str(&format!(" within {}\" of {of}", fmt_num(prox.range)));
    }
    if is_end_of_phase_disembark_battle_shock(t) {
        s.push_str(", if the unit disembarked from a Transport this turn and is Battle-shocked");
    } else if let Some(cond) = &t.condition {
        s.push_str(&format!(", if {}", describe_node(&cond.0)));
    }
    s
}

/// Flatten the polymorphic `trigger` field to a list (empty when absent).
/// Mirrors `normalizeTriggers`.
fn normalize_triggers(trigger: Option<&AbilityTrigger>) -> Vec<&Trigger> {
    match trigger {
        None => Vec::new(),
        Some(AbilityTrigger::Trigger(t)) => vec![t],
        Some(AbilityTrigger::Array(ts)) => ts.iter().collect(),
    }
}

/// The timing value of a bare `timing-is` condition, else `None`. Mirrors `timingOfCondition`.
fn timing_of_condition(c: &ConditionNode) -> Option<String> {
    match c {
        ConditionNode::SimpleCondition(s) if matches!(s.type_, SimpleConditionType::TimingIs) => {
            Some(jv(&s.parameters, "timing"))
        }
        _ => None,
    }
}

/// The numeric range of a top-level within-range condition, else `None`. Mirrors
/// `conditionWithinRange`.
fn condition_within_range(c: &ConditionNode) -> Option<f64> {
    let s = match c {
        ConditionNode::SimpleCondition(s)
            if matches!(
                s.type_,
                SimpleConditionType::UnitWithinRangeOf
                    | SimpleConditionType::OpponentUnitWithinRange
            ) =>
        {
            s
        }
        _ => return None,
    };
    first(&s.parameters, &["range", "range_inches", "within_inches"]).and_then(Value::as_f64)
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
        engagement_range: scope
            .map(|s| matches!(s.range, ScopeRange::EngagementRange))
            .unwrap_or(false),
        scope_range: scope.map(|s| s.range),
        selected_unit: false,
    };
    let duration = scope.map(|s| s.duration.to_string()).unwrap_or_default();
    let (dur_lead, trail) = duration_clauses(&duration);
    let lead = match usage {
        Some(u) => usage_clause(u),
        None => dur_lead,
    };

    // A reactive trigger (or several — the ability fires on any) opens the
    // sentence ("Each time ..."). B2: when a trigger's proximity just restates a
    // within-range condition on the effect, render the range once (drop it here).
    let triggers = normalize_triggers(trigger);
    let trigger_events: std::collections::HashSet<String> =
        triggers.iter().map(|t| t.event.to_string()).collect();
    let cond_range = match e {
        EffectNode::ConditionalEffect(c) => condition_within_range(&c.condition.0),
        _ => None,
    };
    let trig = triggers
        .iter()
        .map(|t| {
            let drop_prox =
                cond_range.is_some() && t.proximity.as_ref().map(|p| p.range) == cond_range;
            if drop_prox {
                let mut t2 = (*t).clone();
                t2.proximity = None;
                describe_ability_trigger(&t2)
            } else {
                describe_ability_trigger(t)
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" or ");

    match e {
        EffectNode::ConditionalEffect(c) => {
            let inner = &*c.effect;
            if let EffectNode::SingleEffect(s) = inner {
                if s.type_ == SingleEffectType::NamedRegionState {
                    return describe_named_region_conditional(&s.modifier, &c.condition.0, &ctx);
                }
            }
            // B1: drop the condition lead-in when it merely restates a trigger's
            // timing (trigger start-of-phase + condition timing-is start-of-phase).
            let cond_timing = timing_of_condition(&c.condition.0);
            let lead_in = match &cond_timing {
                Some(ct) if trigger_events.contains(ct) => String::new(),
                _ => condition_lead_in(&c.condition.0),
            };
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
            // A designate-target carrying its own `duration` renders that duration
            // itself — repeating the scope duration in the head would double it.
            let own_duration = match e {
                EffectNode::DesignateTargetEffect(d) => d.duration.is_some(),
                EffectNode::PersistentDesignationEffect(_) => true,
                _ => false,
            };
            let blk = block(e, 0, &ctx);
            let dur = if !lead.is_empty() {
                lead
            } else if own_duration {
                String::new()
            } else {
                trail
            };
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
