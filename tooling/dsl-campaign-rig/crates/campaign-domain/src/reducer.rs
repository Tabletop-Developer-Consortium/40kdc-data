use crate::{
    AbilityAggregate, AbilityPhase, CampaignPhase, CampaignState, ClauseSet, DomainError,
    DomainEvent, EventPayload, ShapeAggregate, ShapePhase,
};

pub fn evolve(state: &mut CampaignState, event: &DomainEvent) -> Result<(), DomainError> {
    if event.stream_version != state.stream_version + 1 {
        return Err(DomainError::VersionConflict);
    }
    use EventPayload as E;
    match &event.payload {
        E::CampaignCreated { campaign_id } => {
            state.campaign_id = Some(campaign_id.clone());
            state.phase = CampaignPhase::Created;
        }
        E::ManifestFrozen {
            manifest,
            manifest_hash,
        } => {
            state.manifest = Some(manifest.clone());
            state.manifest_hash = Some(*manifest_hash);
            state.repository_head = Some(manifest.base_commit_id.clone());
            state.phase = CampaignPhase::ManifestFrozen;
        }
        E::CampaignStarted => state.phase = CampaignPhase::Running,
        E::AbilityQueued {
            key,
            source_hash,
            score_start,
        } => {
            state.abilities.insert(
                key.clone(),
                AbilityAggregate {
                    phase: AbilityPhase::Queued,
                    evidence_hash: None,
                    source_hash: *source_hash,
                    clauses: None,
                    architecture_hash: None,
                    requires_shape: false,
                    required_shape_id: None,
                    decomposer_hashes: Default::default(),
                    decomposition_hash: None,
                    candidate_hash: None,
                    revision_thread_hash: None,
                    attempt: 0,
                    escalated: false,
                    voters: Default::default(),
                    voter_identity_hashes: Default::default(),
                    blocking_divergences: Default::default(),
                    applied_hash: None,
                    apply_plan_hash: None,
                    applied_commit: None,
                    rollback_evidence_hash: None,
                    rollback_head: None,
                    rollback_terminal: false,
                    verification_hash: None,
                    review_hash: None,
                    reviewer_hashes: Default::default(),
                    score_start: *score_start,
                    score_final: None,
                    correctness_justification_hash: None,
                },
            );
        }
        E::EvidenceBound { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::EvidenceBound;
            ability.evidence_hash = Some(facts.artifact_hash);
            ability.clauses = Some(ClauseSet {
                all: facts.all_clause_ids.clone(),
                mechanical: facts.mechanical_clause_ids.clone(),
            });
        }
        E::ArchitectureRecorded { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::Architected;
            ability.architecture_hash = Some(facts.artifact_hash);
            ability.requires_shape = facts.requires_shape;
        }
        E::DecomposerResultRecorded {
            key,
            role,
            artifact_hash,
            ..
        } => {
            ability_mut(state, key)?
                .decomposer_hashes
                .insert(role.clone(), *artifact_hash);
        }
        E::DecompositionRecorded { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::Decomposed;
            ability.decomposition_hash = Some(facts.artifact_hash);
        }
        E::ShapeRequired { key, shape_id } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::ShapeRequired;
            ability.required_shape_id = Some(shape_id.clone());
            if let Some(shape) = state.shapes.get_mut(shape_id) {
                shape.family_members.insert(key.clone());
            }
        }
        E::ShapeSurveyRecorded { key, .. } => {
            ability_mut(state, key)?.phase = AbilityPhase::ShapeSurveyed
        }
        E::CandidateProposed { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::CandidateProposed;
            ability.candidate_hash = Some(facts.artifact_hash);
            ability.attempt = facts.attempt;
            ability.voters.clear();
            ability.voter_identity_hashes.clear();
            ability.reviewer_hashes.clear();
            ability.blocking_divergences.clear();
        }
        E::RefutationPanelOpened { key, escalated } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::RefutationPanel;
            ability.escalated = *escalated;
        }
        E::RefutationRecorded { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.voters.insert(facts.voter, facts.artifact_hash);
            ability
                .voter_identity_hashes
                .insert(facts.voter_identity_hash);
            ability
                .blocking_divergences
                .extend(facts.divergence_ids.clone());
        }
        E::RevisionRequested {
            key, thread_hash, ..
        } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::RevisionRequested;
            ability.revision_thread_hash = Some(*thread_hash);
        }
        E::CandidateAccepted { key } => {
            ability_mut(state, key)?.phase = AbilityPhase::CandidateAccepted
        }
        E::AbilityMarkedNeedsSchema { key, .. } => {
            ability_mut(state, key)?.phase = AbilityPhase::NeedsSchema
        }
        E::AbilityAbandoned { key, .. } => ability_mut(state, key)?.phase = AbilityPhase::Abandoned,
        E::ApplyRequested { key, plan_hash, .. } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::ApplyRequested;
            ability.apply_plan_hash = Some(*plan_hash);
        }
        E::PatchApplied {
            key,
            applied_hash,
            commit_id,
            ..
        } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::Applied;
            ability.applied_hash = Some(*applied_hash);
            ability.applied_commit = Some(commit_id.clone());
            state.repository_head = Some(commit_id.clone());
        }
        E::MechanicalVerificationFailed {
            key, evidence_hash, ..
        } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::VerificationFailed;
            ability.verification_hash = Some(*evidence_hash);
        }
        E::AbilityRollbackRequested {
            key,
            evidence_hash,
            restore_head,
            terminal,
        } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::RollbackRequested;
            ability.rollback_evidence_hash = Some(*evidence_hash);
            ability.rollback_head = Some(restore_head.clone());
            ability.rollback_terminal = *terminal;
        }
        E::AbilityRolledBack {
            key, restored_head, ..
        } => {
            let ability = ability_mut(state, key)?;
            ability.phase = if ability.rollback_terminal {
                AbilityPhase::NeedsSchema
            } else {
                ability.revision_thread_hash = ability.rollback_evidence_hash;
                AbilityPhase::RevisionRequested
            };
            state.repository_head = Some(restored_head.clone());
        }
        E::MechanicalVerificationRecorded { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::MechanicallyVerified;
            ability.verification_hash = Some(facts.artifact_hash);
            ability.score_final = Some(facts.score_final);
            ability.correctness_justification_hash = facts.correctness_justification_hash;
            state.gate_runs = state.gate_runs.max(facts.gate_run);
        }
        E::ReviewerResultRecorded {
            key,
            role,
            artifact_hash,
            ..
        } => {
            ability_mut(state, key)?
                .reviewer_hashes
                .insert(role.clone(), *artifact_hash);
        }
        E::ReviewRecorded { key, facts } => {
            let ability = ability_mut(state, key)?;
            ability.phase =
                if facts.accepted && facts.severity3_count == 0 && facts.ten_anti_conditions_passed
                {
                    AbilityPhase::Reviewed
                } else {
                    AbilityPhase::RevisionRequested
                };
            ability.review_hash = Some(facts.artifact_hash);
        }
        E::ReviewRevisionRequested {
            key,
            thread_hash,
            finding_ids,
            ..
        } => {
            let ability = ability_mut(state, key)?;
            ability.phase = AbilityPhase::RevisionRequested;
            ability.revision_thread_hash = Some(*thread_hash);
            ability.blocking_divergences = finding_ids.clone();
            ability.reviewer_hashes.clear();
            ability.review_hash = None;
        }
        E::AbilityConverged { key } => ability_mut(state, key)?.phase = AbilityPhase::Converged,
        E::ShapeProposed {
            shape_id,
            package_hash,
        } => {
            state.shapes.insert(
                shape_id.clone(),
                ShapeAggregate {
                    phase: ShapePhase::Proposed,
                    family_hashes: Vec::new(),
                    family_members: Default::default(),
                    internal_family_size: 0,
                    describer_hash: None,
                    excluded_members: Default::default(),
                    review_hashes: Vec::new(),
                    review_round: 0,
                    package_hash: Some(*package_hash),
                    apply_plan_hash: None,
                    applied_hash: None,
                    applied_commit: None,
                    verification_hash: None,
                },
            );
        }
        E::ShapeFamilySurveyed {
            shape_id,
            survey_hash,
            internal_family_size,
            members,
            flattening_exclusions,
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.phase = ShapePhase::FamilySurveyed;
            shape.family_hashes.push(*survey_hash);
            shape.family_members = members.clone();
            shape.internal_family_size = *internal_family_size;
            shape.excluded_members = flattening_exclusions.clone();
        }
        E::ShapeDescriberSpecified {
            shape_id,
            artifact_hash,
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.describer_hash = Some(*artifact_hash);
            shape.phase = ShapePhase::DescriberSpecified;
        }
        E::ShapeReviewRecorded {
            shape_id,
            artifact_hash,
            accepted,
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.review_round += 1;
            shape.review_hashes.push(*artifact_hash);
            shape.phase = if *accepted {
                ShapePhase::UnderReview
            } else {
                ShapePhase::RevisionRequested
            };
        }
        E::ShapeApproved { shape_id } => shape_mut(state, shape_id)?.phase = ShapePhase::Approved,
        E::ShapeApplyRequested {
            shape_id,
            plan_hash,
            ..
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.phase = ShapePhase::ApplyRequested;
            shape.apply_plan_hash = Some(*plan_hash);
        }
        E::ShapeApplied {
            shape_id,
            applied_hash,
            commit_id,
            ..
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.phase = ShapePhase::Applied;
            shape.applied_hash = Some(*applied_hash);
            shape.applied_commit = Some(commit_id.clone());
            state.repository_head = Some(commit_id.clone());
        }
        E::ShapeVerificationRecorded {
            shape_id,
            artifact_hash,
            ..
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.phase = ShapePhase::Verified;
            shape.verification_hash = Some(*artifact_hash);
        }
        E::ShapeRolledBack {
            shape_id,
            artifact_hash,
            restored_head,
            ..
        } => {
            let shape = shape_mut(state, shape_id)?;
            shape.phase = ShapePhase::NotConverged;
            shape.verification_hash = Some(*artifact_hash);
            state.repository_head = Some(restored_head.clone());
        }
        E::ShapeRejected {
            shape_id,
            singleton,
        } => {
            shape_mut(state, shape_id)?.phase = if *singleton {
                ShapePhase::RejectedSingleton
            } else {
                ShapePhase::RejectedSprawl
            };
        }
        E::SealRequested => state.phase = CampaignPhase::Sealing,
        E::CampaignSealed { base, head } => {
            state.phase = CampaignPhase::Sealed;
            state.sealed_base = Some(base.clone());
            state.sealed_head = Some(head.clone());
            state.repository_head = Some(head.clone());
        }
        E::CloseVerificationRecorded { facts } => {
            state.close_gate_runs = state.close_gate_runs.saturating_add(1);
            state.phase = CampaignPhase::CloseVerified;
            state.close_verification_hash = Some(facts.artifact_hash);
        }
        E::CloseVerificationFailed {
            artifact_hash,
            terminal,
            ..
        } => {
            state.close_gate_runs = state.close_gate_runs.saturating_add(1);
            state.close_verification_hash = Some(*artifact_hash);
            state.phase = if *terminal {
                CampaignPhase::Aborted
            } else {
                CampaignPhase::Sealed
            };
        }
        E::PublicationAuthorized { sealed_head } => {
            state.phase = CampaignPhase::PublishAuthorized;
            state.publication_authorized_head = Some(sealed_head.clone());
        }
        E::PublicationRequested { .. } => state.phase = CampaignPhase::Publishing,
        E::PublicationProgressRecorded { effect_hash, .. } => {
            state.publication_effect_hash = Some(*effect_hash);
        }
        E::CampaignPublished { effect_hash, .. } => {
            state.phase = CampaignPhase::Published;
            state.publication_effect_hash = Some(*effect_hash);
        }
        E::CampaignAbortRequested { .. } => state.phase = CampaignPhase::Aborting,
        E::CampaignAborted => state.phase = CampaignPhase::Aborted,
        E::LegacyEvidenceImported { .. } => {}
    }
    state.stream_version = event.stream_version;
    Ok(())
}

pub fn replay<'a>(
    events: impl IntoIterator<Item = &'a DomainEvent>,
) -> Result<CampaignState, DomainError> {
    let mut state = CampaignState::default();
    for event in events {
        evolve(&mut state, event)?;
    }
    Ok(state)
}

fn ability_mut<'a>(
    state: &'a mut CampaignState,
    key: &crate::AbilityKey,
) -> Result<&'a mut AbilityAggregate, DomainError> {
    state
        .abilities
        .get_mut(key)
        .ok_or(DomainError::OutOfManifestMember)
}

fn shape_mut<'a>(
    state: &'a mut CampaignState,
    shape_id: &crate::ShapeId,
) -> Result<&'a mut ShapeAggregate, DomainError> {
    state
        .shapes
        .get_mut(shape_id)
        .ok_or(DomainError::WrongState)
}
