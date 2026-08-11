use thiserror::Error;

use crate::TransportCheckpoint;

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("ChatGPT subscription authentication is required")]
    SubscriptionRequired,
    #[error("API-key authentication is forbidden")]
    ApiKeyForbidden,
    #[error("App Server protocol is incompatible")]
    ProtocolMismatch,
    #[error("provider or model identity mismatch")]
    IdentityMismatch,
    #[error("provider turn has an ambiguous remote outcome")]
    Unreconciled(Option<TransportCheckpoint>),
    #[error("provider usage reporting is unavailable")]
    UsageUnavailable,
    #[error("direct Rig transport is not compiled or compatible")]
    DirectUnavailable,
    #[error("strict structured output failed")]
    InvalidStructuredOutput,
    #[error("requested capability is outside the role contract")]
    CapabilityDenied,
    #[error("provider process ended unexpectedly")]
    ProcessEnded,
    #[error("provider operation timed out")]
    Timeout,
    #[error("provider I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("provider JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("role contract failed")]
    Role,
}
