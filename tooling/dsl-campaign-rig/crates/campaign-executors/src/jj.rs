use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{Capability, CapabilityGrant, ExecutorError};

#[derive(Clone, Debug)]
pub struct JjClient {
    repo_root: PathBuf,
    grants: CapabilityGrant,
}

impl JjClient {
    pub fn new(repo_root: &Path, grants: CapabilityGrant) -> Result<Self, ExecutorError> {
        grants.require(Capability::ReadJj)?;
        let repo_root = repo_root.canonicalize()?;
        let client = Self { repo_root, grants };
        if client.root()? != client.repo_root {
            return Err(ExecutorError::JjMismatch);
        }
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
        let output = self.run(["file", "list", "-r", "@"])?;
        output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| {
                let relative = Path::new(line);
                if relative.is_absolute()
                    || !relative
                        .components()
                        .all(|component| matches!(component, std::path::Component::Normal(_)))
                {
                    return Err(ExecutorError::UnexpectedPath);
                }
                Ok(relative.to_path_buf())
            })
            .collect()
    }
    pub fn archive_current(&self, destination: &Path) -> Result<(), ExecutorError> {
        self.grants.require(Capability::ReadJj)?;
        if !destination.is_absolute() || destination.exists() {
            return Err(ExecutorError::UnexpectedPath);
        }
        self.run([
            "archive",
            "-r",
            "@",
            destination.to_str().ok_or(ExecutorError::UnexpectedPath)?,
        ])?;
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

    fn run<const N: usize>(&self, args: [&str; N]) -> Result<String, ExecutorError> {
        let output = Command::new("jj")
            .args(args)
            .current_dir(&self.repo_root)
            .env_remove("OPENAI_API_KEY")
            .output()?;
        if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
            return Err(ExecutorError::JjMismatch);
        }
        String::from_utf8(output.stdout).map_err(|_| ExecutorError::JjMismatch)
    }
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
