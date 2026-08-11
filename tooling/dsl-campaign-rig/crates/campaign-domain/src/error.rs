use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("wrong aggregate state")]
    WrongState,
    #[error("stream version conflict")]
    VersionConflict,
    #[error("campaign manifest identity mismatch")]
    ManifestMismatch,
    #[error("stale parent artifact")]
    StaleParentArtifact,
    #[error("mixed evidence family")]
    MixedEvidenceFamily,
    #[error("artifact hash mismatch")]
    HashMismatch,
    #[error("clause coverage mismatch")]
    ClauseCoverageMismatch,
    #[error("mechanical clause is unmapped")]
    MechanicalClauseUnmapped,
    #[error("placeholder encoding is forbidden")]
    PlaceholderEncoding,
    #[error("mechanical approximation is forbidden")]
    ApproxMechanicalClause,
    #[error("cruncher lever regression")]
    LeverRegression,
    #[error("refuter quorum is incomplete")]
    InsufficientQuorum,
    #[error("assembly attempt budget exhausted")]
    AttemptBudgetExhausted,
    #[error("gate rerun budget exhausted")]
    GateBudgetExhausted,
    #[error("shape family threshold not met")]
    FamilyThresholdNotMet,
    #[error("member is outside the frozen manifest")]
    OutOfManifestMember,
    #[error("repository change is outside the exact allowlist")]
    UnexpectedChangedPath,
    #[error("implementation matrix is incomplete")]
    ImplementationMatrixIncomplete,
    #[error("candidate and applied commit do not match")]
    CandidateCommitMismatch,
    #[error("application produced no change")]
    NoOpApplication,
    #[error("audit attempted before application")]
    AuditBeforeApply,
    #[error("whole-corpus drift outside the worklist")]
    NonWorklistDrift,
    #[error("target faction mean regressed")]
    FactionMeanRegression,
    #[error("sensitive data crossed the repository boundary")]
    IpBoundaryViolation,
    #[error("lease is stale or superseded")]
    StaleLease,
    #[error("external effect cannot be reconciled")]
    EffectUnreconciled,
    #[error("provider identity mismatch")]
    ProviderIdentityMismatch,
    #[error("serialized run identity cannot be resumed")]
    ResumeVersionMismatch,
    #[error("publication was not explicitly authorized")]
    PublicationNotAuthorized,
    #[error("invalid identity: {0}")]
    InvalidIdentity(&'static str),
    #[error("campaign already exists")]
    AlreadyExists,
    #[error("duplicate ability or voter")]
    Duplicate,
    #[error("revision thread is incomplete")]
    IncompleteRevisionThread,
    #[error("required close invariant failed: {0}")]
    CloseInvariant(&'static str),
}

impl DomainError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::WrongState => "wrong_state",
            Self::VersionConflict => "version_conflict",
            Self::ManifestMismatch => "manifest_mismatch",
            Self::StaleParentArtifact => "stale_parent_artifact",
            Self::MixedEvidenceFamily => "mixed_evidence_family",
            Self::HashMismatch => "hash_mismatch",
            Self::ClauseCoverageMismatch => "clause_coverage_mismatch",
            Self::MechanicalClauseUnmapped => "mechanical_clause_unmapped",
            Self::PlaceholderEncoding => "placeholder_encoding",
            Self::ApproxMechanicalClause => "approx_mechanical_clause",
            Self::LeverRegression => "lever_regression",
            Self::InsufficientQuorum => "insufficient_quorum",
            Self::AttemptBudgetExhausted => "attempt_budget_exhausted",
            Self::GateBudgetExhausted => "gate_budget_exhausted",
            Self::FamilyThresholdNotMet => "family_threshold_not_met",
            Self::OutOfManifestMember => "out_of_manifest_member",
            Self::UnexpectedChangedPath => "unexpected_changed_path",
            Self::ImplementationMatrixIncomplete => "implementation_matrix_incomplete",
            Self::CandidateCommitMismatch => "candidate_commit_mismatch",
            Self::NoOpApplication => "no_op_application",
            Self::AuditBeforeApply => "audit_before_apply",
            Self::NonWorklistDrift => "nonworklist_drift",
            Self::FactionMeanRegression => "faction_mean_regression",
            Self::IpBoundaryViolation => "ip_boundary_violation",
            Self::StaleLease => "stale_lease",
            Self::EffectUnreconciled => "effect_unreconciled",
            Self::ProviderIdentityMismatch => "provider_identity_mismatch",
            Self::ResumeVersionMismatch => "resume_version_mismatch",
            Self::PublicationNotAuthorized => "publication_not_authorized",
            Self::InvalidIdentity(_) => "invalid_identity",
            Self::AlreadyExists => "already_exists",
            Self::Duplicate => "duplicate",
            Self::IncompleteRevisionThread => "incomplete_revision_thread",
            Self::CloseInvariant(_) => "close_invariant",
        }
    }
}
