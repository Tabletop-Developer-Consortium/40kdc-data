use std::collections::BTreeSet;

use crate::{
    AbilityPhase, CampaignPhase, CampaignState, Command, CommandAction, DomainError, DomainEvent,
    EventPayload, ShapePhase, guard,
};

pub fn decide(state: &CampaignState, command: &Command) -> Result<Vec<DomainEvent>, DomainError> {
    guard::stream_version(state, command.meta.expected_stream_version)?;
    guard::campaign_identity(state, &command.meta.campaign_id)?;

    if state.manifest.is_some() {
        guard::manifest_identity(state, command.meta.expected_manifest_hash)?;
        let manifest = state.manifest.as_ref().expect("checked above");
        if command.meta.expected_engine_hash != manifest.identities.executable_hash {
            return Err(DomainError::ManifestMismatch);
        }
    }
    if guard::terminal_or_aborting(state)
        && !matches!(command.action, CommandAction::AbortCampaign { .. })
    {
        return Err(DomainError::WrongState);
    }
    if matches!(
        command.action,
        CommandAction::RecordAppliedPatch { .. }
            | CommandAction::RecordMechanicalVerification { .. }
            | CommandAction::RecordMechanicalVerificationFailure { .. }
            | CommandAction::RecordShapeApplied { .. }
            | CommandAction::RecordAbilityRollback { .. }
            | CommandAction::RecordShapeVerification { .. }
            | CommandAction::RecordShapeRollback { .. }
            | CommandAction::RecordCloseVerification { .. }
            | CommandAction::RecordCloseFailure { .. }
            | CommandAction::RecordPublication { .. }
            | CommandAction::RecordPublicationProgress { .. }
    ) && (command.meta.outbox_id.is_none() || command.meta.fencing_token.is_none())
    {
        return Err(DomainError::StaleLease);
    }

    let payloads = decide_action(state, &command.meta.campaign_id, &command.action)?;
    Ok(payloads
        .into_iter()
        .enumerate()
        .map(|(offset, payload)| DomainEvent {
            command_id: command.meta.command_id,
            stream_version: state.stream_version + offset as u64 + 1,
            payload,
        })
        .collect())
}

