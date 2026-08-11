use campaign_domain::Hash256;
use serde_json::Value;

use crate::ProviderError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubscriptionAccount {
    pub stable_hash: Hash256,
    pub plan_type: String,
}

pub fn validate_account_response(result: &Value) -> Result<SubscriptionAccount, ProviderError> {
    let account = result
        .get("account")
        .and_then(Value::as_object)
        .ok_or(ProviderError::SubscriptionRequired)?;
    match account.get("type").and_then(Value::as_str) {
        Some("apiKey") => Err(ProviderError::ApiKeyForbidden),
        Some("chatgpt") => {
            let plan_type = account
                .get("planType")
                .and_then(Value::as_str)
                .ok_or(ProviderError::SubscriptionRequired)?
                .to_owned();
            let opaque_identity = serde_json::json!({
                "type": "chatgpt",
                "plan": plan_type,
                "account_hint_hash": account
                    .get("email")
                    .and_then(Value::as_str)
                    .map(|value| Hash256::digest(value.as_bytes()).to_string()),
            });
            Ok(SubscriptionAccount {
                stable_hash: Hash256::digest(serde_json::to_vec(&opaque_identity)?),
                plan_type,
            })
        }
        _ => Err(ProviderError::SubscriptionRequired),
    }
}
