use std::collections::{BTreeMap, BTreeSet};

use campaign_domain::{
    AbilityId, AbilityKey, AbilityPhase, ActorId, Budgets, CampaignId, CampaignManifest,
    CampaignPhase, CampaignState, CandidateFacts, Command, CommandAction, CommandId, CommandMeta,
    DomainError, DomainEvent, EventPayload, EvidenceFacts, Hash256, IdentitySet, RefutationFacts,
    ShapeId, ShapePhase, WorkItem, decide, evolve, replay,
};

fn hash(label: &str) -> Hash256 {
    Hash256::digest(label)
}

fn key() -> AbilityKey {
    AbilityKey::new(
        campaign_domain::FactionId::new("test-faction").unwrap(),
        AbilityId::new("test-ability").unwrap(),
    )
}

fn manifest() -> CampaignManifest {
    CampaignManifest {
        campaign_id: CampaignId::new("test-campaign").unwrap(),
        repository_canonical_path_hash: hash("repository"),
        workspace_id: "test-workspace".into(),
        base_commit_id: "base-commit".into(),
        ordered_worklist: vec![WorkItem {
            key: key(),
            cosine_start: 0.5,
            source_hash: hash("source"),
            baseline_dsl_hash: hash("baseline"),
        }],
        baseline_report_hash: hash("report"),
        baseline_rows_hash: hash("rows"),
        identities: IdentitySet {
            provider_precedence: vec!["app-server".into()],
            allowed_transports: BTreeSet::from(["app-server".into()]),
            model: "test-model".into(),
            reasoning: "test-reasoning".into(),
            rig_version: "test-rig".into(),
            rig_lockfile_hash: hash("rig-lock"),
            app_server_binary_hash: hash("server-bin"),
            app_server_version: "test-server".into(),
            app_server_protocol_hash: hash("server-protocol"),
            direct_provider_hash: None,
            prompt_manifest_hash: hash("prompts"),
            role_schema_hashes: (0..16)
                .map(|index| hash(&format!("role-{index}")))
                .collect(),
            semantic_validator_hash: hash("validator"),
            tool_contract_hash: hash("tools"),
            engine_version: "test-engine".into(),
            protocol_version: 1,
            executable_hash: hash("engine"),
        },
        budgets: Budgets::default(),
        gate_definitions_hash: hash("gates"),
        path_policy_hash: hash("paths"),
        privacy_policy_hash: hash("privacy"),
        parity_areas: BTreeSet::from(["test-area".into()]),
    }
}

fn command(state: &CampaignState, action: CommandAction) -> Command {
    let campaign_id = state
        .campaign_id
        .clone()
        .unwrap_or_else(|| CampaignId::new("test-campaign").unwrap());
    let expected_engine_hash = state
        .manifest
        .as_ref()
        .map(|manifest| manifest.identities.executable_hash)
        .unwrap_or(Hash256::ZERO);
    Command {
        meta: CommandMeta {
            command_id: CommandId::new(),
            campaign_id,
            expected_stream_version: state.stream_version,
            causation_id: CommandId::new(),
            correlation_id: CommandId::new(),
            actor: ActorId::new("test-actor").unwrap(),
            expected_manifest_hash: state.manifest_hash,
            expected_engine_hash,
            outbox_id: None,
            fencing_token: None,
            lease_resource: None,
            lease_owner: None,
        },
        action,
    }
}

fn dispatch(state: &mut CampaignState, action: CommandAction) -> Vec<campaign_domain::DomainEvent> {
    let events = decide(state, &command(state, action)).unwrap();
    for event in &events {
        evolve(state, event).unwrap();
    }
    events
}

fn running_state() -> CampaignState {
    let mut state = CampaignState::default();
    dispatch(&mut state, CommandAction::CreateCampaign);
    dispatch(
        &mut state,
        CommandAction::FreezeManifest {
            manifest: manifest(),
        },
    );
    dispatch(&mut state, CommandAction::StartCampaign);
    state
}

