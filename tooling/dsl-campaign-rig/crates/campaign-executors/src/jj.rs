use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use campaign_domain::Hash256;
use serde::Deserialize;

use crate::{Capability, CapabilityGrant, ExecutorError, hash_file};

#[derive(Clone, Debug)]
pub struct JjClient {
    repo_root: PathBuf,
    grants: CapabilityGrant,
    binary: PathBuf,
    binary_hash: Hash256,
}

impl JjClient {
    pub fn new(repo_root: &Path, grants: CapabilityGrant) -> Result<Self, ExecutorError> {
        grants.require(Capability::ReadJj)?;
        let repo_root = repo_root.canonicalize()?;
        let (binary, binary_hash) = resolve_jj()?;
        let client = Self {
            repo_root,
            grants,
            binary,
            binary_hash,
        };
        if client.root()? != client.repo_root {
            return Err(ExecutorError::JjMismatch);
        }
        Ok(client)
    }

    pub fn initialize_snapshot(repo_root: &Path) -> Result<Self, ExecutorError> {
        if !repo_root.is_absolute() {
            return Err(ExecutorError::UnexpectedPath);
        }
        match fs::symlink_metadata(repo_root.join(".jj")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(ExecutorError::UnexpectedPath),
            Err(error) => return Err(error.into()),
        }
        let (binary, binary_hash) = resolve_jj()?;
        let output = Command::new(&binary)
            .args(["git", "init"])
            .current_dir(repo_root)
            .env_remove("OPENAI_API_KEY")
            .output()?;
        if hash_file(&binary)? != binary_hash {
            return Err(ExecutorError::IdentityMismatch);
        }
        if !output.status.success() {
            return Err(ExecutorError::JjMismatch);
        }
        let client = Self::new(
            repo_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]),
        )?;
        client.seal_current()?;
        Ok(client)
    }

    pub fn root(&self) -> Result<PathBuf, ExecutorError> {
        let output = self.run(["root"])?;
        PathBuf::from(output.trim())
            .canonicalize()
            .map_err(ExecutorError::from)
    }

    pub fn commit_id(&self, revision: &str) -> Result<String, ExecutorError> {
        validate_revision(revision)?;
        let output = self.run(["log", "-r", revision, "--no-graph", "-T", "commit_id"])?;
        let commit = output.trim().to_owned();
        if !is_hex_identity(&commit) {
            return Err(ExecutorError::JjMismatch);
        }
        Ok(commit)
    }

    pub fn changed_paths(&self, from: &str, to: &str) -> Result<BTreeSet<String>, ExecutorError> {
        validate_revision(from)?;
        validate_revision(to)?;
        let output = self.run(["diff", "--name-only", "--from", from, "--to", to])?;
        let paths = output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        Ok(paths)
    }

    pub fn tracked_paths(&self) -> Result<Vec<PathBuf>, ExecutorError> {
        let head = self.commit_id("@")?;
        Ok(self
            .tree_entries(&head)?
            .into_iter()
            .map(|entry| entry.path)
            .collect())
    }

    pub fn archive_current(&self, destination: &Path) -> Result<(), ExecutorError> {
        self.grants.require(Capability::ReadJj)?;
        if !destination.is_absolute() {
            return Err(ExecutorError::UnexpectedPath);
        }
        match fs::create_dir(destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(ExecutorError::UnexpectedPath);
            }
            Err(error) => return Err(error.into()),
        }

        let result = (|| {
            let expected_head = self.commit_id("@")?;
            for entry in self.tree_entries(&expected_head)? {
                if entry.file_type != "file" {
                    return Err(ExecutorError::UnexpectedPath);
                }
                let target = destination.join(&entry.path);
                fs::create_dir_all(target.parent().ok_or(ExecutorError::UnexpectedPath)?)?;
                fs::write(&target, self.file_bytes(&expected_head, &entry.path)?)?;
                set_executable(&target, entry.executable)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            fs::remove_dir_all(destination)?;
            return Err(error);
        }
        Ok(())
    }

    pub fn restore_from(&self, revision: &str) -> Result<(), ExecutorError> {
        self.grants.require(Capability::ApplyExactPlan)?;
        validate_revision(revision)?;
        self.run(["edit", revision])?;
        if self.commit_id("@")? == revision {
            Ok(())
        } else {
            Err(ExecutorError::JjMismatch)
        }
    }

    pub fn seal_current(&self) -> Result<String, ExecutorError> {
        self.grants.require(Capability::ApplyExactPlan)?;
        self.run(["describe", "-m", "chore: apply DSL campaign candidate"])?;
        let content_commit = self.commit_id("@")?;
        self.run(["new"])?;
        let head = self.commit_id("@")?;
        self.assert_linear_child(&content_commit, &head)?;
        Ok(head)
    }

    pub fn assert_linear_child(&self, parent: &str, child: &str) -> Result<(), ExecutorError> {
        if self.commit_id(&format!("{child}-"))? == parent && self.commit_id(child)? == child {
            Ok(())
        } else {
            Err(ExecutorError::JjMismatch)
        }
    }

    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    pub fn grants(&self) -> &CapabilityGrant {
        &self.grants
    }

    fn tree_entries(&self, revision: &str) -> Result<Vec<TreeEntry>, ExecutorError> {
        validate_revision(revision)?;
        let output = self.run([
            "file",
            "list",
            "--ignore-working-copy",
            "-r",
            revision,
            "-T",
            TREE_ENTRY_TEMPLATE,
        ])?;
        output
            .lines()
            .map(|line| {
                let entry: TreeEntry =
                    serde_json::from_str(line).map_err(|_| ExecutorError::JjMismatch)?;
                validate_relative_path(&entry.path)?;
                Ok(entry)
            })
            .collect()
    }

    fn file_bytes(&self, revision: &str, path: &Path) -> Result<Vec<u8>, ExecutorError> {
        validate_revision(revision)?;
        self.run_bytes([
            OsStr::new("file"),
            OsStr::new("show"),
            OsStr::new("--ignore-working-copy"),
            OsStr::new("-r"),
            OsStr::new(revision),
            OsStr::new("--"),
            path.as_os_str(),
        ])
    }

    fn run<const N: usize>(&self, args: [&str; N]) -> Result<String, ExecutorError> {
        let bytes = self.run_bytes(args.map(OsStr::new))?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(ExecutorError::JjMismatch);
        }
        String::from_utf8(bytes).map_err(|_| ExecutorError::JjMismatch)
    }

    fn run_bytes<I, S>(&self, args: I) -> Result<Vec<u8>, ExecutorError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        if hash_file(&self.binary)? != self.binary_hash {
            return Err(ExecutorError::IdentityMismatch);
        }
        let output = Command::new(&self.binary)
            .args(args)
            .current_dir(&self.repo_root)
            .env_remove("OPENAI_API_KEY")
            .output()?;
        if hash_file(&self.binary)? != self.binary_hash {
            return Err(ExecutorError::IdentityMismatch);
        }
        if !output.status.success() {
            return Err(ExecutorError::JjMismatch);
        }
        Ok(output.stdout)
    }
}

