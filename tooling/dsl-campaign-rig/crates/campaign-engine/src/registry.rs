use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use campaign_domain::{
    AbilityId, AbilityKey, ConfidenceTier, EmbeddingVector, ExecutionLane, FactionId, Hash256,
    MechanicCluster, MechanicClusterId, MechanicEmbeddings, MechanicTemplate, QueueKind,
    RegistryBody, RegistryQueueEntry, RegistryRevision, RetrievalCandidate, RetrievalDecision,
    SeedMember, StructuralSignature, VerificationProvenance,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use walkdir::WalkDir;

use crate::EngineError;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_EMBEDDING_MODEL: &str = "all-MiniLM-L6-v2";
const TRUSTED_ROUNDTRIP_MIN: f64 = 0.72;
const SUSPECT_ROUNDTRIP_MAX: f64 = 0.55;
const SEMANTIC_BOUNDARY_MIN: f64 = 0.88;

#[derive(Clone, Debug)]
pub struct RegistrySeedConfig {
    pub repository_root: PathBuf,
    pub raw_store_index: PathBuf,
    pub roundtrip_report: PathBuf,
    pub repository_revision: String,
    pub corpus_version: String,
    pub embedding_model: String,
    pub embeddings_root: PathBuf,
    pub python_binary: PathBuf,
    pub embedding_bridge: PathBuf,
    pub verification_bundle: Option<PathBuf>,
    pub schema_valid: bool,
    pub integrity_valid: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistrySeedReport {
    pub revision_id: Hash256,
    pub corpus_root_hash: Hash256,
    pub total_members: usize,
    pub verified_members: usize,
    pub trusted_provisional_members: usize,
    pub suspect_members: usize,
    pub unpaired_members: usize,
    pub clusters: usize,
    pub template_clusters: usize,
    pub contradiction_queue: usize,
    pub suspect_queue: usize,
    pub novelty_queue: usize,
}

pub trait RegistryEmbeddingProvider {
    fn model(&self) -> &str;
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EngineError>;
}

#[derive(Clone, Debug)]
pub struct PythonEmbeddingProvider {
    pub python_binary: PathBuf,
    pub embedding_bridge: PathBuf,
    pub embeddings_root: PathBuf,
    pub model: String,
    pub batch_size: usize,
}

impl RegistryEmbeddingProvider for PythonEmbeddingProvider {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EngineError> {
        let mut vectors = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(self.batch_size.max(1)) {
            let mut child = Command::new(&self.python_binary)
                .arg(&self.embedding_bridge)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let request = serde_json::to_vec(&json!({
                "embeddings_root": self.embeddings_root,
                "model": self.model,
                "texts": chunk,
            }))?;
            child
                .stdin
                .take()
                .ok_or_else(|| EngineError::Registry("embedding bridge stdin unavailable".into()))?
                .write_all(&request)?;
            let output = child.wait_with_output()?;
            if !output.status.success() {
                return Err(EngineError::Registry(format!(
                    "embedding bridge failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
            let response: EmbeddingResponse = serde_json::from_slice(&output.stdout)?;
            if response.vectors.len() != chunk.len()
                || response.vectors.iter().any(|vector| {
                    vector.is_empty() || vector.iter().any(|value| !value.is_finite())
                })
            {
                return Err(EngineError::Registry(
                    "embedding bridge returned an invalid vector batch".into(),
                ));
            }
            vectors.extend(response.vectors);
        }
        Ok(vectors)
    }
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    vectors: Vec<Vec<f32>>,
}

#[derive(Clone, Debug)]
struct CorpusCandidate {
    key: AbilityKey,
    ability_type: String,
    detachment_context: Option<String>,
    normalized_dsl: Value,
    dsl_hash: Hash256,
    source_text: Option<String>,
    source_hash: Option<Hash256>,
    source_provenance_hash: Option<Hash256>,
    describer_output: String,
    scoring_describer_output: String,
    roundtrip_score: Option<f64>,
    structural_signature: StructuralSignature,
    architecture_signature: String,
    clause_signature: String,
    shape_ids: BTreeSet<String>,
    lever_signature: String,
    verification: Option<VerificationProvenance>,
    confidence_reasons: BTreeSet<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct VerificationBundle {
    #[serde(default)]
    records: Vec<VerificationBundleRecord>,
}

#[derive(Clone, Debug, Deserialize)]
struct VerificationBundleRecord {
    faction_id: String,
    ability_id: String,
    exact_dsl_hash: Hash256,
    clause_coverage_hash: Hash256,
    adversarial_review_hash: Hash256,
    mechanical_gates_hash: Hash256,
    lever_check_hash: Hash256,
    final_review_hash: Hash256,
    repository_revision: String,
}

#[derive(Clone, Debug, Default)]
struct RoundtripRecord {
    score: Option<f64>,
    english: String,
}

pub fn seed_registry(
    config: &RegistrySeedConfig,
    parent_revision: Option<Hash256>,
) -> Result<(RegistryRevision, RegistrySeedReport), EngineError> {
    let provider = PythonEmbeddingProvider {
        python_binary: config.python_binary.clone(),
        embedding_bridge: config.embedding_bridge.clone(),
        embeddings_root: config.embeddings_root.clone(),
        model: config.embedding_model.clone(),
        batch_size: 128,
    };
    seed_registry_with_provider(config, parent_revision, &provider)
}

pub fn seed_registry_with_provider(
    config: &RegistrySeedConfig,
    parent_revision: Option<Hash256>,
    provider: &dyn RegistryEmbeddingProvider,
) -> Result<(RegistryRevision, RegistrySeedReport), EngineError> {
    if !config.schema_valid || !config.integrity_valid {
        return Err(EngineError::Registry(
            "complete corpus validation must pass before seeding".into(),
        ));
    }
    if provider.model() != config.embedding_model {
        return Err(EngineError::Registry(
            "embedding model identity mismatch".into(),
        ));
    }

    let roundtrip = load_roundtrip(&config.roundtrip_report)?;
    let raw_store = load_raw_store(&config.raw_store_index)?;
    let verification = load_verification_bundle(config.verification_bundle.as_deref())?;
    let mut candidates = load_authored_corpus(config, &roundtrip, &raw_store, &verification)?;
    if candidates.is_empty() {
        return Err(EngineError::Registry("authored corpus is empty".into()));
    }

    let mut embedding_texts = Vec::with_capacity(candidates.len() * 5);
    for candidate in &candidates {
        let architecture = candidate.architecture_signature.clone();
        let dsl = canonical_json(&candidate.normalized_dsl)?;
        let source = candidate.source_text.clone().unwrap_or_default();
        let describer = candidate.describer_output.clone();
        embedding_texts.extend([
            source.clone(),
            describer.clone(),
            architecture.clone(),
            dsl.clone(),
            [source, describer, architecture, dsl].join("\n---\n"),
        ]);
    }
    let vectors = provider.embed(&embedding_texts)?;
    if vectors.len() != embedding_texts.len() {
        return Err(EngineError::Registry("embedding count mismatch".into()));
    }

    let mut members = Vec::with_capacity(candidates.len());
    for (candidate, vectors) in candidates.drain(..).zip(vectors.chunks_exact(5)) {
        let embeddings = MechanicEmbeddings {
            source_evidence: candidate
                .source_hash
                .map(|_| embedding_vector(provider.model(), &vectors[0])),
            describer_output: Some(embedding_vector(provider.model(), &vectors[1])),
            normalized_architecture: Some(embedding_vector(provider.model(), &vectors[2])),
            normalized_dsl_structure: Some(embedding_vector(provider.model(), &vectors[3])),
            combined_mechanic: Some(embedding_vector(provider.model(), &vectors[4])),
        };
        let (confidence, mut confidence_reasons) = classify_confidence(
            &candidate,
            &embeddings,
            config.schema_valid,
            config.integrity_valid,
        );
        confidence_reasons.extend(candidate.confidence_reasons);
        let cluster_id = MechanicClusterId::from_signature(&candidate.structural_signature)?;
        members.push(SeedMember {
            key: candidate.key,
            ability_type: candidate.ability_type,
            detachment_context: candidate.detachment_context,
            source_hash: candidate.source_hash,
            source_provenance_hash: candidate.source_provenance_hash,
            normalized_dsl: candidate.normalized_dsl,
            dsl_hash: candidate.dsl_hash,
            describer_output: candidate.describer_output,
            scoring_describer_output: candidate.scoring_describer_output,
            architecture_signature: candidate.architecture_signature,
            clause_signature: candidate.clause_signature,
            structural_signature: candidate.structural_signature,
            canonical_shape_ids: candidate.shape_ids,
            lever_signature: candidate.lever_signature,
            roundtrip_score: candidate.roundtrip_score,
            schema_valid: config.schema_valid,
            integrity_valid: config.integrity_valid,
            verification_provenance: candidate.verification,
            repository_revision: config.repository_revision.clone(),
            corpus_version: config.corpus_version.clone(),
            embeddings,
            confidence,
            cluster_id,
            confidence_reasons,
        });
    }
    members.sort_by(|left, right| left.key.cmp(&right.key));

    let (clusters, contradiction_queue, suspect_queue, novelty_queue) = build_clusters(&members)?;
    let corpus_root_hash = Hash256::digest(serde_json::to_vec(
        &members
            .iter()
            .map(|member| (&member.key, member.dsl_hash, member.source_hash))
            .collect::<Vec<_>>(),
    )?);
    let body = RegistryBody {
        schema_version: REGISTRY_SCHEMA_VERSION,
        corpus_root_hash,
        repository_revision: config.repository_revision.clone(),
        embedding_model: config.embedding_model.clone(),
        members,
        clusters,
        contradiction_queue,
        suspect_queue,
        novelty_queue,
    };
    let revision = RegistryRevision::new(parent_revision, body)?;
    let report = summarize_seed(&revision);
    Ok((revision, report))
}

fn embedding_vector(model: &str, values: &[f32]) -> EmbeddingVector {
    EmbeddingVector {
        model: model.to_owned(),
        values: values.to_vec(),
    }
}

fn load_roundtrip(path: &Path) -> Result<BTreeMap<(String, String), RoundtripRecord>, EngineError> {
    let root: Value = serde_json::from_slice(&fs::read(path)?)?;
    let mut records = BTreeMap::new();
    for ability in root
        .get("abilities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(faction) = ability.get("faction").and_then(Value::as_str) else {
            continue;
        };
        let Some(ability_id) = ability.get("ability_id").and_then(Value::as_str) else {
            continue;
        };
        records.insert(
            (faction.to_owned(), ability_id.to_owned()),
            RoundtripRecord {
                score: ability.get("score").and_then(Value::as_f64),
                english: ability
                    .get("english")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            },
        );
    }
    Ok(records)
}

fn load_raw_store(path: &Path) -> Result<BTreeMap<(String, String), Value>, EngineError> {
    let root: Value = serde_json::from_slice(&fs::read(path)?)?;
    let mut records = BTreeMap::new();
    let Some(factions) = root.get("factions").and_then(Value::as_object) else {
        return Err(EngineError::Registry(
            "raw store has no factions object".into(),
        ));
    };
    for (faction, abilities) in factions {
        let Some(abilities) = abilities.as_object() else {
            continue;
        };
        for (ability_id, record) in abilities {
            records.insert((faction.clone(), ability_id.clone()), record.clone());
        }
    }
    Ok(records)
}

fn load_verification_bundle(
    path: Option<&Path>,
) -> Result<BTreeMap<(String, String), VerificationProvenance>, EngineError> {
    let Some(path) = path else {
        return Ok(BTreeMap::new());
    };
    let bundle: VerificationBundle = serde_json::from_slice(&fs::read(path)?)?;
    Ok(bundle
        .records
        .into_iter()
        .map(|record| {
            (
                (record.faction_id, record.ability_id),
                VerificationProvenance {
                    exact_dsl_hash: record.exact_dsl_hash,
                    clause_coverage_hash: record.clause_coverage_hash,
                    adversarial_review_hash: record.adversarial_review_hash,
                    mechanical_gates_hash: record.mechanical_gates_hash,
                    lever_check_hash: record.lever_check_hash,
                    final_review_hash: record.final_review_hash,
                    repository_revision: record.repository_revision,
                },
            )
        })
        .collect())
}

fn load_authored_corpus(
    config: &RegistrySeedConfig,
    roundtrip: &BTreeMap<(String, String), RoundtripRecord>,
    raw_store: &BTreeMap<(String, String), Value>,
    verification: &BTreeMap<(String, String), VerificationProvenance>,
) -> Result<Vec<CorpusCandidate>, EngineError> {
    let enrichment_root = config.repository_root.join("data/enrichment");
    let mut by_key = BTreeMap::<AbilityKey, CorpusCandidate>::new();
    for entry in WalkDir::new(&enrichment_root).follow_links(false) {
        let entry = entry.map_err(|error| EngineError::Registry(error.to_string()))?;
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&enrichment_root)
            .map_err(|_| EngineError::Registry("enrichment path escaped root".into()))?;
        let Some(faction) = relative
            .components()
            .next()
            .and_then(|part| part.as_os_str().to_str())
        else {
            continue;
        };
        if faction.starts_with('_') {
            continue;
        }
        let root: Value = serde_json::from_slice(&fs::read(entry.path())?)?;
        collect_ability_objects(&root, &mut |ability| {
            let Some(ability_id) = ability.get("ability_id").and_then(Value::as_str) else {
                return Ok(());
            };
            if ability.get("effect").is_none() {
                return Ok(());
            }
            let key = AbilityKey::new(FactionId::new(faction)?, AbilityId::new(ability_id)?);
            let normalized_dsl = normalized_mechanic_dsl(ability);
            let dsl_hash = Hash256::digest(serde_json::to_vec(&normalized_dsl)?);
            let raw = raw_store.get(&(faction.to_owned(), ability_id.to_owned()));
            let source_text = raw.and_then(source_text);
            let source_hash = source_text.as_ref().map(Hash256::digest);
            let source_provenance_hash = raw
                .map(serde_json::to_vec)
                .transpose()?
                .map(Hash256::digest);
            let roundtrip_record = roundtrip
                .get(&(faction.to_owned(), ability_id.to_owned()))
                .cloned()
                .unwrap_or_default();
            let describer_output = if roundtrip_record.english.trim().is_empty() {
                canonical_json(&normalized_dsl)?
            } else {
                roundtrip_record.english
            };
            let scoring_describer_output = normalize_text(&describer_output);
            let structural_signature = compute_structural_signature(&normalized_dsl)?;
            let architecture_signature = canonical_json(&json!({
                "trigger": structural_signature.trigger_family,
                "condition": structural_signature.condition_tree,
                "effect": structural_signature.effect_container_shape,
                "binding": structural_signature.actor_binding,
                "control": structural_signature.control_structure,
            }))?;
            let clause_signature = clause_signature(&normalized_dsl)?;
            let shape_ids = canonical_shape_ids(&normalized_dsl);
            let lever_signature = structural_signature.lever_signature.clone();
            let verification = verification
                .get(&(faction.to_owned(), ability_id.to_owned()))
                .filter(|evidence| evidence.complete_for(dsl_hash))
                .cloned();
            let mut confidence_reasons = BTreeSet::new();
            if describer_output == canonical_json(&normalized_dsl)? {
                confidence_reasons.insert("describer-fallback".into());
            }
            let candidate = CorpusCandidate {
                key: key.clone(),
                ability_type: ability
                    .get("ability_type")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| infer_ability_type(relative))
                    .to_owned(),
                detachment_context: ability
                    .get("detachment_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                normalized_dsl,
                dsl_hash,
                source_text,
                source_hash,
                source_provenance_hash,
                describer_output,
                scoring_describer_output,
                roundtrip_score: roundtrip_record.score,
                structural_signature,
                architecture_signature,
                clause_signature,
                shape_ids,
                lever_signature,
                verification,
                confidence_reasons,
            };
            if let Some(existing) = by_key.get(&key) {
                if existing.dsl_hash != candidate.dsl_hash {
                    return Err(EngineError::Registry(format!(
                        "conflicting authored DSL for {key}"
                    )));
                }
            } else {
                by_key.insert(key, candidate);
            }
            Ok(())
        })?;
    }
    Ok(by_key.into_values().collect())
}

fn collect_ability_objects(
    value: &Value,
    visitor: &mut impl FnMut(&Map<String, Value>) -> Result<(), EngineError>,
) -> Result<(), EngineError> {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_ability_objects(value, visitor)?;
            }
        }
        Value::Object(object) => {
            if object.contains_key("ability_id") {
                visitor(object)?;
            } else {
                for value in object.values() {
                    collect_ability_objects(value, visitor)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn source_text(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if let Some(raw) = object.get("raw_text").and_then(Value::as_str) {
        return (!raw.trim().is_empty()).then(|| raw.to_owned());
    }
    let parts = ["when", "target", "effect", "restrictions"]
        .into_iter()
        .filter_map(|key| {
            object
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .map(|text| format!("{key}: {text}"))
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

pub fn normalized_mechanic_dsl(ability: &Map<String, Value>) -> Value {
    const MECHANIC_FIELDS: &[&str] = &[
        "ability_type",
        "applies_to",
        "behavior",
        "effect",
        "scope",
        "trigger",
        "usage",
    ];
    Value::Object(
        MECHANIC_FIELDS
            .iter()
            .filter_map(|key| {
                ability
                    .get(*key)
                    .map(|value| ((*key).to_owned(), value.clone()))
            })
            .collect(),
    )
}

pub fn compute_structural_signature(dsl: &Value) -> Result<StructuralSignature, EngineError> {
    let trigger = dsl.get("trigger").cloned().unwrap_or(Value::Null);
    let effect = dsl.get("effect").cloned().unwrap_or(Value::Null);
    let condition = collect_nodes(&effect, "condition", SignatureMode::Semantic);
    let effect_shape = project_effect_shape(&effect);
    let target_scope = json!({
        "targets": collect_key_values(&effect, &["target", "recipient", "source"]),
        "scope": dsl.get("scope"),
        "applies_to": dsl.get("applies_to"),
    });
    let modifier_dimensions = collect_nodes(&effect, "modifier", SignatureMode::Dimensions);
    let duration_usage = json!({
        "duration": dsl.pointer("/scope/duration"),
        "usage": dsl.get("usage"),
        "trigger_frequency": trigger.get("frequency"),
    });
    let lever_signature = lever_signature(dsl)?;
    let actor_binding = json!({
        "targets": collect_key_values(&effect, &["target", "recipient", "source"]),
        "applies_to": dsl.get("applies_to"),
        "scope_range": dsl.pointer("/scope/range"),
    });
    Ok(StructuralSignature {
        trigger_family: canonical_json(&json!({
            "trigger": parameterize_scalar_tree(&trigger, SignatureMode::Semantic),
            "behavior": dsl.get("behavior"),
        }))?,
        condition_tree: canonical_json(&condition)?,
        effect_container_shape: canonical_json(&effect_shape)?,
        target_scope_structure: canonical_json(&target_scope)?,
        modifier_dimensions: canonical_json(&modifier_dimensions)?,
        duration_usage: canonical_json(&duration_usage)?,
        lever_signature,
        actor_binding: canonical_json(&actor_binding)?,
        control_structure: canonical_json(&project_control_structure(&effect))?,
    })
}

#[derive(Clone, Copy)]
enum SignatureMode {
    Semantic,
    Dimensions,
}

fn collect_nodes(value: &Value, key: &str, mode: SignatureMode) -> Value {
    let mut output = Vec::new();
    collect_nodes_into(value, key, mode, "$", &mut output);
    Value::Array(output)
}

fn collect_nodes_into(
    value: &Value,
    key: &str,
    mode: SignatureMode,
    path: &str,
    output: &mut Vec<Value>,
) {
    match value {
        Value::Object(object) => {
            if let Some(found) = object.get(key) {
                output.push(json!({
                    "path": path,
                    "value": parameterize_scalar_tree(found, mode),
                }));
            }
            for (child_key, child) in object {
                collect_nodes_into(child, key, mode, &format!("{path}/{child_key}"), output);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_nodes_into(child, key, mode, &format!("{path}/{index}"), output);
            }
        }
        _ => {}
    }
}

fn parameterize_scalar_tree(value: &Value, mode: SignatureMode) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let projected = match mode {
                        SignatureMode::Semantic if semantic_key(key) => value.clone(),
                        SignatureMode::Dimensions => match value {
                            Value::Object(_) | Value::Array(_) => {
                                parameterize_scalar_tree(value, mode)
                            }
                            _ if semantic_key(key) => value.clone(),
                            _ => Value::String(value_kind(value).into()),
                        },
                        _ => match value {
                            Value::Object(_) | Value::Array(_) => {
                                parameterize_scalar_tree(value, mode)
                            }
                            _ => Value::String(value_kind(value).into()),
                        },
                    };
                    (key.clone(), projected)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| parameterize_scalar_tree(value, mode))
                .collect(),
        ),
        _ => Value::String(value_kind(value).into()),
    }
}

fn semantic_key(key: &str) -> bool {
    matches!(
        key,
        "type"
            | "operation"
            | "roll"
            | "stat"
            | "target"
            | "source"
            | "recipient"
            | "timing"
            | "phase"
            | "event"
            | "comparison"
            | "range"
            | "duration"
            | "frequency"
            | "grant_type"
            | "keyword"
            | "perspective"
    )
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn project_effect_shape(effect: &Value) -> Value {
    match effect {
        Value::Object(object) => {
            let mut projected = Map::new();
            if let Some(effect_type) = object.get("type") {
                projected.insert("type".into(), effect_type.clone());
            }
            for key in [
                "effect",
                "effects",
                "steps",
                "branches",
                "on_success",
                "on_fail",
                "then",
                "otherwise",
            ] {
                if let Some(child) = object.get(key) {
                    projected.insert(key.into(), project_effect_shape(child));
                }
            }
            Value::Object(projected)
        }
        Value::Array(values) => Value::Array(values.iter().map(project_effect_shape).collect()),
        Value::Null => Value::Null,
        _ => Value::String(value_kind(effect).into()),
    }
}

fn project_control_structure(effect: &Value) -> Value {
    match effect {
        Value::Object(object) => {
            let effect_type = object.get("type").cloned().unwrap_or(Value::Null);
            let children = [
                "effect",
                "effects",
                "steps",
                "branches",
                "on_success",
                "on_fail",
                "then",
                "otherwise",
            ]
            .into_iter()
            .filter_map(|key| {
                object
                    .get(key)
                    .map(|child| (key.to_owned(), project_control_structure(child)))
            })
            .collect::<Map<_, _>>();
            json!({"type": effect_type, "children": children})
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(project_control_structure).collect())
        }
        _ => Value::Null,
    }
}

fn collect_key_values(value: &Value, keys: &[&str]) -> Value {
    let mut values = Vec::new();
    collect_key_values_into(value, keys, "$", &mut values);
    Value::Array(values)
}

fn collect_key_values_into(value: &Value, keys: &[&str], path: &str, output: &mut Vec<Value>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if keys.contains(&key.as_str()) {
                    output.push(json!({"path": path, "key": key, "value": child}));
                }
                collect_key_values_into(child, keys, &format!("{path}/{key}"), output);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_key_values_into(child, keys, &format!("{path}/{index}"), output);
            }
        }
        _ => {}
    }
}

fn lever_signature(dsl: &Value) -> Result<String, EngineError> {
    let mut levers = BTreeSet::new();
    collect_levers(dsl.get("effect").unwrap_or(&Value::Null), "$", &mut levers);
    if let Some(range) = dsl.pointer("/scope/range_inches") {
        levers.insert(format!("scope.range_inches:{}", value_kind(range)));
    }
    canonical_json(&serde_json::to_value(levers)?)
}

fn collect_levers(value: &Value, path: &str, output: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(effect_type) = object.get("type").and_then(Value::as_str) {
                output.insert(format!("effect:{effect_type}"));
            }
            if let Some(modifier) = object.get("modifier").and_then(Value::as_object) {
                for (key, value) in modifier {
                    let semantic = if semantic_key(key) {
                        format!("={value}")
                    } else {
                        format!(":{}", value_kind(value))
                    };
                    output.insert(format!("modifier:{key}{semantic}"));
                }
            }
            if let Some(target) = object.get("target").and_then(Value::as_str) {
                output.insert(format!("target:{target}"));
            }
            for (key, child) in object {
                collect_levers(child, &format!("{path}/{key}"), output);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_levers(child, &format!("{path}/{index}"), output);
            }
        }
        _ => {}
    }
}

fn clause_signature(dsl: &Value) -> Result<String, EngineError> {
    let mut clauses = BTreeSet::new();
    collect_clause_paths(dsl.get("effect").unwrap_or(&Value::Null), "$", &mut clauses);
    canonical_json(&serde_json::to_value(clauses)?)
}

fn collect_clause_paths(value: &Value, path: &str, output: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(effect_type) = object.get("type").and_then(Value::as_str) {
                output.insert(format!("{path}:{effect_type}"));
            }
            for (key, child) in object {
                collect_clause_paths(child, &format!("{path}/{key}"), output);
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                collect_clause_paths(child, &format!("{path}/{index}"), output);
            }
        }
        _ => {}
    }
}

