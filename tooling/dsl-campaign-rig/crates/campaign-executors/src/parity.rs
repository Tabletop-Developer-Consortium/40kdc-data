use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::ExecutorError;

pub const SIX_PAIRS: [&str; 6] = ["ts,rust", "ts,py", "rust,py", "ts,go", "rust,go", "py,go"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParityAreaResult {
    pub ok: bool,
    pub cases_run: u64,
    #[serde(default)]
    pub skipped: BTreeSet<String>,
}

pub fn validate_parity(
    required_areas: &BTreeSet<String>,
    results: &BTreeMap<String, BTreeMap<String, ParityAreaResult>>,
) -> Result<u64, ExecutorError> {
    if results.len() != SIX_PAIRS.len() {
        return Err(ExecutorError::GateFailed);
    }
    let mut cases = 0;
    for pair in SIX_PAIRS {
        let areas = results.get(pair).ok_or(ExecutorError::GateFailed)?;
        for area in required_areas {
            let result = areas.get(area).ok_or(ExecutorError::GateFailed)?;
            if !result.ok || result.cases_run == 0 || result.skipped.contains(area) {
                return Err(ExecutorError::GateFailed);
            }
            cases += result.cases_run;
        }
    }
    Ok(cases)
}
