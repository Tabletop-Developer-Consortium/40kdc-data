use std::collections::BTreeSet;

use crate::{Role, RoleError, RoleRequest, RoleResult, RoleVerdict};

pub fn validate_semantics(request: &RoleRequest, result: &RoleResult) -> Result<(), RoleError> {
    if result.campaign_id != request.campaign_id
        || result.faction_id != request.ability.faction_id
        || result.ability_id != request.ability.ability_id
        || result.role != request.role
        || result.findings.iter().any(|finding| finding.severity > 3)
    {
        return Err(RoleError::ProvenanceMismatch);
    }

    match request.role {
        Role::ArchMagos => validate_arch_magos(request, result),
        Role::Eversor => {
            if request.voter.is_none()
                || !result
                    .payload
                    .get("divergences")
                    .is_some_and(|value| value.is_array())
            {
                Err(RoleError::SemanticInvalid("refuter-voter"))
            } else {
                Ok(())
            }
        }
        Role::Skitarius => validate_skitarius(result),
        Role::Cogitator => {
            if result
                .payload
                .get("lever_verdict")
                .and_then(|value| value.as_str())
                == Some("clean")
            {
                Ok(())
            } else {
                Err(RoleError::SemanticInvalid("lever-regression"))
            }
        }
        Role::Inquisitor => validate_inquisitor(request, result),
        Role::Chronomancer | Role::TargetDummy | Role::VoxHound => {
            if result
                .payload
                .as_object()
                .is_some_and(|payload| !payload.is_empty())
                && result
                    .payload
                    .get("deferred_lookups")
                    .and_then(|value| value.as_array())
                    .is_none_or(Vec::is_empty)
            {
                Ok(())
            } else {
                Err(RoleError::SemanticInvalid("deferred-lookup"))
            }
        }
        Role::KrootFleshShaper => {
            let verdict = result
                .payload
                .pointer("/self_grade/verdict")
                .or_else(|| result.payload.get("verdict"))
                .and_then(|value| value.as_str());
            match verdict {
                Some("new-shape") => {
                    require_object(&result.payload, "proposed_shape", "shape-proposal")?;
                    let resisted_schema = request
                        .sensitive_input
                        .get("resisted_schema")
                        .and_then(|value| {
                            value
                                .get("architecture")
                                .and_then(|architecture| architecture.as_object())
                                .or_else(|| value.as_object())
                        })
                        .ok_or(RoleError::SemanticInvalid("architecture"))?;
                    let expected_family = architecture_local_actions(resisted_schema)?;
                    let proposed_family = result
                        .payload
                        .get("internal_family")
                        .and_then(|value| value.as_array())
                        .ok_or(RoleError::SemanticInvalid("shape-internal-family"))?;
                    if proposed_family != expected_family {
                        return Err(RoleError::SemanticInvalid("shape-internal-family"));
                    }
                    Ok(())
                }
                Some("existing-fits") => {
                    let grounded = result
                        .payload
                        .get("nearest_existing_shapes")
                        .and_then(|value| value.as_array())
                        .is_some_and(|rows| !rows.is_empty());
                    if grounded {
                        Ok(())
                    } else {
                        Err(RoleError::SemanticInvalid("existing-shape-fit"))
                    }
                }
                Some("singleton")
                    if result
                        .payload
                        .get("mechanic")
                        .and_then(|value| value.as_str())
                        .is_some() =>
                {
                    Ok(())
                }
                Some("fail")
                    if result
                        .payload
                        .pointer("/self_grade/concerns")
                        .and_then(|value| value.as_array())
                        .is_some_and(|concerns| !concerns.is_empty()) =>
                {
                    Ok(())
                }
                _ => Err(RoleError::SemanticInvalid("shape-verdict")),
            }
        }
        Role::KrootLoneSpear => {
            let coverage = result
                .payload
                .get("coverage")
                .and_then(|value| value.as_array())
                .ok_or(RoleError::SemanticInvalid("shape-coverage"))?;
            let supplied_size = request
                .sensitive_input
                .get("internal_family")
                .and_then(|value| value.as_array())
                .map_or(0, Vec::len);
            let reported_size = result
                .payload
                .get("internal_family_size")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
                .ok_or(RoleError::SemanticInvalid("shape-internal-family-size"))?;
            if supplied_size != reported_size {
                return Err(RoleError::SemanticInvalid("shape-internal-family-size"));
            }
            let supplied_sweep = request
                .sensitive_input
                .get("swarmlord_sweep")
                .ok_or(RoleError::SemanticInvalid("shape-sweep-provenance"))?;
            if result.payload.get("swarmlord_sweep") != Some(supplied_sweep) {
                return Err(RoleError::SemanticInvalid("shape-sweep-provenance"));
            }
            let candidates = supplied_sweep
                .get("candidates")
                .and_then(|value| value.as_array())
                .ok_or(RoleError::SemanticInvalid("shape-sweep-provenance"))?;
            if survey_row_ids(candidates)? != survey_row_ids(coverage)? {
                return Err(RoleError::SemanticInvalid("shape-sweep-coverage"));
            }
            Ok(())
        }
        Role::KrootTrailShaper => {
            let forms = result
                .payload
                .get("render_rules")
                .and_then(|value| value.as_array());
            if forms.is_some_and(|forms| {
                !forms.is_empty()
                    && forms.iter().all(|form| {
                        form.get("form").and_then(|value| value.as_str()).is_some()
                            && form
                                .get("expected_output")
                                .and_then(|value| value.as_str())
                                .is_some()
                    })
            }) {
                Ok(())
            } else {
                Err(RoleError::SemanticInvalid("render-forms"))
            }
        }
        Role::KrootWarShaper => {
            if matches!(
                result.verdict,
                crate::RoleVerdict::Accept | crate::RoleVerdict::Pass
            ) && result
                .payload
                .get("shape_package")
                .and_then(|value| value.as_object())
                .is_some()
            {
                Ok(())
            } else if matches!(
                result.verdict,
                crate::RoleVerdict::Revise | crate::RoleVerdict::Reject | crate::RoleVerdict::Fail
            ) {
                Ok(())
            } else {
                Err(RoleError::SemanticInvalid("shape-review"))
            }
        }
        Role::Swarmlord => {
            let candidates = result
                .payload
                .get("candidates")
                .and_then(|value| value.as_array())
                .ok_or(RoleError::SemanticInvalid("shape-candidates"))?;
            let estimated_family_size = result
                .payload
                .get("estimated_family_size")
                .and_then(|value| value.as_u64())
                .ok_or(RoleError::SemanticInvalid("shape-family-size"))?;
            if estimated_family_size >= 1
                && (candidates.is_empty()
                    || candidates.iter().all(|candidate| candidate.is_object()))
            {
                Ok(())
            } else {
                Err(RoleError::SemanticInvalid("shape-candidates"))
            }
        }
        Role::Psyker => {
            if result.findings.iter().any(|finding| finding.severity == 3)
                && !matches!(
                    result.verdict,
                    crate::RoleVerdict::Revise
                        | crate::RoleVerdict::Reject
                        | crate::RoleVerdict::Fail
                )
            {
                Err(RoleError::SemanticInvalid("severity-three"))
            } else {
                Ok(())
            }
        }
        Role::DataEnginseer => {
            let packet = result
                .payload
                .get("evidence_packet")
                .unwrap_or(&result.payload);
            match require_array(packet, "clauses", "evidence-clauses") {
                Ok(()) => Ok(()),
                Err(_)
                    if result
                        .payload
                        .get("matches")
                        .is_some_and(|matches| matches.is_array()) =>
                {
                    Ok(())
                }
                Err(error) => Err(error),
            }
        }
        Role::Warpsmith => validate_warpsmith(request, result),
    }
}