fn canonical_shape_ids(dsl: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    collect_shape_ids(dsl.get("effect").unwrap_or(&Value::Null), &mut ids);
    ids
}

fn collect_shape_ids(value: &Value, output: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(effect_type) = object.get("type").and_then(Value::as_str) {
                output.insert(effect_type.to_owned());
            }
            for child in object.values() {
                collect_shape_ids(child, output);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_shape_ids(child, output);
            }
        }
        _ => {}
    }
}

pub fn parameterize_dsl(dsl: &Value) -> Result<(Value, Value), EngineError> {
    let mut properties = Map::new();
    let template = parameterize_value(dsl, "$", &mut properties);
    let required = properties
        .keys()
        .cloned()
        .map(Value::String)
        .collect::<Vec<_>>();
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    });
    Ok((template, schema))
}

fn parameterize_value(value: &Value, path: &str, properties: &mut Map<String, Value>) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, child)| {
                    let child_path = format!("{path}/{key}");
                    let value = if should_parameterize(key, child) {
                        let parameter = parameter_name(&child_path);
                        properties
                            .insert(parameter.clone(), json!({"type": json_schema_type(child)}));
                        json!({"$parameter": parameter})
                    } else {
                        parameterize_value(child, &child_path, properties)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, child)| {
                    parameterize_value(child, &format!("{path}/{index}"), properties)
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn should_parameterize(key: &str, value: &Value) -> bool {
    if value.is_object() || value.is_array() || value.is_null() || semantic_key(key) {
        return false;
    }
    matches!(
        key,
        "value"
            | "count"
            | "threshold"
            | "distance"
            | "range_inches"
            | "radius"
            | "amount"
            | "dice"
            | "keyword_value"
            | "limit"
            | "maximum"
            | "minimum"
            | "attacks"
            | "damage"
    ) || value.is_number()
}

fn parameter_name(path: &str) -> String {
    path.trim_start_matches("$/")
        .replace(['/', '-'], "_")
        .replace(['[', ']'], "")
}

fn json_schema_type(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        Value::Null => "null",
    }
}

fn classify_confidence(
    candidate: &CorpusCandidate,
    embeddings: &MechanicEmbeddings,
    schema_valid: bool,
    integrity_valid: bool,
) -> (ConfidenceTier, BTreeSet<String>) {
    let mut reasons = BTreeSet::new();
    if candidate
        .verification
        .as_ref()
        .is_some_and(|evidence| evidence.complete_for(candidate.dsl_hash))
    {
        reasons.insert("exact-revision-independent-verification".into());
        return (ConfidenceTier::Verified, reasons);
    }
    if candidate.source_hash.is_none() {
        reasons.insert("source-evidence-unavailable".into());
        return (ConfidenceTier::Unpaired, reasons);
    }
    if !schema_valid || !integrity_valid {
        reasons.insert("validation-failed".into());
        return (ConfidenceTier::Suspect, reasons);
    }
    let dsl_text = canonical_json(&candidate.normalized_dsl).unwrap_or_default();
    let approximation = ["community_notes", "[approx]", "unsupported", "needs-schema"]
        .into_iter()
        .any(|marker| dsl_text.to_ascii_lowercase().contains(marker));
    if approximation {
        reasons.insert("approximate-or-unsupported-structure".into());
    }
    if candidate.confidence_reasons.contains("describer-fallback") {
        reasons.insert("describer-output-unavailable".into());
    }
    let source_describer_similarity = embeddings
        .source_evidence
        .as_ref()
        .zip(embeddings.describer_output.as_ref())
        .and_then(|(source, describer)| source.cosine(describer));
    if candidate
        .roundtrip_score
        .is_some_and(|score| score < SUSPECT_ROUNDTRIP_MAX)
    {
        reasons.insert("low-roundtrip-score".into());
    }
    if source_describer_similarity.is_some_and(|score| score < SUSPECT_ROUNDTRIP_MAX) {
        reasons.insert("low-source-describer-agreement".into());
    }
    if approximation
        || candidate.confidence_reasons.contains("describer-fallback")
        || candidate
            .roundtrip_score
            .is_some_and(|score| score < SUSPECT_ROUNDTRIP_MAX)
        || source_describer_similarity.is_some_and(|score| score < SUSPECT_ROUNDTRIP_MAX)
    {
        return (ConfidenceTier::Suspect, reasons);
    }
    if candidate
        .roundtrip_score
        .is_some_and(|score| score >= TRUSTED_ROUNDTRIP_MIN)
        && source_describer_similarity.is_some_and(|score| score >= SUSPECT_ROUNDTRIP_MAX)
    {
        reasons.insert("strong-source-describer-agreement".into());
        (ConfidenceTier::TrustedProvisional, reasons)
    } else {
        reasons.insert("insufficient-independent-verification".into());
        (ConfidenceTier::Suspect, reasons)
    }
}

fn build_clusters(
    members: &[SeedMember],
) -> Result<
    (
        BTreeMap<MechanicClusterId, MechanicCluster>,
        Vec<RegistryQueueEntry>,
        Vec<RegistryQueueEntry>,
        Vec<RegistryQueueEntry>,
    ),
    EngineError,
> {
    let mut grouped = BTreeMap::<MechanicClusterId, Vec<&SeedMember>>::new();
    for member in members {
        grouped
            .entry(member.cluster_id.clone())
            .or_default()
            .push(member);
    }
    let mut clusters = BTreeMap::new();
    for (cluster_id, grouped_members) in &grouped {
        let first = grouped_members[0];
        let verified_exemplars = member_keys(grouped_members, ConfidenceTier::Verified);
        let provisional_members = member_keys(grouped_members, ConfidenceTier::TrustedProvisional);
        let suspect_members = member_keys(grouped_members, ConfidenceTier::Suspect);
        let unpaired_members = member_keys(grouped_members, ConfidenceTier::Unpaired);
        let confidence = if !verified_exemplars.is_empty() {
            ConfidenceTier::Verified
        } else if provisional_members.len() >= 2 {
            ConfidenceTier::TrustedProvisional
        } else if !suspect_members.is_empty() {
            ConfidenceTier::Suspect
        } else {
            ConfidenceTier::Unpaired
        };
        let mut templates = BTreeMap::<Hash256, MechanicTemplate>::new();
        for member in grouped_members
            .iter()
            .filter(|member| member.confidence.template_eligible())
        {
            let (dsl_template, parameter_schema) = parameterize_dsl(&member.normalized_dsl)?;
            let template_hash = Hash256::digest(serde_json::to_vec(&(
                &dsl_template,
                &parameter_schema,
                &member.structural_signature,
            ))?);
            templates.entry(template_hash).or_insert(MechanicTemplate {
                template_hash,
                source_member: member.key.clone(),
                dsl_template,
                parameter_schema,
                confidence: member.confidence,
            });
        }
        let accepted_templates = templates.into_values().collect::<Vec<_>>();
        let parameter_schema = accepted_templates
            .first()
            .map(|template| template.parameter_schema.clone())
            .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
        clusters.insert(
            cluster_id.clone(),
            MechanicCluster {
                canonical_cluster_id: cluster_id.clone(),
                structural_signature: first.structural_signature.clone(),
                evidence_embedding: centroid(
                    grouped_members
                        .iter()
                        .filter_map(|member| member.embeddings.source_evidence.as_ref()),
                ),
                architecture_embedding: centroid(
                    grouped_members
                        .iter()
                        .filter_map(|member| member.embeddings.normalized_architecture.as_ref()),
                ),
                dsl_structure_embedding: centroid(
                    grouped_members
                        .iter()
                        .filter_map(|member| member.embeddings.normalized_dsl_structure.as_ref()),
                ),
                canonical_shape_ids: grouped_members
                    .iter()
                    .flat_map(|member| member.canonical_shape_ids.iter().cloned())
                    .collect(),
                parameter_schema,
                lever_signature: first.lever_signature.clone(),
                accepted_templates,
                verified_exemplars,
                provisional_members,
                suspect_members,
                unpaired_members,
                known_exclusions: BTreeSet::new(),
                rejected_equivalences: BTreeSet::new(),
                conflicting_members: BTreeSet::new(),
                support_count: u32::try_from(grouped_members.len()).unwrap_or(u32::MAX),
                confidence,
                verification_provenance: grouped_members
                    .iter()
                    .filter_map(|member| {
                        member.verification_provenance.as_ref().map(|evidence| {
                            Hash256::digest(serde_json::to_vec(evidence).unwrap_or_default())
                        })
                    })
                    .collect(),
            },
        );
    }

    let nearest = nearest_incompatible_clusters(&clusters);
    let mut contradiction_queue = Vec::new();
    let mut suspect_queue = Vec::new();
    let mut novelty_queue = Vec::new();
    for member in members {
        let cluster = &clusters[&member.cluster_id];
        if member.confidence == ConfidenceTier::Suspect {
            suspect_queue.push(RegistryQueueEntry {
                kind: QueueKind::Suspect,
                member: member.key.clone(),
                cluster_id: member.cluster_id.clone(),
                priority: cluster.support_count.saturating_mul(10),
                reasons: member.confidence_reasons.clone(),
                nearest_cluster: nearest.get(&member.cluster_id).map(|(id, _)| id.clone()),
                semantic_similarity: nearest.get(&member.cluster_id).map(|(_, score)| *score),
            });
        }
        if let Some((nearest_cluster, similarity)) = nearest.get(&member.cluster_id)
            && *similarity >= SEMANTIC_BOUNDARY_MIN
        {
            let mut reasons = incompatible_dimensions(
                &member.structural_signature,
                &clusters[nearest_cluster].structural_signature,
            );
            reasons.insert("semantic-neighbor-structurally-incompatible".into());
            contradiction_queue.push(RegistryQueueEntry {
                kind: QueueKind::Contradiction,
                member: member.key.clone(),
                cluster_id: member.cluster_id.clone(),
                priority: cluster.support_count.saturating_mul(20),
                reasons,
                nearest_cluster: Some(nearest_cluster.clone()),
                semantic_similarity: Some(*similarity),
            });
        }
        if cluster.verified_exemplars.is_empty()
            && cluster.provisional_members.len() < 2
            && member.confidence != ConfidenceTier::Suspect
        {
            novelty_queue.push(RegistryQueueEntry {
                kind: QueueKind::Novelty,
                member: member.key.clone(),
                cluster_id: member.cluster_id.clone(),
                priority: cluster.support_count,
                reasons: BTreeSet::from(["unsupported-structural-cluster".into()]),
                nearest_cluster: nearest.get(&member.cluster_id).map(|(id, _)| id.clone()),
                semantic_similarity: nearest.get(&member.cluster_id).map(|(_, score)| *score),
            });
        }
    }
    sort_queue(&mut contradiction_queue);
    sort_queue(&mut suspect_queue);
    sort_queue(&mut novelty_queue);
    Ok((clusters, contradiction_queue, suspect_queue, novelty_queue))
}

fn member_keys(members: &[&SeedMember], confidence: ConfidenceTier) -> BTreeSet<AbilityKey> {
    members
        .iter()
        .filter(|member| member.confidence == confidence)
        .map(|member| member.key.clone())
        .collect()
}

fn centroid<'a>(vectors: impl Iterator<Item = &'a EmbeddingVector>) -> Option<EmbeddingVector> {
    let vectors = vectors.collect::<Vec<_>>();
    let first = *vectors.first()?;
    if vectors
        .iter()
        .any(|vector| vector.model != first.model || vector.values.len() != first.values.len())
    {
        return None;
    }
    let mut values = vec![0.0_f32; first.values.len()];
    for vector in &vectors {
        for (sum, value) in values.iter_mut().zip(&vector.values) {
            *sum += *value;
        }
    }
    let norm = values
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 {
        return None;
    }
    for value in &mut values {
        *value = (f64::from(*value) / norm) as f32;
    }
    Some(EmbeddingVector {
        model: first.model.clone(),
        values,
    })
}

