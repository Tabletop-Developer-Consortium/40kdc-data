use std::collections::{BTreeMap, BTreeSet};

use campaign_domain::{AbilityKey, CampaignState, CloseFacts, Hash256};
use campaign_executors::{ParityAreaResult, SIX_PAIRS, validate_parity};
use serde::{Deserialize, Serialize};

use crate::EngineError;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CloseEvidence {
    pub artifact_hash: Hash256,
    pub sealed_base: String,
    pub sealed_head: String,
    pub terminal_keys: BTreeSet<AbilityKey>,
    pub fixed_gates_passed: bool,
    pub parity_results: BTreeMap<String, BTreeMap<String, ParityAreaResult>>,
    pub required_parity_areas: BTreeSet<String>,
    pub changed_render_keys: BTreeSet<AbilityKey>,
    pub target_faction_means: BTreeMap<String, (f64, f64)>,
    pub anti_conditions: BTreeMap<u8, bool>,
    pub conflict_free: bool,
}

pub fn validate_close(
    state: &CampaignState,
    evidence: &CloseEvidence,
) -> Result<CloseFacts, EngineError> {
    let manifest = state.manifest.as_ref().ok_or(EngineError::Policy)?;
    let worklist = manifest
        .ordered_worklist
        .iter()
        .map(|item| item.key.clone())
        .collect::<BTreeSet<_>>();
    let parity_cases = validate_parity(&evidence.required_parity_areas, &evidence.parity_results)?;
    let anti_conditions = evidence
        .anti_conditions
        .iter()
        .filter(|(id, passed)| (1..=10).contains(*id) && **passed)
        .count();
    if evidence.sealed_base != manifest.base_commit_id
        || state.sealed_head.as_deref() != Some(evidence.sealed_head.as_str())
        || !state.all_work_terminal()
        || evidence.terminal_keys != worklist
        || !evidence.changed_render_keys.is_subset(&worklist)
        || evidence
            .target_faction_means
            .values()
            .any(|(before, after)| after < before)
        || evidence.anti_conditions.len() != 10
        || anti_conditions != 10
        || !evidence.fixed_gates_passed
        || parity_cases == 0
        || !evidence.conflict_free
    {
        return Err(EngineError::Policy);
    }
    Ok(CloseFacts {
        artifact_hash: evidence.artifact_hash,
        sealed_head: evidence.sealed_head.clone(),
        terminal_ledger_complete: true,
        fixed_gates_passed: true,
        parity_pairs_passed: SIX_PAIRS.len() as u8,
        whole_corpus_drift_clean: true,
        target_means_non_regressing: true,
        anti_conditions_passed: 10,
        conflict_free: true,
    })
}
