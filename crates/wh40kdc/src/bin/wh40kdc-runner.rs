//! NDJSON conformance runner — the Rust implementation of the wire protocol
//! in `conformance/RUNNER_PROTOCOL.md`. Each line on stdin is a JSON request
//! `{op, args?}`; each line on stdout is a JSON response `{ok: true, value}`
//! or `{ok: false, error_kind, error_payload?}`.
//!
//! Structurally parallel to `tools/src/runner.ts`. Library consumers should
//! call the public API directly; this runner exists so the cross-impl differ
//! in `tooling/parity/` has a uniform interface across language ports.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use wh40kdc::cruncher::{
    attribute_stages, crunch, AttackProfileRef, AttributedStage, Buff, BuffSource, EngineContext,
    EngineInput, StageLift, StageName, TargetProfileRef,
};
use wh40kdc::export::{export_roster, ExportFormat};
use wh40kdc::import::{
    import_roster, try_import_roster, AdapterTrial, ImportFailureReason, ImportResult, Roster,
    RosterFormat,
};
use wh40kdc::scoring::{
    add_to_hand, empty_player_game, player_primary, player_secondary, player_total, remove_score,
    score_cap, score_primary_event, score_secondary, score_secondary_event, score_turn,
    set_primary, wtc_result, AssertedAward, ScoringMode,
};
use wh40kdc::share::{decode_share_token, encode_share_token, ShareList};
use wh40kdc::{
    describe_ability_parts, describe_scoring_card, normalize_name, Dataset, Phase, SecondaryCard,
};

// ---------------------------------------------------------------------------
// Spec version + impl identity.
// ---------------------------------------------------------------------------

const IMPL_NAME: &str = "rust";
const IMPL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Walk up from `CARGO_MANIFEST_DIR` to find the `conformance/SPEC_VERSION`
/// file in the source tree. Mirrors the TS runner's parent-walk; lets the
/// binary work both from `cargo run` (manifest-relative) and a built artifact
/// (parent-relative, when the conformance dir is shipped alongside).
fn load_spec_version() -> i64 {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for ancestor in manifest.ancestors() {
        let candidate = ancestor.join("conformance").join("SPEC_VERSION");
        if let Ok(s) = std::fs::read_to_string(&candidate) {
            if let Ok(n) = s.trim().parse::<i64>() {
                return n;
            }
        }
    }
    panic!("could not locate conformance/SPEC_VERSION");
}

// ---------------------------------------------------------------------------
// Response envelope (hand-serialized to keep the JSON shape exactly matching
// the TS runner: ok-tagged with optional error_payload).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum ErrorKind {
    InvalidInput,
    UnknownOp,
    UnknownEntity,
    ImportFailed,
    ExportFailed,
    #[allow(dead_code)] // Reserved for a future Rust validator.
    ValidationError,
    CrunchError,
    #[allow(dead_code)]
    InternalError,
}

impl ErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            ErrorKind::InvalidInput => "INVALID_INPUT",
            ErrorKind::UnknownOp => "UNKNOWN_OP",
            ErrorKind::UnknownEntity => "UNKNOWN_ENTITY",
            ErrorKind::ImportFailed => "IMPORT_FAILED",
            ErrorKind::ExportFailed => "EXPORT_FAILED",
            ErrorKind::ValidationError => "VALIDATION_ERROR",
            ErrorKind::CrunchError => "CRUNCH_ERROR",
            ErrorKind::InternalError => "INTERNAL_ERROR",
        }
    }
}

fn ok_value(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn err_value(kind: ErrorKind, payload: Option<Value>) -> Value {
    match payload {
        Some(p) => json!({ "ok": false, "error_kind": kind.as_str(), "error_payload": p }),
        None => json!({ "ok": false, "error_kind": kind.as_str() }),
    }
}

// ---------------------------------------------------------------------------
// Runner state. Init must come first; ops error with INVALID_INPUT before
// init. Dataset is &'static; no lifetime juggling needed.
// ---------------------------------------------------------------------------

struct RunnerState {
    initialized: bool,
    spec_version: i64,
    dataset: Option<&'static Dataset>,
}

impl RunnerState {
    fn new(spec_version: i64) -> Self {
        Self {
            initialized: false,
            spec_version,
            dataset: None,
        }
    }

    fn dataset(&mut self) -> &'static Dataset {
        let ds = self.dataset.get_or_insert_with(Dataset::embedded);
        *ds
    }
}

// ---------------------------------------------------------------------------
// Op handlers.
// ---------------------------------------------------------------------------

fn handle_init(state: &mut RunnerState, args: &Value) -> Value {
    if state.initialized {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "init called twice" })),
        );
    }
    if !args.is_object() {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "init args must be an object" })),
        );
    }
    let spec_version = args.get("spec_version").and_then(Value::as_i64);
    if spec_version != Some(state.spec_version) {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({
                "detail": format!(
                    "spec_version mismatch: runner={}, request={}",
                    state.spec_version,
                    spec_version.map(|n| n.to_string()).unwrap_or_else(|| "null".to_string()),
                ),
            })),
        );
    }
    let locale = args.get("locale").and_then(Value::as_str);
    if locale != Some("C") {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({
                "detail": format!(
                    "unsupported locale: {} (only \"C\")",
                    locale.unwrap_or("null"),
                ),
            })),
        );
    }
    let tz = args.get("tz").and_then(Value::as_str);
    if tz != Some("UTC") {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({
                "detail": format!("unsupported tz: {} (only \"UTC\")", tz.unwrap_or("null")),
            })),
        );
    }
    if !args.get("seed").map(Value::is_number).unwrap_or(false) {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "seed must be a number" })),
        );
    }
    state.initialized = true;
    ok_value(json!({
        "impl": IMPL_NAME,
        "spec_version": state.spec_version,
        "impl_version": IMPL_VERSION,
    }))
}

fn handle_normalize(args: &Value) -> Value {
    let Some(input) = args.get("input").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "normalize.input must be a string" })),
        );
    };
    ok_value(Value::String(normalize_name(input)))
}

