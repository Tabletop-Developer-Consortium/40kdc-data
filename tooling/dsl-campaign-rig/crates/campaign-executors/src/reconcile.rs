use std::{collections::BTreeSet, fs};

use campaign_domain::Hash256;

use crate::{ApplyPlan, ExecutorError, JjClient};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyObservation {
    NotStarted,
    Complete,
    PartialOrForeign,
}

pub fn observe_apply(jj: &JjClient, plan: &ApplyPlan) -> Result<ApplyObservation, ExecutorError> {
    let mut matched = 0;
    let mut baseline = 0;
    for operation in &plan.operations {
        let path = jj.repo_root().join(&operation.path);
        let observed = fs::read(path).ok().map(Hash256::digest);
        if observed == Some(operation.new_bytes_artifact) {
            matched += 1;
        } else if observed == operation.expected_old_hash {
            baseline += 1;
        }
    }
    if matched == plan.operations.len() {
        let changed = jj.changed_paths(&plan.expected_head, "@")?;
        let expected = plan
            .operations
            .iter()
            .map(|operation| operation.path.clone())
            .collect::<BTreeSet<_>>();
        if changed == expected {
            Ok(ApplyObservation::Complete)
        } else {
            Ok(ApplyObservation::PartialOrForeign)
        }
    } else if baseline == plan.operations.len() {
        Ok(ApplyObservation::NotStarted)
    } else {
        Ok(ApplyObservation::PartialOrForeign)
    }
}