fn candidate_panel(state: &mut CampaignState) {
    let ability = key();
    let clauses = BTreeSet::from(["clause-a".into()]);
    dispatch(
        &mut *state,
        CommandAction::QueueAbility {
            key: ability.clone(),
        },
    );
    dispatch(
        state,
        CommandAction::BindEvidence {
            key: ability.clone(),
            facts: EvidenceFacts {
                artifact_hash: hash("evidence"),
                source_hash: hash("source"),
                all_clause_ids: clauses.clone(),
                mechanical_clause_ids: clauses,
                contiguous_partition: true,
            },
        },
    );
    let evidence_hash = state.abilities[&ability].evidence_hash.unwrap();
    dispatch(
        state,
        CommandAction::RecordArchitecture {
            key: ability.clone(),
            facts: campaign_domain::ArchitectureFacts {
                artifact_hash: hash("architecture"),
                evidence_hash,
                covered_clause_ids: BTreeSet::from(["clause-a".into()]),
                requires_shape: false,
                closed_parent: true,
                unresolved_bindings: BTreeSet::new(),
            },
        },
    );
    let architecture_hash = state.abilities[&ability].architecture_hash.unwrap();
    for role in ["target-dummy", "chronomancer", "vox-hound"] {
        dispatch(
            state,
            CommandAction::RecordDecomposerResult {
                key: ability.clone(),
                role: role.into(),
                architecture_hash,
                artifact_hash: hash(role),
            },
        );
    }
    dispatch(
        state,
        CommandAction::RecordDecomposition {
            key: ability.clone(),
            facts: campaign_domain::DecompositionFacts {
                artifact_hash: hash("decomposition"),
                architecture_hash,
                covered_clause_ids: BTreeSet::from(["clause-a".into()]),
                who_complete: true,
                when_complete: true,
                what_complete: true,
                deferred_lookups: BTreeSet::new(),
            },
        },
    );
    let decomposition_hash = state.abilities[&ability].decomposition_hash.unwrap();
    dispatch(
        state,
        CommandAction::ProposeCandidate {
            key: ability.clone(),
            facts: CandidateFacts {
                artifact_hash: hash("candidate"),
                decomposition_hash,
                attempt: 1,
                exactly_mapped_clauses: BTreeSet::from(["clause-a".into()]),
                source_or_schema_evidence_clauses: BTreeSet::from(["clause-a".into()]),
                placeholder_encoding: false,
                approx_mechanical_clause: false,
                revision_thread_hash: None,
                prior_divergence_ids: BTreeSet::new(),
            },
        },
    );
    dispatch(
        state,
        CommandAction::OpenRefutationPanel {
            key: ability,
            escalated: false,
        },
    );
}

#[test]
fn replay_is_deterministic_and_rejects_non_contiguous_events() {
    let mut state = CampaignState::default();
    let mut events = dispatch(&mut state, CommandAction::CreateCampaign);
    events.extend(dispatch(
        &mut state,
        CommandAction::FreezeManifest {
            manifest: manifest(),
        },
    ));
    events.extend(dispatch(&mut state, CommandAction::StartCampaign));
    events.extend(dispatch(
        &mut state,
        CommandAction::QueueAbility { key: key() },
    ));

    let replayed = replay(&events).unwrap();
    assert_eq!(replayed, state);
    assert_eq!(replayed.state_hash(), state.state_hash());

    let mut invalid = CampaignState::default();
    let mut skipped = events[0].clone();
    skipped.stream_version = 2;
    assert_eq!(
        evolve(&mut invalid, &skipped),
        Err(DomainError::VersionConflict)
    );
}

#[test]
fn frozen_manifest_and_engine_identity_are_required() {
    let state = running_state();
    let mut wrong_manifest = command(&state, CommandAction::QueueAbility { key: key() });
    wrong_manifest.meta.expected_manifest_hash = Some(hash("other-manifest"));
    assert_eq!(
        decide(&state, &wrong_manifest),
        Err(DomainError::ManifestMismatch)
    );

    let mut wrong_engine = command(&state, CommandAction::QueueAbility { key: key() });
    wrong_engine.meta.expected_engine_hash = hash("other-engine");
    assert_eq!(
        decide(&state, &wrong_engine),
        Err(DomainError::ManifestMismatch)
    );

    let mut stale = command(&state, CommandAction::QueueAbility { key: key() });
    stale.meta.expected_stream_version += 1;
    assert_eq!(decide(&state, &stale), Err(DomainError::VersionConflict));
}