/// Mirror the TS runner's import-decode behavior: if the input string looks
/// like JSON (starts with `{` or `[`), parse it; otherwise wrap the raw
/// string. `import_roster` then dispatches on the resulting Value (text
/// adapters match `Value::String`; JSON adapters match `Object`/`Array`).
fn handle_import(state: &mut RunnerState, args: &Value) -> Value {
    let Some(input) = args.get("input").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "import.input must be a string" })),
        );
    };
    let trimmed = input.trim_start();
    let decoded: Value = if trimmed.starts_with('{') || trimmed.starts_with('[') {
        serde_json::from_str(input).unwrap_or_else(|_| Value::String(input.to_string()))
    } else {
        Value::String(input.to_string())
    };
    match import_roster(&decoded, state.dataset()) {
        Ok(roster) => match serde_json::to_value(&roster) {
            Ok(v) => ok_value(v),
            Err(e) => err_value(
                ErrorKind::ImportFailed,
                Some(json!({ "detail": e.to_string() })),
            ),
        },
        Err(e) => err_value(
            ErrorKind::ImportFailed,
            Some(json!({
                "detail": e.to_string(),
                "format": args.get("format").cloned().unwrap_or(Value::Null),
            })),
        ),
    }
}

fn handle_try_import(state: &mut RunnerState, args: &Value) -> Value {
    let Some(input) = args.get("input").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "try_import.input must be a string" })),
        );
    };
    let ds = state.dataset();
    match try_import_roster(input, ds) {
        ImportResult::Ok { roster, format } => {
            let roster_v = serde_json::to_value(&roster).unwrap_or(Value::Null);
            let format_s = roster_format_str(format);
            ok_value(json!({ "format": format_s, "roster": roster_v }))
        }
        ImportResult::Err {
            reason,
            message,
            trials,
        } => err_value(
            ErrorKind::ImportFailed,
            Some(json!({
                "reason": import_failure_reason_str(&reason),
                "message": message,
                "trials": trials.into_iter().map(adapter_trial_to_value).collect::<Vec<_>>(),
            })),
        ),
    }
}

fn roster_format_str(f: RosterFormat) -> &'static str {
    match f {
        RosterFormat::Listforge => "listforge",
        RosterFormat::NewrecruitJson => "newrecruit-json",
        RosterFormat::NewrecruitWtcCompact => "newrecruit-wtc-compact",
        RosterFormat::NewrecruitWtcFull => "newrecruit-wtc-full",
        RosterFormat::NewrecruitSimple => "newrecruit-simple",
        RosterFormat::Rosterizer => "rosterizer",
        RosterFormat::Gw => "gw",
        RosterFormat::ListforgeText => "listforge-text",
        RosterFormat::RosterJson => "roster-json",
    }
}

fn import_failure_reason_str(r: &ImportFailureReason) -> &'static str {
    match r {
        ImportFailureReason::EmptyInput => "empty-input",
        ImportFailureReason::DecodeFailed => "decode-failed",
        ImportFailureReason::NoAdapterMatched => "no-adapter-matched",
        ImportFailureReason::ParseFailed => "parse-failed",
    }
}

fn adapter_trial_to_value(t: AdapterTrial) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "id".to_string(),
        Value::String(roster_format_str(t.id).to_string()),
    );
    obj.insert("matched".to_string(), Value::Bool(t.matched));
    if let Some(r) = t.reason {
        obj.insert("reason".to_string(), Value::String(r));
    }
    Value::Object(obj)
}

fn handle_export(state: &mut RunnerState, args: &Value) -> Value {
    let Some(format_s) = args.get("format").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "export.format must be a string" })),
        );
    };
    let format = match format_s {
        "newrecruit-json" => ExportFormat::NewrecruitJson,
        "newrecruit-wtc-compact" => ExportFormat::NewrecruitWtcCompact,
        "newrecruit-wtc-full" => ExportFormat::NewrecruitWtcFull,
        "newrecruit-simple" => ExportFormat::NewrecruitSimple,
        "roster-json" => ExportFormat::RosterJson,
        "rosterizer" => ExportFormat::Rosterizer,
        "atc-2026-compact" => ExportFormat::Atc2026Compact,
        "atc-2026-full" => ExportFormat::Atc2026Full,
        other => {
            return err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": format!("unknown export format: {other}") })),
            );
        }
    };
    let Some(roster_v) = args.get("roster") else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "export.roster must be present" })),
        );
    };
    let roster: Roster = match serde_json::from_value(roster_v.clone()) {
        Ok(r) => r,
        Err(e) => {
            return err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": format!("export.roster is not a valid Roster: {e}") })),
            );
        }
    };
    let _ = state; // dataset not needed for export — kept for handler symmetry
    match std::panic::catch_unwind(|| export_roster(&roster, format)) {
        Ok(s) => ok_value(Value::String(s)),
        Err(_) => err_value(
            ErrorKind::ExportFailed,
            Some(json!({ "detail": "exporter panicked" })),
        ),
    }
}

fn handle_share_encode(args: &Value) -> Value {
    let Some(list_v) = args.get("list") else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "share_encode.list must be present" })),
        );
    };
    let list: ShareList = match serde_json::from_value(list_v.clone()) {
        Ok(l) => l,
        Err(e) => {
            return err_value(
                ErrorKind::InvalidInput,
                Some(
                    json!({ "detail": format!("share_encode.list is not a valid ShareList: {e}") }),
                ),
            );
        }
    };
    match encode_share_token(&list) {
        Ok(token) => ok_value(Value::String(token)),
        // The only expected failure is an id absent from the embedded registry.
        Err(e) => err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": e.to_string() })),
        ),
    }
}

fn handle_share_decode(args: &Value) -> Value {
    let Some(token) = args.get("token").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "share_decode.token must be a string" })),
        );
    };
    // A malformed/stale token is a normal result (the inner `ok` carries it),
    // not a protocol error — mirror the TS handler.
    match serde_json::to_value(decode_share_token(token)) {
        Ok(v) => ok_value(v),
        Err(e) => err_value(
            ErrorKind::InternalError,
            Some(json!({ "detail": e.to_string() })),
        ),
    }
}

