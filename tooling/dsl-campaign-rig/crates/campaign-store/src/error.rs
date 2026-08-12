use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("campaign state root must be outside the repository")]
    RepositoryLocalState,
    #[error("campaign state permissions are unsupported on this platform")]
    UnsupportedPlatform,
    #[error("unsupported store schema version {0}")]
    UnsupportedSchema(i64),
    #[error("event payload checksum mismatch")]
    CorruptEvent,
    #[error("referenced artifact is missing")]
    MissingArtifact,
    #[error("command receipt conflicts with the requested command")]
    ReceiptConflict,
    #[error("lease is currently held")]
    LeaseHeld,
    #[error("lease is stale or superseded")]
    StaleLease,
    #[error("outbox effect cannot be reconciled")]
    Unreconciled,
    #[error("domain rejected command: {0}")]
    Domain(#[from] campaign_domain::DomainError),
    #[error("SQLite failure: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization failure: {0}")]
    Json(#[from] serde_json::Error),
}
