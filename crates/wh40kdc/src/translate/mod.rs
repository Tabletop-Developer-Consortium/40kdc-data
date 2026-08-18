//! Plain-English translation of `secondary-card` scoring `awards` — the Rust
//! mirror of `tools/src/translate/` in the TS package. Output is **ASCII-only**
//! and must be byte-for-byte identical to the TS oracle; the
//! `conformance/scoring-translation` corpus pins both ports (the differ
//! compares structurally, with no tolerance). Any phrasing change here is a
//! semantic corpus change (bump `conformance/SPEC_VERSION`).

use serde_json::{Map, Value};

use crate::generated::{
    CompoundConditionOperator, Condition, ConditionNode, Phase, PlayerTurn, ScoringTrigger,
    ScoringTriggerTiming, SecondaryCard, SecondaryCardAwardsItem, SimpleCondition,
    SimpleConditionType,
};

mod effect;
pub use effect::{
    describe_ability, describe_ability_parts, describe_applies_to, describe_effect,
    describe_effect_inline, describe_effect_with_scope, describe_scope,
};

/// kebab-case → space-separated words (`enemy-territory` → `enemy territory`).
pub fn dekebab(s: &str) -> String {
    s.replace('-', " ")
}

// `parameters` accessors over the open `serde_json::Map`. Defaults mirror the
// TS `?? 1` / `?? "..."` fallbacks so missing keys translate identically.
fn ps<'a>(p: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}
fn pu(p: &Map<String, Value>, k: &str, default: u64) -> u64 {
    p.get(k).and_then(Value::as_u64).unwrap_or(default)
}
fn pb(p: &Map<String, Value>, k: &str) -> bool {
    p.get(k).and_then(Value::as_bool).unwrap_or(false)
}
fn po<'a>(p: &'a Map<String, Value>, k: &str) -> Option<&'a Map<String, Value>> {
    p.get(k).and_then(Value::as_object)
}
/// JS-template stringification of a parameter (numbers print bare, missing or
/// null prints `?`) — mirrors the TS `str(p.key)` after its nullish guard.
fn pj(p: &Map<String, Value>, k: &str) -> String {
    p.get(k)
        .map(effect::jval)
        .unwrap_or_else(|| "?".to_string())
}

/// `2` + `objective` → `2+ objectives`. All nouns here are regular plurals.
fn count(n: u64, noun: &str) -> String {
    format!("{n}+ {noun}s")
}

