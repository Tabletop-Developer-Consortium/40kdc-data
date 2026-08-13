use std::collections::{BTreeMap, BTreeSet};

use campaign_domain::{AbilityId, FactionId, Hash256};
use serde::{Deserialize, Serialize};

use crate::EngineError;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct BenchmarkKey {
    pub faction_id: FactionId,
    pub ability_id: AbilityId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BenchmarkAbility {
    pub faction_id: FactionId,
    pub ability_id: AbilityId,
    pub stratum: u8,
    pub source_hash: Hash256,
    pub baseline_dsl_hash: Hash256,
    pub expected_verdict_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BenchmarkManifest {
    pub version: u32,
    pub base_commit: String,
    pub prompt_manifest_hash: Hash256,
    pub model: String,
    pub reasoning: String,
    pub abilities: Vec<BenchmarkAbility>,
}

impl BenchmarkManifest {
    pub fn validate(&self) -> Result<(), EngineError> {
        let keys = self
            .abilities
            .iter()
            .map(|ability| BenchmarkKey {
                faction_id: ability.faction_id.clone(),
                ability_id: ability.ability_id.clone(),
            })
            .collect::<BTreeSet<_>>();
        let strata = self
            .abilities
            .iter()
            .map(|ability| ability.stratum)
            .collect::<BTreeSet<_>>();
        if self.version != 1
            || self.abilities.len() != 5
            || keys.len() != 5
            || strata != (1..=5).collect()
            || self.model.is_empty()
            || self.reasoning.is_empty()
        {
            return Err(EngineError::BenchmarkInvalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArmResult {
    pub arm: String,
    pub identity_hash: Hash256,
    pub verdict_hashes: BTreeMap<BenchmarkKey, Hash256>,
    pub token_activity: Option<u64>,
    pub quota_consumed: Option<u64>,
    pub subscription_authenticated: bool,
    pub app_server_fallback: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BenchmarkDecision {
    pub app_server_qualified: bool,
    pub direct_qualified: bool,
    pub app_server_improvement: Option<f64>,
    pub direct_improvement: Option<f64>,
    pub selected_transport: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompoundingStratum {
    Straightforward,
    Ambiguous,
    SchemaResistant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompoundingCaseResult {
    pub key: BenchmarkKey,
    pub stratum: CompoundingStratum,
    pub lane: campaign_domain::ExecutionLane,
    pub applied: bool,
    pub mechanically_verified: bool,
    pub shape_scouted: bool,
    pub reused_cluster: Option<campaign_domain::MechanicClusterId>,
    pub reused_template_hash: Option<Hash256>,
    pub canonical_levers_preserved: bool,
    pub clauses_complete: bool,
    pub non_worklist_render_drift: bool,
    pub evidence_identity_exact: bool,
    pub assignment_stable: bool,
    pub token_activity: u64,
    pub quota_consumed: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompoundingBenchmarkReport {
    pub total: usize,
    pub straightforward: usize,
    pub ambiguous: usize,
    pub schema_resistant: usize,
    pub straightforward_verified_without_shape: usize,
    pub straightforward_success_ratio: f64,
    pub tribunal_count: usize,
    pub reused_family_members: usize,
    pub passed: bool,
    pub failure_codes: BTreeSet<String>,
}

pub fn evaluate_compounding_benchmark(
    results: &[CompoundingCaseResult],
) -> Result<CompoundingBenchmarkReport, EngineError> {
    let unique_keys = results
        .iter()
        .map(|result| &result.key)
        .collect::<BTreeSet<_>>();
    if unique_keys.len() != results.len() {
        return Err(EngineError::BenchmarkInvalid);
    }
    let straightforward = results
        .iter()
        .filter(|result| result.stratum == CompoundingStratum::Straightforward)
        .count();
    let ambiguous = results
        .iter()
        .filter(|result| result.stratum == CompoundingStratum::Ambiguous)
        .count();
    let schema_resistant = results
        .iter()
        .filter(|result| result.stratum == CompoundingStratum::SchemaResistant)
        .count();
    if straightforward < 20 || ambiguous < 5 || schema_resistant < 2 {
        return Err(EngineError::BenchmarkInvalid);
    }
    let straightforward_verified_without_shape = results
        .iter()
        .filter(|result| {
            result.stratum == CompoundingStratum::Straightforward
                && result.lane == campaign_domain::ExecutionLane::Fast
                && result.reused_cluster.is_some()
                && result.reused_template_hash.is_some()
                && result.applied
                && result.mechanically_verified
                && !result.shape_scouted
        })
        .count();
    let straightforward_success_ratio =
        straightforward_verified_without_shape as f64 / straightforward as f64;
    let tribunal_count = results
        .iter()
        .filter(|result| result.lane == campaign_domain::ExecutionLane::Full)
        .count();
    let reused_family_members = results
        .iter()
        .filter(|result| result.reused_cluster.is_some() && result.reused_template_hash.is_some())
        .count();
    let mut failure_codes = BTreeSet::new();
    if straightforward_success_ratio < 0.80 {
        failure_codes.insert("straightforward-success-below-80-percent".into());
    }
    if tribunal_count * 2 >= results.len() {
        failure_codes.insert("full-tribunal-not-a-minority".into());
    }
    if reused_family_members < 2 {
        failure_codes.insert("no-observed-family-template-reuse".into());
    }
    if results
        .iter()
        .any(|result| !result.canonical_levers_preserved)
    {
        failure_codes.insert("canonical-lever-regression".into());
    }
    if results.iter().any(|result| !result.clauses_complete) {
        failure_codes.insert("source-clause-omission".into());
    }
    if results
        .iter()
        .any(|result| result.non_worklist_render_drift)
    {
        failure_codes.insert("non-worklist-render-drift".into());
    }
    if results.iter().any(|result| !result.evidence_identity_exact) {
        failure_codes.insert("evidence-identity-drift".into());
    }
    if results.iter().any(|result| !result.assignment_stable) {
        failure_codes.insert("cluster-assignment-unstable".into());
    }
    Ok(CompoundingBenchmarkReport {
        total: results.len(),
        straightforward,
        ambiguous,
        schema_resistant,
        straightforward_verified_without_shape,
        straightforward_success_ratio,
        tribunal_count,
        reused_family_members,
        passed: failure_codes.is_empty(),
        failure_codes,
    })
}

pub fn decide_benchmark(
    manifest: &BenchmarkManifest,
    omp: &ArmResult,
    app_server: &ArmResult,
    direct: &ArmResult,
) -> Result<BenchmarkDecision, EngineError> {
    manifest.validate()?;
    for arm in [omp, app_server, direct] {
        if arm.verdict_hashes.len() != 5 || !arm.subscription_authenticated {
            return Err(EngineError::BenchmarkInvalid);
        }
    }
    let expected = manifest
        .abilities
        .iter()
        .map(|ability| {
            (
                BenchmarkKey {
                    faction_id: ability.faction_id.clone(),
                    ability_id: ability.ability_id.clone(),
                },
                ability.expected_verdict_hash,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let no_regression = |arm: &ArmResult| arm.verdict_hashes == expected;
    let app_improvement = improvement(omp, app_server);
    let direct_improvement = improvement(omp, direct);
    let app_server_qualified =
        no_regression(app_server) && app_improvement.is_some_and(|ratio| ratio >= 0.30);
    let direct_qualified = no_regression(direct)
        && direct.app_server_fallback
        && direct_improvement.is_some_and(|ratio| ratio >= 0.30)
        && (!app_server_qualified || not_worse_usage(app_server, direct));
    let selected_transport = if direct_qualified {
        Some("direct".into())
    } else if app_server_qualified {
        Some("app-server".into())
    } else {
        None
    };
    Ok(BenchmarkDecision {
        app_server_qualified,
        direct_qualified,
        app_server_improvement: app_improvement,
        direct_improvement,
        selected_transport,
    })
}

fn improvement(baseline: &ArmResult, candidate: &ArmResult) -> Option<f64> {
    let (baseline, candidate) = match (baseline.quota_consumed, candidate.quota_consumed) {
        (Some(baseline), Some(candidate)) if baseline > 0 => (baseline, candidate),
        _ => (baseline.token_activity?, candidate.token_activity?),
    };
    if baseline == 0 || candidate > baseline {
        return Some((baseline as f64 - candidate as f64) / baseline as f64);
    }
    Some((baseline - candidate) as f64 / baseline as f64)
}

fn not_worse_usage(app_server: &ArmResult, direct: &ArmResult) -> bool {
    match (app_server.quota_consumed, direct.quota_consumed) {
        (Some(app), Some(direct)) => direct <= app,
        _ => {
            matches!((app_server.token_activity, direct.token_activity), (Some(app), Some(direct)) if direct <= app)
        }
    }
}
