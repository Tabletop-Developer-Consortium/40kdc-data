use campaign_domain::{
    CampaignId, CampaignState, Command, DomainEvent, Hash256, decide, evolve, replay,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::{CampaignStore, EffectIntent, StoreError, outbox::insert_effect_transaction};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandReceipt {
    pub command_id: String,
    pub stream_id: String,
    pub expected_version: u64,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub result_hash: Hash256,
    pub command_hash: Hash256,
}

impl CampaignStore {
    pub fn handle_command(&self, command: &Command) -> Result<CommandReceipt, StoreError> {
        self.handle_command_inner(command, None)
    }

    pub fn handle_command_with_effect(
        &self,
        command: &Command,
        intent: &EffectIntent,
    ) -> Result<CommandReceipt, StoreError> {
        self.handle_command_inner(command, Some(intent))
    }

    fn handle_command_inner(
        &self,
        command: &Command,
        intent: Option<&EffectIntent>,
    ) -> Result<CommandReceipt, StoreError> {
        let command_hash = Hash256::digest(serde_json::to_vec(&serde_json::json!({
            "campaign_id": command.meta.campaign_id,
            "expected_stream_version": command.meta.expected_stream_version,
            "expected_manifest_hash": command.meta.expected_manifest_hash,
            "expected_engine_hash": command.meta.expected_engine_hash,
            "outbox_id": command.meta.outbox_id,
            "action": command.action,
        }))?);
        let stream_id = command.meta.campaign_id.to_string();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;

        match (
            command.meta.lease_resource.as_deref(),
            command.meta.lease_owner.as_deref(),
            command.meta.fencing_token,
        ) {
            (Some(resource), Some(owner), Some(token)) => {
                let active = transaction
                    .query_row(
                        "SELECT 1 FROM leases
                         WHERE resource_key=?1 AND owner_id=?2 AND fencing_token=?3
                           AND expires_at >= unixepoch()",
                        params![resource, owner, token as i64],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if !active {
                    return Err(StoreError::StaleLease);
                }
            }
            (None, None, _) => {}
            _ => return Err(StoreError::StaleLease),
        }

        if let Some(receipt) = load_receipt(&transaction, &command.meta.command_id.to_string())? {
            if receipt.stream_id != stream_id
                || receipt.expected_version != command.meta.expected_stream_version
                || receipt.command_hash != command_hash
            {
                return Err(StoreError::ReceiptConflict);
            }
            transaction.commit()?;
            return Ok(receipt);
        }

        let events = load_events_from(&transaction, &stream_id)?;
        let mut state = replay(events.iter())?;
        let decided = decide(&state, command)?;
        if decided.is_empty() {
            return Err(StoreError::CorruptEvent);
        }

        transaction.execute(
            "INSERT INTO streams(stream_id, aggregate_type, current_version, created_at)
             VALUES (?1, 'campaign', 0, datetime('now')) ON CONFLICT(stream_id) DO NOTHING",
            [&stream_id],
        )?;

        let mut first_sequence = None;
        let mut result_material = Vec::new();
        for event in &decided {
            let payload = serde_json::to_vec(event)?;
            let checksum = Hash256::digest(&payload);
            result_material.extend_from_slice(checksum.to_string().as_bytes());
            transaction.execute(
                "INSERT INTO events(
                    stream_id, stream_version, event_type, event_version, payload_json,
                    payload_sha256, command_id, causation_id, correlation_id, recorded_at
                 ) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
                params![
                    stream_id,
                    event.stream_version as i64,
                    event.payload.event_type(),
                    String::from_utf8(payload).expect("JSON is UTF-8"),
                    checksum.to_string(),
                    command.meta.command_id.to_string(),
                    command.meta.causation_id.to_string(),
                    command.meta.correlation_id.to_string(),
                ],
            )?;
            let sequence = transaction.last_insert_rowid() as u64;
            first_sequence.get_or_insert(sequence);
            evolve(&mut state, event)?;
        }
        let first_sequence = first_sequence.expect("non-empty decision");
        let last_sequence = transaction.last_insert_rowid() as u64;
        let result_hash = Hash256::digest(result_material);
        transaction.execute(
            "UPDATE streams SET current_version = ?2 WHERE stream_id = ?1",
            params![stream_id, state.stream_version as i64],
        )?;
        update_projections(&transaction, &state, last_sequence)?;
        if let Some(intent) = intent {
            insert_effect_transaction(&transaction, &command.meta.command_id.to_string(), intent)?;
        }
        transaction.execute(
            "INSERT INTO command_receipts(
                command_id, stream_id, expected_version, result_first_seq, result_last_seq,
                result_sha256, command_sha256, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
            params![
                command.meta.command_id.to_string(),
                stream_id,
                command.meta.expected_stream_version as i64,
                first_sequence as i64,
                last_sequence as i64,
                result_hash.to_string(),
                command_hash.to_string(),
            ],
        )?;
        transaction.commit()?;
        Ok(CommandReceipt {
            command_id: command.meta.command_id.to_string(),
            stream_id,
            expected_version: command.meta.expected_stream_version,
            first_sequence,
            last_sequence,
            result_hash,
            command_hash,
        })
    }

    pub fn load_events(&self, campaign_id: &CampaignId) -> Result<Vec<DomainEvent>, StoreError> {
        let connection = self.connection.lock();
        load_events_from(&connection, campaign_id.as_str())
    }

    pub fn load_state(&self, campaign_id: &CampaignId) -> Result<CampaignState, StoreError> {
        let events = self.load_events(campaign_id)?;
        Ok(replay(events.iter())?)
    }
}

fn load_events_from(
    connection: &rusqlite::Connection,
    stream_id: &str,
) -> Result<Vec<DomainEvent>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT payload_json, payload_sha256 FROM events WHERE stream_id = ?1 ORDER BY stream_version",
    )?;
    let rows = statement.query_map([stream_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut events = Vec::new();
    for row in rows {
        let (payload, expected_checksum) = row?;
        if Hash256::digest(payload.as_bytes()).to_string() != expected_checksum {
            return Err(StoreError::CorruptEvent);
        }
        events.push(serde_json::from_str(&payload)?);
    }
    Ok(events)
}

fn load_receipt(
    transaction: &Transaction<'_>,
    command_id: &str,
) -> Result<Option<CommandReceipt>, StoreError> {
    transaction
        .query_row(
            "SELECT stream_id, expected_version, result_first_seq, result_last_seq, result_sha256,
                command_sha256
             FROM command_receipts WHERE command_id = ?1",
            [command_id],
            |row| {
                let hash: String = row.get(4)?;
                let command_hash: Option<String> = row.get(5)?;
                Ok(CommandReceipt {
                    command_id: command_id.to_owned(),
                    stream_id: row.get(0)?,
                    expected_version: row.get::<_, i64>(1)? as u64,
                    first_sequence: row.get::<_, i64>(2)? as u64,
                    last_sequence: row.get::<_, i64>(3)? as u64,
                    result_hash: Hash256::from_hex(&hash)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    command_hash: command_hash
                        .as_deref()
                        .and_then(|value| Hash256::from_hex(value).ok())
                        .ok_or(rusqlite::Error::InvalidQuery)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn update_projections(
    transaction: &Transaction<'_>,
    state: &CampaignState,
    sequence: u64,
) -> Result<(), StoreError> {
    let campaign_id = state
        .campaign_id
        .as_ref()
        .ok_or(StoreError::CorruptEvent)?
        .to_string();
    let phase = serde_json::to_string(&state.phase)?
        .trim_matches('"')
        .to_owned();
    transaction.execute(
        "INSERT INTO campaign_status(campaign_id, phase, stream_version, manifest_hash, sealed_head, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(campaign_id) DO UPDATE SET phase=excluded.phase,
           stream_version=excluded.stream_version, manifest_hash=excluded.manifest_hash,
           sealed_head=excluded.sealed_head, updated_at=excluded.updated_at",
        params![
            campaign_id,
            phase,
            state.stream_version as i64,
            state.manifest_hash.map(|hash| hash.to_string()),
            state.sealed_head,
        ],
    )?;
    for (key, ability) in &state.abilities {
        transaction.execute(
            "INSERT INTO ability_ledger(campaign_id, faction_id, ability_id, phase, attempt,
                candidate_hash, applied_hash, verification_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(campaign_id, faction_id, ability_id) DO UPDATE SET
               phase=excluded.phase, attempt=excluded.attempt, candidate_hash=excluded.candidate_hash,
               applied_hash=excluded.applied_hash, verification_hash=excluded.verification_hash",
            params![
                campaign_id,
                key.faction_id.as_str(),
                key.ability_id.as_str(),
                serde_json::to_string(&ability.phase)?.trim_matches('"'),
                i64::from(ability.attempt),
                ability.candidate_hash.map(|hash| hash.to_string()),
                ability.applied_hash.map(|hash| hash.to_string()),
                ability.verification_hash.map(|hash| hash.to_string()),
            ],
        )?;
    }
    transaction.execute(
        "INSERT INTO projection_checkpoints(name, global_seq, projection_version, updated_at)
         VALUES ('main', ?1, 1, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET global_seq=excluded.global_seq, updated_at=excluded.updated_at",
        [sequence as i64],
    )?;
    Ok(())
}
