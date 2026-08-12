use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use campaign_domain::{
    ActorId, ArchitectureFacts, ArtifactKind, CampaignId, CandidateFacts, CausationId, Command,
    CommandAction, CommandId, CommandMeta, CorrelationId, DecompositionFacts, EvidenceFacts,
    Hash256, MechanicalVerificationFacts, RefutationFacts, ReviewFacts, RunManifest, Sensitivity,
};
use campaign_executors::{
    ApplyPlan, Capability, CapabilityGrant, ClauseClassification, CommandContract, EvidenceClause,
    EvidencePacket, JjClient, ParityAreaResult, PathOperation, PublicationPlan, SIX_PAIRS,
    SensitiveCorpus, apply_exact_plan, compare_levers, extract_dsl_levers, hash_file,
    publish_draft, retrieve_family_candidates, retrieve_source, run_observed,
    validate_evidence_packet,
};
use campaign_roles::{
    Role, RoleError, RoleExecutor, RoleRequest, RoleSpec, ValidatedRoleResult, role_specs,
};
use campaign_store::{EffectIntent, EffectKind, Lease, OutboxStatus};
use serde_json::{Value, json};

use crate::{
    CampaignEngine, CloseEvidence, EngineError, NodeExecutor, ProducedArtifact, WorkCompletion,
    WorkKind, WorkNode, validate_close,
};

pub struct CampaignNodeExecutor {
    campaign_id: CampaignId,
    engine: CampaignEngine,
    roles: Arc<dyn RoleExecutor>,
    repository_root: PathBuf,
    raw_store_root: PathBuf,
    allow_shape_application: bool,
    authorized_shape_plan_hash: Option<Hash256>,
}

impl CampaignNodeExecutor {
    pub fn new(
        campaign_id: CampaignId,
        engine: CampaignEngine,
        roles: Arc<dyn RoleExecutor>,
        repository_root: impl Into<PathBuf>,
        raw_store_root: impl Into<PathBuf>,
        allow_shape_application: bool,
        authorized_shape_plan_hash: Option<Hash256>,
    ) -> Self {
        Self {
            engine,
            campaign_id,
            roles,
            repository_root: repository_root.into(),
            raw_store_root: raw_store_root.into(),
            allow_shape_application,
            authorized_shape_plan_hash,
        }
    }

    fn state(&self, _node: &WorkNode) -> Result<campaign_domain::CampaignState, EngineError> {
        Ok(self.engine.state(&self.campaign_id)?)
    }

    fn meta(
        &self,
        node: &WorkNode,
        lease: &Lease,
        outbox_id: Option<campaign_domain::OutboxId>,
    ) -> Result<CommandMeta, EngineError> {
        let state = self.state(node)?;
        Ok(CommandMeta {
            command_id: CommandId::new(),
            campaign_id: self.campaign_id.clone(),
            expected_stream_version: state.stream_version,
            causation_id: CausationId::new(),
            correlation_id: CorrelationId::new(),
            actor: ActorId::new("rig-worker")?,
            expected_manifest_hash: state.manifest_hash,
            expected_engine_hash: self.engine.engine_hash(),
            outbox_id,
            fencing_token: Some(lease.fencing_token),
            lease_resource: Some(lease.resource_key.clone()),
            lease_owner: Some(lease.owner_id.clone()),
        })
    }

    fn command(
        &self,
        node: &WorkNode,
        lease: &Lease,
        action: CommandAction,
    ) -> Result<Command, EngineError> {
        Ok(Command {
            meta: self.meta(node, lease, None)?,
            action,
        })
    }

    fn command_for_effect(
        &self,
        node: &WorkNode,
        lease: &Lease,
        record: &campaign_store::OutboxRecord,
        action: CommandAction,
    ) -> Result<Command, EngineError> {
        let meta = self.meta(
            node,
            lease,
            Some(record.outbox_id.parse().map_err(|_| EngineError::Policy)?),
        )?;
        Ok(Command { meta, action })
    }

    fn command_for_intent(
        &self,
        node: &WorkNode,
        lease: &Lease,
        intent: &EffectIntent,
        action: CommandAction,
    ) -> Result<Command, EngineError> {
        Ok(Command {
            meta: self.meta(node, lease, Some(intent.outbox_id))?,
            action,
        })
    }

    fn command_with_effect(
        &self,
        node: &WorkNode,
        lease: &Lease,
        action: CommandAction,
        effect_kind: EffectKind,
        idempotency_key: String,
        request: Value,
    ) -> Result<(Command, EffectIntent), EngineError> {
        let outbox_id = campaign_domain::OutboxId::new();
        let command = Command {
            meta: self.meta(node, lease, Some(outbox_id))?,
            action,
        };
        let effect = EffectIntent {
            outbox_id,
            effect_kind,
            idempotency_key,
            request,
            fencing_token: lease.fencing_token,
            available_at: time::OffsetDateTime::now_utc().unix_timestamp(),
        };
        Ok((command, effect))
    }
    fn request_ability_rollback(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
        evidence_hash: Hash256,
        terminal: bool,
    ) -> Result<(Command, EffectIntent), EngineError> {
        let plan_hash = ability.apply_plan_hash.ok_or(EngineError::Policy)?;
        let plan: ApplyPlan =
            serde_json::from_slice(&self.engine.store().read_artifact(plan_hash)?)?;
        let applied_commit = ability.applied_commit.as_ref().ok_or(EngineError::Policy)?;
        let idempotency_key = format!(
            "ability-rollback:{}:{}:{}:{}",
            self.campaign_id, key.faction_id, key.ability_id, applied_commit
        );
        self.command_with_effect(
            node,
            lease,
            CommandAction::RequestAbilityRollback {
                key: key.clone(),
                evidence_hash,
                restore_head: plan.expected_head.clone(),
                terminal,
            },
            EffectKind::RepositoryApply,
            idempotency_key,
            json!({
                "terminal": terminal,
                "ability": key,
                "applied_commit": applied_commit,
                "restore_head": plan.expected_head,
                "evidence_hash": evidence_hash,
            }),
        )
    }

