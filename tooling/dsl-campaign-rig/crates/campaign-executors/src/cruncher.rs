use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ExecutorError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeverDiff {
    pub baseline: BTreeSet<String>,
    pub candidate: BTreeSet<String>,
    pub lost: BTreeSet<String>,
    pub gained: BTreeSet<String>,
}

pub fn compare_levers(
    baseline: impl IntoIterator<Item = String>,
    candidate: impl IntoIterator<Item = String>,
) -> Result<LeverDiff, ExecutorError> {
    let baseline = baseline.into_iter().collect::<BTreeSet<_>>();
    let candidate = candidate.into_iter().collect::<BTreeSet<_>>();
    let lost = baseline
        .difference(&candidate)
        .cloned()
        .collect::<BTreeSet<_>>();
    let gained = candidate
        .difference(&baseline)
        .cloned()
        .collect::<BTreeSet<_>>();
    if !lost.is_empty() {
        return Err(ExecutorError::GateFailed);
    }
    Ok(LeverDiff {
        baseline,
        candidate,
        lost,
        gained,
    })
}

pub fn extract_dsl_levers(ability: &Value) -> BTreeSet<String> {
    let mut levers = BTreeSet::new();
    if let Some(effect) = ability.get("effect") {
        collect(effect, "effect", &mut levers);
    }
    levers
}

fn collect(value: &Value, path: &str, levers: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(kind) = object.get("type").and_then(Value::as_str) {
                levers.insert(format!("{path}:type={kind}"));
            }
            for key in [
                "stat",
                "roll",
                "operation",
                "value",
                "attack_type",
                "weapon_type",
                "weapon_name",
                "weapon_keyword",
                "critical_on",
                "subset",
                "keyword",
            ] {
                if let Some(value) = object.get(key) {
                    if value.is_string() || value.is_number() || value.is_boolean() {
                        levers.insert(format!("{path}:{key}={value}"));
                    }
                }
            }
            for (key, child) in object {
                collect(child, &format!("{path}/{key}"), levers);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect(child, path, levers);
            }
        }
        _ => {}
    }
}
