use campaign_domain::{CampaignId, CampaignState, Hash256};
use rusqlite::{OptionalExtension, params};

use crate::{CampaignStore, StoreError};

pub const REDUCER_VERSION: u32 = 1;

impl CampaignStore {
    pub fn save_snapshot(&self, state: &CampaignState) -> Result<Hash256, StoreError> {
        let campaign_id = state.campaign_id.as_ref().ok_or(StoreError::CorruptEvent)?;
        let state_json = serde_json::to_string(state)?;
        let state_hash = Hash256::digest(state_json.as_bytes());
        let connection = self.connection.lock();
        connection.execute(
            "INSERT OR REPLACE INTO snapshots(stream_id, stream_version, reducer_version,
                state_json, state_sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![
                campaign_id.as_str(),
                state.stream_version as i64,
                i64::from(REDUCER_VERSION),
                state_json,
                state_hash.to_string(),
            ],
        )?;
        Ok(state_hash)
    }

    pub fn load_snapshot(
        &self,
        campaign_id: &CampaignId,
    ) -> Result<Option<CampaignState>, StoreError> {
        let connection = self.connection.lock();
        let row = connection
            .query_row(
                "SELECT state_json, state_sha256 FROM snapshots
                 WHERE stream_id=?1 AND reducer_version=?2 ORDER BY stream_version DESC LIMIT 1",
                params![campaign_id.as_str(), i64::from(REDUCER_VERSION)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((state_json, expected_hash)) = row else {
            return Ok(None);
        };
        if Hash256::digest(state_json.as_bytes()).to_string() != expected_hash {
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(&state_json)?))
    }
}
