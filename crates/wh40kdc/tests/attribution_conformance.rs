//! Cross-implementation conformance for the cruncher's leave-one-out
//! attribution decomposition.
//!
//! Each case in `conformance/attribution/cases.json` references a cruncher
//! input file (the same `EngineInput` already pinned by the cruncher corpus)
//! and lists every `AttributedStage`'s expected/baseline/residual floats, the
//! per-group lifts with their sources and deltas, and the intrinsics list.
//! Floats compare within `5e-4` (matching the cruncher tolerance); BuffSource
//! values compare structurally via serde JSON.

#![cfg(feature = "cruncher")]

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use wh40kdc::cruncher::{
    attribute_stages, AttackProfileRef, Buff, EngineContext, EngineInput, StageName,
    TargetProfileRef,
};
use wh40kdc::Dataset;

const TOLERANCE: f64 = 5e-4;

fn conformance_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
}

#[derive(Debug, Deserialize)]
struct CruncherCase {
    attacker: AttackerSpec,
    #[serde(rename = "modelsFiring")]
    models_firing: u64,
    target: TargetSpec,
    context: EngineContext,
    buffs: Vec<Buff>,
}

#[derive(Debug, Deserialize)]
struct AttackerSpec {
    #[serde(rename = "weaponId")]
    weapon_id: String,
    #[serde(rename = "profileIndex")]
    profile_index: usize,
}

#[derive(Debug, Deserialize)]
struct TargetSpec {
    #[serde(rename = "unitId")]
    unit_id: String,
    #[serde(rename = "profileIndex")]
    profile_index: usize,
    #[serde(rename = "modelCount", default)]
    model_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AttributionCase {
    name: String,
    cruncher_case: String,
    expected: Vec<ExpectedStage>,
}

#[derive(Debug, Deserialize)]
struct ExpectedStage {
    name: StageName,
    expected: f64,
    baseline: f64,
    lifts: Vec<ExpectedLift>,
    residual: f64,
    intrinsics: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ExpectedLift {
    /// Source is round-tripped through serde_json::Value so we can compare it
    /// structurally against the actual BuffSource serialization without
    /// duplicating the discriminated-union layout here.
    source: Value,
    delta: f64,
}

#[test]
fn attribution_corpus_matches_reference() {
    let path = conformance_dir().join("attribution").join("cases.json");
    let raw =
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let cases: Vec<AttributionCase> =
        serde_json::from_str(&raw).expect("attribution/cases.json is a valid JSON array");
    assert!(!cases.is_empty(), "attribution corpus is empty");

    let ds = Dataset::embedded();

    for case in &cases {
        let crunch_path = conformance_dir().join("cruncher").join(&case.cruncher_case);
        let crunch_raw = fs::read_to_string(&crunch_path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", crunch_path.display()));
        let crunch_case: CruncherCase = serde_json::from_str(&crunch_raw)
            .unwrap_or_else(|e| panic!("parsing {}: {e}", crunch_path.display()));

        let weapon = ds
            .weapons
            .get_any(&crunch_case.attacker.weapon_id)
            .unwrap_or_else(|| panic!("unknown weapon {}", crunch_case.attacker.weapon_id));
        let unit = ds
            .units
            .get_any(&crunch_case.target.unit_id)
            .unwrap_or_else(|| panic!("unknown unit {}", crunch_case.target.unit_id));

        let input = EngineInput {
            attacker: AttackProfileRef {
                weapon,
                profile_index: crunch_case.attacker.profile_index,
            },
            target: TargetProfileRef {
                unit,
                profile_index: crunch_case.target.profile_index,
                model_count: crunch_case.target.model_count,
            },
            models_firing: crunch_case.models_firing,
            buffs: crunch_case.buffs,
            context: crunch_case.context,
        };

        let actual = attribute_stages(&input, Some(&ds), None)
            .unwrap_or_else(|e| panic!("attribute_stages for {}: {e}", case.name));

        assert_eq!(
            actual.len(),
            case.expected.len(),
            "attribution/{}: stage count diverged",
            case.cruncher_case
        );

        for (i, (got, want)) in actual.iter().zip(case.expected.iter()).enumerate() {
            assert_eq!(
                got.name, want.name,
                "attribution/{} stage {i}: name mismatch",
                case.cruncher_case
            );
            assert!(
                (got.expected - want.expected).abs() < TOLERANCE,
                "attribution/{} stage {}: expected {} vs {} (\u{0394} {})",
                case.cruncher_case,
                i,
                got.expected,
                want.expected,
                (got.expected - want.expected).abs()
            );
            assert!(
                (got.baseline - want.baseline).abs() < TOLERANCE,
                "attribution/{} stage {}: baseline diverged",
                case.cruncher_case,
                i
            );
            assert!(
                (got.residual - want.residual).abs() < TOLERANCE,
                "attribution/{} stage {}: residual diverged",
                case.cruncher_case,
                i
            );
            assert_eq!(
                got.intrinsics, want.intrinsics,
                "attribution/{} stage {}: intrinsics diverged",
                case.cruncher_case, i
            );
            assert_eq!(
                got.lifts.len(),
                want.lifts.len(),
                "attribution/{} stage {}: lift count diverged",
                case.cruncher_case,
                i
            );
            for (j, (got_lift, want_lift)) in got.lifts.iter().zip(want.lifts.iter()).enumerate() {
                let got_source = serde_json::to_value(&got_lift.source)
                    .expect("BuffSource serializes to a Value");
                assert_eq!(
                    got_source, want_lift.source,
                    "attribution/{} stage {} lift {}: source diverged",
                    case.cruncher_case, i, j
                );
                assert!(
                    (got_lift.delta - want_lift.delta).abs() < TOLERANCE,
                    "attribution/{} stage {} lift {}: delta diverged",
                    case.cruncher_case,
                    i,
                    j
                );
            }
        }
    }
}