/// Whole-unit loadout legality (tier-aware) — mirror of the TS
/// `check_unit_legality` runner op. Returns sorted `"code:id"` strings.
fn handle_check_unit_legality(state: &mut RunnerState, args: &Value) -> Value {
    let Some(unit_id) = args.get("unitId").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "check_unit_legality.unitId required" })),
        );
    };
    let Some(model_count) = args.get("modelCount").and_then(Value::as_u64) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "check_unit_legality.modelCount required" })),
        );
    };
    let faction_id = args.get("factionId").and_then(Value::as_str);
    let ds = state.dataset();
    // Resolve the unit in its faction when pinned (shared chassis diverge per
    // faction in options/composition); else first-wins by id.
    let unit = match faction_id {
        Some(fid) => ds
            .units
            .by_faction(fid)
            .into_iter()
            .find(|u| u.id.as_str() == unit_id),
        None => ds.units.get(unit_id),
    };
    let Some(unit) = unit else {
        return err_value(
            ErrorKind::UnknownEntity,
            Some(json!({ "kind": "unit", "id": unit_id })),
        );
    };
    let comp = ds.unit_compositions.iter().find(|c| {
        c.unit_id.as_str() == unit_id && c.faction_id.as_str() == unit.faction_id.as_str()
    });
    let models = comp.map(|c| wh40kdc::loadout_models(&c.models));
    let tiers = comp.map(|c| wh40kdc::loadout_tiers(&c.tiers));
    let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    if let Some(obj) = args.get("counts").and_then(Value::as_object) {
        for (k, v) in obj {
            if let Some(n) = v.as_i64() {
                counts.insert(k.clone(), n);
            }
        }
    }
    let violations = wh40kdc::check_unit_legality(
        unit,
        model_count,
        &ds.wargear_options_of(unit),
        &counts,
        models.as_deref(),
        tiers.as_deref(),
    );
    let mut encoded: Vec<Value> = violations
        .iter()
        .map(|v| Value::String(format!("{}:{}", v.code.as_str(), v.id)))
        .collect();
    encoded.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
    ok_value(Value::Array(encoded))
}

/// Parse a battle-size label into the importer's [`BattleSize`]; `None` for an
/// absent or unrecognised value (matches the TS `battleSize as BattleSize | null`).
fn parse_battle_size(args: &Value, key: &str) -> Option<wh40kdc::import::BattleSize> {
    match args.get(key).and_then(Value::as_str) {
        Some("strike-force") => Some(wh40kdc::import::BattleSize::StrikeForce),
        Some("incursion") => Some(wh40kdc::import::BattleSize::Incursion),
        _ => None,
    }
}

