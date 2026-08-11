use std::collections::{BTreeMap, BTreeSet};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::ExecutorError;

pub const FIXED_GATES: [&str; 6] = [
    "validate",
    "test",
    "translate-smoke",
    "drift",
    "format-lint",
    "parity",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionKind {
    Data,
    DataConformance,
    NewShape,
    DescriberReword,
    ScoringDescriber,
    SealedCampaign,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixRow {
    pub required: bool,
    pub files: BTreeSet<String>,
}

pub type ImplementationMatrix = BTreeMap<String, MatrixRow>;

pub fn validate_changed_paths(
    decision: DecisionKind,
    factions: &BTreeSet<String>,
    changed_paths: &BTreeSet<String>,
    exact_allowlist: &BTreeSet<String>,
    matrix: &ImplementationMatrix,
) -> Result<(), ExecutorError> {
    if changed_paths.is_empty() || !changed_paths.is_subset(exact_allowlist) {
        return Err(ExecutorError::UnexpectedPath);
    }
    if changed_paths
        .iter()
        .any(|path| !normalized(path) || !allowed_policy_path(path, factions))
    {
        return Err(ExecutorError::UnexpectedPath);
    }
    let required = required_families(decision, matrix);
    if required.is_empty() {
        return Err(ExecutorError::GateFailed);
    }
    for family in required {
        let row = matrix.get(family).ok_or(ExecutorError::GateFailed)?;
        if !row.required
            || row.files.is_empty()
            || !row.files.is_subset(changed_paths)
            || !row
                .files
                .iter()
                .all(|path| family_matches(family, path, factions))
        {
            return Err(ExecutorError::GateFailed);
        }
    }
    Ok(())
}

pub fn validate_gate_results(results: &BTreeMap<String, bool>) -> Result<(), ExecutorError> {
    if results.len() != FIXED_GATES.len()
        || FIXED_GATES
            .iter()
            .any(|gate| results.get(*gate) != Some(&true))
    {
        Err(ExecutorError::GateFailed)
    } else {
        Ok(())
    }
}

fn required_families<'a>(decision: DecisionKind, matrix: &'a ImplementationMatrix) -> Vec<&'a str> {
    match decision {
        DecisionKind::NewShape => vec![
            "canonical_schema",
            "typescript_describer",
            "rust_describer",
            "python_describer",
            "go_describer",
            "typescript_cruncher",
            "rust_cruncher",
            "python_cruncher",
            "go_cruncher",
            "conformance",
            "spec_version",
            "generated_types",
            "embedded_schemas",
            "rust_bundle",
            "python_bundle",
            "go_bundle",
            "version_lockstep",
            "data",
        ],
        DecisionKind::DescriberReword => vec![
            "typescript_describer",
            "rust_describer",
            "python_describer",
            "go_describer",
            "conformance",
            "spec_version",
        ],
        DecisionKind::ScoringDescriber => vec![
            "typescript_scoring_describer",
            "python_scoring_describer",
            "go_scoring_describer",
            "scoring_conformance",
            "spec_version",
        ],
        DecisionKind::Data => vec!["data", "rust_bundle", "python_bundle", "go_bundle"],
        DecisionKind::DataConformance => vec![
            "data",
            "rust_bundle",
            "python_bundle",
            "go_bundle",
            "conformance",
            "spec_version",
        ],
        DecisionKind::SealedCampaign => matrix
            .keys()
            .map(String::as_str)
            .filter(|key| known_family(key))
            .collect(),
    }
}

fn known_family(family: &str) -> bool {
    matches!(
        family,
        "data"
            | "canonical_schema"
            | "typescript_describer"
            | "rust_describer"
            | "python_describer"
            | "go_describer"
            | "typescript_cruncher"
            | "rust_cruncher"
            | "python_cruncher"
            | "go_cruncher"
            | "conformance"
            | "scoring_conformance"
            | "spec_version"
            | "generated_types"
            | "typescript_scoring_describer"
            | "python_scoring_describer"
            | "go_scoring_describer"
            | "embedded_schemas"
            | "rust_bundle"
            | "python_bundle"
            | "go_bundle"
            | "version_lockstep"
    )
}

