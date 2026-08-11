use campaign_domain::{AbilityAggregate, CampaignManifest, DomainError};

pub fn required_refuters(manifest: &CampaignManifest, ability: &AbilityAggregate) -> u8 {
    if ability.escalated {
        manifest.budgets.escalated_refuters
    } else {
        manifest.budgets.routine_refuters
    }
}

pub fn validate_budgets(manifest: &CampaignManifest) -> Result<(), DomainError> {
    manifest.validate()
}

pub fn direct_transport_qualified(no_regression: bool, improvement_ratio: f64) -> bool {
    no_regression && improvement_ratio.is_finite() && improvement_ratio >= 0.30
}
