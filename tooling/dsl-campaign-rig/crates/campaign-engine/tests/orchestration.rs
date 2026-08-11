use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use async_trait::async_trait;
use campaign_domain::{
    AbilityAggregate, AbilityId, AbilityKey, AbilityPhase, ActorId, CampaignId, CampaignManifest,
    CampaignPhase, CampaignState, CausationId, Command, CommandAction, CommandId, CommandMeta,
    CorrelationId, Hash256, IdentitySet, WorkItem,
};
use campaign_engine::{
    CampaignEngine, CloseEvidence, EngineError, NodeExecutor, WorkCompletion, WorkKind, WorkNode,
    Worker, import_omp_evidence, ready_work, validate_close,
};
use campaign_executors::{ParityAreaResult, SIX_PAIRS};
use campaign_store::{CampaignStore, Lease};

fn hash(label: &str) -> Hash256 {
    Hash256::digest(label.as_bytes())
}

fn key(name: &str) -> AbilityKey {
    AbilityKey::new(
        campaign_domain::FactionId::new("sample-faction").unwrap(),
        AbilityId::new(name).unwrap(),
    )
}

fn manifest(keys: Vec<AbilityKey>) -> CampaignManifest {
    CampaignManifest {
        campaign_id: CampaignId::new("sample-campaign").unwrap(),
        repository_canonical_path_hash: hash("repository"),
        workspace_id: "sample-workspace".into(),
        base_commit_id: "base-commit".into(),
        ordered_worklist: keys
            .into_iter()
            .enumerate()
            .map(|(index, key)| WorkItem {
                key,
                cosine_start: index as f64,
                source_hash: hash("source"),
                baseline_dsl_hash: hash("baseline"),
            })
            .collect(),
        baseline_report_hash: hash("report"),
        baseline_rows_hash: hash("rows"),
        identities: IdentitySet {
            provider_precedence: vec!["app-server".into()],
            allowed_transports: BTreeSet::from(["app-server".into()]),
            model: "sample-model".into(),
            reasoning: "sample-reasoning".into(),
            rig_version: "sample-rig".into(),
            rig_lockfile_hash: hash("lock"),
            app_server_binary_hash: hash("binary"),
            app_server_version: "sample-server".into(),
            app_server_protocol_hash: hash("protocol"),
            direct_provider_hash: None,
            prompt_manifest_hash: hash("prompts"),
            role_schema_hashes: (0..16)
                .map(|index| hash(&format!("role-{index}")))
                .collect(),
            semantic_validator_hash: hash("validator"),
            tool_contract_hash: hash("tools"),
            engine_version: "sample-engine".into(),
            protocol_version: 1,
            executable_hash: hash("engine"),
        },
        budgets: Default::default(),
        gate_definitions_hash: hash("gates"),
        path_policy_hash: hash("paths"),
        privacy_policy_hash: hash("privacy"),
        parity_areas: BTreeSet::from(["core".into()]),
    }
}

fn ability(phase: AbilityPhase) -> AbilityAggregate {
    AbilityAggregate {
        phase,
        evidence_hash: None,
        source_hash: hash("source"),
        clauses: None,
        architecture_hash: None,
        required_shape_id: None,
        requires_shape: false,
        decomposer_hashes: BTreeMap::new(),
        decomposition_hash: None,
        candidate_hash: None,
        revision_thread_hash: None,
        attempt: 0,
        escalated: false,
        voters: BTreeMap::new(),
        voter_identity_hashes: BTreeSet::new(),
        blocking_divergences: BTreeSet::new(),
        rollback_evidence_hash: None,
        rollback_head: None,
        rollback_terminal: false,
        applied_hash: None,
        apply_plan_hash: None,
        applied_commit: None,
        verification_hash: None,
        review_hash: None,
        reviewer_hashes: BTreeMap::new(),
        score_start: 0.5,
        score_final: None,
        correctness_justification_hash: None,
    }
}

fn state_with(keys: Vec<(AbilityKey, AbilityPhase)>, phase: CampaignPhase) -> CampaignState {
    let ordered_keys = keys.iter().map(|(key, _)| key.clone()).collect();
    CampaignState {
        campaign_id: Some(CampaignId::new("sample-campaign").unwrap()),
        phase,
        stream_version: 7,
        manifest: Some(manifest(ordered_keys)),
        manifest_hash: Some(hash("manifest")),
        repository_head: Some("base-commit".into()),
        abilities: keys
            .into_iter()
            .map(|(key, phase)| (key, ability(phase)))
            .collect(),
        shapes: BTreeMap::new(),
        gate_runs: 0,
        close_gate_runs: 0,
        sealed_base: Some("base-commit".into()),
        sealed_head: Some("sealed-head".into()),
        close_verification_hash: None,
        publication_authorized_head: None,
        publication_effect_hash: None,
    }
}

