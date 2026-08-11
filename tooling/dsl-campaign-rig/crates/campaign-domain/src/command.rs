use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    AbilityKey, ActorId, CampaignId, CampaignManifest, CausationId, CommandId, CorrelationId,
    FencingToken, Hash256, OutboxId, ShapeId,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandMeta {
    pub command_id: CommandId,
    pub campaign_id: CampaignId,
    pub expected_stream_version: u64,
    pub causation_id: CausationId,
    pub correlation_id: CorrelationId,
    pub actor: ActorId,
    pub expected_manifest_hash: Option<Hash256>,
    pub expected_engine_hash: Hash256,
    pub outbox_id: Option<OutboxId>,
    pub fencing_token: Option<FencingToken>,
    #[serde(default)]
    pub lease_resource: Option<String>,
    #[serde(default)]
    pub lease_owner: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceFacts {
    pub artifact_hash: Hash256,
    pub source_hash: Hash256,
    pub all_clause_ids: BTreeSet<String>,
    pub mechanical_clause_ids: BTreeSet<String>,
    pub contiguous_partition: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchitectureFacts {
    pub artifact_hash: Hash256,
    pub evidence_hash: Hash256,
    pub covered_clause_ids: BTreeSet<String>,
    pub requires_shape: bool,
    pub closed_parent: bool,
    pub unresolved_bindings: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecompositionFacts {
    pub artifact_hash: Hash256,
    pub architecture_hash: Hash256,
    pub covered_clause_ids: BTreeSet<String>,
    pub who_complete: bool,
    pub when_complete: bool,
    pub what_complete: bool,
    pub deferred_lookups: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateFacts {
    pub artifact_hash: Hash256,
    pub decomposition_hash: Hash256,
    pub attempt: u8,
    pub exactly_mapped_clauses: BTreeSet<String>,
    pub source_or_schema_evidence_clauses: BTreeSet<String>,
    pub placeholder_encoding: bool,
    pub approx_mechanical_clause: bool,
    pub revision_thread_hash: Option<Hash256>,
    pub prior_divergence_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefutationFacts {
    pub artifact_hash: Hash256,
    pub candidate_hash: Hash256,
    pub voter: u8,
    pub voter_identity_hash: Hash256,
    pub divergence_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MechanicalVerificationFacts {
    pub artifact_hash: Hash256,
    pub candidate_hash: Hash256,
    pub applied_hash: Hash256,
    pub commit_id: String,
    pub all_fixed_gates_passed: bool,
    pub parity_pairs_passed: u8,
    pub lever_regression: bool,
    pub gate_run: u8,
    pub score_final: f64,
    pub correctness_justification_hash: Option<Hash256>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewFacts {
    pub artifact_hash: Hash256,
    pub candidate_hash: Hash256,
    pub verification_hash: Hash256,
    pub accepted: bool,
    pub severity3_count: u8,
    pub ten_anti_conditions_passed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloseFacts {
    pub artifact_hash: Hash256,
    pub sealed_head: String,
    pub terminal_ledger_complete: bool,
    pub fixed_gates_passed: bool,
    pub parity_pairs_passed: u8,
    pub whole_corpus_drift_clean: bool,
    pub target_means_non_regressing: bool,
    pub anti_conditions_passed: u8,
    pub conflict_free: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum CommandAction {
    CreateCampaign,
    FreezeManifest {
        manifest: CampaignManifest,
    },
    ImportLegacyEvidence {
        report_hash: Hash256,
    },
    StartCampaign,
    QueueAbility {
        key: AbilityKey,
    },
    BindEvidence {
        key: AbilityKey,
        facts: EvidenceFacts,
    },
    RecordArchitecture {
        key: AbilityKey,
        facts: ArchitectureFacts,
    },
    RecordDecomposerResult {
        key: AbilityKey,
        role: String,
        architecture_hash: Hash256,
        artifact_hash: Hash256,
    },
    RecordDecomposition {
        key: AbilityKey,
        facts: DecompositionFacts,
    },
    RequireShape {
        key: AbilityKey,
        shape_id: ShapeId,
    },
    OpenShapeLifecycle {
        key: AbilityKey,
        shape_id: ShapeId,
        package_hash: Hash256,
    },
    RecordShapeSurvey {
        key: AbilityKey,
        artifact_hash: Hash256,
    },
    ProposeCandidate {
        key: AbilityKey,
        facts: CandidateFacts,
    },
    OpenRefutationPanel {
        key: AbilityKey,
        escalated: bool,
    },
    RecordRefutation {
        key: AbilityKey,
        facts: RefutationFacts,
    },
    RequestRevision {
        key: AbilityKey,
        thread_hash: Hash256,
        resolved_divergence_ids: BTreeSet<String>,
    },
    AcceptCandidate {
        key: AbilityKey,
    },
    MarkNeedsSchema {
        key: AbilityKey,
        evidence_hash: Hash256,
    },
    AbandonAbility {
        key: AbilityKey,
        reason_hash: Hash256,
    },
    RequestApply {
        key: AbilityKey,
        expected_head: String,
        plan_hash: Hash256,
    },
    RecordAppliedPatch {
        key: AbilityKey,
        candidate_hash: Hash256,
        applied_hash: Hash256,
        commit_id: String,
        changed_paths: BTreeMap<String, Hash256>,
        no_op: bool,
    },
    RecordMechanicalVerificationFailure {
        key: AbilityKey,
        evidence_hash: Hash256,
        commit_id: String,
    },
    RequestAbilityRollback {
        key: AbilityKey,
        evidence_hash: Hash256,
        restore_head: String,
        terminal: bool,
    },
    RecordAbilityRollback {
        key: AbilityKey,
        evidence_hash: Hash256,
        restored_head: String,
    },
    RecordMechanicalVerification {
        key: AbilityKey,
        facts: MechanicalVerificationFacts,
    },
    RecordReviewerResult {
        key: AbilityKey,
        role: String,
        verification_hash: Hash256,
        artifact_hash: Hash256,
    },
    RequestReviewRevision {
        key: AbilityKey,
        verification_hash: Hash256,
        thread_hash: Hash256,
        finding_ids: BTreeSet<String>,
    },
    RecordReview {
        key: AbilityKey,
        facts: ReviewFacts,
    },
    ConvergeAbility {
        key: AbilityKey,
    },
    ProposeShape {
        shape_id: ShapeId,
        package_hash: Hash256,
    },
    RecordFamilySurvey {
        shape_id: ShapeId,
        survey_hash: Hash256,
        members: BTreeSet<AbilityKey>,
        flattening_exclusions: BTreeSet<AbilityKey>,
    },
    RecordDescriberSpec {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        render_form_count: u8,
    },
    RecordShapeReview {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        accepted: bool,
        resolved_findings: bool,
        refuter_count: u8,
    },
    ApproveShape {
        shape_id: ShapeId,
        implementation_matrix_complete: bool,
    },
    RequestShapeApply {
        shape_id: ShapeId,
        expected_head: String,
        plan_hash: Hash256,
    },
    RecordShapeApplied {
        shape_id: ShapeId,
        package_hash: Hash256,
        applied_hash: Hash256,
        commit_id: String,
        changed_paths: BTreeMap<String, Hash256>,
    },
    RecordShapeVerification {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        applied_hash: Hash256,
    },
    RecordShapeRollback {
        shape_id: ShapeId,
        artifact_hash: Hash256,
        applied_hash: Hash256,
        restored_head: String,
    },
    RejectShape {
        shape_id: ShapeId,
        singleton: bool,
    },
    RequestSeal,
    RecordSealedHead {
        base: String,
        head: String,
    },
    RecordCloseVerification {
        facts: CloseFacts,
    },
    AuthorizePublication {
        sealed_head: String,
    },
    RequestPublication {
        sealed_head: String,
    },
    RecordPublication {
        sealed_head: String,
        effect_hash: Hash256,
        checks_green: bool,
    },
    RecordPublicationProgress {
        sealed_head: String,
        effect_hash: Hash256,
    },
    RecordCloseFailure {
        artifact_hash: Hash256,
        sealed_head: String,
        terminal: bool,
    },
    AbortCampaign {
        reason_hash: Hash256,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub meta: CommandMeta,
    pub action: CommandAction,
}
