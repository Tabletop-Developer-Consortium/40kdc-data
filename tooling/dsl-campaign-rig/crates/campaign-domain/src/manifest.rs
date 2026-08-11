use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{AbilityKey, CampaignId, DomainError, Hash256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkItem {
    pub key: AbilityKey,
    pub cosine_start: f64,
    pub source_hash: Hash256,
    pub baseline_dsl_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budgets {
    pub max_abilities: u8,
    pub max_batch_size: u8,
    pub max_assembly_attempts: u8,
    pub routine_refuters: u8,
    pub escalated_refuters: u8,
    pub max_shape_review_rounds: u8,
    pub max_full_gate_reruns: u8,
    pub family_threshold: u8,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            max_abilities: 40,
            max_batch_size: 8,
            max_assembly_attempts: 4,
            routine_refuters: 2,
            escalated_refuters: 3,
            max_shape_review_rounds: 3,
            max_full_gate_reruns: 2,
            family_threshold: 4,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentitySet {
    pub provider_precedence: Vec<String>,
    pub allowed_transports: BTreeSet<String>,
    pub model: String,
    pub reasoning: String,
    pub rig_version: String,
    pub rig_lockfile_hash: Hash256,
    pub app_server_binary_hash: Hash256,
    pub app_server_version: String,
    pub app_server_protocol_hash: Hash256,
    pub direct_provider_hash: Option<Hash256>,
    pub prompt_manifest_hash: Hash256,
    pub role_schema_hashes: Vec<Hash256>,
    pub semantic_validator_hash: Hash256,
    pub tool_contract_hash: Hash256,
    pub engine_version: String,
    pub protocol_version: u32,
    pub executable_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CampaignManifest {
    pub campaign_id: CampaignId,
    pub repository_canonical_path_hash: Hash256,
    pub workspace_id: String,
    pub base_commit_id: String,
    pub ordered_worklist: Vec<WorkItem>,
    pub baseline_report_hash: Hash256,
    pub baseline_rows_hash: Hash256,
    pub identities: IdentitySet,
    pub budgets: Budgets,
    pub gate_definitions_hash: Hash256,
    pub path_policy_hash: Hash256,
    pub privacy_policy_hash: Hash256,
    pub parity_areas: BTreeSet<String>,
}

impl CampaignManifest {
    pub fn canonical_hash(&self) -> Result<Hash256, DomainError> {
        let bytes = serde_json::to_vec(self).map_err(|_| DomainError::HashMismatch)?;
        Ok(Hash256::digest(bytes))
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        let identities = &self.identities;
        if self.ordered_worklist.is_empty()
            || self.ordered_worklist.len() > usize::from(self.budgets.max_abilities)
            || self.budgets.max_abilities > 40
            || self.budgets.max_batch_size == 0
            || self.budgets.max_batch_size > 8
            || self.budgets.max_assembly_attempts != 4
            || self.budgets.routine_refuters != 2
            || self.budgets.escalated_refuters != 3
            || self.budgets.max_shape_review_rounds != 3
            || self.budgets.max_full_gate_reruns != 2
            || self.budgets.family_threshold < 4
        {
            return Err(DomainError::ManifestMismatch);
        }

        let mut keys = BTreeSet::new();
        if self
            .ordered_worklist
            .iter()
            .any(|item| !keys.insert(item.key.clone()))
        {
            return Err(DomainError::Duplicate);
        }

        let pinned = [
            identities.model.as_str(),
            identities.reasoning.as_str(),
            identities.rig_version.as_str(),
            identities.app_server_version.as_str(),
            identities.engine_version.as_str(),
            self.workspace_id.as_str(),
            self.base_commit_id.as_str(),
        ];
        if pinned.iter().any(|value| value.trim().is_empty())
            || identities.protocol_version == 0
            || identities.role_schema_hashes.len() != 16
            || identities.provider_precedence.is_empty()
            || !identities.allowed_transports.contains("app-server")
            || identities.allowed_transports.iter().any(|transport| {
                transport.contains("api-key") || transport == "openai" || transport == "openai-api"
            })
        {
            return Err(DomainError::ManifestMismatch);
        }

        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunManifest {
    pub campaign_id: CampaignId,
    pub ability: AbilityKey,
    pub role: String,
    pub attempt: u8,
    pub voter: Option<u8>,
    pub request_artifact_hashes: Vec<Hash256>,
    pub transport: String,
    pub fallback_reason: Option<String>,
    pub remote_run_hash: Option<Hash256>,
    pub response_artifact_hash: Hash256,
    pub usage_artifact_hash: Hash256,
    pub identity_hash: Hash256,
}