#[test]
fn scheduler_prioritizes_manifest_order_and_stalls_apply_in_read_only_mode() {
    let first = key("first");
    let second = key("second");
    let state = state_with(
        vec![
            (first.clone(), AbilityPhase::CandidateAccepted),
            (second.clone(), AbilityPhase::Queued),
        ],
        CampaignPhase::Running,
    );

    let work = ready_work(&state, false);
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].ability, Some(first));
    assert_eq!(work[0].kind, WorkKind::PlanApply);

    let read_only_work = ready_work(&state, true);
    assert_eq!(read_only_work.len(), 1);
    assert_eq!(read_only_work[0].ability, Some(second));
    assert_eq!(read_only_work[0].kind, WorkKind::BindEvidence);

    let applying = state_with(
        vec![(key("only"), AbilityPhase::ApplyRequested)],
        CampaignPhase::Running,
    );
    assert!(ready_work(&applying, true).is_empty());
}

#[test]
fn scheduler_assigns_deterministic_work_ids() {
    let ability_key = key("stable");
    let state = state_with(
        vec![(ability_key.clone(), AbilityPhase::Queued)],
        CampaignPhase::Running,
    );

    let first = ready_work(&state, false);
    let second = ready_work(&state, false);
    assert_eq!(first, second);

    let changed = state_with(
        vec![(ability_key, AbilityPhase::EvidenceBound)],
        CampaignPhase::Running,
    );
    assert_ne!(first[0].work_id, ready_work(&changed, false)[0].work_id);
}

struct TestPaths {
    root: PathBuf,
    repository: PathBuf,
    state: PathBuf,
}

impl TestPaths {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("campaign-engine-test-{}", CommandId::new()));
        let repository = root.join("repository");
        let state = root.join("state");
        fs::create_dir_all(&repository).unwrap();
        Self {
            root,
            repository,
            state,
        }
    }

    fn store(&self) -> CampaignStore {
        CampaignStore::open(&self.state, &self.repository).unwrap()
    }
}

