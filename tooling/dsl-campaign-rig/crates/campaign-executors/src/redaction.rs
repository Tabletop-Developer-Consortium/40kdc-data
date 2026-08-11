use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use campaign_domain::Hash256;

use crate::{Capability, CapabilityGrant, ExecutorError, JjClient};
pub const TELEMETRY_FIELDS: [&str; 21] = [
    "campaign_id",
    "faction_id",
    "ability_id",
    "shape_id",
    "state",
    "hash",
    "verdict",
    "error_code",
    "attempt",
    "voter",
    "gate",
    "input_tokens",
    "cached_tokens",
    "output_tokens",
    "reasoning_tokens",
    "byte_len",
    "exit_code",
    "event_seq",
    "stream_version",
    "lease_count",
    "outbox_status",
];

const MIN_PROHIBITED_FRAGMENT_BYTES: usize = 16;

pub struct SensitiveCorpus {
    exact_hashes: BTreeSet<Hash256>,
    short_normalized: Vec<Vec<u8>>,
    normalized_ngrams: BTreeSet<Hash256>,
}

impl SensitiveCorpus {
    pub fn new<'a>(sources: impl IntoIterator<Item = &'a [u8]>) -> Self {
        let mut exact_hashes = BTreeSet::new();
        let mut short_normalized = Vec::new();
        let mut normalized_ngrams = BTreeSet::new();
        for source in sources {
            exact_hashes.insert(Hash256::digest(source));
            let normalized = normalize_sensitive(source);
            if normalized.is_empty() {
                continue;
            }
            if normalized.len() < MIN_PROHIBITED_FRAGMENT_BYTES {
                short_normalized.push(normalized);
            } else {
                normalized_ngrams.extend(
                    normalized
                        .windows(MIN_PROHIBITED_FRAGMENT_BYTES)
                        .map(Hash256::digest),
                );
            }
        }
        Self {
            exact_hashes,
            short_normalized,
            normalized_ngrams,
        }
    }

    pub fn reject_sensitive_bytes(&self, bytes: &[u8]) -> Result<(), ExecutorError> {
        if self.exact_hashes.contains(&Hash256::digest(bytes)) {
            return Err(ExecutorError::SensitiveContent);
        }
        let normalized = normalize_sensitive(bytes);
        let leaked = if self.short_normalized.iter().any(|source| {
            normalized
                .windows(source.len())
                .any(|window| window == source)
        }) {
            true
        } else if normalized.len() < MIN_PROHIBITED_FRAGMENT_BYTES {
            false
        } else {
            normalized
                .windows(MIN_PROHIBITED_FRAGMENT_BYTES)
                .map(Hash256::digest)
                .any(|hash| self.normalized_ngrams.contains(&hash))
        };
        if leaked {
            return Err(ExecutorError::SensitiveContent);
        }
        Ok(())
    }
}

pub fn validate_external_state_root(
    state_root: &Path,
    repository_root: &Path,
) -> Result<PathBuf, ExecutorError> {
    let repository_root = repository_root.canonicalize()?;
    let repository_parent = repository_root
        .parent()
        .ok_or(ExecutorError::RepositoryLocalState)?
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
    Ok(state_root)
}

fn canonical_or_original(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

fn canonicalize_prospective(path: &Path) -> Result<PathBuf, ExecutorError> {
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
                .ok_or(ExecutorError::RepositoryLocalState)?
                .to_owned(),
        );
        existing = existing
            .parent()
            .ok_or(ExecutorError::RepositoryLocalState)?;
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
) -> Result<(), ExecutorError> {
    if protected_roots
        .iter()
        .any(|root| candidate.starts_with(root) || root.starts_with(candidate))
    {
        Err(ExecutorError::RepositoryLocalState)
    } else {
        Ok(())
    }
}

pub fn validate_subscription_environment() -> Result<(), ExecutorError> {
    if std::env::var_os("OPENAI_API_KEY").is_some() {
        Err(ExecutorError::SensitiveContent)
    } else {
        Ok(())
    }
}

pub fn audit_tracked_tree(repository_root: &Path) -> Result<(), ExecutorError> {
    const GW_PROSE_MARKER: &[u8] = &[71, 87, 95, 80, 82, 79, 83, 69, 95, 66, 69, 71, 73, 78];
    const RAW_SOURCE_MARKER: &[u8] = &[
        82, 65, 87, 95, 83, 79, 85, 82, 67, 69, 95, 66, 69, 71, 73, 78,
    ];
    const PROVIDER_DUMP_MARKER: &[u8] = &[
        80, 82, 79, 86, 73, 68, 69, 82, 95, 67, 79, 78, 86, 69, 82, 83, 65, 84, 73, 79, 78,
    ];
    const FORBIDDEN_MARKERS: [&[u8]; 3] =
        [GW_PROSE_MARKER, RAW_SOURCE_MARKER, PROVIDER_DUMP_MARKER];
    let grants = CapabilityGrant::from_capabilities([Capability::ReadJj]);
    let jj = JjClient::new(repository_root, grants)?;
    for relative in jj.tracked_paths()? {
        if relative.starts_with("_private") {
            continue;
        }
        let path = repository_root.join(relative);
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(repository_root) || !canonical.is_file() {
            return Err(ExecutorError::UnexpectedPath);
        }
        let bytes = fs::read(canonical)?;
        if FORBIDDEN_MARKERS
            .iter()
            .any(|marker| contains_bytes(&bytes, marker))
        {
            return Err(ExecutorError::SensitiveContent);
        }
    }
    Ok(())
}

pub fn validate_telemetry_fields<'a>(
    fields: impl IntoIterator<Item = &'a str>,
) -> Result<(), ExecutorError> {
    let allowed = TELEMETRY_FIELDS.into_iter().collect::<BTreeSet<_>>();
    if fields.into_iter().all(|field| allowed.contains(field)) {
        Ok(())
    } else {
        Err(ExecutorError::SensitiveContent)
    }
}
fn normalize_sensitive(bytes: &[u8]) -> Vec<u8> {
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut pending_space = false;
    for byte in bytes.iter().copied() {
        if byte.is_ascii_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(b' ');
            pending_space = false;
        }
        normalized.push(byte.to_ascii_lowercase());
    }
    normalized
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}