/// `Number(p.key)` for a battle-round window bound: present-and-not-null integer,
/// else `None`. Mirrors the TS `p.min/p.max != null ? Number(...) : undefined`.
pub(super) fn num_param(p: &Map<String, Value>, k: &str) -> Option<i64> {
    p.get(k)
        .filter(|v| !v.is_null())
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

/// Battle-round ordinal: `["zeroth","first",...,"fifth"][n] ?? "{n}th"`. Out of
/// range (incl. negative) degrades to `<n>th`, matching the TS `bOrd`/`ord` helper.
pub(super) fn battle_round_ordinal(n: i64) -> String {
    let table = ["zeroth", "first", "second", "third", "fourth", "fifth"];
    usize::try_from(n)
        .ok()
        .and_then(|i| table.get(i))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{n}th"))
}

/// `EVENT_PHRASES` lookup: a canonical `GameEvent` token → its fixed phrase, or
/// `None` when unmapped. The single source of truth shared by [`event_clause`]
/// (reactive triggers) and [`describe_timing`] (canonicalized `timing-is`).
fn event_phrase(e: &str) -> Option<&'static str> {
    let mapped = match e {
        "start-of-phase" => "at the start of the phase",
        "end-of-phase" => "at the end of the phase",
        "start-of-turn" => "at the start of the turn",
        "end-of-turn" => "at the end of the turn",
        "start-of-opponent-turn" => "at the start of the opponent's turn",
        "end-of-opponent-turn" => "at the end of the opponent's turn",
        "start-of-battle-round" => "at the start of the battle round",
        "start-of-battle" => "at the start of the battle",
        "army-selection" => "when you select this model to include in your army",
        "start-of-command-phase" => "at the start of the Command phase",
        "start-of-shooting-phase" => "at the start of your Shooting phase",
        "declare-battle-formations" => "when declaring Battle Formations",
        "post-deployment" => "after deployment",
        "unit-set-up" => "when the unit is set up",
        "set-up-from-reserves" => "when the unit arrives from Reserves",
        "arrives-from-strategic-reserves" => "when the unit arrives from Strategic Reserves",
        "starts-in-strategic-reserves" => "if the unit starts in Strategic Reserves",
        "game-start-in-reserves" => "if the unit begins the battle in Reserves",
        "deep-strike-setup" => "when the unit is set up by Deep Strike",
        "reinforcements" => "when the unit arrives as Reinforcements",
        "normal-move" => "when the unit makes a Normal move",
        "advance-move" => "when the unit makes an Advance move",
        "advances" => "when the unit Advances",
        "fall-back-move" => "when the unit makes a Fall Back move",
        "falls-back" => "when the unit Falls Back",
        "charge-move" => "when the unit makes a Charge move",
        "charge-declaration" => "when a Charge is declared",
        "moved-through-terrain" => "when the unit moves through terrain",
        "moved-through-tall-terrain" => "when the unit moves through terrain over 4\" tall",
        "enemy-unit-ended-move" => "an enemy unit ends a move",
        "enemy-unit-fell-back" => "an enemy unit Falls Back",
        "before-hit-roll" => "before a Hit roll is made",
        "after-hit-roll" => "after a Hit roll is made",
        "before-wound-roll" => "before a Wound roll is made",
        "after-wound-roll" => "after a Wound roll is made",
        "before-save-roll" => "before a saving throw is made",
        "after-save-roll" => "after a saving throw is made",
        "before-damage-roll" => "before a Damage roll is made",
        "after-damage-roll" => "after a Damage roll is made",
        "before-charge-roll" => "before a Charge roll is made",
        "after-charge-roll" => "after a Charge roll is made",
        "before-advance-roll" => "before an Advance roll is made",
        "after-advance-roll" => "after an Advance roll is made",
        "before-battle-shock" => "before a Battle-shock test",
        "after-battle-shock" => "after a Battle-shock test",
        "on-unit-selected" => "when the unit is selected",
        "selected-to-shoot" => "when the unit is selected to shoot",
        "selected-to-fight" => "when the unit is selected to fight",
        "selected-to-advance" => "when the unit is selected to Advance",
        "after-unit-resolves-attacks" => "after the unit resolves its attacks",
        "after-scoring-hit" => "after scoring a hit",
        "after-enemy-unit-fires" => "after an enemy unit shoots",
        "on-unit-destroyed" => "when the unit is destroyed",
        "on-model-destroyed" => "when a model in the unit is destroyed",
        "first-model-destroyed" => "the first time a model in the unit is destroyed",
        "before-bearer-removed" => "before this model is removed from play",
        "enemy-unit-destroyed-in-melee" => "when an enemy unit is destroyed in melee",
        "on-damage-allocated" => "when damage is allocated",
        "battle-shock-test" => "when the unit takes a Battle-shock test",
        "leadership-test" => "when the unit takes a Leadership test",
        "desperate-escape-test" => "when the unit takes a Desperate Escape test",
        _ => return None,
    };
    Some(mapped)
}

/// A `GameEvent` token → natural reactive-trigger clause ("an enemy unit ends a
/// move", "before a saving throw is made"). Mirrors the TS `EVENT_PHRASES` map
/// in `condition.ts`; an unmapped event falls back to `when <dekebab>`.
pub(super) fn event_clause(e: &str) -> String {
    match event_phrase(e) {
        Some(p) => p.to_string(),
        None => format!("when {}", dekebab(e)),
    }
}

/// Legacy `timing-is` string → its canonical `GameEvent` token. Mirrors
/// `TIMING_ALIASES`; applied before the `EVENT_PHRASES` lookup in
/// [`describe_timing`].
fn timing_alias(t: &str) -> Option<&'static str> {
    Some(match t {
        "advance" => "advances",
        "after-attacks" => "after-unit-resolves-attacks",
        "after-attacking-unit-finishes-attacks" => "after-unit-resolves-attacks",
        "after-shooting" => "after-unit-resolves-attacks",
        "after-unit-shot" => "after-unit-resolves-attacks",
        "after-unit-has-shot" => "after-unit-resolves-attacks",
        "after-this-model-has-shot" => "after-unit-resolves-attacks",
        "after-shot-hits-scored" => "after-scoring-hit",
        "deep-strike" => "deep-strike-setup",
        "end" => "end-of-turn",
        "start" => "start-of-turn",
        "fall-back" => "falls-back",
        "model-destroyed" => "on-model-destroyed",
        "on-destroyed" => "on-unit-destroyed",
        "before-this-model-removed" => "before-bearer-removed",
        "reinforcements-step" => "reinforcements",
        "setup" => "unit-set-up",
        "set-up-this-turn" => "unit-set-up",
        "after-move-through-terrain-over-4-inches" => "moved-through-tall-terrain",
        "after-moving-through-tall-terrain" => "moved-through-tall-terrain",
        "when-this-unit-selected-to-shoot" => "selected-to-shoot",
        _ => return None,
    })
}

