use async_trait::async_trait;
use campaign_domain::Hash256;
use campaign_roles::{RoleError, RoleRequest, RoleSpec, RoleTransport, RoleTransportExchange};

use crate::{ProviderError, SubscriptionTransport, TransportRequest};

pub struct TransportRoleAdapter<T> {
    transport: T,
    output_schema: serde_json::Value,
    tool_contract_hash: Hash256,
}

impl<T> TransportRoleAdapter<T> {
    pub fn new(transport: T, tool_contract_hash: Hash256) -> Result<Self, serde_json::Error> {
        Ok(Self {
            transport,
            output_schema: serde_json::from_str(include_str!(
                "../../../contracts/provider-role-result.schema.json"
            ))?,
            tool_contract_hash,
        })
    }
}

#[async_trait]
impl<T: SubscriptionTransport> RoleTransport for TransportRoleAdapter<T> {
    async fn exchange(
        &self,
        spec: &RoleSpec,
        request: &RoleRequest,
    ) -> Result<RoleTransportExchange, RoleError> {
        let prompt = format!(
            "{}\n\nYou are a model-only role inside an explicit engine DAG. Do not call tools, \
             spawn agents, read files, or claim you did so. All admissible evidence is in task; \
             missing evidence requires a failing/revision verdict. Return one JSON object matching \
             the supplied schema. Copy campaign_id, faction_id, ability_id, and role from the input \
             exactly. Serialize your complete role-specific native output as JSON text in \
             payload.json. Set verdict to accept, revise, needs-schema, reject, pass, or fail. \
             Always include findings; use an empty array when there are none. Each finding must \
             contain only a deidentified code, severity, and nullable clause_id.\n",
            spec.prompt
        );
        let input = serde_json::json!({
            "campaign_id": request.campaign_id,
            "faction_id": request.ability.faction_id,
            "ability_id": request.ability.ability_id,
            "role": request.role,
            "attempt": request.attempt,
            "voter": request.voter,
            "task": request.sensitive_input,
        });
        let transport_request = TransportRequest {
            prompt_hash: Hash256::digest(prompt.as_bytes()),
            prompt,
            input,
            output_schema: self.output_schema.clone(),
            model: spec.model.clone(),
            reasoning: spec.reasoning.clone(),
            tool_contract_hash: self.tool_contract_hash,
        };
        let exchange = self
            .transport
            .start_or_resume(transport_request, None)
            .await
            .map_err(map_provider_error)?;
        let mut response = exchange.response;
        let payload_text = response
            .pointer("/payload/json")
            .and_then(serde_json::Value::as_str)
            .ok_or(RoleError::ProviderFailure("payload-envelope-invalid"))?;
        let (payload, payload_repaired) = parse_payload_json(payload_text)?;
        response
            .as_object_mut()
            .ok_or(RoleError::ProviderFailure("response-envelope-invalid"))?
            .insert("payload".into(), payload);
        Ok(RoleTransportExchange {
            response_hash: Hash256::digest(
                serde_json::to_vec(&response).map_err(|_| RoleError::Transport)?,
            ),
            provider_identity_hash: self.transport.identity().canonical_hash(),
            response,
            repaired: exchange.repaired || payload_repaired,
            transport: self.transport.identity().transport.clone(),
            fallback_reason: None,
            remote_run_hash: exchange.remote_run_hash,
            usage: serde_json::to_value(exchange.usage).map_err(|_| RoleError::Transport)?,
        })
    }
}

fn payload_json_diagnostic(error: &serde_json::Error) -> String {
    format!(
        "{:?} at line {}, column {}",
        error.classify(),
        error.line(),
        error.column()
    )
}

fn parse_payload_json(payload: &str) -> Result<(serde_json::Value, bool), RoleError> {
    match serde_json::from_str(payload) {
        Ok(value) => Ok((value, false)),
        Err(error) if error.classify() == serde_json::error::Category::Eof => {
            let repaired = close_truncated_json(payload)
                .and_then(|candidate| serde_json::from_str(&candidate).ok())
                .ok_or_else(|| RoleError::PayloadJsonInvalid(payload_json_diagnostic(&error)))?;
            Ok((repaired, true))
        }
        Err(error) => Err(RoleError::PayloadJsonInvalid(payload_json_diagnostic(
            &error,
        ))),
    }
}