#[test]
fn refutation_quorum_blocks_acceptance_and_unresolved_findings_require_revision() {
    let mut state = running_state();
    candidate_panel(&mut state);
    let ability = key();
    let candidate_hash = state.abilities[&ability].candidate_hash.unwrap();

    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::AcceptCandidate {
                    key: ability.clone()
                }
            )
        ),
        Err(DomainError::InsufficientQuorum)
    );
    dispatch(
        &mut state,
        CommandAction::RecordRefutation {
            key: ability.clone(),
            facts: RefutationFacts {
                artifact_hash: hash("refutation-one"),
                candidate_hash,
                voter: 1,
                voter_identity_hash: hash("voter-one"),
                divergence_ids: BTreeSet::from(["finding-a".into()]),
            },
        },
    );
    dispatch(
        &mut state,
        CommandAction::RecordRefutation {
            key: ability.clone(),
            facts: RefutationFacts {
                artifact_hash: hash("refutation-two"),
                candidate_hash,
                voter: 2,
                voter_identity_hash: hash("voter-two"),
                divergence_ids: BTreeSet::new(),
            },
        },
    );
    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::AcceptCandidate {
                    key: ability.clone()
                }
            )
        ),
        Err(DomainError::InsufficientQuorum)
    );
    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::RequestRevision {
                    key: ability.clone(),
                    thread_hash: hash("thread"),
                    resolved_divergence_ids: BTreeSet::new(),
                }
            )
        ),
        Err(DomainError::IncompleteRevisionThread)
    );
    dispatch(
        &mut state,
        CommandAction::RequestRevision {
            key: ability,
            thread_hash: hash("thread"),
            resolved_divergence_ids: BTreeSet::from(["finding-a".into()]),
        },
    );
}

#[test]
fn first_shape_requirement_backfills_legacy_origin_provenance() {
    let mut state = running_state();
    let ability = key();
    let shape_id = ShapeId::new("shape-legacy-origin").unwrap();
    dispatch(
        &mut state,
        CommandAction::QueueAbility {
            key: ability.clone(),
        },
    );
    dispatch(
        &mut state,
        CommandAction::ProposeShape {
            shape_id: shape_id.clone(),
            package_hash: hash("shape-package"),
        },
    );
    assert!(state.shapes[&shape_id].originating_ability.is_none());
    let next_stream_version = state.stream_version + 1;

    evolve(
        &mut state,
        &DomainEvent {
            command_id: CommandId::new(),
            stream_version: next_stream_version,
            payload: EventPayload::ShapeRequired {
                key: ability.clone(),
                shape_id: shape_id.clone(),
            },
        },
    )
    .unwrap();

    assert_eq!(
        state.shapes[&shape_id].originating_ability.as_ref(),
        Some(&ability)
    );
}