/// `timing-is` tokens with no canonical `GameEvent` — these keep their own
/// phrase. Mirrors `TIMING_ONLY_PHRASES`.
fn timing_only_phrase(t: &str) -> Option<&'static str> {
    Some(match t {
        "once-per-battle" => "once per battle",
        "once-per-phase" => "once per phase",
        "once-per-opponent-turn" => "once per opponent's turn",
        "first-this-battle" => "the first time this battle",
        "first-time-this-phase" => "the first time this phase",
        "in-reserves" => "while it is in Reserves",
        "shooting-phase" => "in the Shooting phase",
        "command-phase" => "in the Command phase",
        "start-of-fight-phase" => "at the start of the Fight phase",
        "first-movement-phase" => "in your first Movement phase",
        "start-of-first-battle-round" => "at the start of the first battle round",
        "start-of-movement-phase" => "at the start of the Movement phase",
        "shooting-or-fight-phase" => "in the Shooting or Fight phase",
        "this-model-starts-or-ends-a-move" => "each time this model starts or ends a move",
        "end-of-normal-move" => "when the unit ends a Normal move",
        "friendly-unit-empowered-within-9" => {
            "each time you spend 1 Pain token to Empower a friendly unit within 9\" of this unit"
        }
        "enemy-unit-fails-battle-shock" => "each time an enemy unit fails a Battle-shock test",
        "enemy-unit-destroyed" => "each time an enemy unit is destroyed",
        _ => return None,
    })
}

/// A `timing-is` token → natural GW-voice clause. `timing-is` has been unified
/// onto the game-event vocabulary: a timing-only phrase wins first, otherwise
/// the token is canonicalized (via [`timing_alias`]) and rendered through the
/// shared [`event_phrase`] map; the `after-`/`on-`/`-destroyed`/`at` fallbacks
/// run on the *original* token.
pub(super) fn describe_timing(t: &str) -> String {
    if let Some(p) = timing_only_phrase(t) {
        return p.to_string();
    }
    let canon = timing_alias(t).unwrap_or(t);
    if let Some(p) = event_phrase(canon) {
        return p.to_string();
    }
    if let Some(rest) = t.strip_prefix("after-") {
        return format!("after {}", dekebab(rest));
    }
    if let Some(rest) = t.strip_prefix("on-") {
        return format!("when {}", dekebab(rest));
    }
    if t.ends_with("-destroyed") {
        return format!("each time {}", dekebab(t));
    }
    format!("at {}", dekebab(t))
}

/// `timing-is` negation, generic over every [`describe_timing`] phrase: a
/// `when …` clause becomes `unless …`; anything else is bare-prepended with
/// `unless `. Mirrors the TS `negatedTiming` helper.
pub(super) fn negated_timing(t: &str) -> String {
    let phrase = describe_timing(t);
    match phrase.strip_prefix("when ") {
        Some(rest) => format!("unless {rest}"),
        None => format!("unless {phrase}"),
    }
}

/// TS `param != null` over the open parameter map.
fn pnn(p: &Map<String, Value>, k: &str) -> bool {
    matches!(p.get(k), Some(v) if !v.is_null())
}

fn phase_word(p: Phase) -> &'static str {
    match p {
        Phase::Command => "Command",
        Phase::Movement => "Movement",
        Phase::Shooting => "Shooting",
        Phase::Charge => "Charge",
        Phase::Fight => "Fight",
    }
}

