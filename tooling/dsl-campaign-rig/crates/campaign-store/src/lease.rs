use rusqlite::{OptionalExtension, params};

use crate::{CampaignStore, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub resource_key: String,
    pub owner_id: String,
    pub fencing_token: u64,
    pub expires_at: i64,
}

impl CampaignStore {
    pub fn acquire_lease(
        &self,
        resource_key: &str,
        owner_id: &str,
        now: i64,
        ttl_seconds: i64,
    ) -> Result<Lease, StoreError> {
        if ttl_seconds <= 0 {
            return Err(StoreError::StaleLease);
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT owner_id, fencing_token, expires_at FROM leases WHERE resource_key = ?1",
                [resource_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        if existing
            .as_ref()
            .is_some_and(|(_, _, expires_at)| *expires_at > now)
        {
            return Err(StoreError::LeaseHeld);
        }
        let token = existing.map_or(1, |(_, token, _)| token as u64 + 1);
        let expires_at = now + ttl_seconds;
        transaction.execute(
            "INSERT INTO leases(resource_key, owner_id, fencing_token, acquired_at, expires_at, heartbeat_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?4)
             ON CONFLICT(resource_key) DO UPDATE SET owner_id=excluded.owner_id,
               fencing_token=excluded.fencing_token, acquired_at=excluded.acquired_at,
               expires_at=excluded.expires_at, heartbeat_at=excluded.heartbeat_at",
            params![resource_key, owner_id, token as i64, now, expires_at],
        )?;
        transaction.commit()?;
        Ok(Lease {
            resource_key: resource_key.to_owned(),
            owner_id: owner_id.to_owned(),
            fencing_token: token,
            expires_at,
        })
    }
    pub fn expire_lease(&self, lease: &Lease, now: i64) -> Result<(), StoreError> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE leases SET heartbeat_at=?4, expires_at=?4
             WHERE resource_key=?1 AND owner_id=?2 AND fencing_token=?3",
            params![
                lease.resource_key,
                lease.owner_id,
                lease.fencing_token as i64,
                now,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::StaleLease);
        }
        Ok(())
    }

    pub fn heartbeat_lease(
        &self,
        lease: &Lease,
        now: i64,
        ttl_seconds: i64,
    ) -> Result<Lease, StoreError> {
        if ttl_seconds <= 0 {
            return Err(StoreError::StaleLease);
        }
        let expires_at = now + ttl_seconds;
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE leases SET heartbeat_at=?4, expires_at=?5
             WHERE resource_key=?1 AND owner_id=?2 AND fencing_token=?3 AND expires_at>?4",
            params![
                lease.resource_key,
                lease.owner_id,
                lease.fencing_token as i64,
                now,
                expires_at,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::StaleLease);
        }
        Ok(Lease {
            expires_at,
            ..lease.clone()
        })
    }

    pub fn validate_fence(
        &self,
        resource_key: &str,
        token: u64,
        now: i64,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock();
        let valid = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM leases WHERE resource_key=?1 AND fencing_token=?2 AND expires_at>?3)",
            params![resource_key, token as i64, now],
            |row| row.get::<_, bool>(0),
        )?;
        if valid {
            Ok(())
        } else {
            Err(StoreError::StaleLease)
        }
    }
}
