//! Cross-implementation conformance for Dataset's linked-API read methods.
//!
//! Each case in `conformance/linked-api/cases.json` names a query, args, and
//! a `comparison` mode (`scalar`, `ordered`, `set`). The Rust crate must
//! reproduce the reference (TS) result for each case. See `CONFORMANCE.md`
//! "abilities-resolver" and "linked-api" for ordering invariants.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use wh40kdc::Dataset;

fn conformance_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

/// Resolve a query against the embedded Dataset and return the result encoded
/// as a `serde_json::Value` so a single comparison helper can handle scalar
/// (string | null) and list (array of strings) cases uniformly.
fn run_query(ds: &Dataset, query: &str, args: &Value) -> Value {
    let arg_str = |k: &str| -> &str {
        args.get(k)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("missing arg {k} in args {args}"))
    };
    match query {
        "find_unit" => ds
            .find_unit(arg_str("query"))
            .map(|u| Value::String(u.id.to_string()))
            .unwrap_or(Value::Null),
        "find_weapon" => ds
            .find_weapon(arg_str("query"))
            .map(|w| Value::String(w.id.to_string()))
            .unwrap_or(Value::Null),
        "find_faction" => ds
            .find_faction(arg_str("query"))
            .map(|f| Value::String(f.id.to_string()))
            .unwrap_or(Value::Null),
        "find_ability" => ds
            .find_ability(arg_str("query"))
            .map(|a| Value::String(a.ability_id.to_string()))
            .unwrap_or(Value::Null),
        "abilities_of" => {
            let id = arg_str("unitId");
            let u = ds
                .units
                .get(id)
                .unwrap_or_else(|| panic!("abilities_of: unknown unit {id}"));
            Value::Array(
                ds.abilities_of(u)
                    .into_iter()
                    .map(|a| Value::String(a.ability_id.to_string()))
                    .collect(),
            )
        }
        "weapons_of" => {
            let id = arg_str("unitId");
            let u = ds
                .units
                .get(id)
                .unwrap_or_else(|| panic!("weapons_of: unknown unit {id}"));
            Value::Array(
                ds.weapons_of(u)
                    .into_iter()
                    .map(|w| Value::String(w.id.to_string()))
                    .collect(),
            )
        }
        "wargear_options_of" => {
            let id = arg_str("unitId");
            let u = ds
                .units
                .get(id)
                .unwrap_or_else(|| panic!("wargear_options_of: unknown unit {id}"));
            Value::Array(
                ds.wargear_options_of(u)
                    .into_iter()
                    .map(|o| Value::String(o.id.to_string()))
                    .collect(),
            )
        }
        "base_loadout" | "maximal_loadout" => {
            let id = arg_str("unitId");
            let model_count: u64 = arg_str("modelCount")
                .parse()
                .expect("modelCount is an integer");
            let u = ds
                .units
                .get(id)
                .unwrap_or_else(|| panic!("{query}: unknown unit {id}"));
            let models = ds
                .unit_compositions
                .iter()
                .find(|c| c.unit_id.as_str() == id)
                .map(|c| wh40kdc::loadout_models(&c.models));
            let lo = if query == "base_loadout" {
                wh40kdc::base_loadout(u, model_count, &ds.wargear_options_of(u), models.as_deref())
            } else {
                wh40kdc::maximal_loadout(
                    u,
                    model_count,
                    &ds.wargear_options_of(u),
                    models.as_deref(),
                )
            };
            let mut encoded: Vec<Value> = lo
                .counts
                .iter()
                .map(|(k, v)| Value::String(format!("{k}:{v}")))
                .collect();
            encoded.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
            Value::Array(encoded)
        }
        "phases_of" => {
            let id = arg_str("abilityId");
            let a = ds
                .abilities
                .get(id)
                .unwrap_or_else(|| panic!("phases_of: unknown ability {id}"));
            Value::Array(
                ds.phases_of(a)
                    .iter()
                    .map(|p| serde_json::to_value(p).expect("Phase serializes"))
                    .collect(),
            )
        }
        "faction_of" => {
            let id = arg_str("unitId");
            let u = ds
                .units
                .get(id)
                .unwrap_or_else(|| panic!("faction_of: unknown unit {id}"));
            ds.faction_of(u)
                .map(|f| Value::String(f.id.to_string()))
                .unwrap_or(Value::Null)
        }
        "abilities_of_faction" => Value::Array(
            ds.abilities_of_faction(arg_str("factionId"))
                .into_iter()
                .map(|a| Value::String(a.ability_id.to_string()))
                .collect(),
        ),
        "weapons_of_faction" => Value::Array(
            ds.weapons_of_faction(arg_str("factionId"))
                .into_iter()
                .map(|w| Value::String(w.id.to_string()))
                .collect(),
        ),
        "logo_url_of_faction" => {
            let id = arg_str("factionId");
            let f = ds
                .factions
                .get(id)
                .unwrap_or_else(|| panic!("logo_url_of_faction: unknown faction {id}"));
            match &f.logo_url {
                Some(url) => Value::String(url.clone()),
                None => Value::Null,
            }
        }
        "base_size_of" => {
            let id = arg_str("unitId");
            let u = ds
                .units
                .get(id)
                .unwrap_or_else(|| panic!("base_size_of: unknown unit {id}"));
            match &u.base_size_mm {
                Some(b) => Value::String(wh40kdc::encode_base_size(b)),
                None => Value::Null,
            }
        }
        "model_bases_of" => {
            let id = arg_str("unitId");
            if ds.units.get(id).is_none() {
                panic!("model_bases_of: unknown unit {id}");
            }
            let comp = ds
                .unit_compositions
                .iter()
                .find(|c| c.unit_id.as_str() == id);
            let pairs: Vec<Value> = comp
                .map(|c| {
                    c.models
                        .iter()
                        .map(|m| {
                            let base = m
                                .base_size_mm
                                .as_ref()
                                .map(wh40kdc::encode_base_size)
                                .unwrap_or_else(|| "none".to_string());
                            Value::String(format!("{}={}", m.name.as_str(), base))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Value::Array(pairs)
        }
        "units_with_keyword" => Value::Array(
            ds.units_with_keyword(arg_str("keyword"))
                .into_iter()
                .map(|u| Value::String(u.id.to_string()))
                .collect(),
        ),
        "allies_for" => {
            let faction_id = arg_str("factionId");
            let detachment_ids: Vec<&str> = args
                .get("detachmentIds")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            Value::Array(
                ds.allies_for(faction_id, &detachment_ids)
                    .into_iter()
                    .map(|r| Value::String(r.id.to_string()))
                    .collect(),
            )
        }
        "ally_units_for" => Value::Array(
            ds.ally_units_for(arg_str("ruleId"))
                .into_iter()
                .map(|u| Value::String(u.id.to_string()))
                .collect(),
        ),
        "reactive_trigger_ability_ids" => {
            let mut ids: Vec<String> = ds
                .reactive_triggers()
                .into_iter()
                .map(|rt| rt.ability_id)
                .collect();
            ids.sort();
            Value::Array(ids.into_iter().map(Value::String).collect())
        }
        "events_with_triggers" => {
            Value::Array(ds.trigger_index().into_keys().map(Value::String).collect())
        }
        "triggers_for_event" => {
            let event = arg_str("event");
            let mut ids: Vec<String> = ds
                .reactive_triggers()
                .into_iter()
                .filter(|rt| rt.event == event)
                .map(|rt| rt.ability_id)
                .collect();
            ids.sort();
            Value::Array(ids.into_iter().map(Value::String).collect())
        }
        other => panic!("unknown linked-api query: {other}"),
    }
}

/// Sort a JSON array of strings in place. Used for `set`-comparison cases so
/// the test ignores incidental iteration order.
fn sort_string_array(v: &mut Value) {
    if let Some(arr) = v.as_array_mut() {
        arr.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
    }
}

#[test]
fn linked_api_corpus_matches_reference() {
    let path = conformance_dir().join("linked-api").join("cases.json");
    let raw =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let cases: Vec<Value> = serde_json::from_str(&raw).expect("cases.json is a JSON array");
    assert!(!cases.is_empty(), "linked-api corpus is empty");

    let ds = Dataset::embedded();
    for case in &cases {
        let name = case["name"].as_str().expect("case.name");
        let query = case["query"].as_str().expect("case.query");
        let comparison = case["comparison"].as_str().expect("case.comparison");
        let args = &case["args"];
        let mut expected = case["expected"].clone();
        let mut actual = run_query(ds, query, args);

        if comparison == "set" {
            sort_string_array(&mut actual);
            sort_string_array(&mut expected);
        }

        assert_eq!(
            actual, expected,
            "linked-api/{query} ({name}): result diverged from TS reference"
        );
    }
}
