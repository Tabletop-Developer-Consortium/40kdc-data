use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};

use async_trait::async_trait;
use campaign_domain::{AbilityId, AbilityKey, CampaignId, FactionId, Hash256};
use campaign_roles::{
    Role, RoleError, RoleExecutor, RoleRequest, RoleTransport, RoleTransportExchange,
    TypedRoleExecutor, role_specs, validate_contract_bundle,
};
use serde_json::{Value, json};

#[derive(Clone)]
struct FakeRoleTransport {
    exchange: RoleTransportExchange,
}

#[async_trait]
impl RoleTransport for FakeRoleTransport {
    async fn exchange(
        &self,
        _spec: &campaign_roles::RoleSpec,
        _request: &RoleRequest,
    ) -> Result<RoleTransportExchange, RoleError> {
        Ok(self.exchange.clone())
    }
}

struct NoopWaker;

impl Wake for NoopWaker {
    fn wake(self: Arc<Self>) {}
}

fn run_ready<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(NoopWaker));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);

    match Future::poll(Pin::as_mut(&mut future), &mut context) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("fake transport must complete immediately"),
    }
}

fn request(role: Role, voter: Option<u8>) -> RoleRequest {
    RoleRequest {
        campaign_id: CampaignId::new("campaign-alpha").unwrap(),
        ability: AbilityKey::new(
            FactionId::new("test-faction").unwrap(),
            AbilityId::new("test-ability").unwrap(),
        ),
        role,
        attempt: 1,
        voter,
        manifest_hash: Hash256::digest("manifest"),
        input_artifacts: vec![Hash256::digest("input-artifact")],
        sensitive_input: json!({
            "clause_ids": ["clause-a", "clause-b"],
            "mechanical_clause_ids": ["clause-a"]
        }),
    }
}

fn result_for(request: &RoleRequest, payload: Value) -> Value {
    json!({
        "campaign_id": request.campaign_id.as_str(),
        "faction_id": request.ability.faction_id.as_str(),
        "ability_id": request.ability.ability_id.as_str(),
        "role": request.role.as_str(),
        "verdict": "accept",
        "payload": payload,
        "findings": []
    })
}

fn valid_arch_magos_payload() -> Value {
    json!({
        "clause_coverage": [
            {"clause_id": "clause-a", "disposition": "exact", "evidence": "source-explicit"},
            {"clause_id": "clause-b", "disposition": "declared-nonmechanical", "evidence": "schema-derived"}
        ],
        "placeholder_encoding": false,
        "approx_mechanical": false
    })
}

fn exchange(response: Value) -> RoleTransportExchange {
    RoleTransportExchange {
        response,
        response_hash: Hash256::digest("response"),
        provider_identity_hash: Hash256::digest("provider"),
        repaired: false,
        transport: "fake-provider".into(),
        fallback_reason: None,
        remote_run_hash: None,
        usage: json!({"input_tokens": 11, "output_tokens": 7}),
    }
}

fn spec(role: Role) -> campaign_roles::RoleSpec {
    role_specs()
        .unwrap()
        .into_iter()
        .find(|candidate| candidate.role == role)
        .unwrap()
}

#[test]
fn frozen_prompt_and_schema_contracts_load_with_expected_hashes() {
    validate_contract_bundle().unwrap();
    let specs = role_specs().unwrap();
    let schema_hash = Hash256::digest(include_str!("../../../contracts/role-result.schema.json"));

    assert_eq!(specs.len(), Role::ALL.len());
    for role in Role::ALL {
        let spec = specs.iter().find(|spec| spec.role == role).unwrap();
        assert_eq!(spec.prompt_hash, Hash256::digest(role.prompt()));
        assert_eq!(spec.schema_hash, schema_hash);
        assert!(!spec.model.trim().is_empty());
        assert!(!spec.reasoning.trim().is_empty());
    }
}

#[test]
fn typed_executor_rejects_request_role_provenance_mismatch() {
    let request = request(Role::Eversor, Some(1));
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(result_for(&request, json!({"divergences": []}))),
    });

    let error = run_ready(executor.execute(&spec(Role::ArchMagos), request)).unwrap_err();

    assert_eq!(error, RoleError::ProvenanceMismatch);
}

#[test]
fn typed_executor_rejects_result_identity_mismatch() {
    let request = request(Role::ArchMagos, None);
    let mut response = result_for(&request, valid_arch_magos_payload());
    response["ability_id"] = json!("different-ability");
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(response),
    });

    let error = run_ready(executor.execute(&spec(Role::ArchMagos), request)).unwrap_err();

    assert_eq!(error, RoleError::ProvenanceMismatch);
}