fn resolve_jj() -> Result<(PathBuf, Hash256), ExecutorError> {
    let binary = which::which("jj")
        .map_err(|_| ExecutorError::CommandNotAllowed)?
        .canonicalize()?;
    let binary_hash = hash_file(&binary)?;
    Ok((binary, binary_hash))
}

#[derive(Deserialize)]
struct TreeEntry {
    path: PathBuf,
    #[serde(rename = "type")]
    file_type: String,
    executable: bool,
}

const TREE_ENTRY_TEMPLATE: &str = "'{\"path\":' ++ json(path) ++ ',\"type\":' ++ file_type.escape_json() ++ ',\"executable\":' ++ json(executable) ++ \"}\\n\"";

fn validate_relative_path(relative: &Path) -> Result<(), ExecutorError> {
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || !relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err(ExecutorError::UnexpectedPath);
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path, executable: bool) -> Result<(), ExecutorError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if executable { 0o755 } else { 0o644 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path, _executable: bool) -> Result<(), ExecutorError> {
    Ok(())
}

fn validate_revision(revision: &str) -> Result<(), ExecutorError> {
    if revision == "@"
        || revision == "@-"
        || is_hex_identity(revision)
        || revision.strip_suffix('-').is_some_and(is_hex_identity)
    {
        Ok(())
    } else {
        Err(ExecutorError::JjMismatch)
    }
}

fn is_hex_identity(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
