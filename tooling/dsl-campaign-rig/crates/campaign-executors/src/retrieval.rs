use std::{collections::BTreeSet, fs, path::Path};

use campaign_domain::{AbilityKey, Hash256};
use serde::Serialize;
use serde_json::Value;

use crate::{Capability, CapabilityGrant, ExecutorError};

#[derive(Clone, Debug, PartialEq)]
pub struct RetrievedSource {
    pub key: AbilityKey,
    pub sensitive_record: Value,
    pub source_hash: Hash256,
    pub same_slug_factions: BTreeSet<String>,
    pub source_text: String,
}

#[derive(Clone, Serialize)]
pub struct FamilyCandidate {
    pub key: AbilityKey,
    pub source_hash: Hash256,
    pub source_text: String,
    pub lexical_score: f64,
}

pub fn retrieve_source(
    grants: &CapabilityGrant,
    store_root: &Path,
    key: &AbilityKey,
) -> Result<RetrievedSource, ExecutorError> {
    grants.require(Capability::ReadRawStore)?;
    let index_path = store_root.join("index.json");
    let bytes = fs::read(index_path)?;
    let index: Value = serde_json::from_slice(&bytes)?;
    if index.get("schema_version").and_then(Value::as_u64) != Some(2) {
        return Err(ExecutorError::IdentityMismatch);
    }
    let factions = index
        .get("factions")
        .and_then(Value::as_object)
        .ok_or(ExecutorError::IdentityMismatch)?;
    let record = factions
        .get(key.faction_id.as_str())
        .and_then(Value::as_object)
        .and_then(|abilities| abilities.get(key.ability_id.as_str()))
        .cloned()
        .ok_or(ExecutorError::AmbiguousLookup)?;
    let same_slug_factions = factions
        .iter()
        .filter_map(|(faction, abilities)| {
            abilities
                .as_object()
                .is_some_and(|abilities| abilities.contains_key(key.ability_id.as_str()))
                .then_some(faction.clone())
        })
        .collect();
    let source_text = canonical_source_text(&record)?;
    Ok(RetrievedSource {
        key: key.clone(),
        sensitive_record: record,
        source_hash: Hash256::digest(source_text.as_bytes()),
        source_text,
        same_slug_factions,
    })
}

pub fn retrieve_family_candidates(
    grants: &CapabilityGrant,
    store_root: &Path,
    seed: &AbilityKey,
    limit: usize,
) -> Result<Vec<FamilyCandidate>, ExecutorError> {
    grants.require(Capability::ReadRawStore)?;
    if limit == 0 || limit > 100 {
        return Err(ExecutorError::IdentityMismatch);
    }
    let index: Value = serde_json::from_slice(&fs::read(store_root.join("index.json"))?)?;
    if index.get("schema_version").and_then(Value::as_u64) != Some(2) {
        return Err(ExecutorError::IdentityMismatch);
    }
    let factions = index
        .get("factions")
        .and_then(Value::as_object)
        .ok_or(ExecutorError::IdentityMismatch)?;
    let seed_record = factions
        .get(seed.faction_id.as_str())
        .and_then(Value::as_object)
        .and_then(|abilities| abilities.get(seed.ability_id.as_str()))
        .ok_or(ExecutorError::AmbiguousLookup)?;
    let query = lexical_tokens(&canonical_source_text(seed_record)?);
    if query.is_empty() {
        return Err(ExecutorError::IdentityMismatch);
    }

    let mut candidates = Vec::new();
    for (faction_id, abilities) in factions {
        let abilities = abilities
            .as_object()
            .ok_or(ExecutorError::IdentityMismatch)?;
        for (ability_id, record) in abilities {
            if faction_id == seed.faction_id.as_str() && ability_id == seed.ability_id.as_str() {
                continue;
            }
            let source_text = canonical_source_text(record)?;
            let tokens = lexical_tokens(&source_text);
            let overlap = query.intersection(&tokens).count();
            if overlap == 0 {
                continue;
            }
            let score = overlap as f64 / query.len() as f64;
            candidates.push(FamilyCandidate {
                key: AbilityKey::new(
                    campaign_domain::FactionId::new(faction_id)
                        .map_err(|_| ExecutorError::IdentityMismatch)?,
                    campaign_domain::AbilityId::new(ability_id)
                        .map_err(|_| ExecutorError::IdentityMismatch)?,
                ),
                source_hash: Hash256::digest(source_text.as_bytes()),
                source_text,
                lexical_score: score,
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .lexical_score
            .total_cmp(&left.lexical_score)
            .then_with(|| left.key.cmp(&right.key))
    });
    candidates.truncate(limit);
    Ok(candidates)
}

fn lexical_tokens(text: &str) -> BTreeSet<String> {
    const STOP: [&str; 24] = [
        "after", "before", "during", "each", "from", "have", "into", "model", "models", "once",
        "other", "round", "that", "their", "this", "unit", "units", "until", "when", "where",
        "which", "while", "with", "your",
    ];
    text.split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|token| token.len() > 2 && STOP.binary_search(&token.as_str()).is_err())
        .collect()
}

fn canonical_source_text(record: &Value) -> Result<String, ExecutorError> {
    if let Some(raw_text) = record.get("raw_text").and_then(Value::as_str) {
        return Ok(raw_text.to_owned());
    }
    let object = record.as_object().ok_or(ExecutorError::IdentityMismatch)?;
    let mut structured = serde_json::Map::new();
    for key in ["when", "target", "effect", "restrictions"] {
        if let Some(value) = object.get(key) {
            structured.insert(key.to_owned(), value.clone());
        }
    }
    if structured.is_empty() {
        return Err(ExecutorError::AmbiguousLookup);
    }
    Ok(serde_json::to_string(&structured)?)
}