fn decide_action(
    state: &CampaignState,
    campaign_id: &crate::CampaignId,
    action: &CommandAction,
) -> Result<Vec<EventPayload>, DomainError> {
    use CommandAction as C;
    use EventPayload as E;

    let one = |event| Ok(vec![event]);
    match action {
        C::CreateCampaign => {
            if state.phase != CampaignPhase::Empty {
                return Err(DomainError::AlreadyExists);
            }
            one(E::CampaignCreated {
                campaign_id: campaign_id.clone(),
            })
        }
        C::FreezeManifest { manifest } => {
            if state.phase != CampaignPhase::Created || state.manifest.is_some() {
                return Err(DomainError::WrongState);
            }
            if state.campaign_id.as_ref() != Some(&manifest.campaign_id) {
                return Err(DomainError::ManifestMismatch);
            }
            manifest.validate()?;
            one(E::ManifestFrozen {
                manifest: manifest.clone(),
                manifest_hash: manifest.canonical_hash()?,
            })
        }
        C::ImportLegacyEvidence { report_hash } => {
            if !matches!(
                state.phase,
                CampaignPhase::ManifestFrozen | CampaignPhase::Running
            ) {
                return Err(DomainError::WrongState);
            }
            one(E::LegacyEvidenceImported {
                report_hash: *report_hash,
            })
        }
        C::StartCampaign => {
            if state.phase != CampaignPhase::ManifestFrozen {
                return Err(DomainError::WrongState);
            }
            one(E::CampaignStarted)
        }
        C::QueueAbility { key } => {
            guard::running(state)?;
            guard::manifest_member(state, key)?;
            if state.abilities.contains_key(key) {
                return Err(DomainError::Duplicate);
            }
            let item = state
                .manifest
                .as_ref()
                .and_then(|manifest| {
                    manifest
                        .ordered_worklist
                        .iter()
                        .find(|item| item.key == *key)
                })
                .ok_or(DomainError::OutOfManifestMember)?;
            one(E::AbilityQueued {
                key: key.clone(),
                source_hash: item.source_hash,
                score_start: item.cosine_start,
            })
        }
        C::BindEvidence { key, facts } => {
            require_ability(state, key, AbilityPhase::Queued)?;
            if !facts.contiguous_partition
                || facts.all_clause_ids.is_empty()
                || !facts.mechanical_clause_ids.is_subset(&facts.all_clause_ids)
                || state.abilities[key].source_hash != facts.source_hash
            {
                return Err(DomainError::ClauseCoverageMismatch);
            }
            one(E::EvidenceBound {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::RecordArchitecture { key, facts } => {
            let ability = require_ability(state, key, AbilityPhase::EvidenceBound)?;
            if ability.evidence_hash != Some(facts.evidence_hash) {
                return Err(DomainError::StaleParentArtifact);
            }
            guard::exact_clause_coverage(
                &ability.clauses.as_ref().expect("evidence bound").all,
                &facts.covered_clause_ids,
            )?;
            if !facts.closed_parent || !facts.unresolved_bindings.is_empty() {
                return Err(DomainError::ClauseCoverageMismatch);
            }
            one(E::ArchitectureRecorded {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::RecordDecomposerResult {
            key,
            role,
            architecture_hash,
            artifact_hash,
        } => {
            let ability = require_ability(state, key, AbilityPhase::Architected)?;
            if ability.architecture_hash != Some(*architecture_hash) {
                return Err(DomainError::StaleParentArtifact);
            }
            if !matches!(role.as_str(), "target-dummy" | "chronomancer" | "vox-hound")
                || ability.decomposer_hashes.contains_key(role)
            {
                return Err(DomainError::Duplicate);
            }
            one(E::DecomposerResultRecorded {
                key: key.clone(),
                role: role.clone(),
                architecture_hash: *architecture_hash,
                artifact_hash: *artifact_hash,
            })
        }
        C::RecordDecomposition { key, facts } => {
            let ability = require_ability(state, key, AbilityPhase::Architected)?;
            if ability.architecture_hash != Some(facts.architecture_hash) {
                return Err(DomainError::StaleParentArtifact);
            }
            if ability.decomposer_hashes.len() != 3
                || !["target-dummy", "chronomancer", "vox-hound"]
                    .iter()
                    .all(|role| ability.decomposer_hashes.contains_key(*role))
            {
                return Err(DomainError::ClauseCoverageMismatch);
            }
            guard::exact_clause_coverage(
                &ability.clauses.as_ref().expect("architected").all,
                &facts.covered_clause_ids,
            )?;
            if !facts.who_complete
                || !facts.when_complete
                || !facts.what_complete
                || !facts.deferred_lookups.is_empty()
            {
                return Err(DomainError::ClauseCoverageMismatch);
            }
            one(E::DecompositionRecorded {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::RequireShape { key, shape_id } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            if !matches!(
                ability.phase,
                AbilityPhase::Architected | AbilityPhase::Decomposed
            ) {
                return Err(DomainError::WrongState);
            }
            one(E::ShapeRequired {
                key: key.clone(),
                shape_id: shape_id.clone(),
            })
        }
        C::OpenShapeLifecycle {
            key,
            shape_id,
            package_hash,
        } => {
            let ability = require_ability(state, key, AbilityPhase::Decomposed)?;
            if !ability.requires_shape || state.shapes.contains_key(shape_id) {
                return Err(DomainError::WrongState);
            }
            Ok(vec![
                E::ShapeProposed {
                    originating_ability: Some(key.clone()),
                    shape_id: shape_id.clone(),
                    package_hash: *package_hash,
                },
                E::ShapeRequired {
                    key: key.clone(),
                    shape_id: shape_id.clone(),
                },
            ])
        }
        C::RecordShapeSurvey { key, artifact_hash } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            if ability.phase == AbilityPhase::Decomposed
                && ability.requires_shape
                && ability.required_shape_id.is_none()
            {
                return one(E::ShapeSurveyRecorded {
                    key: key.clone(),
                    artifact_hash: *artifact_hash,
                });
            }
            if ability.phase != AbilityPhase::ShapeRequired {
                return Err(DomainError::WrongState);
            }
            let shape = ability
                .required_shape_id
                .as_ref()
                .and_then(|shape_id| state.shapes.get(shape_id))
                .ok_or(DomainError::WrongState)?;
            if shape.phase != ShapePhase::Verified
                || shape.verification_hash != Some(*artifact_hash)
            {
                return Err(DomainError::WrongState);
            }
            one(E::ShapeSurveyRecorded {
                key: key.clone(),
                artifact_hash: *artifact_hash,
            })
        }
        C::ProposeCandidate { key, facts } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            if !matches!(
                ability.phase,
                AbilityPhase::Decomposed
                    | AbilityPhase::ShapeSurveyed
                    | AbilityPhase::RevisionRequested
            ) {
                return Err(DomainError::WrongState);
            }
            if facts.decomposition_hash
                != ability
                    .decomposition_hash
                    .ok_or(DomainError::StaleParentArtifact)?
            {
                return Err(DomainError::StaleParentArtifact);
            }
            let budgets = &state.manifest.as_ref().expect("running campaign").budgets;
            if facts.attempt == 0
                || facts.attempt > budgets.max_assembly_attempts
                || facts.attempt != ability.attempt + 1
            {
                return Err(DomainError::AttemptBudgetExhausted);
            }
            let clauses = ability
                .clauses
                .as_ref()
                .expect("candidate requires evidence");
            guard::exact_clause_coverage(&clauses.mechanical, &facts.exactly_mapped_clauses)?;
            guard::exact_clause_coverage(
                &clauses.mechanical,
                &facts.source_or_schema_evidence_clauses,
            )?;
            if facts.placeholder_encoding {
                return Err(DomainError::PlaceholderEncoding);
            }
            if facts.approx_mechanical_clause {
                return Err(DomainError::ApproxMechanicalClause);
            }
            if ability.phase == AbilityPhase::RevisionRequested {
                if facts.revision_thread_hash != ability.revision_thread_hash
                    || facts.prior_divergence_ids != ability.blocking_divergences
                {
                    return Err(DomainError::IncompleteRevisionThread);
                }
            }
            one(E::CandidateProposed {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::OpenRefutationPanel { key, escalated } => {
            require_ability(state, key, AbilityPhase::CandidateProposed)?;
            one(E::RefutationPanelOpened {
                key: key.clone(),
                escalated: *escalated,
            })
        }
        C::RecordRefutation { key, facts } => {
            let ability = require_ability(state, key, AbilityPhase::RefutationPanel)?;
            if ability.candidate_hash != Some(facts.candidate_hash) {
                return Err(DomainError::StaleParentArtifact);
            }
            let required = if ability.escalated {
                state.manifest.as_ref().unwrap().budgets.escalated_refuters
            } else {
                state.manifest.as_ref().unwrap().budgets.routine_refuters
            };
            if facts.voter == 0
                || facts.voter > required
                || ability.voters.contains_key(&facts.voter)
            {
                return Err(DomainError::Duplicate);
            }
            if ability
                .voter_identity_hashes
                .contains(&facts.voter_identity_hash)
            {
                return Err(DomainError::Duplicate);
            }
            one(E::RefutationRecorded {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::RequestRevision {
            key,
            thread_hash,
            resolved_divergence_ids,
        } => {
            let ability = require_ability(state, key, AbilityPhase::RefutationPanel)?;
            ensure_quorum(state, ability)?;
            if ability.blocking_divergences.is_empty()
                || &ability.blocking_divergences != resolved_divergence_ids
            {
                return Err(DomainError::IncompleteRevisionThread);
            }
            if ability.attempt
                >= state
                    .manifest
                    .as_ref()
                    .unwrap()
                    .budgets
                    .max_assembly_attempts
            {
                return Err(DomainError::AttemptBudgetExhausted);
            }
            one(E::RevisionRequested {
                key: key.clone(),
                thread_hash: *thread_hash,
                resolved_divergence_ids: resolved_divergence_ids.clone(),
            })
        }
        C::AcceptCandidate { key } => {
            let ability = require_ability(state, key, AbilityPhase::RefutationPanel)?;
            ensure_quorum(state, ability)?;
            if !ability.blocking_divergences.is_empty() {
                return Err(DomainError::InsufficientQuorum);
            }
            one(E::CandidateAccepted { key: key.clone() })
        }
        C::MarkNeedsSchema { key, evidence_hash } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            if !matches!(
                ability.phase,
                AbilityPhase::Architected
                    | AbilityPhase::Decomposed
                    | AbilityPhase::ShapeRequired
                    | AbilityPhase::ShapeSurveyed
                    | AbilityPhase::RevisionRequested
            ) || ability.applied_commit.is_some()
            {
                return Err(DomainError::WrongState);
            }
            one(E::AbilityMarkedNeedsSchema {
                key: key.clone(),
                evidence_hash: *evidence_hash,
            })
        }
        C::AbandonAbility { key, reason_hash } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            if ability.phase.terminal()
                || ability.apply_plan_hash.is_some()
                || ability.applied_commit.is_some()
                || ability.rollback_evidence_hash.is_some()
            {
                return Err(DomainError::WrongState);
            }
            one(E::AbilityAbandoned {
                key: key.clone(),
                reason_hash: *reason_hash,
            })
        }
        C::RequestApply {
            key,
            expected_head,
            plan_hash,
        } => {
            require_ability(state, key, AbilityPhase::CandidateAccepted)?;
            let expected_chain_head = state
                .repository_head
                .as_ref()
                .ok_or(DomainError::CandidateCommitMismatch)?;
            if expected_head != expected_chain_head {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::ApplyRequested {
                key: key.clone(),
                expected_head: expected_head.clone(),
                plan_hash: *plan_hash,
            })
        }
        C::RecordAppliedPatch {
            key,
            candidate_hash,
            applied_hash,
            commit_id,
            changed_paths,
            no_op,
        } => {
            let ability = require_ability(state, key, AbilityPhase::ApplyRequested)?;
            if *no_op || changed_paths.is_empty() || candidate_hash == applied_hash {
                return Err(DomainError::NoOpApplication);
            }
            if ability.candidate_hash != Some(*candidate_hash) {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::PatchApplied {
                key: key.clone(),
                candidate_hash: *candidate_hash,
                applied_hash: *applied_hash,
                commit_id: commit_id.clone(),
                changed_paths: changed_paths.clone(),
            })
        }
        C::RecordMechanicalVerificationFailure {
            key,
            evidence_hash,
            commit_id,
        } => {
            let ability = require_ability(state, key, AbilityPhase::Applied)?;
            if ability.applied_commit.as_deref() != Some(commit_id)
                || state.repository_head.as_deref() != Some(commit_id)
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::MechanicalVerificationFailed {
                key: key.clone(),
                evidence_hash: *evidence_hash,
                commit_id: commit_id.clone(),
            })
        }
        C::RequestAbilityRollback {
            key,
            evidence_hash,
            restore_head,
            terminal,
        } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            let failure_phase = ability.phase == AbilityPhase::VerificationFailed;
            let terminal_phase = matches!(
                ability.phase,
                AbilityPhase::MechanicallyVerified | AbilityPhase::RevisionRequested
            );
            if (!failure_phase && !terminal_phase)
                || (terminal_phase && !terminal)
                || ability.applied_commit.as_ref() != state.repository_head.as_ref()
                || restore_head == ability.applied_commit.as_deref().unwrap_or_default()
            {
                return Err(DomainError::WrongState);
            }
            one(E::AbilityRollbackRequested {
                key: key.clone(),
                evidence_hash: *evidence_hash,
                restore_head: restore_head.clone(),
                terminal: *terminal,
            })
        }
        C::RecordAbilityRollback {
            key,
            evidence_hash,
            restored_head,
        } => {
            let ability = state
                .abilities
                .get(key)
                .ok_or(DomainError::OutOfManifestMember)?;
            if ability.phase != AbilityPhase::RollbackRequested
                || ability.rollback_evidence_hash != Some(*evidence_hash)
                || ability.rollback_head.as_ref() != Some(restored_head)
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::AbilityRolledBack {
                key: key.clone(),
                evidence_hash: *evidence_hash,
                restored_head: restored_head.clone(),
            })
        }
        C::RecordMechanicalVerification { key, facts } => {
            let ability = require_ability(state, key, AbilityPhase::Applied)?;
            if ability.candidate_hash != Some(facts.candidate_hash)
                || ability.applied_hash != Some(facts.applied_hash)
                || ability.applied_commit.as_deref() != Some(facts.commit_id.as_str())
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            if facts.lever_regression {
                return Err(DomainError::LeverRegression);
            }
            if !facts.all_fixed_gates_passed || facts.parity_pairs_passed != 6 {
                return Err(DomainError::CloseInvariant("verification"));
            }
            if facts.gate_run == 0
                || facts.gate_run
                    > state
                        .manifest
                        .as_ref()
                        .unwrap()
                        .budgets
                        .max_full_gate_reruns
            {
                return Err(DomainError::GateBudgetExhausted);
            }
            if facts.score_final < ability.score_start
                && facts.correctness_justification_hash.is_none()
            {
                return Err(DomainError::FactionMeanRegression);
            }
            one(E::MechanicalVerificationRecorded {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::RecordReviewerResult {
            key,
            role,
            verification_hash,
            artifact_hash,
        } => {
            let ability = require_ability(state, key, AbilityPhase::MechanicallyVerified)?;
            if ability.verification_hash != Some(*verification_hash) {
                return Err(DomainError::StaleParentArtifact);
            }
            if !matches!(role.as_str(), "psyker" | "inquisitor")
                || ability.reviewer_hashes.contains_key(role)
            {
                return Err(DomainError::Duplicate);
            }
            one(E::ReviewerResultRecorded {
                key: key.clone(),
                role: role.clone(),
                verification_hash: *verification_hash,
                artifact_hash: *artifact_hash,
            })
        }
        C::RequestReviewRevision {
            key,
            verification_hash,
            thread_hash,
            finding_ids,
        } => {
            let ability = require_ability(state, key, AbilityPhase::MechanicallyVerified)?;
            if ability.verification_hash != Some(*verification_hash)
                || ability.reviewer_hashes.len() != 2
                || finding_ids.is_empty()
            {
                return Err(DomainError::IncompleteRevisionThread);
            }
            if ability.attempt
                >= state
                    .manifest
                    .as_ref()
                    .unwrap()
                    .budgets
                    .max_assembly_attempts
            {
                return Err(DomainError::AttemptBudgetExhausted);
            }
            one(E::ReviewRevisionRequested {
                key: key.clone(),
                verification_hash: *verification_hash,
                thread_hash: *thread_hash,
                finding_ids: finding_ids.clone(),
            })
        }
        C::RecordReview { key, facts } => {
            let ability = require_ability(state, key, AbilityPhase::MechanicallyVerified)?;
            if ability.reviewer_hashes.len() != 2
                || !["psyker", "inquisitor"]
                    .iter()
                    .all(|role| ability.reviewer_hashes.contains_key(*role))
            {
                return Err(DomainError::InsufficientQuorum);
            }
            if ability.candidate_hash != Some(facts.candidate_hash)
                || ability.verification_hash != Some(facts.verification_hash)
            {
                return Err(DomainError::StaleParentArtifact);
            }
            if !facts.accepted || facts.severity3_count != 0 || !facts.ten_anti_conditions_passed {
                return Err(DomainError::InsufficientQuorum);
            }
            one(E::ReviewRecorded {
                key: key.clone(),
                facts: facts.clone(),
            })
        }
        C::ConvergeAbility { key } => {
            let ability = require_ability(state, key, AbilityPhase::Reviewed)?;
            if ability.review_hash.is_none() {
                return Err(DomainError::WrongState);
            }
            one(E::AbilityConverged { key: key.clone() })
        }
        C::ProposeShape {
            shape_id,
            package_hash,
        } => {
            guard::running(state)?;
            if state.shapes.contains_key(shape_id) {
                return Err(DomainError::Duplicate);
            }
            one(E::ShapeProposed {
                originating_ability: None,
                shape_id: shape_id.clone(),
                package_hash: *package_hash,
            })
        }
        C::RecordFamilySurvey {
            shape_id,
            survey_hash,
            internal_family_size,
            members,
            flattening_exclusions,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if !matches!(
                shape.phase,
                ShapePhase::Proposed | ShapePhase::FamilySurveyed
            ) {
                return Err(DomainError::WrongState);
            }
            let manifest_keys = state
                .manifest
                .as_ref()
                .unwrap()
                .ordered_worklist
                .iter()
                .map(|item| &item.key)
                .collect::<std::collections::BTreeSet<_>>();
            if members.iter().any(|member| !manifest_keys.contains(member)) {
                return Err(DomainError::OutOfManifestMember);
            }
            let external_family_size = members.difference(flattening_exclusions).count();
            if external_family_size.max(usize::from(*internal_family_size))
                < usize::from(state.manifest.as_ref().unwrap().budgets.family_threshold)
            {
                return Err(DomainError::FamilyThresholdNotMet);
            }
            if !shape.family_hashes.is_empty()
                && (shape.internal_family_size != *internal_family_size
                    || !same_family_roster(
                        &shape.family_members,
                        &shape.excluded_members,
                        members,
                        flattening_exclusions,
                    ))
            {
                return Err(DomainError::ImplementationMatrixIncomplete);
            }
            one(E::ShapeFamilySurveyed {
                shape_id: shape_id.clone(),
                internal_family_size: *internal_family_size,
                survey_hash: *survey_hash,
                members: members.clone(),
                flattening_exclusions: flattening_exclusions.clone(),
            })
        }
        C::RecordDescriberSpec {
            shape_id,
            artifact_hash,
            render_form_count,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if !matches!(
                shape.phase,
                ShapePhase::FamilySurveyed | ShapePhase::RevisionRequested
            ) || shape.family_hashes.len() < 2
                || *render_form_count == 0
            {
                return Err(DomainError::ImplementationMatrixIncomplete);
            }
            one(E::ShapeDescriberSpecified {
                shape_id: shape_id.clone(),
                artifact_hash: *artifact_hash,
            })
        }
        C::RecordShapeReview {
            shape_id,
            artifact_hash,
            accepted,
            resolved_findings,
            refuter_count,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if !matches!(
                shape.phase,
                ShapePhase::DescriberSpecified | ShapePhase::RevisionRequested
            ) || *refuter_count < 2
                || (*accepted && !resolved_findings)
            {
                return Err(DomainError::InsufficientQuorum);
            }
            if shape.review_round
                >= state
                    .manifest
                    .as_ref()
                    .unwrap()
                    .budgets
                    .max_shape_review_rounds
            {
                return Err(DomainError::AttemptBudgetExhausted);
            }
            one(E::ShapeReviewRecorded {
                shape_id: shape_id.clone(),
                artifact_hash: *artifact_hash,
                accepted: *accepted,
            })
        }
        C::ApproveShape {
            shape_id,
            implementation_matrix_complete,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if shape.phase != ShapePhase::UnderReview || !implementation_matrix_complete {
                return Err(DomainError::ImplementationMatrixIncomplete);
            }
            one(E::ShapeApproved {
                shape_id: shape_id.clone(),
            })
        }
        C::RequestShapeApply {
            shape_id,
            expected_head,
            plan_hash,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if shape.phase != ShapePhase::Approved {
                return Err(DomainError::WrongState);
            }
            let chain_head = state
                .repository_head
                .as_ref()
                .ok_or(DomainError::CandidateCommitMismatch)?;
            if expected_head != chain_head {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::ShapeApplyRequested {
                shape_id: shape_id.clone(),
                expected_head: expected_head.clone(),
                plan_hash: *plan_hash,
            })
        }
        C::RecordShapeApplied {
            shape_id,
            package_hash,
            applied_hash,
            commit_id,
            changed_paths,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if shape.phase != ShapePhase::ApplyRequested
                || shape.package_hash != Some(*package_hash)
                || changed_paths.is_empty()
                || package_hash == applied_hash
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::ShapeApplied {
                shape_id: shape_id.clone(),
                package_hash: *package_hash,
                applied_hash: *applied_hash,
                commit_id: commit_id.clone(),
                changed_paths: changed_paths.clone(),
            })
        }
        C::RecordShapeVerification {
            shape_id,
            artifact_hash,
            applied_hash,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if shape.phase != ShapePhase::Applied || shape.applied_hash != Some(*applied_hash) {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::ShapeVerificationRecorded {
                shape_id: shape_id.clone(),
                artifact_hash: *artifact_hash,
                applied_hash: *applied_hash,
            })
        }
        C::RecordShapeRollback {
            shape_id,
            artifact_hash,
            applied_hash,
            restored_head,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if shape.phase != ShapePhase::Applied
                || shape.applied_hash != Some(*applied_hash)
                || shape.applied_commit.as_ref() != state.repository_head.as_ref()
                || shape.applied_commit.as_deref() == Some(restored_head)
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::ShapeRolledBack {
                shape_id: shape_id.clone(),
                artifact_hash: *artifact_hash,
                applied_hash: *applied_hash,
                restored_head: restored_head.clone(),
            })
        }
        C::RejectShape {
            shape_id,
            singleton,
        } => {
            let shape = state.shapes.get(shape_id).ok_or(DomainError::WrongState)?;
            if !matches!(
                shape.phase,
                ShapePhase::Proposed
                    | ShapePhase::FamilySurveyed
                    | ShapePhase::DescriberSpecified
                    | ShapePhase::UnderReview
                    | ShapePhase::RevisionRequested
            ) {
                return Err(DomainError::WrongState);
            }
            one(E::ShapeRejected {
                shape_id: shape_id.clone(),
                singleton: *singleton,
            })
        }
        C::RequestSeal => {
            if state.phase != CampaignPhase::Running || !state.all_work_terminal() {
                return Err(DomainError::CloseInvariant("terminal-ledger"));
            }
            one(E::SealRequested)
        }
        C::RecordSealedHead { base, head } => {
            if state.phase != CampaignPhase::Sealing
                || base != &state.manifest.as_ref().unwrap().base_commit_id
                || base == head
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::CampaignSealed {
                base: base.clone(),
                head: head.clone(),
            })
        }
        C::RecordCloseVerification { facts } => {
            if state.phase != CampaignPhase::Sealed
                || state.sealed_head.as_deref() != Some(facts.sealed_head.as_str())
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            if !facts.terminal_ledger_complete
                || !facts.fixed_gates_passed
                || facts.parity_pairs_passed != 6
                || !facts.whole_corpus_drift_clean
                || !facts.target_means_non_regressing
                || facts.anti_conditions_passed != 10
                || !facts.conflict_free
            {
                return Err(DomainError::CloseInvariant("close-review"));
            }
            one(E::CloseVerificationRecorded {
                facts: facts.clone(),
            })
        }
        C::RecordCloseFailure {
            artifact_hash,
            sealed_head,
            terminal,
        } => {
            if state.phase != CampaignPhase::Sealed
                || state.sealed_head.as_ref() != Some(sealed_head)
            {
                return Err(DomainError::CandidateCommitMismatch);
            }
            one(E::CloseVerificationFailed {
                artifact_hash: *artifact_hash,
                sealed_head: sealed_head.clone(),
                terminal: *terminal,
            })
        }
        C::AuthorizePublication { sealed_head } => {
            if state.phase != CampaignPhase::CloseVerified
                || state.sealed_head.as_ref() != Some(sealed_head)
            {
                return Err(DomainError::PublicationNotAuthorized);
            }
            one(E::PublicationAuthorized {
                sealed_head: sealed_head.clone(),
            })
        }
        C::RequestPublication { sealed_head } => {
            if state.phase != CampaignPhase::PublishAuthorized
                || state.publication_authorized_head.as_ref() != Some(sealed_head)
            {
                return Err(DomainError::PublicationNotAuthorized);
            }
            one(E::PublicationRequested {
                sealed_head: sealed_head.clone(),
            })
        }
        C::RecordPublicationProgress {
            sealed_head,
            effect_hash,
        } => {
            if state.phase != CampaignPhase::Publishing
                || state.publication_authorized_head.as_ref() != Some(sealed_head)
            {
                return Err(DomainError::PublicationNotAuthorized);
            }
            one(E::PublicationProgressRecorded {
                sealed_head: sealed_head.clone(),
                effect_hash: *effect_hash,
            })
        }
        C::RecordPublication {
            sealed_head,
            effect_hash,
            checks_green,
        } => {
            if state.phase != CampaignPhase::Publishing
                || state.publication_authorized_head.as_ref() != Some(sealed_head)
                || !checks_green
            {
                return Err(DomainError::PublicationNotAuthorized);
            }
            one(E::CampaignPublished {
                sealed_head: sealed_head.clone(),
                effect_hash: *effect_hash,
            })
        }
        C::AbortCampaign { reason_hash } => {
            if matches!(
                state.phase,
                CampaignPhase::Empty | CampaignPhase::Published | CampaignPhase::Aborted
            ) {
                return Err(DomainError::WrongState);
            }
            Ok(vec![
                E::CampaignAbortRequested {
                    reason_hash: *reason_hash,
                },
                E::CampaignAborted,
            ])
        }
    }
}

fn require_ability<'a>(
    state: &'a CampaignState,
    key: &crate::AbilityKey,
    phase: AbilityPhase,
) -> Result<&'a crate::AbilityAggregate, DomainError> {
    guard::running(state)?;
    guard::manifest_member(state, key)?;
    let ability = state
        .abilities
        .get(key)
        .ok_or(DomainError::OutOfManifestMember)?;
    if ability.phase != phase {
        return Err(DomainError::WrongState);
    }
    Ok(ability)
}

fn ensure_quorum(
    state: &CampaignState,
    ability: &crate::AbilityAggregate,
) -> Result<(), DomainError> {
    let budgets = &state.manifest.as_ref().expect("running campaign").budgets;
    let required = if ability.escalated {
        budgets.escalated_refuters
    } else {
        budgets.routine_refuters
    };
    if ability.voters.len() == usize::from(required) {
        Ok(())
    } else {
        Err(DomainError::InsufficientQuorum)
    }
}

fn same_family_roster(
    prior_members: &BTreeSet<crate::AbilityKey>,
    prior_exclusions: &BTreeSet<crate::AbilityKey>,
    members: &BTreeSet<crate::AbilityKey>,
    exclusions: &BTreeSet<crate::AbilityKey>,
) -> bool {
    prior_members
        .union(prior_exclusions)
        .all(|key| members.contains(key) || exclusions.contains(key))
        && members
            .union(exclusions)
            .all(|key| prior_members.contains(key) || prior_exclusions.contains(key))
}
