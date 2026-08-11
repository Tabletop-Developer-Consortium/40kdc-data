use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use campaign_domain::Hash256;
use campaign_store::CampaignStore;
use serde::{Deserialize, Serialize};

use crate::{Capability, ExecutorError, JjClient, SensitiveCorpus};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathOperation {
    pub path: String,
    pub expected_old_hash: Option<Hash256>,
    pub new_bytes_artifact: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyPlan {
    pub expected_head: String,
    pub allowed_paths: BTreeSet<String>,
    pub operations: Vec<PathOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedInventory {
    pub before_head: String,
    pub after_head: String,
    pub paths: Vec<(String, Option<Hash256>, Hash256)>,
}

pub fn apply_exact_plan(
    jj: &JjClient,
    store: &CampaignStore,
    plan: &ApplyPlan,
    sensitive_corpus: &SensitiveCorpus,
) -> Result<AppliedInventory, ExecutorError> {
    jj.grants().require(Capability::ApplyExactPlan)?;
    if jj.commit_id("@")? != plan.expected_head || plan.operations.is_empty() {
        return Err(ExecutorError::JjMismatch);
    }
    let mut seen = BTreeSet::new();
    let mut prepared = Vec::with_capacity(plan.operations.len());
    for operation in &plan.operations {
        if !normalized(&operation.path)
            || !plan.allowed_paths.contains(&operation.path)
            || !seen.insert(operation.path.clone())
        {
            return Err(ExecutorError::UnexpectedPath);
        }
        reject_symlink_components(jj.repo_root(), Path::new(&operation.path))?;
        let path = jj.repo_root().join(&operation.path);
        let old_bytes = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let old_hash = old_bytes.as_ref().map(Hash256::digest);
        if old_hash != operation.expected_old_hash {
            return Err(ExecutorError::IdentityMismatch);
        }
        let new_bytes = store
            .read_artifact(operation.new_bytes_artifact)
            .map_err(|_| ExecutorError::IdentityMismatch)?;
        sensitive_corpus.reject_sensitive_bytes(&new_bytes)?;
        let new_hash = Hash256::digest(&new_bytes);
        if old_hash == Some(new_hash) {
            return Err(ExecutorError::NoOp);
        }
        prepared.push((
            operation.path.clone(),
            path,
            old_bytes,
            old_hash,
            new_bytes,
            new_hash,
        ));
    }

    let transaction_root = jj
        .repo_root()
        .join(".jj")
        .join(format!("rig-apply-{}", std::process::id()));
    fs::create_dir_all(&transaction_root)?;
    let mut staged = Vec::with_capacity(prepared.len());
    for (index, (_, path, _, _, bytes, _)) in prepared.iter().enumerate() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = transaction_root.join(index.to_string());
        fs::write(&temporary, bytes)?;
        fs::File::open(&temporary)?.sync_all()?;
        staged.push(temporary);
    }

    let mut applied = 0;
    let result = (|| {
        for ((name, path, _, _, _, _), temporary) in prepared.iter().zip(&staged) {
            reject_symlink_components(jj.repo_root(), Path::new(name))
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            fs::rename(temporary, path)?;
            applied += 1;
        }
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = result {
        rollback(&prepared[..applied])?;
        let _ = fs::remove_dir_all(&transaction_root);
        return Err(error.into());
    }
    let _ = fs::remove_dir_all(&transaction_root);
    let changed = jj.changed_paths(&plan.expected_head, "@")?;
    if changed != plan.allowed_paths || changed != seen {
        rollback(&prepared)?;
        return Err(ExecutorError::UnexpectedPath);
    }
    let after_head = jj.commit_id("@")?;
    Ok(AppliedInventory {
        before_head: plan.expected_head.clone(),
        after_head,
        paths: prepared
            .into_iter()
            .map(|(name, _, _, old_hash, _, new_hash)| (name, old_hash, new_hash))
            .collect(),
    })
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), ExecutorError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(ExecutorError::UnexpectedPath);
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ExecutorError::UnexpectedPath);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn rollback(
    prepared: &[(
        String,
        PathBuf,
        Option<Vec<u8>>,
        Option<Hash256>,
        Vec<u8>,
        Hash256,
    )],
) -> Result<(), ExecutorError> {
    for (_, path, old_bytes, _, _, _) in prepared.iter().rev() {
        if let Some(bytes) = old_bytes {
            fs::write(path, bytes)?;
        } else if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn normalized(path: &str) -> bool {
    let candidate = Path::new(path);
    !candidate.is_absolute()
        && !path.ends_with('/')
        && candidate
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}