/// Whole-army legality over a compact roster spec — mirror of the TS
/// `check_roster_legality` runner op. Returns the sorted union of per-unit
/// loadout and army violations as `"<scope>|<severity>|<code>:<id>"` strings.
fn handle_check_roster_legality(state: &mut RunnerState, args: &Value) -> Value {
    if !args.is_object() {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "check_roster_legality args must be an object" })),
        );
    }
    let Some(units_in) = args.get("units").and_then(Value::as_array) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "check_roster_legality.units must be an array" })),
        );
    };

    let detachment_ids: Vec<String> = args
        .get("detachments")
        .and_then(Value::as_array)
        .map(|ds| {
            ds.iter()
                .filter_map(|d| d.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let units: Vec<wh40kdc::NormUnit> = units_in
        .iter()
        .map(|u| {
            let mut counts: std::collections::HashMap<String, i64> =
                std::collections::HashMap::new();
            if let Some(obj) = u.get("counts").and_then(Value::as_object) {
                for (k, v) in obj {
                    if let Some(n) = v.as_i64() {
                        counts.insert(k.clone(), n);
                    }
                }
            }
            wh40kdc::NormUnit {
                unit_id: u
                    .get("unitId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                model_count: u.get("modelCount").and_then(Value::as_u64).unwrap_or(0),
                is_warlord: u.get("isWarlord").and_then(Value::as_bool).unwrap_or(false),
                enhancement_id: u
                    .get("enhancementId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                leader_bodyguard_id: u
                    .get("leaderBodyguardId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                counts,
            }
        })
        .collect();

    let spec = wh40kdc::NormRoster {
        faction_id: args
            .get("factionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        battle_size: parse_battle_size(args, "battleSize"),
        force_disposition: args
            .get("forceDisposition")
            .and_then(Value::as_str)
            .map(str::to_string),
        detachment_ids,
        units,
    };

    let result = wh40kdc::validate_roster_core(&spec, state.dataset());
    let mut lines: Vec<String> = Vec::new();
    for u in &result.units {
        for v in &u.violations {
            lines.push(format!(
                "u{}|error|{}:{}",
                u.unit_index,
                v.code.as_str(),
                v.id
            ));
        }
    }
    for v in &result.army {
        let scope = match v.unit_index {
            Some(i) => format!("u{i}"),
            None => "army".to_string(),
        };
        lines.push(format!(
            "{}|{}|{}:{}",
            scope,
            v.severity.as_str(),
            v.code.as_str(),
            v.id
        ));
    }
    lines.sort();
    ok_value(Value::Array(lines.into_iter().map(Value::String).collect()))
}

/// Cheapest-next-copy pricing + affordability for a set of candidate units —
/// mirror of the TS `candidate_affordability` runner op. Returns
/// `[{unitId, nextCopyCost, affordable}]` sorted ascending by `(nextCopyCost, unitId)`.
fn handle_candidate_affordability(state: &mut RunnerState, args: &Value) -> Value {
    if !args.is_object() {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "candidate_affordability args must be an object" })),
        );
    }
    let Some(units_in) = args.get("units").and_then(Value::as_array) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "candidate_affordability.units must be an array" })),
        );
    };

    let units: Vec<wh40kdc::AffordabilityUnit> = units_in
        .iter()
        .map(|u| wh40kdc::AffordabilityUnit {
            unit_id: u
                .get("unitId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            model_count: u.get("modelCount").and_then(Value::as_u64).unwrap_or(0),
            enhancement_id: u
                .get("enhancementId")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
        .collect();

    let candidate_unit_ids: Option<Vec<String>> = args
        .get("candidateUnitIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        });

    let spec = wh40kdc::AffordabilitySpec {
        faction_id: args
            .get("factionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        battle_size: parse_battle_size(args, "battleSize"),
        points_limit_override: args.get("pointsLimitOverride").and_then(Value::as_u64),
        units,
        candidate_unit_ids,
    };

    let out = wh40kdc::candidate_affordability(&spec, state.dataset());
    let arr: Vec<Value> = out
        .into_iter()
        .map(|c| {
            json!({
                "unitId": c.unit_id,
                "nextCopyCost": c.next_copy_cost,
                "affordable": c.affordable,
            })
        })
        .collect();
    ok_value(Value::Array(arr))
}

fn handle_linked_query(state: &mut RunnerState, args: &Value) -> Value {
    let Some(query) = args.get("query").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "linked_query.query must be a string" })),
        );
    };
    let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
    let str_arg = |k: &str| -> &str { input.get(k).and_then(Value::as_str).unwrap_or("") };
    let ds = state.dataset();
    match query {
        "find_unit" => ok_value(match ds.find_unit(str_arg("query")) {
            Some(u) => Value::String(u.id.to_string()),
            None => Value::Null,
        }),
        "find_weapon" => ok_value(match ds.find_weapon(str_arg("query")) {
            Some(w) => Value::String(w.id.to_string()),
            None => Value::Null,
        }),
        "find_faction" => ok_value(match ds.find_faction(str_arg("query")) {
            Some(f) => Value::String(f.id.to_string()),
            None => Value::Null,
        }),
        "find_ability" => ok_value(match ds.find_ability(str_arg("query")) {
            Some(a) => Value::String(a.ability_id.to_string()),
            None => Value::Null,
        }),
        "abilities_of" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            ok_value(Value::Array(
                ds.abilities_of(unit)
                    .into_iter()
                    .map(|a| Value::String(a.ability_id.to_string()))
                    .collect(),
            ))
        }
        "weapons_of" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            ok_value(Value::Array(
                ds.weapons_of(unit)
                    .into_iter()
                    .map(|w| Value::String(w.id.to_string()))
                    .collect(),
            ))
        }
        "wargear_options_of" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            ok_value(Value::Array(
                ds.wargear_options_of(unit)
                    .into_iter()
                    .map(|o| Value::String(o.id.to_string()))
                    .collect(),
            ))
        }
        "base_loadout" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            let model_count: u64 = str_arg("modelCount").parse().unwrap_or(0);
            let models = ds
                .unit_compositions
                .iter()
                .find(|c| c.unit_id.as_str() == id)
                .map(|c| wh40kdc::loadout_models(&c.models));
            let lo = wh40kdc::base_loadout(
                unit,
                model_count,
                &ds.wargear_options_of(unit),
                models.as_deref(),
            );
            let mut encoded: Vec<Value> = lo
                .counts
                .iter()
                .map(|(k, v)| Value::String(format!("{k}:{v}")))
                .collect();
            encoded.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
            ok_value(Value::Array(encoded))
        }
        "maximal_loadout" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            let model_count: u64 = str_arg("modelCount").parse().unwrap_or(0);
            let models = ds
                .unit_compositions
                .iter()
                .find(|c| c.unit_id.as_str() == id)
                .map(|c| wh40kdc::loadout_models(&c.models));
            let lo = wh40kdc::maximal_loadout(
                unit,
                model_count,
                &ds.wargear_options_of(unit),
                models.as_deref(),
            );
            let mut encoded: Vec<Value> = lo
                .counts
                .iter()
                .map(|(k, v)| Value::String(format!("{k}:{v}")))
                .collect();
            encoded.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
            ok_value(Value::Array(encoded))
        }
        "phases_of" => {
            let id = str_arg("abilityId");
            let Some(ability) = ds.abilities.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "ability", "id": id })),
                );
            };
            ok_value(Value::Array(
                ds.phases_of(ability)
                    .iter()
                    .map(|p| Value::String(phase_str(*p).to_string()))
                    .collect(),
            ))
        }
        "faction_of" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            ok_value(match ds.faction_of(unit) {
                Some(f) => Value::String(f.id.to_string()),
                None => Value::Null,
            })
        }
        "base_size_of" => {
            let id = str_arg("unitId");
            let Some(unit) = ds.units.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
            };
            ok_value(match &unit.base_size_mm {
                Some(b) => Value::String(encode_base(b)),
                None => Value::Null,
            })
        }
        "model_bases_of" => {
            let id = str_arg("unitId");
            if ds.units.get(id).is_none() {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "unit", "id": id })),
                );
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
                                .map(encode_base)
                                .unwrap_or_else(|| "none".to_string());
                            Value::String(format!("{}={}", m.name.as_str(), base))
                        })
                        .collect()
                })
                .unwrap_or_default();
            ok_value(Value::Array(pairs))
        }
        "abilities_of_faction" => {
            let id = str_arg("factionId");
            ok_value(Value::Array(
                ds.abilities_of_faction(id)
                    .into_iter()
                    .map(|a| Value::String(a.ability_id.to_string()))
                    .collect(),
            ))
        }
        "weapons_of_faction" => {
            let id = str_arg("factionId");
            if ds.factions.get(id).is_none() {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "faction", "id": id })),
                );
            }
            ok_value(Value::Array(
                ds.weapons_of_faction(id)
                    .into_iter()
                    .map(|w| Value::String(w.id.to_string()))
                    .collect(),
            ))
        }
        "logo_url_of_faction" => {
            let id = str_arg("factionId");
            let Some(faction) = ds.factions.get(id) else {
                return err_value(
                    ErrorKind::UnknownEntity,
                    Some(json!({ "kind": "faction", "id": id })),
                );
            };
            ok_value(match &faction.logo_url {
                Some(url) => Value::String(url.clone()),
                None => Value::Null,
            })
        }
        "units_with_keyword" => {
            let kw = str_arg("keyword");
            ok_value(Value::Array(
                ds.units_with_keyword(kw)
                    .into_iter()
                    .map(|u| Value::String(u.id.to_string()))
                    .collect(),
            ))
        }
        "allies_for" => {
            let faction_id = str_arg("factionId");
            let detachment_ids: Vec<&str> = input
                .get("detachmentIds")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            ok_value(Value::Array(
                ds.allies_for(faction_id, &detachment_ids)
                    .into_iter()
                    .map(|r| Value::String(r.id.to_string()))
                    .collect(),
            ))
        }
        "ally_units_for" => {
            let rule_id = str_arg("ruleId");
            ok_value(Value::Array(
                ds.ally_units_for(rule_id)
                    .into_iter()
                    .map(|u| Value::String(u.id.to_string()))
                    .collect(),
            ))
        }
        "reactive_trigger_ability_ids" => {
            let mut ids: Vec<String> = ds
                .reactive_triggers()
                .into_iter()
                .map(|rt| rt.ability_id)
                .collect();
            ids.sort();
            ok_value(Value::Array(ids.into_iter().map(Value::String).collect()))
        }
        "events_with_triggers" => {
            // BTreeMap keys are already ascending and distinct.
            ok_value(Value::Array(
                ds.trigger_index().into_keys().map(Value::String).collect(),
            ))
        }
        "triggers_for_event" => {
            let event = str_arg("event");
            let mut ids: Vec<String> = ds
                .reactive_triggers()
                .into_iter()
                .filter(|rt| rt.event == event)
                .map(|rt| rt.ability_id)
                .collect();
            ids.sort();
            ok_value(Value::Array(ids.into_iter().map(Value::String).collect()))
        }
        other => err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": format!("unknown linked_query: {other}") })),
        ),
    }
}

