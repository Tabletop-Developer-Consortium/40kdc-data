use std::{collections::BTreeSet, str::FromStr};

use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};

use crate::RoleError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    ArchMagos,
    Chronomancer,
    Cogitator,
    DataEnginseer,
    Eversor,
    Inquisitor,
    KrootFleshShaper,
    KrootLoneSpear,
    KrootTrailShaper,
    KrootWarShaper,
    Psyker,
    Skitarius,
    Swarmlord,
    TargetDummy,
    VoxHound,
    Warpsmith,
}

impl Role {
    pub const ALL: [Self; 16] = [
        Self::ArchMagos,
        Self::Chronomancer,
        Self::Cogitator,
        Self::DataEnginseer,
        Self::Eversor,
        Self::Inquisitor,
        Self::KrootFleshShaper,
        Self::KrootLoneSpear,
        Self::KrootTrailShaper,
        Self::KrootWarShaper,
        Self::Psyker,
        Self::Skitarius,
        Self::Swarmlord,
        Self::TargetDummy,
        Self::VoxHound,
        Self::Warpsmith,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ArchMagos => "arch-magos",
            Self::Chronomancer => "chronomancer",
            Self::Cogitator => "cogitator",
            Self::DataEnginseer => "data-enginseer",
            Self::Eversor => "eversor",
            Self::Inquisitor => "inquisitor",
            Self::KrootFleshShaper => "kroot-flesh-shaper",
            Self::KrootLoneSpear => "kroot-lone-spear",
            Self::KrootTrailShaper => "kroot-trail-shaper",
            Self::KrootWarShaper => "kroot-war-shaper",
            Self::Psyker => "psyker",
            Self::Skitarius => "skitarius",
            Self::Swarmlord => "swarmlord",
            Self::TargetDummy => "target-dummy",
            Self::VoxHound => "vox-hound",
            Self::Warpsmith => "warpsmith",
        }
    }

    pub const fn prompt(self) -> &'static str {
        match self {
            Self::ArchMagos => include_str!("../../../prompts/roles/arch-magos.md"),
            Self::Chronomancer => include_str!("../../../prompts/roles/chronomancer.md"),
            Self::Cogitator => include_str!("../../../prompts/roles/cogitator.md"),
            Self::DataEnginseer => include_str!("../../../prompts/roles/data-enginseer.md"),
            Self::Eversor => include_str!("../../../prompts/roles/eversor.md"),
            Self::Inquisitor => include_str!("../../../prompts/roles/inquisitor.md"),
            Self::KrootFleshShaper => include_str!("../../../prompts/roles/kroot-flesh-shaper.md"),
            Self::KrootLoneSpear => include_str!("../../../prompts/roles/kroot-lone-spear.md"),
            Self::KrootTrailShaper => include_str!("../../../prompts/roles/kroot-trail-shaper.md"),
            Self::KrootWarShaper => include_str!("../../../prompts/roles/kroot-war-shaper.md"),
            Self::Psyker => include_str!("../../../prompts/roles/psyker.md"),
            Self::Skitarius => include_str!("../../../prompts/roles/skitarius.md"),
            Self::Swarmlord => include_str!("../../../prompts/roles/swarmlord.md"),
            Self::TargetDummy => include_str!("../../../prompts/roles/target-dummy.md"),
            Self::VoxHound => include_str!("../../../prompts/roles/vox-hound.md"),
            Self::Warpsmith => include_str!("../../../prompts/roles/warpsmith.md"),
        }
    }
}

impl FromStr for Role {
    type Err = RoleError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|role| role.as_str() == value)
            .ok_or(RoleError::UnknownRole)
    }
}

#[derive(Clone, Debug, Deserialize)]
struct PromptManifest {
    version: u32,
    roles: Vec<PromptManifestEntry>,
}

#[derive(Clone, Debug, Deserialize)]
struct PromptManifestEntry {
    role: String,
    prompt_sha256: String,
    schema_sha256: String,
    model: String,
    reasoning: String,
    capabilities: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleSpec {
    pub role: Role,
    pub prompt: &'static str,
    pub prompt_hash: Hash256,
    pub schema_hash: Hash256,
    pub model: String,
    pub reasoning: String,
    pub capabilities: BTreeSet<String>,
}

pub fn role_specs() -> Result<Vec<RoleSpec>, RoleError> {
    let manifest: PromptManifest =
        serde_json::from_str(include_str!("../../../prompts/manifest.json"))
            .map_err(|_| RoleError::ManifestInvalid)?;
    if manifest.version != 1 || manifest.roles.len() != Role::ALL.len() {
        return Err(RoleError::ManifestInvalid);
    }
    let mut seen = BTreeSet::new();
    let mut specs = Vec::with_capacity(Role::ALL.len());
    for entry in manifest.roles {
        let role = Role::from_str(&entry.role)?;
        if !seen.insert(role) || entry.model.trim().is_empty() || entry.reasoning.trim().is_empty()
        {
            return Err(RoleError::ManifestInvalid);
        }
        let prompt_hash = Hash256::digest(role.prompt().as_bytes());
        if prompt_hash
            != Hash256::from_hex(&entry.prompt_sha256).map_err(|_| RoleError::HashDrift)?
        {
            return Err(RoleError::HashDrift);
        }
        specs.push(RoleSpec {
            role,
            prompt: role.prompt(),
            prompt_hash,
            schema_hash: Hash256::from_hex(&entry.schema_sha256)
                .map_err(|_| RoleError::ManifestInvalid)?,
            model: entry.model,
            reasoning: entry.reasoning,
            capabilities: entry.capabilities,
        });
    }
    Ok(specs)
}
