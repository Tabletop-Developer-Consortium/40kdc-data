use std::collections::BTreeSet;

use crate::{AbilityKey, CampaignPhase, CampaignState, DomainError, Hash256};

pub fn stream_version(state: &CampaignState, expected: u64) -> Result<(), DomainError> {
    if state.stream_version != expected {
        return Err(DomainError::VersionConflict);
    }
    Ok(())
}

pub fn campaign_identity(
    state: &CampaignState,
    campaign_id: &crate::CampaignId,
) -> Result<(), DomainError> {
    if state
        .campaign_id
        .as_ref()
        .is_some_and(|existing| existing != campaign_id)
    {
        return Err(DomainError::ManifestMismatch);
    }
    Ok(())
}

pub fn manifest_identity(
    state: &CampaignState,
    expected: Option<Hash256>,
) -> Result<(), DomainError> {
    if state.manifest_hash != expected {
        return Err(DomainError::ManifestMismatch);
    }
    Ok(())
}

pub fn running(state: &CampaignState) -> Result<(), DomainError> {
    if state.phase != CampaignPhase::Running {
        return Err(DomainError::WrongState);
    }
    Ok(())
}

pub fn manifest_member(state: &CampaignState, key: &AbilityKey) -> Result<(), DomainError> {
    let Some(manifest) = &state.manifest else {
        return Err(DomainError::ManifestMismatch);
    };
    if manifest
        .ordered_worklist
        .iter()
        .any(|item| &item.key == key)
    {
        Ok(())
    } else {
        Err(DomainError::OutOfManifestMember)
    }
}

pub fn exact_clause_coverage(
    expected: &BTreeSet<String>,
    actual: &BTreeSet<String>,
) -> Result<(), DomainError> {
    if expected == actual {
        Ok(())
    } else {
        Err(DomainError::ClauseCoverageMismatch)
    }
}

pub fn terminal_or_aborting(state: &CampaignState) -> bool {
    matches!(
        state.phase,
        CampaignPhase::Published | CampaignPhase::Aborting | CampaignPhase::Aborted
    )
}
