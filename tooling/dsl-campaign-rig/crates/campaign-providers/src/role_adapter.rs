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
        let payload = response
            .pointer("/payload/json")
            .and_then(serde_json::Value::as_str)
            .ok_or(RoleError::ProviderFailure("payload-envelope-invalid"))
            .and_then(|payload| {
                serde_json::from_str(payload)
                    .map_err(|_| RoleError::ProviderFailure("payload-json-invalid"))
            })?;
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
            repaired: exchange.repaired,
            transport: self.transport.identity().transport.clone(),
            fallback_reason: None,
            remote_run_hash: exchange.remote_run_hash,
            usage: serde_json::to_value(exchange.usage).map_err(|_| RoleError::Transport)?,
        })
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
