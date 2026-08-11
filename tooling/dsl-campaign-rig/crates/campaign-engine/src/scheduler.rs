use campaign_domain::{
    AbilityKey, AbilityPhase, CampaignPhase, CampaignState, Hash256, ShapeId, ShapePhase,
};
use campaign_executors::Capability;
use campaign_roles::Role;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkKind {
    BindEvidence,
    Architecture,
    Decompose { role: Role },
    CombineDecomposition,
    ShapeRoute,
    ShapeSurvey,
    MarkNeedsSchema,
    Assemble,
    OpenRefutationPanel,
    Refute { voter: u8 },
    ResolveRefutations,
    PlanApply,
    Apply,
    RollbackAbility,
    RequestRepairRollback,
    ReviewRole { role: Role },
    CombineReview,
    Verify,
    Converge,
    ShapeFamilySurvey { survey: u8 },
    ShapeDescriberSpec,
    ShapeApprove,
    ShapePlanApply,
    ShapeReview,
    ShapeApply,
    ShapeVerify,
    RecordSeal,
    Seal,
    CloseVerify,
    Publish,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkNode {
    pub work_id: Hash256,
    pub ability: Option<AbilityKey>,
    pub shape_id: Option<ShapeId>,
    pub kind: WorkKind,
    pub roles: Vec<Role>,
    pub capabilities: Vec<Capability>,
}

pub fn ready_work(state: &CampaignState, read_only: bool) -> Vec<WorkNode> {
    ready_work_with_policy(state, read_only, !read_only)
}

pub fn ready_work_with_policy(
    state: &CampaignState,
    read_only: bool,
    allow_shape_application: bool,
) -> Vec<WorkNode> {
    if state.phase != CampaignPhase::Running {
        return campaign_work(state, read_only);
    }
    let manifest = match &state.manifest {
        Some(manifest) => manifest,
        None => return Vec::new(),
    };
    for item in &manifest.ordered_worklist {
        let Some(ability) = state.abilities.get(&item.key) else {
            continue;
        };
        let prioritized = match ability.phase {
            AbilityPhase::ApplyRequested if !read_only => Some((
                WorkKind::Apply,
                vec![],
                vec![Capability::ApplyExactPlan, Capability::ReadJj],
            )),
            AbilityPhase::CandidateAccepted if !read_only => Some((
                WorkKind::PlanApply,
                vec![],
                vec![Capability::ReadRepo, Capability::ReadJj],
            )),
            AbilityPhase::Applied => Some((
                WorkKind::Verify,
                vec![Role::Cogitator, Role::Skitarius],
                vec![
                    Capability::RunValidator,
                    Capability::RunParity,
                    Capability::RunScorer,
                    Capability::ReadJj,
                    Capability::ApplyExactPlan,
                ],
            )),
            AbilityPhase::VerificationFailed if !read_only => {
                Some((WorkKind::RequestRepairRollback, vec![], vec![]))
            }
            AbilityPhase::RollbackRequested if !read_only => Some((
                WorkKind::RollbackAbility,
                vec![],
                vec![Capability::ApplyExactPlan, Capability::ReadJj],
            )),
            AbilityPhase::MechanicallyVerified => {
                let next = [Role::Psyker, Role::Inquisitor]
                    .into_iter()
                    .find(|role| !ability.reviewer_hashes.contains_key(role.as_str()));
                match next {
                    Some(role) => Some((WorkKind::ReviewRole { role }, vec![role], vec![])),
                    None => Some((WorkKind::CombineReview, vec![], vec![])),
                }
            }
            AbilityPhase::Reviewed => Some((WorkKind::Converge, vec![], vec![])),
            _ => None,
        };
        if let Some((kind, roles, capabilities)) = prioritized {
            return vec![node(
                Some(item.key.clone()),
                None,
                kind,
                roles,
                capabilities,
            )];
        }
    }
    let mut nodes = Vec::new();
    for item in &manifest.ordered_worklist {
        let Some(ability) = state.abilities.get(&item.key) else {
            continue;
        };
        let (kind, roles, capabilities) = match ability.phase {
            AbilityPhase::Queued => (
                WorkKind::BindEvidence,
                vec![Role::DataEnginseer],
                vec![Capability::ReadRawStore, Capability::ReadRepo],
            ),
            AbilityPhase::EvidenceBound => (WorkKind::Architecture, vec![Role::Inquisitor], vec![]),
            AbilityPhase::Architected => {
                let next = [Role::TargetDummy, Role::Chronomancer, Role::VoxHound]
                    .into_iter()
                    .find(|role| !ability.decomposer_hashes.contains_key(role.as_str()));
                match next {
                    Some(role) => (WorkKind::Decompose { role }, vec![role], vec![]),
                    None => (WorkKind::CombineDecomposition, vec![], vec![]),
                }
            }
            AbilityPhase::Decomposed if ability.requires_shape => (
                WorkKind::ShapeRoute,
                vec![Role::KrootFleshShaper],
                vec![Capability::ReadRawStore],
            ),
            AbilityPhase::ShapeRequired => {
                let Some(shape) = ability
                    .required_shape_id
                    .as_ref()
                    .and_then(|shape_id| state.shapes.get(shape_id))
                else {
                    continue;
                };
                if shape.phase == ShapePhase::Verified {
                    (WorkKind::ShapeSurvey, vec![], vec![])
                } else if shape.phase.terminal() {
                    (WorkKind::MarkNeedsSchema, vec![], vec![])
                } else {
                    continue;
                }
            }
            AbilityPhase::Decomposed
            | AbilityPhase::ShapeSurveyed
            | AbilityPhase::RevisionRequested => {
                (WorkKind::Assemble, vec![Role::ArchMagos], vec![])
            }
            AbilityPhase::CandidateProposed => (WorkKind::OpenRefutationPanel, vec![], vec![]),
            AbilityPhase::RefutationPanel => {
                let required = crate::policy::required_refuters(manifest, ability);
                if let Some(voter) =
                    (1..=required).find(|voter| !ability.voters.contains_key(voter))
                {
                    (WorkKind::Refute { voter }, vec![Role::Eversor], vec![])
                } else {
                    (WorkKind::ResolveRefutations, vec![], vec![])
                }
            }
            AbilityPhase::CandidateAccepted if !read_only => (
                WorkKind::PlanApply,
                vec![Role::Warpsmith],
                vec![Capability::ReadJj],
            ),
            AbilityPhase::ApplyRequested if !read_only => {
                (WorkKind::Apply, vec![], vec![Capability::ApplyExactPlan])
            }
            AbilityPhase::Applied => (
                WorkKind::Verify,
                vec![Role::Skitarius, Role::Cogitator],
                vec![
                    Capability::RunValidator,
                    Capability::RunParity,
                    Capability::RunScorer,
                    Capability::ReadJj,
                    Capability::ApplyExactPlan,
                ],
            ),
            AbilityPhase::VerificationFailed if !read_only => {
                (WorkKind::RequestRepairRollback, vec![], vec![])
            }
            AbilityPhase::RollbackRequested if !read_only => (
                WorkKind::RollbackAbility,
                vec![],
                vec![Capability::ApplyExactPlan, Capability::ReadJj],
            ),
            AbilityPhase::MechanicallyVerified => continue,
            AbilityPhase::Reviewed => (WorkKind::Converge, vec![], vec![]),
            _ => continue,
        };
        nodes.push(node(
            Some(item.key.clone()),
            None,
            kind,
            roles,
            capabilities,
        ));
    }
    for (shape_id, shape) in &state.shapes {
        let (kind, roles, capabilities) = match shape.phase {
            ShapePhase::Proposed | ShapePhase::FamilySurveyed if shape.family_hashes.len() < 2 => (
                WorkKind::ShapeFamilySurvey {
                    survey: shape.family_hashes.len() as u8 + 1,
                },
                vec![Role::Swarmlord, Role::KrootLoneSpear],
                vec![Capability::ReadRawStore],
            ),
            ShapePhase::FamilySurveyed => (
                WorkKind::ShapeDescriberSpec,
                vec![Role::KrootTrailShaper, Role::Psyker],
                vec![],
            ),
            ShapePhase::DescriberSpecified => (
                WorkKind::ShapeReview,
                vec![Role::KrootWarShaper, Role::Eversor],
                vec![],
            ),
            ShapePhase::RevisionRequested => (
                WorkKind::ShapeDescriberSpec,
                vec![Role::KrootTrailShaper, Role::Psyker],
                vec![],
            ),
            ShapePhase::UnderReview => (WorkKind::ShapeApprove, vec![], vec![]),
            ShapePhase::Approved if !read_only && allow_shape_application => (
                WorkKind::ShapePlanApply,
                vec![Role::Warpsmith],
                vec![Capability::ReadJj],
            ),
            ShapePhase::ApplyRequested if allow_shape_application => (
                WorkKind::ShapeApply,
                vec![],
                vec![Capability::ApplyExactPlan, Capability::GenerateArtifacts],
            ),
            ShapePhase::Applied => (
                WorkKind::ShapeVerify,
                vec![Role::Skitarius, Role::Cogitator],
                vec![
                    Capability::RunValidator,
                    Capability::RunParity,
                    Capability::ReadJj,
                    Capability::ApplyExactPlan,
                ],
            ),
            _ => continue,
        };
        nodes.push(node(
            None,
            Some(shape_id.clone()),
            kind,
            roles,
            capabilities,
        ));
    }
    if nodes.is_empty() && state.all_work_terminal() {
        nodes.push(node(
            None,
            None,
            WorkKind::Seal,
            vec![],
            vec![Capability::ReadJj],
        ));
    }
    nodes
}

fn campaign_work(state: &CampaignState, read_only: bool) -> Vec<WorkNode> {
    match state.phase {
        CampaignPhase::Running if state.all_work_terminal() => {
            vec![node(None, None, WorkKind::Seal, vec![], vec![])]
        }
        CampaignPhase::Sealing => vec![node(
            None,
            None,
            WorkKind::RecordSeal,
            vec![],
            vec![Capability::ReadJj],
        )],
        CampaignPhase::Sealed => vec![node(
            None,
            None,
            WorkKind::CloseVerify,
            vec![Role::Inquisitor, Role::Skitarius],
            vec![
                Capability::RunValidator,
                Capability::RunParity,
                Capability::RunScorer,
                Capability::ReadJj,
                Capability::ApplyExactPlan,
            ],
        )],
        CampaignPhase::Publishing if !read_only => vec![node(
            None,
            None,
            WorkKind::Publish,
            vec![],
            vec![
                Capability::CreateBookmark,
                Capability::PushBookmark,
                Capability::CreateDraftPr,
            ],
        )],
        _ => Vec::new(),
    }
}

fn node(
    ability: Option<AbilityKey>,
    shape_id: Option<ShapeId>,
    kind: WorkKind,
    roles: Vec<Role>,
    capabilities: Vec<Capability>,
) -> WorkNode {
    let identity = serde_json::to_vec(&(ability.clone(), shape_id.clone(), &kind))
        .expect("work node serializes");
    WorkNode {
        work_id: Hash256::digest(identity),
        ability,
        shape_id,
        kind,
        roles,
        capabilities,
    }
}
