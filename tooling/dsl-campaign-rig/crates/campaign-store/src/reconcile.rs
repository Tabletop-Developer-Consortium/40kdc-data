use campaign_domain::Hash256;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use crate::{CampaignStore, EffectKind, StoreError};

impl CampaignStore {
    pub fn outbox_key_for_reference(&self, outbox_reference: &str) -> Result<String, StoreError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT idempotency_key FROM outbox
                 WHERE outbox_id = ?1 OR idempotency_key = ?1",
                [outbox_reference],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or(StoreError::Unreconciled)
    }

    pub fn reconcile_effect_receipt(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<Value>, StoreError> {
        let connection = self.connection.lock();
        let receipt = connection
            .query_row(
                "SELECT effect_kind, observed_identity_json, observed_sha256
                 FROM effect_receipts WHERE idempotency_key=?1",
                [idempotency_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((effect_kind, observed_json, expected_hash)) = receipt else {
            return Ok(None);
        };
        if Hash256::digest(observed_json.as_bytes()).to_string() != expected_hash {
            return Err(StoreError::CorruptEvent);
        }
        let changed = connection.execute(
            "UPDATE outbox SET status='observed', completed_at=COALESCE(completed_at, strftime('%s','now'))
             WHERE idempotency_key=?1 AND effect_kind=?2 AND status IN ('executing','unreconciled','observed')",
            params![idempotency_key, effect_kind],
        )?;
        if changed != 1 {
            return Err(StoreError::Unreconciled);
        }
        Ok(Some(serde_json::from_str(&observed_json)?))
    }

    pub fn unreconciled_effects(&self) -> Result<Vec<(String, EffectKind)>, StoreError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT idempotency_key, effect_kind FROM outbox WHERE status IN ('executing','unreconciled') ORDER BY idempotency_key",
        )?;
        let rows = statement.query_map([], |row| {
            let key = row.get::<_, String>(0)?;
            let effect = row.get::<_, String>(1)?;
            let effect = serde_json::from_str(&format!("\"{effect}\""))
                .map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok((key, effect))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}
