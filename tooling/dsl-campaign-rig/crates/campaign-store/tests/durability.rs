use std::path::PathBuf;

use campaign_domain::{
    ActorId, ArtifactKind, CampaignId, Command, CommandAction, CommandId, CommandMeta, DomainError,
    Hash256, Sensitivity,
};
use campaign_store::{CampaignStore, EffectIntent, EffectKind, OutboxStatus, StoreError};
use serde_json::json;
use tempfile::TempDir;

struct StoreFixture {
    _root: TempDir,
    repository_root: PathBuf,
    state_root: PathBuf,
}

impl StoreFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("temporary fixture root");
        let repository_root = root.path().join("fabricated-repository");
        let state_root = root.path().join("external-campaign-state");
        std::fs::create_dir(&repository_root).expect("fabricated repository root");
        Self {
            _root: root,
            repository_root,
            state_root,
        }
    }

    fn open(&self) -> CampaignStore {
        CampaignStore::open(&self.state_root, &self.repository_root).expect("open external store")
    }
}

fn create_campaign(campaign_id: &CampaignId, expected_stream_version: u64) -> Command {
    Command {
        meta: CommandMeta {
            command_id: CommandId::new(),
            campaign_id: campaign_id.clone(),
            expected_stream_version,
            causation_id: CommandId::new(),
            correlation_id: CommandId::new(),
            actor: ActorId::new("test-actor").expect("valid fabricated actor"),
            expected_manifest_hash: None,
            expected_engine_hash: Hash256::digest(b"fabricated-engine"),
            outbox_id: None,
            fencing_token: None,
            lease_resource: None,
            lease_owner: None,
        },
        action: CommandAction::CreateCampaign,
    }
}

fn enqueue(store: &CampaignStore, key: &str, token: u64) {
    store
        .enqueue_effect(
            CommandId::new(),
            "fabricated-command",
            EffectKind::Generate,
            key,
            &json!({"job": "fabricated-output"}),
            token,
            10,
        )
        .expect("enqueue fabricated effect");
}

fn effect_artifact(store: &CampaignStore, bytes: &[u8]) -> Hash256 {
    store
        .put_artifact(
            ArtifactKind::Verification,
            Sensitivity::Deidentified,
            bytes,
            "application/octet-stream",
            "identity",
            &[],
        )
        .unwrap()
        .artifact_id
}

#[test]
fn external_root_is_persistent_and_owner_only_where_supported() {
    let fixture = StoreFixture::new();
    assert!(matches!(
        CampaignStore::open(
            &fixture.repository_root.join("campaign-state"),
            &fixture.repository_root
        ),
        Err(StoreError::RepositoryLocalState)
    ));

    let store = fixture.open();
    let expected_state_root = fixture.state_root.canonicalize().unwrap();
    assert_eq!(store.state_root(), expected_state_root.as_path());
    assert!(store.state_root().join("campaign.sqlite3").is_file());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(store.state_root())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    drop(store);
    assert!(CampaignStore::open(&fixture.state_root, &fixture.repository_root).is_ok());
}