/// "End of your Command phase (round 2+)" and friends.
pub fn describe_trigger(t: &ScoringTrigger) -> String {
    let turn = match t.player_turn {
        Some(PlayerTurn::OpponentTurn) => "the opponent's",
        Some(PlayerTurn::Either) => "any",
        _ => "your",
    };
    let phase = t.phase.map(phase_word).unwrap_or("");

    let mut base = match t.timing {
        Some(ScoringTriggerTiming::StartOfTurn) => format!("Start of {turn} turn"),
        Some(ScoringTriggerTiming::EndOfTurn) => format!("End of {turn} turn"),
        Some(ScoringTriggerTiming::StartOfPhase) => format!("Start of {turn} {phase} phase"),
        Some(ScoringTriggerTiming::EndOfPhase) => format!("End of {turn} {phase} phase"),
        Some(ScoringTriggerTiming::EndOfBattle) => "End of the battle".to_string(),
        None => {
            if t.phase.is_some() {
                format!("During {turn} {phase} phase")
            } else {
                "Any time".to_string()
            }
        }
    };

    if let Some(br) = &t.battle_round {
        let min = br.min.map(|n| n.get());
        let max = br.max.map(|n| n.get());
        match (min, max) {
            (Some(mn), Some(mx)) => base.push_str(&if mn == mx {
                format!(" (round {mn})")
            } else {
                format!(" (rounds {mn}-{mx})")
            }),
            (Some(mn), None) => base.push_str(&format!(" (round {mn}+)")),
            (None, Some(mx)) => base.push_str(&format!(" (rounds 1-{mx})")),
            (None, None) => {}
        }
    }
    base
}

/// "End of your Command phase (round 2+): 3 VP per controlled objective when ..."
pub fn describe_award(a: &SecondaryCardAwardsItem) -> String {
    let (trigger, when, cumulative, exclusive, amount) = match a {
        SecondaryCardAwardsItem::Variant0 {
            trigger,
            when,
            cumulative,
            exclusive_group,
            vp,
            ..
        } => (
            trigger,
            when,
            *cumulative,
            exclusive_group.is_some(),
            format!("{vp} VP"),
        ),
        SecondaryCardAwardsItem::Variant1 {
            trigger,
            when,
            cumulative,
            exclusive_group,
            vp_per,
            per,
            per_max,
            ..
        } => {
            let mut amt = format!("{vp_per} VP per {}", dekebab(per));
            if let Some(pm) = per_max {
                amt.push_str(&format!(" (max {})", pm.get()));
            }
            (trigger, when, *cumulative, exclusive_group.is_some(), amt)
        }
    };

    let prefix = if cumulative { "+ " } else { "" };
    let trig = describe_trigger(trigger);
    let when_clause = match when {
        Some(c) => format!(" when {}", describe_condition(c)),
        None => String::new(),
    };
    let tier = if exclusive { " [highest tier]" } else { "" };
    format!("{prefix}{trig}: {amount}{when_clause}{tier}")
}

/// Humanize every award on a card, in array order (the order is load-bearing).
pub fn describe_scoring_card(card: &SecondaryCard) -> Vec<String> {
    card.awards.iter().map(describe_award).collect()
}

pub fn describe_condition(c: &Condition) -> String {
    describe_node(&c.0)
}

pub(super) fn describe_node(n: &ConditionNode) -> String {
    match n {
        ConditionNode::CompoundCondition(c) => {
            let parts: Vec<String> = c.operands.iter().map(describe_node).collect();
            match c.operator {
                CompoundConditionOperator::And => parts.join(" and "),
                CompoundConditionOperator::Or => parts.join(" or "),
                CompoundConditionOperator::Not => format!("not ({})", parts.join(", ")),
            }
        }
        ConditionNode::SimpleCondition(s) => describe_simple(s),
    }
}

fn region_membership_phrase(p: &Map<String, Value>, negated: bool) -> String {
    let raw = p
        .get("region_id")
        .or_else(|| po(p, "state_ref").and_then(|r| r.get("region_id")))
        .map(effect::jval)
        .unwrap_or_else(|| "?".to_string());
    let region = dekebab(&raw)
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let relation = match ps(p, "relation") {
        Some("wholly-within") => "wholly within",
        Some(value) => value,
        None => "within",
    };
    let subject = if ps(p, "unit_scope") == Some("whole-unit") {
        "every model in the eligible attacking unit"
    } else {
        "the eligible attacking model"
    };
    format!(
        "{}{} is {relation} {region}",
        if negated { "not " } else { "" },
        subject
    )
}