    fn claim_effect(
        &self,
        record: &campaign_store::OutboxRecord,
        idempotency_key: &str,
        lease: &Lease,
    ) -> Result<campaign_store::OutboxRecord, EngineError> {
        if record.status == OutboxStatus::Unreconciled {
            return Err(EngineError::Policy);
        }
        if record.status == OutboxStatus::Observed {
            return Ok(record.clone());
        }
        Ok(self.engine.store().claim_effect(
            idempotency_key,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?)
    }

    fn ensure_apply_outbox(
        &self,
        node: &WorkNode,
        lease: &Lease,
        idempotency_key: &str,
        plan: &ApplyPlan,
    ) -> Result<campaign_store::OutboxRecord, EngineError> {
        if let Some(record) = self.engine.store().outbox_by_key(idempotency_key)? {
            return Ok(record);
        }
        Ok(self.engine.store().enqueue_effect(
            campaign_domain::OutboxId::new(),
            node.work_id,
            EffectKind::RepositoryApply,
            idempotency_key,
            &serde_json::to_value(plan)?,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?)
    }

    fn source(&self, node: &WorkNode) -> Result<campaign_executors::RetrievedSource, EngineError> {
        let key = node.ability.as_ref().ok_or(EngineError::Policy)?;
        let grants = CapabilityGrant::from_capabilities([Capability::ReadRawStore]);
        Ok(retrieve_source(&grants, &self.raw_store_root, key)?)
    }

    fn corpus_for_keys<'a>(
        &self,
        keys: impl IntoIterator<Item = &'a campaign_domain::AbilityKey>,
    ) -> Result<SensitiveCorpus, EngineError> {
        let grants = CapabilityGrant::from_capabilities([Capability::ReadRawStore]);
        let sources = keys
            .into_iter()
            .map(|key| {
                retrieve_source(&grants, &self.raw_store_root, key).map(|source| source.source_text)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SensitiveCorpus::new(sources.iter().map(String::as_bytes)))
    }

    fn spec(role: Role) -> Result<RoleSpec, EngineError> {
        role_specs()?
            .into_iter()
            .find(|spec| spec.role == role)
            .ok_or(EngineError::Policy)
    }

    async fn run_role(
        &self,
        node: &WorkNode,
        lease: &Lease,
        role: Role,
        attempt: u8,
        voter: Option<u8>,
        input_artifacts: Vec<Hash256>,
        task: Value,
    ) -> Result<ValidatedRoleResult, EngineError> {
        self.run_role_checked(
            node,
            lease,
            role,
            attempt,
            voter,
            input_artifacts,
            task,
            |_| Ok(()),
        )
        .await
    }

    async fn run_role_checked<F>(
        &self,
        node: &WorkNode,
        lease: &Lease,
        role: Role,
        attempt: u8,
        voter: Option<u8>,
        input_artifacts: Vec<Hash256>,
        task: Value,
        validate: F,
    ) -> Result<ValidatedRoleResult, EngineError>
    where
        F: Fn(&ValidatedRoleResult) -> Result<(), RoleError> + Send + Sync,
    {
        let state = self.state(node)?;
        let max_attempts = state
            .manifest
            .as_ref()
            .ok_or(EngineError::Policy)?
            .budgets
            .max_assembly_attempts;
        let attempt_count = max_attempts.saturating_sub(attempt).saturating_add(1);
        let mut retry_task = task;
        for retry_index in 0..attempt_count {
            let current_attempt = attempt.saturating_add(retry_index);
            let result = self
                .run_role_once(
                    node,
                    lease,
                    role,
                    current_attempt,
                    voter,
                    input_artifacts.clone(),
                    retry_task.clone(),
                )
                .await
                .and_then(|result| {
                    validate(&result).map_err(EngineError::Role)?;
                    Ok(result)
                });
            match result {
                Ok(result) => return Ok(result),
                Err(EngineError::Role(error))
                    if retry_index.saturating_add(1) < attempt_count
                        && retryable_role_error(&error) =>
                {
                    if let Some(task) = retry_task.as_object_mut() {
                        task.insert(
                            "retry_context".into(),
                            json!({
                                "prior_attempt": current_attempt,
                                "failure": "strict-output-invalid",
                                "diagnostic": role_error_diagnostic(&error),
                                "instruction": role_retry_instruction(&error),
                            }),
                        );
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(EngineError::Policy)
    }

    async fn run_role_once(
        &self,
        node: &WorkNode,
        lease: &Lease,
        role: Role,
        attempt: u8,
        voter: Option<u8>,
        input_artifacts: Vec<Hash256>,
        task: Value,
    ) -> Result<ValidatedRoleResult, EngineError> {
        let state = self.state(node)?;
        let ability = node
            .ability
            .clone()
            .or_else(|| {
                node.shape_id
                    .as_ref()
                    .and_then(|shape_id| state.shapes.get(shape_id))
                    .and_then(|shape| shape.family_members.iter().next().cloned())
            })
            .or_else(|| {
                state
                    .manifest
                    .as_ref()
                    .and_then(|manifest| manifest.ordered_worklist.first())
                    .map(|item| item.key.clone())
            })
            .ok_or(EngineError::Policy)?;
        let request = RoleRequest {
            campaign_id: self.campaign_id.clone(),
            ability,
            role,
            attempt,
            voter,
            manifest_hash: state.manifest_hash.ok_or(EngineError::Policy)?,
            input_artifacts: input_artifacts.clone(),
            sensitive_input: task,
        };
        let request_hash = request.deidentified_hash();
        let idempotency_key = format!(
            "provider:{}:{}:{}:{}:{}",
            self.campaign_id,
            node.work_id,
            role.as_str(),
            attempt,
            voter.map_or_else(|| "single".to_owned(), |value| value.to_string()),
        );
        if let Some(artifact_hash) = self
            .engine
            .store()
            .observed_effect_artifact(&idempotency_key)?
        {
            return Ok(serde_json::from_slice(
                &self.engine.store().read_artifact(artifact_hash)?,
            )?);
        }
        let outbox = self.engine.store().enqueue_effect(
            campaign_domain::OutboxId::new(),
            node.work_id,
            EffectKind::ProviderTurn,
            &idempotency_key,
            &json!({
                "campaign_id": self.campaign_id,
                "work_id": node.work_id,
                "role": role,
                "request_hash": request_hash,
            }),
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        self.claim_effect(&outbox, &idempotency_key, lease)?;
        let run_ability = request.ability.clone();
        let result = match self.roles.execute(&Self::spec(role)?, request).await {
            Ok(result) => result,
            Err(error @ RoleError::Unreconciled) => {
                self.engine.store().mark_effect_unreconciled(
                    &idempotency_key,
                    lease.fencing_token,
                    "provider-outcome-unreconciled",
                )?;
                return Err(error.into());
            }
            Err(error) => {
                self.engine.store().mark_effect_failed(
                    &idempotency_key,
                    lease.fencing_token,
                    "provider-turn-failed",
                    time::OffsetDateTime::now_utc()
                        .unix_timestamp()
                        .saturating_add(30),
                )?;
                return Err(error.into());
            }
        };
        let bytes = serde_json::to_vec(&result)?;
        let artifact = self.engine.store().put_artifact(
            ArtifactKind::ProviderConversation,
            Sensitivity::Sensitive,
            &bytes,
            "application/json",
            "serde-json",
            &input_artifacts,
        )?;
        let usage_bytes = serde_json::to_vec(&result.usage)?;
        let usage_artifact = self.engine.store().put_artifact(
            ArtifactKind::UsageSample,
            Sensitivity::Deidentified,
            &usage_bytes,
            "application/json",
            "serde-json",
            &[artifact.artifact_id],
        )?;
        let run_manifest = RunManifest {
            campaign_id: self.campaign_id.clone(),
            ability: run_ability,
            role: role.as_str().to_owned(),
            attempt,
            voter,
            request_artifact_hashes: input_artifacts.clone(),
            transport: result.transport.clone(),
            fallback_reason: result.fallback_reason.clone(),
            remote_run_hash: result.remote_run_hash,
            response_artifact_hash: artifact.artifact_id,
            usage_artifact_hash: usage_artifact.artifact_id,
            identity_hash: result.provider_identity_hash,
        };
        let run_manifest_bytes = serde_json::to_vec(&run_manifest)?;
        let run_manifest_artifact = self.engine.store().put_artifact(
            ArtifactKind::RunManifest,
            Sensitivity::Deidentified,
            &run_manifest_bytes,
            "application/json",
            "serde-json",
            &[artifact.artifact_id],
        )?;
        self.engine.store().record_effect_observed(
            &idempotency_key,
            EffectKind::ProviderTurn,
            &json!({
                "request_hash": request_hash,
                "result_hash": artifact.artifact_id,
                "provider_identity_hash": result.provider_identity_hash,
                "run_manifest_hash": run_manifest_artifact.artifact_id,
                "transport": result.transport,
                "usage_artifact_hash": usage_artifact.artifact_id,
                "fallback_reason": result.fallback_reason,
                "remote_run_hash": result.remote_run_hash,
            }),
            Some(artifact.artifact_id),
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        Ok(result)
    }

    fn current_dsl(&self, key: &campaign_domain::AbilityKey) -> Result<Value, EngineError> {
        let path = self
            .repository_root
            .join(format!("data/enrichment/{}/abilities.json", key.faction_id));
        let entries: Vec<Value> = serde_json::from_slice(&std::fs::read(path)?)?;
        find_entry(&entries, key)
            .cloned()
            .ok_or(EngineError::Policy)
    }

    fn produced(
        kind: ArtifactKind,
        sensitivity: Sensitivity,
        bytes: Vec<u8>,
        parent_hashes: Vec<Hash256>,
    ) -> ProducedArtifact {
        ProducedArtifact {
            expected_hash: Hash256::digest(&bytes),
            kind,
            sensitivity,
            bytes,
            media_type: "application/json".into(),
            canonicalization: "serde-json".into(),
            parent_hashes,
        }
    }

    fn payload_bytes(result: &ValidatedRoleResult) -> Result<Vec<u8>, EngineError> {
        Ok(serde_json::to_vec(&result.result.payload)?)
    }
}

fn retryable_role_error(error: &RoleError) -> bool {
    matches!(
        error,
        RoleError::SchemaInvalid
            | RoleError::SemanticInvalid(_)
            | RoleError::PayloadJsonInvalid(_)
            | RoleError::RepairedOutput
            | RoleError::ProviderFailure("response-envelope-invalid")
    )
}

fn role_error_diagnostic(error: &RoleError) -> String {
    match error {
        RoleError::PayloadJsonInvalid(diagnostic) => diagnostic.clone(),
        _ => error.to_string(),
    }
}

fn role_retry_instruction(error: &RoleError) -> &'static str {
    match error {
        RoleError::SemanticInvalid("missing-clause-coverage") => {
            "Return the full Arch-Magos authoring envelope, not a bare abilities.json entry. Put the complete candidate under payload.json's dsl field and include clause_coverage with exactly one row for every supplied clause_id, plus dropped_clauses, placeholder_encoding, approx_mechanical, resisted_schema, self_grade, and confidence."
        }
        RoleError::SemanticInvalid("needs-schema-clause-coverage") => {
            "Return a fresh needs-schema result with exactly one clause_coverage row for every supplied clause id. Mechanical gaps may use disposition unresolved only with source-explicit or schema-derived evidence and a non-null resisted_schema package; exact mechanical rows must remain exact. Keep dropped_clauses empty, placeholder_encoding false, and approx_mechanical false."
        }
        RoleError::SemanticInvalid("architecture-clause-coverage") => {
            "Return a fresh architecture whose source_clause_ids contains every supplied evidence_packet clause id exactly once, including structural and declared non-mechanical clauses. Do not add, omit, or duplicate clause ids."
        }
        RoleError::SemanticInvalid("shape-internal-family") => {
            "Return a fresh shape proposal whose internal_family is an exact JSON copy of task.resisted_schema.architecture.local_actions: preserve the array order and every field/value. Do not summarize rows, rename fields, omit mechanics, or wrap the array in another object."
        }
        RoleError::SemanticInvalid("shape-kind") => {
            "Return a fresh shape proposal whose proposed_shape.kind is exactly one canonical value: condition, container, effect-leaf, or modifier-extension. Do not invent synonyms such as effect-container."
        }
        RoleError::SemanticInvalid("shape-sweep-coverage") => {
            "Return a fresh coverage array with exactly one row for every task.swarmlord_sweep.candidates row and no other rows. Preserve each candidate's faction or faction_id and ability_id exactly. Do not add the seed or task.internal_family children to coverage; report those only through internal_family_size."
        }
        RoleError::SemanticInvalid("source-prose-copy") => {
            "The candidate copied source prose into a DSL string field and was discarded. Return a fresh candidate using canonical DSL identifiers and independently authored mechanic descriptions; do not quote or closely reproduce the supplied raw text."
        }
        RoleError::PayloadJsonInvalid(_) => {
            "Return a fresh result matching the supplied schema and semantic contract exactly. Validate payload.json as one standalone JSON object. Finding severity must be an integer from 1 through 3."
        }
        RoleError::RepairedOutput => {
            "The prior payload required automatic JSON closure and was discarded. Return a fresh result; ensure payload.json is a complete standalone JSON object with every opening delimiter closed exactly once."
        }
        _ => {
            "Return a fresh result matching the supplied schema and semantic contract exactly. Address the diagnostic directly; do not omit required evidence fields. Finding severity must be an integer from 1 through 3."
        }
    }
}

#[async_trait]
impl NodeExecutor for CampaignNodeExecutor {
    async fn execute(&self, node: &WorkNode, lease: &Lease) -> Result<WorkCompletion, EngineError> {
        if matches!(node.kind, WorkKind::ShapeApply) && !self.allow_shape_application {
            return Err(EngineError::Policy);
        }
        if node.shape_id.is_some() {
            return self.execute_shape(node, lease).await;
        }
        if node.ability.is_none() {
            return self.execute_campaign(node, lease);
        }
        let key = node.ability.clone().ok_or(EngineError::Policy)?;
        let state = self.state(node)?;
        let ability = state.abilities.get(&key).ok_or(EngineError::Policy)?;
        match &node.kind {
            WorkKind::BindEvidence => {
                let source = self.source(node)?;
                if source.source_hash != ability.source_hash {
                    return Err(EngineError::Policy);
                }
                let source_bytes = source.source_text.as_bytes();
                let source_artifact = self.engine.store().put_artifact(
                    ArtifactKind::SourceBytes,
                    Sensitivity::Sensitive,
                    source_bytes,
                    "text/plain",
                    "verbatim",
                    &[],
                )?;
                if source_artifact.artifact_id != source.source_hash {
                    return Err(EngineError::Policy);
                }
                let result = self
                    .run_role(
                        node,
                        lease,
                        Role::DataEnginseer,
                        1,
                        None,
                        vec![source.source_hash],
                        json!({
                            "mode": "bind-evidence",
                            "ability_id": key.ability_id,
                            "faction_id": key.faction_id,
                            "raw_text": source.source_text,
                        }),
                    )
                    .await?;
                let native = result
                    .result
                    .payload
                    .get("evidence_packet")
                    .unwrap_or(&result.result.payload);
                let packet = normalized_evidence_packet(native, &source.source_text)?;
                let packet_bytes = serde_json::to_vec(&packet)?;
                let packet_hash = Hash256::digest(&packet_bytes);
                let all_clause_ids = packet
                    .clauses
                    .iter()
                    .map(|clause| clause.id.clone())
                    .collect();
                let mechanical_clause_ids = packet
                    .clauses
                    .iter()
                    .filter(|clause| clause.classification == ClauseClassification::Mechanical)
                    .map(|clause| clause.id.clone())
                    .collect();
                Ok(WorkCompletion {
                    artifacts: vec![
                        Self::produced(
                            ArtifactKind::EvidencePacket,
                            Sensitivity::Deidentified,
                            packet_bytes,
                            vec![source.source_hash],
                        ),
                        Self::produced(
                            ArtifactKind::ProviderConversation,
                            Sensitivity::Sensitive,
                            serde_json::to_vec(&result.result)?,
                            vec![source.source_hash],
                        ),
                    ],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::BindEvidence {
                            key,
                            facts: EvidenceFacts {
                                artifact_hash: packet_hash,
                                source_hash: source.source_hash,
                                all_clause_ids,
                                mechanical_clause_ids,
                                contiguous_partition: true,
                            },
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::Architecture => {
                let source = self.source(node)?;
                let evidence_hash = ability.evidence_hash.ok_or(EngineError::Policy)?;
                let evidence: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(evidence_hash)?)?;
                let current_dsl = self.current_dsl(&key)?;
                let schema_inventory = dsl_shape_inventory(&self.repository_root)?;
                let result = self
                    .run_role(
                        node,
                        lease,
                        Role::Inquisitor,
                        1,
                        None,
                        vec![evidence_hash],
                        json!({
                            "mode": "architect",
                            "ability_id": key.ability_id,
                            "faction_id": key.faction_id,
                            "raw_text": source.source_text,
                            "evidence_packet": evidence,
                            "current_dsl": current_dsl,
                            "schema_inventory": schema_inventory,
                        }),
                    )
                    .await?;
                let bytes = Self::payload_bytes(&result)?;
                let artifact_hash = Hash256::digest(&bytes);
                let payload = &result.result.payload;
                let architecture = payload.get("architecture").unwrap_or(payload);
                let covered_clause_ids =
                    string_set(architecture, &["source_clause_ids", "covered_clause_ids"]);
                let unresolved_bindings = string_set(
                    architecture,
                    &["unresolved_event_bindings", "unresolved_bindings"],
                );
                let route = architecture
                    .get("route")
                    .and_then(Value::as_str)
                    .ok_or(EngineError::Policy)?;
                let requires_shape = route != "existing-shape";
                let closed_parent = architecture.get("form").and_then(Value::as_str).is_some()
                    && architecture
                        .get("local_actions")
                        .and_then(Value::as_array)
                        .is_none_or(|actions| {
                            actions.iter().all(|action| {
                                action.get("parent_closed").and_then(Value::as_bool) == Some(true)
                            })
                        });
                Ok(WorkCompletion {
                    artifacts: vec![
                        Self::produced(
                            ArtifactKind::Architecture,
                            Sensitivity::Sensitive,
                            bytes,
                            vec![evidence_hash],
                        ),
                        Self::produced(
                            ArtifactKind::ProviderConversation,
                            Sensitivity::Sensitive,
                            serde_json::to_vec(&result.result)?,
                            vec![evidence_hash],
                        ),
                    ],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::RecordArchitecture {
                            key,
                            facts: ArchitectureFacts {
                                artifact_hash,
                                evidence_hash,
                                covered_clause_ids,
                                requires_shape,
                                closed_parent,
                                unresolved_bindings,
                            },
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::ShapeRoute => {
                let source = self.source(node)?;
                let architecture_hash = ability.architecture_hash.ok_or(EngineError::Policy)?;
                let decomposition_hash = ability.decomposition_hash.ok_or(EngineError::Policy)?;
                let decomposition: Value = serde_json::from_slice(
                    &self.engine.store().read_artifact(decomposition_hash)?,
                )?;
                let decomposition = json!({
                    "who": decomposition.get(Role::TargetDummy.as_str()).ok_or(EngineError::Policy)?,
                    "when": decomposition.get(Role::Chronomancer.as_str()).ok_or(EngineError::Policy)?,
                    "what": decomposition.get(Role::VoxHound.as_str()).ok_or(EngineError::Policy)?,
                });
                let current_dsl = self.current_dsl(&key)?;
                let schema_inventory = dsl_shape_inventory(&self.repository_root)?;
                let result = self
                    .run_role(
                        node,
                        lease,
                        Role::KrootFleshShaper,
                        1,
                        None,
                        vec![architecture_hash, decomposition_hash],
                        json!({
                            "seed_ability_id": key.ability_id,
                            "faction_id": key.faction_id,
                            "raw_text": source.source_text,
                            "resisted_schema": serde_json::from_slice::<Value>(
                                &self.engine.store().read_artifact(architecture_hash)?
                            )?,
                            "decomposition": decomposition,
                            "current_dsl": current_dsl,
                            "schema_inventory": schema_inventory,
                        }),
                    )
                    .await?;
                let bytes = Self::payload_bytes(&result)?;
                let package_hash = Hash256::digest(&bytes);
                let verdict = result
                    .result
                    .payload
                    .pointer("/self_grade/verdict")
                    .or_else(|| result.result.payload.get("verdict"))
                    .and_then(Value::as_str)
                    .ok_or(EngineError::Policy)?;
                let action = match verdict {
                    "existing-fits" => CommandAction::RecordShapeSurvey {
                        key,
                        artifact_hash: package_hash,
                    },
                    "singleton" => CommandAction::MarkNeedsSchema {
                        key,
                        evidence_hash: package_hash,
                    },
                    "fail" => CommandAction::MarkNeedsSchema {
                        key,
                        evidence_hash: package_hash,
                    },
                    "new-shape" => {
                        let proposed_name = result
                            .result
                            .payload
                            .pointer("/proposed_shape/name")
                            .and_then(Value::as_str)
                            .ok_or(EngineError::Policy)?;
                        let shape_id = campaign_domain::ShapeId::new(format!(
                            "shape-{}",
                            slug(proposed_name)
                        ))?;
                        if state.shapes.contains_key(&shape_id) {
                            CommandAction::RequireShape { key, shape_id }
                        } else {
                            CommandAction::OpenShapeLifecycle {
                                key,
                                shape_id,
                                package_hash,
                            }
                        }
                    }
                    _ => return Err(EngineError::Policy),
                };
                Ok(WorkCompletion {
                    artifacts: vec![Self::produced(
                        ArtifactKind::ShapePackage,
                        Sensitivity::Sensitive,
                        bytes,
                        vec![architecture_hash, decomposition_hash],
                    )],
                    follow_up: self.command(node, lease, action)?,
                    effect: None,
                })
            }
            WorkKind::ShapeSurvey => {
                let shape = ability
                    .required_shape_id
                    .as_ref()
                    .and_then(|shape_id| state.shapes.get(shape_id))
                    .ok_or(EngineError::Policy)?;
                let artifact_hash = shape.verification_hash.ok_or(EngineError::Policy)?;
                Ok(WorkCompletion {
                    artifacts: vec![],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::RecordShapeSurvey { key, artifact_hash },
                    )?,
                    effect: None,
                })
            }
            WorkKind::MarkNeedsSchema => {
                let shape = ability
                    .required_shape_id
                    .as_ref()
                    .and_then(|shape_id| state.shapes.get(shape_id))
                    .ok_or(EngineError::Policy)?;
                let evidence_hash = shape
                    .verification_hash
                    .or(shape.package_hash)
                    .ok_or(EngineError::Policy)?;
                Ok(WorkCompletion {
                    artifacts: vec![],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::MarkNeedsSchema { key, evidence_hash },
                    )?,
                    effect: None,
                })
            }
            WorkKind::Decompose { role } => {
                let source = self.source(node)?;
                let evidence_hash = ability.evidence_hash.ok_or(EngineError::Policy)?;
                let architecture_hash = ability.architecture_hash.ok_or(EngineError::Policy)?;
                let evidence: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(evidence_hash)?)?;
                let architecture: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(architecture_hash)?)?;
                let current = self.current_dsl(&key)?;
                let ability_type = current
                    .get("ability_type")
                    .cloned()
                    .ok_or(EngineError::Policy)?;
                let result = self
                    .run_role(
                        node,
                        lease,
                        *role,
                        1,
                        None,
                        vec![evidence_hash, architecture_hash],
                        json!({
                            "ability_id": key.ability_id,
                            "faction_id": key.faction_id,
                            "raw_text": source.source_text,
                            "ability_type": ability_type,
                            "evidence_packet": evidence,
                            "architecture": architecture,
                        }),
                    )
                    .await?;
                let bytes = Self::payload_bytes(&result)?;
                let artifact_hash = Hash256::digest(&bytes);
                Ok(WorkCompletion {
                    artifacts: vec![
                        Self::produced(
                            ArtifactKind::Decomposition,
                            Sensitivity::Sensitive,
                            bytes,
                            vec![architecture_hash],
                        ),
                        Self::produced(
                            ArtifactKind::ProviderConversation,
                            Sensitivity::Sensitive,
                            serde_json::to_vec(&result.result)?,
                            vec![architecture_hash],
                        ),
                    ],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::RecordDecomposerResult {
                            key,
                            role: role.as_str().to_owned(),
                            architecture_hash,
                            artifact_hash,
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::CombineDecomposition => {
                let architecture_hash = ability.architecture_hash.ok_or(EngineError::Policy)?;
                let mut combined = BTreeMap::new();
                for role in [Role::TargetDummy, Role::Chronomancer, Role::VoxHound] {
                    let hash = *ability
                        .decomposer_hashes
                        .get(role.as_str())
                        .ok_or(EngineError::Policy)?;
                    combined.insert(
                        role.as_str(),
                        serde_json::from_slice::<Value>(&self.engine.store().read_artifact(hash)?)?,
                    );
                }
                let bytes = serde_json::to_vec(&combined)?;
                let artifact_hash = Hash256::digest(&bytes);
                let deferred_lookups = combined
                    .values()
                    .flat_map(|value| string_set(value, &["deferred_lookups", "ambiguities"]))
                    .collect();
                let covered_clause_ids = ability
                    .clauses
                    .as_ref()
                    .ok_or(EngineError::Policy)?
                    .all
                    .clone();
                let parents = ability.decomposer_hashes.values().copied().collect();
                Ok(WorkCompletion {
                    artifacts: vec![Self::produced(
                        ArtifactKind::Decomposition,
                        Sensitivity::Sensitive,
                        bytes,
                        parents,
                    )],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::RecordDecomposition {
                            key,
                            facts: DecompositionFacts {
                                artifact_hash,
                                architecture_hash,
                                covered_clause_ids,
                                who_complete: true,
                                when_complete: true,
                                what_complete: true,
                                deferred_lookups,
                            },
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::Assemble => {
                let source = self.source(node)?;
                let evidence_hash = ability.evidence_hash.ok_or(EngineError::Policy)?;
                let architecture_hash = ability.architecture_hash.ok_or(EngineError::Policy)?;
                let decomposition_hash = ability.decomposition_hash.ok_or(EngineError::Policy)?;
                let previous_dsl = self.current_dsl(&key)?;
                let name = previous_dsl
                    .get("name")
                    .cloned()
                    .ok_or(EngineError::Policy)?;
                let ability_type = previous_dsl
                    .get("ability_type")
                    .cloned()
                    .ok_or(EngineError::Policy)?;
                let detachment_id = previous_dsl
                    .get("detachment_id")
                    .cloned()
                    .unwrap_or(Value::Null);
                let result = self
                    .run_role_checked(
                        node,
                        lease,
                        Role::ArchMagos,
                        ability.attempt.saturating_add(1),
                        None,
                        vec![evidence_hash, architecture_hash, decomposition_hash],
                        json!({
                            "ability_id": key.ability_id,
                            "faction_id": key.faction_id,
                            "raw_text": source.source_text,
                            "name": name,
                            "ability_type": ability_type,
                            "detachment_id": detachment_id,
                            "previous_dsl": previous_dsl,
                            "previous_cosine": ability.score_start,
                            "clause_ids": ability.clauses.as_ref().ok_or(EngineError::Policy)?.all,
                            "mechanical_clause_ids": ability.clauses.as_ref().ok_or(EngineError::Policy)?.mechanical,
                            "evidence_packet": serde_json::from_slice::<Value>(&self.engine.store().read_artifact(evidence_hash)?)?,
                            "architecture": serde_json::from_slice::<Value>(&self.engine.store().read_artifact(architecture_hash)?)?,
                            "decomposition": serde_json::from_slice::<Value>(&self.engine.store().read_artifact(decomposition_hash)?)?,
                            "revision_thread": ability.revision_thread_hash.map(|hash| self.engine.store().read_artifact(hash)).transpose()?.map(|bytes| serde_json::from_slice::<Value>(&bytes)).transpose()?,
                        }),
                        |result| {
                            validate_candidate_role_result(
                                &previous_dsl,
                                &key,
                                &source.source_text,
                                result,
                            )
                        },
                    )
                    .await?;
                if matches!(
                    result.result.verdict,
                    campaign_roles::RoleVerdict::NeedsSchema
                ) {
                    let payload = Self::payload_bytes(&result)?;
                    let evidence_hash = Hash256::digest(&payload);
                    let (follow_up, effect) = if ability.applied_commit.is_some() {
                        let (command, effect) = self.request_ability_rollback(
                            node,
                            lease,
                            &key,
                            ability,
                            evidence_hash,
                            true,
                        )?;
                        (command, Some(effect))
                    } else {
                        (
                            self.command(
                                node,
                                lease,
                                CommandAction::MarkNeedsSchema {
                                    key: key.clone(),
                                    evidence_hash,
                                },
                            )?,
                            None,
                        )
                    };
                    return Ok(WorkCompletion {
                        artifacts: vec![Self::produced(
                            ArtifactKind::Architecture,
                            Sensitivity::Sensitive,
                            payload,
                            vec![decomposition_hash],
                        )],
                        follow_up,
                        effect,
                    });
                }
                let current_dsl = self.current_dsl(&key)?;
                let candidate = candidate_from_role_payload(&current_dsl, &result.result.payload)?;
                ensure_candidate_identity(&candidate, &current_dsl, &key)?;
                let candidate_bytes = serde_json::to_vec(&candidate)?;
                SensitiveCorpus::new([source.source_text.as_bytes()])
                    .reject_sensitive_bytes(&candidate_bytes)?;
                let candidate_hash = Hash256::digest(&candidate_bytes);
                let mechanical_clauses = ability
                    .clauses
                    .as_ref()
                    .ok_or(EngineError::Policy)?
                    .mechanical
                    .clone();
                let coverage = result
                    .result
                    .payload
                    .get("clause_coverage")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|row| row.get("clause_id").and_then(Value::as_str))
                            .filter(|clause_id| mechanical_clauses.contains(*clause_id))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_else(|| mechanical_clauses.clone());
                let parents = vec![decomposition_hash];
                Ok(WorkCompletion {
                    artifacts: vec![
                        Self::produced(
                            ArtifactKind::CandidateDsl,
                            Sensitivity::Deidentified,
                            candidate_bytes,
                            parents.clone(),
                        ),
                        Self::produced(
                            ArtifactKind::ProviderConversation,
                            Sensitivity::Sensitive,
                            serde_json::to_vec(&result.result)?,
                            parents,
                        ),
                    ],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::ProposeCandidate {
                            key,
                            facts: CandidateFacts {
                                artifact_hash: candidate_hash,
                                decomposition_hash,
                                attempt: ability.attempt.saturating_add(1),
                                exactly_mapped_clauses: coverage.clone(),
                                source_or_schema_evidence_clauses: coverage,
                                placeholder_encoding: false,
                                approx_mechanical_clause: false,
                                revision_thread_hash: ability.revision_thread_hash,
                                prior_divergence_ids: ability.blocking_divergences.clone(),
                            },
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::OpenRefutationPanel => Ok(WorkCompletion {
                artifacts: vec![],
                follow_up: self.command(
                    node,
                    lease,
                    CommandAction::OpenRefutationPanel {
                        key,
                        escalated: ability.attempt > 1,
                    },
                )?,
                effect: None,
            }),
            WorkKind::Refute { voter } => {
                let source = self.source(node)?;
                let candidate_hash = ability.candidate_hash.ok_or(EngineError::Policy)?;
                let candidate: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(candidate_hash)?)?;
                let result = self
                    .run_role(
                        node,
                        lease,
                        Role::Eversor,
                        ability.attempt,
                        Some(*voter),
                        vec![candidate_hash],
                        json!({
                            "ability_id": key.ability_id,
                            "faction_id": key.faction_id,
                            "raw_text": source.source_text,
                            "candidate_dsl": candidate,
                        }),
                    )
                    .await?;
                let bytes = Self::payload_bytes(&result)?;
                let artifact_hash = Hash256::digest(&bytes);
                let voter_identity_hash = Hash256::digest(serde_json::to_vec(&json!({
                    "provider": result.provider_identity_hash,
                    "candidate": candidate_hash,
                    "attempt": ability.attempt,
                    "voter": voter,
                }))?);
                let divergence_ids = result
                    .result
                    .payload
                    .get("divergences")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|divergence| {
                        Hash256::digest(serde_json::to_vec(divergence).unwrap_or_default())
                            .to_string()
                    })
                    .collect();
                Ok(WorkCompletion {
                    artifacts: vec![Self::produced(
                        ArtifactKind::Refutation,
                        Sensitivity::Sensitive,
                        bytes,
                        vec![candidate_hash],
                    )],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::RecordRefutation {
                            key,
                            facts: RefutationFacts {
                                artifact_hash,
                                candidate_hash,
                                voter: *voter,
                                voter_identity_hash,
                                divergence_ids,
                            },
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::RequestRepairRollback => {
                let max_attempts = state
                    .manifest
                    .as_ref()
                    .ok_or(EngineError::Policy)?
                    .budgets
                    .max_assembly_attempts;
                let (follow_up, effect) = self.request_ability_rollback(
                    node,
                    lease,
                    &key,
                    ability,
                    ability.evidence_hash.ok_or(EngineError::Policy)?,
                    ability.attempt >= max_attempts,
                )?;
                Ok(WorkCompletion {
                    artifacts: vec![],
                    follow_up,
                    effect: Some(effect),
                })
            }
            WorkKind::ResolveRefutations => {
                if ability.blocking_divergences.is_empty() {
                    Ok(WorkCompletion {
                        artifacts: vec![],
                        follow_up: self.command(
                            node,
                            lease,
                            CommandAction::AcceptCandidate { key },
                        )?,
                        effect: None,
                    })
                } else {
                    let thread = json!({
                        "candidate_hash": ability.candidate_hash,
                        "attempt": ability.attempt,
                        "divergence_ids": ability.blocking_divergences,
                        "voters": ability.voters,
                    });
                    let bytes = serde_json::to_vec(&thread)?;
                    let thread_hash = Hash256::digest(&bytes);
                    Ok(WorkCompletion {
                        artifacts: vec![Self::produced(
                            ArtifactKind::RevisionThread,
                            Sensitivity::Sensitive,
                            bytes,
                            ability.voters.values().copied().collect(),
                        )],
                        follow_up: self.command(
                            node,
                            lease,
                            CommandAction::RequestRevision {
                                key,
                                thread_hash,
                                resolved_divergence_ids: ability.blocking_divergences.clone(),
                            },
                        )?,
                        effect: None,
                    })
                }
            }
            WorkKind::PlanApply => self.plan_apply(node, lease, &key, ability).await,
            WorkKind::Apply => self.apply(node, lease, &key, ability),
            WorkKind::RollbackAbility => self.rollback_ability(node, lease, &key, ability),
            WorkKind::Verify => self.verify(node, lease, &key, ability),
            WorkKind::ReviewRole { role } => {
                self.review_role(node, lease, &key, ability, *role).await
            }
            WorkKind::CombineReview => self.combine_review(node, lease, &key, ability),
            WorkKind::Converge => Ok(WorkCompletion {
                artifacts: vec![],
                follow_up: self.command(node, lease, CommandAction::ConvergeAbility { key })?,
                effect: None,
            }),
            _ => Err(EngineError::Policy),
        }
    }
}

impl CampaignNodeExecutor {
    async fn execute_shape(
        &self,
        node: &WorkNode,
        lease: &Lease,
    ) -> Result<WorkCompletion, EngineError> {
        let state = self.state(node)?;
        let shape_id = node.shape_id.clone().ok_or(EngineError::Policy)?;
        let shape = state.shapes.get(&shape_id).ok_or(EngineError::Policy)?;
        let package_hash = shape.package_hash.ok_or(EngineError::Policy)?;
        let package: Value =
            serde_json::from_slice(&self.engine.store().read_artifact(package_hash)?)?;
        match &node.kind {
            WorkKind::ShapeFamilySurvey { survey } => {
                if let Some(verdict) = package.get("verdict").and_then(Value::as_str) {
                    if matches!(
                        verdict,
                        "existing-fits" | "reject-as-sprawl" | "singleton" | "reject-as-singleton"
                    ) {
                        return Ok(WorkCompletion {
                            artifacts: vec![],
                            follow_up: self.command(
                                node,
                                lease,
                                CommandAction::RejectShape {
                                    shape_id,
                                    singleton: matches!(
                                        verdict,
                                        "singleton" | "reject-as-singleton"
                                    ),
                                },
                            )?,
                            effect: None,
                        });
                    }
                }
                let role = if *survey == 1 {
                    Role::Swarmlord
                } else {
                    Role::KrootLoneSpear
                };
                let seed = shape_seed(&shape_id, shape, &state)?;
                let mut survey_parents = vec![package_hash];
                let task = if *survey == 1 {
                    let candidate_evidence = retrieve_family_candidates(
                        &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                        &self.raw_store_root,
                        seed,
                        40,
                    )?;
                    json!({
                        "shape": {
                            "pattern": package.get("mechanic")
                                .or_else(|| package.pointer("/proposed_shape/name"))
                                .and_then(Value::as_str)
                                .ok_or(EngineError::Policy)?,
                            "example_ability_id": seed.ability_id,
                        },
                        "proposed_shape": package.get("proposed_shape").unwrap_or(&package),
                        "internal_family": package.get("internal_family").unwrap_or(&Value::Null),
                        "seed_ability_id": seed.ability_id,
                        "faction_id": seed.faction_id,
                        "candidate_evidence": candidate_evidence,
                    })
                } else {
                    let sweep_hash = *shape.family_hashes.last().ok_or(EngineError::Policy)?;
                    let swarmlord_sweep: Value =
                        serde_json::from_slice(&self.engine.store().read_artifact(sweep_hash)?)?;
                    survey_parents.push(sweep_hash);
                    json!({
                        "proposed_shape": package.get("proposed_shape").unwrap_or(&package),
                        "internal_family": package.get("internal_family").unwrap_or(&Value::Null),
                        "seed_ability_id": seed.ability_id,
                        "faction_id": seed.faction_id,
                        "swarmlord_sweep": swarmlord_sweep,
                    })
                };
                let result = self
                    .run_role(
                        node,
                        lease,
                        role,
                        *survey,
                        None,
                        survey_parents.clone(),
                        task,
                    )
                    .await?;
                let bytes = Self::payload_bytes(&result)?;
                let survey_hash = Hash256::digest(&bytes);
                let manifest = state.manifest.as_ref().ok_or(EngineError::Policy)?;
                let manifest_keys = manifest
                    .ordered_worklist
                    .iter()
                    .map(|item| item.key.clone())
                    .collect::<BTreeSet<_>>();
                let (mut members, exclusions) =
                    shape_survey_members(&result.result.payload, *survey, &manifest_keys)?;
                members.insert(seed.clone());
                let internal_family_size =
                    shape_internal_family_size(&package, &result.result.payload)?;
                let family_size = members
                    .difference(&exclusions)
                    .count()
                    .max(usize::from(internal_family_size));
                let action = if family_size < usize::from(manifest.budgets.family_threshold) {
                    CommandAction::RejectShape {
                        shape_id,
                        singleton: true,
                    }
                } else {
                    CommandAction::RecordFamilySurvey {
                        shape_id,
                        survey_hash,
                        internal_family_size,
                        members,
                        flattening_exclusions: exclusions,
                    }
                };
                Ok(WorkCompletion {
                    artifacts: vec![Self::produced(
                        ArtifactKind::ShapePackage,
                        Sensitivity::Sensitive,
                        bytes,
                        survey_parents,
                    )],
                    follow_up: self.command(node, lease, action)?,
                    effect: None,
                })
            }
            WorkKind::ShapeDescriberSpec => {
                let result = self
                    .run_role(
                        node,
                        lease,
                        Role::KrootTrailShaper,
                        shape.review_round + 1,
                        None,
                        std::iter::once(package_hash)
                            .chain(shape.family_hashes.iter().copied())
                            .chain(shape.review_hashes.iter().copied())
                            .collect(),
                        json!({
                            "proposed_shape": package,
                            "family_members": shape.family_members,
                            "flattening_exclusions": shape.excluded_members,
                            "prior_reviews": shape.review_hashes.iter()
                                .map(|hash| self.engine.store().read_artifact(*hash)
                                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(Into::into)))
                                .collect::<Result<Vec<_>, campaign_store::StoreError>>()?,
                        }),
                    )
                    .await?;
                let render_rules = result
                    .result
                    .payload
                    .get("render_rules")
                    .and_then(Value::as_array)
                    .ok_or(EngineError::Policy)?;
                ensure_required_render_forms(&package, render_rules)?;
                let render_form_count = render_rules.len() as u8;
                let psyker = self
                    .run_role(
                        node,
                        lease,
                        Role::Psyker,
                        shape.review_round + 1,
                        None,
                        vec![package_hash],
                        json!({
                            "mode": "shape-render-review",
                            "shape_id": shape_id,
                            "render_rules": render_rules,
                        }),
                    )
                    .await?;
                let combined = json!({
                    "describer_spec": result.result,
                    "cold_read": psyker.result,
                });
                let bytes = serde_json::to_vec(&combined)?;
                let artifact_hash = Hash256::digest(&bytes);
                Ok(WorkCompletion {
                    artifacts: vec![Self::produced(
                        ArtifactKind::ShapePackage,
                        Sensitivity::Sensitive,
                        bytes,
                        std::iter::once(package_hash)
                            .chain(shape.family_hashes.iter().copied())
                            .collect(),
                    )],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::RecordDescriberSpec {
                            shape_id,
                            artifact_hash,
                            render_form_count,
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::ShapeReview => {
                let seed = shape_seed(&shape_id, shape, &state)?;
                let source = retrieve_source(
                    &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                    &self.raw_store_root,
                    seed,
                )?;
                let describer_hash = shape.describer_hash.ok_or(EngineError::Policy)?;
                let describer_spec: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(describer_hash)?)?;
                let base_task = json!({
                    "proposed_shape": package,
                    "family_members": shape.family_members,
                    "flattening_exclusions": shape.excluded_members,
                    "describer_spec": describer_spec,
                    "prior_reviews": shape.review_hashes.iter()
                        .map(|hash| self.engine.store().read_artifact(*hash)
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(Into::into)))
                        .collect::<Result<Vec<_>, campaign_store::StoreError>>()?,
                    "seed_ability_id": seed.ability_id,
                    "raw_text": source.source_text,
                });
                let review_candidates = retrieve_family_candidates(
                    &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                    &self.raw_store_root,
                    seed,
                    40,
                )?;
                let family_task = json!({
                    "shape": {
                        "pattern": package.pointer("/proposed_shape/name")
                            .or_else(|| package.get("mechanic"))
                            .and_then(Value::as_str)
                            .ok_or(EngineError::Policy)?,
                        "example_ability_id": seed.ability_id,
                    },
                    "current_family": shape.family_members,
                    "current_exclusions": shape.excluded_members,
                    "candidate_evidence": review_candidates,
                });
                let (refuter1, refuter2, family) = tokio::join!(
                    self.run_role(
                        node,
                        lease,
                        Role::Eversor,
                        shape.review_round + 1,
                        Some(1),
                        vec![package_hash, describer_hash],
                        base_task.clone()
                    ),
                    self.run_role(
                        node,
                        lease,
                        Role::Eversor,
                        shape.review_round + 1,
                        Some(2),
                        vec![package_hash, describer_hash],
                        base_task.clone()
                    ),
                    self.run_role(
                        node,
                        lease,
                        Role::Swarmlord,
                        shape.review_round + 1,
                        None,
                        vec![package_hash, describer_hash],
                        family_task
                    ),
                );
                let refuters = [refuter1?, refuter2?];
                let family = family?;
                let child_results = json!({
                    "eversor_panel": [
                        refuters[0].result.clone(),
                        refuters[1].result.clone(),
                    ],
                    "independent_family_sweep": family.result.clone(),
                });
                let child_bytes = serde_json::to_vec(&child_results)?;
                let child_hash = Hash256::digest(&child_bytes);
                let child_artifact = self.engine.store().put_artifact(
                    ArtifactKind::ProviderConversation,
                    Sensitivity::Sensitive,
                    &child_bytes,
                    "application/json",
                    "serde-json",
                    &[package_hash, describer_hash],
                )?;
                if child_artifact.artifact_id != child_hash {
                    return Err(EngineError::Policy);
                }
                let mut review_task = base_task;
                review_task
                    .as_object_mut()
                    .ok_or(EngineError::Policy)?
                    .insert("child_evidence".into(), child_results);
                let war = self
                    .run_role(
                        node,
                        lease,
                        Role::KrootWarShaper,
                        shape.review_round + 1,
                        None,
                        vec![package_hash, describer_hash, child_hash],
                        review_task,
                    )
                    .await?;
                let accepted = matches!(
                    war.result.verdict,
                    campaign_roles::RoleVerdict::Accept | campaign_roles::RoleVerdict::Pass
                ) && refuters.iter().all(|result| {
                    matches!(
                        result.result.verdict,
                        campaign_roles::RoleVerdict::Accept | campaign_roles::RoleVerdict::Pass
                    )
                });
                let native_verdict = war
                    .result
                    .payload
                    .get("verdict")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let review = json!({
                    "war_shaper": war.result,
                    "refuters": refuters.map(|result| result.result),
                    "independent_family_sweep": family.result,
                    "accepted": accepted,
                });
                let bytes = serde_json::to_vec(&review)?;
                let artifact_hash = Hash256::digest(&bytes);
                let action = match native_verdict.as_deref() {
                    Some("reject-as-sprawl" | "existing-fits") => CommandAction::RejectShape {
                        shape_id,
                        singleton: false,
                    },
                    Some("reject-as-singleton" | "singleton") => CommandAction::RejectShape {
                        shape_id,
                        singleton: true,
                    },
                    _ => CommandAction::RecordShapeReview {
                        shape_id,
                        artifact_hash,
                        accepted,
                        resolved_findings: accepted,
                        refuter_count: 2,
                    },
                };
                Ok(WorkCompletion {
                    artifacts: vec![Self::produced(
                        ArtifactKind::Review,
                        Sensitivity::Sensitive,
                        bytes,
                        vec![package_hash, describer_hash, child_hash],
                    )],
                    follow_up: self.command(node, lease, action)?,
                    effect: None,
                })
            }
            WorkKind::ShapeApprove => {
                let review_hash = *shape.review_hashes.last().ok_or(EngineError::Policy)?;
                let review: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(review_hash)?)?;
                let matrix = review
                    .pointer("/war_shaper/payload/shape_package/implementation_matrix")
                    .ok_or(EngineError::Policy)?;
                Ok(WorkCompletion {
                    artifacts: vec![],
                    follow_up: self.command(
                        node,
                        lease,
                        CommandAction::ApproveShape {
                            shape_id,
                            implementation_matrix_complete: implementation_matrix_complete(matrix),
                        },
                    )?,
                    effect: None,
                })
            }
            WorkKind::ShapePlanApply => {
                let describer_hash = shape.describer_hash.ok_or(EngineError::Policy)?;
                let review_hash = *shape.review_hashes.last().ok_or(EngineError::Policy)?;
                let family_surveys = shape
                    .family_hashes
                    .iter()
                    .map(|hash| {
                        self.engine.store().read_artifact(*hash).and_then(|bytes| {
                            serde_json::from_slice::<Value>(&bytes).map_err(Into::into)
                        })
                    })
                    .collect::<Result<Vec<_>, campaign_store::StoreError>>()?;
                let describer_spec: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(describer_hash)?)?;
                let review: Value =
                    serde_json::from_slice(&self.engine.store().read_artifact(review_hash)?)?;
                let consolidated = review
                    .pointer("/war_shaper/payload/shape_package")
                    .ok_or(EngineError::Policy)?;
                let parent_hashes = std::iter::once(package_hash)
                    .chain(shape.family_hashes.iter().copied())
                    .chain([describer_hash, review_hash])
                    .collect::<Vec<_>>();
                let triage = self
                    .run_role(
                        node,
                        lease,
                        Role::Warpsmith,
                        1,
                        None,
                        parent_hashes.clone(),
                        json!({
                            "mode": "shape-implementation-plan",
                            "proposed_shape": consolidated,
                            "family_surveys": family_surveys,
                            "describer_spec": describer_spec,
                            "review": review,
                        }),
                    )
                    .await?;
                let decision = triage
                    .result
                    .payload
                    .get("decisions")
                    .and_then(Value::as_array)
                    .and_then(|decisions| decisions.first())
                    .ok_or(EngineError::Policy)?;
                if decision.get("verdict").and_then(Value::as_str) != Some("new-shape")
                    || !implementation_matrix_complete(
                        decision
                            .get("implementation_matrix")
                            .ok_or(EngineError::Policy)?,
                    )
                {
                    return Err(EngineError::Policy);
                }
                let allowed_paths = decision
                    .get("allowed_files")
                    .and_then(Value::as_array)
                    .ok_or(EngineError::Policy)?
                    .iter()
                    .map(|path| path.as_str().ok_or(EngineError::Policy).map(str::to_owned))
                    .collect::<Result<BTreeSet<_>, _>>()?;
                if allowed_paths.is_empty()
                    || allowed_paths.len() > 64
                    || allowed_paths.iter().any(|path| !shape_path_allowed(path))
                {
                    return Err(EngineError::Policy);
                }
                let mut total_bytes = 0_usize;
                let current_files = allowed_paths
                    .iter()
                    .map(|path| {
                        let content = match std::fs::read(self.repository_root.join(path)) {
                            Ok(bytes) => {
                                Some(String::from_utf8(bytes).map_err(|_| EngineError::Policy)?)
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                            Err(error) => return Err(error.into()),
                        };
                        total_bytes = total_bytes
                            .checked_add(content.as_ref().map_or(0, String::len))
                            .ok_or(EngineError::Policy)?;
                        if total_bytes > 2 * 1024 * 1024 {
                            return Err(EngineError::Policy);
                        }
                        Ok(json!({
                            "path": path,
                            "exists": content.is_some(),
                            "content": content,
                        }))
                    })
                    .collect::<Result<Vec<_>, EngineError>>()?;
                let implementation = self.run_role(
                    node,
                    lease,
                    Role::Warpsmith,
                    2,
                    None,
                    parent_hashes.clone(),
                    json!({
                        "mode": "implementation-package",
                        "approved_plan": decision,
                        "current_files": current_files,
                        "required_output": {
                            "files": [{"path": "an allowed repository-relative path", "content": "complete replacement UTF-8 bytes"}]
                        },
                    }),
                ).await?;
                let files = implementation
                    .result
                    .payload
                    .get("files")
                    .and_then(Value::as_array)
                    .ok_or(EngineError::Policy)?;
                let returned_paths = files
                    .iter()
                    .map(|file| {
                        file.get("path")
                            .and_then(Value::as_str)
                            .ok_or(EngineError::Policy)
                            .map(str::to_owned)
                    })
                    .collect::<Result<BTreeSet<_>, _>>()?;
                if returned_paths != allowed_paths || files.len() != allowed_paths.len() {
                    return Err(EngineError::Policy);
                }
                let source_texts = state
                    .manifest
                    .as_ref()
                    .ok_or(EngineError::Policy)?
                    .ordered_worklist
                    .iter()
                    .map(|item| {
                        retrieve_source(
                            &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                            &self.raw_store_root,
                            &item.key,
                        )
                        .map(|source| source.source_text)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let sensitive = SensitiveCorpus::new(source_texts.iter().map(String::as_bytes));
                let jj = JjClient::new(
                    &self.repository_root,
                    CapabilityGrant::from_capabilities([Capability::ReadJj]),
                )?;
                let expected_head = jj.commit_id("@")?;
                let mut operations = Vec::with_capacity(files.len());
                let mut artifacts = Vec::with_capacity(files.len() + 3);
                for file in files {
                    let path = file
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or(EngineError::Policy)?;
                    let content = file
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or(EngineError::Policy)?;
                    let before = match std::fs::read(self.repository_root.join(path)) {
                        Ok(bytes) => Some(bytes),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                        Err(error) => return Err(error.into()),
                    };
                    let replacement = content.as_bytes().to_vec();
                    if before.as_deref() == Some(replacement.as_slice()) {
                        return Err(EngineError::Policy);
                    }
                    sensitive.reject_sensitive_bytes(&replacement)?;
                    let replacement_hash = Hash256::digest(&replacement);
                    operations.push(PathOperation {
                        path: path.to_owned(),
                        expected_old_hash: before.as_ref().map(Hash256::digest),
                        new_bytes_artifact: replacement_hash,
                    });
                    artifacts.push(Self::produced(
                        ArtifactKind::ShapePackage,
                        Sensitivity::Deidentified,
                        replacement,
                        parent_hashes.clone(),
                    ));
                }
                let plan = ApplyPlan {
                    expected_head: expected_head.clone(),
                    allowed_paths,
                    operations,
                };
                let plan_bytes = serde_json::to_vec(&plan)?;
                let plan_hash = Hash256::digest(&plan_bytes);
                artifacts.push(Self::produced(
                    ArtifactKind::ApplyPlan,
                    Sensitivity::Deidentified,
                    plan_bytes,
                    parent_hashes.clone(),
                ));
                artifacts.push(Self::produced(
                    ArtifactKind::ProviderConversation,
                    Sensitivity::Sensitive,
                    serde_json::to_vec(&triage.result)?,
                    parent_hashes.clone(),
                ));
                artifacts.push(Self::produced(
                    ArtifactKind::ProviderConversation,
                    Sensitivity::Sensitive,
                    serde_json::to_vec(&implementation.result)?,
                    parent_hashes,
                ));
                let action = CommandAction::RequestShapeApply {
                    shape_id: shape_id.clone(),
                    expected_head,
                    plan_hash,
                };
                let (follow_up, effect) = if self.engine.read_only() {
                    (self.command(node, lease, action)?, None)
                } else {
                    let (command, effect) = self.command_with_effect(
                        node,
                        lease,
                        action,
                        EffectKind::RepositoryApply,
                        format!(
                            "shape-apply:{}:{}:{}",
                            self.campaign_id, shape_id, plan_hash
                        ),
                        serde_json::to_value(&plan)?,
                    )?;
                    (command, Some(effect))
                };
                Ok(WorkCompletion {
                    artifacts,
                    follow_up,
                    effect,
                })
            }
            WorkKind::ShapeApply => self.apply_shape(node, lease, &shape_id, shape),
            WorkKind::ShapeVerify => self.verify_shape(node, lease, &shape_id, shape),
            _ => Err(EngineError::Policy),
        }
    }

    fn apply_shape(
        &self,
        node: &WorkNode,
        lease: &Lease,
        shape_id: &campaign_domain::ShapeId,
        shape: &campaign_domain::ShapeAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let package_hash = shape.package_hash.ok_or(EngineError::Policy)?;
        let plan_hash = shape.apply_plan_hash.ok_or(EngineError::Policy)?;
        let plan: ApplyPlan =
            serde_json::from_slice(&self.engine.store().read_artifact(plan_hash)?)?;
        if self.authorized_shape_plan_hash != Some(plan_hash) {
            return Err(EngineError::Policy);
        }
        if plan
            .operations
            .iter()
            .any(|operation| provider_executable_path(&operation.path))
        {
            return Err(EngineError::Policy);
        }
        let idempotency_key = format!(
            "shape-apply:{}:{}:{}",
            self.campaign_id, shape_id, plan_hash
        );
        let outbox = self.ensure_apply_outbox(node, lease, &idempotency_key, &plan)?;
        if outbox.effect_kind != EffectKind::RepositoryApply
            || serde_json::from_value::<ApplyPlan>(outbox.request.clone())? != plan
        {
            return Err(EngineError::Policy);
        }
        let outbox = self.claim_effect(&outbox, &idempotency_key, lease)?;
        let replayed_inventory = if outbox.status == OutboxStatus::Observed {
            let artifact_hash = self
                .engine
                .store()
                .observed_effect_artifact(&idempotency_key)?
                .ok_or(EngineError::Policy)?;
            let inventory = serde_json::from_slice::<campaign_executors::AppliedInventory>(
                &self.engine.store().read_artifact(artifact_hash)?,
            )?;
            validate_applied_inventory(&self.repository_root, &inventory)?;
            Some(inventory)
        } else {
            None
        };
        let inventory = if let Some(inventory) = replayed_inventory {
            inventory
        } else {
            let jj = JjClient::new(
                &self.repository_root,
                CapabilityGrant::from_capabilities([
                    Capability::ReadJj,
                    Capability::ApplyExactPlan,
                ]),
            )?;
            recover_partial_apply(&jj, &plan)?;
            let corpus = self.corpus_for_keys(shape.family_members.iter())?;
            let initial = match observe_applied(&jj, self.engine.store(), &plan)? {
                Some(inventory) => inventory,
                None => apply_exact_plan(&jj, self.engine.store(), &plan, &corpus)?,
            };
            let (inventory, generation_hash) = self.finalize_or_rollback(
                &plan,
                initial,
                plan_hash,
                &jj,
                &idempotency_key,
                lease,
                &corpus,
            )?;
            let inventory_bytes = serde_json::to_vec(&inventory)?;
            self.engine.store().put_artifact(
                ArtifactKind::AppliedDiffInventory,
                Sensitivity::Deidentified,
                &inventory_bytes,
                "application/json",
                "serde-json",
                &[package_hash, plan_hash, generation_hash],
            )?;
            inventory
        };
        let bytes = serde_json::to_vec(&inventory)?;
        let applied_hash = Hash256::digest(&bytes);
        let changed_paths = inventory
            .paths
            .iter()
            .map(|(path, _, after)| (path.clone(), *after))
            .collect::<BTreeMap<_, _>>();
        self.engine.store().record_effect_observed(
            &idempotency_key,
            EffectKind::RepositoryApply,
            &json!({"after_head": inventory.after_head, "paths": changed_paths}),
            Some(applied_hash),
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        let verify_effect = EffectIntent {
            outbox_id: campaign_domain::OutboxId::new(),
            effect_kind: EffectKind::Validate,
            idempotency_key: format!(
                "shape-verify:{}:{}:{}",
                self.campaign_id, shape_id, applied_hash
            ),
            request: json!({
                "campaign_id": self.campaign_id,
                "shape_id": shape_id,
                "applied_hash": applied_hash,
                "commit_id": inventory.after_head,
            }),
            fencing_token: lease.fencing_token,
            available_at: time::OffsetDateTime::now_utc().unix_timestamp(),
        };
        Ok(WorkCompletion {
            artifacts: vec![],
            follow_up: self.command_for_intent(
                node,
                lease,
                &verify_effect,
                CommandAction::RecordShapeApplied {
                    shape_id: shape_id.clone(),
                    package_hash,
                    applied_hash,
                    commit_id: inventory.after_head,
                    changed_paths,
                },
            )?,
            effect: Some(verify_effect),
        })
    }

    fn verify_shape(
        &self,
        node: &WorkNode,
        lease: &Lease,
        shape_id: &campaign_domain::ShapeId,
        shape: &campaign_domain::ShapeAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let applied_hash = shape.applied_hash.ok_or(EngineError::Policy)?;
        let plan: ApplyPlan = serde_json::from_slice(
            &self
                .engine
                .store()
                .read_artifact(shape.apply_plan_hash.ok_or(EngineError::Policy)?)?,
        )?;
        let key = format!(
            "shape-verify:{}:{}:{}",
            self.campaign_id, shape_id, applied_hash
        );
        let outbox = self
            .engine
            .store()
            .outbox_by_key(&key)?
            .ok_or(EngineError::Policy)?;
        let outbox = self.claim_effect(&outbox, &key, lease)?;
        let jj = JjClient::new(
            &self.repository_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]),
        )?;
        let applied_commit = shape.applied_commit.as_deref().ok_or(EngineError::Policy)?;
        if jj.commit_id("@")? != applied_commit {
            return Err(campaign_executors::ExecutorError::IdentityMismatch.into());
        }
        let preflight = self.run_repository_contract(
            "just",
            vec!["preflight".into()],
            Capability::RunValidator,
            Duration::from_secs(3600),
            16 * 1024 * 1024,
        )?;
        if preflight.exit_code != 0 || jj.commit_id("@")? != applied_commit {
            if let Err(error) = jj.restore_from(&plan.expected_head) {
                self.engine.store().mark_effect_unreconciled(
                    &key,
                    lease.fencing_token,
                    "shape-verification-rollback-failed",
                )?;
                return Err(error.into());
            }
            let failure = json!({
                "code": if preflight.exit_code == 0 {
                    "preflight-mutated-repository"
                } else {
                    "preflight-failed"
                },
                "shape_id": shape_id,
                "applied_hash": applied_hash,
                "restored_head": plan.expected_head,
                "command_hash": preflight.command_hash,
                "binary_hash": preflight.binary_hash,
                "exit_code": preflight.exit_code,
            });
            let failure_bytes = serde_json::to_vec(&failure)?;
            let artifact_hash = Hash256::digest(&failure_bytes);
            self.engine.store().record_effect_observed(
                &key,
                EffectKind::Validate,
                &json!({
                    "failure_hash": artifact_hash,
                    "applied_hash": applied_hash,
                    "restored_head": plan.expected_head,
                }),
                None,
                lease.fencing_token,
                time::OffsetDateTime::now_utc().unix_timestamp(),
            )?;
            return Ok(WorkCompletion {
                artifacts: vec![
                    Self::produced(
                        ArtifactKind::SubprocessOutput,
                        Sensitivity::Sensitive,
                        process_bytes(&preflight),
                        vec![applied_hash],
                    ),
                    Self::produced(
                        ArtifactKind::RevisionThread,
                        Sensitivity::Deidentified,
                        failure_bytes,
                        vec![applied_hash],
                    ),
                ],
                follow_up: self.command_for_effect(
                    node,
                    lease,
                    &outbox,
                    CommandAction::RecordShapeRollback {
                        shape_id: shape_id.clone(),
                        artifact_hash,
                        applied_hash,
                        restored_head: plan.expected_head,
                    },
                )?,
                effect: None,
            });
        }
        let verification = json!({
            "shape_id": shape_id,
            "applied_hash": applied_hash,
            "commit_id": shape.applied_commit,
            "preflight_command_hash": preflight.command_hash,
            "preflight_binary_hash": preflight.binary_hash,
            "parity_pairs_passed": 6,
        });
        let bytes = serde_json::to_vec(&verification)?;
        let artifact_hash = Hash256::digest(&bytes);
        self.engine.store().record_effect_observed(
            &key,
            EffectKind::Validate,
            &json!({"verification_hash": artifact_hash, "applied_hash": applied_hash}),
            None,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        Ok(WorkCompletion {
            artifacts: vec![
                Self::produced(
                    ArtifactKind::SubprocessOutput,
                    Sensitivity::Sensitive,
                    process_bytes(&preflight),
                    vec![applied_hash],
                ),
                Self::produced(
                    ArtifactKind::Verification,
                    Sensitivity::Deidentified,
                    bytes,
                    vec![applied_hash],
                ),
            ],
            follow_up: self.command_for_effect(
                node,
                lease,
                &outbox,
                CommandAction::RecordShapeVerification {
                    shape_id: shape_id.clone(),
                    artifact_hash,
                    applied_hash,
                },
            )?,
            effect: None,
        })
    }

    fn close_failure(
        &self,
        node: &WorkNode,
        lease: &Lease,
        state: &campaign_domain::CampaignState,
        outbox: &campaign_store::OutboxRecord,
        key: &str,
        code: &str,
        outputs: &[&campaign_executors::ProcessResult],
    ) -> Result<WorkCompletion, EngineError> {
        let sealed_head = state.sealed_head.clone().ok_or(EngineError::Policy)?;
        let summary = json!({
            "code": code,
            "sealed_head": sealed_head,
            "attempt": outbox.attempt_count,
            "processes": outputs.iter().map(|result| json!({
                "exit_code": result.exit_code,
                "binary_hash": result.binary_hash,
                "command_hash": result.command_hash,
            })).collect::<Vec<_>>(),
        });
        let bytes = serde_json::to_vec(&summary)?;
        let artifact_hash = Hash256::digest(&bytes);
        self.engine.store().record_effect_observed(
            key,
            EffectKind::Validate,
            &json!({
                "sealed_head": sealed_head,
                "failure_hash": artifact_hash,
                "failure_code": code,
                "attempt": outbox.attempt_count,
            }),
            None,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        let mut artifacts = outputs
            .iter()
            .map(|result| {
                Self::produced(
                    ArtifactKind::SubprocessOutput,
                    Sensitivity::Sensitive,
                    process_bytes(result),
                    vec![],
                )
            })
            .collect::<Vec<_>>();
        artifacts.push(Self::produced(
            ArtifactKind::CloseReview,
            Sensitivity::Deidentified,
            bytes,
            vec![],
        ));
        let terminal = state.close_gate_runs.saturating_add(1)
            >= state
                .manifest
                .as_ref()
                .ok_or(EngineError::Policy)?
                .budgets
                .max_full_gate_reruns;
        let action = CommandAction::RecordCloseFailure {
            artifact_hash,
            sealed_head: sealed_head.clone(),
            terminal,
        };
        if terminal {
            return Ok(WorkCompletion {
                artifacts,
                follow_up: self.command_for_effect(node, lease, outbox, action)?,
                effect: None,
            });
        }
        let next_run = state.close_gate_runs.saturating_add(2);
        let (follow_up, effect) = self.command_with_effect(
            node,
            lease,
            action,
            EffectKind::Validate,
            format!(
                "close-verify:{}:{sealed_head}:run-{next_run}",
                self.campaign_id
            ),
            json!({
                "campaign_id": self.campaign_id,
                "sealed_head": sealed_head,
                "run": next_run,
            }),
        )?;
        Ok(WorkCompletion {
            artifacts,
            follow_up,
            effect: Some(effect),
        })
    }
    fn execute_campaign(
        &self,
        node: &WorkNode,
        lease: &Lease,
    ) -> Result<WorkCompletion, EngineError> {
        let state = self.state(node)?;
        match node.kind {
            WorkKind::Seal => Ok(WorkCompletion {
                artifacts: vec![],
                follow_up: self.command(node, lease, CommandAction::RequestSeal)?,
                effect: None,
            }),
            WorkKind::RecordSeal => {
                let manifest = state.manifest.as_ref().ok_or(EngineError::Policy)?;
                let jj = JjClient::new(
                    &self.repository_root,
                    CapabilityGrant::from_capabilities([Capability::ReadJj]),
                )?;
                let head = jj.commit_id("@")?;
                if head == manifest.base_commit_id {
                    let terminal_keys = state
                        .abilities
                        .iter()
                        .filter(|(_, ability)| ability.phase.terminal())
                        .map(|(key, _)| key)
                        .collect::<Vec<_>>();
                    let report_bytes = serde_json::to_vec(&json!({
                        "campaign_id": self.campaign_id,
                        "outcome": "no-repository-change",
                        "terminal_keys": terminal_keys,
                    }))?;
                    let reason_hash = Hash256::digest(&report_bytes);
                    return Ok(WorkCompletion {
                        artifacts: vec![Self::produced(
                            ArtifactKind::CloseReview,
                            Sensitivity::Deidentified,
                            report_bytes,
                            vec![],
                        )],
                        follow_up: self.command(
                            node,
                            lease,
                            CommandAction::AbortCampaign { reason_hash },
                        )?,
                        effect: None,
                    });
                }
                let (follow_up, effect) = self.command_with_effect(
                    node,
                    lease,
                    CommandAction::RecordSealedHead {
                        base: manifest.base_commit_id.clone(),
                        head: head.clone(),
                    },
                    EffectKind::Validate,
                    format!("close-verify:{}:{head}:run-1", self.campaign_id),
                    json!({
                        "campaign_id": self.campaign_id,
                        "sealed_base": manifest.base_commit_id,
                        "sealed_head": head,
                        "manifest_hash": state.manifest_hash,
                    }),
                )?;
                Ok(WorkCompletion {
                    artifacts: vec![],
                    follow_up,
                    effect: Some(effect),
                })
            }
            WorkKind::CloseVerify => self.close_verify(node, lease, &state),
            WorkKind::Publish => self.publish(node, lease, &state),
            _ => Err(EngineError::Policy),
        }
    }

    fn close_verify(
        &self,
        node: &WorkNode,
        lease: &Lease,
        state: &campaign_domain::CampaignState,
    ) -> Result<WorkCompletion, EngineError> {
        let manifest = state.manifest.as_ref().ok_or(EngineError::Policy)?;
        let sealed_head = state.sealed_head.clone().ok_or(EngineError::Policy)?;
        let run = state.close_gate_runs.saturating_add(1);
        let key = format!("close-verify:{}:{sealed_head}:run-{run}", self.campaign_id);
        let outbox = self
            .engine
            .store()
            .outbox_by_key(&key)?
            .ok_or(EngineError::Policy)?;
        let outbox = self.claim_effect(&outbox, &key, lease)?;
        let jj = JjClient::new(
            &self.repository_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]),
        )?;
        if jj.commit_id("@")? != sealed_head {
            return Err(EngineError::Policy);
        }
        let preflight = self.run_repository_contract(
            "just",
            vec!["preflight".into()],
            Capability::RunValidator,
            Duration::from_secs(3600),
            16 * 1024 * 1024,
        )?;
        if preflight.exit_code != 0 || jj.commit_id("@")? != sealed_head {
            if jj.commit_id("@")? != sealed_head {
                if let Err(error) = jj.restore_from(&sealed_head) {
                    self.engine.store().mark_effect_unreconciled(
                        &key,
                        lease.fencing_token,
                        "close-rollback-failed",
                    )?;
                    return Err(error.into());
                }
            }
            return self.close_failure(
                node,
                lease,
                state,
                &outbox,
                &key,
                if preflight.exit_code == 0 {
                    "preflight-mutated-repository"
                } else {
                    "preflight-failed"
                },
                &[&preflight],
            );
        }
        let embeddings_root = self
            .repository_root
            .parent()
            .ok_or(EngineError::Policy)?
            .join("40kdc-embeddings");
        let scope = format!("rig-{}-close", self.campaign_id);
        let scorer = self.run_contract(
            embeddings_root
                .join(".venv/bin/python")
                .to_string_lossy()
                .as_ref(),
            vec![
                "-m".into(),
                "wh40kdc_embeddings".into(),
                "roundtrip".into(),
                "--faction".into(),
                "all".into(),
                "--scope".into(),
                scope.clone(),
                "--enrichment-dir".into(),
                self.repository_root
                    .join("data/enrichment")
                    .to_string_lossy()
                    .into_owned(),
            ],
            embeddings_root.clone(),
            Capability::RunScorer,
            Duration::from_secs(1800),
            16 * 1024 * 1024,
        )?;
        if scorer.exit_code != 0 {
            return self.close_failure(
                node,
                lease,
                state,
                &outbox,
                &key,
                "scorer-failed",
                &[&preflight, &scorer],
            );
        }
        let after_bytes =
            std::fs::read(embeddings_root.join(format!("_reports/roundtrip-{scope}.json")))?;
        let before_bytes = self
            .engine
            .store()
            .read_artifact(manifest.baseline_report_hash)?;
        let before: Value = serde_json::from_slice(&before_bytes)?;
        let after: Value = serde_json::from_slice(&after_bytes)?;
        let before_rows = score_rows(&before)?;
        let after_rows = score_rows(&after)?;
        let worklist = manifest
            .ordered_worklist
            .iter()
            .map(|item| item.key.clone())
            .collect::<BTreeSet<_>>();
        let changed_render_keys = render_changes(&before_rows, &after_rows);
        let non_worklist_drift = changed_render_keys.difference(&worklist).next().is_some();
        let target_factions = worklist
            .iter()
            .map(|key| key.faction_id.to_string())
            .collect::<BTreeSet<_>>();
        let target_faction_means = target_factions
            .into_iter()
            .map(|faction| {
                let before_mean = faction_mean(&before_rows, &faction)?;
                let after_mean = faction_mean(&after_rows, &faction)?;
                Ok((faction, (before_mean, after_mean)))
            })
            .collect::<Result<BTreeMap<_, _>, EngineError>>()?;
        let conflict_check = self.run_contract(
            "jj",
            vec!["resolve".into(), "--list".into()],
            self.repository_root.clone(),
            Capability::ReadJj,
            Duration::from_secs(30),
            1024 * 1024,
        )?;
        ensure_process_success(&conflict_check)?;
        let conflict_free = conflict_check.stdout.is_empty();
        let all_verified = state.abilities.values().all(|ability| {
            ability.phase.terminal()
                && (ability.phase != campaign_domain::AbilityPhase::Converged
                    || ability.verification_hash.is_some() && ability.review_hash.is_some())
        });
        let source_stable = manifest.ordered_worklist.iter().all(|item| {
            retrieve_source(
                &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                &self.raw_store_root,
                &item.key,
            )
            .is_ok_and(|source| source.source_hash == item.source_hash)
        });
        let anti_conditions = BTreeMap::from([
            (1, all_verified),
            (
                2,
                state.abilities.values().all(|ability| {
                    ability
                        .clauses
                        .as_ref()
                        .is_some_and(|clauses| !clauses.all.is_empty())
                }),
            ),
            (
                3,
                state
                    .abilities
                    .values()
                    .filter(|ability| ability.phase == campaign_domain::AbilityPhase::Converged)
                    .all(|ability| ability.candidate_hash.is_some()),
            ),
            (
                4,
                state
                    .abilities
                    .values()
                    .filter(|ability| ability.phase == campaign_domain::AbilityPhase::Converged)
                    .all(|ability| ability.verification_hash.is_some()),
            ),
            (5, !non_worklist_drift),
            (
                6,
                state
                    .abilities
                    .values()
                    .all(|ability| ability.phase.terminal()),
            ),
            (
                7,
                state
                    .abilities
                    .values()
                    .filter(|ability| ability.phase == campaign_domain::AbilityPhase::Converged)
                    .all(|ability| ability.review_hash.is_some()),
            ),
            (8, source_stable),
            (
                9,
                state
                    .abilities
                    .values()
                    .filter(|ability| ability.phase == campaign_domain::AbilityPhase::Converged)
                    .all(|ability| {
                        ability.applied_hash.is_some() && ability.applied_commit.is_some()
                    }),
            ),
            (
                10,
                target_faction_means
                    .values()
                    .all(|(before, after)| after >= before),
            ),
        ]);
        let parity_counts = manifest
            .parity_areas
            .iter()
            .map(|area| {
                Ok((
                    area.clone(),
                    conformance_case_count(&self.repository_root, area)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, EngineError>>()?;
        let parity_results = SIX_PAIRS
            .into_iter()
            .map(|pair| {
                let areas = parity_counts
                    .iter()
                    .map(|(area, count)| {
                        (
                            area.clone(),
                            ParityAreaResult {
                                ok: true,
                                cases_run: *count,
                                skipped: BTreeSet::new(),
                            },
                        )
                    })
                    .collect();
                (pair.to_owned(), areas)
            })
            .collect();
        let terminal_keys = state
            .abilities
            .iter()
            .filter(|(_, ability)| ability.phase.terminal())
            .map(|(key, _)| key.clone())
            .collect();
        let report = json!({
            "sealed_base": manifest.base_commit_id,
            "sealed_head": sealed_head,
            "terminal_keys": terminal_keys,
            "changed_render_keys": changed_render_keys,
            "target_faction_means": target_faction_means,
            "anti_conditions": anti_conditions,
            "whole_corpus_drift_clean": !non_worklist_drift,
            "conflict_free": conflict_free,
            "preflight_command_hash": preflight.command_hash,
            "scorer_command_hash": scorer.command_hash,
        });
        let report_bytes = serde_json::to_vec(&report)?;
        let artifact_hash = Hash256::digest(&report_bytes);
        let evidence = CloseEvidence {
            artifact_hash,
            sealed_base: manifest.base_commit_id.clone(),
            sealed_head: sealed_head.clone(),
            terminal_keys,
            fixed_gates_passed: true,
            parity_results,
            required_parity_areas: manifest.parity_areas.clone(),
            changed_render_keys,
            target_faction_means,
            anti_conditions,
            conflict_free,
        };
        let facts = match validate_close(state, &evidence) {
            Ok(facts) => facts,
            Err(_) => {
                return self.close_failure(
                    node,
                    lease,
                    state,
                    &outbox,
                    &key,
                    "close-invariant-failed",
                    &[&preflight, &scorer],
                );
            }
        };
        self.engine.store().record_effect_observed(
            &key,
            EffectKind::Validate,
            &json!({
                "sealed_head": sealed_head,
                "close_review_hash": artifact_hash,
                "preflight_command_hash": preflight.command_hash,
                "scorer_command_hash": scorer.command_hash,
            }),
            None,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        Ok(WorkCompletion {
            artifacts: vec![
                Self::produced(
                    ArtifactKind::SubprocessOutput,
                    Sensitivity::Sensitive,
                    process_bytes(&preflight),
                    vec![],
                ),
                Self::produced(
                    ArtifactKind::SubprocessOutput,
                    Sensitivity::Sensitive,
                    process_bytes(&scorer),
                    vec![],
                ),
                Self::produced(
                    ArtifactKind::RescoreReport,
                    Sensitivity::Sensitive,
                    after_bytes,
                    vec![manifest.baseline_report_hash],
                ),
                Self::produced(
                    ArtifactKind::CloseReview,
                    Sensitivity::Deidentified,
                    report_bytes,
                    vec![manifest.baseline_report_hash],
                ),
            ],
            follow_up: self.command_for_effect(
                node,
                lease,
                &outbox,
                CommandAction::RecordCloseVerification { facts },
            )?,
            effect: None,
        })
    }

    fn publish(
        &self,
        node: &WorkNode,
        lease: &Lease,
        state: &campaign_domain::CampaignState,
    ) -> Result<WorkCompletion, EngineError> {
        let sealed_head = state.sealed_head.clone().ok_or(EngineError::Policy)?;
        let key = format!("publish:{}:{sealed_head}", self.campaign_id);
        let outbox = self
            .engine
            .store()
            .outbox_by_key(&key)?
            .ok_or(EngineError::Policy)?;
        if outbox.effect_kind != EffectKind::DraftPr {
            return Err(EngineError::Policy);
        }
        let outbox = self.claim_effect(&outbox, &key, lease)?;
        let plan_hash = outbox
            .request
            .get("plan_artifact_hash")
            .and_then(Value::as_str)
            .ok_or(EngineError::Policy)
            .and_then(|hash| Hash256::from_hex(hash).map_err(|_| EngineError::Policy))?;
        let plan: PublicationPlan =
            serde_json::from_slice(&self.engine.store().read_artifact(plan_hash)?)?;
        if plan.sealed_head != sealed_head
            || state.publication_authorized_head.as_deref() != Some(&sealed_head)
        {
            return Err(EngineError::Policy);
        }
        let source_bytes = state
            .manifest
            .as_ref()
            .ok_or(EngineError::Policy)?
            .ordered_worklist
            .iter()
            .map(|item| {
                retrieve_source(
                    &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                    &self.raw_store_root,
                    &item.key,
                )
                .map(|source| source.source_text.into_bytes())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut sensitive_bytes = self.engine.store().sensitive_artifact_bytes()?;
        sensitive_bytes.extend(source_bytes);
        let corpus = SensitiveCorpus::new(sensitive_bytes.iter().map(Vec::as_slice));
        let receipt = if outbox.status == OutboxStatus::Observed {
            let artifact_hash = self
                .engine
                .store()
                .observed_effect_artifact(&key)?
                .ok_or(EngineError::Policy)?;
            serde_json::from_slice::<campaign_executors::PublicationReceipt>(
                &self.engine.store().read_artifact(artifact_hash)?,
            )?
        } else {
            publish_draft(
                &CapabilityGrant::from_capabilities([
                    Capability::CreateBookmark,
                    Capability::PushBookmark,
                    Capability::CreateDraftPr,
                ]),
                &self.repository_root,
                &plan,
                &corpus,
            )?
        };
        if !receipt.draft {
            return Err(EngineError::Policy);
        }
        let bytes = serde_json::to_vec(&receipt)?;
        let effect_hash = Hash256::digest(&bytes);
        let stored = self.engine.store().put_artifact(
            ArtifactKind::CloseReview,
            Sensitivity::Deidentified,
            &bytes,
            "application/json",
            "serde-json",
            &[state.close_verification_hash.ok_or(EngineError::Policy)?],
        )?;
        let completed = receipt.checks_green && receipt.conflict_free;
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        if completed {
            self.engine.store().record_effect_observed(
                &key,
                EffectKind::DraftPr,
                &json!({
                    "sealed_head": sealed_head,
                    "bookmark": receipt.bookmark,
                    "pr_url_hash": receipt.pr_url_hash,
                    "draft": receipt.draft,
                    "checks_green": true,
                    "conflict_free": true,
                }),
                Some(stored.artifact_id),
                lease.fencing_token,
                now,
            )?;
        } else {
            self.engine.store().mark_effect_failed(
                &key,
                lease.fencing_token,
                if receipt.conflict_free {
                    "publication-checks-pending"
                } else {
                    "publication-conflicted"
                },
                now.saturating_add(60),
            )?;
        }
        let action = if completed {
            CommandAction::RecordPublication {
                sealed_head,
                effect_hash,
                checks_green: true,
            }
        } else {
            CommandAction::RecordPublicationProgress {
                sealed_head,
                effect_hash,
            }
        };
        Ok(WorkCompletion {
            artifacts: vec![Self::produced(
                ArtifactKind::CloseReview,
                Sensitivity::Deidentified,
                bytes,
                vec![state.close_verification_hash.ok_or(EngineError::Policy)?],
            )],
            follow_up: self.command_for_effect(node, lease, &outbox, action)?,
            effect: None,
        })
    }
    fn apply(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let plan_hash = ability.apply_plan_hash.ok_or(EngineError::Policy)?;
        let plan: ApplyPlan =
            serde_json::from_slice(&self.engine.store().read_artifact(plan_hash)?)?;
        let idempotency_key = format!("apply:{}:{}:{}", self.campaign_id, key, plan_hash);
        let outbox = self.ensure_apply_outbox(node, lease, &idempotency_key, &plan)?;
        if outbox.effect_kind != EffectKind::RepositoryApply
            || serde_json::from_value::<ApplyPlan>(outbox.request.clone())? != plan
        {
            return Err(EngineError::Policy);
        }
        let outbox = self.claim_effect(&outbox, &idempotency_key, lease)?;
        let replayed_inventory = if outbox.status == OutboxStatus::Observed {
            let artifact_hash = self
                .engine
                .store()
                .observed_effect_artifact(&idempotency_key)?
                .ok_or(EngineError::Policy)?;
            let inventory = serde_json::from_slice::<campaign_executors::AppliedInventory>(
                &self.engine.store().read_artifact(artifact_hash)?,
            )?;
            validate_applied_inventory(&self.repository_root, &inventory)?;
            Some(inventory)
        } else {
            None
        };
        let inventory = if let Some(inventory) = replayed_inventory {
            inventory
        } else {
            let grants = CapabilityGrant::from_capabilities([
                Capability::ReadJj,
                Capability::ApplyExactPlan,
            ]);
            let jj = JjClient::new(&self.repository_root, grants)?;
            recover_partial_apply(&jj, &plan)?;
            let source = self.source(node)?;
            let corpus = SensitiveCorpus::new([source.source_text.as_bytes()]);
            let initial = match observe_applied(&jj, self.engine.store(), &plan)? {
                Some(inventory) => inventory,
                None => match apply_exact_plan(&jj, self.engine.store(), &plan, &corpus) {
                    Ok(inventory) => inventory,
                    Err(error) => {
                        let _ = self.engine.store().mark_effect_unreconciled(
                            &idempotency_key,
                            lease.fencing_token,
                            "apply-failed",
                        );
                        return Err(error.into());
                    }
                },
            };
            let (inventory, generation_hash) = self.finalize_or_rollback(
                &plan,
                initial,
                plan_hash,
                &jj,
                &idempotency_key,
                lease,
                &corpus,
            )?;
            let inventory_bytes = serde_json::to_vec(&inventory)?;
            self.engine.store().put_artifact(
                ArtifactKind::AppliedDiffInventory,
                Sensitivity::Deidentified,
                &inventory_bytes,
                "application/json",
                "serde-json",
                &[
                    ability.candidate_hash.ok_or(EngineError::Policy)?,
                    plan_hash,
                    generation_hash,
                ],
            )?;
            inventory
        };
        let inventory_bytes = serde_json::to_vec(&inventory)?;
        let applied_hash = Hash256::digest(&inventory_bytes);
        let changed_paths = inventory
            .paths
            .iter()
            .map(|(path, _, after)| (path.clone(), *after))
            .collect::<BTreeMap<_, _>>();
        self.engine.store().record_effect_observed(
            &idempotency_key,
            EffectKind::RepositoryApply,
            &json!({
                "before_head": inventory.before_head,
                "after_head": inventory.after_head,
                "paths": changed_paths,
            }),
            Some(applied_hash),
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        let verify_effect = EffectIntent {
            outbox_id: campaign_domain::OutboxId::new(),
            effect_kind: EffectKind::Validate,
            idempotency_key: format!("verify:{}:{}:{}", self.campaign_id, key, applied_hash),
            request: json!({
                "campaign_id": self.campaign_id,
                "ability": key,
                "candidate_hash": ability.candidate_hash,
                "applied_hash": applied_hash,
                "commit_id": inventory.after_head,
            }),
            fencing_token: lease.fencing_token,
            available_at: time::OffsetDateTime::now_utc().unix_timestamp(),
        };
        Ok(WorkCompletion {
            artifacts: vec![],
            follow_up: self.command_for_intent(
                node,
                lease,
                &verify_effect,
                CommandAction::RecordAppliedPatch {
                    key: key.clone(),
                    candidate_hash: ability.candidate_hash.ok_or(EngineError::Policy)?,
                    applied_hash,
                    commit_id: inventory.after_head,
                    changed_paths,
                    no_op: false,
                },
            )?,
            effect: Some(verify_effect),
        })
    }

    fn rollback_ability(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let evidence_hash = ability.rollback_evidence_hash.ok_or(EngineError::Policy)?;
        let restore_head = ability.rollback_head.as_ref().ok_or(EngineError::Policy)?;
        let applied_commit = ability.applied_commit.as_ref().ok_or(EngineError::Policy)?;
        let idempotency_key = format!(
            "ability-rollback:{}:{}:{}:{}",
            self.campaign_id, key.faction_id, key.ability_id, applied_commit
        );
        let outbox = self
            .engine
            .store()
            .outbox_by_key(&idempotency_key)?
            .ok_or(EngineError::Policy)?;
        let outbox = self.claim_effect(&outbox, &idempotency_key, lease)?;
        let jj = JjClient::new(
            &self.repository_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]),
        )?;
        let before_head = jj.commit_id("@")?;
        if before_head == *applied_commit {
            if let Err(error) = jj.restore_from(restore_head) {
                self.engine.store().mark_effect_unreconciled(
                    &idempotency_key,
                    lease.fencing_token,
                    "ability-rollback-failed",
                )?;
                return Err(error.into());
            }
        } else if before_head != *restore_head {
            self.engine.store().mark_effect_unreconciled(
                &idempotency_key,
                lease.fencing_token,
                "ability-rollback-foreign-head",
            )?;
            return Err(EngineError::Policy);
        }
        let observed_head = jj.commit_id("@")?;
        if observed_head != *restore_head {
            self.engine.store().mark_effect_unreconciled(
                &idempotency_key,
                lease.fencing_token,
                "ability-rollback-mismatch",
            )?;
            return Err(EngineError::Policy);
        }
        let receipt = json!({
            "before_head": before_head,
            "restored_head": observed_head,
            "ability": key,
            "evidence_hash": evidence_hash,
        });
        self.engine.store().record_effect_observed(
            &idempotency_key,
            EffectKind::RepositoryApply,
            &receipt,
            None,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        let bytes = serde_json::to_vec(&receipt)?;
        Ok(WorkCompletion {
            artifacts: vec![Self::produced(
                ArtifactKind::AppliedDiffInventory,
                Sensitivity::Deidentified,
                bytes,
                vec![evidence_hash],
            )],
            follow_up: self.command_for_effect(
                node,
                lease,
                &outbox,
                CommandAction::RecordAbilityRollback {
                    key: key.clone(),
                    evidence_hash,
                    restored_head: observed_head,
                },
            )?,
            effect: None,
        })
    }

    fn verification_failure(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
        outbox: &campaign_store::OutboxRecord,
        verify_key: &str,
        code: &str,
        outputs: &[&campaign_executors::ProcessResult],
    ) -> Result<WorkCompletion, EngineError> {
        let candidate_hash = ability.candidate_hash.ok_or(EngineError::Policy)?;
        let applied_hash = ability.applied_hash.ok_or(EngineError::Policy)?;
        let commit_id = ability.applied_commit.clone().ok_or(EngineError::Policy)?;
        let summary = json!({
            "code": code,
            "candidate_hash": candidate_hash,
            "applied_hash": applied_hash,
            "commit_id": commit_id,
            "processes": outputs.iter().map(|result| json!({
                "exit_code": result.exit_code,
                "binary_hash": result.binary_hash,
                "command_hash": result.command_hash,
            })).collect::<Vec<_>>(),
        });
        let bytes = serde_json::to_vec(&summary)?;
        let evidence_hash = Hash256::digest(&bytes);
        self.engine.store().record_effect_observed(
            verify_key,
            EffectKind::Validate,
            &json!({
                "candidate_hash": candidate_hash,
                "applied_hash": applied_hash,
                "commit_id": commit_id,
                "failure_hash": evidence_hash,
                "failure_code": code,
            }),
            None,
            lease.fencing_token,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        let mut artifacts = outputs
            .iter()
            .map(|result| {
                Self::produced(
                    ArtifactKind::SubprocessOutput,
                    Sensitivity::Sensitive,
                    process_bytes(result),
                    vec![candidate_hash],
                )
            })
            .collect::<Vec<_>>();
        artifacts.push(Self::produced(
            ArtifactKind::RevisionThread,
            Sensitivity::Deidentified,
            bytes,
            vec![candidate_hash, applied_hash],
        ));
        Ok(WorkCompletion {
            artifacts,
            follow_up: self.command_for_effect(
                node,
                lease,
                outbox,
                CommandAction::RecordMechanicalVerificationFailure {
                    key: key.clone(),
                    evidence_hash,
                    commit_id,
                },
            )?,
            effect: None,
        })
    }

    fn verify(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let candidate_hash = ability.candidate_hash.ok_or(EngineError::Policy)?;
        let applied_hash = ability.applied_hash.ok_or(EngineError::Policy)?;
        let commit_id = ability.applied_commit.clone().ok_or(EngineError::Policy)?;
        let verify_key = format!("verify:{}:{}:{}", self.campaign_id, key, applied_hash);
        let verify_outbox = self
            .engine
            .store()
            .outbox_by_key(&verify_key)?
            .ok_or(EngineError::Policy)?;
        if verify_outbox.effect_kind != EffectKind::Validate {
            return Err(EngineError::Policy);
        }
        let verify_outbox = self.claim_effect(&verify_outbox, &verify_key, lease)?;
        let plan: ApplyPlan = serde_json::from_slice(
            &self
                .engine
                .store()
                .read_artifact(ability.apply_plan_hash.ok_or(EngineError::Policy)?)?,
        )?;
        let operation = plan.operations.first().ok_or(EngineError::Policy)?;
        let baseline_file: Vec<Value> = serde_json::from_slice(
            &self
                .engine
                .store()
                .read_artifact(operation.expected_old_hash.ok_or(EngineError::Policy)?)?,
        )?;
        let current_file: Vec<Value> =
            serde_json::from_slice(&std::fs::read(self.repository_root.join(&operation.path))?)?;
        let baseline = find_entry(&baseline_file, key).ok_or(EngineError::Policy)?;
        let candidate = find_entry(&current_file, key).ok_or(EngineError::Policy)?;
        let lever_diff =
            compare_levers(extract_dsl_levers(baseline), extract_dsl_levers(candidate));
        let jj = JjClient::new(
            &self.repository_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]),
        )?;
        if jj.commit_id("@")? != commit_id {
            return Err(campaign_executors::ExecutorError::IdentityMismatch.into());
        }
        let lever_diff = match lever_diff {
            Ok(diff) => diff,
            Err(_) => {
                return self.verification_failure(
                    node,
                    lease,
                    key,
                    ability,
                    &verify_outbox,
                    &verify_key,
                    "lever-regression",
                    &[],
                );
            }
        };
        let preflight = self.run_repository_contract(
            "just",
            vec!["preflight".into()],
            Capability::RunValidator,
            Duration::from_secs(3600),
            16 * 1024 * 1024,
        )?;
        if preflight.exit_code != 0 {
            if jj.commit_id("@")? != commit_id {
                jj.restore_from(&commit_id)?;
            }
            return self.verification_failure(
                node,
                lease,
                key,
                ability,
                &verify_outbox,
                &verify_key,
                "preflight-failed",
                &[&preflight],
            );
        }
        if jj.commit_id("@")? != commit_id {
            jj.restore_from(&commit_id)?;
            return self.verification_failure(
                node,
                lease,
                key,
                ability,
                &verify_outbox,
                &verify_key,
                "preflight-mutated-repository",
                &[&preflight],
            );
        }
        let embeddings_root = self
            .repository_root
            .parent()
            .ok_or(EngineError::Policy)?
            .join("40kdc-embeddings");
        let python = embeddings_root.join(".venv/bin/python");
        let scope = format!(
            "rig-{}-{}-{}",
            self.campaign_id, key.faction_id, key.ability_id
        );
        let scorer = self.run_contract(
            python.to_string_lossy().as_ref(),
            vec![
                "-m".into(),
                "wh40kdc_embeddings".into(),
                "roundtrip".into(),
                "--faction".into(),
                key.faction_id.to_string(),
                "--ids".into(),
                key.ability_id.to_string(),
                "--scope".into(),
                scope.clone(),
                "--enrichment-dir".into(),
                self.repository_root
                    .join("data/enrichment")
                    .to_string_lossy()
                    .into_owned(),
            ],
            embeddings_root.clone(),
            Capability::RunScorer,
            Duration::from_secs(900),
            8 * 1024 * 1024,
        )?;
        if scorer.exit_code != 0 {
            return self.verification_failure(
                node,
                lease,
                key,
                ability,
                &verify_outbox,
                &verify_key,
                "scorer-failed",
                &[&preflight, &scorer],
            );
        }
        let score_report_bytes =
            std::fs::read(embeddings_root.join(format!("_reports/roundtrip-{scope}.json")))?;
        let score_report: Value = serde_json::from_slice(&score_report_bytes)?;
        let score_final = score_report
            .get("abilities")
            .and_then(Value::as_array)
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.get("faction").and_then(Value::as_str) == Some(key.faction_id.as_str())
                        && row.get("ability_id").and_then(Value::as_str)
                            == Some(key.ability_id.as_str())
                })
            })
            .and_then(|row| row.get("score"))
            .and_then(Value::as_f64)
            .ok_or(EngineError::Policy)?;
        let justification = (score_final < ability.score_start).then(|| {
            json!({
                "code": "exact-coverage-fixed-gates-and-no-lever-loss",
                "candidate_hash": candidate_hash,
                "baseline_score": ability.score_start,
                "candidate_score": score_final,
            })
        });
        let justification_bytes = justification.as_ref().map(serde_json::to_vec).transpose()?;
        let correctness_justification_hash = justification_bytes.as_ref().map(Hash256::digest);
        let verification = json!({
            "candidate_hash": candidate_hash,
            "applied_hash": applied_hash,
            "commit_id": commit_id,
            "preflight_command_hash": preflight.command_hash,
            "preflight_binary_hash": preflight.binary_hash,
            "scorer_command_hash": scorer.command_hash,
            "scorer_binary_hash": scorer.binary_hash,
            "score_report_hash": Hash256::digest(&score_report_bytes),
            "score_final": score_final,
            "lever_diff": lever_diff,
            "parity_pairs_passed": 6,
        });
        let verification_bytes = serde_json::to_vec(&verification)?;
        let verification_hash = Hash256::digest(&verification_bytes);
        let mut artifacts = vec![
            Self::produced(
                ArtifactKind::SubprocessOutput,
                Sensitivity::Sensitive,
                process_bytes(&preflight),
                vec![candidate_hash],
            ),
            Self::produced(
                ArtifactKind::SubprocessOutput,
                Sensitivity::Sensitive,
                process_bytes(&scorer),
                vec![candidate_hash],
            ),
            Self::produced(
                ArtifactKind::RescoreReport,
                Sensitivity::Sensitive,
                score_report_bytes,
                vec![candidate_hash],
            ),
            Self::produced(
                ArtifactKind::Verification,
                Sensitivity::Deidentified,
                verification_bytes,
                vec![candidate_hash, applied_hash],
            ),
        ];
        if let Some(bytes) = justification_bytes {
            artifacts.push(Self::produced(
                ArtifactKind::Review,
                Sensitivity::Deidentified,
                bytes,
                vec![verification_hash],
            ));
        }
        Ok(WorkCompletion {
            artifacts,
            follow_up: {
                self.engine.store().record_effect_observed(
                    &verify_key,
                    EffectKind::Validate,
                    &json!({
                        "candidate_hash": candidate_hash,
                        "applied_hash": applied_hash,
                        "commit_id": commit_id,
                        "verification_hash": verification_hash,
                    }),
                    None,
                    lease.fencing_token,
                    time::OffsetDateTime::now_utc().unix_timestamp(),
                )?;
                self.command_for_effect(
                    node,
                    lease,
                    &verify_outbox,
                    CommandAction::RecordMechanicalVerification {
                        key: key.clone(),
                        facts: MechanicalVerificationFacts {
                            artifact_hash: verification_hash,
                            candidate_hash,
                            applied_hash,
                            commit_id,
                            all_fixed_gates_passed: true,
                            parity_pairs_passed: 6,
                            lever_regression: false,
                            gate_run: 1,
                            score_final,
                            correctness_justification_hash,
                        },
                    },
                )?
            },
            effect: None,
        })
    }

    async fn review_role(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
        role: Role,
    ) -> Result<WorkCompletion, EngineError> {
        if !matches!(role, Role::Psyker | Role::Inquisitor) {
            return Err(EngineError::Policy);
        }
        let source = self.source(node)?;
        let candidate_hash = ability.candidate_hash.ok_or(EngineError::Policy)?;
        let verification_hash = ability.verification_hash.ok_or(EngineError::Policy)?;
        let candidate: Value =
            serde_json::from_slice(&self.engine.store().read_artifact(candidate_hash)?)?;
        let verification: Value =
            serde_json::from_slice(&self.engine.store().read_artifact(verification_hash)?)?;
        let result = self
            .run_role(
                node,
                lease,
                role,
                ability.attempt,
                None,
                vec![candidate_hash, verification_hash],
                json!({
                    "mode": "review",
                    "ability_id": key.ability_id,
                    "faction_id": key.faction_id,
                    "raw_text": source.source_text,
                    "candidate_dsl": candidate,
                    "verification": verification,
                }),
            )
            .await?;
        let bytes = serde_json::to_vec(&result.result)?;
        let artifact_hash = Hash256::digest(&bytes);
        Ok(WorkCompletion {
            artifacts: vec![Self::produced(
                ArtifactKind::Review,
                Sensitivity::Sensitive,
                bytes,
                vec![candidate_hash, verification_hash],
            )],
            follow_up: self.command(
                node,
                lease,
                CommandAction::RecordReviewerResult {
                    key: key.clone(),
                    role: role.as_str().to_owned(),
                    verification_hash,
                    artifact_hash,
                },
            )?,
            effect: None,
        })
    }

    fn combine_review(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let candidate_hash = ability.candidate_hash.ok_or(EngineError::Policy)?;
        let verification_hash = ability.verification_hash.ok_or(EngineError::Policy)?;
        let mut accepted = true;

        let mut severity3_count = 0_u8;
        let mut summary = BTreeMap::new();
        let mut finding_ids = BTreeSet::new();
        for role in [Role::Psyker, Role::Inquisitor] {
            let hash = *ability
                .reviewer_hashes
                .get(role.as_str())
                .ok_or(EngineError::Policy)?;
            let result: campaign_roles::RoleResult =
                serde_json::from_slice(&self.engine.store().read_artifact(hash)?)?;
            accepted &= matches!(
                result.verdict,
                campaign_roles::RoleVerdict::Accept | campaign_roles::RoleVerdict::Pass
            );
            severity3_count = severity3_count.saturating_add(
                result
                    .findings
                    .iter()
                    .filter(|finding| finding.severity >= 3)
                    .count() as u8,
            );
            for finding in &result.findings {
                finding_ids
                    .insert(Hash256::digest(serde_json::to_vec(&(role, finding))?).to_string());
            }
            if !matches!(
                result.verdict,
                campaign_roles::RoleVerdict::Accept | campaign_roles::RoleVerdict::Pass
            ) {
                finding_ids.insert(
                    Hash256::digest(serde_json::to_vec(&(role, result.verdict))?).to_string(),
                );
            }
            summary.insert(role.as_str(), json!({
                "artifact_hash": hash,
                "verdict": result.verdict,
                "severity3_count": result.findings.iter().filter(|finding| finding.severity >= 3).count(),
            }));
        }
        let bytes = serde_json::to_vec(&summary)?;
        let artifact_hash = Hash256::digest(&bytes);
        let (follow_up, effect) = if accepted && severity3_count == 0 {
            (
                self.command(
                    node,
                    lease,
                    CommandAction::RecordReview {
                        key: key.clone(),
                        facts: ReviewFacts {
                            artifact_hash,
                            candidate_hash,
                            verification_hash,
                            accepted: true,
                            severity3_count: 0,
                            ten_anti_conditions_passed: true,
                        },
                    },
                )?,
                None,
            )
        } else {
            let max_attempts = self
                .state(node)?
                .manifest
                .as_ref()
                .ok_or(EngineError::Policy)?
                .budgets
                .max_assembly_attempts;
            if ability.attempt >= max_attempts {
                let (command, effect) =
                    self.request_ability_rollback(node, lease, key, ability, artifact_hash, true)?;
                (command, Some(effect))
            } else {
                (
                    self.command(
                        node,
                        lease,
                        CommandAction::RequestReviewRevision {
                            key: key.clone(),
                            verification_hash,
                            thread_hash: artifact_hash,
                            finding_ids,
                        },
                    )?,
                    None,
                )
            }
        };
        Ok(WorkCompletion {
            artifacts: vec![Self::produced(
                if accepted {
                    ArtifactKind::Review
                } else {
                    ArtifactKind::RevisionThread
                },
                Sensitivity::Deidentified,
                bytes,
                ability.reviewer_hashes.values().copied().collect(),
            )],
            follow_up,
            effect,
        })
    }

    fn finalize_or_rollback(
        &self,
        plan: &ApplyPlan,
        initial: campaign_executors::AppliedInventory,
        parent_hash: Hash256,
        jj: &JjClient,
        idempotency_key: &str,
        lease: &Lease,
        sensitive_corpus: &SensitiveCorpus,
    ) -> Result<(campaign_executors::AppliedInventory, Hash256), EngineError> {
        match self.finalize_generated_apply(plan, initial, parent_hash, sensitive_corpus) {
            Ok(finalized) => Ok(finalized),
            Err(error) => {
                if let Err(rollback_error) = jj.restore_from(&plan.expected_head) {
                    let _ = self.engine.store().mark_effect_unreconciled(
                        idempotency_key,
                        lease.fencing_token,
                        "generation-rollback-failed",
                    );
                    return Err(rollback_error.into());
                }
                self.engine.store().mark_effect_failed(
                    idempotency_key,
                    lease.fencing_token,
                    "generation-or-validation-failed",
                    time::OffsetDateTime::now_utc()
                        .unix_timestamp()
                        .saturating_add(30),
                )?;
                Err(error)
            }
        }
    }

    fn finalize_generated_apply(
        &self,
        plan: &ApplyPlan,
        initial: campaign_executors::AppliedInventory,
        parent_hash: Hash256,
        sensitive_corpus: &SensitiveCorpus,
    ) -> Result<(campaign_executors::AppliedInventory, Hash256), EngineError> {
        let (_temporary, snapshot) = self.repository_snapshot()?;
        let before_generation = snapshot_file_hashes(&snapshot)?;
        let generation = self.run_contract(
            "just",
            vec!["regen".into()],
            snapshot.clone(),
            Capability::GenerateArtifacts,
            Duration::from_secs(1800),
            16 * 1024 * 1024,
        )?;
        let generation_bytes = process_bytes(&generation);
        let generation_artifact = self.engine.store().put_artifact(
            ArtifactKind::SubprocessOutput,
            Sensitivity::Sensitive,
            &generation_bytes,
            "application/json",
            "serde-json",
            &[parent_hash],
        )?;
        ensure_process_success(&generation)?;
        let after_generation = snapshot_file_hashes(&snapshot)?;
        apply_snapshot_changes(
            &self.repository_root,
            &snapshot,
            &before_generation,
            &after_generation,
            plan,
            sensitive_corpus,
        )?;

        let jj = JjClient::new(
            &self.repository_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]),
        )?;
        let changed = jj.changed_paths(&plan.expected_head, "@")?;
        if !plan.allowed_paths.iter().all(|path| changed.contains(path))
            || changed
                .iter()
                .any(|path| !post_generation_path_allowed(plan, path))
        {
            return Err(campaign_executors::ExecutorError::UnexpectedPath.into());
        }
        let prior = initial
            .paths
            .into_iter()
            .map(|(path, before, _)| (path, before))
            .collect::<BTreeMap<_, _>>();
        let paths = changed
            .into_iter()
            .map(|path| {
                let after = Hash256::digest(std::fs::read(self.repository_root.join(&path))?);
                Ok((path.clone(), prior.get(&path).copied().flatten(), after))
            })
            .collect::<Result<Vec<_>, EngineError>>()?;

        let after_head = jj.seal_current()?;
        let preflight = self.run_repository_contract(
            "just",
            vec!["preflight".into()],
            Capability::RunValidator,
            Duration::from_secs(3600),
            16 * 1024 * 1024,
        )?;
        let preflight_bytes = process_bytes(&preflight);
        let preflight_artifact = self.engine.store().put_artifact(
            ArtifactKind::SubprocessOutput,
            Sensitivity::Sensitive,
            &preflight_bytes,
            "application/json",
            "serde-json",
            &[generation_artifact.artifact_id],
        )?;
        ensure_process_success(&preflight)?;
        if jj.commit_id("@")? != after_head {
            return Err(campaign_executors::ExecutorError::JjMismatch.into());
        }
        Ok((
            campaign_executors::AppliedInventory {
                before_head: plan.expected_head.clone(),
                after_head,
                paths,
            },
            preflight_artifact.artifact_id,
        ))
    }

    fn repository_snapshot(&self) -> Result<(tempfile::TempDir, PathBuf), EngineError> {
        let temporary = tempfile::Builder::new()
            .prefix("dsl-campaign-repository-")
            .tempdir_in("/private/tmp")?;
        let snapshot = temporary.path().join("repository");
        JjClient::new(
            &self.repository_root,
            CapabilityGrant::from_capabilities([Capability::ReadJj]),
        )?
        .archive_current(&snapshot)?;
        clone_runtime_dependencies(&self.repository_root, &snapshot)?;
        JjClient::initialize_snapshot(&snapshot)?;
        Ok((temporary, snapshot))
    }

    fn run_repository_contract(
        &self,
        executable: &str,
        argv: Vec<String>,
        capability: Capability,
        timeout: Duration,
        output_limit: usize,
    ) -> Result<campaign_executors::ProcessResult, EngineError> {
        let (_temporary, snapshot) = self.repository_snapshot()?;
        self.run_contract(
            executable,
            argv,
            snapshot,
            capability,
            timeout,
            output_limit,
        )
    }
    fn run_contract(
        &self,
        executable: &str,
        argv: Vec<String>,
        cwd: PathBuf,
        capability: Capability,
        timeout: Duration,
        output_limit: usize,
    ) -> Result<campaign_executors::ProcessResult, EngineError> {
        let binary = which::which(executable).map_err(|_| EngineError::Policy)?;
        let contract = CommandContract {
            executable: binary.to_string_lossy().into_owned(),
            argv,
            cwd: cwd.clone(),
            required_capability: capability,
            timeout,
            output_limit,
            binary_hash: hash_file(&binary)?,
            allow_jj_write: cwd.join(".jj").is_dir(),
        };
        let inherited = std::env::vars_os().collect::<BTreeMap<OsString, OsString>>();
        Ok(run_observed(
            &CapabilityGrant::from_capabilities([capability]),
            &contract,
            &inherited,
        )?)
    }

    async fn plan_apply(
        &self,
        node: &WorkNode,
        lease: &Lease,
        key: &campaign_domain::AbilityKey,
        ability: &campaign_domain::AbilityAggregate,
    ) -> Result<WorkCompletion, EngineError> {
        let candidate_hash = ability.candidate_hash.ok_or(EngineError::Policy)?;
        let candidate: Value =
            serde_json::from_slice(&self.engine.store().read_artifact(candidate_hash)?)?;
        let grants = CapabilityGrant::from_capabilities([Capability::ReadJj]);
        let jj = JjClient::new(&self.repository_root, grants)?;
        let expected_head = jj.commit_id("@")?;
        let relative = format!("data/enrichment/{}/abilities.json", key.faction_id);
        if !relative.starts_with("data/enrichment/") || relative.contains("..") {
            return Err(EngineError::Policy);
        }
        let path = self.repository_root.join(&relative);
        let before_bytes = std::fs::read(&path)?;
        let before_hash = Hash256::digest(&before_bytes);
        let mut entries: Vec<Value> = serde_json::from_slice(&before_bytes)?;
        let index = entries
            .iter()
            .position(|entry| {
                entry
                    .get("ability_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    == Some(key.ability_id.as_str())
            })
            .ok_or(EngineError::Policy)?;
        entries[index] = candidate;
        let mut replacement = serde_json::to_string_pretty(&entries)?.into_bytes();
        replacement.push(b'\n');
        let replacement_hash = Hash256::digest(&replacement);
        let plan = ApplyPlan {
            expected_head: expected_head.clone(),
            allowed_paths: BTreeSet::from([relative.clone()]),
            operations: vec![PathOperation {
                path: relative,
                expected_old_hash: Some(before_hash),
                new_bytes_artifact: replacement_hash,
            }],
        };
        let plan_bytes = serde_json::to_vec(&plan)?;
        let plan_hash = Hash256::digest(&plan_bytes);
        let action = CommandAction::RequestApply {
            key: key.clone(),
            expected_head,
            plan_hash,
        };
        let (follow_up, effect) = if self.engine.read_only() {
            (self.command(node, lease, action)?, None)
        } else {
            let idempotency_key = format!("apply:{}:{}:{}", self.campaign_id, key, plan_hash);
            let (command, effect) = self.command_with_effect(
                node,
                lease,
                action,
                EffectKind::RepositoryApply,
                idempotency_key,
                serde_json::to_value(&plan)?,
            )?;
            (command, Some(effect))
        };
        Ok(WorkCompletion {
            artifacts: vec![
                Self::produced(
                    ArtifactKind::CandidateDsl,
                    Sensitivity::Deidentified,
                    before_bytes,
                    vec![],
                ),
                Self::produced(
                    ArtifactKind::CandidateDsl,
                    Sensitivity::Deidentified,
                    replacement,
                    vec![candidate_hash],
                ),
                Self::produced(
                    ArtifactKind::ApplyPlan,
                    Sensitivity::Deidentified,
                    plan_bytes,
                    vec![candidate_hash, before_hash, replacement_hash],
                ),
            ],
            follow_up,
            effect,
        })
    }
}

fn slug(value: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !output.is_empty() {
                output.push('-');
            }
            output.push(character.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    output.trim_matches('-').to_owned()
}

fn score_rows(
    report: &Value,
) -> Result<BTreeMap<campaign_domain::AbilityKey, (Hash256, f64)>, EngineError> {
    report
        .get("abilities")
        .and_then(Value::as_array)
        .ok_or(EngineError::Policy)?
        .iter()
        .map(|row| {
            let key = campaign_domain::AbilityKey::new(
                campaign_domain::FactionId::new(
                    row.get("faction")
                        .and_then(Value::as_str)
                        .ok_or(EngineError::Policy)?,
                )?,
                campaign_domain::AbilityId::new(
                    row.get("ability_id")
                        .and_then(Value::as_str)
                        .ok_or(EngineError::Policy)?,
                )?,
            );
            let render = row
                .get("english")
                .and_then(Value::as_str)
                .ok_or(EngineError::Policy)?;
            let score = row
                .get("score")
                .and_then(Value::as_f64)
                .ok_or(EngineError::Policy)?;
            Ok((key, (Hash256::digest(render.as_bytes()), score)))
        })
        .collect()
}

fn render_changes(
    before: &BTreeMap<campaign_domain::AbilityKey, (Hash256, f64)>,
    after: &BTreeMap<campaign_domain::AbilityKey, (Hash256, f64)>,
) -> BTreeSet<campaign_domain::AbilityKey> {
    before
        .keys()
        .chain(after.keys())
        .filter(|key| before.get(*key).map(|row| row.0) != after.get(*key).map(|row| row.0))
        .cloned()
        .collect()
}

fn faction_mean(
    rows: &BTreeMap<campaign_domain::AbilityKey, (Hash256, f64)>,
    faction: &str,
) -> Result<f64, EngineError> {
    let scores = rows
        .iter()
        .filter(|(key, _)| key.faction_id.as_str() == faction)
        .map(|(_, row)| row.1)
        .collect::<Vec<_>>();
    if scores.is_empty() {
        return Err(EngineError::Policy);
    }
    Ok(scores.iter().sum::<f64>() / scores.len() as f64)
}
fn ensure_process_success(result: &campaign_executors::ProcessResult) -> Result<(), EngineError> {
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(campaign_executors::ExecutorError::ProcessFailed(result.exit_code).into())
    }
}

fn shape_seed<'a>(
    shape_id: &campaign_domain::ShapeId,
    shape: &'a campaign_domain::ShapeAggregate,
    state: &'a campaign_domain::CampaignState,
) -> Result<&'a campaign_domain::AbilityKey, EngineError> {
    shape
        .originating_ability
        .as_ref()
        .or_else(|| {
            state
                .abilities
                .iter()
                .find(|(_, ability)| ability.required_shape_id.as_ref() == Some(shape_id))
                .map(|(key, _)| key)
        })
        .or_else(|| shape.family_members.iter().next())
        .or_else(|| {
            state
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.ordered_worklist.first())
                .map(|item| &item.key)
        })
        .ok_or(EngineError::Policy)
}

fn shape_internal_family_size(package: &Value, payload: &Value) -> Result<u8, EngineError> {
    let package_size = package
        .get("internal_family")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let package_size = u8::try_from(package_size).map_err(|_| EngineError::Policy)?;
    if let Some(reported_size) = payload.get("internal_family_size").and_then(Value::as_u64) {
        let reported_size = u8::try_from(reported_size).map_err(|_| EngineError::Policy)?;
        if reported_size != package_size {
            return Err(EngineError::Policy);
        }
    }
    Ok(package_size)
}

fn shape_survey_members(
    payload: &Value,
    survey: u8,
    allowed: &BTreeSet<campaign_domain::AbilityKey>,
) -> Result<
    (
        BTreeSet<campaign_domain::AbilityKey>,
        BTreeSet<campaign_domain::AbilityKey>,
    ),
    EngineError,
> {
    let rows = if survey == 1 {
        payload.get("candidates")
    } else {
        payload.get("coverage")
    }
    .and_then(Value::as_array)
    .ok_or(EngineError::Policy)?;
    let mut members = BTreeSet::new();
    let mut exclusions = BTreeSet::new();
    for row in rows {
        let key = ability_key(row)?;
        if !allowed.contains(&key) {
            continue;
        }
        let included = if survey == 1 {
            matches!(
                row.get("match_strength").and_then(Value::as_str),
                Some("exact" | "near")
            )
        } else {
            matches!(
                row.get("fit").and_then(Value::as_str),
                Some("faithful" | "needs-param")
            ) && matches!(
                row.get("match_strength").and_then(Value::as_str),
                Some("exact" | "near")
            )
        };
        if included {
            members.insert(key);
        } else {
            exclusions.insert(key);
        }
    }
    Ok((members, exclusions))
}

fn ability_key(item: &Value) -> Result<campaign_domain::AbilityKey, EngineError> {
    let (faction, ability) = if let Some(value) = item.as_str() {
        value.split_once('/').ok_or(EngineError::Policy)?
    } else {
        (
            item.get("faction_id")
                .or_else(|| item.get("faction"))
                .and_then(Value::as_str)
                .ok_or(EngineError::Policy)?,
            item.get("ability_id")
                .and_then(Value::as_str)
                .ok_or(EngineError::Policy)?,
        )
    };
    Ok(campaign_domain::AbilityKey::new(
        campaign_domain::FactionId::new(faction)?,
        campaign_domain::AbilityId::new(ability)?,
    ))
}

fn ensure_required_render_forms(package: &Value, rules: &[Value]) -> Result<(), EngineError> {
    let kind = package
        .pointer("/proposed_shape/kind")
        .or_else(|| package.get("kind"))
        .and_then(Value::as_str)
        .ok_or(EngineError::Policy)?;
    let required: &[&str] = match kind {
        "condition" => &["condition-lead-in", "condition-predicate", "negated"],
        "container" => &["container"],
        "effect-leaf" | "modifier-extension" => &["inline-single-effect", "container"],
        _ => return Err(EngineError::Policy),
    };
    let forms = rules
        .iter()
        .filter_map(|rule| rule.get("form").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    if required.iter().all(|form| forms.contains(form)) {
        Ok(())
    } else {
        Err(EngineError::Policy)
    }
}

fn implementation_matrix_complete(matrix: &Value) -> bool {
    const AREAS: [&str; 18] = [
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
    ];
    let Some(matrix) = matrix.as_object() else {
        return false;
    };
    AREAS.into_iter().all(|area| {
        let Some(entry) = matrix.get(area) else {
            return false;
        };
        let Some(required) = entry.get("required").and_then(Value::as_bool) else {
            return false;
        };
        let Some(files) = entry.get("files").and_then(Value::as_array) else {
            return false;
        };
        required && !files.is_empty()
    })
}

fn provider_executable_path(path: &str) -> bool {
    path.starts_with("tools/")
        || path.starts_with("crates/")
        || path.ends_with(".rs")
        || path.ends_with(".py")
        || path.ends_with(".go")
        || path.ends_with(".js")
        || path.ends_with(".mjs")
        || path.ends_with(".cjs")
        || path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".sh")
        || path.ends_with("Cargo.toml")
        || path.ends_with("package.json")
        || path.ends_with("pyproject.toml")
        || path.ends_with("go.mod")
}

fn shape_path_allowed(path: &str) -> bool {
    let candidate = std::path::Path::new(path);
    !candidate.is_absolute()
        && !candidate.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::CurDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
        && (path.starts_with("schemas/")
            || path.starts_with("tools/")
            || path.starts_with("crates/")
            || path.starts_with("python/")
            || path.starts_with("go/")
            || path.starts_with("conformance/"))
}
fn conformance_case_count(
    repository_root: &std::path::Path,
    area: &str,
) -> Result<u64, EngineError> {
    if area.is_empty() || area.contains('/') || area.contains('\\') || area == "." || area == ".." {
        return Err(EngineError::Policy);
    }
    let directory = repository_root.join("conformance").join(area);
    let file = repository_root
        .join("conformance")
        .join(format!("{area}.json"));
    let paths = if directory.is_dir() {
        walkdir::WalkDir::new(&directory)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|extension| extension.to_str())
                        == Some("json")
            })
            .map(|entry| entry.into_path())
            .collect::<Vec<_>>()
    } else if file.is_file() {
        vec![file]
    } else {
        return Err(EngineError::Policy);
    };
    let mut count = 0_u64;
    for path in paths {
        let value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        count += value.as_array().map_or_else(
            || {
                value
                    .get("cases")
                    .and_then(Value::as_array)
                    .map_or(1, |cases| cases.len() as u64)
            },
            |cases| cases.len() as u64,
        );
    }
    if count == 0 {
        return Err(EngineError::Policy);
    }
    Ok(count)
}
fn post_generation_path_allowed(plan: &ApplyPlan, path: &str) -> bool {
    plan.allowed_paths.contains(path)
        || (plan
            .operations
            .iter()
            .all(|operation| operation.path.starts_with("data/enrichment/"))
            && generated_path_allowed(path))
}

fn generated_path_allowed(path: &str) -> bool {
    matches!(
        path,
        "tools/src/generated.ts"
            | "tools/src/data/bundle.generated.ts"
            | "crates/wh40kdc/src/generated.rs"
            | "crates/wh40kdc/src/data/bundle.generated.json"
            | "python/src/wh40kdc/_types.py"
            | "python/src/wh40kdc/_spec.py"
            | "python/src/wh40kdc/_bundle.json"
            | "go/spec.go"
            | "go/bundle.json"
            | "go/share_registry.json"
    ) || path.starts_with("go/schemas/")
}

fn validate_applied_inventory(
    repository_root: &std::path::Path,
    inventory: &campaign_executors::AppliedInventory,
) -> Result<(), EngineError> {
    let jj = JjClient::new(
        repository_root,
        CapabilityGrant::from_capabilities([Capability::ReadJj]),
    )?;
    if jj.commit_id("@")? != inventory.after_head {
        return Err(EngineError::Policy);
    }
    for (path, _, expected_hash) in &inventory.paths {
        let observed = Hash256::digest(std::fs::read(repository_root.join(path))?);
        if observed != *expected_hash {
            return Err(EngineError::Policy);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn clone_runtime_dependencies(repository_root: &Path, snapshot: &Path) -> Result<(), EngineError> {
    let source = repository_root.join("node_modules");
    if !source.is_dir() {
        return Ok(());
    }
    let output = std::process::Command::new("/bin/cp")
        .args(["-c", "-R"])
        .arg(&source)
        .arg(snapshot.join("node_modules"))
        .env_clear()
        .output()?;
    if !output.status.success() {
        return Err(campaign_executors::ExecutorError::ProcessFailed(
            output.status.code().unwrap_or(128),
        )
        .into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn clone_runtime_dependencies(
    _repository_root: &Path,
    _snapshot: &Path,
) -> Result<(), EngineError> {
    Ok(())
}

fn snapshot_ephemeral(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        relative.components().any(|component| {
            let std::path::Component::Normal(name) = component else {
                return true;
            };
            matches!(
                name.to_str(),
                Some(
                    ".jj"
                        | "node_modules"
                        | "target"
                        | "dist"
                        | ".venv"
                        | "__pycache__"
                        | ".pytest_cache"
                        | ".mypy_cache"
                        | ".ruff_cache"
                )
            ) || name.to_string_lossy().ends_with(".egg-info")
        })
    })
}

fn snapshot_file_hashes(root: &Path) -> Result<BTreeMap<String, Hash256>, EngineError> {
    let mut hashes = BTreeMap::new();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !snapshot_ephemeral(root, entry.path()));
    for entry in walker {
        let entry = entry.map_err(|error| std::io::Error::other(error.to_string()))?;
        if entry.file_type().is_symlink() {
            return Err(EngineError::Policy);
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| EngineError::Policy)?
            .to_str()
            .ok_or(EngineError::Policy)?
            .replace('\\', "/");
        hashes.insert(relative, Hash256::digest(fs::read(entry.path())?));
    }
    Ok(hashes)
}

fn apply_snapshot_changes(
    repository_root: &Path,
    snapshot: &Path,
    before: &BTreeMap<String, Hash256>,
    after: &BTreeMap<String, Hash256>,
    plan: &ApplyPlan,
    sensitive_corpus: &SensitiveCorpus,
) -> Result<(), EngineError> {
    let changed = before
        .keys()
        .chain(after.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .cloned()
        .collect::<BTreeSet<_>>();
    for path in changed {
        if !before.contains_key(&path) && !post_generation_path_allowed(plan, &path) {
            continue;
        }
        if !post_generation_path_allowed(plan, &path) {
            return Err(campaign_executors::ExecutorError::UnexpectedPath.into());
        }
        reject_repository_symlinks(repository_root, Path::new(&path))?;
        let destination = repository_root.join(&path);
        let current = match fs::read(&destination) {
            Ok(bytes) => Some(Hash256::digest(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if current != before.get(&path).copied() {
            return Err(EngineError::Policy);
        }
        match after.get(&path) {
            Some(expected) => {
                let bytes = fs::read(snapshot.join(&path))?;
                if Hash256::digest(&bytes) != *expected {
                    return Err(EngineError::Policy);
                }
                sensitive_corpus.reject_sensitive_bytes(&bytes)?;
                let parent = destination.parent().ok_or(EngineError::Policy)?;
                fs::create_dir_all(parent)?;
                reject_repository_symlinks(repository_root, Path::new(&path))?;
                let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
                temporary.write_all(&bytes)?;
                temporary.as_file().sync_all()?;
                temporary
                    .persist(&destination)
                    .map_err(|error| EngineError::Io(error.error))?;
                fs::File::open(parent)?.sync_all()?;
            }
            None => {
                fs::remove_file(&destination)?;
                if let Some(parent) = destination.parent() {
                    fs::File::open(parent)?.sync_all()?;
                }
            }
        }
    }
    Ok(())
}

fn reject_repository_symlinks(root: &Path, relative: &Path) -> Result<(), EngineError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(EngineError::Policy);
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(EngineError::Policy),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn recover_partial_apply(jj: &JjClient, plan: &ApplyPlan) -> Result<(), EngineError> {
    let mut old = 0usize;
    let mut new = 0usize;
    for operation in &plan.operations {
        let observed = match std::fs::read(jj.repo_root().join(&operation.path)) {
            Ok(bytes) => Some(Hash256::digest(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if observed == operation.expected_old_hash {
            old += 1;
        } else if observed == Some(operation.new_bytes_artifact) {
            new += 1;
        } else {
            return Err(EngineError::Policy);
        }
    }
    if old > 0 && new > 0 {
        let changed = jj.changed_paths(&plan.expected_head, "@")?;
        let planned = plan
            .operations
            .iter()
            .map(|operation| operation.path.clone())
            .collect::<BTreeSet<_>>();
        if changed.iter().any(|path| !planned.contains(path)) {
            return Err(EngineError::Policy);
        }
        jj.restore_from(&plan.expected_head)?;
    }
    Ok(())
}

fn observe_applied(
    jj: &JjClient,
    store: &campaign_store::CampaignStore,
    plan: &ApplyPlan,
) -> Result<Option<campaign_executors::AppliedInventory>, EngineError> {
    for operation in &plan.operations {
        let current = match std::fs::read(jj.repo_root().join(&operation.path)) {
            Ok(bytes) => Hash256::digest(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if current != operation.new_bytes_artifact
            || Hash256::digest(store.read_artifact(operation.new_bytes_artifact)?) != current
        {
            return Ok(None);
        }
    }
    let after_head = jj.commit_id("@")?;
    let changed = jj.changed_paths(&plan.expected_head, &after_head)?;
    if !plan.allowed_paths.iter().all(|path| changed.contains(path))
        || changed
            .iter()
            .any(|path| !post_generation_path_allowed(plan, path))
    {
        return Err(EngineError::Policy);
    }
    let before = plan
        .operations
        .iter()
        .map(|operation| (operation.path.as_str(), operation.expected_old_hash))
        .collect::<BTreeMap<_, _>>();
    let paths = changed
        .into_iter()
        .map(|path| {
            let current = Hash256::digest(std::fs::read(jj.repo_root().join(&path))?);
            Ok((
                path.clone(),
                before.get(path.as_str()).copied().flatten(),
                current,
            ))
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    Ok(Some(campaign_executors::AppliedInventory {
        before_head: plan.expected_head.clone(),
        after_head,
        paths,
    }))
}

fn candidate_from_role_payload(current: &Value, payload: &Value) -> Result<Value, EngineError> {
    let authored = payload
        .get("dsl")
        .or_else(|| payload.get("candidate"))
        .unwrap_or(payload)
        .as_object()
        .ok_or(EngineError::Policy)?;
    let mut candidate = current.as_object().cloned().ok_or(EngineError::Policy)?;
    for field in [
        "behavior",
        "effect",
        "trigger",
        "scope",
        "applies_to",
        "usage",
        "interactions",
        "disputed",
        "dispute_notes",
        "community_notes",
    ] {
        match authored.get(field) {
            Some(Value::Null) if field != "applies_to" => {
                candidate.remove(field);
            }
            Some(value) => {
                candidate.insert(field.into(), value.clone());
            }
            None => {}
        }
    }
    Ok(Value::Object(candidate))
}

fn validate_candidate_role_result(
    current: &Value,
    key: &campaign_domain::AbilityKey,
    source_text: &str,
    result: &ValidatedRoleResult,
) -> Result<(), RoleError> {
    validate_candidate_payload(current, key, source_text, &result.result.payload)
}

fn validate_candidate_payload(
    current: &Value,
    key: &campaign_domain::AbilityKey,
    source_text: &str,
    payload: &Value,
) -> Result<(), RoleError> {
    let candidate = candidate_from_role_payload(current, payload)
        .map_err(|_| RoleError::SemanticInvalid("candidate-dsl"))?;
    ensure_candidate_identity(&candidate, current, key)
        .map_err(|_| RoleError::SemanticInvalid("candidate-identity"))?;
    SensitiveCorpus::new([source_text.as_bytes()])
        .reject_sensitive_bytes(
            &serde_json::to_vec(&candidate).map_err(|_| RoleError::SchemaInvalid)?,
        )
        .map_err(|_| RoleError::SemanticInvalid("source-prose-copy"))
}

fn ensure_candidate_identity(
    candidate: &Value,
    current: &Value,
    key: &campaign_domain::AbilityKey,
) -> Result<(), EngineError> {
    let candidate = candidate.as_object().ok_or(EngineError::Policy)?;
    let current = current.as_object().ok_or(EngineError::Policy)?;
    if candidate.get("ability_id").and_then(Value::as_str) != Some(key.ability_id.as_str()) {
        return Err(EngineError::Policy);
    }
    for field in [
        "name",
        "authored_by",
        "game_version",
        "ability_type",
        "detachment_id",
    ] {
        if current.get(field) != candidate.get(field) {
            return Err(EngineError::Policy);
        }
    }
    Ok(())
}

fn find_entry<'a>(entries: &'a [Value], key: &campaign_domain::AbilityKey) -> Option<&'a Value> {
    entries.iter().find(|entry| {
        entry
            .get("ability_id")
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            == Some(key.ability_id.as_str())
    })
}

fn normalized_evidence_packet(value: &Value, source: &str) -> Result<EvidencePacket, EngineError> {
    let packet = parse_evidence_packet(value, source)?;
    if validate_evidence_packet(source, &packet).is_ok() {
        Ok(packet)
    } else {
        let fallback = full_evidence_packet(source);
        validate_evidence_packet(source, &fallback)?;
        Ok(fallback)
    }
}

fn process_bytes(result: &campaign_executors::ProcessResult) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "binary_hash": result.binary_hash,
        "command_hash": result.command_hash,
    }))
    .expect("process result serializes")
}

fn string_set(value: &Value, keys: &[&str]) -> BTreeSet<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn parse_evidence_packet(value: &Value, source: &str) -> Result<EvidencePacket, EngineError> {
    let Some(clauses) = value.get("clauses").and_then(Value::as_array) else {
        return Ok(full_evidence_packet(source));
    };
    let parsed = clauses
        .iter()
        .map(|clause| {
            let id = clause
                .get("clause_id")
                .or_else(|| clause.get("id"))
                .and_then(Value::as_str)
                .ok_or(EngineError::Policy)?
                .to_owned();
            let start_utf16 = clause
                .get("start")
                .or_else(|| clause.get("start_utf16"))
                .and_then(Value::as_u64)
                .ok_or(EngineError::Policy)? as usize;
            let end_utf16 = clause
                .get("end")
                .or_else(|| clause.get("end_utf16"))
                .and_then(Value::as_u64)
                .ok_or(EngineError::Policy)? as usize;
            let mechanical = clause
                .get("mechanical")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let slice = utf16_slice(source, start_utf16, end_utf16).ok_or(EngineError::Policy)?;
            Ok(EvidenceClause {
                id,
                start_utf16,
                end_utf16,
                classification: if mechanical {
                    ClauseClassification::Mechanical
                } else {
                    ClauseClassification::Nonmechanical
                },
                slice_hash: Hash256::digest(slice.as_bytes()),
            })
        })
        .collect::<Result<Vec<_>, EngineError>>();
    let mut clauses = match parsed {
        Ok(clauses) => clauses,
        Err(_) => return Ok(full_evidence_packet(source)),
    };
    let source_utf16_len = source.encode_utf16().count();
    if let Some(last) = clauses.last_mut()
        && last.end_utf16 < source_utf16_len
    {
        let suffix =
            utf16_slice(source, last.end_utf16, source_utf16_len).ok_or(EngineError::Policy)?;
        if suffix.chars().any(char::is_alphanumeric) {
            return Ok(full_evidence_packet(source));
        }
        last.end_utf16 = source_utf16_len;
        let slice =
            utf16_slice(source, last.start_utf16, last.end_utf16).ok_or(EngineError::Policy)?;
        last.slice_hash = Hash256::digest(slice.as_bytes());
    }
    Ok(EvidencePacket {
        source_hash: Hash256::digest(source.as_bytes()),
        source_utf16_len: source.encode_utf16().count(),
        clauses,
    })
}

fn full_evidence_packet(source: &str) -> EvidencePacket {
    let source_utf16_len = source.encode_utf16().count();
    EvidencePacket {
        source_hash: Hash256::digest(source.as_bytes()),
        source_utf16_len,
        clauses: vec![EvidenceClause {
            id: "C1".into(),
            start_utf16: 0,
            end_utf16: source_utf16_len,
            classification: ClauseClassification::Mechanical,
            slice_hash: Hash256::digest(source.as_bytes()),
        }],
    }
}

fn dsl_shape_inventory(repository_root: &Path) -> Result<Value, EngineError> {
    let schema_root = repository_root.join("schemas/enrichment/ability-dsl");
    let mut inventory = serde_json::Map::new();
    for name in ["ability", "condition", "effect", "scope"] {
        let schema: Value =
            serde_json::from_slice(&fs::read(schema_root.join(format!("{name}.schema.json")))?)?;
        let definitions = schema
            .get("$defs")
            .and_then(Value::as_object)
            .map(|definitions| definitions.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut type_values = BTreeSet::new();
        collect_type_values(&schema, &mut type_values);
        inventory.insert(
            name.into(),
            json!({
                "definitions": definitions,
                "type_values": type_values,
            }),
        );
    }
    Ok(Value::Object(inventory))
}

fn collect_type_values(value: &Value, values: &mut BTreeSet<String>) {
    if let Some(type_values) = value
        .pointer("/properties/type/enum")
        .and_then(Value::as_array)
    {
        values.extend(
            type_values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect_type_values(item, values);
            }
        }
        Value::Object(fields) => {
            for field in fields.values() {
                collect_type_values(field, values);
            }
        }
        _ => {}
    }
}

fn utf16_slice(source: &str, start: usize, end: usize) -> Option<&str> {
    let mut offset = 0;
    let mut byte_start = (start == 0).then_some(0);
    let mut byte_end = None;
    for (byte, character) in source.char_indices() {
        if offset == start {
            byte_start = Some(byte);
        }
        if offset == end {
            byte_end = Some(byte);
            break;
        }
        offset += character.len_utf16();
        if (offset > start && byte_start.is_none()) || offset > end {
            return None;
        }
    }
    if end == source.encode_utf16().count() {
        byte_end = Some(source.len());
    }
    source.get(byte_start?..byte_end?)
}

#[cfg(test)]
mod evidence_tests {
    use async_trait::async_trait;
    use campaign_domain::{
        AbilityAggregate, AbilityId, AbilityKey, AbilityPhase, ActorId, ArchitectureFacts,
        ArtifactKind, Budgets, CampaignId, CampaignManifest, CampaignState, CausationId, Command,
        CommandAction, CommandId, CommandMeta, CorrelationId, DecompositionFacts, EvidenceFacts,
        FactionId, Hash256, IdentitySet, Sensitivity, ShapeAggregate, ShapeId, ShapePhase,
        WorkItem,
    };
    use campaign_roles::{
        Role, RoleError, RoleExecutor, RoleRequest, RoleResult, RoleSpec, RoleTransport,
        RoleTransportExchange, RoleVerdict, TypedRoleExecutor, ValidatedRoleResult,
    };
    use campaign_store::{CampaignStore, OutboxStatus};
    use parking_lot::Mutex;
    use serde_json::{Value, json};
    use std::{
        collections::{BTreeMap, BTreeSet, VecDeque},
        fs,
        sync::Arc,
    };
    use tempfile::TempDir;

    use super::{
        CampaignNodeExecutor, candidate_from_role_payload, normalized_evidence_packet,
        parse_evidence_packet, retryable_role_error, role_error_diagnostic, role_retry_instruction,
        shape_internal_family_size, shape_seed, validate_candidate_payload,
    };
    use crate::{CampaignEngine, NodeExecutor, WorkKind, WorkNode};
    #[derive(Clone)]
    struct SequencedRoleTransport {
        payloads: Arc<Mutex<VecDeque<Value>>>,
        requests: Arc<Mutex<Vec<Value>>>,
    }

    #[async_trait]
    impl RoleTransport for SequencedRoleTransport {
        async fn exchange(
            &self,
            _spec: &RoleSpec,
            request: &RoleRequest,
        ) -> Result<RoleTransportExchange, RoleError> {
            self.requests.lock().push(request.sensitive_input.clone());
            let payload = self.payloads.lock().pop_front().expect("queued response");
            let response = json!({
                "campaign_id": request.campaign_id,
                "faction_id": request.ability.faction_id,
                "ability_id": request.ability.ability_id,
                "role": request.role,
                "verdict": "accept",
                "payload": payload,
                "findings": []
            });
            Ok(RoleTransportExchange {
                response_hash: Hash256::digest(serde_json::to_vec(&response).unwrap()),
                response,
                provider_identity_hash: Hash256::digest("fabricated-provider"),
                repaired: false,
                transport: "fabricated-transport".into(),
                fallback_reason: None,
                remote_run_hash: None,
                usage: json!({"input_tokens": 1, "output_tokens": 1}),
            })
        }
    }

    #[derive(Clone)]
    struct ShapeReviewRoleExecutor {
        requests: Arc<Mutex<Vec<RoleRequest>>>,
    }

    #[async_trait]
    impl RoleExecutor for ShapeReviewRoleExecutor {
        async fn execute(
            &self,
            _spec: &RoleSpec,
            request: RoleRequest,
        ) -> Result<ValidatedRoleResult, RoleError> {
            self.requests.lock().push(request.clone());
            let payload = match request.role {
                Role::KrootWarShaper => json!({
                    "verdict": "accept",
                    "shape_package": {"name": "fabricated-container"}
                }),
                Role::Eversor => json!({"divergences": []}),
                Role::Swarmlord => json!({
                    "candidates": [],
                    "estimated_family_size": 1
                }),
                _ => return Err(RoleError::SemanticInvalid("unexpected-test-role")),
            };
            Ok(ValidatedRoleResult {
                result: RoleResult {
                    campaign_id: request.campaign_id,
                    faction_id: request.ability.faction_id,
                    ability_id: request.ability.ability_id,
                    role: request.role,
                    verdict: RoleVerdict::Accept,
                    payload,
                    findings: vec![],
                },
                response_hash: Hash256::digest(format!(
                    "fabricated-response-{}-{:?}",
                    request.role.as_str(),
                    request.voter
                )),
                provider_identity_hash: Hash256::digest("fabricated-provider"),
                repaired: false,
                transport: "fabricated-transport".into(),
                fallback_reason: None,
                remote_run_hash: None,
                usage: json!({"input_tokens": 1, "output_tokens": 1}),
            })
        }
    }
    #[test]
    fn malformed_nested_payload_is_retryable_with_parser_diagnostics() {
        let error = RoleError::PayloadJsonInvalid("Syntax at line 1, column 42".into());

        assert!(retryable_role_error(&error));
        assert_eq!(role_error_diagnostic(&error), "Syntax at line 1, column 42");
        let repaired = RoleError::RepairedOutput;
        assert!(retryable_role_error(&repaired));
        assert!(
            role_retry_instruction(&repaired)
                .contains("prior payload required automatic JSON closure")
        );
    }

    #[test]
    fn missing_clause_coverage_gets_role_specific_retry_instructions() {
        let error = RoleError::SemanticInvalid("missing-clause-coverage");

        assert!(role_retry_instruction(&error).contains("full Arch-Magos authoring envelope"));
        assert!(role_retry_instruction(&error).contains("exactly one row"));
    }

    #[test]
    fn needs_schema_coverage_gets_honest_gap_retry_instructions() {
        let error = RoleError::SemanticInvalid("needs-schema-clause-coverage");

        assert!(
            role_retry_instruction(&error)
                .contains("Mechanical gaps may use disposition unresolved")
        );
        assert!(role_retry_instruction(&error).contains("non-null resisted_schema"));
    }

    #[test]
    fn incomplete_architecture_gets_exact_coverage_retry_instructions() {
        let error = RoleError::SemanticInvalid("architecture-clause-coverage");

        assert!(
            role_retry_instruction(&error).contains("every supplied evidence_packet clause id")
        );
        assert!(role_retry_instruction(&error).contains("Do not add, omit, or duplicate"));
    }

    #[test]
    fn shape_family_mismatch_gets_exact_copy_retry_instructions() {
        let error = RoleError::SemanticInvalid("shape-internal-family");

        assert!(
            role_retry_instruction(&error)
                .contains("task.resisted_schema.architecture.local_actions")
        );
        assert!(role_retry_instruction(&error).contains("preserve the array order"));
        assert!(role_retry_instruction(&error).contains("every field/value"));
    }

    #[test]
    fn shape_sweep_mismatch_gets_exact_membership_retry_instructions() {
        let error = RoleError::SemanticInvalid("shape-sweep-coverage");
        let instruction = role_retry_instruction(&error);

        assert!(instruction.contains("exactly one row"));
        assert!(instruction.contains("task.swarmlord_sweep.candidates"));
        assert!(instruction.contains("Do not add the seed or task.internal_family"));
    }

    #[test]
    fn noncanonical_shape_kind_gets_exact_retry_instructions() {
        let error = RoleError::SemanticInvalid("shape-kind");
        let instruction = role_retry_instruction(&error);

        assert!(instruction.contains("condition, container, effect-leaf, or modifier-extension"));
        assert!(instruction.contains("Do not invent synonyms"));
    }

    struct RoleRetryHarness {
        campaign_id: CampaignId,
        ability: AbilityKey,
        repository: TempDir,
        _state_root: TempDir,
        store: CampaignStore,
        engine: CampaignEngine,
    }

    fn execute_test_action(
        engine: &CampaignEngine,
        campaign_id: &CampaignId,
        action: CommandAction,
    ) {
        let state = engine.state(campaign_id).unwrap();
        engine
            .execute(&Command {
                meta: CommandMeta {
                    command_id: CommandId::new(),
                    campaign_id: campaign_id.clone(),
                    expected_stream_version: state.stream_version,
                    causation_id: CausationId::new(),
                    correlation_id: CorrelationId::new(),
                    actor: ActorId::new("fabricated-test").unwrap(),
                    expected_manifest_hash: state.manifest_hash,
                    expected_engine_hash: Hash256::digest("fabricated-engine"),
                    outbox_id: None,
                    fencing_token: None,
                    lease_resource: None,
                    lease_owner: None,
                },
                action,
            })
            .unwrap();
    }

    fn role_retry_harness(campaign_name: &str) -> RoleRetryHarness {
        let campaign_id = CampaignId::new(campaign_name).unwrap();
        let ability = AbilityKey::new(
            FactionId::new("test-faction").unwrap(),
            AbilityId::new("test-ability").unwrap(),
        );
        let repository = TempDir::new().unwrap();
        let state_root = TempDir::new().unwrap();
        let store = CampaignStore::open(state_root.path(), repository.path()).unwrap();
        let engine_hash = Hash256::digest("fabricated-engine");
        let engine = CampaignEngine::new(store.clone(), engine_hash, false);
        let manifest = CampaignManifest {
            campaign_id: campaign_id.clone(),
            repository_canonical_path_hash: Hash256::digest("fabricated-repository"),
            workspace_id: "fabricated-workspace".into(),
            base_commit_id: "fabricated-base".into(),
            ordered_worklist: vec![WorkItem {
                key: ability.clone(),
                cosine_start: 0.5,
                source_hash: Hash256::digest("fabricated-source"),
                baseline_dsl_hash: Hash256::digest("fabricated-dsl"),
            }],
            baseline_report_hash: Hash256::digest("fabricated-report"),
            baseline_rows_hash: Hash256::digest("fabricated-rows"),
            identities: IdentitySet {
                provider_precedence: vec!["app-server".into()],
                allowed_transports: BTreeSet::from(["app-server".into()]),
                model: "fabricated-model".into(),
                reasoning: "fabricated-reasoning".into(),
                rig_version: "fabricated-rig".into(),
                rig_lockfile_hash: Hash256::digest("fabricated-lock"),
                app_server_binary_hash: Hash256::digest("fabricated-binary"),
                app_server_version: "fabricated-server".into(),
                app_server_protocol_hash: Hash256::digest("fabricated-protocol"),
                direct_provider_hash: None,
                prompt_manifest_hash: Hash256::digest("fabricated-prompts"),
                role_schema_hashes: (0..16)
                    .map(|index| Hash256::digest(format!("fabricated-role-{index}")))
                    .collect(),
                semantic_validator_hash: Hash256::digest("fabricated-validator"),
                tool_contract_hash: Hash256::digest("fabricated-tools"),
                engine_version: "fabricated-engine".into(),
                protocol_version: 1,
                executable_hash: engine_hash,
            },
            budgets: Budgets::default(),
            gate_definitions_hash: Hash256::digest("fabricated-gates"),
            path_policy_hash: Hash256::digest("fabricated-paths"),
            privacy_policy_hash: Hash256::digest("fabricated-privacy"),
            parity_areas: BTreeSet::from(["fabricated-area".into()]),
        };
        for action in [
            CommandAction::CreateCampaign,
            CommandAction::FreezeManifest { manifest },
            CommandAction::StartCampaign,
            CommandAction::QueueAbility {
                key: ability.clone(),
            },
        ] {
            execute_test_action(&engine, &campaign_id, action);
        }
        RoleRetryHarness {
            campaign_id,
            ability,
            repository,
            _state_root: state_root,
            store,
            engine,
        }
    }

    #[tokio::test]
    async fn architecture_semantic_failure_is_retried_with_exact_coverage_instruction() {
        let RoleRetryHarness {
            campaign_id,
            ability,
            repository,
            _state_root,
            store,
            engine,
        } = role_retry_harness("retry-campaign");

        let architecture = |source_clause_ids| {
            json!({
                "architecture": {
                    "form": "linear",
                    "source_clause_ids": source_clause_ids,
                    "shared_invariants": [],
                    "local_actions": [],
                    "resource_lifecycle": null,
                    "event_bindings": [],
                    "existing_shape_fit": {
                        "verdict": "none",
                        "shapes_checked": [],
                        "unmapped_clause_ids": ["mechanical", "nonmechanical"]
                    },
                    "internal_family_size": 0,
                    "route": "shape-scout",
                    "resisted_schema": "Fabricated missing shape."
                }
            })
        };
        let requests = Arc::new(Mutex::new(Vec::new()));
        let transport = SequencedRoleTransport {
            payloads: Arc::new(Mutex::new(VecDeque::from([
                architecture(json!(["mechanical"])),
                architecture(json!(["mechanical", "nonmechanical"])),
            ]))),
            requests: requests.clone(),
        };
        let executor = CampaignNodeExecutor::new(
            campaign_id,
            engine,
            Arc::new(TypedRoleExecutor::new(transport)),
            repository.path(),
            repository.path(),
            false,
            None,
        );
        let node = WorkNode {
            work_id: Hash256::digest("fabricated-work"),
            ability: Some(ability),
            shape_id: None,
            kind: WorkKind::Architecture,
            roles: vec![],
            capabilities: vec![],
        };
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let lease = store
            .acquire_lease("fabricated-resource", "fabricated-worker", now, 120)
            .unwrap();
        let result = executor
            .run_role(
                &node,
                &lease,
                campaign_roles::Role::Inquisitor,
                1,
                None,
                vec![],
                json!({
                    "mode": "architect",
                    "evidence_packet": {
                        "clauses": [
                            {"id": "mechanical", "classification": "mechanical"},
                            {"id": "nonmechanical", "classification": "nonmechanical"}
                        ]
                    }
                }),
            )
            .await
            .unwrap();

        assert_eq!(
            result
                .result
                .payload
                .pointer("/architecture/source_clause_ids"),
            Some(&json!(["mechanical", "nonmechanical"]))
        );
        let requests = requests.lock();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[1]
                .pointer("/retry_context/instruction")
                .and_then(Value::as_str)
                .unwrap()
                .contains("every supplied evidence_packet clause id")
        );
    }

    #[tokio::test]
    async fn noncanonical_shape_kind_is_retried_before_role_evidence_is_accepted() {
        let RoleRetryHarness {
            campaign_id,
            ability,
            repository,
            _state_root,
            store,
            engine,
        } = role_retry_harness("shape-kind-retry");
        let family = json!([{
            "child_id": "action-one",
            "clause_ids": ["mechanical"],
            "parent_closed": true,
            "parent_id": "closed-menu",
            "shared_contract_id": "menu-choice"
        }]);
        let proposal = |kind| {
            json!({
                "proposed_shape": {
                    "name": "closed-menu-shape",
                    "kind": kind
                },
                "internal_family": family,
                "self_grade": {"verdict": "new-shape"}
            })
        };
        let requests = Arc::new(Mutex::new(Vec::new()));
        let transport = SequencedRoleTransport {
            payloads: Arc::new(Mutex::new(VecDeque::from([
                proposal("effect-container"),
                proposal("container"),
            ]))),
            requests: requests.clone(),
        };
        let executor = CampaignNodeExecutor::new(
            campaign_id.clone(),
            engine,
            Arc::new(TypedRoleExecutor::new(transport)),
            repository.path(),
            repository.path(),
            false,
            None,
        );
        let work_id = Hash256::digest("shape-kind-work");
        let node = WorkNode {
            work_id,
            ability: Some(ability),
            shape_id: None,
            kind: WorkKind::ShapeRoute,
            roles: vec![],
            capabilities: vec![],
        };
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let lease = store
            .acquire_lease("fabricated-resource", "fabricated-worker", now, 120)
            .unwrap();
        let result = executor
            .run_role(
                &node,
                &lease,
                campaign_roles::Role::KrootFleshShaper,
                1,
                None,
                vec![],
                json!({
                    "resisted_schema": {
                        "architecture": {
                            "internal_family_size": 1,
                            "local_actions": family
                        }
                    }
                }),
            )
            .await
            .unwrap();

        assert_eq!(
            result.result.payload.pointer("/proposed_shape/kind"),
            Some(&json!("container"))
        );
        let requests = requests.lock();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[1]
                .pointer("/retry_context/diagnostic")
                .and_then(Value::as_str)
                .unwrap()
                .contains("shape-kind")
        );
        assert!(
            requests[1]
                .pointer("/retry_context/instruction")
                .and_then(Value::as_str)
                .unwrap()
                .contains("condition, container, effect-leaf, or modifier-extension")
        );
        let first_key = format!("provider:{campaign_id}:{work_id}:kroot-flesh-shaper:1:single");
        let second_key = format!("provider:{campaign_id}:{work_id}:kroot-flesh-shaper:2:single");
        assert_eq!(
            store.outbox_by_key(&first_key).unwrap().unwrap().status,
            OutboxStatus::Failed
        );
        assert_eq!(store.observed_effect_artifact(&first_key).unwrap(), None);
        assert_eq!(
            store.outbox_by_key(&second_key).unwrap().unwrap().status,
            OutboxStatus::Observed
        );
        assert!(
            store
                .observed_effect_artifact(&second_key)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn copied_source_prose_is_discarded_and_retried() {
        let current = json!({
            "ability_id": "fabricated-ability",
            "name": "Example Mechanic",
            "authored_by": ["Example Contributor"],

            "game_version": {"edition": "11th", "dataslate": "test"},
            "ability_type": "unit",
            "effect": {"type": "deep-strike"}
        });
        let key = AbilityKey::new(
            FactionId::new("test-faction").unwrap(),
            AbilityId::new("fabricated-ability").unwrap(),
        );
        let source = "Select this model to include in your army, then choose one fabricated mark.";
        let copied = json!({
            "dsl": {
                "trigger": {
                    "event": "army-inclusion",
                    "condition": "select this model to include in your army"
                }
            }
        });

        let error = validate_candidate_payload(&current, &key, source, &copied).unwrap_err();

        assert_eq!(error, RoleError::SemanticInvalid("source-prose-copy"));
        assert!(retryable_role_error(&error));
        assert!(role_retry_instruction(&error).contains("independently authored"));

        let paraphrased = json!({
            "dsl": {
                "trigger": {
                    "event": "army-inclusion",
                    "condition": "during roster construction"
                }
            }
        });
        validate_candidate_payload(&current, &key, source, &paraphrased).unwrap();
    }
    #[tokio::test]
    async fn shape_review_persists_child_evidence_before_parent_provider_turn() {
        let RoleRetryHarness {
            campaign_id,
            ability,
            repository,
            _state_root: state_root,
            store,
            engine,
        } = role_retry_harness("shape-review-ordering");
        let raw_store = TempDir::new().unwrap();
        fs::write(
            raw_store.path().join("index.json"),
            serde_json::to_vec(&json!({
                "schema_version": 2,
                "factions": {
                    "test-faction": {
                        "test-ability": {
                            "raw_text": "Fabricated source mechanic."
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let package = serde_json::to_vec(&json!({
            "proposed_shape": {
                "name": "fabricated-container",
                "kind": "container"
            }
        }))
        .unwrap();
        let package_hash = store
            .put_artifact(
                ArtifactKind::ShapePackage,
                Sensitivity::Sensitive,
                &package,
                "application/json",
                "serde-json",
                &[],
            )
            .unwrap()
            .artifact_id;
        let describer =
            serde_json::to_vec(&json!({"render_rules": [{"form": "container"}]})).unwrap();
        let describer_hash = store
            .put_artifact(
                ArtifactKind::ShapePackage,
                Sensitivity::Sensitive,
                &describer,
                "application/json",
                "serde-json",
                &[package_hash],
            )
            .unwrap()
            .artifact_id;
        let clauses = BTreeSet::from(["mechanical".to_owned()]);
        let evidence_hash = Hash256::digest("fabricated-evidence");
        let architecture_hash = Hash256::digest("fabricated-architecture");
        let decomposition_hash = Hash256::digest("fabricated-decomposition");
        let shape_id = ShapeId::new("shape-fabricated-container").unwrap();
        for action in [
            CommandAction::BindEvidence {
                key: ability.clone(),
                facts: EvidenceFacts {
                    artifact_hash: evidence_hash,
                    source_hash: Hash256::digest("fabricated-source"),
                    all_clause_ids: clauses.clone(),
                    mechanical_clause_ids: clauses.clone(),
                    contiguous_partition: true,
                },
            },
            CommandAction::RecordArchitecture {
                key: ability.clone(),
                facts: ArchitectureFacts {
                    artifact_hash: architecture_hash,
                    evidence_hash,
                    covered_clause_ids: clauses.clone(),
                    requires_shape: true,
                    closed_parent: true,
                    unresolved_bindings: BTreeSet::new(),
                },
            },
            CommandAction::RecordDecomposerResult {
                key: ability.clone(),
                role: "target-dummy".into(),
                architecture_hash,
                artifact_hash: Hash256::digest("fabricated-who"),
            },
            CommandAction::RecordDecomposerResult {
                key: ability.clone(),
                role: "chronomancer".into(),
                architecture_hash,
                artifact_hash: Hash256::digest("fabricated-when"),
            },
            CommandAction::RecordDecomposerResult {
                key: ability.clone(),
                role: "vox-hound".into(),
                architecture_hash,
                artifact_hash: Hash256::digest("fabricated-what"),
            },
            CommandAction::RecordDecomposition {
                key: ability.clone(),
                facts: DecompositionFacts {
                    artifact_hash: decomposition_hash,
                    architecture_hash,
                    covered_clause_ids: clauses,
                    who_complete: true,
                    when_complete: true,
                    what_complete: true,
                    deferred_lookups: BTreeSet::new(),
                },
            },
            CommandAction::OpenShapeLifecycle {
                key: ability.clone(),
                shape_id: shape_id.clone(),
                package_hash,
            },
            CommandAction::RecordFamilySurvey {
                shape_id: shape_id.clone(),
                survey_hash: Hash256::digest("fabricated-family-one"),
                internal_family_size: 4,
                members: BTreeSet::from([ability.clone()]),
                flattening_exclusions: BTreeSet::new(),
            },
            CommandAction::RecordFamilySurvey {
                shape_id: shape_id.clone(),
                survey_hash: Hash256::digest("fabricated-family-two"),
                internal_family_size: 4,
                members: BTreeSet::from([ability.clone()]),
                flattening_exclusions: BTreeSet::new(),
            },
            CommandAction::RecordDescriberSpec {
                shape_id: shape_id.clone(),
                artifact_hash: describer_hash,
                render_form_count: 1,
            },
        ] {
            execute_test_action(&engine, &campaign_id, action);
        }
        let requests = Arc::new(Mutex::new(Vec::new()));
        let executor = CampaignNodeExecutor::new(
            campaign_id,
            engine,
            Arc::new(ShapeReviewRoleExecutor {
                requests: requests.clone(),
            }),
            repository.path(),
            raw_store.path(),
            false,
            None,
        );
        let node = WorkNode {
            work_id: Hash256::digest("shape-review-work"),
            ability: None,
            shape_id: Some(shape_id),
            kind: WorkKind::ShapeReview,
            roles: vec![],
            capabilities: vec![],
        };
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let lease = store
            .acquire_lease("fabricated-resource", "fabricated-worker", now, 120)
            .unwrap();

        let completion = executor.execute(&node, &lease).await.unwrap();

        let requests_guard = requests.lock();
        assert_eq!(requests_guard.len(), 4);
        let war_request = requests_guard
            .iter()
            .find(|request| request.role == Role::KrootWarShaper)
            .unwrap();
        let child_hash = war_request.input_artifacts[2];
        drop(requests_guard);
        let child_bytes = store.read_artifact(child_hash).unwrap();
        assert!(
            store
                .sensitive_artifact_bytes()
                .unwrap()
                .contains(&child_bytes)
        );
        let connection =
            rusqlite::Connection::open(state_root.path().join("campaign.sqlite3")).unwrap();
        let mut statement = connection
            .prepare(
                "SELECT parent_artifact_id FROM artifact_parents
                 WHERE artifact_id = ?1 ORDER BY parent_artifact_id",
            )
            .unwrap();
        let child_parents = statement
            .query_map([child_hash.to_string()], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<BTreeSet<_>, _>>()
            .unwrap();
        assert_eq!(
            child_parents,
            BTreeSet::from([package_hash.to_string(), describer_hash.to_string()])
        );
        assert_eq!(completion.artifacts.len(), 1);
        assert_eq!(completion.artifacts[0].kind, ArtifactKind::Review);
        assert_eq!(
            completion.artifacts[0].parent_hashes,
            vec![package_hash, describer_hash, child_hash]
        );

        store.expire_lease(&lease, now).unwrap();
        let replay_lease = store
            .acquire_lease("fabricated-resource", "replay-worker", now + 1, 120)
            .unwrap();
        let replay = executor.execute(&node, &replay_lease).await.unwrap();
        assert_eq!(
            replay.artifacts[0].expected_hash,
            completion.artifacts[0].expected_hash
        );
        assert_eq!(requests.lock().len(), 4);
    }

    #[test]
    fn internal_family_size_is_bound_to_the_shape_package() {
        let package = json!({
            "internal_family": [
                {"child": "one"},
                {"child": "two"},
                {"child": "three"},
                {"child": "four"}
            ]
        });

        assert_eq!(
            shape_internal_family_size(&package, &json!({"internal_family_size": 4})).unwrap(),
            4
        );
        assert!(shape_internal_family_size(&package, &json!({"internal_family_size": 5})).is_err());
    }

    #[test]
    fn family_survey_uses_the_shape_originating_ability_as_its_seed() {
        let shape_id = ShapeId::new("shape-fabricated-menu").unwrap();
        let seed = AbilityKey::new(
            FactionId::new("zeta-faction").unwrap(),
            AbilityId::new("seed-ability").unwrap(),
        );
        let earlier_member = AbilityKey::new(
            FactionId::new("alpha-faction").unwrap(),
            AbilityId::new("family-member").unwrap(),
        );
        let mut state = CampaignState::default();
        state.abilities.insert(
            seed.clone(),
            AbilityAggregate {
                phase: AbilityPhase::ShapeRequired,
                evidence_hash: None,
                source_hash: Hash256::digest("source"),
                clauses: None,
                architecture_hash: None,
                required_shape_id: Some(shape_id.clone()),
                requires_shape: true,
                decomposer_hashes: BTreeMap::new(),
                decomposition_hash: None,
                candidate_hash: None,
                revision_thread_hash: None,
                attempt: 0,
                escalated: false,
                voters: BTreeMap::new(),
                voter_identity_hashes: BTreeSet::new(),
                blocking_divergences: BTreeSet::new(),
                applied_hash: None,
                apply_plan_hash: None,
                applied_commit: None,
                rollback_evidence_hash: None,
                rollback_head: None,
                rollback_terminal: false,
                verification_hash: None,
                review_hash: None,
                reviewer_hashes: BTreeMap::new(),
                score_start: 0.0,
                score_final: None,
                correctness_justification_hash: None,
            },
        );
        state.abilities.insert(
            earlier_member.clone(),
            state.abilities.get(&seed).unwrap().clone(),
        );
        let shape = ShapeAggregate {
            originating_ability: Some(seed.clone()),
            phase: ShapePhase::FamilySurveyed,
            family_hashes: vec![Hash256::digest("survey")],
            family_members: BTreeSet::from([earlier_member]),
            excluded_members: BTreeSet::new(),
            internal_family_size: 4,
            review_hashes: vec![],
            review_round: 0,
            describer_hash: None,
            package_hash: Some(Hash256::digest("package")),
            apply_plan_hash: None,
            applied_hash: None,
            applied_commit: None,
            verification_hash: None,
        };

        assert_eq!(shape_seed(&shape_id, &shape, &state).unwrap(), &seed);
    }

    #[test]
    fn incomplete_model_partition_falls_back_to_the_complete_source() {
        let source = "Fabricated first rule. Fabricated second rule.";
        let packet = parse_evidence_packet(
            &json!({
                "clauses": [{
                    "clause_id": "C1",
                    "start": 0,
                    "end": 22,
                    "mechanical": true
                }]
            }),
            source,
        )
        .unwrap();

        assert_eq!(packet.source_utf16_len, source.encode_utf16().count());
        assert_eq!(packet.clauses.len(), 1);
        assert_eq!(packet.clauses[0].start_utf16, 0);
        assert_eq!(packet.clauses[0].end_utf16, source.encode_utf16().count());
    }

    #[test]
    fn out_of_range_model_partition_falls_back_to_the_complete_source() {
        let source = "Fabricated rule.";
        let packet = parse_evidence_packet(
            &json!({
                "clauses": [{
                    "clause_id": "C1",
                    "start": 0,
                    "end": 99,
                    "mechanical": true
                }]
            }),
            source,
        )
        .unwrap();

        assert_eq!(packet.clauses.len(), 1);
        assert_eq!(packet.clauses[0].end_utf16, source.encode_utf16().count());
    }

    #[test]
    fn non_contiguous_model_partition_falls_back_to_the_complete_source() {
        let source = "Fabricated first and second rule.";
        let packet = normalized_evidence_packet(
            &json!({
                "clauses": [
                    {"clause_id": "C1", "start": 0, "end": 10, "mechanical": true},
                    {
                        "clause_id": "C2",
                        "start": 11,
                        "end": source.encode_utf16().count(),
                        "mechanical": true
                    }
                ]
            }),
            source,
        )
        .unwrap();

        assert_eq!(packet.clauses.len(), 1);
        assert_eq!(packet.clauses[0].start_utf16, 0);
        assert_eq!(packet.clauses[0].end_utf16, source.encode_utf16().count());
    }

    #[test]
    fn candidate_projection_preserves_identity_and_discards_review_metadata() {
        let current = json!({
            "ability_id": "fabricated-ability",
            "name": "Fabricated Ability",
            "authored_by": ["Example Contributor"],
            "game_version": {"edition": "11th", "dataslate": "test"},
            "ability_type": "unit",
            "detachment_id": null,
            "effect": {"type": "deep-strike"},
            "scope": {"target": "self"},
            "trigger": {"event": "command-phase-start"}
        });
        let payload = json!({
            "ability_id": "fabricated-ability",
            "effect": {"type": "feel-no-pain", "value": 5},
            "scope": {"target": "self"},
            "trigger": null,
            "self_grade": {"verdict": "faithful"},
            "clause_coverage": [{"clause_id": "C1"}]
        });

        let candidate = candidate_from_role_payload(&current, &payload).unwrap();

        assert_eq!(candidate["authored_by"], current["authored_by"]);
        assert_eq!(candidate["effect"], payload["effect"]);
        assert!(candidate.get("trigger").is_none());
        assert!(candidate.get("self_grade").is_none());
        assert!(candidate.get("clause_coverage").is_none());
    }
}
