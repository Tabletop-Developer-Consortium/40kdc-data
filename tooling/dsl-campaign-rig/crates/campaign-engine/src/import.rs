use std::{collections::BTreeSet, fs, path::Path};

use campaign_domain::{ArtifactKind, Hash256, Sensitivity};
use campaign_store::CampaignStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use walkdir::WalkDir;

use crate::EngineError;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyImportReport {
    pub source_root_hash: Hash256,
    pub accepted_artifacts: BTreeSet<Hash256>,
    pub rejected_artifacts: BTreeSet<Hash256>,
    pub ambiguous_artifacts: BTreeSet<Hash256>,
    pub orphaned_artifacts: BTreeSet<Hash256>,
    pub raw_conversations_unavailable: bool,
    pub publishable: bool,
    pub failure_codes: BTreeSet<String>,
}

pub fn import_omp_evidence(
    store: &CampaignStore,
    source_root: &Path,
) -> Result<LegacyImportReport, EngineError> {
    let source_root = source_root.canonicalize()?;
    let mut report = LegacyImportReport {
        source_root_hash: Hash256::digest(source_root.to_string_lossy().as_bytes()),
        raw_conversations_unavailable: true,
        publishable: true,
        ..LegacyImportReport::default()
    };
    for entry in WalkDir::new(&source_root) {
        let entry = entry.map_err(|error| std::io::Error::other(error.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        let hash = Hash256::digest(&bytes);
        store.put_artifact(
            ArtifactKind::RevisionThread,
            Sensitivity::Sensitive,
            &bytes,
            "application/octet-stream",
            "legacy-verbatim",
            &[],
        )?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            report.orphaned_artifacts.insert(hash);
            report.publishable = false;
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            report.rejected_artifacts.insert(hash);
            report.failure_codes.insert("invalid-json".into());
            report.publishable = false;
            continue;
        };
        match adjudicate_legacy(&value) {
            LegacyVerdict::Accepted => {
                report.accepted_artifacts.insert(hash);
            }
            LegacyVerdict::Rejected(code) => {
                report.rejected_artifacts.insert(hash);
                report.failure_codes.insert(code.into());
                report.publishable = false;
            }
            LegacyVerdict::Ambiguous(code) => {
                report.ambiguous_artifacts.insert(hash);
                report.failure_codes.insert(code.into());
                report.publishable = false;
            }
        }
    }
    if report.accepted_artifacts.is_empty() {
        report.publishable = false;
        report
            .failure_codes
            .insert("no-authoritative-evidence".into());
    }
    let report_bytes = serde_json::to_vec(&report)?;
    store.put_artifact(
        ArtifactKind::Verification,
        Sensitivity::Deidentified,
        &report_bytes,
        "application/json",
        "canonical-json",
        &report
            .accepted_artifacts
            .iter()
            .copied()
            .collect::<Vec<_>>(),
    )?;
    Ok(report)
}

enum LegacyVerdict {
    Accepted,
    Rejected(&'static str),
    Ambiguous(&'static str),
}

fn adjudicate_legacy(value: &Value) -> LegacyVerdict {
    if contains_key(value, "raw_text") || contains_key(value, "conversation") {
        return LegacyVerdict::Ambiguous("sensitive-narrative-only");
    }
    let campaign_id = value
        .get("campaign_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if campaign_id == "c008"
        && (value
            .get("full_gate_runs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 2)
        && value.get("post_repair_full_gate").and_then(Value::as_bool) != Some(true)
    {
        return LegacyVerdict::Rejected("c008-gate-budget-exhausted");
    }
    if campaign_id == "c009"
        && (value.get("application_performed").and_then(Value::as_bool) != Some(true)
            || value.get("baseline_render_hash") == value.get("updated_render_hash"))
    {
        return LegacyVerdict::Rejected("c009-orchestration-failure");
    }
    if value.get("baseline_dsl_hash") == value.get("candidate_dsl_hash")
        && value.get("status").and_then(Value::as_str) == Some("updated")
    {
        return LegacyVerdict::Rejected("no-op-updated");
    }
    if value
        .get("audit_sequence")
        .and_then(Value::as_u64)
        .is_some_and(|audit| {
            value
                .get("apply_sequence")
                .and_then(Value::as_u64)
                .is_none_or(|apply| audit < apply)
        })
    {
        return LegacyVerdict::Rejected("audit-before-apply");
    }
    if let Some(hashes) = value.get("candidate_hashes").and_then(Value::as_array) {
        let unique = hashes
            .iter()
            .filter_map(Value::as_str)
            .collect::<BTreeSet<_>>();
        if unique.len() > 1 {
            return LegacyVerdict::Ambiguous("mixed-candidate-hashes");
        }
    }
    if value
        .get("family_manifest_hashes")
        .and_then(Value::as_array)
        .is_some_and(|hashes| {
            hashes
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                .len()
                > 1
        })
    {
        return LegacyVerdict::Ambiguous("mixed-family-manifests");
    }
    let authoritative = [
        "campaign_id",
        "manifest_hash",
        "candidate_dsl_hash",
        "applied_dsl_hash",
        "verification_hash",
        "review_hash",
    ]
    .iter()
    .all(|key| value.get(*key).and_then(Value::as_str).is_some());
    if authoritative {
        LegacyVerdict::Accepted
    } else {
        LegacyVerdict::Ambiguous("incomplete-evidence")
    }
}

fn contains_key(value: &Value, needle: &str) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key(needle) || map.values().any(|value| contains_key(value, needle))
        }
        Value::Array(values) => values.iter().any(|value| contains_key(value, needle)),
        _ => false,
    }
}
