use campaign_domain::{AbilityKey, CampaignId, Hash256};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Role;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoleRequest {
    pub campaign_id: CampaignId,
    pub ability: AbilityKey,
    pub role: Role,
    pub attempt: u8,
    pub voter: Option<u8>,
    pub manifest_hash: Hash256,
    pub input_artifacts: Vec<Hash256>,
    pub sensitive_input: Value,
}

impl RoleRequest {
    pub fn deidentified_hash(&self) -> Hash256 {
        let deidentified = serde_json::json!({
            "campaign_id": self.campaign_id,
            "ability": self.ability,
            "role": self.role,
            "attempt": self.attempt,
            "voter": self.voter,
            "manifest_hash": self.manifest_hash,
            "input_artifacts": self.input_artifacts,
        });
        Hash256::digest(serde_json::to_vec(&deidentified).expect("serializable role request"))
    }
}
