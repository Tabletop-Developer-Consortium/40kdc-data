use campaign_domain::{AbilityId, CampaignId, FactionId, Hash256};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Role;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoleVerdict {
    Accept,
    Revise,
    NeedsSchema,
    Reject,
    Pass,
    Fail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleFinding {
    pub code: String,
    pub severity: u8,
    pub clause_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoleResult {
    pub campaign_id: CampaignId,
    pub faction_id: FactionId,
    pub ability_id: AbilityId,
    pub role: Role,
    pub verdict: RoleVerdict,
    pub payload: Value,
    #[serde(default)]
    pub findings: Vec<RoleFinding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ValidatedRoleResult {
    pub result: RoleResult,
    pub response_hash: Hash256,
    pub provider_identity_hash: Hash256,
    pub repaired: bool,
    pub transport: String,
    pub fallback_reason: Option<String>,
    pub remote_run_hash: Option<Hash256>,
    pub usage: Value,
}