fn close_truncated_json(payload: &str) -> Option<String> {
    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for character in payload.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        match character {
            '"' => in_string = true,
            '{' | '[' => stack.push(character),
            '}' => {
                if stack.pop() != Some('{') {
                    return None;
                }
            }
            ']' => {
                if stack.pop() != Some('[') {
                    return None;
                }
            }
            _ => {}
        }
    }
    if in_string || escaped || stack.is_empty() || stack.len() > 4 {
        return None;
    }

    let trimmed = payload.trim_end();
    let mut repaired = String::with_capacity(trimmed.len() + stack.len());
    repaired.push_str(trimmed);
    for opening in stack.iter().rev() {
        repaired.push(if *opening == '{' { '}' } else { ']' });
    }
    Some(repaired)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use async_trait::async_trait;
    use campaign_domain::{AbilityId, AbilityKey, CampaignId, FactionId, Hash256};
    use campaign_roles::{Role, RoleError, RoleRequest, RoleTransport, role_specs};
    use serde_json::json;

    use super::{TransportRoleAdapter, parse_payload_json};
    use crate::{
        ProviderError, ProviderIdentity, SubscriptionCapabilities, SubscriptionTransport,
        TransportCheckpoint, TransportExchange, TransportRequest, UsageSample,
    };

    #[derive(Clone)]
    struct FakeTransport {
        identity: ProviderIdentity,
        exchange: TransportExchange,
    }

    #[async_trait]
    impl SubscriptionTransport for FakeTransport {
        fn identity(&self) -> &ProviderIdentity {
            &self.identity
        }

        async fn probe(&self) -> Result<SubscriptionCapabilities, ProviderError> {
            Ok(SubscriptionCapabilities {
                subscription_authenticated: true,
                api_key_authenticated: false,
                strict_structured_output: true,
                resumable_threads: true,
                usage_reporting: true,
                supported_models: BTreeSet::from([self.identity.model.clone()]),
            })
        }

        async fn start_or_resume(
            &self,
            _request: TransportRequest,
            _checkpoint: Option<TransportCheckpoint>,
        ) -> Result<TransportExchange, ProviderError> {
            Ok(self.exchange.clone())
        }

        async fn usage_sample(&self) -> Result<UsageSample, ProviderError> {
            Ok(self.exchange.usage.clone())
        }
    }

    #[test]
    fn closes_one_through_four_balanced_delimiters_at_eof() {
        for source in [
            r#"{"a":1"#,
            r#"{"a":[1"#,
            r#"{"a":[{"b":1"#,
            r#"{"a":[{"b":{"c":1"#,
        ] {
            let (_, repaired) = parse_payload_json(source).unwrap();
            assert!(repaired, "source should be repairable: {source}");
        }
    }

    #[test]
    fn respects_string_escaping_and_delimiter_safety_boundaries() {
        let escaped = r#"{"text":"quote: \" slash: \\ delimiters: {[]} unicode: \u2603""#;
        let (payload, repaired) = parse_payload_json(escaped).unwrap();
        assert!(repaired);
        assert_eq!(
            payload["text"],
            r#"quote: " slash: \ delimiters: {[]} unicode: ☃"#
        );

        for source in [
            r#"{"a":[{"b":{"c":{"d":1"#,
            r#"{"a":[1}"#,
            r#"{"a":"unterminated"#,
            "{\"a\":\"trailing escape\\",
            r#"{"key":"#,
        ] {
            assert!(
                matches!(
                    parse_payload_json(source),
                    Err(RoleError::PayloadJsonInvalid(_))
                ),
                "source must remain invalid: {source}"
            );
        }
    }

    #[test]
    fn preserves_complete_payloads_and_rejects_non_eof_syntax_errors() {
        let (payload, repaired) = parse_payload_json(r#"{"shape":"choice"}"#).unwrap();
        assert!(!repaired);
        assert_eq!(payload["shape"], "choice");
        assert!(matches!(
            parse_payload_json(r#"{"shape":,}"#),
            Err(RoleError::PayloadJsonInvalid(_))
        ));
    }

    #[tokio::test]
    async fn adapter_propagates_repair_provenance_and_hashes_normalized_response() {
        let repaired = run_adapter(r#"{"value":1"#, false).await;
        assert!(repaired.repaired);
        assert_eq!(repaired.response["payload"], json!({"value": 1}));
        assert_eq!(
            repaired.response_hash,
            Hash256::digest(serde_json::to_vec(&repaired.response).unwrap())
        );
        assert_eq!(
            repaired.remote_run_hash,
            Some(Hash256::digest("remote-run"))
        );

        assert!(run_adapter(r#"{"value":1}"#, true).await.repaired);
        assert!(!run_adapter(r#"{"value":1}"#, false).await.repaired);
    }

    async fn run_adapter(
        payload: &str,
        upstream_repaired: bool,
    ) -> campaign_roles::RoleTransportExchange {
        let role = Role::DataEnginseer;
        let request = RoleRequest {
            campaign_id: CampaignId::new("campaign-alpha").unwrap(),
            ability: AbilityKey::new(
                FactionId::new("test-faction").unwrap(),
                AbilityId::new("test-ability").unwrap(),
            ),
            role,
            attempt: 1,
            voter: None,
            manifest_hash: Hash256::digest("manifest"),
            input_artifacts: vec![],
            sensitive_input: json!({}),
        };
        let identity = ProviderIdentity {
            transport: "fake-provider".into(),
            implementation_hash: Hash256::digest("implementation"),
            binary_hash: Hash256::digest("binary"),
            protocol_hash: Hash256::digest("protocol"),
            model: "test-model".into(),
            reasoning: "test-reasoning".into(),
            subscription_account_hash: Hash256::digest("account"),
        };
        let transport = FakeTransport {
            identity,
            exchange: TransportExchange {
                response: json!({
                    "campaign_id": request.campaign_id,
                    "faction_id": request.ability.faction_id,
                    "ability_id": request.ability.ability_id,
                    "role": role,
                    "verdict": "accept",
                    "payload": {"json": payload},
                    "findings": []
                }),
                sensitive_checkpoint: None,
                remote_run_hash: Some(Hash256::digest("remote-run")),
                usage: UsageSample::default(),
                repaired: upstream_repaired,
            },
        };
        let adapter =
            TransportRoleAdapter::new(transport, Hash256::digest("tool-contract")).unwrap();
        let spec = role_specs()
            .unwrap()
            .into_iter()
            .find(|spec| spec.role == role)
            .unwrap();

        adapter.exchange(&spec, &request).await.unwrap()
    }
}

fn map_provider_error(error: ProviderError) -> RoleError {
    match error {
        ProviderError::Unreconciled(_) => RoleError::Unreconciled,
        ProviderError::InvalidStructuredOutput => {
            RoleError::ProviderFailure("invalid-structured-output")
        }
        ProviderError::ProtocolMismatch => RoleError::ProviderFailure("protocol-mismatch"),
        ProviderError::IdentityMismatch => RoleError::ProviderFailure("identity-mismatch"),
        ProviderError::CapabilityDenied => RoleError::ProviderFailure("capability-denied"),
        ProviderError::ProcessEnded => RoleError::ProviderFailure("process-ended"),
        ProviderError::SubscriptionRequired => RoleError::ProviderFailure("subscription-required"),
        ProviderError::ApiKeyForbidden => RoleError::ProviderFailure("api-key-forbidden"),
        ProviderError::UsageUnavailable => RoleError::ProviderFailure("usage-unavailable"),
        ProviderError::DirectUnavailable => RoleError::ProviderFailure("direct-unavailable"),
        ProviderError::Role => RoleError::ProviderFailure("role-contract"),
        ProviderError::Timeout | ProviderError::Io(_) | ProviderError::Json(_) => {
            RoleError::Transport
        }
    }
}