impl Drop for TestPaths {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct FakeNodeExecutor {
    campaign_id: CampaignId,
    engine_hash: Hash256,
    command_id: CommandId,
    wrong_fence: bool,
    observed_fences: Mutex<Vec<u64>>,
}

#[async_trait]
impl NodeExecutor for FakeNodeExecutor {
    async fn execute(
        &self,
        _node: &WorkNode,
        lease: &Lease,
    ) -> Result<WorkCompletion, EngineError> {
        self.observed_fences
            .lock()
            .unwrap()
            .push(lease.fencing_token);
        Ok(WorkCompletion {
            artifacts: vec![],
            follow_up: Command {
                meta: CommandMeta {
                    command_id: self.command_id.clone(),
                    campaign_id: self.campaign_id.clone(),
                    expected_stream_version: 0,
                    causation_id: CausationId::new(),
                    correlation_id: CorrelationId::new(),
                    actor: ActorId::new("test-worker").unwrap(),
                    expected_manifest_hash: None,
                    expected_engine_hash: self.engine_hash,
                    outbox_id: None,
                    fencing_token: Some(lease.fencing_token + u64::from(self.wrong_fence)),
                    lease_resource: Some(lease.resource_key.clone()),
                    lease_owner: Some(lease.owner_id.clone()),
                },
                action: CommandAction::CreateCampaign,
            },
            effect: None,
        })
    }
}

fn test_node() -> WorkNode {
    WorkNode {
        work_id: hash("worker-node"),
        ability: None,
        shape_id: None,
        kind: WorkKind::Seal,
        roles: vec![],
        capabilities: vec![],
    }
}

#[tokio::test]
async fn worker_fences_append_and_retries_are_idempotent_after_a_crash() {
    let paths = TestPaths::new();
    let store = paths.store();
    let engine_hash = hash("engine");
    let campaign_id = CampaignId::new("worker-campaign").unwrap();
    let executor = FakeNodeExecutor {
        campaign_id: campaign_id.clone(),
        engine_hash,
        command_id: CommandId::new(),
        wrong_fence: false,
        observed_fences: Mutex::new(vec![]),
    };
    let engine = CampaignEngine::new(store.clone(), engine_hash, false);
    let worker = Worker {
        engine: &engine,
        campaign_id: campaign_id.clone(),
        executor: &executor,
        owner_id: "owner-a".into(),
        lease_ttl_seconds: 10,
    };

    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    worker.run_node(&test_node(), now).await.unwrap();
    worker.run_node(&test_node(), now + 11).await.unwrap();

    assert_eq!(store.load_events(&campaign_id).unwrap().len(), 1);
    assert_eq!(*executor.observed_fences.lock().unwrap(), vec![1, 2]);

    let stale_executor = FakeNodeExecutor {
        campaign_id: CampaignId::new("stale-campaign").unwrap(),
        engine_hash,
        command_id: CommandId::new(),
        wrong_fence: true,
        observed_fences: Mutex::new(vec![]),
    };
    let stale_engine = CampaignEngine::new(store.clone(), engine_hash, false);
    let stale_worker = Worker {
        engine: &stale_engine,
        campaign_id: CampaignId::new("stale-campaign").unwrap(),
        executor: &stale_executor,
        owner_id: "owner-b".into(),
        lease_ttl_seconds: 10,
    };
    assert!(stale_worker.run_node(&test_node(), now + 22).await.is_err());
    assert!(
        store
            .load_events(&CampaignId::new("stale-campaign").unwrap())
            .unwrap()
            .is_empty()
    );
}

fn valid_close_evidence() -> CloseEvidence {
    let parity_results = SIX_PAIRS
        .into_iter()
        .map(|pair| {
            (
                pair.into(),
                BTreeMap::from([(
                    "core".into(),
                    ParityAreaResult {
                        ok: true,
                        cases_run: 1,
                        skipped: BTreeSet::new(),
                    },
                )]),
            )
        })
        .collect();
    CloseEvidence {
        artifact_hash: hash("close"),
        sealed_base: "base-commit".into(),
        sealed_head: "sealed-head".into(),
        terminal_keys: BTreeSet::from([key("closed")]),
        fixed_gates_passed: true,
        parity_results,
        required_parity_areas: BTreeSet::from(["core".into()]),
        changed_render_keys: BTreeSet::from([key("closed")]),
        target_faction_means: BTreeMap::from([("sample-faction".into(), (0.5, 0.5))]),
        anti_conditions: (1..=10).map(|id| (id, true)).collect(),
        conflict_free: true,
    }
}

#[test]
fn close_validation_rejects_nonterminal_work_incomplete_ledger_gates_parity_and_drift() {
    let state = state_with(
        vec![(key("closed"), AbilityPhase::Converged)],
        CampaignPhase::Sealed,
    );
    let evidence = valid_close_evidence();
    assert!(validate_close(&state, &evidence).is_ok());

    let nonterminal = state_with(
        vec![(key("closed"), AbilityPhase::Queued)],
        CampaignPhase::Sealed,
    );
    assert!(validate_close(&nonterminal, &evidence).is_err());

    let mut incomplete = evidence.clone();
    incomplete.terminal_keys.clear();
    assert!(validate_close(&state, &incomplete).is_err());

    let mut failed_gates = evidence.clone();
    failed_gates.fixed_gates_passed = false;
    assert!(validate_close(&state, &failed_gates).is_err());

    let mut incomplete_parity = evidence.clone();
    incomplete_parity.parity_results.remove("ts,rust");
    assert!(validate_close(&state, &incomplete_parity).is_err());

    let mut drift = evidence;
    drift
        .target_faction_means
        .insert("sample-faction".into(), (0.7, 0.6));
    assert!(validate_close(&state, &drift).is_err());
}

fn write_fixture(root: &Path, name: &str, value: serde_json::Value) -> Hash256 {
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(root.join(name), &bytes).unwrap();
    Hash256::digest(bytes)
}

#[test]
fn legacy_c008_and_c009_evidence_are_not_publishable_and_are_orchestration_failures() {
    let paths = TestPaths::new();
    let evidence_root = paths.root.join("legacy-evidence");
    fs::create_dir_all(&evidence_root).unwrap();
    let c008_hash = write_fixture(
        &evidence_root,
        "c008.json",
        serde_json::json!({ "campaign_id": "c008", "full_gate_runs": 2, "post_repair_full_gate": false }),
    );
    let c009_hash = write_fixture(
        &evidence_root,
        "c009.json",
        serde_json::json!({ "campaign_id": "c009", "application_performed": false, "baseline_render_hash": "same", "updated_render_hash": "same" }),
    );

    let report = import_omp_evidence(&paths.store(), &evidence_root).unwrap();
    assert!(!report.publishable);
    assert!(report.rejected_artifacts.contains(&c008_hash));
    assert!(report.rejected_artifacts.contains(&c009_hash));
    assert!(report.failure_codes.contains("c008-gate-budget-exhausted"));
    assert!(report.failure_codes.contains("c009-orchestration-failure"));
    assert!(!report.failure_codes.contains("no-op-updated"));
}