fn phase_str(p: Phase) -> &'static str {
    match p {
        Phase::Command => "command",
        Phase::Movement => "movement",
        Phase::Shooting => "shooting",
        Phase::Charge => "charge",
        Phase::Fight => "fight",
    }
}

use wh40kdc::encode_base_size as encode_base;

/// Validate `args.value` against the named schema `args.target`, returning the
/// closed-enum `(path, code)` errors (empty list = valid).
fn handle_validate(args: &Value) -> Value {
    let Some(target) = args.get("target").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "validate.target must be a string" })),
        );
    };
    if !wh40kdc::validator_has_target(target) {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": format!("unknown validator target: {target}") })),
        );
    }
    let value = args.get("value").cloned().unwrap_or(Value::Null);
    ok_value(Value::Array(wh40kdc::validate_target(target, &value)))
}

/// Wire shape for the `crunch` and `attribution` args. Both ops take the same
/// envelope (`buildEngineInput` in TS); separating it keeps each handler thin.
#[derive(serde::Deserialize)]
struct CrunchArgs {
    attacker: Option<AttackerSpec>,
    #[serde(rename = "modelsFiring")]
    models_firing: Option<u64>,
    target: Option<TargetSpec>,
    context: Option<EngineContext>,
    #[serde(default)]
    buffs: Vec<Buff>,
    #[serde(default)]
    epsilon: Option<f64>,
}

#[derive(serde::Deserialize)]
struct AttackerSpec {
    #[serde(rename = "weaponId")]
    weapon_id: String,
    #[serde(rename = "profileIndex")]
    profile_index: usize,
}

#[derive(serde::Deserialize)]
struct TargetSpec {
    #[serde(rename = "unitId")]
    unit_id: String,
    #[serde(rename = "profileIndex")]
    profile_index: usize,
    #[serde(rename = "modelCount", default)]
    model_count: Option<u64>,
}

/// Build a borrowed [`EngineInput`] from the wire args. The returned input
/// borrows from the dataset, so callers consume it immediately. Returns the
/// pre-built error envelope on validation/lookup failures.
fn build_engine_input<'a>(
    ds: &'a Dataset,
    args: &Value,
    op_name: &str,
) -> Result<(EngineInput<'a>, Option<f64>), Value> {
    let parsed: CrunchArgs = serde_json::from_value(args.clone()).map_err(|e| {
        err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": format!("{op_name} args: {e}") })),
        )
    })?;
    let attacker = parsed.attacker.ok_or_else(|| {
        err_value(
            ErrorKind::InvalidInput,
            Some(json!({
                "detail": format!("{op_name}.attacker.weaponId/profileIndex required"),
            })),
        )
    })?;
    let target = parsed.target.ok_or_else(|| {
        err_value(
            ErrorKind::InvalidInput,
            Some(json!({
                "detail": format!("{op_name}.target.unitId/profileIndex required"),
            })),
        )
    })?;
    let models_firing = parsed.models_firing.ok_or_else(|| {
        err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": format!("{op_name}.modelsFiring required") })),
        )
    })?;
    let context = parsed.context.ok_or_else(|| {
        err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": format!("{op_name}.context required") })),
        )
    })?;
    let weapon = ds.weapons.get(&attacker.weapon_id).ok_or_else(|| {
        err_value(
            ErrorKind::UnknownEntity,
            Some(json!({ "kind": "weapon", "id": attacker.weapon_id })),
        )
    })?;
    let unit = ds.units.get(&target.unit_id).ok_or_else(|| {
        err_value(
            ErrorKind::UnknownEntity,
            Some(json!({ "kind": "unit", "id": target.unit_id })),
        )
    })?;
    let input = EngineInput {
        attacker: AttackProfileRef {
            weapon,
            profile_index: attacker.profile_index,
        },
        target: TargetProfileRef {
            unit,
            profile_index: target.profile_index,
            model_count: target.model_count,
        },
        models_firing,
        buffs: parsed.buffs,
        context,
    };
    Ok((input, parsed.epsilon))
}

