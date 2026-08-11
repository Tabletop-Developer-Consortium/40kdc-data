use campaign_domain::CampaignId;

use crate::{CampaignStore, StoreError, events::update_projections};

impl CampaignStore {
    pub fn rebuild_projections(&self) -> Result<usize, StoreError> {
        let stream_ids = {
            let connection = self.connection.lock();
            let mut statement =
                connection.prepare("SELECT stream_id FROM streams ORDER BY stream_id")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut states = Vec::with_capacity(stream_ids.len());
        for stream_id in stream_ids {
            let campaign_id = CampaignId::new(stream_id).map_err(StoreError::Domain)?;
            states.push(self.load_state(&campaign_id)?);
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "DELETE FROM campaign_status;
             DELETE FROM ability_ledger;
             DELETE FROM shape_ledger;
             DELETE FROM ready_work;
             DELETE FROM projection_checkpoints;",
        )?;
        let sequence = transaction.query_row(
            "SELECT COALESCE(MAX(global_seq), 0) FROM events",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        for state in &states {
            update_projections(&transaction, state, sequence)?;
        }
        transaction.commit()?;
        Ok(states.len())
    }
}