fn describe_simple(s: &SimpleCondition) -> String {
    let negate = if s.negated { "not " } else { "" };
    let p = &s.parameters;
    use SimpleConditionType as T;
    match s.type_ {
        // ── Ability-DSL conditions ──────────────────────────────────────────
        T::PhaseIs => format!("{negate}during the {} phase", pj(p, "phase")),
        T::TimingIs => {
            let timing = ps(p, "timing").unwrap_or("?");
            if s.negated {
                negated_timing(timing)
            } else {
                describe_timing(timing)
            }
        }
        T::PlayerTurnIs => {
            let turn = match ps(p, "turn") {
                Some("your-turn") | Some("your") | Some("own") => "your",
                Some("opponent-turn") | Some("opponent") => "the opponent's",
                _ => "either player's",
            };
            format!("{negate}in {turn} turn")
        }
        T::ChargedThisTurn => format!("{negate}the unit charged this turn"),
        T::AdvancedThisTurn => format!("{negate}the unit advanced this turn"),
        T::DisembarkedFromTransport => {
            format!("{negate}the unit disembarked from a Transport this turn")
        }
        T::FactionRuleActive => format!("{negate}the {} is active", pj(p, "rule")),
        T::BattleRound => {
            let where_ = match (num_param(p, "min"), num_param(p, "max")) {
                (Some(min), Some(max)) => {
                    if min == max {
                        format!("the {} battle round", battle_round_ordinal(min))
                    } else {
                        format!("battle rounds {min}-{max}")
                    }
                }
                (Some(min), None) => {
                    format!("the {} battle round onward", battle_round_ordinal(min))
                }
                (None, Some(max)) => format!("the first {max} battle rounds"),
                (None, None) => "the battle round".to_string(),
            };
            format!("{negate}during {where_}")
        }
        T::RemainedStationary => format!("{negate}the unit remained stationary"),
        T::UnitBelowStartingStrength => format!("{negate}the unit is below starting strength"),
        T::UnitBelowHalfStrength => {
            let who = if pj(p, "subject") == "target" {
                "target unit"
            } else {
                "unit"
            };
            format!("{negate}the {who} is below half strength")
        }
        T::UnitHasKeyword => format!("{negate}the unit has \"{}\"", pj(p, "keyword")),
        T::TargetHasKeyword => {
            format!("{negate}the target has \"{}\"", pj(p, "keyword"))
        }
        T::ModelIsLeader => format!("{negate}the model is leading a unit"),
        T::IsAttached => {
            let kw = match ps(p, "keyword") {
                Some(k) => format!("{k} "),
                None => String::new(),
            };
            format!("{negate}attached to a {kw}unit")
        }
        T::AttackIsType => {
            match ps(p, "comparison") {
                Some("strength-greater-than-toughness") => {
                    format!("{negate}when this attack's Strength is greater than the target's Toughness")
                }
                Some(c) => format!("{negate}when {}", dekebab(c)),
                None => format!("{negate}for {} attacks", pj(p, "attack_type")),
            }
        }
        T::IsBattleShocked => format!("{negate}the unit is battle-shocked"),
        T::HasLostWounds => format!("{negate}the model has lost wounds"),
        T::WoundsRemainingAtOrBelow => format!(
            "{negate}the model has {} or fewer wounds remaining",
            pu(p, "threshold", 0)
        ),
        T::WasHitByAttack => {
            let subject = match ps(p, "subject") {
                Some("target") => "the target",
                Some("selected-friendly-unit") => "the selected friendly unit",
                _ => "the unit",
            };
            let atk = match ps(p, "attack_type") {
                Some(t) => format!("{t} "),
                None => String::new(),
            };
            let weapon = match ps(p, "weapon_name") {
                Some(w) => format!(" by {w}"),
                None => String::new(),
            };
            let bound_source = match p.get("source") {
                Some(Value::Object(source)) if source.get("event_var").is_some() => {
                    " from that enemy unit".to_string()
                }
                Some(v) if !v.is_null() => format!(" from {}", effect::jval(v)),
                _ => String::new(),
            };
            let window = if ps(p, "window") == Some("just-finished-shooting-sequence") {
                " during its just-finished shooting sequence"
            } else {
                " this phase"
            };
            let n = pu(p, "count_min", 1);
            if n > 1 {
                format!(
                    "{negate}{subject} was hit by {n}+ {atk}attacks{weapon}{bound_source}{window}"
                )
            } else if atk.is_empty() {
                format!("{negate}{subject} was hit by an attack{weapon}{bound_source}{window}")
            } else {
                format!("{negate}{subject} was hit by a {atk}attack{weapon}{bound_source}{window}")
            }
        }
        T::OpponentUnitWithinRange => {
            let rv = ["range", "range_inches", "within_inches"]
                .iter()
                .filter_map(|k| p.get(*k))
                .find(|v| !v.is_null());
            let r = if pnn(p, "weapon_name") {
                format!("range of {}", dekebab(&pj(p, "weapon_name")))
            } else if pnn(p, "range_multiplier") {
                "half range of its ranged weapons".to_string()
            } else if rv.and_then(Value::as_str) == Some("engagement") {
                "engagement range".to_string()
            } else {
                format!(
                    "{}\"",
                    rv.map(effect::jval).unwrap_or_else(|| "?".to_string())
                )
            };
            format!("{negate}an enemy unit is within {r}")
        }
        T::UnitWithinRangeOf => {
            let tt = ps(p, "target_type").unwrap_or("target");
            if tt == "closest-eligible" {
                let within = if pnn(p, "range") {
                    format!(" within {}\"", pj(p, "range"))
                } else {
                    String::new()
                };
                format!("{negate}the target is the closest eligible target{within}")
            } else if tt == "area-terrain" {
                format!("{negate}within an area terrain feature")
            } else {
                let who = if tt == "friendly-keyword" && ps(p, "keyword").is_some() {
                    format!("a friendly {} unit", pj(p, "keyword"))
                } else if tt == "friendly" {
                    "a friendly unit".to_string()
                } else {
                    dekebab(tt)
                };
                let dist = if pnn(p, "range") {
                    format!("{}\"", pj(p, "range"))
                } else {
                    "?\"".to_string()
                };
                format!("{negate}within {dist} of {who}")
            }
        }
        T::WithinRangeOfObjective => format!("{negate}within range of an objective"),
        T::HasFoughtThisPhase => format!("{negate}has fought this phase"),
        T::DestroyedByAttackType => {
            if pj(p, "attack_type") == "any" {
                format!("{negate}destroyed by any attack")
            } else {
                format!("{negate}destroyed by a {} attack", pj(p, "attack_type"))
            }
        }

        // ── Scoring conditions (secondary-card award `when`) ────────────────
        T::ObjectiveMajority => format!(
            "{negate}you hold more objectives than the {}",
            dekebab(ps(p, "relative_to").unwrap_or("opponent"))
        ),
        T::ControlsObjective => {
            let noun = match ps(p, "objective_role") {
                Some(r) => format!("{} objective", dekebab(r)),
                None => "objective".to_string(),
            };
            let mut out = format!(
                "{negate}you control {}",
                count(pu(p, "count_min", 1), &noun)
            );
            if let Some(o) = ps(p, "objective") {
                out.push_str(&format!(" ({})", dekebab(o)));
            }
            if let Some(sc) = ps(p, "scope") {
                out.push_str(&format!(" in {}", dekebab(sc)));
            }
            if let Some(e) = ps(p, "exclude") {
                out.push_str(&format!(" (excluding {})", dekebab(e)));
            }
            out
        }
        T::UnitsDestroyed => {
            let mut s = format!(
                "{negate}{} destroyed",
                count(pu(p, "count_min", 1), &format!("{} unit", pj(p, "side")))
            );
            if pnn(p, "window") {
                s.push_str(&format!(" {}", dekebab(&pj(p, "window"))));
            }
            s
        }
        T::UnitsDestroyedComparison => {
            let empty = Map::new();
            let subj = po(p, "subject").unwrap_or(&empty);
            let refr = po(p, "reference").unwrap_or(&empty);
            let (cmp, link) = if ps(p, "comparator") == Some("greater-or-equal") {
                ("at least as many", "as")
            } else {
                ("more", "than")
            };
            format!(
                "{negate}you destroyed {cmp} {} units {} {link} {} units {}",
                pj(subj, "side"),
                dekebab(&pj(subj, "window")),
                pj(refr, "side"),
                dekebab(&pj(refr, "window"))
            )
        }
        T::NewObjectiveControlled => format!(
            "{negate}you newly control {} this turn",
            count(pu(p, "count_min", 1), "objective")
        ),
        T::DestroyedWhileOnObjective => {
            let obj = match ps(p, "objective_role") {
                Some(r) => format!("a {} objective", dekebab(r)),
                None => "an objective".to_string(),
            };
            let mut out = format!(
                "{negate}{} destroyed",
                count(pu(p, "count_min", 1), "enemy unit")
            );
            if pb(p, "destroyer_on_objective") {
                out.push_str(&format!(" by a unit on {obj}"));
            }
            if pb(p, "victim_on_objective") {
                out.push_str(&format!(" while on {obj}"));
            }
            if pb(p, "victim_started_turn_on_objective") {
                out.push_str(&format!(" that started the turn on {obj}"));
            }
            out
        }
        T::DestroyedInTaggedTerrain => {
            let where_ = if pb(p, "at_start_of_turn") {
                "that started the turn in"
            } else {
                "while in"
            };
            let terrain = match ps(p, "tag") {
                Some(t) => format!("{} terrain", dekebab(t)),
                None => "a terrain area".to_string(),
            };
            format!(
                "{negate}{} destroyed {where_} {terrain}",
                count(pu(p, "count_min", 1), "enemy unit")
            )
        }
        T::OperationMarkers => {
            let side = match ps(p, "side") {
                Some(s) => format!("{s} "),
                None => String::new(),
            };
            let min = p.get("count_min").and_then(Value::as_u64);
            let max = p.get("count_max").and_then(Value::as_u64);
            let mut out = if max == Some(0) {
                format!("no {side}operation markers on the battlefield")
            } else if min.is_some() && min == max {
                let n = min.unwrap_or(1);
                let plural = if n == 1 { "" } else { "s" };
                format!("exactly {n} {side}operation marker{plural} on the battlefield")
            } else {
                format!(
                    "{}+ {side}operation markers on the battlefield",
                    min.unwrap_or(1)
                )
            };
            if let Some(w) = ps(p, "within_range_of") {
                out.push_str(&format!(" within range of {}", dekebab(w)));
            }
            if pb(p, "friendly_unit_in_same_terrain_area") {
                out.push_str(" with a friendly unit in the same terrain area");
            }
            if pb(p, "no_enemy_in_terrain_area") {
                out.push_str(" and no enemy units in that terrain area");
            }
            format!("{negate}{out}")
        }
        T::ActionCompleted => {
            let mut out = format!(
                "{negate}{} completed",
                count(pu(p, "count_min", 1), "action")
            );
            if let Some(a) = ps(p, "action_id") {
                out.push_str(&format!(" ({})", dekebab(a)));
            }
            if let Some(tk) = ps(p, "target_kind") {
                out.push_str(&format!(" on {}", dekebab(tk)));
            }
            if let Some(tf) = po(p, "target_filter") {
                if let Some(r) = ps(tf, "objective_role") {
                    out.push_str(&format!(" ({})", dekebab(r)));
                }
                if pb(tf, "in_enemy_territory") {
                    out.push_str(" in enemy territory");
                }
                if let Some(e) = ps(tf, "exclude") {
                    out.push_str(&format!(" (excluding {})", dekebab(e)));
                }
            }
            if let Some(w) = ps(p, "window") {
                out.push_str(&format!(" {}", dekebab(w)));
            }
            out
        }
        T::ObjectiveHasTag => {
            let mut out = format!(
                "{negate}{} tagged {}",
                count(pu(p, "count_min", 1), "objective"),
                dekebab(&pj(p, "tag"))
            );
            if let Some(cm) = p.get("count_max").and_then(Value::as_u64) {
                out.push_str(&format!(" (at most {cm})"));
            }
            if let Some(o) = ps(p, "objective") {
                out.push_str(&format!(" ({})", dekebab(o)));
            }
            if let Some(sc) = ps(p, "scope") {
                out.push_str(&format!(" in {}", dekebab(sc)));
            }
            if pb(p, "last_marked") {
                out.push_str(" (most recently marked)");
            }
            out
        }
        T::UnitHasTag => {
            // Ability-gate use (no side/count) reads as a unit state; scoring counts tagged units.
            if !pnn(p, "side") && !pnn(p, "count_min") {
                return format!("{negate}the unit is tagged {}", dekebab(&pj(p, "tag")));
            }
            let mut out = format!(
                "{negate}{} tagged {}",
                count(pu(p, "count_min", 1), &format!("{} unit", pj(p, "side"))),
                dekebab(&pj(p, "tag"))
            );
            if let Some(w) = ps(p, "window") {
                out.push_str(&format!(" ({})", dekebab(w)));
            }
            out
        }
        T::TerrainHasTag => {
            let mut out = format!("{negate}terrain tagged {}", dekebab(&pj(p, "tag")));
            if let Some(fm) = p.get("friendly_units_min").and_then(Value::as_u64) {
                out.push_str(&format!(" with {fm}+ friendly units"));
            }
            if let Some(em) = p.get("enemy_units_max").and_then(Value::as_u64) {
                out.push_str(&format!(" and at most {em} enemy units"));
            }
            if pb(p, "last_marked") {
                out.push_str(" (most recently marked)");
            }
            if pb(p, "in_enemy_dz") {
                out.push_str(" in the enemy deployment zone");
            }
            out
        }
        T::TerrainAreaControl => format!(
            "{negate}you control a terrain area with {}+ models",
            pu(p, "min_models", 1)
        ),
        T::RegionMembership => region_membership_phrase(p, s.negated),
        T::TerritoryControl => {
            let mut out = format!(
                "{negate}you control {}",
                dekebab(ps(p, "territory_ref").unwrap_or("your-territory"))
            );
            if let Some(em) = p.get("enemy_units_max").and_then(Value::as_u64) {
                out.push_str(&format!(" with at most {em} enemy units"));
            }
            out
        }
        T::EngagementFronts => {
            format!(
                "{negate}you are engaged on {}+ fronts",
                pu(p, "count_min", 1)
            )
        }
        T::TokenCountAtOrAbove => format!(
            "{negate}the unit has {}+ {}",
            pj(p, "threshold"),
            dekebab(&pj(p, "pool_id"))
        ),

        T::EngagementState => match ps(p, "state") {
            None => format!("{negate}the unit is within Engagement Range"),
            Some("on-battlefield") => format!("{negate}the unit is on the battlefield"),
            Some("embarked") => format!("{negate}the unit is embarked"),
            Some("engaged") | Some("within-engagement-range") | Some("in-engagement-range") => {
                format!("{negate}the unit is within Engagement Range")
            }
            Some(other) => format!("{negate}the unit is {}", dekebab(other)),
        },
        T::UnitWasInEngagementRangeOf => {
            let snapshot_point = if ps(p, "snapshot") == Some("turn-start") {
                "the turn"
            } else {
                "the phase"
            };
            format!(
                "{negate}the selected friendly unit started {snapshot_point} within Engagement Range of that enemy unit"
            )
        }
        T::FightsFirst => format!("{negate}the unit has Fights First"),
        T::DispositionMatches => match ps(p, "disposition") {
            Some("strategic-reserves") => format!("{negate}the unit is in Strategic Reserves"),
            _ => format!(
                "{negate}the unit's disposition is {}",
                dekebab(&pj(p, "disposition"))
            ),
        },
        T::AttackStatCompare => format!(
            "{negate}the attack's {} is {} the target's {}",
            ps(p, "attacker_stat").unwrap_or(""),
            dekebab(ps(p, "comparison").unwrap_or("")),
            ps(p, "target_stat").unwrap_or(""),
        ),
        T::MadeIngressMoveThisTurn => format!("{negate}the unit made an ingress move this turn"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::ScoringTriggerBattleRound;
    use std::num::NonZeroU64;

    fn br(min: Option<u64>, max: Option<u64>) -> ScoringTriggerBattleRound {
        ScoringTriggerBattleRound {
            min: min.and_then(NonZeroU64::new),
            max: max.and_then(NonZeroU64::new),
        }
    }

    #[test]
    fn trigger_phrases() {
        let t = ScoringTrigger {
            timing: Some(ScoringTriggerTiming::EndOfPhase),
            phase: Some(Phase::Command),
            player_turn: Some(PlayerTurn::YourTurn),
            battle_round: Some(br(Some(2), None)),
        };
        assert_eq!(describe_trigger(&t), "End of your Command phase (round 2+)");

        let t2 = ScoringTrigger {
            timing: Some(ScoringTriggerTiming::EndOfTurn),
            phase: None,
            player_turn: None,
            battle_round: Some(br(None, Some(2))),
        };
        assert_eq!(describe_trigger(&t2), "End of your turn (rounds 1-2)");

        let t3 = ScoringTrigger {
            timing: Some(ScoringTriggerTiming::EndOfBattle),
            phase: None,
            player_turn: None,
            battle_round: None,
        };
        assert_eq!(describe_trigger(&t3), "End of the battle");
    }

    fn simple(type_: SimpleConditionType, params: Value) -> Condition {
        let parameters = params.as_object().cloned().unwrap_or_default();
        Condition(ConditionNode::SimpleCondition(SimpleCondition {
            negated: false,
            parameters,
            type_,
        }))
    }

    #[test]
    fn condition_phrases() {
        assert_eq!(
            describe_condition(&simple(
                SimpleConditionType::ControlsObjective,
                serde_json::json!({ "objective_role": "central", "count_min": 1 })
            )),
            "you control 1+ central objectives"
        );
        assert_eq!(
            describe_condition(&simple(
                SimpleConditionType::ObjectiveMajority,
                serde_json::json!({ "relative_to": "opponent" })
            )),
            "you hold more objectives than the opponent"
        );
        assert_eq!(
            describe_condition(&simple(
                SimpleConditionType::UnitsDestroyed,
                serde_json::json!({ "side": "enemy", "window": "this-turn", "count_min": 1 })
            )),
            "1+ enemy units destroyed this turn"
        );
    }
}
