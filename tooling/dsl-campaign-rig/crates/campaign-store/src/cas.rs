use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
};

use campaign_domain::{ArtifactKind, Hash256, Sensitivity};
use rusqlite::params;
use uuid::Uuid;

use crate::{CampaignStore, StoreError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredArtifact {
    pub artifact_id: Hash256,
    pub kind: ArtifactKind,
    pub sensitivity: Sensitivity,
    pub byte_len: u64,
    pub relative_path: PathBuf,
}

impl CampaignStore {
    pub fn put_artifact(
        &self,
        kind: ArtifactKind,
        sensitivity: Sensitivity,
        bytes: &[u8],
        media_type: &str,
        canonicalization: &str,
        parent_hashes: &[Hash256],
    ) -> Result<StoredArtifact, StoreError> {
        if bytes.is_empty()
            || kind
                .required_sensitivity()
                .is_some_and(|required| required != sensitivity)
        {
            return Err(StoreError::CorruptEvent);
        }
        let hash = Hash256::digest(bytes);
        let sensitivity_dir = match sensitivity {
            Sensitivity::Sensitive => "sensitive",
            Sensitivity::Deidentified => "deidentified",
        };
        let hash_string = hash.to_string();
        let relative_path = PathBuf::from(format!(
            "cas/{sensitivity_dir}/sha256/{}/{}",
            &hash_string[..2],
            hash_string
        ));
        reject_symlink_components(&self.state_root, &relative_path)?;
        let final_path = self.state_root.join(&relative_path);
        if !final_path.exists() {
            let parent = final_path.parent().expect("CAS path has parent");
            reject_symlink_components(&self.state_root, &relative_path)?;
            fs::create_dir_all(parent)?;
            reject_symlink_components(&self.state_root, &relative_path)?;
            let temporary = parent.join(format!(".tmp-{}", Uuid::new_v4()));
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            set_owner_only_file(&file)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            if Hash256::digest(fs::read(&temporary)?) != hash {
                fs::remove_file(&temporary)?;
                return Err(StoreError::CorruptEvent);
            }
            match fs::rename(&temporary, &final_path) {
                Ok(()) => {}
                Err(error) if final_path.exists() => {
                    fs::remove_file(&temporary)?;
                    if fs::read(&final_path)? != bytes {
                        return Err(StoreError::Io(error));
                    }
                }
                Err(error) => return Err(StoreError::Io(error)),
            }
            File::open(parent)?.sync_all()?;
        } else if fs::read(&final_path)? != bytes {
            return Err(StoreError::CorruptEvent);
        }
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO artifacts(artifact_id, kind, sensitivity, sha256, byte_len, media_type,
                canonicalization, relative_cas_path, created_at)
             VALUES (?1, ?2, ?3, ?1, ?4, ?5, ?6, ?7, datetime('now'))
             ON CONFLICT(sensitivity, sha256) DO NOTHING",
            params![
                hash_string,
                serde_json::to_string(&kind)?.trim_matches('"'),
                serde_json::to_string(&sensitivity)?.trim_matches('"'),
                bytes.len() as i64,
                media_type,
                canonicalization,
                relative_path.to_string_lossy(),
            ],
        )?;
        for parent_hash in parent_hashes {
            connection.execute(
                "INSERT OR IGNORE INTO artifact_parents(artifact_id, parent_artifact_id) VALUES (?1, ?2)",
                params![hash_string, parent_hash.to_string()],
            )?;
        }
        Ok(StoredArtifact {
            artifact_id: hash,
            kind,
            sensitivity,
            byte_len: bytes.len() as u64,
            relative_path,
        })
    }

    pub fn read_artifact(&self, artifact_id: Hash256) -> Result<Vec<u8>, StoreError> {
        let connection = self.connection.lock();
        let relative: String = connection
            .query_row(
                "SELECT relative_cas_path FROM artifacts WHERE artifact_id = ?1",
                [artifact_id.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => StoreError::MissingArtifact,
                other => StoreError::Sqlite(other),
            })?;
        drop(connection);
        let relative = std::path::Path::new(&relative);
        reject_symlink_components(&self.state_root, relative)?;
        let bytes =
            fs::read(self.state_root.join(relative)).map_err(|_| StoreError::MissingArtifact)?;
        if Hash256::digest(&bytes) != artifact_id {
            return Err(StoreError::CorruptEvent);
        }
        Ok(bytes)
    }

    pub fn sensitive_artifact_bytes(&self) -> Result<Vec<Vec<u8>>, StoreError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT artifact_id, relative_cas_path FROM artifacts
             WHERE sensitivity='sensitive' ORDER BY artifact_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);
        rows.into_iter()
            .map(|(expected, relative)| {
                let relative = std::path::Path::new(&relative);
                if relative.is_absolute()
                    || !relative
                        .components()
                        .all(|component| matches!(component, std::path::Component::Normal(_)))
                {
                    return Err(StoreError::CorruptEvent);
                }
                reject_symlink_components(&self.state_root, relative)?;
                let bytes = fs::read(self.state_root.join(relative))?;
                if Hash256::digest(&bytes).to_string() != expected {
                    return Err(StoreError::CorruptEvent);
                }
                Ok(bytes)
            })
            .collect()
    }
}

fn reject_symlink_components(
    root: &std::path::Path,
    relative: &std::path::Path,
) -> Result<(), StoreError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(StoreError::CorruptEvent);
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(StoreError::CorruptEvent);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file(file: &File) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_file(_file: &File) -> Result<(), StoreError> {
    Err(StoreError::UnsupportedPlatform)
}