#[test]
fn closed_internal_family_can_justify_shape_lifecycle() {
    let mut state = running_state();
    let shape_id = ShapeId::new("shape-internal-family").unwrap();
    dispatch(
        &mut state,
        CommandAction::ProposeShape {
            shape_id: shape_id.clone(),
            package_hash: hash("shape-package"),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RecordFamilySurvey {
            shape_id: shape_id.clone(),
            survey_hash: hash("survey-one"),
            internal_family_size: 4,
            members: BTreeSet::new(),
            flattening_exclusions: BTreeSet::new(),
        },
    );

    assert_eq!(state.shapes[&shape_id].phase, ShapePhase::FamilySurveyed);
    assert_eq!(state.shapes[&shape_id].internal_family_size, 4);

    dispatch(
        &mut state,
        CommandAction::RecordFamilySurvey {
            shape_id: shape_id.clone(),
            survey_hash: hash("survey-two"),
            internal_family_size: 4,
            members: BTreeSet::new(),
            flattening_exclusions: BTreeSet::new(),
        },
    );
    assert_eq!(state.shapes[&shape_id].family_hashes.len(), 2);
}

#[test]
fn exhausted_shape_review_budget_terminates_as_not_converged() {
    let mut state = running_state();
    let shape_id = ShapeId::new("shape-review-exhausted").unwrap();
    dispatch(
        &mut state,
        CommandAction::ProposeShape {
            shape_id: shape_id.clone(),
            package_hash: hash("shape-package"),
        },
    );
    let max_review_rounds = state
        .manifest
        .as_ref()
        .unwrap()
        .budgets
        .max_shape_review_rounds;
    let shape = state.shapes.get_mut(&shape_id).unwrap();
    shape.phase = ShapePhase::RevisionRequested;
    shape.review_round = max_review_rounds;
    let artifact_hash = hash("terminal-review");

    dispatch(
        &mut state,
        CommandAction::MarkShapeNotConverged {
            shape_id: shape_id.clone(),
            artifact_hash,
        },
    );

    assert_eq!(state.shapes[&shape_id].phase, ShapePhase::NotConverged);
    assert_eq!(
        state.shapes[&shape_id].verification_hash,
        Some(artifact_hash)
    );
}

#[test]
fn shape_surveys_cannot_change_the_internal_family() {
    let mut state = running_state();
    let shape_id = ShapeId::new("shape-internal-family").unwrap();
    dispatch(
        &mut state,
        CommandAction::ProposeShape {
            shape_id: shape_id.clone(),
            package_hash: hash("shape-package"),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RecordFamilySurvey {
            shape_id: shape_id.clone(),
            survey_hash: hash("survey-one"),
            internal_family_size: 4,
            members: BTreeSet::new(),
            flattening_exclusions: BTreeSet::new(),
        },
    );

    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::RecordFamilySurvey {
                    shape_id,
                    survey_hash: hash("survey-two"),
                    internal_family_size: 5,
                    members: BTreeSet::new(),
                    flattening_exclusions: BTreeSet::new(),
                },
            ),
        ),
        Err(DomainError::ImplementationMatrixIncomplete)
    );
}

#[test]
fn adjudicator_can_reclassify_the_scouted_family_without_changing_its_roster() {
    let mut state = running_state();
    let shape_id = ShapeId::new("shape-refined-family").unwrap();
    dispatch(
        &mut state,
        CommandAction::ProposeShape {
            shape_id: shape_id.clone(),
            package_hash: hash("shape-package"),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RecordFamilySurvey {
            shape_id: shape_id.clone(),
            survey_hash: hash("scout-survey"),
            internal_family_size: 4,
            members: BTreeSet::from([key()]),
            flattening_exclusions: BTreeSet::new(),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RecordFamilySurvey {
            shape_id: shape_id.clone(),
            survey_hash: hash("adjudicator-survey"),
            internal_family_size: 4,
            members: BTreeSet::new(),
            flattening_exclusions: BTreeSet::from([key()]),
        },
    );

    let shape = &state.shapes[&shape_id];
    assert_eq!(shape.family_hashes.len(), 2);
    assert!(shape.family_members.is_empty());
    assert_eq!(shape.excluded_members, BTreeSet::from([key()]));
}

#[test]
fn adjudicator_cannot_change_the_scouted_candidate_roster() {
    let mut state = running_state();
    let shape_id = ShapeId::new("shape-invented-family").unwrap();
    dispatch(
        &mut state,
        CommandAction::ProposeShape {
            shape_id: shape_id.clone(),
            package_hash: hash("shape-package"),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RecordFamilySurvey {
            shape_id: shape_id.clone(),
            survey_hash: hash("scout-survey"),
            internal_family_size: 4,
            members: BTreeSet::new(),
            flattening_exclusions: BTreeSet::new(),
        },
    );

    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::RecordFamilySurvey {
                    shape_id,
                    survey_hash: hash("adjudicator-survey"),
                    internal_family_size: 4,
                    members: BTreeSet::from([key()]),
                    flattening_exclusions: BTreeSet::new(),
                },
            ),
        ),
        Err(DomainError::ImplementationMatrixIncomplete)
    );
}

