use std::str::FromStr;

use campaign_domain::{CampaignId, Hash256, RegistryRevision};
use rusqlite::{OptionalExtension, Transaction, params};

use crate::{CampaignStore, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryPromotionReceipt {
    pub campaign_id: CampaignId,
    pub source_revision: Hash256,
    pub promoted_revision: Hash256,
    pub close_evidence_hash: Hash256,
}

fn registry_head(transaction: &Transaction<'_>) -> Result<Option<Hash256>, StoreError> {
    transaction
        .query_row(
            "SELECT revision_id FROM mechanic_registry_head WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| Hash256::from_str(&value))
        .transpose()
        .map_err(|_| StoreError::CorruptRegistry)
}

fn persist_registry_revision(
    transaction: &Transaction<'_>,
    revision: &RegistryRevision,
    bytes: &[u8],
    now: i64,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT OR IGNORE INTO mechanic_registry_revisions(
            revision_id, parent_revision, corpus_root_hash, repository_revision,
            body_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            revision.revision_id.to_string(),
            revision.parent_revision.map(|hash| hash.to_string()),
            revision.body.corpus_root_hash.to_string(),
            revision.body.repository_revision,
            bytes,
            now,
        ],
    )?;
    let stored: Vec<u8> = transaction.query_row(
        "SELECT body_json FROM mechanic_registry_revisions WHERE revision_id = ?1",
        [revision.revision_id.to_string()],
        |row| row.get(0),
    )?;
    if stored.as_slice() != bytes {
        return Err(StoreError::CorruptRegistry);
    }
    Ok(())
}

impl CampaignStore {
    pub fn put_registry_revision(
        &self,
        revision: &RegistryRevision,
        expected_head: Option<Hash256>,
    ) -> Result<Hash256, StoreError> {
        revision
            .validate()
            .map_err(|_| StoreError::CorruptRegistry)?;
        let bytes = serde_json::to_vec(revision)?;
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let current_head = registry_head(&transaction)?;
        if current_head != expected_head || revision.parent_revision != expected_head {
            return Err(StoreError::RegistryConflict);
        }
        persist_registry_revision(&transaction, revision, &bytes, now)?;
        transaction.execute(
            "INSERT INTO mechanic_registry_head(singleton, revision_id, updated_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET
               revision_id = excluded.revision_id,
               updated_at = excluded.updated_at",
            params![revision.revision_id.to_string(), now],
        )?;
        transaction.commit()?;
        Ok(revision.revision_id)
    }

    pub fn promote_registry_revision(
        &self,
        revision: &RegistryRevision,
        expected_head: Hash256,
        receipt: &RegistryPromotionReceipt,
    ) -> Result<Hash256, StoreError> {
        revision
            .validate()
            .map_err(|_| StoreError::CorruptRegistry)?;
        if revision.parent_revision != Some(expected_head)
            || receipt.source_revision != expected_head
            || receipt.promoted_revision != revision.revision_id
        {
            return Err(StoreError::RegistryConflict);
        }
        let bytes = serde_json::to_vec(revision)?;
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let current_head = registry_head(&transaction)?;
        if current_head != Some(expected_head) {
            return Err(StoreError::RegistryConflict);
        }
        persist_registry_revision(&transaction, revision, &bytes, now)?;
        transaction.execute(
            "INSERT INTO campaign_registry_promotions(
                campaign_id, source_revision, promoted_revision, close_evidence_hash, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(campaign_id) DO NOTHING",
            params![
                receipt.campaign_id.to_string(),
                receipt.source_revision.to_string(),
                receipt.promoted_revision.to_string(),
                receipt.close_evidence_hash.to_string(),
                now,
            ],
        )?;
        let stored_receipt = transaction
            .query_row(
                "SELECT source_revision, promoted_revision, close_evidence_hash
                 FROM campaign_registry_promotions WHERE campaign_id = ?1",
                [receipt.campaign_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or(StoreError::RegistryConflict)?;
        if stored_receipt
            != (
                receipt.source_revision.to_string(),
                receipt.promoted_revision.to_string(),
                receipt.close_evidence_hash.to_string(),
            )
        {
            return Err(StoreError::RegistryConflict);
        }
        transaction.execute(
            "UPDATE mechanic_registry_head
             SET revision_id = ?1, updated_at = ?2
             WHERE singleton = 1 AND revision_id = ?3",
            params![
                revision.revision_id.to_string(),
                now,
                expected_head.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(revision.revision_id)
    }

    pub fn registry_revision(
        &self,
        revision_id: Hash256,
    ) -> Result<Option<RegistryRevision>, StoreError> {
        let connection = self.connection.lock();
        let bytes = connection
            .query_row(
                "SELECT body_json FROM mechanic_registry_revisions WHERE revision_id = ?1",
                [revision_id.to_string()],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        bytes
            .map(|bytes| {
                let revision: RegistryRevision = serde_json::from_slice(&bytes)?;
                revision.validate().map_err(StoreError::Domain)?;
                Ok(revision)
            })
            .transpose()
    }

    pub fn registry_head(&self) -> Result<Option<Hash256>, StoreError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT revision_id FROM mechanic_registry_head WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| Hash256::from_str(&value).map_err(|_| StoreError::CorruptRegistry))
            .transpose()
    }

    pub fn record_registry_promotion(
        &self,
        receipt: &RegistryPromotionReceipt,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO campaign_registry_promotions(
                campaign_id, source_revision, promoted_revision, close_evidence_hash, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(campaign_id) DO NOTHING",
            params![
                receipt.campaign_id.to_string(),
                receipt.source_revision.to_string(),
                receipt.promoted_revision.to_string(),
                receipt.close_evidence_hash.to_string(),
                time::OffsetDateTime::now_utc().unix_timestamp(),
            ],
        )?;
        drop(connection);
        let stored = self.registry_promotion(&receipt.campaign_id)?;
        if stored.as_ref() != Some(receipt) {
            return Err(StoreError::RegistryConflict);
        }
        Ok(())
    }

    pub fn registry_promotion(
        &self,
        campaign_id: &CampaignId,
    ) -> Result<Option<RegistryPromotionReceipt>, StoreError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT source_revision, promoted_revision, close_evidence_hash
                 FROM campaign_registry_promotions WHERE campaign_id = ?1",
                [campaign_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(source, promoted, evidence)| {
                Ok(RegistryPromotionReceipt {
                    campaign_id: campaign_id.clone(),
                    source_revision: Hash256::from_str(&source)
                        .map_err(|_| StoreError::CorruptRegistry)?,
                    promoted_revision: Hash256::from_str(&promoted)
                        .map_err(|_| StoreError::CorruptRegistry)?,
                    close_evidence_hash: Hash256::from_str(&evidence)
                        .map_err(|_| StoreError::CorruptRegistry)?,
                })
            })
            .transpose()
    }
}