/// Canonical wire shape for one stage: `{name, expected}`. Matches the TS
/// runner's trimmed crunch output — neither `detail` strings nor the
/// `resolved` modifier block are stable across implementations.
#[derive(Serialize)]
struct WireStage {
    name: StageName,
    expected: f64,
}

fn handle_crunch(state: &mut RunnerState, args: &Value) -> Value {
    let ds = state.dataset();
    let (input, _eps) = match build_engine_input(ds, args, "crunch") {
        Ok(x) => x,
        Err(e) => return e,
    };
    match crunch(&input, Some(ds)) {
        Ok(out) => {
            let stages: Vec<WireStage> = out
                .stages
                .iter()
                .map(|s| WireStage {
                    name: s.name,
                    expected: s.expected,
                })
                .collect();
            ok_value(json!({ "stages": stages }))
        }
        Err(e) => err_value(
            ErrorKind::CrunchError,
            Some(json!({ "detail": e.to_string() })),
        ),
    }
}

/// Wire-shape for `attribution`: drop `detail`, keep every numeric and the
/// kind-tagged BuffSource that's already serde-compatible.
#[derive(Serialize)]
struct WireAttributedStage<'a> {
    name: StageName,
    expected: f64,
    baseline: f64,
    lifts: Vec<WireLift<'a>>,
    residual: f64,
    intrinsics: &'a [String],
}

#[derive(Serialize)]
struct WireLift<'a> {
    source: &'a BuffSource,
    delta: f64,
}

fn project_attribution(stages: &[AttributedStage]) -> Vec<WireAttributedStage<'_>> {
    stages
        .iter()
        .map(|s| WireAttributedStage {
            name: s.name,
            expected: s.expected,
            baseline: s.baseline,
            lifts: s
                .lifts
                .iter()
                .map(|l: &StageLift| WireLift {
                    source: &l.source,
                    delta: l.delta,
                })
                .collect(),
            residual: s.residual,
            intrinsics: &s.intrinsics,
        })
        .collect()
}

fn handle_attribution(state: &mut RunnerState, args: &Value) -> Value {
    let ds = state.dataset();
    let (input, epsilon) = match build_engine_input(ds, args, "attribution") {
        Ok(x) => x,
        Err(e) => return e,
    };
    match attribute_stages(&input, Some(ds), epsilon) {
        Ok(stages) => {
            let wire = project_attribution(&stages);
            ok_value(serde_json::to_value(&wire).unwrap_or(Value::Null))
        }
        Err(e) => err_value(
            ErrorKind::CrunchError,
            Some(json!({ "detail": e.to_string() })),
        ),
    }
}

fn handle_translate_scoring(state: &mut RunnerState, args: &Value) -> Value {
    let Some(card_id) = args.get("cardId").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "translate_scoring.cardId must be a string" })),
        );
    };
    let ds = state.dataset();
    match ds.mission_cards.get(card_id) {
        Some(card) => ok_value(json!({ "awards": describe_scoring_card(card) })),
        None => err_value(
            ErrorKind::UnknownEntity,
            Some(json!({ "kind": "secondary-card", "id": card_id })),
        ),
    }
}

fn handle_translate_effect(args: &Value) -> Value {
    let Some(effect_value) = args.get("effect") else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "translate_effect.effect must be an object" })),
        );
    };
    let effect: wh40kdc::EffectNode = match serde_json::from_value(effect_value.clone()) {
        Ok(e) => e,
        Err(e) => {
            return err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": format!("translate_effect.effect did not parse: {e}") })),
            )
        }
    };
    let scope: Option<wh40kdc::Scope> = args
        .get("scope")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let applies_to: Option<wh40kdc::AbilityAppliesTo> = args
        .get("applies_to")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let usage: Option<wh40kdc::AbilityUsage> = args
        .get("usage")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let trigger: Option<wh40kdc::AbilityTrigger> = args
        .get("trigger")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    ok_value(json!({
        "text": describe_ability_parts(
            &effect,
            scope.as_ref(),
            applies_to.as_ref(),
            usage.as_ref(),
            trigger.as_ref(),
        )
    }))
}

fn handle_match_applies_to(args: &Value) -> Value {
    let Some(units) = args.get("units").and_then(Value::as_array) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "match_applies_to.units must be an array" })),
        );
    };
    let filter: Option<wh40kdc::AbilityAppliesTo> = args
        .get("applies_to")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let mut matched_ids: Vec<String> = Vec::new();
    for unit in units {
        let mut owned: Vec<String> = Vec::new();
        for key in ["keywords", "faction_keywords"] {
            if let Some(arr) = unit.get(key).and_then(Value::as_array) {
                owned.extend(arr.iter().filter_map(|kw| kw.as_str().map(str::to_string)));
            }
        }
        if wh40kdc::unit_matches_applies_to(filter.as_ref(), owned.iter().map(String::as_str)) {
            if let Some(id) = unit.get("id").and_then(Value::as_str) {
                matched_ids.push(id.to_string());
            }
        }
    }
    ok_value(json!({ "matchedIds": matched_ids }))
}

// ---------------------------------------------------------------------------
// Scoring engine ops. Awards are referenced by index into a card's `awards`
// array (never serialized over the wire); both impls reconstruct the same
// `AssertedAward` from the shared embedded dataset.
// ---------------------------------------------------------------------------

fn parse_mode(s: &str) -> Option<ScoringMode> {
    match s {
        "fixed" => Some(ScoringMode::Fixed),
        "tactical" => Some(ScoringMode::Tactical),
        _ => None,
    }
}

/// Resolve `[{index, count?}]` against a card's `awards`, or a typed error. The
/// index addresses the full `awards` array (approach affects only the cap).
fn resolve_asserted(card: &SecondaryCard, asserted: &Value) -> Result<Vec<AssertedAward>, Value> {
    let Some(arr) = asserted.as_array() else {
        return Err(err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "asserted must be an array" })),
        ));
    };
    let n = card.awards.len();
    let mut out = Vec::with_capacity(arr.len());
    for raw in arr {
        let Some(idx) = raw.get("index").and_then(Value::as_u64) else {
            return Err(err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": "asserted.index must be a number" })),
            ));
        };
        let idx = idx as usize;
        if idx >= n {
            return Err(err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": format!("asserted.index out of range: {idx}") })),
            ));
        }
        out.push(AssertedAward {
            award: card.awards[idx].clone(),
            count: raw.get("count").and_then(Value::as_u64),
        });
    }
    Ok(out)
}

