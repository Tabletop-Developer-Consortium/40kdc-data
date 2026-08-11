use campaign_domain::Hash256;

use crate::{RoleError, RoleSpec, role_specs};

pub fn verified_prompt(role: crate::Role, expected_hash: Hash256) -> Result<RoleSpec, RoleError> {
    let spec = role_specs()?
        .into_iter()
        .find(|spec| spec.role == role)
        .ok_or(RoleError::UnknownRole)?;
    if spec.prompt_hash != expected_hash {
        return Err(RoleError::HashDrift);
    }
    Ok(spec)
}
