use std::collections::{BTreeMap, BTreeSet};

use campaign_domain::{
    AbilityId, AbilityKey, ConfidenceTier, EmbeddingVector, ExecutionLane, FactionId, Hash256,
    MechanicCluster, MechanicClusterId, MechanicEmbeddings, MechanicTemplate, RegistryBody,
    RegistryRevision, SeedMember,
};
use campaign_engine::{
    compute_structural_signature, instantiate_retrieved_template, normalized_mechanic_dsl,
    parameterize_dsl, retrieval_for_member, retrieve_cluster,
};
use serde_json::{Map, Value, json};

fn key(name: &str) -> AbilityKey {
    AbilityKey::new(
        FactionId::new("sample-faction").unwrap(),
        AbilityId::new(name).unwrap(),
    )
}

fn signature(dsl: &Value) -> campaign_domain::StructuralSignature {
    compute_structural_signature(dsl).unwrap()
}
fn template(member: &AbilityKey, dsl: Value, tier: ConfidenceTier) -> MechanicTemplate {
    let (dsl_template, parameter_schema) = parameterize_dsl(&dsl).unwrap();
    let template_hash = Hash256::digest(
        serde_json::to_vec(&(&dsl_template, &parameter_schema, signature(&dsl))).unwrap(),
    );
    MechanicTemplate {
        template_hash,
        source_member: member.clone(),
        dsl_template,
        parameter_schema,
        confidence: tier,
    }
}

fn member(name: &str, dsl: Value, tier: ConfidenceTier) -> SeedMember {
    let key = key(name);
    let signature = signature(&dsl);
    let cluster_id = MechanicClusterId::from_signature(&signature).unwrap();
    let dsl_hash = Hash256::digest(serde_json::to_vec(&dsl).unwrap());
    SeedMember {
        key,
        ability_type: "unit".into(),
        detachment_context: None,
        source_hash: Some(Hash256::digest(name)),
        source_provenance_hash: Some(Hash256::digest(format!("provenance-{name}"))),
        normalized_dsl: dsl,
        dsl_hash,
        describer_output: "community description".into(),
        scoring_describer_output: "community description".into(),
        architecture_signature: "architecture".into(),
        clause_signature: "clauses".into(),
        structural_signature: signature,
        canonical_shape_ids: BTreeSet::from(["re-roll".into()]),
        lever_signature: "levers".into(),
        roundtrip_score: Some(0.9),
        schema_valid: true,
        integrity_valid: true,
        verification_provenance: None,
        repository_revision: "revision".into(),
        corpus_version: "revision".into(),
        embeddings: MechanicEmbeddings {
            source_evidence: Some(EmbeddingVector {
                model: "test-model".into(),
                values: vec![1.0, 0.0],
            }),
            describer_output: None,
            normalized_architecture: None,
            normalized_dsl_structure: None,
            combined_mechanic: Some(EmbeddingVector {
                model: "test-model".into(),
                values: vec![1.0, 0.0],
            }),
        },
        confidence: tier,
        cluster_id,
        confidence_reasons: BTreeSet::new(),
    }
}

fn revision_with(members: Vec<SeedMember>) -> RegistryRevision {
    let mut clusters = BTreeMap::new();
    for member in &members {
        let cluster = clusters
            .entry(member.cluster_id.clone())
            .or_insert_with(|| MechanicCluster {
                canonical_cluster_id: member.cluster_id.clone(),
                structural_signature: member.structural_signature.clone(),
                evidence_embedding: member.embeddings.source_evidence.clone(),
                architecture_embedding: None,
                dsl_structure_embedding: None,
                canonical_shape_ids: member.canonical_shape_ids.clone(),
                parameter_schema: json!({"type": "object", "properties": {}}),
                lever_signature: member.lever_signature.clone(),
                accepted_templates: Vec::new(),
                verified_exemplars: BTreeSet::new(),
                provisional_members: BTreeSet::new(),
                suspect_members: BTreeSet::new(),
                unpaired_members: BTreeSet::new(),
                known_exclusions: BTreeSet::new(),
                rejected_equivalences: BTreeSet::new(),
                conflicting_members: BTreeSet::new(),
                support_count: 0,
                confidence: member.confidence,
                verification_provenance: BTreeSet::new(),
            });
        cluster.support_count += 1;
        match member.confidence {
            ConfidenceTier::Verified => {
                cluster.verified_exemplars.insert(member.key.clone());
            }
            ConfidenceTier::TrustedProvisional => {
                cluster.provisional_members.insert(member.key.clone());
            }
            ConfidenceTier::Suspect => {
                cluster.suspect_members.insert(member.key.clone());
            }
            ConfidenceTier::Unpaired => {
                cluster.unpaired_members.insert(member.key.clone());
            }
        }
        if member.confidence.template_eligible() {
            cluster.accepted_templates.push(template(
                &member.key,
                member.normalized_dsl.clone(),
                member.confidence,
            ));
        }
    }
    RegistryRevision::new(
        None,
        RegistryBody {
            schema_version: 1,
            corpus_root_hash: Hash256::digest("corpus"),
            repository_revision: "revision".into(),
            embedding_model: "test-model".into(),
            members,
            clusters,
            contradiction_queue: vec![],
            suspect_queue: vec![],
            novelty_queue: vec![],
        },
    )
    .unwrap()
}

