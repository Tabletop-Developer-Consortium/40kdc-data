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
