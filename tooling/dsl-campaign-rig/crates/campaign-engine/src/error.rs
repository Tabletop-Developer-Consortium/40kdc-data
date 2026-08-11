use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("store failure: {0}")]
    Store(#[from] campaign_store::StoreError),
    #[error("domain failure: {0}")]
    Domain(#[from] campaign_domain::DomainError),
    #[error("executor failure: {0}")]
    Executor(#[from] campaign_executors::ExecutorError),
    #[error("provider failure: {0}")]
    Provider(#[from] campaign_providers::ProviderError),
    #[error("role failure: {0}")]
    Role(#[from] campaign_roles::RoleError),
    #[error("campaign policy blocked the operation")]
    Policy,
    #[error("legacy evidence is ambiguous")]
    LegacyAmbiguous,
    #[error("benchmark comparison is invalid")]
    BenchmarkInvalid,
    #[error("JSON failure: {0}")]
    Json(#[from] serde_json::Error),
    #[error("filesystem failure: {0}")]
    Io(#[from] std::io::Error),
}
