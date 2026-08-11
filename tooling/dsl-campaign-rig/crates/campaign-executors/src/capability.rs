use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    ReadRepo,
    ReadRawStore,
    ReadEmbeddingsReports,
    RunScorer,
    RunValidator,
    RunParity,
    ReadJj,
    ApplyExactPlan,
    GenerateArtifacts,
    CreateBookmark,
    PushBookmark,
    CreateDraftPr,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityGrant(BTreeSet<Capability>);

impl CapabilityGrant {
    pub fn from_capabilities(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        Self(capabilities.into_iter().collect())
    }

    pub fn read_only() -> Self {
        Self(BTreeSet::from([
            Capability::ReadRepo,
            Capability::ReadRawStore,
            Capability::ReadEmbeddingsReports,
            Capability::RunScorer,
            Capability::RunValidator,
            Capability::RunParity,
            Capability::ReadJj,
        ]))
    }

    pub fn contains(&self, capability: Capability) -> bool {
        self.0.contains(&capability)
    }

    pub fn require(&self, capability: Capability) -> Result<(), crate::ExecutorError> {
        if self.contains(capability) {
            Ok(())
        } else {
            Err(crate::ExecutorError::CapabilityDenied(capability))
        }
    }

    pub fn authorize(&mut self, capability: Capability) {
        self.0.insert(capability);
    }
}