fn family_matches(family: &str, path: &str, factions: &BTreeSet<String>) -> bool {
    match family {
        "data" => factions
            .iter()
            .any(|faction| path == format!("data/enrichment/{faction}/abilities.json")),
        "canonical_schema" => regex_match(
            r"^schemas/enrichment/ability-dsl/(ability|condition|effect|scope|trigger)\.schema\.json$",
            path,
        ),
        "typescript_describer" => {
            regex_match(r"^tools/src/translate/(condition|effect|index)\.ts$", path)
        }
        "rust_describer" => regex_match(r"^crates/wh40kdc/src/translate/(effect|mod)\.rs$", path),
        "python_describer" => regex_match(
            r"^python/src/wh40kdc/translate/(condition|effect|__init__)\.py$",
            path,
        ),
        "go_describer" => regex_match(r"^go/translate_(condition|effect)\.go$", path),
        "typescript_cruncher" => path == "tools/src/cruncher/from-dsl.ts",
        "rust_cruncher" => path == "crates/wh40kdc/src/cruncher/buffs.rs",
        "python_cruncher" => path == "python/src/wh40kdc/cruncher/from_dsl.py",
        "go_cruncher" => path == "go/cruncher_from_dsl.go",
        "conformance" => {
            path.starts_with("conformance/")
                && path != "conformance/SPEC_VERSION"
                && !path.starts_with("conformance/scoring-translation/")
        }
        "scoring_conformance" => path.starts_with("conformance/scoring-translation/"),
        "spec_version" => matches!(
            path,
            "conformance/SPEC_VERSION" | "python/src/wh40kdc/_spec.py" | "go/spec.go"
        ),
        "generated_types" => matches!(
            path,
            "tools/src/generated.ts"
                | "crates/wh40kdc/src/generated.rs"
                | "python/src/wh40kdc/_types.py"
        ),
        "typescript_scoring_describer" => path == "tools/src/translate/scoring.ts",
        "python_scoring_describer" => path == "python/src/wh40kdc/translate/scoring.py",
        "go_scoring_describer" => path == "go/translate_scoring.go",
        "embedded_schemas" => {
            path == "crates/wh40kdc/schemas/bundled.schema.json"
                || path.starts_with("python/src/wh40kdc/schemas/")
                || path.starts_with("go/schemas/")
        }
        "rust_bundle" => path == "crates/wh40kdc/src/data/bundle.generated.json",
        "python_bundle" => path == "python/src/wh40kdc/_bundle.json",
        "go_bundle" => path == "go/bundle.json",
        "version_lockstep" => matches!(
            path,
            "tools/package.json"
                | "crates/wh40kdc/Cargo.toml"
                | "python/src/wh40kdc/_version.py"
                | "go/version.go"
                | "Cargo.lock"
        ),
        _ => false,
    }
}

fn allowed_policy_path(path: &str, factions: &BTreeSet<String>) -> bool {
    family_matches("data", path, factions)
        || path.starts_with("schemas/enrichment/ability-dsl/")
        || path.starts_with("tools/src/translate/")
        || path.starts_with("tools/src/cruncher/")
        || path.starts_with("crates/wh40kdc/src/translate/")
        || path.starts_with("crates/wh40kdc/src/cruncher/")
        || path.starts_with("python/src/wh40kdc/")
        || path.starts_with("go/translate_")
        || path.starts_with("go/cruncher_")
        || path.starts_with("conformance/")
        || matches!(
            path,
            "tools/src/generated.ts" | "crates/wh40kdc/src/generated.rs" | "Cargo.lock"
        )
        || path.starts_with("crates/wh40kdc/schemas/")
        || path.starts_with("go/")
}

fn normalized(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.ends_with('/')
        && !path.split('/').any(|part| part == ".." || part.is_empty())
}

fn regex_match(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).expect("fixed regex").is_match(value)
}
