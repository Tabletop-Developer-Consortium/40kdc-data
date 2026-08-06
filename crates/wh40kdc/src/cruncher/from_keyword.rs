//! Translate a weapon-keyword catalog entry into the [`Buff`] stack it
//! contributes for a given reference-site parameter set and engine context.
//!
//! Mirrors `tools/src/cruncher/from-keyword.ts`. Two paths converge here:
//!
//! 1. **DSL walk**, for keywords whose catalog `effect` is non-null
//!    (`twin-linked`, `heavy`). The walker handles a deliberately small subset
//!    of nodes — `re-roll`, `roll-modifier`, `feel-no-pain`, `keyword-grant`,
//!    `conditional`, `sequence` — and produces buffs with
//!    `source.kind = "weapon-keyword"`.
//!
//! 2. **Id dispatch**, for the eight rules whose catalog `effect` is null
//!    because the DSL has no primitive for them yet — `lethal-hits`,
//!    `sustained-hits`, `devastating-wounds`, `anti`, `melta`, `rapid-fire`,
//!    `torrent`, `ignores-cover`. These surface as `extra-keyword` buffs so the
//!    engine can read them out of [`ResolvedModifiers.extra_keywords`] and
//!    dispatch its math directly.
//!
//! Unrecognised nodes drop silently — diagnostic surfacing is the broader
//! ability translator's concern (M2 / abilities-resolver port).
//!
//! [`ResolvedModifiers.extra_keywords`]: super::buffs::ResolvedModifiers::extra_keywords

use serde_json::Value;

use super::buffs::{
    Buff, BuffContribution, BuffSource, EngineContext, RerollSubset, RollKind, WeaponKeywordRef,
};

/// Keywords whose math the engine encodes directly (catalog `effect` is null).
const ENGINE_DISPATCH_KEYWORDS: &[&str] = &[
    "lethal-hits",
    "sustained-hits",
    "devastating-wounds",
    "anti",
    "melta",
    "rapid-fire",
    "torrent",
    "ignores-cover",
];

/// Convert a single weapon-keyword reference (catalog effect + reference-site
/// parameters) into the buff contributions it makes against `context`.
pub fn buffs_from_keyword(
    keyword_id: &str,
    weapon_id: &str,
    effect: Option<&Value>,
    parameters: Option<&Value>,
    context: &EngineContext,
) -> Vec<Buff> {
    let source = BuffSource::WeaponKeyword {
        weapon_id: weapon_id.to_string(),
        keyword_id: keyword_id.to_string(),
    };

    if ENGINE_DISPATCH_KEYWORDS.contains(&keyword_id) {
        let mut keyword_ref = WeaponKeywordRef {
            keyword_id: keyword_id.to_string(),
            parameters: None,
        };
        if let Some(p) = parameters {
            keyword_ref.parameters = Some(p.clone());
        }
        return vec![Buff {
            source,
            applicable_when: None,
            contribution: BuffContribution::ExtraKeyword { keyword_ref },
        }];
    }

    let Some(effect) = effect else {
        return Vec::new();
    };
    walk(effect, &source, context, None)
}

fn walk(
    node: &Value,
    source: &BuffSource,
    ctx: &EngineContext,
    default_target: Option<&str>,
) -> Vec<Buff> {
    let Some(obj) = node.as_object() else {
        return Vec::new();
    };
    let decorated = default_target.and_then(|target| {
        if obj.contains_key("target") {
            return None;
        }
        let mut copy = obj.clone();
        copy.insert("target".to_string(), Value::String(target.to_string()));
        Some(copy)
    });
    let obj = decorated.as_ref().unwrap_or(obj);
    let Some(node_type) = obj.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    match node_type {
        "re-roll" => reroll_buffs(obj, source),
        "roll-modifier" => roll_modifier_buffs(obj, source),
        "feel-no-pain" => feel_no_pain_buffs(obj, source),
        "keyword-grant" => keyword_grant_buffs(obj, source),
        "conditional" => conditional_buffs(obj, source, ctx, default_target),
        "sequence" => walk_children(obj.get("steps"), source, ctx, default_target),
        // These relationship containers require runtime recipient/selection state
        // that EngineContext does not currently carry. Treat them as unsupported
        // rather than applying their nested effects to the wrong unit or target.
        "leader-model-ability-grant" | "persistent-designation" => Vec::new(),
        _ => Vec::new(),
    }
}

fn walk_children(
    steps: Option<&Value>,
    source: &BuffSource,
    ctx: &EngineContext,
    default_target: Option<&str>,
) -> Vec<Buff> {
    let Some(arr) = steps.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .flat_map(|c| walk(c, source, ctx, default_target))
        .collect()
}

fn reroll_buffs(obj: &serde_json::Map<String, Value>, source: &BuffSource) -> Vec<Buff> {
    let Some(modifier) = obj.get("modifier").and_then(Value::as_object) else {
        return Vec::new();
    };
    let roll = match modifier.get("roll").and_then(Value::as_str) {
        Some("hit") => RollKind::Hit,
        Some("wound") => RollKind::Wound,
        Some("save") => RollKind::Save,
        Some("damage") => RollKind::Damage,
        _ => return Vec::new(),
    };
    let subset = match modifier.get("subset").and_then(Value::as_str) {
        Some("ones") => RerollSubset::Ones,
        Some("all-failures") => RerollSubset::AllFailures,
        _ => return Vec::new(),
    };
    vec![Buff {
        source: source.clone(),
        applicable_when: None,
        contribution: BuffContribution::Reroll { roll, subset },
    }]
}