fn optional_caps(op: &Value) -> (Option<u64>, Option<u64>) {
    (
        op.get("roundCap").and_then(Value::as_u64),
        op.get("gameCap").and_then(Value::as_u64),
    )
}

fn handle_score_event(state: &mut RunnerState, args: &Value) -> Value {
    let Some(card_id) = args.get("cardId").and_then(Value::as_str) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "score_event.cardId must be a string" })),
        );
    };
    let Some(approach) = args
        .get("approach")
        .and_then(Value::as_str)
        .and_then(parse_mode)
    else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "score_event.approach must be 'fixed' or 'tactical'" })),
        );
    };
    let ds = state.dataset();
    let Some(card) = ds.mission_cards.get(card_id) else {
        return err_value(
            ErrorKind::UnknownEntity,
            Some(json!({ "kind": "secondary-card", "id": card_id })),
        );
    };
    let asserted = match resolve_asserted(card, args.get("asserted").unwrap_or(&Value::Null)) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let turn = score_turn(&asserted);
    let cap = score_cap(card, approach);
    let banked = score_secondary_event(&asserted, card, approach);
    let mut value = serde_json::Map::new();
    value.insert("turn".into(), json!(turn));
    // Infinity (uncapped fixed) has no JSON form — null means "no cap".
    value.insert("cap".into(), cap.map(|c| json!(c)).unwrap_or(Value::Null));
    value.insert("banked".into(), json!(banked));
    if let Some(round_cap) = args.get("roundCap").and_then(Value::as_u64) {
        value.insert(
            "primaryBanked".into(),
            json!(score_primary_event(&asserted, round_cap)),
        );
    }
    ok_value(Value::Object(value))
}

fn handle_score_state(state: &mut RunnerState, args: &Value) -> Value {
    let Some(approach) = args
        .get("approach")
        .and_then(Value::as_str)
        .and_then(parse_mode)
    else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "score_state.approach must be 'fixed' or 'tactical'" })),
        );
    };
    let Some(ops) = args.get("ops").and_then(Value::as_array) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "score_state.ops must be an array" })),
        );
    };
    let ds = state.dataset();
    let mut pg = empty_player_game(approach);
    for op in ops {
        let kind = op.get("kind").and_then(Value::as_str).unwrap_or("");
        match kind {
            "draw" => {
                let Some(cid) = op.get("cardId").and_then(Value::as_str) else {
                    return err_value(
                        ErrorKind::InvalidInput,
                        Some(json!({ "detail": "draw.cardId must be a string" })),
                    );
                };
                pg = add_to_hand(&pg, cid);
            }
            "score-secondary" | "score-primary" => {
                let (Some(cid), Some(round)) = (
                    op.get("cardId").and_then(Value::as_str),
                    op.get("round").and_then(Value::as_u64),
                ) else {
                    return err_value(
                        ErrorKind::InvalidInput,
                        Some(json!({ "detail": format!("{kind} needs cardId and round") })),
                    );
                };
                let Some(card) = ds.mission_cards.get(cid) else {
                    return err_value(
                        ErrorKind::UnknownEntity,
                        Some(json!({ "kind": "secondary-card", "id": cid })),
                    );
                };
                let asserted =
                    match resolve_asserted(card, op.get("asserted").unwrap_or(&Value::Null)) {
                        Ok(a) => a,
                        Err(e) => return e,
                    };
                if kind == "score-secondary" {
                    let vp = score_secondary_event(&asserted, card, pg.approach);
                    pg = score_secondary(&pg, round, cid, vp);
                } else {
                    // The app path: compute the round's raw total, then clamp on store.
                    let (rc, gc) = optional_caps(op);
                    pg = set_primary(&pg, round, score_turn(&asserted), rc, gc);
                }
            }
            "set-primary" => {
                let (Some(round), Some(vp)) = (
                    op.get("round").and_then(Value::as_u64),
                    op.get("vp").and_then(Value::as_u64),
                ) else {
                    return err_value(
                        ErrorKind::InvalidInput,
                        Some(json!({ "detail": "set-primary needs round and vp" })),
                    );
                };
                let (rc, gc) = optional_caps(op);
                pg = set_primary(&pg, round, vp, rc, gc);
            }
            "remove-score" => {
                let Some(index) = op.get("index").and_then(Value::as_u64) else {
                    return err_value(
                        ErrorKind::InvalidInput,
                        Some(json!({ "detail": "remove-score needs index" })),
                    );
                };
                pg = remove_score(&pg, index as usize);
            }
            other => {
                return err_value(
                    ErrorKind::InvalidInput,
                    Some(json!({ "detail": format!("unknown score_state op kind: {other}") })),
                );
            }
        }
    }
    ok_value(json!({
        "rounds": pg.rounds,
        "handIds": pg.hand_ids,
        "log": pg.log,
        "primary": player_primary(&pg),
        "secondary": player_secondary(&pg),
        "total": player_total(&pg),
    }))
}

fn handle_wtc_result(args: &Value) -> Value {
    let (Some(a), Some(b)) = (
        args.get("a").and_then(Value::as_u64),
        args.get("b").and_then(Value::as_u64),
    ) else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "wtc_result needs numeric a and b" })),
        );
    };
    let r = wtc_result(a, b);
    ok_value(json!({ "a": r.a, "b": r.b }))
}