#[test]
fn commands_replay_deduplicate_and_fence_conflicts() {
    let fixture = StoreFixture::new();
    let campaign_id = CampaignId::new("durability-campaign").unwrap();
    let command = create_campaign(&campaign_id, 0);
    let store = fixture.open();

    let effect = EffectIntent {
        outbox_id: CommandId::new(),
        effect_kind: EffectKind::Generate,
        idempotency_key: "creation-command-effect".to_owned(),
        request: json!({"job": "fabricated-output"}),
        fencing_token: 1,
        available_at: 0,
    };
    let receipt = store
        .handle_command_with_effect(&command, &effect)
        .expect("append creation event and effect");
    assert_eq!(receipt.first_sequence, receipt.last_sequence);
    assert_eq!(store.load_events(&campaign_id).unwrap().len(), 1);
    assert_eq!(
        store.handle_command_with_effect(&command, &effect).unwrap(),
        receipt
    );
    assert_eq!(store.load_events(&campaign_id).unwrap().len(), 1);
    assert_eq!(
        store
            .outbox_by_key(&effect.idempotency_key)
            .unwrap()
            .unwrap()
            .status,
        OutboxStatus::Pending
    );

    let stale = create_campaign(&campaign_id, 0);
    assert!(matches!(
        store.handle_command(&stale),
        Err(StoreError::Domain(DomainError::VersionConflict))
    ));

    let mut duplicate_with_changed_precondition = command.clone();
    duplicate_with_changed_precondition
        .meta
        .expected_stream_version = 1;
    assert!(matches!(
        store.handle_command(&duplicate_with_changed_precondition),
        Err(StoreError::ReceiptConflict)
    ));

    let mut duplicate_with_changed_action = command.clone();
    duplicate_with_changed_action.action = CommandAction::AbortCampaign {
        reason_hash: Hash256::digest(b"fabricated-reason"),
    };
    assert!(matches!(
        store.handle_command(&duplicate_with_changed_action),
        Err(StoreError::ReceiptConflict)
    ));

    drop(store);
    let reopened = fixture.open();
    let state = reopened
        .load_state(&campaign_id)
        .expect("replay persisted event");
    assert_eq!(state.campaign_id.as_ref(), Some(&campaign_id));
    assert_eq!(state.stream_version, 1);
    let snapshot_hash = reopened.save_snapshot(&state).expect("save snapshot");
    assert_ne!(snapshot_hash, Hash256::ZERO);
    assert_eq!(reopened.load_snapshot(&campaign_id).unwrap(), Some(state));
}

#[test]
fn artifacts_are_content_addressed_and_effect_payloads_reject_sensitive_fields() {
    let fixture = StoreFixture::new();
    let store = fixture.open();
    let bytes = br#"{"result":"fabricated-summary"}"#;
    let first = store
        .put_artifact(
            ArtifactKind::CandidateDsl,
            Sensitivity::Deidentified,
            bytes,
            "application/json",
            "canonical-json",
            &[],
        )
        .expect("store deidentified artifact");
    let second = store
        .put_artifact(
            ArtifactKind::CandidateDsl,
            Sensitivity::Deidentified,
            bytes,
            "application/json",
            "canonical-json",
            &[],
        )
        .expect("deduplicate artifact");
    assert_eq!(first.artifact_id, second.artifact_id);
    assert_eq!(store.read_artifact(first.artifact_id).unwrap(), bytes);
    assert!(first.relative_path.starts_with("cas/deidentified/sha256"));

    assert!(matches!(
        store.enqueue_effect(
            CommandId::new(),
            "fabricated-command",
            EffectKind::Generate,
            "sensitive-field-rejection",
            &json!({"nested": {"prompt": "fabricated fragment one two three"}}),
            1,
            0,
        ),
        Err(StoreError::CorruptEvent)
    ));
}

