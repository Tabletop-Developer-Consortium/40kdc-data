use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::StoreError;

const MIGRATIONS: [&str; 4] = [
    include_str!("../../../migrations/0001_event_store.sql"),
    include_str!("../../../migrations/0002_projections.sql"),
    include_str!("../../../migrations/0003_provider_usage.sql"),
    include_str!("../../../migrations/0004_command_identity.sql"),
];

#[derive(Clone)]
pub struct CampaignStore {
    pub(crate) connection: Arc<Mutex<Connection>>,
    pub(crate) state_root: Arc<PathBuf>,
}

impl CampaignStore {
    pub fn open(state_root: &Path, repository_root: &Path) -> Result<Self, StoreError> {
        let repository_root = repository_root.canonicalize()?;
        let repository_parent = repository_root
            .parent()
            .ok_or(StoreError::RepositoryLocalState)?
            .to_path_buf();
        let protected_roots = [
            repository_root,
            canonical_or_original(repository_parent.join("40kdc-abilities")),
            canonical_or_original(repository_parent.join("40kdc-embeddings")),
        ];
        let prospective = canonicalize_prospective(state_root)?;
        reject_protected_overlap(&prospective, &protected_roots)?;
        fs::create_dir_all(&prospective)?;
        let state_root = prospective.canonicalize()?;
        reject_protected_overlap(&state_root, &protected_roots)?;
        set_owner_only(&state_root)?;
        let cas_root = state_root.join("cas");
        reject_symlink_path(&cas_root)?;
        fs::create_dir_all(cas_root.join("sensitive/sha256"))?;
        fs::create_dir_all(cas_root.join("deidentified/sha256"))?;
        reject_symlink_descendants(&cas_root)?;
        let database_path = state_root.join("campaign.sqlite3");
        reject_symlink_path(&database_path)?;
        let mut connection = Connection::open(database_path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        apply_migrations(&mut connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            state_root: Arc::new(state_root),
        })
    }

    pub fn state_root(&self) -> &Path {
        &self.state_root
    }
}

fn apply_migrations(connection: &mut Connection) -> Result<(), StoreError> {
    let current = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if current > MIGRATIONS.len() as i64 {
        return Err(StoreError::UnsupportedSchema(current));
    }
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration)?;
        transaction.execute(
            "INSERT INTO schema_version(version, applied_at) VALUES (?1, datetime('now'))",
            [index as i64 + 1],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

fn canonical_or_original(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

fn canonicalize_prospective(path: &Path) -> Result<PathBuf, StoreError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut existing = absolute.as_path();
    let mut missing = Vec::new();
    while !existing.exists() {
        missing.push(
            existing
                .file_name()
                .ok_or(StoreError::RepositoryLocalState)?
                .to_owned(),
        );
        existing = existing.parent().ok_or(StoreError::RepositoryLocalState)?;
    }
    let mut resolved = existing.canonicalize()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn reject_protected_overlap(
    candidate: &Path,
    protected_roots: &[PathBuf],
) -> Result<(), StoreError> {
    if protected_roots
        .iter()
        .any(|root| candidate.starts_with(root) || root.starts_with(candidate))
    {
        Err(StoreError::RepositoryLocalState)
    } else {
        Ok(())
    }
}

fn reject_symlink_path(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(StoreError::RepositoryLocalState),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn reject_symlink_descendants(root: &Path) -> Result<(), StoreError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(StoreError::RepositoryLocalState);
        }
        if metadata.is_dir() {
            reject_symlink_descendants(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), StoreError> {
    Err(StoreError::UnsupportedPlatform)
}
