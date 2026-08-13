use campaign_domain::{
    CampaignPhase, CampaignState, ClusterExclusion, ConfidenceTier, Hash256, MechanicClusterId,
    MechanicTemplate, RegistryRevision, RejectedEquivalence, VerificationProvenance,
};
use campaign_store::{CampaignStore, RegistryPromotionReceipt};
use serde_json::Value;

use crate::{EngineError, compute_structural_signature, normalized_mechanic_dsl, parameterize_dsl};

#[derive(Clone, Debug)]
pub struct PromotionBoundary {
    pub cluster_id: MechanicClusterId,
    pub other_cluster_id: MechanicClusterId,
    pub distinction_code: String,
    pub evidence_hash: Hash256,
    pub rejected_equivalence: bool,
}

pub fn promote_campaign_learning(
    store: &CampaignStore,
    state: &CampaignState,
    close_evidence_hash: Hash256,
    boundaries: &[PromotionBoundary],
) -> Result<RegistryRevision, EngineError> {
    if state.phase != CampaignPhase::CloseVerified {
        return Err(EngineError::Policy);
    }
    let campaign_id = state.campaign_id.clone().ok_or(EngineError::Policy)?;
    let manifest = state.manifest.as_ref().ok_or(EngineError::Policy)?;
    if state.close_verification_hash != Some(close_evidence_hash) {
        return Err(EngineError::Policy);
    }
    let current_head = store.registry_head()?.ok_or(EngineError::Policy)?;
    if current_head != manifest.mechanic_registry_revision {
        return Err(EngineError::Registry(
            "registry head advanced after the campaign froze its revision".into(),
        ));
    }
    let source = store
        .registry_revision(manifest.mechanic_registry_revision)?
        .ok_or(EngineError::Policy)?;
    let mut body = source.body.clone();
    for (key, ability) in &state.abilities {
        if ability.phase != campaign_domain::AbilityPhase::Converged {
            continue;
        }
        let member = body
            .members
            .iter_mut()
            .find(|member| &member.key == key)
            .ok_or_else(|| EngineError::Registry(format!("promoted ability absent: {key}")))?;
        let verification_hash = ability.verification_hash.ok_or(EngineError::Policy)?;
        let review_hash = ability.review_hash.ok_or(EngineError::Policy)?;
        let correctness_hash = ability
            .correctness_justification_hash
            .ok_or(EngineError::Policy)?;
        let clause_coverage_hash = ability.evidence_hash.ok_or(EngineError::Policy)?;
        member.verification_provenance = Some(VerificationProvenance {
            exact_dsl_hash: member.dsl_hash,
            clause_coverage_hash,
            adversarial_review_hash: review_hash,
            mechanical_gates_hash: verification_hash,
            lever_check_hash: correctness_hash,
            final_review_hash: close_evidence_hash,
            repository_revision: body.repository_revision.clone(),
        });
        member.confidence = ConfidenceTier::Verified;
        member
            .confidence_reasons
            .insert("campaign-mechanically-verified-and-reviewed".into());
        let cluster = body
            .clusters
            .get_mut(&member.cluster_id)
            .ok_or(EngineError::Policy)?;
        cluster.suspect_members.remove(key);
        cluster.provisional_members.remove(key);
        cluster.unpaired_members.remove(key);
        cluster.verified_exemplars.insert(key.clone());
        cluster.confidence = ConfidenceTier::Verified;
        cluster.verification_provenance.extend([
            verification_hash,
            review_hash,
            correctness_hash,
            close_evidence_hash,
        ]);
        if let Some(candidate_hash) = ability.candidate_hash {
            let candidate: Value = serde_json::from_slice(&store.read_artifact(candidate_hash)?)?;
            let candidate = candidate
                .as_object()
                .cloned()
                .ok_or_else(|| EngineError::Registry("candidate DSL is not an object".into()))?;
            let normalized = normalized_mechanic_dsl(&candidate);
            let candidate_signature = compute_structural_signature(&normalized)?;
            if MechanicClusterId::from_signature(&candidate_signature)? != member.cluster_id {
                return Err(EngineError::Registry(
                    "promoted candidate changed mechanic cluster".into(),
                ));
            }
            let candidate_dsl_hash = Hash256::digest(serde_json::to_vec(&normalized)?);
            member.normalized_dsl = normalized.clone();
            member.dsl_hash = candidate_dsl_hash;
            member.structural_signature = candidate_signature;
            member
                .verification_provenance
                .as_mut()
                .ok_or(EngineError::Policy)?
                .exact_dsl_hash = candidate_dsl_hash;
            let (dsl_template, parameter_schema) = parameterize_dsl(&normalized)?;
            let template_hash = Hash256::digest(serde_json::to_vec(&(
                &dsl_template,
                &parameter_schema,
                &cluster.structural_signature,
            ))?);
            if !cluster
                .accepted_templates
                .iter()
                .any(|template| template.template_hash == template_hash)
            {
                cluster.accepted_templates.push(MechanicTemplate {
                    template_hash,
                    source_member: key.clone(),
                    dsl_template,
                    parameter_schema,
                    confidence: ConfidenceTier::Verified,
                });
            }
        }
    }
    for boundary in boundaries {
        let cluster = body
            .clusters
            .get_mut(&boundary.cluster_id)
            .ok_or(EngineError::Policy)?;
        cluster.known_exclusions.insert(ClusterExclusion {
            other_cluster_id: boundary.other_cluster_id.clone(),
            distinction_code: boundary.distinction_code.clone(),
            evidence_hash: boundary.evidence_hash,
        });
        if boundary.rejected_equivalence {
            cluster.rejected_equivalences.insert(RejectedEquivalence {
                proposed_cluster_id: boundary.other_cluster_id.clone(),
                distinction_code: boundary.distinction_code.clone(),
                refutation_hash: boundary.evidence_hash,
            });
        }
    }
    body.contradiction_queue
        .retain(|entry| !state.abilities.contains_key(&entry.member));
    let revision = RegistryRevision::new(Some(source.revision_id), body)?;
    let receipt = RegistryPromotionReceipt {
        campaign_id,
        source_revision: source.revision_id,
        promoted_revision: revision.revision_id,
        close_evidence_hash,
    };
    store.promote_registry_revision(&revision, source.revision_id, &receipt)?;
    Ok(revision)
}