fn validate_arch_magos(request: &RoleRequest, result: &RoleResult) -> Result<(), RoleError> {
    let needs_schema = match result.verdict {
        RoleVerdict::Accept => false,
        RoleVerdict::NeedsSchema => true,
        _ => return Err(RoleError::SemanticInvalid("arch-magos-verdict")),
    };
    let coverage_error = if needs_schema {
        "needs-schema-clause-coverage"
    } else {
        "clause-coverage"
    };
    let expected = string_array_set(
        request.sensitive_input.get("clause_ids"),
        "missing-clause-contract",
    )?;
    let mechanical = string_array_set(
        request.sensitive_input.get("mechanical_clause_ids"),
        "missing-mechanical-clause-contract",
    )?;
    let coverage = result
        .payload
        .get("clause_coverage")
        .and_then(|value| value.as_array())
        .ok_or(RoleError::SemanticInvalid("missing-clause-coverage"))?;
    let actual = coverage
        .iter()
        .map(|row| {
            row.get("clause_id")
                .and_then(|value| value.as_str())
                .ok_or(RoleError::SemanticInvalid(coverage_error))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let mut unresolved_mechanical = false;
    let invalid_row = coverage.iter().any(|row| {
        let clause_id = row
            .get("clause_id")
            .and_then(|value| value.as_str())
            .expect("parsed above");
        let disposition = row.get("disposition").and_then(|value| value.as_str());
        let evidence = row.get("evidence").and_then(|value| value.as_str());
        if mechanical.contains(clause_id)
            && needs_schema
            && disposition == Some("unresolved")
            && matches!(evidence, Some("source-explicit" | "schema-derived"))
        {
            unresolved_mechanical = true;
            false
        } else if mechanical.contains(clause_id) {
            disposition != Some("exact")
                || !matches!(evidence, Some("source-explicit" | "schema-derived"))
        } else {
            !matches!(disposition, Some("exact" | "declared-nonmechanical"))
                || !matches!(evidence, Some("source-explicit" | "schema-derived"))
        }
    });
    let dropped_clauses_empty = result
        .payload
        .get("dropped_clauses")
        .and_then(|value| value.as_array())
        .is_some_and(Vec::is_empty);
    let resisted_schema_complete = result
        .payload
        .get("resisted_schema")
        .and_then(|value| value.as_object())
        .is_some_and(|package| {
            ["mechanic", "resists_schema", "proposal", "also_unblocks"]
                .iter()
                .all(|field| {
                    package
                        .get(*field)
                        .and_then(|value| value.as_str())
                        .is_some_and(|value| !value.trim().is_empty())
                })
        });
    let needs_schema_dsl_present = result
        .payload
        .get("dsl")
        .and_then(|value| value.as_object())
        .and_then(|dsl| dsl.get("ability_id"))
        .and_then(|value| value.as_str())
        == Some(request.ability.ability_id.as_str());
    if expected != actual
        || coverage.len() != actual.len()
        || !mechanical.is_subset(&expected)
        || invalid_row
        || !dropped_clauses_empty
        || result
            .payload
            .get("placeholder_encoding")
            .and_then(|value| value.as_bool())
            != Some(false)
        || result
            .payload
            .get("approx_mechanical")
            .and_then(|value| value.as_bool())
            != Some(false)
        || (needs_schema
            && (!unresolved_mechanical || !resisted_schema_complete || !needs_schema_dsl_present))
    {
        Err(RoleError::SemanticInvalid(coverage_error))
    } else {
        Ok(())
    }
}

fn string_array_set<'a>(
    value: Option<&'a serde_json::Value>,
    error: &'static str,
) -> Result<BTreeSet<&'a str>, RoleError> {
    value
        .and_then(|value| value.as_array())
        .ok_or(RoleError::SemanticInvalid(error))?
        .iter()
        .map(|value| value.as_str().ok_or(RoleError::SemanticInvalid(error)))
        .collect()
}

