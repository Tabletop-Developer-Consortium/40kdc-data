use campaign_domain::{CampaignId, CampaignState, Command, CommandAction, Hash256};
use campaign_store::{CampaignStore, CommandReceipt, EffectIntent};

use crate::{EngineError, retrieval_for_member};

#[derive(Clone)]
pub struct CampaignEngine {
    store: CampaignStore,
    engine_hash: Hash256,
    read_only: bool,
    allow_shape_application: bool,
}

impl CampaignEngine {
    pub fn new(store: CampaignStore, engine_hash: Hash256, read_only: bool) -> Self {
        Self {
            store,
            engine_hash,
            read_only,
            allow_shape_application: false,
        }
    }

    fn validate_registry_command(&self, command: &Command) -> Result<(), EngineError> {
        let CommandAction::RecordMechanicRetrieval { key, decision, .. } = &command.action else {
            return Ok(());
        };
        if decision.lane != campaign_domain::ExecutionLane::Fast {
            return Ok(());
        }
        let revision = self
            .store
            .registry_revision(decision.registry_revision)?
            .ok_or(EngineError::Policy)?;
        if retrieval_for_member(&revision, key)? != *decision {
            return Err(EngineError::Policy);
        }
        Ok(())
    }

    pub fn execute(&self, command: &Command) -> Result<CommandReceipt, EngineError> {
        if command.meta.expected_engine_hash != self.engine_hash {
            return Err(EngineError::Policy);
        }
        self.validate_registry_command(command)?;
        Ok(self.store.handle_command(command)?)
    }

    pub fn execute_with_effect(
        &self,
        command: &Command,
        intent: &EffectIntent,
    ) -> Result<CommandReceipt, EngineError> {
        if self.read_only || command.meta.expected_engine_hash != self.engine_hash {
            return Err(EngineError::Policy);
        }
        if command.meta.outbox_id != Some(intent.outbox_id)
            || command.meta.fencing_token != Some(intent.fencing_token)
        {
            return Err(EngineError::Policy);
        }
        self.validate_registry_command(command)?;
        Ok(self.store.handle_command_with_effect(command, intent)?)
    }

    pub fn state(&self, campaign_id: &CampaignId) -> Result<CampaignState, EngineError> {
        Ok(self.store.load_state(campaign_id)?)
    }

    pub fn store(&self) -> &CampaignStore {
        &self.store
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    pub fn engine_hash(&self) -> Hash256 {
        self.engine_hash
    }

    pub fn with_shape_application(mut self, allow: bool) -> Self {
        self.allow_shape_application = allow;
        self
    }

    pub fn allow_shape_application(&self) -> bool {
        self.allow_shape_application
    }
}
