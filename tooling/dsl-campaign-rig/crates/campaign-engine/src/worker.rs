use async_trait::async_trait;
use campaign_domain::{ArtifactKind, CampaignId, Command, Hash256, Sensitivity};
use campaign_store::{EffectIntent, Lease};

use crate::{CampaignEngine, EngineError, WorkNode};

pub struct ProducedArtifact {
    pub kind: ArtifactKind,
    pub sensitivity: Sensitivity,
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub canonicalization: String,
    pub expected_hash: Hash256,
    pub parent_hashes: Vec<Hash256>,
}

pub struct WorkCompletion {
    pub artifacts: Vec<ProducedArtifact>,
    pub follow_up: Command,
    pub effect: Option<EffectIntent>,
}

#[async_trait]
pub trait NodeExecutor: Send + Sync {
    async fn execute(&self, node: &WorkNode, lease: &Lease) -> Result<WorkCompletion, EngineError>;
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkRunStatus {
    Completed,
    LeaseHeld,
}

pub struct Worker<'a, E> {
    pub engine: &'a CampaignEngine,
    pub campaign_id: CampaignId,
    pub executor: &'a E,
    pub owner_id: String,
    pub lease_ttl_seconds: i64,
}

impl<E: NodeExecutor> Worker<'_, E> {
    pub async fn run_node(&self, node: &WorkNode, now: i64) -> Result<WorkRunStatus, EngineError> {
        let resource_key = format!("campaign:{}:work:{}", self.campaign_id, node.work_id);
        let lease = match self.engine.store().acquire_lease(
            &resource_key,
            &self.owner_id,
            now,
            self.lease_ttl_seconds,
        ) {
            Ok(lease) => lease,
            Err(campaign_store::StoreError::LeaseHeld) => return Ok(WorkRunStatus::LeaseHeld),
            Err(error) => return Err(error.into()),
        };
        let heartbeat_store = self.engine.store().clone();
        let mut heartbeat_lease = lease.clone();
        let heartbeat_every = (self.lease_ttl_seconds / 3).max(1) as u64;
        let heartbeat_ttl = self.lease_ttl_seconds;
        let (lease_lost_tx, mut lease_lost_rx) = tokio::sync::oneshot::channel();
        let heartbeat = AbortOnDrop(tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(heartbeat_every)).await;
                let now = time::OffsetDateTime::now_utc().unix_timestamp();
                match heartbeat_store.heartbeat_lease(&heartbeat_lease, now, heartbeat_ttl) {
                    Ok(renewed) => heartbeat_lease = renewed,
                    Err(_) => {
                        let _ = lease_lost_tx.send(());
                        break;
                    }
                }
            }
        }));
        let execution = tokio::select! {
            result = self.executor.execute(node, &lease) => result,
            _ = &mut lease_lost_rx => return Err(campaign_store::StoreError::StaleLease.into()),
        };
        drop(heartbeat);
        let completion = match execution {
            Ok(completion) => completion,
            Err(error) => {
                if !matches!(
                    error,
                    EngineError::Role(campaign_roles::RoleError::Unreconciled)
                ) {
                    self.engine
                        .store()
                        .expire_lease(&lease, time::OffsetDateTime::now_utc().unix_timestamp())?;
                }
                return Err(error);
            }
        };
        let completed_at = time::OffsetDateTime::now_utc().unix_timestamp();
        self.engine
            .store()
            .validate_fence(&resource_key, lease.fencing_token, completed_at)?;
        for artifact in &completion.artifacts {
            if Hash256::digest(&artifact.bytes) != artifact.expected_hash {
                return Err(EngineError::Policy);
            }
            self.engine.store().put_artifact(
                artifact.kind,
                artifact.sensitivity,
                &artifact.bytes,
                &artifact.media_type,
                &artifact.canonicalization,
                &artifact.parent_hashes,
            )?;
        }
        self.engine.store().validate_fence(
            &resource_key,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        if completion.follow_up.meta.fencing_token != Some(lease.fencing_token) {
            return Err(EngineError::Policy);
        }
        if let Some(effect) = &completion.effect {
            self.engine
                .execute_with_effect(&completion.follow_up, effect)?;
        } else {
            self.engine.execute(&completion.follow_up)?;
        }
        self.engine
            .store()
            .expire_lease(&lease, time::OffsetDateTime::now_utc().unix_timestamp())?;
        Ok(WorkRunStatus::Completed)
    }
}
