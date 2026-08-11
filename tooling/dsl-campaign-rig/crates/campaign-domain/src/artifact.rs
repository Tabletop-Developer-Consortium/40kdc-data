use serde::{Deserialize, Serialize};

use crate::{AbilityKey, CampaignId, Hash256, ShapeId};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Sensitivity {
    Sensitive,
    Deidentified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactKind {
    SourceBytes,
    EvidencePacket,
    Architecture,
    Decomposition,
    CandidateDsl,
    RevisionThread,
    Refutation,
    ShapePackage,
    ApplyPlan,
    PublicationPlan,
    AppliedDiffInventory,
    Verification,
    RescoreReport,
    Review,
    ProseBaseline,
    ProseDiff,
    CloseReview,
    ProviderConversation,
    RunManifest,
    UsageSample,
    SubprocessOutput,
}

impl ArtifactKind {
    pub fn required_sensitivity(self) -> Option<Sensitivity> {
        match self {
            Self::SourceBytes
            | Self::ProviderConversation
            | Self::PublicationPlan
            | Self::ProseBaseline
            | Self::ProseDiff
            | Self::SubprocessOutput => Some(Sensitivity::Sensitive),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub artifact_id: Hash256,
    pub kind: ArtifactKind,
    pub sensitivity: Sensitivity,
    pub sha256: Hash256,
    pub byte_len: u64,
    pub media_type: String,
    pub canonicalization: String,
    pub campaign_id: CampaignId,
    pub ability: Option<AbilityKey>,
    pub shape_id: Option<ShapeId>,
    pub attempt: Option<u8>,
    pub parent_hashes: Vec<Hash256>,
    pub producer_run_id: Hash256,
    pub creation_sequence: u64,
}

impl ArtifactRef {
    pub fn validate(&self) -> bool {
        self.artifact_id == self.sha256
            && self.byte_len > 0
            && self
                .kind
                .required_sensitivity()
                .is_none_or(|required| required == self.sensitivity)
            && self.parent_hashes.windows(2).all(|pair| pair[0] <= pair[1])
    }
}
