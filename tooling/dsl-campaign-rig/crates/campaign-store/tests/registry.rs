use std::collections::BTreeMap;

use campaign_domain::{
    ActorId, CampaignId, Command, CommandAction, CommandId, CommandMeta, Hash256,
    ReadOnlyEvidenceIdentity, RegistryBody, RegistryRevision,
};
use campaign_store::{CampaignStore, RegistryPromotionReceipt, StoreError};

fn empty_revision(parent: Option<Hash256>, marker: &str) -> RegistryRevision {
    RegistryRevision::new(
        parent,
        RegistryBody {
            schema_version: 1,
            corpus_root_hash: Hash256::digest(marker),
            repository_revision: marker.into(),
            embedding_model: "test-model".into(),
            members: vec![],
            clusters: BTreeMap::new(),
            contradiction_queue: vec![],
            suspect_queue: vec![],
            novelty_queue: vec![],
        },
    )
    .unwrap()
}

fn store() -> (tempfile::TempDir, tempfile::TempDir, CampaignStore) {
    let repository = tempfile::TempDir::new().unwrap();
    let state = tempfile::TempDir::new().unwrap();
    let store = CampaignStore::open(state.path(), repository.path()).unwrap();
    (repository, state, store)
}

#[test]
fn registry_revisions_are_immutable_and_head_updates_are_compare_and_swap() {
    let (_repository, _state, store) = store();
    let first = empty_revision(None, "first");
    store.put_registry_revision(&first, None).unwrap();
    assert_eq!(store.registry_head().unwrap(), Some(first.revision_id));
    assert_eq!(
        store.registry_revision(first.revision_id).unwrap(),
        Some(first.clone())
    );

    let second = empty_revision(Some(first.revision_id), "second");
    assert!(matches!(
        store.put_registry_revision(&second, None),
        Err(StoreError::RegistryConflict)
    ));
    store
        .put_registry_revision(&second, Some(first.revision_id))
        .unwrap();
    assert_eq!(store.registry_head().unwrap(), Some(second.revision_id));
}

#[test]
fn compatible_read_only_evidence_reuses_across_engine_revisions_only_by_semantic_identity() {
    let (_repository, _state, store) = store();
    let identity = ReadOnlyEvidenceIdentity {
        source_hash: Hash256::digest("source"),
        normalized_dsl_hash: Hash256::digest("dsl"),
        semantic_validator_hash: Hash256::digest("validator"),
        prompt_manifest_hash: Hash256::digest("prompts"),
        role_schema_hashes: vec![Hash256::digest("role")],
    };
    let artifact = Hash256::digest("artifact");
    store
        .put_reusable_read_only_evidence(&identity, artifact)
        .unwrap();
    assert_eq!(
        store.reusable_read_only_evidence(&identity).unwrap(),
        Some(artifact)
    );

    let incompatible = ReadOnlyEvidenceIdentity {
        semantic_validator_hash: Hash256::digest("different-validator"),
        ..identity
    };
    assert_eq!(
        store.reusable_read_only_evidence(&incompatible).unwrap(),
        None
    );
}

#[test]
fn promotion_revision_and_receipt_commit_atomically() {
    let (_repository, _state, store) = store();
    let first = empty_revision(None, "first");
    store.put_registry_revision(&first, None).unwrap();
    let second = empty_revision(Some(first.revision_id), "second");
    let campaign_id = CampaignId::new("atomic-promotion").unwrap();
    store
        .handle_command(&Command {
            meta: CommandMeta {
                command_id: CommandId::new(),
                campaign_id: campaign_id.clone(),
                expected_stream_version: 0,
                causation_id: CommandId::new(),
                correlation_id: CommandId::new(),
                actor: ActorId::new("test-actor").unwrap(),
                expected_manifest_hash: None,
                expected_engine_hash: Hash256::digest("test-engine"),
                outbox_id: None,
                fencing_token: None,
                lease_resource: None,
                lease_owner: None,
            },
            action: CommandAction::CreateCampaign,
        })
        .unwrap();
    store
        .record_registry_promotion(&RegistryPromotionReceipt {
            campaign_id: campaign_id.clone(),
            source_revision: first.revision_id,
            promoted_revision: first.revision_id,
            close_evidence_hash: Hash256::digest("wrong-evidence"),
        })
        .unwrap();
    let receipt = RegistryPromotionReceipt {
        campaign_id,
        source_revision: first.revision_id,
        promoted_revision: second.revision_id,
        close_evidence_hash: Hash256::digest("close"),
    };

    assert!(matches!(
        store.promote_registry_revision(&second, first.revision_id, &receipt),
        Err(StoreError::RegistryConflict)
    ));
    assert_eq!(store.registry_head().unwrap(), Some(first.revision_id));
    assert_eq!(store.registry_revision(second.revision_id).unwrap(), None);
}