fn nearest_incompatible_clusters(
    clusters: &BTreeMap<MechanicClusterId, MechanicCluster>,
) -> BTreeMap<MechanicClusterId, (MechanicClusterId, f64)> {
    let mut nearest = BTreeMap::new();
    let values = clusters.values().collect::<Vec<_>>();
    for (index, left) in values.iter().enumerate() {
        let Some(left_embedding) = &left.evidence_embedding else {
            continue;
        };
        for right in values.iter().skip(index + 1) {
            if left
                .structural_signature
                .structurally_compatible(&right.structural_signature)
            {
                continue;
            }
            let Some(similarity) = right
                .evidence_embedding
                .as_ref()
                .and_then(|embedding| left_embedding.cosine(embedding))
            else {
                continue;
            };
            insert_nearest(
                &mut nearest,
                &left.canonical_cluster_id,
                &right.canonical_cluster_id,
                similarity,
            );
            insert_nearest(
                &mut nearest,
                &right.canonical_cluster_id,
                &left.canonical_cluster_id,
                similarity,
            );
        }
    }
    nearest
}

fn insert_nearest(
    nearest: &mut BTreeMap<MechanicClusterId, (MechanicClusterId, f64)>,
    key: &MechanicClusterId,
    candidate: &MechanicClusterId,
    similarity: f64,
) {
    match nearest.get(key) {
        Some((_, current)) if *current >= similarity => {}
        _ => {
            nearest.insert(key.clone(), (candidate.clone(), similarity));
        }
    }
}

