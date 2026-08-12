use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    AbilityKey, ArchitectureFacts, CampaignId, CampaignManifest, CandidateFacts, CloseFacts,
    CommandId, DecompositionFacts, EvidenceFacts, Hash256, MechanicalVerificationFacts,
    RefutationFacts, ReviewFacts, ShapeId,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum EventPayload {
    CampaignCreated {
        campaign_id: CampaignId,
    },
    ManifestFrozen {
        manifest: CampaignManifest,
        manifest_hash: Hash256,
    },
    CampaignStarted,
    AbilityQueued {
        key: AbilityKey,
        source_hash: Hash256,
        score_start: f64,
    },
    EvidenceBound {
        key: AbilityKey,
        facts: EvidenceFacts,
    },
    ArchitectureRecorded {
        key: AbilityKey,
        facts: ArchitectureFacts,
    },
    DecomposerResultRecorded {
        key: AbilityKey,
        role: String,
        architecture_hash: Hash256,
        artifact_hash: Hash256,
    },
    DecompositionRecorded {
        key: AbilityKey,
        facts: DecompositionFacts,
    },
    ShapeRequired {
        key: AbilityKey,
        shape_id: ShapeId,
    },
    ShapeSurveyRecorded {
        key: AbilityKey,
        artifact_hash: Hash256,
    },
    CandidateProposed {
        key: AbilityKey,
        facts: CandidateFacts,
    },
    RefutationPanelOpened {
        key: AbilityKey,
        escalated: bool,
    },
    RefutationRecorded {
        key: AbilityKey,
        facts: RefutationFacts,
    },
    RevisionRequested {
        key: AbilityKey,
        thread_hash: Hash256,
        resolved_divergence_ids: BTreeSet<String>,
    },
    CandidateAccepted {
        key: AbilityKey,
    },
    AbilityMarkedNeedsSchema {
        key: AbilityKey,
        evidence_hash: Hash256,
    },
    AbilityAbandoned {
        key: AbilityKey,
        reason_hash: Hash256,
    },
    ApplyRequested {
        key: AbilityKey,
        expected_head: String,
        plan_hash: Hash256,
    },
    PatchApplied {
        key: AbilityKey,
        candidate_hash: Hash256,
        applied_hash: Hash256,
        commit_id: String,
        changed_paths: BTreeMap<String, Hash256>,
    },
    MechanicalVerificationFailed {
        key: AbilityKey,
        evidence_hash: Hash256,
        commit_id: String,
    },
    AbilityRollbackRequested {
        key: AbilityKey,
        evidence_hash: Hash256,
        restore_head: String,
        terminal: bool,
    },
    AbilityRolledBack {
        key: AbilityKey,
        evidence_hash: Hash256,
        restored_head: String,
    },
    MechanicalVerificationRecorded {
        key: AbilityKey,
        facts: MechanicalVerificationFacts,
    },
    ReviewRecorded {
        key: AbilityKey,
        facts: ReviewFacts,
    },
    ReviewerResultRecorded {
        key: AbilityKey,
        role: String,
        verification_hash: Hash256,
        artifact_hash: Hash256,
    },
    ReviewRevisionRequested {
        key: AbilityKey,
        verification_hash: Hash256,
        thread_hash: Hash256,
        finding_ids: BTreeSet<String>,
    },
    AbilityConverged {
        key: AbilityKey,
    },
    ShapeProposed {
        shape_id: ShapeId,
        package_hash: Hash256,
    },
    ShapeFamilySurveyed {
        shape_id: ShapeId,
        survey_hash: Hash256,
        #[serde(default)]
        internal_family_size: u8,
        members: BTreeSet<AbilityKey>,
        flattening_exclusions: BTreeSet<AbilityKey>,
    },
    ShapeDescriberSpecified {
        shape_id: ShapeId,
        artifact_hash: Hash256,
    },
    ShapeReviewRecorded {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        accepted: bool,
    },
    ShapeApproved {
        shape_id: ShapeId,
    },
    ShapeApplyRequested {
        shape_id: ShapeId,
        expected_head: String,
        plan_hash: Hash256,
    },
    ShapeApplied {
        shape_id: ShapeId,
        package_hash: Hash256,
        applied_hash: Hash256,
        commit_id: String,
        changed_paths: BTreeMap<String, Hash256>,
    },
    ShapeVerificationRecorded {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        applied_hash: Hash256,
    },
    ShapeRolledBack {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        applied_hash: Hash256,
        restored_head: String,
    },
    ShapeRejected {
        shape_id: ShapeId,
        singleton: bool,
    },
    SealRequested,
    CampaignSealed {
        base: String,
        head: String,
    },
    CloseVerificationRecorded {
        facts: CloseFacts,
    },
    PublicationAuthorized {
        sealed_head: String,
    },
    PublicationRequested {
        sealed_head: String,
    },
    PublicationProgressRecorded {
        sealed_head: String,
        effect_hash: Hash256,
    },
    CampaignPublished {
        sealed_head: String,
        effect_hash: Hash256,
    },
    CampaignAbortRequested {
        reason_hash: Hash256,
    },
    CloseVerificationFailed {
        artifact_hash: Hash256,
        sealed_head: String,
        terminal: bool,
    },
    CampaignAborted,
    LegacyEvidenceImported {
        report_hash: Hash256,
    },
}