#[test]
fn typed_executor_rejects_repaired_and_schema_invalid_outputs() {
    let request = request(Role::ArchMagos, None);
    let mut repaired = exchange(result_for(&request, valid_arch_magos_payload()));
    repaired.repaired = true;
    let repaired_executor = TypedRoleExecutor::new(FakeRoleTransport { exchange: repaired });
    let repaired_error =
        run_ready(repaired_executor.execute(&spec(Role::ArchMagos), request.clone())).unwrap_err();
    assert_eq!(repaired_error, RoleError::RepairedOutput);

    let invalid_executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(json!({"campaign_id": "campaign-alpha"})),
    });
    let invalid_error =
        run_ready(invalid_executor.execute(&spec(Role::ArchMagos), request)).unwrap_err();
    assert_eq!(invalid_error, RoleError::SchemaInvalid);
}

#[test]
fn typed_executor_rejects_arch_magos_clause_coverage_violation() {
    let request = request(Role::ArchMagos, None);
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(result_for(
            &request,
            json!({
                "clause_coverage": [],
                "placeholder_encoding": false,
                "approx_mechanical": false
            }),
        )),
    });

    let error = run_ready(executor.execute(&spec(Role::ArchMagos), request)).unwrap_err();

    assert_eq!(error, RoleError::SemanticInvalid("clause-coverage"));
}

#[test]
fn typed_executor_rejects_refuter_vote_without_divergences() {
    let request = request(Role::Eversor, Some(2));
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(result_for(&request, json!({"observations": []}))),
    });

    let error = run_ready(executor.execute(&spec(Role::Eversor), request)).unwrap_err();

    assert_eq!(error, RoleError::SemanticInvalid("refuter-voter"));
}

#[test]
fn typed_executor_accepts_retrieval_with_matches_for_deterministic_partition_fallback() {
    let request = request(Role::DataEnginseer, None);
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(result_for(
            &request,
            json!({
                "matches": [{"ability_id": "test-ability"}],
                "evidence_packet": {"clauses": null}
            }),
        )),
    });

    let validated = run_ready(executor.execute(&spec(Role::DataEnginseer), request)).unwrap();

    assert_eq!(validated.result.role, Role::DataEnginseer);
}

#[test]
fn typed_executor_accepts_grounded_shape_failure_for_needs_schema_routing() {
    let request = request(Role::KrootFleshShaper, None);
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(result_for(
            &request,
            json!({
                "mechanic": "Fabricated unresolved mechanic",
                "proposed_shape": null,
                "self_grade": {
                    "verdict": "fail",
                    "concerns": ["Existing shape inventory was insufficient."]
                }
            }),
        )),
    });

    let validated = run_ready(executor.execute(&spec(Role::KrootFleshShaper), request)).unwrap();

    assert_eq!(validated.result.role, Role::KrootFleshShaper);
}

#[test]
fn typed_executor_accepts_singleton_shape_survey() {
    let request = request(Role::Swarmlord, None);
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: exchange(result_for(
            &request,
            json!({
                "candidates": [],
                "estimated_family_size": 1
            }),
        )),
    });

    let validated = run_ready(executor.execute(&spec(Role::Swarmlord), request)).unwrap();

    assert_eq!(validated.result.role, Role::Swarmlord);
}

#[test]
fn typed_executor_returns_validated_result_with_transport_metadata_and_usage() {
    let request = request(Role::ArchMagos, None);
    let response_hash = Hash256::digest("response-metadata");
    let provider_identity_hash = Hash256::digest("provider-identity");
    let remote_run_hash = Hash256::digest("remote-run");
    let usage = json!({"input_tokens": 13, "output_tokens": 5});
    let executor = TypedRoleExecutor::new(FakeRoleTransport {
        exchange: RoleTransportExchange {
            response: result_for(&request, valid_arch_magos_payload()),
            response_hash,
            provider_identity_hash,
            repaired: false,
            transport: "fake-provider".into(),
            fallback_reason: Some("fabricated fallback".into()),
            remote_run_hash: Some(remote_run_hash),
            usage: usage.clone(),
        },
    });

    let validated = run_ready(executor.execute(&spec(Role::ArchMagos), request)).unwrap();

    assert_eq!(
        validated.result.verdict,
        campaign_roles::RoleVerdict::Accept
    );
    assert_eq!(validated.response_hash, response_hash);
    assert_eq!(validated.provider_identity_hash, provider_identity_hash);
    assert!(!validated.repaired);
    assert_eq!(validated.transport, "fake-provider");
    assert_eq!(
        validated.fallback_reason.as_deref(),
        Some("fabricated fallback")
    );
    assert_eq!(validated.remote_run_hash, Some(remote_run_hash));
    assert_eq!(validated.usage, usage);
}
