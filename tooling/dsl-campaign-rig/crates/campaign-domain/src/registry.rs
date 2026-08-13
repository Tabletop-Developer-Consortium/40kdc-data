use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{AbilityKey, DomainError, Hash256};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MechanicClusterId(String);

impl MechanicClusterId {
    pub fn from_signature(signature: &StructuralSignature) -> Result<Self, DomainError> {
        signature.validate()?;
        let hash =
            Hash256::digest(serde_json::to_vec(signature).map_err(|_| DomainError::HashMismatch)?);
        Ok(Self(format!("mc-{}", &hash.to_string()[..20])))
    }

    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        let valid = value.len() == 23
            && value.starts_with("mc-")
            && value[3..].bytes().all(|byte| byte.is_ascii_hexdigit());
        if valid {
            Ok(Self(value))
        } else {
            Err(DomainError::InvalidIdentity("mechanic-cluster-id"))
        }
    }
}

impl std::fmt::Display for MechanicClusterId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfidenceTier {
    Verified,
    TrustedProvisional,
    Suspect,
    Unpaired,
}

impl ConfidenceTier {
    pub fn template_eligible(self) -> bool {
        matches!(self, Self::Verified | Self::TrustedProvisional)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralSignature {
    pub trigger_family: String,
    pub condition_tree: String,
    pub effect_container_shape: String,
    pub target_scope_structure: String,
    pub modifier_dimensions: String,
    pub duration_usage: String,
    pub lever_signature: String,
    pub actor_binding: String,
    pub control_structure: String,
}

impl StructuralSignature {
    pub fn validate(&self) -> Result<(), DomainError> {
        if [
            &self.trigger_family,
            &self.condition_tree,
            &self.effect_container_shape,
            &self.target_scope_structure,
            &self.modifier_dimensions,
            &self.duration_usage,
            &self.lever_signature,
            &self.actor_binding,
            &self.control_structure,
        ]
        .into_iter()
        .any(|part| part.trim().is_empty())
        {
            Err(DomainError::ManifestMismatch)
        } else {
            Ok(())
        }
    }

    pub fn structurally_compatible(&self, other: &Self) -> bool {
        self == other
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbeddingVector {
    pub model: String,
    pub values: Vec<f32>,
}

impl EmbeddingVector {
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.model.trim().is_empty()
            || self.values.is_empty()
            || self.values.iter().any(|value| !value.is_finite())
        {
            Err(DomainError::ManifestMismatch)
        } else {
            Ok(())
        }
    }

    pub fn cosine(&self, other: &Self) -> Option<f64> {
        if self.model != other.model || self.values.len() != other.values.len() {
            return None;
        }
        let mut dot = 0.0_f64;
        let mut left = 0.0_f64;
        let mut right = 0.0_f64;
        for (a, b) in self.values.iter().zip(&other.values) {
            let a = f64::from(*a);
            let b = f64::from(*b);
            dot += a * b;
            left += a * a;
            right += b * b;
        }
        (left > 0.0 && right > 0.0).then(|| dot / (left.sqrt() * right.sqrt()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MechanicEmbeddings {
    pub source_evidence: Option<EmbeddingVector>,
    pub describer_output: Option<EmbeddingVector>,
    pub normalized_architecture: Option<EmbeddingVector>,
    pub normalized_dsl_structure: Option<EmbeddingVector>,
    pub combined_mechanic: Option<EmbeddingVector>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationProvenance {
    pub exact_dsl_hash: Hash256,
    pub clause_coverage_hash: Hash256,
    pub adversarial_review_hash: Hash256,
    pub mechanical_gates_hash: Hash256,
    pub lever_check_hash: Hash256,
    pub final_review_hash: Hash256,
    pub repository_revision: String,
}

impl VerificationProvenance {
    pub fn complete_for(&self, dsl_hash: Hash256) -> bool {
        self.exact_dsl_hash == dsl_hash
            && !self.repository_revision.trim().is_empty()
            && [
                self.clause_coverage_hash,
                self.adversarial_review_hash,
                self.mechanical_gates_hash,
                self.lever_check_hash,
                self.final_review_hash,
            ]
            .into_iter()
            .all(|hash| hash != Hash256::ZERO)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeedMember {
    pub key: AbilityKey,
    pub ability_type: String,
    pub detachment_context: Option<String>,
    pub source_hash: Option<Hash256>,
    pub source_provenance_hash: Option<Hash256>,
    pub normalized_dsl: Value,
    pub dsl_hash: Hash256,
    pub describer_output: String,
    pub scoring_describer_output: String,
    pub architecture_signature: String,
    pub clause_signature: String,
    pub structural_signature: StructuralSignature,
    pub canonical_shape_ids: BTreeSet<String>,
    pub lever_signature: String,
    pub roundtrip_score: Option<f64>,
    pub schema_valid: bool,
    pub integrity_valid: bool,
    pub verification_provenance: Option<VerificationProvenance>,
    pub repository_revision: String,
    pub corpus_version: String,
    pub embeddings: MechanicEmbeddings,
    pub confidence: ConfidenceTier,
    pub cluster_id: MechanicClusterId,
    pub confidence_reasons: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MechanicTemplate {
    pub template_hash: Hash256,
    pub source_member: AbilityKey,
    pub dsl_template: Value,
    pub parameter_schema: Value,
    pub confidence: ConfidenceTier,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ClusterExclusion {
    pub other_cluster_id: MechanicClusterId,
    pub distinction_code: String,
    pub evidence_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RejectedEquivalence {
    pub proposed_cluster_id: MechanicClusterId,
    pub distinction_code: String,
    pub refutation_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MechanicCluster {
    pub canonical_cluster_id: MechanicClusterId,
    pub structural_signature: StructuralSignature,
    pub evidence_embedding: Option<EmbeddingVector>,
    pub architecture_embedding: Option<EmbeddingVector>,
    pub dsl_structure_embedding: Option<EmbeddingVector>,
    pub canonical_shape_ids: BTreeSet<String>,
    pub parameter_schema: Value,
    pub lever_signature: String,
    pub accepted_templates: Vec<MechanicTemplate>,
    pub verified_exemplars: BTreeSet<AbilityKey>,
    pub provisional_members: BTreeSet<AbilityKey>,
    pub suspect_members: BTreeSet<AbilityKey>,
    pub unpaired_members: BTreeSet<AbilityKey>,
    pub known_exclusions: BTreeSet<ClusterExclusion>,
    pub rejected_equivalences: BTreeSet<RejectedEquivalence>,
    pub conflicting_members: BTreeSet<AbilityKey>,
    pub support_count: u32,
    pub confidence: ConfidenceTier,
    pub verification_provenance: BTreeSet<Hash256>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueueKind {
    Contradiction,
    Suspect,
    Novelty,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryQueueEntry {
    pub kind: QueueKind,
    pub member: AbilityKey,
    pub cluster_id: MechanicClusterId,
    pub priority: u32,
    pub reasons: BTreeSet<String>,
    pub nearest_cluster: Option<MechanicClusterId>,
    pub semantic_similarity: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryBody {
    pub schema_version: u32,
    pub corpus_root_hash: Hash256,
    pub repository_revision: String,
    pub embedding_model: String,
    pub members: Vec<SeedMember>,
    pub clusters: BTreeMap<MechanicClusterId, MechanicCluster>,
    pub contradiction_queue: Vec<RegistryQueueEntry>,
    pub suspect_queue: Vec<RegistryQueueEntry>,
    pub novelty_queue: Vec<RegistryQueueEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryRevision {
    pub revision_id: Hash256,
    pub parent_revision: Option<Hash256>,
    pub body: RegistryBody,
}

impl RegistryRevision {
    pub fn new(parent_revision: Option<Hash256>, body: RegistryBody) -> Result<Self, DomainError> {
        let revision_id = registry_revision_id(parent_revision, &body)?;
        let revision = Self {
            revision_id,
            parent_revision,
            body,
        };
        revision.validate()?;
        Ok(revision)
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        if self.body.schema_version != 1
            || self.body.repository_revision.trim().is_empty()
            || self.body.embedding_model.trim().is_empty()
        {
            return Err(DomainError::ManifestMismatch);
        }
        let expected = registry_revision_id(self.parent_revision, &self.body)?;
        if expected != self.revision_id {
            return Err(DomainError::InvalidIdentity("registry-revision-id"));
        }
        let mut member_keys = BTreeSet::new();
        for member in &self.body.members {
            member.structural_signature.validate()?;
            if !member_keys.insert(member.key.clone())
                || member.cluster_id
                    != MechanicClusterId::from_signature(&member.structural_signature)?
                || member.dsl_hash
                    != Hash256::digest(
                        serde_json::to_vec(&member.normalized_dsl)
                            .map_err(|_| DomainError::HashMismatch)?,
                    )
                || member.confidence == ConfidenceTier::Verified
                    && !member
                        .verification_provenance
                        .as_ref()
                        .is_some_and(|evidence| evidence.complete_for(member.dsl_hash))
            {
                return Err(DomainError::InvalidIdentity("registry-member"));
            }
        }
        for (cluster_id, cluster) in &self.body.clusters {
            if cluster_id != &cluster.canonical_cluster_id
                || cluster_id != &MechanicClusterId::from_signature(&cluster.structural_signature)?
            {
                return Err(DomainError::InvalidIdentity("registry-cluster"));
            }
            for template in &cluster.accepted_templates {
                let expected = Hash256::digest(
                    serde_json::to_vec(&(
                        &template.dsl_template,
                        &template.parameter_schema,
                        &cluster.structural_signature,
                    ))
                    .map_err(|_| DomainError::HashMismatch)?,
                );
                if template.template_hash != expected
                    || !member_keys.contains(&template.source_member)
                {
                    return Err(DomainError::InvalidIdentity("registry-template"));
                }
            }
            let assigned = cluster
                .verified_exemplars
                .iter()
                .chain(&cluster.provisional_members)
                .chain(&cluster.suspect_members)
                .chain(&cluster.unpaired_members)
                .collect::<BTreeSet<_>>();
            if assigned.len() != cluster.support_count as usize
                || assigned.iter().any(|key| {
                    !self.body.members.iter().any(|member| {
                        &member.key == *key
                            && &member.cluster_id == cluster_id
                            && match member.confidence {
                                ConfidenceTier::Verified => {
                                    cluster.verified_exemplars.contains(*key)
                                }
                                ConfidenceTier::TrustedProvisional => {
                                    cluster.provisional_members.contains(*key)
                                }
                                ConfidenceTier::Suspect => cluster.suspect_members.contains(*key),
                                ConfidenceTier::Unpaired => cluster.unpaired_members.contains(*key),
                            }
                    })
                })
            {
                return Err(DomainError::InvalidIdentity("registry-membership"));
            }
        }
        Ok(())
    }
}

fn registry_revision_id(
    parent_revision: Option<Hash256>,
    body: &RegistryBody,
) -> Result<Hash256, DomainError> {
    let serialized = serde_json::to_vec(body).map_err(|_| DomainError::HashMismatch)?;
    let canonical_body: RegistryBody =
        serde_json::from_slice(&serialized).map_err(|_| DomainError::HashMismatch)?;
    let bytes = serde_json::to_vec(&(parent_revision, canonical_body))
        .map_err(|_| DomainError::HashMismatch)?;
    Ok(Hash256::digest(bytes))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionLane {
    Fast,
    Review,
    Full,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RetrievalCandidate {
    pub cluster_id: MechanicClusterId,
    pub structural_compatible: bool,
    pub semantic_similarity: Option<f64>,
    pub confidence: ConfidenceTier,
    pub support_count: u32,
    pub negative_boundary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RetrievalDecision {
    pub registry_revision: Hash256,
    pub lane: ExecutionLane,
    pub selected_cluster: Option<MechanicClusterId>,
    pub selected_template_hash: Option<Hash256>,
    pub candidates: Vec<RetrievalCandidate>,
    pub reasons: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadOnlyEvidenceIdentity {
    pub source_hash: Hash256,
    pub normalized_dsl_hash: Hash256,
    pub semantic_validator_hash: Hash256,
    pub prompt_manifest_hash: Hash256,
    pub role_schema_hashes: Vec<Hash256>,
}

impl ReadOnlyEvidenceIdentity {
    pub fn compatible_with(&self, other: &Self) -> bool {
        self == other
    }
}

impl RetrievalDecision {
    pub fn requires_shape_tribunal(&self) -> bool {
        self.lane == ExecutionLane::Full
    }

    pub fn fast_path_valid(&self) -> bool {
        if self.lane != ExecutionLane::Fast {
            return true;
        }
        let (Some(cluster_id), Some(template_hash)) =
            (&self.selected_cluster, self.selected_template_hash)
        else {
            return false;
        };
        template_hash != Hash256::ZERO
            && self.candidates.iter().any(|candidate| {
                &candidate.cluster_id == cluster_id
                    && candidate.structural_compatible
                    && candidate
                        .semantic_similarity
                        .is_some_and(|similarity| similarity >= 0.80 && similarity.is_finite())
                    && candidate.negative_boundary.is_none()
                    && (candidate.confidence == ConfidenceTier::Verified
                        || candidate.confidence == ConfidenceTier::TrustedProvisional
                            && candidate.support_count >= 2)
            })
    }
}
