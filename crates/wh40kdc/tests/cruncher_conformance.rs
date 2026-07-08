//! Cross-implementation conformance for the damage-projection engine.
//!
//! The TypeScript reference is the oracle; the Rust crate asserts against the
//! same `conformance/cruncher/` corpus the TS suite runs
//! (`tools/test/conformance.test.ts`). Each case names an attacker/target
//! by id (resolved against the embedded dataset), a flat `buffs` stack, an
//! `EngineContext`, and an `expected.stages` map of expected-value floats.
//!
//! The runner asserts each stage matches within `5e-4` of the golden — wide
//! enough to absorb the four-decimal rounding in the goldens themselves,
//! tight enough that any non-trivial engine drift is caught.

#![cfg(feature = "cruncher")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use wh40kdc::cruncher::{
    crunch, AttackProfileRef, Buff, EngineContext, EngineInput, StageName, TargetProfileRef,
};
use wh40kdc::Dataset;

const TOLERANCE: f64 = 5e-4;

fn conformance_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cruncher")
}

#[derive(Debug, Deserialize)]
struct CruncherCase {
    name: String,
    attacker: AttackerSpec,
    #[serde(rename = "modelsFiring")]
    models_firing: u64,
    target: TargetSpec,
    context: EngineContext,
    buffs: Vec<Buff>,
    expected: ExpectedBlock,
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
struct ExpectedBlock {
    stages: HashMap<String, f64>,
}

fn case_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    out.sort();
    out
}

fn stage_name(key: &str) -> Option<StageName> {
    Some(match key {
        "attacks" => StageName::Attacks,
        "hits" => StageName::Hits,
        "wounds" => StageName::Wounds,
        "unsaved" => StageName::Unsaved,
        "damage" => StageName::Damage,
        "after-fnp" => StageName::AfterFnp,
        "models-killed" => StageName::ModelsKilled,
        _ => return None,
    })
}

#[test]
fn cruncher_corpus_stages_match_reference_within_tolerance() {
    let ds = Dataset::embedded();
    let dir = conformance_dir();
    let cases = case_files(&dir);
    assert!(!cases.is_empty(), "no cruncher conformance cases found");

    for case_path in &cases {
        let raw = fs::read_to_string(case_path)
            .unwrap_or_else(|e| panic!("reading {}: {e}", case_path.display()));
        let case: CruncherCase = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("parsing {}: {e}", case_path.display()));

        let weapon = ds.weapons.get(&case.attacker.weapon_id).unwrap_or_else(|| {
            panic!(
                "unknown weapon {} in {}",
                case.attacker.weapon_id,
                case_path.display()
            )
        });
        let unit = ds.units.get_any(&case.target.unit_id).unwrap_or_else(|| {
            panic!(
                "unknown unit {} in {}",
                case.target.unit_id,
                case_path.display()
            )
        });

        let input = EngineInput {
            attacker: AttackProfileRef {
                weapon,
                profile_index: case.attacker.profile_index,
            },
            target: TargetProfileRef {
                unit,
                profile_index: case.target.profile_index,
                model_count: case.target.model_count,
            },
            models_firing: case.models_firing,
            buffs: case.buffs,
            context: case.context,
        };
        let out = crunch(&input, Some(ds))
            .unwrap_or_else(|e| panic!("crunch failed for {}: {e}", case_path.display()));
        let actual: HashMap<StageName, f64> =
            out.stages.iter().map(|s| (s.name, s.expected)).collect();

        for (stage_key, expected) in &case.expected.stages {
            let Some(name) = stage_name(stage_key) else {
                panic!(
                    "cruncher/{}: unknown stage key {stage_key:?} (case '{}')",
                    case_path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("?"),
                    case.name
                );
            };
            let actual_value = *actual.get(&name).unwrap_or_else(|| {
                panic!(
                    "cruncher/{}: stage {stage_key} missing from engine output (case '{}')",
                    case_path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("?"),
                    case.name
                )
            });
            let delta = (actual_value - expected).abs();
            assert!(
                delta < TOLERANCE,
                "cruncher/{} stage {stage_key}: expected {expected:.6}, got {actual_value:.6} (Δ {delta:.6}) — case '{}'",
                case_path.file_name().and_then(|s| s.to_str()).unwrap_or("?"),
                case.name
            );
        }
    }
}
