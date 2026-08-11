use std::{path::Path, process::Command};

use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};

use crate::{Capability, CapabilityGrant, ExecutorError, SensitiveCorpus};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationPlan {
    pub authorized: bool,
    pub sealed_head: String,
    pub bookmark: String,
    pub base_bookmark: String,
    pub title: String,
    pub body: String,
    pub body_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationReceipt {
    pub bookmark: String,
    pub sealed_head: String,
    pub pr_url_hash: Hash256,
    pub draft: bool,
    pub checks_green: bool,
    pub conflict_free: bool,
}

pub fn publish_draft(
    grants: &CapabilityGrant,
    repo_root: &Path,
    plan: &PublicationPlan,
    sensitive: &SensitiveCorpus,
) -> Result<PublicationReceipt, ExecutorError> {
    if !plan.authorized
        || !valid_bookmark(&plan.bookmark)
        || !valid_bookmark(&plan.base_bookmark)
        || plan.bookmark == "main"
        || !plan.bookmark.starts_with("wnmitch/dsl-")
        || plan.title.trim().is_empty()
        || plan.body_hash != Hash256::digest(plan.body.as_bytes())
    {
        return Err(ExecutorError::PublicationDenied);
    }
    sensitive.reject_sensitive_bytes(plan.body.as_bytes())?;
    sensitive.reject_sensitive_bytes(plan.title.as_bytes())?;
    grants.require(Capability::CreateBookmark)?;
    grants.require(Capability::PushBookmark)?;
    grants.require(Capability::CreateDraftPr)?;

    let existing = run(
        repo_root,
        "gh",
        &[
            "pr",
            "list",
            "--head",
            &plan.bookmark,
            "--state",
            "all",
            "--json",
            "number",
        ],
    )?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&existing)?;
    if let Some(row) = rows.first() {
        if rows.len() != 1 {
            return Err(ExecutorError::PublicationDenied);
        }
        let number = row
            .get("number")
            .and_then(|value| value.as_u64())
            .ok_or(ExecutorError::PublicationDenied)?;
        return observe_pr(repo_root, number, plan);
    }

    let bookmark_rows = run(
        repo_root,
        "jj",
        &[
            "--ignore-working-copy",
            "bookmark",
            "list",
            &plan.bookmark,
            "-T",
            "name ++ \"\\t\" ++ if(self.normal_target(), self.normal_target().commit_id(), \"conflict\") ++ \"\\n\"",
        ],
    )?;
    let targets = bookmark_rows
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .filter(|(name, _)| *name == plan.bookmark)
        .map(|(_, target)| target)
        .collect::<Vec<_>>();
    match targets.as_slice() {
        [] => {
            run(
                repo_root,
                "jj",
                &[
                    "--ignore-working-copy",
                    "bookmark",
                    "create",
                    &plan.bookmark,
                    "-r",
                    &plan.sealed_head,
                ],
            )?;
        }
        [target] if *target == plan.sealed_head => {}
        _ => return Err(ExecutorError::PublicationDenied),
    }
    run(
        repo_root,
        "jj",
        &[
            "--ignore-working-copy",
            "git",
            "push",
            "--bookmark",
            &plan.bookmark,
        ],
    )?;
    let url = run(
        repo_root,
        "gh",
        &[
            "pr",
            "create",
            "--draft",
            "--head",
            &plan.bookmark,
            "--base",
            &plan.base_bookmark,
            "--title",
            &plan.title,
            "--body",
            &plan.body,
        ],
    )?;
    let number = url
        .trim()
        .rsplit('/')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(ExecutorError::PublicationDenied)?;
    observe_pr(repo_root, number, plan)
}

fn observe_pr(
    repo_root: &Path,
    number: u64,
    plan: &PublicationPlan,
) -> Result<PublicationReceipt, ExecutorError> {
    let output = run(
        repo_root,
        "gh",
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "url,isDraft,state,title,body,headRefName,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup",
        ],
    )?;
    let row: serde_json::Value = serde_json::from_str(&output)?;
    if row.get("headRefName").and_then(|value| value.as_str()) != Some(plan.bookmark.as_str())
        || row.get("baseRefName").and_then(|value| value.as_str())
            != Some(plan.base_bookmark.as_str())
        || row.get("headRefOid").and_then(|value| value.as_str()) != Some(plan.sealed_head.as_str())
        || row.get("state").and_then(|value| value.as_str()) != Some("OPEN")
        || row.get("isDraft").and_then(|value| value.as_bool()) != Some(true)
        || row.get("title").and_then(|value| value.as_str()) != Some(plan.title.as_str())
        || row
            .get("body")
            .and_then(|value| value.as_str())
            .map(|body| Hash256::digest(body.as_bytes()))
            != Some(plan.body_hash)
    {
        return Err(ExecutorError::PublicationDenied);
    }
    let checks = row
        .get("statusCheckRollup")
        .and_then(|value| value.as_array())
        .ok_or(ExecutorError::PublicationDenied)?;
    let checks_green = !checks.is_empty()
        && checks.iter().all(|check| {
            check
                .get("conclusion")
                .and_then(|value| value.as_str())
                .or_else(|| check.get("state").and_then(|value| value.as_str()))
                .is_some_and(|state| matches!(state, "SUCCESS" | "NEUTRAL" | "SKIPPED"))
        });
    let conflict_free =
        row.get("mergeStateStatus").and_then(|value| value.as_str()) == Some("CLEAN");
    let url = row
        .get("url")
        .and_then(|value| value.as_str())
        .ok_or(ExecutorError::PublicationDenied)?;
    Ok(PublicationReceipt {
        bookmark: plan.bookmark.clone(),
        sealed_head: plan.sealed_head.clone(),
        pr_url_hash: Hash256::digest(url.as_bytes()),
        draft: row
            .get("isDraft")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        checks_green,
        conflict_free,
    })
}

fn valid_bookmark(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'/'))
}

fn run(repo_root: &Path, executable: &str, args: &[&str]) -> Result<String, ExecutorError> {
    let output = Command::new(executable)
        .args(args)
        .current_dir(repo_root)
        .env_remove("OPENAI_API_KEY")
        .output()?;
    if !output.status.success() || output.stdout.len() > 1024 * 1024 {
        return Err(ExecutorError::ProcessFailed(
            output.status.code().unwrap_or(128),
        ));
    }
    String::from_utf8(output.stdout).map_err(|_| ExecutorError::IdentityMismatch)
}