fn roll_modifier_buffs(obj: &serde_json::Map<String, Value>, source: &BuffSource) -> Vec<Buff> {
    let Some(modifier) = obj.get("modifier").and_then(Value::as_object) else {
        return Vec::new();
    };
    // M1 supports additive only; multiplicative/improve/worsen are out of scope.
    if modifier.get("operation").and_then(Value::as_str) != Some("add") {
        return Vec::new();
    }
    let Some(value) = modifier.get("value").and_then(Value::as_f64) else {
        return Vec::new();
    };
    let contribution = match modifier.get("roll").and_then(Value::as_str) {
        Some("hit") => BuffContribution::HitMod { value },
        Some("wound") => BuffContribution::WoundMod { value },
        Some("save") => BuffContribution::SaveMod { value },
        Some("damage") => BuffContribution::DamageMod { value },
        _ => return Vec::new(),
    };
    vec![Buff {
        source: source.clone(),
        applicable_when: None,
        contribution,
    }]
}

fn feel_no_pain_buffs(obj: &serde_json::Map<String, Value>, source: &BuffSource) -> Vec<Buff> {
    let Some(modifier) = obj.get("modifier").and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(threshold) = modifier.get("threshold").and_then(Value::as_f64) else {
        return Vec::new();
    };
    vec![Buff {
        source: source.clone(),
        applicable_when: None,
        contribution: BuffContribution::FeelNoPain {
            threshold,
            scope: Default::default(),
        },
    }]
}

fn keyword_grant_buffs(obj: &serde_json::Map<String, Value>, source: &BuffSource) -> Vec<Buff> {
    let Some(modifier) = obj.get("modifier").and_then(Value::as_object) else {
        return Vec::new();
    };
    let id = modifier
        .get("keyword_id")
        .or_else(|| modifier.get("id"))
        .and_then(Value::as_str);
    let Some(id) = id.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let parameters = modifier
        .get("parameters")
        .filter(|v| v.is_object())
        .cloned();
    let keyword_ref = WeaponKeywordRef {
        keyword_id: id.to_string(),
        parameters,
    };
    vec![Buff {
        source: source.clone(),
        applicable_when: None,
        contribution: BuffContribution::ExtraKeyword { keyword_ref },
    }]
}

fn conditional_buffs(
    obj: &serde_json::Map<String, Value>,
    source: &BuffSource,
    ctx: &EngineContext,
    default_target: Option<&str>,
) -> Vec<Buff> {
    let Some(condition) = obj.get("condition").and_then(Value::as_object) else {
        return Vec::new();
    };
    let negated = condition.get("negated").and_then(Value::as_bool) == Some(true);
    let verdict = evaluate_condition(condition, ctx);
    let active = match verdict {
        Verdict::Unknown => return Vec::new(),
        Verdict::True => !negated,
        Verdict::False => negated,
    };
    if !active {
        return Vec::new();
    }
    obj.get("effect")
        .map(|e| walk(e, source, ctx, default_target))
        .unwrap_or_default()
}

enum Verdict {
    True,
    False,
    Unknown,
}

/// M1 condition evaluator. Matches the TS `from-keyword.ts` subset:
/// `remained-stationary` and `target-has-keyword`; everything else is
/// "unknown" (the buff is then dropped, matching TS).
fn evaluate_condition(condition: &serde_json::Map<String, Value>, ctx: &EngineContext) -> Verdict {
    match condition.get("type").and_then(Value::as_str) {
        Some("remained-stationary") => {
            if ctx.attacker_stationary == Some(true) {
                Verdict::True
            } else {
                Verdict::False
            }
        }
        Some("target-has-keyword") => {
            let parameters = condition.get("parameters").and_then(Value::as_object);
            let Some(kw) = parameters
                .and_then(|p| p.get("keyword"))
                .and_then(Value::as_str)
            else {
                return Verdict::Unknown;
            };
            let kw_lower = kw.to_lowercase();
            let hit = ctx
                .target_keywords
                .as_ref()
                .is_some_and(|kws| kws.iter().any(|k| k == &kw_lower));
            if hit {
                Verdict::True
            } else {
                Verdict::False
            }
        }
        _ => Verdict::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Phase;
    use serde_json::json;

    fn context() -> EngineContext {
        EngineContext {
            phase: Phase::Shooting,
            attacker_stationary: None,
            attacker_charged: None,
            within_half_range: None,
            distance_inches: None,
            attacker_in_cover: None,
            target_in_cover: None,
            attacker_keywords: None,
            target_keywords: None,
            timing: None,
            attacker_attached: None,
        }
    }

    #[test]
    fn leader_model_ability_grant_requires_resolved_beneficiary() {
        let effect = json!({
            "type": "leader-model-ability-grant",
            "grant": {
                "effect": {
                    "type": "feel-no-pain",
                    "modifier": {"threshold": 4}
                }
            }
        });
        let buffs = buffs_from_keyword("test", "test-weapon", Some(&effect), None, &context());
        assert!(buffs.is_empty());
    }

    #[test]
    fn persistent_designation_requires_retained_selection_state() {
        let effect = json!({
            "type": "persistent-designation",
            "consumer": {
                "effect": {
                    "type": "re-roll",
                    "target": "bearer",
                    "modifier": {"roll": "hit", "subset": "all-failures"}
                }
            }
        });
        let buffs = buffs_from_keyword("test", "test-weapon", Some(&effect), None, &context());
        assert!(buffs.is_empty());
    }
}