#[test]
fn applied_patch_must_match_the_accepted_candidate() {
    let mut state = running_state();
    candidate_panel(&mut state);
    let ability = key();
    let candidate_hash = state.abilities[&ability].candidate_hash.unwrap();
    for voter in 1..=2 {
        dispatch(
            &mut state,
            CommandAction::RecordRefutation {
                key: ability.clone(),
                facts: RefutationFacts {
                    artifact_hash: hash(&format!("clear-refutation-{voter}")),
                    candidate_hash,
                    voter,
                    voter_identity_hash: hash(&format!("clear-voter-{voter}")),
                    divergence_ids: BTreeSet::new(),
                },
            },
        );
    }
    dispatch(
        &mut state,
        CommandAction::AcceptCandidate {
            key: ability.clone(),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RequestApply {
            key: ability.clone(),
            expected_head: "base-commit".into(),
            plan_hash: hash("apply-plan"),
        },
    );
    let mut mismatched = command(
        &state,
        CommandAction::RecordAppliedPatch {
            key: ability,
            candidate_hash: hash("different-candidate"),
            applied_hash: hash("applied"),
            commit_id: "applied-commit".into(),
            changed_paths: BTreeMap::from([("test-path".into(), hash("path"))]),
            no_op: false,
        },
    );
    mismatched.meta.outbox_id = Some(CommandId::new());
    mismatched.meta.fencing_token = Some(1);
    assert_eq!(
        decide(&state, &mismatched),
        Err(DomainError::CandidateCommitMismatch)
    );
}

#[test]
fn sealing_and_publication_require_terminal_work_and_authorization() {
    let mut state = running_state();
    assert_eq!(
        decide(&state, &command(&state, CommandAction::RequestSeal)),
        Err(DomainError::CloseInvariant("terminal-ledger"))
    );
    dispatch(&mut state, CommandAction::QueueAbility { key: key() });
    dispatch(
        &mut state,
        CommandAction::AbandonAbility {
            key: key(),
            reason_hash: hash("reason"),
        },
    );
    dispatch(&mut state, CommandAction::RequestSeal);
    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::RecordSealedHead {
                    base: "wrong-base".into(),
                    head: "sealed-head".into(),
                }
            )
        ),
        Err(DomainError::CandidateCommitMismatch)
    );
    dispatch(
        &mut state,
        CommandAction::RecordSealedHead {
            base: "base-commit".into(),
            head: "sealed-head".into(),
        },
    );
    let invalid_close = campaign_domain::CloseFacts {
        artifact_hash: hash("invalid-close"),
        sealed_head: "sealed-head".into(),
        terminal_ledger_complete: true,
        fixed_gates_passed: true,
        parity_pairs_passed: 5,
        whole_corpus_drift_clean: true,
        target_means_non_regressing: true,
        anti_conditions_passed: 10,
        conflict_free: true,
    };
    let mut invalid_close_command = command(
        &state,
        CommandAction::RecordCloseVerification {
            facts: invalid_close,
        },
    );
    invalid_close_command.meta.outbox_id = Some(CommandId::new());
    invalid_close_command.meta.fencing_token = Some(1);
    assert_eq!(
        decide(&state, &invalid_close_command),
        Err(DomainError::CloseInvariant("close-review"))
    );

    let valid_close = campaign_domain::CloseFacts {
        artifact_hash: hash("valid-close"),
        sealed_head: "sealed-head".into(),
        terminal_ledger_complete: true,
        fixed_gates_passed: true,
        parity_pairs_passed: 6,
        whole_corpus_drift_clean: true,
        target_means_non_regressing: true,
        anti_conditions_passed: 10,
        conflict_free: true,
    };
    let mut valid_close_command = command(
        &state,
        CommandAction::RecordCloseVerification { facts: valid_close },
    );
    valid_close_command.meta.outbox_id = Some(CommandId::new());
    valid_close_command.meta.fencing_token = Some(1);
    for event in decide(&state, &valid_close_command).unwrap() {
        evolve(&mut state, &event).unwrap();
    }
    assert_eq!(state.phase, CampaignPhase::CloseVerified);
    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::RequestPublication {
                    sealed_head: "sealed-head".into()
                }
            )
        ),
        Err(DomainError::PublicationNotAuthorized)
    );
    dispatch(
        &mut state,
        CommandAction::AuthorizePublication {
            sealed_head: "sealed-head".into(),
        },
    );
    dispatch(
        &mut state,
        CommandAction::RequestPublication {
            sealed_head: "sealed-head".into(),
        },
    );
    let mut failed_publication = command(
        &state,
        CommandAction::RecordPublication {
            sealed_head: "sealed-head".into(),
            effect_hash: hash("effect"),
            checks_green: false,
        },
    );
    failed_publication.meta.outbox_id = Some(CommandId::new());
    failed_publication.meta.fencing_token = Some(1);
    assert_eq!(
        decide(&state, &failed_publication),
        Err(DomainError::PublicationNotAuthorized)
    );
}