#[test]
fn structural_signature_is_stable_across_object_key_order() {
    let left = json!({
        "ability_type": "unit",
        "effect": {
            "type": "conditional",
            "condition": {"parameters": {"phase": "shooting"}, "type": "phase-is"},
            "effect": {"modifier": {"roll": "hit", "value": 1, "operation": "add"}, "target": "attacker", "type": "roll-modifier"}
        },
        "scope": {"duration": "phase", "range": "unit"}
    });
    let mut object = Map::new();
    object.insert(
        "scope".into(),
        json!({"range": "unit", "duration": "phase"}),
    );
    object.insert("effect".into(), left.get("effect").unwrap().clone());
    object.insert("ability_type".into(), json!("unit"));
    let right = Value::Object(object);

    assert_eq!(signature(&left), signature(&right));
    assert_eq!(
        MechanicClusterId::from_signature(&signature(&left)).unwrap(),
        MechanicClusterId::from_signature(&signature(&right)).unwrap()
    );
}

#[test]
fn structural_signature_blocks_timing_target_control_and_lever_merges() {
    let baseline = json!({
        "effect": {"type": "re-roll", "target": "attacker", "modifier": {"roll": "hit", "scope": "ones"}},
        "scope": {"range": "unit", "duration": "phase"},
        "trigger": {"event": "attack-declared"}
    });
    for incompatible in [
        json!({
            "effect": {"type": "re-roll", "target": "attacker", "modifier": {"roll": "hit", "scope": "ones"}},
            "scope": {"range": "unit", "duration": "phase"},
            "trigger": {"event": "wound-rolled"}
        }),
        json!({
            "effect": {"type": "re-roll", "target": "defender", "modifier": {"roll": "hit", "scope": "ones"}},
            "scope": {"range": "unit", "duration": "phase"},
            "trigger": {"event": "attack-declared"}
        }),
        json!({
            "effect": {"type": "sequence", "steps": [{"type": "re-roll", "target": "attacker", "modifier": {"roll": "hit", "scope": "ones"}}]},
            "scope": {"range": "unit", "duration": "phase"},
            "trigger": {"event": "attack-declared"}
        }),
        json!({
            "effect": {"type": "re-roll", "target": "attacker", "modifier": {"roll": "wound", "scope": "ones"}},
            "scope": {"range": "unit", "duration": "phase"},
            "trigger": {"event": "attack-declared"}
        }),
    ] {
        assert_ne!(signature(&baseline), signature(&incompatible));
        assert_ne!(
            MechanicClusterId::from_signature(&signature(&baseline)).unwrap(),
            MechanicClusterId::from_signature(&signature(&incompatible)).unwrap()
        );
    }
}

#[test]
fn verified_or_supported_provisional_templates_take_fast_lane() {
    let dsl = json!({
        "effect": {"type": "re-roll", "target": "attacker", "modifier": {"roll": "hit", "scope": "ones"}},
        "scope": {"range": "unit", "duration": "permanent"}
    });
    let revision = revision_with(vec![
        member("first", dsl.clone(), ConfidenceTier::TrustedProvisional),
        member("second", dsl, ConfidenceTier::TrustedProvisional),
    ]);

    let decision = retrieval_for_member(&revision, &key("first")).unwrap();
    assert_eq!(decision.lane, ExecutionLane::Fast);
    assert!(decision.selected_template_hash.is_some());
}

#[test]
fn fast_lane_instantiates_the_selected_template_with_target_parameters() {
    let first = json!({
        "effect": {"type": "roll-modifier", "target": "attacker", "modifier": {"roll": "hit", "value": 1}},
        "scope": {"range": "unit", "duration": "phase"}
    });
    let second = json!({
        "effect": {"type": "roll-modifier", "target": "attacker", "modifier": {"roll": "hit", "value": 2}},
        "scope": {"range": "unit", "duration": "phase"}
    });
    let revision = revision_with(vec![
        member(
            "first-parameterized",
            first,
            ConfidenceTier::TrustedProvisional,
        ),
        member(
            "second-parameterized",
            second.clone(),
            ConfidenceTier::TrustedProvisional,
        ),
    ]);
    let key = key("second-parameterized");
    let decision = retrieval_for_member(&revision, &key).unwrap();

    assert_eq!(
        instantiate_retrieved_template(&revision, &key, &decision).unwrap(),
        second
    );
}

#[test]
fn high_semantic_similarity_never_overrides_structural_incompatibility() {
    let known = json!({
        "effect": {"type": "re-roll", "target": "attacker", "modifier": {"roll": "hit", "scope": "ones"}},
        "scope": {"range": "unit", "duration": "permanent"}
    });
    let revision = revision_with(vec![
        member("known-a", known.clone(), ConfidenceTier::TrustedProvisional),
        member("known-b", known, ConfidenceTier::TrustedProvisional),
    ]);
    let novel = json!({
        "effect": {"type": "re-roll", "target": "defender", "modifier": {"roll": "save", "scope": "ones"}},
        "scope": {"range": "unit", "duration": "permanent"}
    });
    let decision = retrieve_cluster(
        &revision,
        &signature(&novel),
        Some(&EmbeddingVector {
            model: "test-model".into(),
            values: vec![1.0, 0.0],
        }),
    )
    .unwrap();

    assert_eq!(decision.lane, ExecutionLane::Review);
    assert!(decision.selected_cluster.is_none());
    assert!(
        decision
            .candidates
            .first()
            .is_some_and(|candidate| !candidate.structural_compatible)
    );
}

#[test]
fn normalized_dsl_excludes_identity_and_authorship_metadata() {
    let ability = json!({
        "ability_id": "example",
        "name": "Example",
        "authored_by": "community",
        "effect": {"type": "deep-strike", "target": "self", "modifier": {}},
        "scope": {"range": "unit", "duration": "permanent"},
        "unit_ids": ["unit"]
    });
    let normalized = normalized_mechanic_dsl(ability.as_object().unwrap());
    assert_eq!(
        normalized,
        json!({
            "effect": {"type": "deep-strike", "target": "self", "modifier": {}},
            "scope": {"range": "unit", "duration": "permanent"}
        })
    );
}
