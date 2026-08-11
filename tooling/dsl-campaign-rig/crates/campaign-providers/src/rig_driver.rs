#[cfg(feature = "direct-chatgpt")]
use std::collections::BTreeSet;

#[cfg(feature = "direct-chatgpt")]
use rig_agent::agent::run::{AgentRun, AgentRunStep, ModelTurn, ModelTurnOutcome};
#[cfg(feature = "direct-chatgpt")]
use rig_core::completion::CompletionModel;

#[cfg(feature = "direct-chatgpt")]
use crate::{ProviderError, UsageSample};

#[cfg(feature = "direct-chatgpt")]
pub struct RigRunResult {
    pub output: String,
    pub serialized_run: Vec<u8>,
    pub usage: UsageSample,
}

#[cfg(feature = "direct-chatgpt")]
pub async fn drive<M: CompletionModel>(
    model: &M,
    prompt: String,
    preamble: &str,
    output_schema: schemars::Schema,
    reasoning: &str,
    resumed_run: Option<AgentRun>,
    mut checkpoint: impl FnMut(&AgentRun, bool) -> Result<(), ProviderError>,
) -> Result<RigRunResult, ProviderError> {
    let mut run = resumed_run.unwrap_or_else(|| {
        AgentRun::new(prompt).max_turns(1).with_output_validation(
            Some(serde_json::to_value(&output_schema).expect("schema serializes")),
            0,
        )
    });
    loop {
        match run
            .next_step()
            .map_err(|_| ProviderError::Unreconciled(None))?
        {
            AgentRunStep::CallModel {
                prompt, history, ..
            } => {
                let request = model
                    .completion_request(prompt)
                    .messages(history)
                    .preamble(preamble.to_owned())
                    .output_schema(output_schema.clone())
                    .additional_params(serde_json::json!({"reasoning": {"effort": reasoning}}))
                    .build();
                checkpoint(&run, true)?;
                let response = tokio::time::timeout(
                    std::time::Duration::from_secs(900),
                    model.completion(request),
                )
                .await
                .map_err(|_| {
                    let bytes = serde_json::to_vec(&run).unwrap_or_default();
                    ProviderError::Unreconciled(Some(crate::TransportCheckpoint {
                        sensitive_bytes: bytes,
                        identity_hash: campaign_domain::Hash256::ZERO,
                        turn_started: true,
                    }))
                })?
                .map_err(|_| {
                    let bytes = serde_json::to_vec(&run).unwrap_or_default();
                    ProviderError::Unreconciled(Some(crate::TransportCheckpoint {
                        sensitive_bytes: bytes,
                        identity_hash: campaign_domain::Hash256::ZERO,
                        turn_started: true,
                    }))
                })?;
                let turn = ModelTurn::new(
                    response.message_id,
                    response.choice,
                    response.usage,
                    BTreeSet::new(),
                    BTreeSet::new(),
                );
                if !matches!(
                    run.model_response(turn)
                        .map_err(|_| ProviderError::InvalidStructuredOutput)?,
                    ModelTurnOutcome::Continue { .. }
                ) {
                    return Err(ProviderError::CapabilityDenied);
                }
                checkpoint(&run, false)?;
            }
            AgentRunStep::CallTools { .. } => return Err(ProviderError::CapabilityDenied),
            AgentRunStep::Done(response) => {
                let serialized_run = serde_json::to_vec(&run)?;
                return Ok(RigRunResult {
                    output: response.output,
                    serialized_run,
                    usage: UsageSample {
                        available: true,
                        input_tokens: response.usage.input_tokens,
                        cached_tokens: response.usage.cached_input_tokens,
                        output_tokens: response.usage.output_tokens,
                        reasoning_tokens: response.usage.reasoning_tokens,
                        quota_snapshot_hash: None,
                    },
                });
            }
        }
    }
}
