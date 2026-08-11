use std::collections::{BTreeMap, BTreeSet};

use campaign_domain::{AbilityKey, Hash256};
use serde::{Deserialize, Serialize};

use crate::ExecutorError;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScoreRow {
    pub key: AbilityKey,
    pub baseline: f64,
    pub candidate: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct ScoreReport {
    rows: Vec<ScoreRow>,
    faction_means: BTreeMap<String, (f64, f64)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScoreBinding {
    pub command_hash: Hash256,
    pub binary_hash: Hash256,
    pub input_hash: Hash256,
    pub report_hash: Hash256,
    pub rows: Vec<ScoreRow>,
    pub faction_means: BTreeMap<String, (f64, f64)>,
}

pub fn bind_score_report(
    report_bytes: &[u8],
    expected_keys: &BTreeSet<AbilityKey>,
    command_hash: Hash256,
    binary_hash: Hash256,
    input_hash: Hash256,
) -> Result<ScoreBinding, ExecutorError> {
    let mut report: ScoreReport = serde_json::from_slice(report_bytes)?;
    let keys = report
        .rows
        .iter()
        .map(|row| row.key.clone())
        .collect::<BTreeSet<_>>();
    if &keys != expected_keys
        || report
            .rows
            .iter()
            .any(|row| !row.baseline.is_finite() || !row.candidate.is_finite())
        || report
            .faction_means
            .values()
            .any(|(before, after)| after < before)
    {
        return Err(ExecutorError::GateFailed);
    }
    report.rows.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(ScoreBinding {
        command_hash,
        binary_hash,
        input_hash,
        report_hash: Hash256::digest(report_bytes),
        rows: report.rows,
        faction_means: report.faction_means,
    })
}
