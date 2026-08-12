use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{AbilityKey, CampaignId, CampaignManifest, Hash256, ShapeId};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CampaignPhase {
    #[default]
    Empty,
    Created,
    ManifestFrozen,
    Running,
    Sealing,
    Sealed,
    CloseVerified,
    PublishAuthorized,
    Publishing,
    Published,
    Aborting,
    Aborted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AbilityPhase {
    Queued,
    EvidenceBound,
    Architected,
    Decomposed,
    ShapeRequired,
    ShapeSurveyed,
    CandidateProposed,
    RefutationPanel,
    RevisionRequested,
    CandidateAccepted,
    ApplyRequested,
    Applied,
    VerificationFailed,
    MechanicallyVerified,
    Reviewed,
    RollbackRequested,
    Converged,
    NeedsSchema,
    Abandoned,
}

impl AbilityPhase {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Converged | Self::NeedsSchema | Self::Abandoned)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShapePhase {
    Proposed,
    FamilySurveyed,
    DescriberSpecified,
    UnderReview,
    RevisionRequested,
    Approved,
    ApplyRequested,
    Applied,
    Verified,
    RejectedSprawl,
    RejectedSingleton,
    NotConverged,
}
impl ShapePhase {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Verified | Self::RejectedSprawl | Self::RejectedSingleton | Self::NotConverged
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClauseSet {
    pub all: BTreeSet<String>,
    pub mechanical: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AbilityAggregate {
    pub phase: AbilityPhase,
    pub evidence_hash: Option<Hash256>,
    pub source_hash: Hash256,
    pub clauses: Option<ClauseSet>,
    pub architecture_hash: Option<Hash256>,
    pub required_shape_id: Option<ShapeId>,
    pub requires_shape: bool,
    pub decomposer_hashes: BTreeMap<String, Hash256>,
    pub decomposition_hash: Option<Hash256>,
    pub candidate_hash: Option<Hash256>,
    pub revision_thread_hash: Option<Hash256>,
    pub attempt: u8,
    pub escalated: bool,
    pub voters: BTreeMap<u8, Hash256>,
    #[serde(default)]
    pub voter_identity_hashes: BTreeSet<Hash256>,
    pub blocking_divergences: BTreeSet<String>,
    pub applied_hash: Option<Hash256>,
    pub apply_plan_hash: Option<Hash256>,
    pub applied_commit: Option<String>,
    pub rollback_evidence_hash: Option<Hash256>,
    pub rollback_head: Option<String>,
    pub rollback_terminal: bool,
    pub verification_hash: Option<Hash256>,
    pub review_hash: Option<Hash256>,
    pub reviewer_hashes: BTreeMap<String, Hash256>,
    pub score_start: f64,
    pub score_final: Option<f64>,
    pub correctness_justification_hash: Option<Hash256>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShapeAggregate {
    #[serde(default)]
    pub originating_ability: Option<AbilityKey>,
    pub phase: ShapePhase,
    pub family_hashes: Vec<Hash256>,
    pub family_members: BTreeSet<AbilityKey>,
    pub excluded_members: BTreeSet<AbilityKey>,
    #[serde(default)]
    pub internal_family_size: u8,
    pub review_hashes: Vec<Hash256>,
    pub review_round: u8,
    pub describer_hash: Option<Hash256>,
    pub package_hash: Option<Hash256>,
    pub apply_plan_hash: Option<Hash256>,
    pub applied_hash: Option<Hash256>,
    pub applied_commit: Option<String>,
    pub verification_hash: Option<Hash256>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CampaignState {
    pub campaign_id: Option<CampaignId>,
    pub phase: CampaignPhase,
    pub stream_version: u64,
    pub manifest: Option<CampaignManifest>,
    pub manifest_hash: Option<Hash256>,
    #[serde(default)]
    pub repository_head: Option<String>,
    #[serde(with = "ability_map")]
    pub abilities: BTreeMap<AbilityKey, AbilityAggregate>,
    pub shapes: BTreeMap<ShapeId, ShapeAggregate>,
    pub gate_runs: u8,
    #[serde(default)]
    pub close_gate_runs: u8,
    pub sealed_base: Option<String>,
    pub sealed_head: Option<String>,
    pub close_verification_hash: Option<Hash256>,
    pub publication_authorized_head: Option<String>,
    pub publication_effect_hash: Option<Hash256>,
}

impl Default for CampaignState {
    fn default() -> Self {
        Self {
            campaign_id: None,
            phase: CampaignPhase::Empty,
            stream_version: 0,
            manifest: None,
            manifest_hash: None,
            repository_head: None,
            abilities: BTreeMap::new(),
            shapes: BTreeMap::new(),
            gate_runs: 0,
            close_gate_runs: 0,
            sealed_base: None,
            sealed_head: None,
            close_verification_hash: None,
            publication_authorized_head: None,
            publication_effect_hash: None,
        }
    }
}

impl CampaignState {
    pub fn state_hash(&self) -> Hash256 {
        let bytes = serde_json::to_vec(self).expect("serializing campaign state cannot fail");
        Hash256::digest(bytes)
    }

    pub fn all_work_terminal(&self) -> bool {
        let Some(manifest) = &self.manifest else {
            return false;
        };
        self.abilities.len() == manifest.ordered_worklist.len()
            && self
                .abilities
                .values()
                .all(|ability| ability.phase.terminal())
            && self.shapes.values().all(|shape| shape.phase.terminal())
    }
}

mod ability_map {
    use std::collections::BTreeMap;

    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    use crate::{AbilityAggregate, AbilityKey};

    pub fn serialize<S>(
        value: &BTreeMap<AbilityKey, AbilityAggregate>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        value.iter().collect::<Vec<_>>().serialize(serializer)
    }

    pub fn deserialize<'de, D>(
        deserializer: D,
    ) -> Result<BTreeMap<AbilityKey, AbilityAggregate>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Vec::<(AbilityKey, AbilityAggregate)>::deserialize(deserializer)
            .map(|entries| entries.into_iter().collect())
    }
}