fn incompatible_dimensions(
    left: &StructuralSignature,
    right: &StructuralSignature,
) -> BTreeSet<String> {
    let mut dimensions = BTreeSet::new();
    for (name, left, right) in [
        ("timing", &left.trigger_family, &right.trigger_family),
        ("condition", &left.condition_tree, &right.condition_tree),
        ("control", &left.control_structure, &right.control_structure),
        ("actor-target", &left.actor_binding, &right.actor_binding),
        (
            "scope",
            &left.target_scope_structure,
            &right.target_scope_structure,
        ),
        (
            "duration-usage",
            &left.duration_usage,
            &right.duration_usage,
        ),
        (
            "canonical-lever",
            &left.lever_signature,
            &right.lever_signature,
        ),
    ] {
        if left != right {
            dimensions.insert(format!("incompatible-{name}"));
        }
    }
    dimensions
}

fn sort_queue(queue: &mut [RegistryQueueEntry]) {
    queue.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.member.cmp(&right.member))
    });
}

const FAST_LANE_SEMANTIC_MIN: f64 = 0.80;

pub fn retrieve_cluster(
    revision: &RegistryRevision,
    signature: &StructuralSignature,
    combined_embedding: Option<&EmbeddingVector>,
) -> Result<RetrievalDecision, EngineError> {
    revision.validate()?;
    let exact_id = MechanicClusterId::from_signature(signature)?;
    let mut candidates = revision
        .body
        .clusters
        .values()
        .map(|cluster| {
            let similarity = combined_embedding.and_then(|query| {
                cluster
                    .evidence_embedding
                    .as_ref()
                    .and_then(|embedding| query.cosine(embedding))
            });
            let negative_boundary = cluster
                .known_exclusions
                .iter()
                .find(|exclusion| exclusion.other_cluster_id == exact_id)
                .map(|exclusion| exclusion.distinction_code.clone());
            RetrievalCandidate {
                cluster_id: cluster.canonical_cluster_id.clone(),
                structural_compatible: cluster
                    .structural_signature
                    .structurally_compatible(signature),
                semantic_similarity: similarity,
                confidence: cluster.confidence,
                support_count: cluster.support_count,
                negative_boundary,
            }
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .structural_compatible
            .cmp(&left.structural_compatible)
            .then_with(|| {
                right
                    .semantic_similarity
                    .partial_cmp(&left.semantic_similarity)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| right.support_count.cmp(&left.support_count))
            .then_with(|| left.cluster_id.cmp(&right.cluster_id))
    });
    candidates.truncate(8);

    let exact = revision.body.clusters.get(&exact_id);
    let mut reasons = BTreeSet::new();
    let exact_similarity = candidates
        .iter()
        .find(|candidate| candidate.cluster_id == exact_id)
        .and_then(|candidate| candidate.semantic_similarity);
    let (lane, selected_cluster, selected_template_hash) = match exact {
        Some(cluster)
            if cluster.known_exclusions.is_empty()
                && !cluster.accepted_templates.is_empty()
                && exact_similarity
                    .is_some_and(|similarity| similarity >= FAST_LANE_SEMANTIC_MIN)
                && (cluster.confidence == ConfidenceTier::Verified
                    || cluster.confidence == ConfidenceTier::TrustedProvisional
                        && cluster.provisional_members.len() >= 2) =>
        {
            reasons.insert("structural-template-match".into());
            if cluster.confidence == ConfidenceTier::Verified {
                reasons.insert("verified-family".into());
            } else {
                reasons.insert("multiply-supported-provisional-family".into());
            }
            (
                ExecutionLane::Fast,
                Some(cluster.canonical_cluster_id.clone()),
                cluster
                    .accepted_templates
                    .first()
                    .map(|template| template.template_hash),
            )
        }
        Some(cluster) if !cluster.accepted_templates.is_empty() => {
            reasons.insert("existing-family-requires-focused-review".into());
            (
                ExecutionLane::Review,
                Some(cluster.canonical_cluster_id.clone()),
                cluster
                    .accepted_templates
                    .first()
                    .map(|template| template.template_hash),
            )
        }
        _ => {
            let boundary = candidates.iter().any(|candidate| {
                candidate
                    .semantic_similarity
                    .is_some_and(|score| score >= SEMANTIC_BOUNDARY_MIN)
            });
            if boundary {
                reasons.insert("near-known-family-boundary".into());
                (ExecutionLane::Review, None, None)
            } else {
                reasons.insert("no-honest-cluster-match".into());
                (ExecutionLane::Full, None, None)
            }
        }
    };
    Ok(RetrievalDecision {
        registry_revision: revision.revision_id,
        lane,
        selected_cluster,
        selected_template_hash,
        candidates,
        reasons,
    })
}

pub fn deduplicate_shape_id(
    revision: &RegistryRevision,
    signature: &StructuralSignature,
    proposed_shape_ids: &BTreeSet<String>,
) -> Result<(MechanicClusterId, BTreeSet<String>), EngineError> {
    revision.validate()?;
    let canonical_cluster_id = MechanicClusterId::from_signature(signature)?;
    let canonical_shape_ids = revision
        .body
        .clusters
        .get(&canonical_cluster_id)
        .map(|cluster| cluster.canonical_shape_ids.clone())
        .unwrap_or_else(|| proposed_shape_ids.clone());
    Ok((canonical_cluster_id, canonical_shape_ids))
}
pub fn retrieval_for_member(
    revision: &RegistryRevision,
    key: &AbilityKey,
) -> Result<RetrievalDecision, EngineError> {
    let member = revision
        .body
        .members
        .iter()
        .find(|member| &member.key == key)
        .ok_or_else(|| EngineError::Registry(format!("ability is not in registry: {key}")))?;
    retrieve_cluster(
        revision,
        &member.structural_signature,
        member.embeddings.combined_mechanic.as_ref(),
    )
}

pub fn instantiate_retrieved_template(
    revision: &RegistryRevision,
    key: &AbilityKey,
    decision: &RetrievalDecision,
) -> Result<Value, EngineError> {
    if decision.registry_revision != revision.revision_id {
        return Err(EngineError::Registry(
            "retrieval decision references a different registry revision".into(),
        ));
    }
    let cluster_id = decision
        .selected_cluster
        .as_ref()
        .ok_or_else(|| EngineError::Registry("retrieval selected no cluster".into()))?;
    let template_hash = decision
        .selected_template_hash
        .ok_or_else(|| EngineError::Registry("retrieval selected no template".into()))?;
    let member = revision
        .body
        .members
        .iter()
        .find(|member| &member.key == key)
        .ok_or_else(|| EngineError::Registry(format!("ability is not in registry: {key}")))?;
    let cluster = revision
        .body
        .clusters
        .get(cluster_id)
        .ok_or_else(|| EngineError::Registry("retrieved cluster is missing".into()))?;
    let template = cluster
        .accepted_templates
        .iter()
        .find(|template| template.template_hash == template_hash)
        .ok_or_else(|| EngineError::Registry("retrieved template is missing".into()))?;
    let instantiated = instantiate_value(&template.dsl_template, &member.normalized_dsl)?;
    if !cluster
        .structural_signature
        .structurally_compatible(&compute_structural_signature(&instantiated)?)
    {
        return Err(EngineError::Registry(
            "instantiated template changed structural signature".into(),
        ));
    }
    Ok(instantiated)
}

fn instantiate_value(template: &Value, target: &Value) -> Result<Value, EngineError> {
    match template {
        Value::Object(object)
            if object.len() == 1 && object.get("$parameter").and_then(Value::as_str).is_some() =>
        {
            Ok(target.clone())
        }
        Value::Object(object) => {
            let target = target.as_object().ok_or_else(|| {
                EngineError::Registry("template object does not match target".into())
            })?;
            object
                .iter()
                .map(|(key, child)| {
                    let target_child = target.get(key).ok_or_else(|| {
                        EngineError::Registry(format!("template target is missing {key}"))
                    })?;
                    Ok((key.clone(), instantiate_value(child, target_child)?))
                })
                .collect::<Result<Map<String, Value>, EngineError>>()
                .map(Value::Object)
        }
        Value::Array(values) => {
            let target = target.as_array().ok_or_else(|| {
                EngineError::Registry("template array does not match target".into())
            })?;
            if values.len() != target.len() {
                return Err(EngineError::Registry(
                    "template array length does not match target".into(),
                ));
            }
            values
                .iter()
                .zip(target)
                .map(|(child, target_child)| instantiate_value(child, target_child))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        _ if template == target => Ok(template.clone()),
        _ => Err(EngineError::Registry(format!(
            "fixed template value {template} does not match target {target}"
        ))),
    }
}

pub fn prioritized_campaign_candidates(
    revision: &RegistryRevision,
    limit: usize,
) -> Result<Vec<(AbilityKey, RetrievalDecision, u32)>, EngineError> {
    revision.validate()?;
    let mut candidates = revision
        .body
        .members
        .iter()
        .filter_map(|member| {
            let cluster = revision.body.clusters.get(&member.cluster_id)?;
            let template = cluster.accepted_templates.first()?;
            let semantic_similarity =
                member
                    .embeddings
                    .combined_mechanic
                    .as_ref()
                    .and_then(|member_embedding| {
                        cluster
                            .evidence_embedding
                            .as_ref()
                            .and_then(|cluster_embedding| {
                                member_embedding.cosine(cluster_embedding)
                            })
                    });
            let fast_lane = cluster.known_exclusions.is_empty()
                && semantic_similarity
                    .is_some_and(|similarity| similarity >= FAST_LANE_SEMANTIC_MIN)
                && (cluster.confidence == ConfidenceTier::Verified
                    || cluster.confidence == ConfidenceTier::TrustedProvisional
                        && cluster.provisional_members.len() >= 2);
            let lane = if fast_lane {
                ExecutionLane::Fast
            } else {
                ExecutionLane::Review
            };
            let decision = RetrievalDecision {
                registry_revision: revision.revision_id,
                lane,
                selected_cluster: Some(cluster.canonical_cluster_id.clone()),
                selected_template_hash: Some(template.template_hash),
                candidates: vec![RetrievalCandidate {
                    cluster_id: cluster.canonical_cluster_id.clone(),
                    structural_compatible: true,
                    semantic_similarity,
                    confidence: cluster.confidence,
                    support_count: cluster.support_count,
                    negative_boundary: None,
                }],
                reasons: BTreeSet::from([if fast_lane {
                    "structural-template-match".into()
                } else {
                    "existing-family-requires-focused-review".into()
                }]),
            };
            if member.confidence == ConfidenceTier::Suspect {
                return None;
            }
            let confidence_bonus = match member.confidence {
                ConfidenceTier::Verified => 300,
                ConfidenceTier::TrustedProvisional => 200,
                ConfidenceTier::Unpaired => 50,
                ConfidenceTier::Suspect => 0,
            };
            let lane_bonus = match decision.lane {
                ExecutionLane::Fast => 200,
                ExecutionLane::Review => 50,
                ExecutionLane::Full => 0,
            };
            let family_leverage = cluster.support_count.saturating_mul(20);
            Some((
                member.key.clone(),
                decision,
                confidence_bonus + lane_bonus + family_leverage,
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));
    candidates.truncate(limit);
    Ok(candidates)
}

pub fn write_registry_reports(
    output_dir: &Path,
    revision: &RegistryRevision,
    report: &RegistrySeedReport,
) -> Result<(), EngineError> {
    revision.validate()?;
    fs::create_dir_all(output_dir)?;
    let outputs = [
        (
            "cluster-registry.json",
            serde_json::to_vec_pretty(revision)?,
        ),
        (
            "contradiction-queue.json",
            serde_json::to_vec_pretty(&revision.body.contradiction_queue)?,
        ),
        (
            "suspect-queue.json",
            serde_json::to_vec_pretty(&revision.body.suspect_queue)?,
        ),
        (
            "novelty-queue.json",
            serde_json::to_vec_pretty(&revision.body.novelty_queue)?,
        ),
        ("seed-report.json", serde_json::to_vec_pretty(report)?),
    ];
    for (name, bytes) in outputs {
        let path = output_dir.join(name);
        let temporary = output_dir.join(format!(".{name}.tmp"));
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)?;
    }
    Ok(())
}

fn summarize_seed(revision: &RegistryRevision) -> RegistrySeedReport {
    let count = |tier| {
        revision
            .body
            .members
            .iter()
            .filter(|member| member.confidence == tier)
            .count()
    };
    RegistrySeedReport {
        revision_id: revision.revision_id,
        corpus_root_hash: revision.body.corpus_root_hash,
        total_members: revision.body.members.len(),
        verified_members: count(ConfidenceTier::Verified),
        trusted_provisional_members: count(ConfidenceTier::TrustedProvisional),
        suspect_members: count(ConfidenceTier::Suspect),
        unpaired_members: count(ConfidenceTier::Unpaired),
        clusters: revision.body.clusters.len(),
        template_clusters: revision
            .body
            .clusters
            .values()
            .filter(|cluster| !cluster.accepted_templates.is_empty())
            .count(),
        contradiction_queue: revision.body.contradiction_queue.len(),
        suspect_queue: revision.body.suspect_queue.len(),
        novelty_queue: revision.body.novelty_queue.len(),
    }
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

fn canonical_json(value: &Value) -> Result<String, EngineError> {
    Ok(serde_json::to_string(value)?)
}

fn infer_ability_type(path: &Path) -> &str {
    match path.file_name().and_then(|name| name.to_str()) {
        Some("stratagems.json") => "stratagem",
        Some("enhancements.json") => "enhancement",
        Some("detachment-rules.json") => "detachment",
        _ => "unit",
    }
}