#[test]
fn leases_fence_replacements_and_outbox_claims() {
    let fixture = StoreFixture::new();
    let store = fixture.open();
    let first = store
        .acquire_lease("fabricated-resource", "worker-a", 100, 10)
        .unwrap();
    assert!(matches!(
        store.acquire_lease("fabricated-resource", "worker-b", 101, 10),
        Err(StoreError::StaleLease)
    ));
    let replacement = store
        .acquire_lease("fabricated-resource", "worker-b", 110, 10)
        .unwrap();
    assert_eq!(replacement.fencing_token, first.fencing_token + 1);
    assert!(matches!(
        store.validate_fence("fabricated-resource", first.fencing_token, 111),
        Err(StoreError::StaleLease)
    ));
    store
        .validate_fence("fabricated-resource", replacement.fencing_token, 111)
        .unwrap();
    assert!(matches!(
        store.heartbeat_lease(&first, 111, 10),
        Err(StoreError::StaleLease)
    ));

    enqueue(&store, "claim-token", 1);
    assert!(matches!(
        store.claim_effect("claim-token", 0, 10),
        Err(StoreError::StaleLease)
    ));
    let claimed = store.claim_effect("claim-token", 2, 10).unwrap();
    assert_eq!(claimed.status, OutboxStatus::Executing);
    assert_eq!(claimed.fencing_token, 2);
    assert!(matches!(
        store.mark_effect_failed("claim-token", 1, "fabricated-failure", 20),
        Err(StoreError::Unreconciled)
    ));
    let observed_result = effect_artifact(&store, b"fabricated-observed-result");
    store
        .record_effect_observed(
            "claim-token",
            EffectKind::Generate,
            &json!({"run": "fabricated-run"}),
            Some(observed_result),
            2,
            112,
        )
        .unwrap();
    assert!(matches!(
        store.claim_effect("claim-token", 3, 113),
        Err(StoreError::StaleLease)
    ));
}

#[test]
fn outbox_retries_and_rejects_mismatched_duplicate_observations() {
    let fixture = StoreFixture::new();
    let store = fixture.open();
    enqueue(&store, "retryable-effect", 1);
    store.claim_effect("retryable-effect", 1, 10).unwrap();
    store
        .mark_effect_failed("retryable-effect", 1, "fabricated-transient", 20)
        .unwrap();
    assert_eq!(
        store
            .outbox_by_key("retryable-effect")
            .unwrap()
            .unwrap()
            .status,
        OutboxStatus::Failed
    );
    assert!(matches!(
        store.claim_effect("retryable-effect", 2, 19),
        Err(StoreError::StaleLease)
    ));
    let retried = store.claim_effect("retryable-effect", 2, 20).unwrap();
    assert_eq!(retried.attempt_count, 2);

    let result = effect_artifact(&store, b"fabricated-effect-result");
    store
        .record_effect_observed(
            "retryable-effect",
            EffectKind::Generate,
            &json!({"run": "fabricated-run-a"}),
            Some(result),
            2,
            21,
        )
        .unwrap();
    assert_eq!(
        store.observed_effect_artifact("retryable-effect").unwrap(),
        Some(result)
    );
    assert!(matches!(
        store.record_effect_observed(
            "retryable-effect",
            EffectKind::Generate,
            &json!({"run": "fabricated-run-b"}),
            Some(result),
            2,
            22,
        ),
        Err(StoreError::Unreconciled)
    ));
}

#[test]
fn outbox_idempotency_key_rejects_changed_effect_identity() {
    let fixture = StoreFixture::new();
    let store = fixture.open();
    enqueue(&store, "stable-effect-key", 1);
    assert!(matches!(
        store.enqueue_effect(
            CommandId::new(),
            "different-command",
            EffectKind::Push,
            "stable-effect-key",
            &json!({"job": "different-output"}),
            2,
            0,
        ),
        Err(StoreError::ReceiptConflict)
    ));
}

#[test]
fn explicit_reconciliation_never_requeues_an_unobserved_effect() {
    let fixture = StoreFixture::new();
    let store = fixture.open();
    enqueue(&store, "ambiguous-effect", 1);
    let claimed = store.claim_effect("ambiguous-effect", 1, 10).unwrap();
    store
        .mark_effect_unreconciled(
            "ambiguous-effect",
            claimed.fencing_token,
            "fabricated-ambiguous-outcome",
        )
        .unwrap();

    assert_eq!(
        store.reconcile_effect_receipt("ambiguous-effect").unwrap(),
        None
    );
    assert_eq!(
        store
            .outbox_by_key("ambiguous-effect")
            .unwrap()
            .unwrap()
            .status,
        OutboxStatus::Unreconciled
    );
    assert!(matches!(
        store.claim_effect("ambiguous-effect", 2, 20),
        Err(StoreError::StaleLease)
    ));
}
