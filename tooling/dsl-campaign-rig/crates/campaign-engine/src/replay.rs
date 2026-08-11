use campaign_domain::{CampaignId, CampaignPhase, Hash256, replay};
use campaign_store::CampaignStore;
use serde::{Deserialize, Serialize};

use crate::EngineError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayReport {
    pub campaign_id: CampaignId,
    pub event_count: usize,
    pub stream_version: u64,
    pub state_hash: Hash256,
    pub snapshot_hash_matched: Option<bool>,
    pub publishable: bool,
}

pub fn replay_campaign(
    store: &CampaignStore,
    campaign_id: &CampaignId,
) -> Result<ReplayReport, EngineError> {
    let events = store.load_events(campaign_id)?;
    let state = replay(events.iter())?;
    let state_hash = state.state_hash();
    let snapshot_hash_matched = store.load_snapshot(campaign_id)?.map(|snapshot| {
        snapshot.stream_version <= state.stream_version && {
            let snapshot_version = snapshot.stream_version;
            let mut resumed = snapshot;
            events
                .iter()
                .filter(|event| event.stream_version > snapshot_version)
                .all(|event| campaign_domain::evolve(&mut resumed, event).is_ok())
                && resumed.state_hash() == state_hash
        }
    });
    let publishable = state.phase == CampaignPhase::Published
        && state.all_work_terminal()
        && state.close_verification_hash.is_some()
        && state.publication_effect_hash.is_some();
    Ok(ReplayReport {
        campaign_id: campaign_id.clone(),
        event_count: events.len(),
        stream_version: state.stream_version,
        state_hash,
        snapshot_hash_matched,
        publishable,
    })
}
