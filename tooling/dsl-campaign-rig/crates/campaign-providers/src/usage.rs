use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageSample {
    #[serde(default)]
    pub available: bool,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub quota_snapshot_hash: Option<Hash256>,
}

impl UsageSample {
    pub fn token_activity(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.cached_tokens)
            .saturating_add(self.output_tokens)
            .saturating_add(self.reasoning_tokens)
    }

    pub fn checked_delta(&self, before: &Self) -> Option<Self> {
        Some(Self {
            available: self.available && before.available,
            input_tokens: self.input_tokens.checked_sub(before.input_tokens)?,
            cached_tokens: self.cached_tokens.checked_sub(before.cached_tokens)?,
            output_tokens: self.output_tokens.checked_sub(before.output_tokens)?,
            reasoning_tokens: self.reasoning_tokens.checked_sub(before.reasoning_tokens)?,
            quota_snapshot_hash: self.quota_snapshot_hash,
        })
    }
}
