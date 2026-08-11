use std::collections::BTreeSet;

use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderIdentity {
    pub transport: String,
    pub implementation_hash: Hash256,
    pub binary_hash: Hash256,
    pub protocol_hash: Hash256,
    pub model: String,
    pub reasoning: String,
    pub subscription_account_hash: Hash256,
}

impl ProviderIdentity {
    pub fn canonical_hash(&self) -> Hash256 {
        Hash256::digest(serde_json::to_vec(self).expect("serializable provider identity"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionCapabilities {
    pub subscription_authenticated: bool,
    pub api_key_authenticated: bool,
    pub strict_structured_output: bool,
    pub resumable_threads: bool,
    pub usage_reporting: bool,
    pub supported_models: BTreeSet<String>,
}
