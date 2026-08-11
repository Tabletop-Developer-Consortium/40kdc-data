use async_trait::async_trait;
use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ProviderError, ProviderIdentity, SubscriptionCapabilities, UsageSample};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TransportRequest {
    pub prompt: String,
    pub input: Value,
    pub output_schema: Value,
    pub model: String,
    pub reasoning: String,
    pub prompt_hash: Hash256,
    pub tool_contract_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportCheckpoint {
    pub sensitive_bytes: Vec<u8>,
    pub identity_hash: Hash256,
    pub turn_started: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TransportExchange {
    pub response: Value,
    pub sensitive_checkpoint: Option<TransportCheckpoint>,
    pub remote_run_hash: Option<Hash256>,
    pub usage: UsageSample,
    pub repaired: bool,
}

#[async_trait]
pub trait SubscriptionTransport: Send + Sync {
    fn identity(&self) -> &ProviderIdentity;
    async fn probe(&self) -> Result<SubscriptionCapabilities, ProviderError>;
    async fn start_or_resume(
        &self,
        request: TransportRequest,
        checkpoint: Option<TransportCheckpoint>,
    ) -> Result<TransportExchange, ProviderError>;
    async fn usage_sample(&self) -> Result<UsageSample, ProviderError>;
}
