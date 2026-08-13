use std::str::FromStr;

use campaign_domain::{Hash256, ReadOnlyEvidenceIdentity};
use rusqlite::{OptionalExtension, params};

use crate::{CampaignStore, StoreError};

impl CampaignStore {
    pub fn put_reusable_read_only_evidence(
        &self,
        identity: &ReadOnlyEvidenceIdentity,
        artifact_hash: Hash256,
    ) -> Result<Hash256, StoreError> {
        let identity_hash = Hash256::digest(serde_json::to_vec(identity)?);
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO reusable_read_only_evidence(
                identity_hash, source_hash, normalized_dsl_hash, semantic_validator_hash,
                prompt_manifest_hash, role_schema_hashes_json, artifact_hash, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(identity_hash) DO NOTHING",
            params![
                identity_hash.to_string(),
                identity.source_hash.to_string(),
                identity.normalized_dsl_hash.to_string(),
                identity.semantic_validator_hash.to_string(),
                identity.prompt_manifest_hash.to_string(),
                serde_json::to_vec(&identity.role_schema_hashes)?,
                artifact_hash.to_string(),
                time::OffsetDateTime::now_utc().unix_timestamp(),
            ],
        )?;
        let stored = connection.query_row(
            "SELECT artifact_hash FROM reusable_read_only_evidence WHERE identity_hash = ?1",
            [identity_hash.to_string()],
            |row| row.get::<_, String>(0),
        )?;
        let stored = Hash256::from_str(&stored).map_err(|_| StoreError::CorruptRegistry)?;
        if stored != artifact_hash {
            return Err(StoreError::RegistryConflict);
        }
        Ok(identity_hash)
    }

    pub fn reusable_read_only_evidence(
        &self,
        identity: &ReadOnlyEvidenceIdentity,
    ) -> Result<Option<Hash256>, StoreError> {
        let identity_hash = Hash256::digest(serde_json::to_vec(identity)?);
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT artifact_hash FROM reusable_read_only_evidence WHERE identity_hash = ?1",
                [identity_hash.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| Hash256::from_str(&value).map_err(|_| StoreError::CorruptRegistry))
            .transpose()
    }
}