impl EventPayload {
    pub fn event_type(&self) -> &'static str {
        match self {
            Self::CampaignCreated { .. } => "campaign-created",
            Self::ManifestFrozen { .. } => "manifest-frozen",
            Self::CampaignStarted => "campaign-started",
            Self::AbilityQueued { .. } => "ability-queued",
            Self::EvidenceBound { .. } => "evidence-bound",
            Self::DecomposerResultRecorded { .. } => "decomposer-result-recorded",
            Self::ArchitectureRecorded { .. } => "architecture-recorded",
            Self::DecompositionRecorded { .. } => "decomposition-recorded",
            Self::ShapeRequired { .. } => "shape-required",
            Self::ShapeSurveyRecorded { .. } => "shape-survey-recorded",
            Self::CandidateProposed { .. } => "candidate-proposed",
            Self::RefutationPanelOpened { .. } => "refutation-panel-opened",
            Self::RefutationRecorded { .. } => "refutation-recorded",
            Self::RevisionRequested { .. } => "revision-requested",
            Self::CandidateAccepted { .. } => "candidate-accepted",
            Self::AbilityMarkedNeedsSchema { .. } => "ability-marked-needs-schema",
            Self::AbilityAbandoned { .. } => "ability-abandoned",
            Self::ApplyRequested { .. } => "apply-requested",
            Self::PatchApplied { .. } => "patch-applied",
            Self::AbilityRollbackRequested { .. } => "ability-rollback-requested",
            Self::MechanicalVerificationFailed { .. } => "mechanical-verification-failed",
            Self::AbilityRolledBack { .. } => "ability-rolled-back",
            Self::MechanicalVerificationRecorded { .. } => "mechanical-verification-recorded",
            Self::ReviewRecorded { .. } => "review-recorded",
            Self::AbilityConverged { .. } => "ability-converged",
            Self::ReviewRevisionRequested { .. } => "review-revision-requested",
            Self::ReviewerResultRecorded { .. } => "reviewer-result-recorded",
            Self::ShapeProposed { .. } => "shape-proposed",
            Self::ShapeFamilySurveyed { .. } => "shape-family-surveyed",
            Self::ShapeDescriberSpecified { .. } => "shape-describer-specified",
            Self::ShapeReviewRecorded { .. } => "shape-review-recorded",
            Self::ShapeApproved { .. } => "shape-approved",
            Self::ShapeApplyRequested { .. } => "shape-apply-requested",
            Self::ShapeApplied { .. } => "shape-applied",
            Self::ShapeVerificationRecorded { .. } => "shape-verification-recorded",
            Self::ShapeRolledBack { .. } => "shape-rolled-back",
            Self::ShapeRejected { .. } => "shape-rejected",
            Self::SealRequested => "seal-requested",
            Self::CampaignSealed { .. } => "campaign-sealed",
            Self::CloseVerificationRecorded { .. } => "close-verification-recorded",
            Self::PublicationAuthorized { .. } => "publication-authorized",
            Self::PublicationRequested { .. } => "publication-requested",
            Self::PublicationProgressRecorded { .. } => "publication-progress-recorded",
            Self::CampaignPublished { .. } => "campaign-published",
            Self::CampaignAbortRequested { .. } => "campaign-abort-requested",
            Self::CloseVerificationFailed { .. } => "close-verification-failed",
            Self::CampaignAborted => "campaign-aborted",
            Self::LegacyEvidenceImported { .. } => "legacy-evidence-imported",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DomainEvent {
    pub command_id: CommandId,
    pub stream_version: u64,
    pub payload: EventPayload,
}
