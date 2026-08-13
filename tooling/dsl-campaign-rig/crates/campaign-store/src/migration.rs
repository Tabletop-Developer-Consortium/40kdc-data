use crate::{CampaignStore, StoreError};

pub const SCHEMA_VERSION: i64 = 6;

impl CampaignStore {
    pub fn verify_schema_version(&self) -> Result<(), StoreError> {
        let connection = self.connection.lock();
        let version = connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if version == SCHEMA_VERSION {
            Ok(())
        } else {
            Err(StoreError::UnsupportedSchema(version))
        }
    }
}