#[test]
fn applied_terminal_failure_requires_observed_rollback() {
    let mut state = running_state();
    candidate_panel(&mut state);
    let ability_key = key();
    let applied_commit = "applied-commit".to_owned();
    let restore_head = "baseline-head".to_owned();
    {
        let ability = state.abilities.get_mut(&ability_key).unwrap();
        ability.phase = AbilityPhase::MechanicallyVerified;
        ability.applied_commit = Some(applied_commit.clone());
        ability.apply_plan_hash = Some(hash("apply-plan"));
    }
    state.repository_head = Some(applied_commit);

    assert_eq!(
        decide(
            &state,
            &command(
                &state,
                CommandAction::MarkNeedsSchema {
                    key: ability_key.clone(),
                    evidence_hash: hash("failed-review"),
                },
            ),
        ),
        Err(DomainError::WrongState)
    );

    let evidence_hash = hash("failed-review");
    dispatch(
        &mut state,
        CommandAction::RequestAbilityRollback {
            key: ability_key.clone(),
            terminal: true,
            evidence_hash,
            restore_head: restore_head.clone(),
        },
    );
    assert_eq!(
        state.abilities[&ability_key].phase,
        AbilityPhase::RollbackRequested
    );

    let mut record = command(
        &state,
        CommandAction::RecordAbilityRollback {
            key: ability_key.clone(),
            evidence_hash,
            restored_head: restore_head.clone(),
        },
    );
    record.meta.outbox_id = Some(CommandId::new());
    record.meta.fencing_token = Some(1);
    for event in decide(&state, &record).unwrap() {
        evolve(&mut state, &event).unwrap();
    }
    assert_eq!(
        state.abilities[&ability_key].phase,
        AbilityPhase::NeedsSchema
    );
    assert_eq!(
        state.repository_head.as_deref(),
        Some(restore_head.as_str())
    );
}

#[test]
fn mechanical_failure_rolls_back_into_revision_until_budget_exhaustion() {
    let mut state = running_state();
    candidate_panel(&mut state);
    let ability_key = key();
    let applied_commit = "applied-commit".to_owned();
    let restore_head = "baseline-head".to_owned();
    {
        let ability = state.abilities.get_mut(&ability_key).unwrap();
        ability.phase = AbilityPhase::Applied;
        ability.applied_commit = Some(applied_commit.clone());
        ability.apply_plan_hash = Some(hash("apply-plan"));
    }
    state.repository_head = Some(applied_commit.clone());

    let evidence_hash = hash("gate-failure");
    let mut failure = command(
        &state,
        CommandAction::RecordMechanicalVerificationFailure {
            key: ability_key.clone(),
            evidence_hash,
            commit_id: applied_commit,
        },
    );
    failure.meta.outbox_id = Some(CommandId::new());
    failure.meta.fencing_token = Some(1);
    for event in decide(&state, &failure).unwrap() {
        evolve(&mut state, &event).unwrap();
    }
    assert_eq!(
        state.abilities[&ability_key].phase,
        AbilityPhase::VerificationFailed
    );

    dispatch(
        &mut state,
        CommandAction::RequestAbilityRollback {
            key: ability_key.clone(),
            evidence_hash,
            restore_head: restore_head.clone(),
            terminal: false,
        },
    );
    let mut record = command(
        &state,
        CommandAction::RecordAbilityRollback {
            key: ability_key.clone(),
            evidence_hash,
            restored_head: restore_head,
        },
    );
    record.meta.outbox_id = Some(CommandId::new());
    record.meta.fencing_token = Some(1);
    for event in decide(&state, &record).unwrap() {
        evolve(&mut state, &event).unwrap();
    }
    let ability = &state.abilities[&ability_key];
    assert_eq!(ability.phase, AbilityPhase::RevisionRequested);
    assert_eq!(ability.revision_thread_hash, Some(evidence_hash));
}
