use serde_json::Value;

use crate::RoleError;

const ROLE_RESULT_SCHEMA: &str = include_str!("../../../contracts/role-result.schema.json");

pub fn validate_role_result(value: &Value) -> Result<(), RoleError> {
    let schema: Value =
        serde_json::from_str(ROLE_RESULT_SCHEMA).map_err(|_| RoleError::ManifestInvalid)?;
    let validator = jsonschema::validator_for(&schema).map_err(|_| RoleError::ManifestInvalid)?;
    if validator.is_valid(value) {
        Ok(())
    } else {
        Err(RoleError::SchemaInvalid)
    }
}

pub fn validate_contract_bundle() -> Result<(), RoleError> {
    const CONTRACTS: [&str; 11] = [
        include_str!("../../../contracts/role-request.schema.json"),
        ROLE_RESULT_SCHEMA,
        include_str!("../../../contracts/evidence-packet.schema.json"),
        include_str!("../../../contracts/architecture.schema.json"),
        include_str!("../../../contracts/decomposition.schema.json"),
        include_str!("../../../contracts/candidate.schema.json"),
        include_str!("../../../contracts/refutation.schema.json"),
        include_str!("../../../contracts/verification.schema.json"),
        include_str!("../../../contracts/review.schema.json"),
        include_str!("../../../contracts/shape-package.schema.json"),
        include_str!("../../../contracts/close-review.schema.json"),
    ];
    for raw in CONTRACTS {
        let schema: Value = serde_json::from_str(raw).map_err(|_| RoleError::ManifestInvalid)?;
        if schema.get("type") != Some(&Value::String("object".into()))
            || schema.get("additionalProperties") != Some(&Value::Bool(false))
        {
            return Err(RoleError::ManifestInvalid);
        }
        jsonschema::validator_for(&schema).map_err(|_| RoleError::ManifestInvalid)?;
    }
    Ok(())
}