fn validate_skitarius(result: &RoleResult) -> Result<(), RoleError> {
    let gates = result
        .payload
        .get("gates")
        .and_then(|value| value.as_array())
        .ok_or(RoleError::SemanticInvalid("missing-gates"))?;
    if gates.is_empty()
        || gates
            .iter()
            .any(|gate| gate.get("status").and_then(|value| value.as_str()) != Some("pass"))
    {
        Err(RoleError::SemanticInvalid("gate-failure"))
    } else {
        Ok(())
    }
}
fn validate_inquisitor(request: &RoleRequest, result: &RoleResult) -> Result<(), RoleError> {
    if request
        .sensitive_input
        .get("mode")
        .and_then(|value| value.as_str())
        == Some("architect")
    {
        let architecture = result
            .payload
            .get("architecture")
            .and_then(|value| value.as_object())
            .ok_or(RoleError::SemanticInvalid("architecture"))?;
        let route = architecture.get("route").and_then(|value| value.as_str());
        let source_clauses = architecture
            .get("source_clause_ids")
            .and_then(|value| value.as_array())
            .ok_or(RoleError::SemanticInvalid("architecture-clause-coverage"))?;
        let expected_source_clauses = request
            .sensitive_input
            .pointer("/evidence_packet/clauses")
            .and_then(|value| value.as_array())
            .ok_or(RoleError::SemanticInvalid("architecture-clause-coverage"))?
            .iter()
            .map(|clause| {
                clause
                    .get("id")
                    .and_then(|value| value.as_str())
                    .ok_or(RoleError::SemanticInvalid("architecture-clause-coverage"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let reported_source_clauses = source_clauses
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or(RoleError::SemanticInvalid("architecture-clause-coverage"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let exact_fit = architecture
            .get("existing_shape_fit")
            .and_then(|value| value.as_object());
        if expected_source_clauses != reported_source_clauses
            || source_clauses.len() != reported_source_clauses.len()
            || source_clauses.is_empty()
        {
            return Err(RoleError::SemanticInvalid("architecture-clause-coverage"));
        }
        if !matches!(route, Some("existing-shape" | "shape-scout"))
            || (route == Some("existing-shape")
                && exact_fit
                    .and_then(|fit| fit.get("verdict"))
                    .and_then(|value| value.as_str())
                    != Some("exact"))
        {
            return Err(RoleError::SemanticInvalid("architecture"));
        }
        architecture_local_actions(architecture)?;
    }
    if let Some(rows) = result
        .payload
        .get("anti_conditions")
        .and_then(|value| value.as_array())
    {
        let ids = rows
            .iter()
            .filter(|row| row.get("pass").and_then(|value| value.as_bool()) == Some(true))
            .filter_map(|row| row.get("id").and_then(|value| value.as_u64()))
            .collect::<BTreeSet<_>>();
        if ids != (1..=10).collect() {
            return Err(RoleError::SemanticInvalid("anti-conditions"));
        }
    }
    Ok(())
}

fn architecture_local_actions(
    architecture: &serde_json::Map<String, serde_json::Value>,
) -> Result<&Vec<serde_json::Value>, RoleError> {
    let actions = architecture
        .get("local_actions")
        .and_then(|value| value.as_array())
        .ok_or(RoleError::SemanticInvalid("architecture-internal-family"))?;
    let declared_size = architecture
        .get("internal_family_size")
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(RoleError::SemanticInvalid("architecture-internal-family"))?;
    if declared_size != actions.len() {
        return Err(RoleError::SemanticInvalid("architecture-internal-family"));
    }

    let mut child_ids = BTreeSet::new();
    let mut clause_ids = BTreeSet::new();
    let mut parent_id = None;
    let mut contract_id = None;
    for action in actions {
        let child_id = action
            .get("child_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or(RoleError::SemanticInvalid("architecture-internal-family"))?;
        let action_parent = action
            .get("parent_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or(RoleError::SemanticInvalid("architecture-internal-family"))?;
        let action_contract = action
            .get("shared_contract_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or(RoleError::SemanticInvalid("architecture-internal-family"))?;
        let action_clauses = action
            .get("clause_ids")
            .and_then(|value| value.as_array())
            .ok_or(RoleError::SemanticInvalid("architecture-internal-family"))?;
        if !child_ids.insert(child_id)
            || action
                .get("parent_closed")
                .and_then(|value| value.as_bool())
                != Some(true)
            || parent_id.is_some_and(|value| value != action_parent)
            || contract_id.is_some_and(|value| value != action_contract)
            || action_clauses.iter().any(|clause| {
                clause
                    .as_str()
                    .is_none_or(|clause_id| !clause_ids.insert(clause_id))
            })
        {
            return Err(RoleError::SemanticInvalid("architecture-internal-family"));
        }
        parent_id = Some(action_parent);
        contract_id = Some(action_contract);
    }

    Ok(actions)
}
fn survey_row_ids<'a>(
    rows: &'a [serde_json::Value],
) -> Result<BTreeSet<(&'a str, &'a str)>, RoleError> {
    let ids = rows
        .iter()
        .map(|row| {
            let faction = row
                .get("faction")
                .or_else(|| row.get("faction_id"))
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .ok_or(RoleError::SemanticInvalid("shape-sweep-coverage"))?;
            let ability = row
                .get("ability_id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .ok_or(RoleError::SemanticInvalid("shape-sweep-coverage"))?;
            Ok((faction, ability))
        })
        .collect::<Result<BTreeSet<_>, RoleError>>()?;
    if ids.len() != rows.len() {
        return Err(RoleError::SemanticInvalid("shape-sweep-coverage"));
    }
    Ok(ids)
}

fn validate_warpsmith(request: &RoleRequest, result: &RoleResult) -> Result<(), RoleError> {
    if request
        .sensitive_input
        .get("mode")
        .and_then(|value| value.as_str())
        == Some("implementation-package")
    {
        let files = result
            .payload
            .get("files")
            .and_then(|value| value.as_array())
            .ok_or(RoleError::SemanticInvalid("implementation-files"))?;
        let mut paths = BTreeSet::new();
        if files.is_empty()
            || files.iter().any(|file| {
                file.get("path")
                    .and_then(|value| value.as_str())
                    .is_none_or(|path| !paths.insert(path))
                    || file
                        .get("content")
                        .and_then(|value| value.as_str())
                        .is_none()
            })
        {
            return Err(RoleError::SemanticInvalid("implementation-files"));
        }
        return Ok(());
    }
    require_array(&result.payload, "decisions", "warpsmith-decisions")
}

fn require_array(
    payload: &serde_json::Value,
    field: &str,
    code: &'static str,
) -> Result<(), RoleError> {
    if payload
        .get(field)
        .and_then(|value| value.as_array())
        .is_some_and(|values| !values.is_empty())
    {
        Ok(())
    } else {
        Err(RoleError::SemanticInvalid(code))
    }
}

fn require_object(
    payload: &serde_json::Value,
    field: &str,
    code: &'static str,
) -> Result<(), RoleError> {
    if payload
        .get(field)
        .and_then(|value| value.as_object())
        .is_some()
    {
        Ok(())
    } else {
        Err(RoleError::SemanticInvalid(code))
    }
}
