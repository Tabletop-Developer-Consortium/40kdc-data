use std::collections::BTreeSet;

use campaign_domain::{CampaignId, CampaignPhase};

use crate::{CampaignEngine, EngineError, NodeExecutor, Worker, ready_work_with_policy};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSummary {
    pub executed_work: usize,
    pub remaining_work: usize,
    pub idle: bool,
}

pub async fn run_until_idle<E: NodeExecutor>(
    engine: &CampaignEngine,
    campaign_id: &CampaignId,
    executor: &E,
    owner_id: &str,
    now: i64,
    max_nodes: usize,
) -> Result<RunSummary, EngineError> {
    let worker = Worker {
        engine,
        executor,
        owner_id: owner_id.to_owned(),
        lease_ttl_seconds: 300,
    };
    let mut executed = 0;
    let mut seen_versions = BTreeSet::new();
    loop {
        let state = engine.state(campaign_id)?;
        if !seen_versions.insert(state.stream_version) && executed > 0 {
            return Err(EngineError::Policy);
        }
        let nodes =
            ready_work_with_policy(&state, engine.read_only(), engine.allow_shape_application());
        if nodes.is_empty() || executed >= max_nodes {
            return Ok(RunSummary {
                executed_work: executed,
                remaining_work: nodes.len(),
                idle: nodes.is_empty(),
            });
        }
        for node in nodes {
            if executed >= max_nodes {
                break;
            }
            worker.run_node(&node, now).await?;
            executed += 1;
            if node.kind == crate::WorkKind::Publish
                && engine.state(campaign_id)?.phase == CampaignPhase::Publishing
            {
                return Ok(RunSummary {
                    executed_work: executed,
                    remaining_work: 1,
                    idle: false,
                });
            }
        }
    }
}
