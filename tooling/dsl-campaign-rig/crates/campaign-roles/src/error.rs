use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum RoleError {
    #[error("unknown campaign role")]
    UnknownRole,
    #[error("role prompt manifest is invalid")]
    ManifestInvalid,
    #[error("role prompt or schema hash drifted")]
    HashDrift,
    #[error("role result failed JSON Schema")]
    SchemaInvalid,
    #[error("role result failed semantic validation: {0}")]
    SemanticInvalid(&'static str),
    #[error("runtime role provenance does not match the request")]
    ProvenanceMismatch,
    #[error("automatically repaired structured output cannot count as evidence")]
    RepairedOutput,
    #[error("transport failed before a valid result")]
    Transport,
    #[error("provider rejected the role turn: {0}")]
    ProviderFailure(&'static str),
    #[error("provider turn outcome is ambiguous")]
    Unreconciled,
}