fn handle_resolve_terrain(args: &Value) -> Value {
    let Some(layout_val) = args.get("layout") else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "resolve_terrain.layout must be an object" })),
        );
    };
    let templates_val = args.get("templates").cloned().unwrap_or_else(|| json!([]));
    if !templates_val.is_array() {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "resolve_terrain.templates must be an array" })),
        );
    }
    let layout: wh40kdc::terrain::TerrainLayout = match serde_json::from_value(layout_val.clone()) {
        Ok(l) => l,
        Err(e) => {
            return err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": format!("resolve_terrain.layout: {e}") })),
            )
        }
    };
    let templates: Vec<wh40kdc::terrain::TerrainTemplate> =
        match serde_json::from_value(templates_val) {
            Ok(t) => t,
            Err(e) => {
                return err_value(
                    ErrorKind::InvalidInput,
                    Some(json!({ "detail": format!("resolve_terrain.templates: {e}") })),
                )
            }
        };
    match wh40kdc::resolve_layout(&layout, &templates) {
        Ok(pieces) => ok_value(json!({ "pieces": pieces })),
        Err(e) => err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": e.to_string() })),
        ),
    }
}

fn handle_keystones(args: &Value) -> Value {
    let Some(layout_val) = args.get("layout") else {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "keystones.layout must be an object" })),
        );
    };
    let templates_val = args.get("templates").cloned().unwrap_or_else(|| json!([]));
    if !templates_val.is_array() {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "keystones.templates must be an array" })),
        );
    }
    let layout: wh40kdc::terrain::TerrainLayout = match serde_json::from_value(layout_val.clone()) {
        Ok(l) => l,
        Err(e) => {
            return err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": format!("keystones.layout: {e}") })),
            )
        }
    };
    let templates: Vec<wh40kdc::terrain::TerrainTemplate> =
        match serde_json::from_value(templates_val) {
            Ok(t) => t,
            Err(e) => {
                return err_value(
                    ErrorKind::InvalidInput,
                    Some(json!({ "detail": format!("keystones.templates: {e}") })),
                )
            }
        };
    let board: wh40kdc::terrain::BoardExtents = match args.get("board") {
        None => wh40kdc::terrain::BOARD_INCHES,
        Some(b) => match serde_json::from_value(b.clone()) {
            Ok(b) => b,
            Err(e) => {
                return err_value(
                    ErrorKind::InvalidInput,
                    Some(json!({ "detail": format!("keystones.board: {e}") })),
                )
            }
        },
    };
    match wh40kdc::terrain::keystone_measurements(&layout, &templates, board) {
        Ok(measurements) => ok_value(json!({ "measurements": measurements })),
        Err(e) => err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": e.to_string() })),
        ),
    }
}

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

/// Apply one decoded request to runner state and return the response. Used by
/// tests directly; the CLI loop wraps this with line parsing.
fn dispatch(state: &mut RunnerState, op: &str, args: &Value) -> Value {
    if !state.initialized && op != "init" {
        return err_value(
            ErrorKind::InvalidInput,
            Some(json!({ "detail": "must init before any other op" })),
        );
    }
    match op {
        "init" => handle_init(state, args),
        "version" => ok_value(json!({
            "impl": IMPL_NAME,
            "spec_version": state.spec_version,
            "impl_version": IMPL_VERSION,
        })),
        "normalize" => handle_normalize(args),
        "import" => handle_import(state, args),
        "try_import" => handle_try_import(state, args),
        "export" => handle_export(state, args),
        "linked_query" => handle_linked_query(state, args),
        "check_unit_legality" => handle_check_unit_legality(state, args),
        "check_roster_legality" => handle_check_roster_legality(state, args),
        "candidate_affordability" => handle_candidate_affordability(state, args),
        "validate" => handle_validate(args),
        "crunch" => handle_crunch(state, args),
        "attribution" => handle_attribution(state, args),
        "translate_scoring" => handle_translate_scoring(state, args),
        "translate_effect" => handle_translate_effect(args),
        "match_applies_to" => handle_match_applies_to(args),
        "score_event" => handle_score_event(state, args),
        "score_state" => handle_score_state(state, args),
        "wtc_result" => handle_wtc_result(args),
        "resolve_terrain" => handle_resolve_terrain(args),
        "keystones" => handle_keystones(args),
        "share_encode" => handle_share_encode(args),
        "share_decode" => handle_share_decode(args),
        "shutdown" => ok_value(Value::Null),
        other => err_value(ErrorKind::UnknownOp, Some(json!({ "op": other }))),
    }
}

/// Process one stdin line and return the line that should be written to
/// stdout (without trailing `\n`). `None` on empty lines, which the CLI loop
/// silently ignores.
fn process_request(state: &mut RunnerState, line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let req: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return Some(
                err_value(
                    ErrorKind::InvalidInput,
                    Some(json!({ "detail": format!("not valid JSON: {e}") })),
                )
                .to_string(),
            );
        }
    };
    let Some(op) = req.get("op").and_then(Value::as_str) else {
        return Some(
            err_value(
                ErrorKind::InvalidInput,
                Some(json!({ "detail": "request must have a string `op` field" })),
            )
            .to_string(),
        );
    };
    let args = req.get("args").cloned().unwrap_or(Value::Null);
    Some(dispatch(state, op, &args).to_string())
}

// ---------------------------------------------------------------------------
// CLI: NDJSON stdin/stdout loop.
// ---------------------------------------------------------------------------

fn run_cli() -> ! {
    let spec_version = load_spec_version();
    let mut state = RunnerState::new(spec_version);
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line_res in stdin.lock().lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(_) => break,
        };
        if let Some(resp) = process_request(&mut state, &line) {
            // Honor `shutdown`: respond first, flush, then exit clean.
            let is_shutdown = serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|v| v.get("op").and_then(Value::as_str).map(str::to_string))
                .as_deref()
                == Some("shutdown");
            let _ = writeln!(out, "{resp}");
            let _ = out.flush();
            if is_shutdown {
                std::process::exit(0);
            }
        }
    }
    std::process::exit(0);
}

fn main() {
    run_cli();
}

#[cfg(test)]
mod self_tests {
    use super::*;

    #[test]
    fn spec_version_loads() {
        let v = load_spec_version();
        assert!(v >= 1, "spec version: {v}");
    }
}
