use campaign_domain::{Hash256, OutboxId};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CampaignStore, StoreError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectKind {
    RepositoryApply,
    Generate,
    Validate,
    Score,
    Bookmark,
    Push,
    DraftPr,
    ProviderTurn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutboxStatus {
    Pending,
    Executing,
    Observed,
    Failed,
    Unreconciled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OutboxRecord {
    pub outbox_id: String,
    pub command_id: String,
    pub effect_kind: EffectKind,
    pub idempotency_key: String,
    pub request: Value,
    pub status: OutboxStatus,
    pub fencing_token: u64,
    pub attempt_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectIntent {
    pub outbox_id: OutboxId,
    pub effect_kind: EffectKind,
    pub idempotency_key: String,
    pub request: Value,
    pub fencing_token: u64,
    pub available_at: i64,
}

impl CampaignStore {
    pub fn enqueue_effect(
        &self,
        outbox_id: OutboxId,
        command_id: impl ToString,
        effect_kind: EffectKind,
        idempotency_key: &str,
        request: &Value,
        fencing_token: u64,
        available_at: i64,
    ) -> Result<OutboxRecord, StoreError> {
        reject_sensitive_keys(request)?;
        let request_json = serde_json::to_string(request)?;
        let request_hash = Hash256::digest(request_json.as_bytes());
        let connection = self.connection.lock();
        let changed = connection.execute(
            "INSERT INTO outbox(outbox_id, command_id, effect_kind, idempotency_key, request_json,
                request_sha256, status, fencing_token, attempt_count, available_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 0, ?8)
             ON CONFLICT(idempotency_key) DO NOTHING",
            params![
                outbox_id.to_string(),
                command_id.to_string(),
                enum_text(effect_kind)?,
                idempotency_key,
                request_json,
                request_hash.to_string(),
                fencing_token as i64,
                available_at,
            ],
        )?;
        if changed == 0 {
            ensure_effect_identity(
                &connection,
                idempotency_key,
                &command_id.to_string(),
                effect_kind,
                request_hash,
            )?;
        }
        drop(connection);
        self.outbox_by_key(idempotency_key)?
            .ok_or(StoreError::Unreconciled)
    }

    pub fn claim_effect(
        &self,
        idempotency_key: &str,
        fencing_token: u64,
        now: i64,
    ) -> Result<OutboxRecord, StoreError> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE outbox SET status='executing', fencing_token=?2, started_at=?3,
                attempt_count=attempt_count+1
             WHERE idempotency_key=?1 AND fencing_token<=?2
                AND status IN ('pending','failed') AND available_at<=?3",
            params![idempotency_key, fencing_token as i64, now],
        )?;
        if changed != 1 {
            return Err(StoreError::StaleLease);
        }
        drop(connection);
        self.outbox_by_key(idempotency_key)?
            .ok_or(StoreError::Unreconciled)
    }

    pub fn observed_effect_artifact(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<Hash256>, StoreError> {
        let connection = self.connection.lock();
        let value = connection.query_row(
            "SELECT result_artifact_id FROM outbox WHERE idempotency_key=?1 AND status='observed'",
            [idempotency_key],
            |row| row.get::<_, Option<String>>(0),
        ).optional()?.flatten();
        value
            .map(|hash| Hash256::from_hex(&hash).map_err(|_| StoreError::CorruptEvent))
            .transpose()
    }

    pub fn record_effect_observed(
        &self,
        idempotency_key: &str,
        effect_kind: EffectKind,
        observed_identity: &Value,
        result_artifact_id: Option<Hash256>,
        fencing_token: u64,
        now: i64,
    ) -> Result<(), StoreError> {
        reject_sensitive_keys(observed_identity)?;
        let observed_json = serde_json::to_string(observed_identity)?;
        let observed_hash = Hash256::digest(observed_json.as_bytes());
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO effect_receipts(idempotency_key, effect_kind, observed_identity_json,
                observed_sha256, completed_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(idempotency_key) DO NOTHING",
            params![
                idempotency_key,
                enum_text(effect_kind)?,
                observed_json,
                observed_hash.to_string(),
                now
            ],
        )?;
        let existing = transaction.query_row(
            "SELECT effect_kind, observed_sha256
             FROM effect_receipts WHERE idempotency_key=?1",
            [idempotency_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        if existing != (enum_text(effect_kind)?, observed_hash.to_string()) {
            return Err(StoreError::Unreconciled);
        }
        let changed = transaction.execute(
            "UPDATE outbox SET status='observed', completed_at=COALESCE(completed_at, ?3),
                result_artifact_id=COALESCE(result_artifact_id, ?4), last_error_code=NULL
             WHERE idempotency_key=?1
                AND ((status='executing' AND fencing_token=?2) OR status='observed')
                AND (result_artifact_id IS NULL OR result_artifact_id=?4)",
            params![
                idempotency_key,
                fencing_token as i64,
                now,
                result_artifact_id.map(|hash| hash.to_string()),
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Unreconciled);
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_effect_unreconciled(
        &self,
        idempotency_key: &str,
        fencing_token: u64,
        code: &str,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE outbox SET status='unreconciled', last_error_code=?3
             WHERE idempotency_key=?1 AND fencing_token=?2 AND status='executing'",
            params![idempotency_key, fencing_token as i64, code],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(StoreError::Unreconciled)
        }
    }
    pub fn mark_effect_failed(
        &self,
        idempotency_key: &str,
        fencing_token: u64,
        code: &str,
        available_at: i64,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE outbox SET status='failed', last_error_code=?3, available_at=?4
             WHERE idempotency_key=?1 AND fencing_token=?2 AND status='executing'",
            params![idempotency_key, fencing_token as i64, code, available_at],
        )?;
        if changed == 1 {
            Ok(())
        } else {
            Err(StoreError::Unreconciled)
        }
    }

    pub fn outbox_by_key(&self, idempotency_key: &str) -> Result<Option<OutboxRecord>, StoreError> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT outbox_id, command_id, effect_kind, request_json, status,
                    fencing_token, attempt_count FROM outbox WHERE idempotency_key=?1",
                [idempotency_key],
                |row| {
                    let effect: String = row.get(2)?;
                    let status: String = row.get(4)?;
                    Ok(OutboxRecord {
                        outbox_id: row.get(0)?,
                        command_id: row.get(1)?,
                        effect_kind: parse_effect(&effect).ok_or(rusqlite::Error::InvalidQuery)?,
                        idempotency_key: idempotency_key.to_owned(),
                        request: serde_json::from_str(&row.get::<_, String>(3)?)
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                        status: parse_status(&status).ok_or(rusqlite::Error::InvalidQuery)?,
                        fencing_token: row.get::<_, i64>(5)? as u64,
                        attempt_count: row.get::<_, i64>(6)? as u32,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }
}

pub(crate) fn insert_effect_transaction(
    transaction: &rusqlite::Transaction<'_>,
    command_id: &str,
    intent: &EffectIntent,
) -> Result<(), StoreError> {
    reject_sensitive_keys(&intent.request)?;
    let request_json = serde_json::to_string(&intent.request)?;
    let request_hash = Hash256::digest(request_json.as_bytes());
    let changed = transaction.execute(
        "INSERT INTO outbox(outbox_id, command_id, effect_kind, idempotency_key, request_json,
            request_sha256, status, fencing_token, attempt_count, available_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 0, ?8)
         ON CONFLICT(idempotency_key) DO NOTHING",
        params![
            intent.outbox_id.to_string(),
            command_id,
            enum_text(intent.effect_kind)?,
            intent.idempotency_key,
            request_json,
            request_hash.to_string(),
            intent.fencing_token as i64,
            intent.available_at,
        ],
    )?;
    if changed == 0 {
        ensure_effect_identity(
            transaction,
            &intent.idempotency_key,
            command_id,
            intent.effect_kind,
            request_hash,
        )?;
    }
    Ok(())
}

fn ensure_effect_identity(
    connection: &rusqlite::Connection,
    idempotency_key: &str,
    command_id: &str,
    effect_kind: EffectKind,
    request_hash: Hash256,
) -> Result<(), StoreError> {
    let expected_kind = enum_text(effect_kind)?;
    let matches = connection
        .query_row(
            "SELECT command_id = ?2 AND effect_kind = ?3 AND request_sha256 = ?4
             FROM outbox WHERE idempotency_key = ?1",
            params![
                idempotency_key,
                command_id,
                expected_kind,
                request_hash.to_string(),
            ],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false);
    if matches {
        Ok(())
    } else {
        Err(StoreError::ReceiptConflict)
    }
}

fn reject_sensitive_keys(value: &Value) -> Result<(), StoreError> {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if matches!(
                    key.as_str(),
                    "raw_text"
                        | "source_bytes"
                        | "prompt"
                        | "response"
                        | "conversation"
                        | "describer_output"
                ) {
                    return Err(StoreError::CorruptEvent);
                }
                reject_sensitive_keys(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                reject_sensitive_keys(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn enum_text(value: EffectKind) -> Result<String, StoreError> {
    Ok(serde_json::to_string(&value)?.trim_matches('"').to_owned())
}

fn parse_effect(value: &str) -> Option<EffectKind> {
    serde_json::from_str(&format!("\"{value}\"")).ok()
}

fn parse_status(value: &str) -> Option<OutboxStatus> {
    serde_json::from_str(&format!("\"{value}\"")).ok()
}
