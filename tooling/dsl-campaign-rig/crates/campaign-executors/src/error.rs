use thiserror::Error;

use crate::Capability;

#[derive(Debug, Error)]
pub enum ExecutorError {
    #[error("capability denied: {0:?}")]
    CapabilityDenied(Capability),
    #[error("state root is not external to the repository")]
    RepositoryLocalState,
    #[error("sensitive content reached a deidentified boundary")]
    SensitiveContent,
    #[error("subprocess command is not in the fixed contract")]
    CommandNotAllowed,
    #[error("subprocess failed with exit code {0}")]
    ProcessFailed(i32),
    #[error("subprocess output exceeded the configured limit")]
    OutputLimit,
    #[error("artifact identity mismatch")]
    IdentityMismatch,
    #[error("lookup is missing or ambiguous")]
    AmbiguousLookup,
    #[error("evidence packet partition or hash is invalid")]
    InvalidEvidence,
    #[error("unexpected changed path")]
    UnexpectedPath,
    #[error("application is a no-op")]
    NoOp,
    #[error("jj identity or workspace mismatch")]
    JjMismatch,
    #[error("required gate or parity area failed")]
    GateFailed,
    #[error("publication is not authorized")]
    PublicationDenied,
    #[error("filesystem failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON failure: {0}")]
    Json(#[from] serde_json::Error),
}
