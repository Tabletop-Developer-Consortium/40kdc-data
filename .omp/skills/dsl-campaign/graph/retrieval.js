import { canonicalJson, sha256 } from './canonical.js'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { GLOBAL_ROOT_ID, abilityProjectionId, abilityProjectionLabel, missingAbilityLabel, projectionScope } from './projection.js'
import { canonicalizeMechanicFacetValue, mechanicClaimAdapter } from './mechanic-claims.js'

export const SIGNATURE_FIELDS = [
  'actor', 'affected_entity', 'event', 'producer_ports', 'consumer_ports', 'polarity', 'quantifier',
  'timing', 'duration', 'scope', 'ordering', 'restrictions', 'exclusions',
]
export const RETRIEVAL_ORDER = ['exact-family-instance', 'admissible-family-substitution', 'certified-connected-subfamily', 'primitive-discovery', 'embedding-llm-discovery']
const COVERING = new Set(RETRIEVAL_ORDER.slice(0, 3))

function normalizeValue(value) {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return [...value].map(normalizeValue).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeValue(value[key])]))
  if (typeof value === 'string') return value.trim().toLowerCase()
  return value
}

export function normalizeMechanicSignature(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('mechanic signature must be an object')
  const signature = Object.fromEntries(SIGNATURE_FIELDS.map(field => [field, normalizeValue(input[field])]))
  return { signature, signature_hash: sha256(canonicalJson(signature)) }
}

function compatible(target, candidate, substitutions) {
  const bindings = []
  for (const field of SIGNATURE_FIELDS) {
    if (canonicalJson(target[field]) === canonicalJson(candidate[field])) continue
    const allowed = substitutions?.[field]
    if (!allowed || !allowed.some(pair => canonicalJson(pair.from) === canonicalJson(candidate[field]) && canonicalJson(pair.to) === canonicalJson(target[field]))) {
      return { compatible: false, bindings, conflict: field }
    }
    bindings.push({ field, from: candidate[field], to: target[field] })
  }
  return { compatible: true, bindings, conflict: null }
}

export function validateSourceClaims(sourceClaims) {
  if (!Array.isArray(sourceClaims) || !sourceClaims.length) throw new TypeError('source_claims required')
  const ids = sourceClaims.map(claim => {
    if (!claim || Object.getPrototypeOf(claim) !== Object.prototype || typeof claim.claim_occurrence_id !== 'string' || !claim.claim_occurrence_id.trim()) {
      throw new TypeError('source claim_occurrence_id must be non-empty')
    }
    return claim.claim_occurrence_id.trim()
  })
  if (new Set(ids).size !== ids.length) throw new TypeError('source claim_occurrence_ids must be unique')
  return ids
}

export function validateCoveredClaimOccurrenceIds(sourceClaimOccurrenceIds, coveredClaimOccurrenceIds, { required = true } = {}) {
  if (!Array.isArray(coveredClaimOccurrenceIds)) {
    if (required) return { ok: false, reason: 'missing-covers-claim-occurrence-ids', indexes: [] }
    return { ok: true, reason: null, indexes: [] }
  }
  if (new Set(coveredClaimOccurrenceIds).size !== coveredClaimOccurrenceIds.length) return { ok: false, reason: 'duplicate-covered-claim-occurrence-id', indexes: [] }
  const index = new Map(sourceClaimOccurrenceIds.map((claimOccurrenceId, ordinal) => [claimOccurrenceId, ordinal]))
  if (coveredClaimOccurrenceIds.some(claimOccurrenceId => !index.has(claimOccurrenceId))) return { ok: false, reason: 'foreign-covered-claim-occurrence-id', indexes: [] }
  const indexes = coveredClaimOccurrenceIds.map(claimOccurrenceId => index.get(claimOccurrenceId))
  if (indexes.some((value, ordinal) => ordinal > 0 && value <= indexes[ordinal - 1])) return { ok: false, reason: 'covered-claim-occurrence-order-invalid', indexes }
  if (indexes.some((value, ordinal) => ordinal > 0 && value !== indexes[ordinal - 1] + 1)) return { ok: false, reason: 'covered-claim-occurrences-non-contiguous', indexes }
  return { ok: true, reason: null, indexes }
}

// Candidate coverage is an authorization boundary, not model self-reporting. A
// ready plan must be replayed against the current occurrence projection before
// a representation can be certified.
export function validateCandidateClaimCoverage({ source_claims, plan, covered_claim_occurrence_ids, composition_seams, current_claim_occurrence_ids }) {
  const sourceIds = validateSourceClaims(source_claims)
  if (!plan || plan.state !== 'ready') return { ok: false, reason: 'construction-plan-not-ready' }
  if (!Array.isArray(plan.covered_claim_occurrence_ids) || !Array.isArray(plan.unmatched_claim_occurrence_ids)) {
    return { ok: false, reason: 'construction-plan-coverage-missing' }
  }
  if (plan.unmatched_claim_occurrence_ids.length || canonicalJson(plan.covered_claim_occurrence_ids) !== canonicalJson(sourceIds)) {
    return { ok: false, reason: 'construction-plan-not-exact' }
  }
  if (!Array.isArray(current_claim_occurrence_ids) || canonicalJson(current_claim_occurrence_ids) !== canonicalJson(sourceIds)) {
    return { ok: false, reason: 'claim-occurrence-currentness-failed' }
  }
  const candidateCoverage = validateCoveredClaimOccurrenceIds(sourceIds, covered_claim_occurrence_ids)
  if (!candidateCoverage.ok) return candidateCoverage
  if (canonicalJson(covered_claim_occurrence_ids) !== canonicalJson(sourceIds)) {
    return { ok: false, reason: 'candidate-coverage-not-exact' }
  }
  if (!Array.isArray(composition_seams) || canonicalJson(composition_seams) !== canonicalJson(plan.composition_seams || [])) {
    return { ok: false, reason: 'candidate-composition-seams-mismatch' }
  }
  return { ok: true, reason: null, covered_claim_occurrence_ids: [...sourceIds] }
}

export function persistRepresentationClaimCoverage(store, {
  representation_node_id,
  claim_set_id,
  construction_plan_node_id,
  claim_occurrence_ids,
}) {
  for (const claim_occurrence_id of claim_occurrence_ids) {
    store.appendEvent('representation-coverage-recorded', {
      representation_node_id,
      claim_set_id,
      claim_occurrence_id,
      construction_plan_node_id,
      rows: {
        representation_claim_coverage: [{
          representation_node_id,
          claim_set_id,
          claim_occurrence_id,
          coverage_state: 'covered',
          construction_plan_node_id,
        }],
      },
    }, {
      aggregate_kind: 'projection',
      aggregate_id: `${representation_node_id}:${claim_occurrence_id}`,
      node_id: representation_node_id,
    })
  }
}

export function retrieveEvidence({ target_signature, target_claim_occurrence_ids, candidates }) {
  if (!Array.isArray(target_claim_occurrence_ids) || !target_claim_occurrence_ids.length || new Set(target_claim_occurrence_ids).size !== target_claim_occurrence_ids.length || target_claim_occurrence_ids.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('target_claim_occurrence_ids must be non-empty and unique')
  }
  const target = normalizeMechanicSignature(target_signature).signature
  const matches = []
  for (const candidate of candidates) {
    if (candidate.status !== 'certified' || !candidate.current) {
      matches.push({ evidence_node_id: candidate.node_id, match_type: candidate.discovery_kind || 'embedding-llm-discovery', covers_claim_occurrence_ids: [], bindings: [], rejected_reason: 'evidence is not a current certificate' })
      continue
    }
    const normalized = normalizeMechanicSignature(candidate.signature).signature
    const check = compatible(target, normalized, candidate.admissible_substitutions)
    let match_type
    if (check.compatible && check.bindings.length === 0) match_type = 'exact-family-instance'
    else if (check.compatible) match_type = 'admissible-family-substitution'
    else if (Array.isArray(candidate.covers_claim_occurrence_ids) && candidate.covers_claim_occurrence_ids.length) match_type = 'certified-connected-subfamily'
    else match_type = candidate.discovery_kind || 'primitive-discovery'
    let covers = []
    let rejectedReason = COVERING.has(match_type) ? null : `incompatible ${check.conflict || 'discovery-only'} binding`
    if (COVERING.has(match_type)) {
      const coverage = validateCoveredClaimOccurrenceIds(target_claim_occurrence_ids, candidate.covers_claim_occurrence_ids)
      if (!coverage.ok || !candidate.covers_claim_occurrence_ids.length) rejectedReason = coverage.ok ? 'missing-covers-claim-occurrence-ids' : coverage.reason
      else covers = [...candidate.covers_claim_occurrence_ids]
    }
    matches.push({ evidence_node_id: candidate.node_id, match_type, covers_claim_occurrence_ids: covers, bindings: check.bindings, rejected_reason: rejectedReason })
  }
  return matches.sort((a, b) => RETRIEVAL_ORDER.indexOf(a.match_type) - RETRIEVAL_ORDER.indexOf(b.match_type) || a.evidence_node_id.localeCompare(b.evidence_node_id))
}

function candidatePlans(claimOccurrenceIds, matches) {
  const covering = matches.filter(match => COVERING.has(match.match_type) && !match.rejected_reason)
  if (covering.length > 20) throw new Error(`construction-plan-candidate-limit-exceeded: ${covering.length} > 20`)
  const plans = []
  const count = 2 ** covering.length
  for (let mask = 0; mask < count; mask += 1) {
    const selected = covering.filter((_, index) => mask & (2 ** index))
      .sort((left, right) => claimOccurrenceIds.indexOf(left.covers_claim_occurrence_ids[0]) - claimOccurrenceIds.indexOf(right.covers_claim_occurrence_ids[0]) || left.evidence_node_id.localeCompare(right.evidence_node_id))
    const ownership = new Set()
    let overlap = false
    for (const match of selected) for (const claimOccurrenceId of match.covers_claim_occurrence_ids) {
      if (ownership.has(claimOccurrenceId)) overlap = true
      ownership.add(claimOccurrenceId)
    }
    if (overlap) continue
    const covered = claimOccurrenceIds.filter(id => ownership.has(id))
    const unmatched = claimOccurrenceIds.filter(id => !ownership.has(id))
    const exact = selected.filter(match => match.match_type === 'exact-family-instance').length
    plans.push({ selected, covered, unmatched, exact, seams: Math.max(0, selected.length - 1) })
  }
  return plans
}

function planTuple(plan) {
  return [
    plan.unmatched.length,
    plan.seams,
    plan.selected.length,
    -plan.exact,
    plan.selected.map(match => match.evidence_node_id),
  ]
}

function comparePlanTuple(left, right) {
  for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  return canonicalJson(left[4]).localeCompare(canonicalJson(right[4]))
}

export function chooseConstructionPlan({ faction_id, ability_id, claim_set_id, source_claims, matches, authorization, required_checks = [], unresolved = [] }) {
  if (typeof claim_set_id !== 'string' || !claim_set_id) throw new TypeError('claim_set_id required')
  if (!authorization || authorization.status !== 'full' || authorization.obligation !== 'represent' || authorization.claim_set_id !== claim_set_id) {
    throw new Error('construction plan requires full represent authorization')
  }
  const claimOccurrenceIds = validateSourceClaims(source_claims)
  const blocking = unresolved.filter(item => item.resolution_state === 'open' && item.blocks_obligations?.includes('represent'))
  const normalizedMatches = matches.map(match => {
    if (!COVERING.has(match.match_type) || match.rejected_reason) return match
    const coverage = validateCoveredClaimOccurrenceIds(claimOccurrenceIds, match.covers_claim_occurrence_ids)
    return coverage.ok && match.covers_claim_occurrence_ids.length ? match : { ...match, covers_claim_occurrence_ids: [], rejected_reason: coverage.ok ? 'missing-covers-claim-occurrence-ids' : coverage.reason }
  })
  const plans = candidatePlans(claimOccurrenceIds, normalizedMatches)
  plans.sort((left, right) => comparePlanTuple(planTuple(left), planTuple(right)))
  const best = plans[0]
  const unmatched = [...new Set([...best.unmatched, ...(blocking.length ? claimOccurrenceIds : [])])]
  return {
    faction_id, ability_id, claim_set_id,
    selected_evidence_node_ids: best.selected.map(match => match.evidence_node_id),
    covered_claim_occurrence_ids: best.covered,
    unmatched_claim_occurrence_ids: unmatched,
    state: blocking.length ? 'blocked' : best.unmatched.length ? 'incomplete' : 'ready',
    blocking_unresolved_keys: blocking.map(item => item.unresolved_key),
    rejected_conflicts: normalizedMatches.filter(match => match.rejected_reason),
    substitutions: best.selected.filter(match => match.bindings.length).map(match => ({ evidence_node_id: match.evidence_node_id, bindings: match.bindings })),
    composition_seams: best.selected.slice(1).map((match, index) => ({
      left: best.selected[index].evidence_node_id,
      right: match.evidence_node_id,
      after_claim_occurrence_id: best.selected[index].covers_claim_occurrence_ids.at(-1),
      before_claim_occurrence_id: match.covers_claim_occurrence_ids[0],
    })),
    required_checks,
  }
}

function sameStrings(left, right) {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort())
}

function acceptedAuthority(store, occurrenceId, originId, visiting = new Set()) {
  if (visiting.has(occurrenceId)) throw new Error('accepted derivation cycle')
  visiting.add(occurrenceId)
  const occurrence = store.db.prepare(`
    SELECT o.*,origin.origin_kind,origin.current_state
    FROM claim_occurrences o JOIN claim_origins origin USING(origin_id)
    WHERE o.claim_occurrence_id=?
  `).get(occurrenceId)
  if (!occurrence || occurrence.state !== 'accepted' || occurrence.origin_id !== originId ||
      occurrence.origin_kind !== 'primary-source' || occurrence.current_state !== 'current') {
    throw new Error('accepted derivation parent lacks current primary-source authority')
  }
  const assertions = store.db.prepare("SELECT * FROM claim_assertions WHERE claim_occurrence_id=? AND decision_state='accepted' ORDER BY assertion_id").all(occurrenceId)
  if (assertions.length !== 1) throw new Error('accepted member must have exactly one accepted assertion')
  const assertion = assertions[0]
  const reviews = store.db.prepare("SELECT * FROM claim_review_decisions WHERE subject_node_id=? AND decision='accept' ORDER BY decision_id").all(assertion.node_id)
  if (reviews.length !== 1) throw new Error('accepted assertion must have exactly one accepting review')
  if (!reviews[0].policy_version) throw new Error('accepting review lacks policy version')
  if (reviews[0].reviewer_kind === 'validator' && reviews[0].policy_version !== '2') throw new Error('accepting validator policy is stale')
  const direct = store.db.prepare(`
    SELECT 1 FROM claim_assertion_evidence ae
    JOIN claim_evidence_bindings b USING(binding_id)
    WHERE ae.assertion_id=? AND b.origin_id=?
      AND (
        b.kind='source_span' OR
        (b.kind='structured_path' AND b.path_kind IN ('json_pointer','json-pointer'))
      )
    LIMIT 1
  `).get(assertion.assertion_id, originId)
  if (direct) {
    if (!['validator', 'human'].includes(reviews[0].reviewer_kind)) throw new Error('direct assertion lacks eligible accepting review')
  } else {
    if (reviews[0].reviewer_kind !== 'human') throw new Error('derived-only assertion requires human review')
    const parents = store.db.prepare('SELECT parent_claim_occurrence_id FROM claim_derivation_parents WHERE assertion_id=? ORDER BY ordinal').all(assertion.assertion_id)
    if (!parents.length) throw new Error('accepted assertion lacks direct evidence or derivation parents')
    for (const parent of parents) acceptedAuthority(store, parent.parent_claim_occurrence_id, originId, visiting)
  }
  visiting.delete(occurrenceId)
  return { assertion, review: reviews[0] }
}

export function assertClaimSetAuthority(store, claimSet, certificatePayload, obligation = 'retrieve') {
  if (certificatePayload.status !== 'current') throw new Error('claim-set certificate is not current')
  if (claimSet.adapter_id !== mechanicClaimAdapter.adapter_id) throw new Error('claim-set adapter is not approved for direct evidence')
  const origin = store.db.prepare("SELECT * FROM claim_origins WHERE origin_id=? AND origin_kind='primary-source' AND current_state='current'").get(claimSet.origin_id)
  if (!origin) throw new Error('claim set lacks current primary-source authority')
  if (claimSet.completeness_state !== 'complete') throw new Error('claim set is not complete')
  const checked = JSON.parse(claimSet.obligations_checked_json)
  if (!checked.includes(obligation)) throw new Error(`claim set did not check ${obligation} obligation`)
  const blockers = store.db.prepare(`
    SELECT unresolved.unresolved_key,unresolved.blocks_obligations_json
    FROM claim_set_unresolved membership
    JOIN claim_unresolved unresolved USING(unresolved_key)
    WHERE membership.claim_set_id=? AND unresolved.resolution_state='open'
    ORDER BY unresolved.unresolved_key
  `).all(claimSet.claim_set_id).filter(row => JSON.parse(row.blocks_obligations_json).includes(obligation))
  if (blockers.length) throw new Error(`open unresolved blocker ${blockers[0].unresolved_key}`)
  const candidates = Number(store.db.prepare("SELECT COUNT(*) AS n FROM claim_set_members WHERE claim_set_id=? AND member_state='candidate'").get(claimSet.claim_set_id).n)
  if (candidates) throw new Error('complete claim set retains candidate members')
  const members = store.db.prepare("SELECT claim_occurrence_id FROM claim_set_members WHERE claim_set_id=? AND member_state='accepted' ORDER BY claim_occurrence_id").all(claimSet.claim_set_id)
  if (!members.length) throw new Error('claim set has no accepted source facts')
  const authorities = members.map(member => acceptedAuthority(store, member.claim_occurrence_id, origin.origin_id))
  const assertionIds = authorities.map(item => item.assertion.assertion_id)
  const assertionNodes = authorities.map(item => item.assertion.node_id)
  const reviewIds = authorities.map(item => item.review.decision_id)
  const reviewNodes = authorities.map(item => item.review.node_id)
  if (!sameStrings(certificatePayload.assertion_ids ?? [], assertionIds) ||
      !sameStrings(certificatePayload.assertion_node_ids ?? [], assertionNodes) ||
      !sameStrings(certificatePayload.decision_ids ?? [], reviewIds) ||
      !sameStrings(certificatePayload.review_decision_node_ids ?? [], reviewNodes)) {
    throw new Error('claim-set certificate does not reference exact accepted authority')
  }
  const sourceNode = store.db.prepare("SELECT node_id FROM nodes WHERE kind='source-snapshot' AND json_extract(payload_json,'$.source_snapshot_id')=? ORDER BY node_id LIMIT 1").get(origin.source_snapshot_id)
  if (!sourceNode) throw new Error('primary-source node missing')
  const dependencies = [sourceNode.node_id, origin.node_id, certificatePayload.extraction_node_id, certificatePayload.claim_set_node_id, ...assertionNodes, ...reviewNodes]
  if (!sameStrings(certificatePayload.dependency_node_ids ?? [], dependencies)) throw new Error('claim-set certificate dependencies are not exact')
  const certificateNodeId = claimSet.certificate_node_id
  for (const dependency of dependencies) {
    if (!store.db.prepare('SELECT 1 FROM edges WHERE parent_node_id=? AND child_node_id=?').get(dependency, certificateNodeId)) {
      throw new Error('claim-set certificate dependency edge missing')
    }
  }
  const invalidated = members.some(member => store.db.prepare('SELECT 1 FROM claim_source_revision_invalidations WHERE old_occurrence_id=?').get(member.claim_occurrence_id))
  if (invalidated) throw new Error('claim set has current source-revision invalidation')
  return { origin, accepted: authorities.map(item => item.assertion) }
}

export function authorizeClaimSet(store, certificateNodeId, obligation = 'retrieve') {
  try {
    const certificate = store.db.prepare('SELECT kind,payload_json FROM nodes WHERE node_id=?').get(certificateNodeId)
    if (!certificate || certificate.kind !== 'claim-set-certificate') throw new Error('claim-set certificate node missing')
    const certificatePayload = JSON.parse(certificate.payload_json)
    const claimSet = store.db.prepare("SELECT * FROM claim_sets WHERE claim_set_id=? AND state='current'").get(certificatePayload.claim_set_id)
    if (!claimSet) throw new Error('current claim-set certificate projection missing')
    assertClaimSetAuthority(store, claimSet, certificatePayload, obligation)
    return { certificate_node_id: certificateNodeId, claim_set_id: claimSet.claim_set_id, subject_ref: claimSet.subject_ref, obligation, status: 'full' }
  } catch (error) {
    throw new Error(`claim set does not authorize ${obligation}: ${error.message}`)
  }
}

export function projectedClaimSet(store, { certificate_node_id, obligation = 'retrieve' }) {
  const authorization = authorizeClaimSet(store, certificate_node_id, obligation)
  const certificate = store.db.prepare('SELECT kind,payload_json FROM nodes WHERE node_id=?').get(certificate_node_id)
  const certificatePayload = JSON.parse(certificate.payload_json)
  const claimSet = store.db.prepare(`
    SELECT sets.* FROM claim_sets AS sets
    WHERE sets.claim_set_id=? AND sets.state='current'
  `).get(certificatePayload.claim_set_id)
  const origin = store.db.prepare('SELECT * FROM claim_origins WHERE origin_id=?').get(claimSet.origin_id)
  const claims = store.db.prepare(`
    SELECT occurrences.claim_occurrence_id, occurrences.semantic_key, semantic.proposition_json,
           assertions.node_id AS assertion_node_id, nodes.payload_json,
           MIN(bindings.start_byte) AS first_evidence_byte
    FROM claim_set_members AS members
    JOIN claim_occurrences AS occurrences ON occurrences.claim_occurrence_id=members.claim_occurrence_id
    JOIN semantic_claims AS semantic ON semantic.semantic_key=occurrences.semantic_key
    JOIN claim_assertions AS assertions
      ON assertions.claim_occurrence_id=occurrences.claim_occurrence_id AND assertions.decision_state='accepted'
    JOIN nodes ON nodes.node_id=assertions.node_id
    LEFT JOIN claim_assertion_evidence AS assertion_evidence ON assertion_evidence.assertion_id=assertions.assertion_id
    LEFT JOIN claim_evidence_bindings AS bindings ON bindings.binding_id=assertion_evidence.binding_id
    WHERE members.claim_set_id=? AND occurrences.state='accepted'
    GROUP BY occurrences.claim_occurrence_id, occurrences.semantic_key, semantic.proposition_json, assertions.node_id, nodes.payload_json
    ORDER BY first_evidence_byte IS NULL, first_evidence_byte, occurrences.claim_occurrence_id
  `).all(claimSet.claim_set_id).map(row => {
    const assertionPayload = JSON.parse(row.payload_json || '{}')
    return {
      claim_occurrence_id: row.claim_occurrence_id,
      semantic_key: row.semantic_key,
      proposition: JSON.parse(row.proposition_json),
      signature: assertionPayload.signature || assertionPayload.mechanic_signature || null,
      assertion_node_id: row.assertion_node_id,
    }
  })
  if (!claims.length) throw new Error('claim set has no current accepted occurrences')
  const certifiedAssertionNodes = new Set(certificatePayload.assertion_node_ids ?? [])
  if (certifiedAssertionNodes.size !== claims.length || claims.some(claim => !certifiedAssertionNodes.has(claim.assertion_node_id))) {
    throw new Error('claim-set certificate does not reference current accepted assertion authority')
  }
  const unresolved = store.db.prepare(`
    SELECT unresolved.unresolved_key, unresolved.kind, unresolved.focus_json,
           unresolved.blocks_obligations_json, unresolved.resolution_state
    FROM claim_set_unresolved AS membership
    JOIN claim_unresolved AS unresolved ON unresolved.unresolved_key=membership.unresolved_key
    WHERE membership.claim_set_id=? AND unresolved.resolution_state='open'
    ORDER BY unresolved.unresolved_key
  `).all(claimSet.claim_set_id).map(row => ({
    unresolved_key: row.unresolved_key,
    kind: row.kind,
    focus: JSON.parse(row.focus_json),
    blocks_obligations: JSON.parse(row.blocks_obligations_json),
    resolution_state: row.resolution_state,
  }))
  const aggregate = claims.find(claim => claim.signature?.aggregate)?.signature.aggregate ||
    claims.find(claim => claim.signature)?.signature
  if (!aggregate) throw new Error('projected claim signatures missing')
  return {
    authorization,
    claim_set_id: claimSet.claim_set_id,
    certificate_node_id,
    source_snapshot_id: origin.source_snapshot_id,
    source_claims: claims,
    target_signature: aggregate,
    unresolved,
  }
}

export function persistRetrieval(store, { run_id, faction_id, ability_id, claim_set_certificate_node_id, candidates, required_checks = [] }) {
  const projected = projectedClaimSet(store, { certificate_node_id: claim_set_certificate_node_id, obligation: 'retrieve' })
  const claimOccurrenceIds = validateSourceClaims(projected.source_claims)
  const matches = retrieveEvidence({ target_signature: projected.target_signature, target_claim_occurrence_ids: claimOccurrenceIds, candidates })
  const represent = projectedClaimSet(store, { certificate_node_id: claim_set_certificate_node_id, obligation: 'represent' }).authorization
  const plan = chooseConstructionPlan({ faction_id, ability_id, claim_set_id: projected.claim_set_id, source_claims: projected.source_claims, matches, authorization: represent, required_checks, unresolved: projected.unresolved })
  let matchNodes
  let planNode
  store.transaction(() => {
    matchNodes = matches.map(match => {
      const parents = [{ node_id: claim_set_certificate_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }]
      if (match.evidence_node_id && store.hasNode(match.evidence_node_id)) {
        const accepted = !match.rejected_reason && COVERING.has(match.match_type)
        const edge_type = !accepted ? 'similar_mechanic' : match.match_type === 'admissible-family-substitution' ? 'specializes' : 'satisfies'
        parents.push({ node_id: match.evidence_node_id, edge_type, authorizes_reuse: accepted, metadata: { covers_claim_occurrence_ids: match.covers_claim_occurrence_ids } })
      }
      return store.createNode({ kind: 'retrieval-match', payload: { faction_id, ability_id, claim_set_id: projected.claim_set_id, ...match }, parents })
    })
    planNode = store.createNode({
      kind: 'construction-plan',
      payload: plan,
      parents: [
        { node_id: claim_set_certificate_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} },
        ...matchNodes.map((node, index) => {
          const match = matches[index]
          const accepted = !match.rejected_reason && COVERING.has(match.match_type)
          return { node_id: node.node_id, edge_type: accepted ? 'satisfies' : 'similar_mechanic', authorizes_reuse: accepted, metadata: {} }
        }),
      ],
    })
    store.appendEvent('construction-plan-recorded', {
      run_id, faction_id, ability_id,
      rows: {
        construction_plans: [{
          id: `${run_id}:${faction_id}/${ability_id}:construction-plan`,
          run_id,
          state: plan.state,
          node_id: planNode.node_id,
          payload: plan,
        }],
      },
    }, { aggregate_kind: 'construction-plan', aggregate_id: `${run_id}:${faction_id}/${ability_id}`, node_id: planNode.node_id })
  })
  return { matches, match_node_ids: matchNodes.map(node => node.node_id), plan, plan_node_id: planNode.node_id }
}

const GRAPH_PROJECTION_TABLES = [
  'source_snapshots', 'clause_maps', 'mechanic_signatures', 'tasks', 'attempts', 'leases',
  'checkpoints', 'decisions', 'findings', 'checks', 'certificates', 'ability_evidence',
  'family_templates', 'family_instances', 'construction_plans', 'apply_transactions',
  'legacy_observations',
]

function refKey(factionId, abilityId) {
  return `${factionId}\0${abilityId}`
}

export class GraphQueryError extends Error {
  constructor(status, code, details = {}) {
    super(code)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function graphRevision(store) {
  return sha256(canonicalJson({ sequence: store.sequence(), projection: store.projectionChecksum() }))
}

function cursorEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function cursorDecode(value, revision, fingerprint) {
  if (!value) return null
  let parsed
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new GraphQueryError(400, 'invalid-cursor') }
  if (parsed.graph_revision !== revision) throw new GraphQueryError(409, 'stale-cursor', { graph_revision: revision })
  if (parsed.fingerprint !== fingerprint || !Array.isArray(parsed.tuple)) throw new GraphQueryError(400, 'cursor-filter-mismatch')
  return parsed.tuple
}

function boundedInteger(value, fallback, maximum, minimum = 1) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new GraphQueryError(400, 'invalid-bound')
  return Math.min(parsed, maximum)
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a).localeCompare(String(b))
  }
  return 0
}

function parsedWorkflowEnvelope(row) {
  if (row.kind !== 'workflow-output') return null
  const payload = JSON.parse(row.payload_json || '{}')
  const envelope = payload.envelope
  if (!envelope || typeof envelope !== 'object') return null
  const outputKind = typeof payload.output_kind === 'string' ? payload.output_kind : null
  const runId = typeof envelope.run_id === 'string' ? envelope.run_id : null
  const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : null
  const attemptId = typeof envelope.attempt_id === 'string' ? envelope.attempt_id : null
  if (!outputKind || !runId || !taskId || !attemptId || envelope.producer_contract_version !== Number(row.producer_contract_version)) return null
  const provenance = {
    run_id: runId,
    task_id: taskId,
    attempt_id: attemptId,
    output_kind: outputKind,
  }
  const taskParts = taskId.split(':')
  const attemptParts = attemptId.split(':')
  const taskMarker = taskParts.lastIndexOf('task')
  const attemptMarker = attemptParts.lastIndexOf('attempt')
  if (
    taskMarker >= 6 &&
    attemptMarker >= 6 &&
    /^\d+$/.test(taskParts[taskMarker + 1] || '') &&
    /^\d+$/.test(attemptParts[attemptMarker + 1] || '') &&
    taskParts.slice(0, taskMarker).join(':') === attemptParts.slice(0, attemptMarker).join(':') &&
    outputKind === taskParts[taskMarker - 1]
  ) {
    provenance.workflow_stage = taskParts[2]
    provenance.workflow_task = taskParts[3]
    provenance.workflow_round = taskParts[4]
    provenance.workflow_lane = taskParts[5]
    provenance.attempt_number = Number(attemptParts[attemptMarker + 1])
  } else {
    const attemptNumber = attemptId.match(/(?:^|-)attempt-(\d+)$/)?.[1]
    if (attemptNumber) provenance.attempt_number = Number(attemptNumber)
  }
  return provenance
}

function trustedWorkflowEnvelopes(store) {
  const tasks = new Map(store.db.prepare('SELECT id,run_id,node_id FROM tasks').all().map(row => [row.id, row]))
  const attempts = new Map(store.db.prepare('SELECT id,run_id,node_id FROM attempts').all().map(row => [row.id, row]))
  const envelopes = new Map()
  for (const row of store.db.prepare("SELECT node_id,kind,producer_contract_version,payload_json FROM nodes WHERE kind='workflow-output'").all()) {
    const envelope = parsedWorkflowEnvelope(row)
    const task = envelope ? tasks.get(envelope.task_id) : null
    const attempt = envelope ? attempts.get(envelope.attempt_id) : null
    if (!envelope || task?.run_id !== envelope.run_id || task.node_id !== row.node_id || attempt?.run_id !== envelope.run_id || attempt.node_id !== row.node_id) continue
    envelopes.set(row.node_id, envelope)
  }
  return envelopes
}

function campaignRefsByNode(store, workflowEnvelopes = trustedWorkflowEnvelopes(store)) {
  const refs = new Map()
  const runs = new Map(store.db.prepare('SELECT run_id,campaign_id FROM runs').all().map(row => [row.run_id, row.campaign_id]))
  const add = (nodeId, campaignId) => {
    if (!nodeId || !campaignId) return
    if (!refs.has(nodeId)) refs.set(nodeId, new Set())
    refs.get(nodeId).add(campaignId)
  }
  for (const table of GRAPH_PROJECTION_TABLES) {
    for (const row of store.db.prepare(`SELECT node_id,run_id FROM ${table} WHERE node_id IS NOT NULL AND run_id IS NOT NULL`).all()) add(row.node_id, runs.get(row.run_id))
  }
  for (const row of store.db.prepare('SELECT node_id,aggregate_id FROM events WHERE node_id IS NOT NULL').all()) add(row.node_id, runs.get(row.aggregate_id) || store.db.prepare('SELECT campaign_id FROM runs WHERE campaign_id=?').get(row.aggregate_id)?.campaign_id)
  for (const [nodeId, envelope] of workflowEnvelopes) add(nodeId, runs.get(envelope.run_id))
  return new Map([...refs].map(([nodeId, values]) => [nodeId, [...values].sort()]))
}

function abilityRefsByNode(store) {
  const refs = new Map()
  for (const row of store.db.prepare(`
    SELECT refs.node_id,refs.faction_id,refs.ability_id,refs.source_kind,refs.distance,
           catalog.ability_name,catalog.faction_name
    FROM node_ability_refs AS refs
    LEFT JOIN ability_catalog AS catalog
      ON catalog.faction_id=refs.faction_id AND catalog.ability_id=refs.ability_id
    ORDER BY refs.node_id,refs.faction_id,refs.ability_id
  `).all()) {
    if (!refs.has(row.node_id)) refs.set(row.node_id, [])
    refs.get(row.node_id).push({
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      label: row.ability_name ? abilityProjectionLabel(row) : missingAbilityLabel(row.faction_id, row.ability_id),
      metadata_status: row.ability_name ? 'current' : 'missing',
      source_kind: row.source_kind,
      distance: Number(row.distance),
    })
  }
  return refs
}

function projectionMetadataByNode(store) {
  const metadata = new Map()
  for (const table of GRAPH_PROJECTION_TABLES) {
    for (const row of store.db.prepare(`SELECT id,run_id,state,node_id FROM ${table} WHERE node_id IS NOT NULL ORDER BY id`).all()) {
      if (!metadata.has(row.node_id)) metadata.set(row.node_id, { run_ids: new Set(), statuses: new Set(), certificates: [], findings: [] })
      const value = metadata.get(row.node_id)
      if (row.run_id) value.run_ids.add(row.run_id)
      if (row.state) value.statuses.add(row.state)
      if (table === 'certificates') value.certificates.push(row.id)
      if (table === 'findings') value.findings.push(row.id)
    }
  }
  return new Map([...metadata].map(([nodeId, value]) => [nodeId, {
    run_ids: [...value.run_ids].sort(),
    statuses: [...value.statuses].sort(),
    certificates: value.certificates.sort(),
    findings: value.findings.sort(),
  }]))
}

function rootNode(revision) {
  return {
    id: GLOBAL_ROOT_ID,
    kind: 'mechanic-evidence-root',
    label: 'Mechanic Evidence',
    scope: 'global',
    ability_refs: [],
    campaign_refs: [],
    metadata: { graph_revision: revision },
  }
}

function abilityRowLabel(row) {
  return row.metadata_status === 'missing'
    ? missingAbilityLabel(row.faction_id, row.ability_id)
    : abilityProjectionLabel(row)
}

function projectionAbilityRows(store) {
  const rows = new Map()
  for (const row of store.db.prepare('SELECT * FROM ability_catalog').all()) {
    rows.set(refKey(row.faction_id, row.ability_id), { ...row, metadata_status: 'current' })
  }
  for (const row of store.db.prepare('SELECT DISTINCT faction_id,ability_id FROM node_ability_refs ORDER BY faction_id,ability_id').all()) {
    const key = refKey(row.faction_id, row.ability_id)
    if (!rows.has(key)) rows.set(key, {
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      ability_name: null,
      faction_name: null,
      repository_version_id: null,
      metadata_status: 'missing',
    })
  }
  return [...rows.values()]
}

function abilityNode(row, statusMetadata = {}) {
  const label = abilityRowLabel(row)
  return {
    id: abilityProjectionId(row.faction_id, row.ability_id),
    kind: 'ability',
    label,
    scope: 'ability',
    ability_refs: [{
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      label,
      metadata_status: row.metadata_status,
      source_kind: row.metadata_status === 'missing' ? 'projection-ref' : 'catalog',
      distance: 0,
    }],
    campaign_refs: statusMetadata.campaign_refs || [],
    metadata: {
      metadata_status: row.metadata_status,
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      statuses: statusMetadata.statuses || [],
      evidence_count: statusMetadata.evidence_count || 0,
    },
  }
}

function browserWorkflowProvenance(envelope) {
  if (!envelope) return {}
  return {
    output_kind: envelope.output_kind,
    task_id: envelope.task_id,
    attempt_id: envelope.attempt_id,
    workflow_stage: envelope.workflow_stage,
    workflow_task: envelope.workflow_task,
    workflow_round: envelope.workflow_round,
    workflow_lane: envelope.workflow_lane,
    attempt_number: envelope.attempt_number,
  }
}

function evidenceLabel(row, provenance) {
  const role = provenance.output_kind || row.kind
  return `${role.replaceAll('-', ' ')}${provenance.output_kind ? ' output' : ''}`
}


function evidenceNode(row, abilityRefs, campaignRefs, metadata, workflowEnvelopes) {
  const refs = abilityRefs.get(row.node_id) || []
  const provenance = browserWorkflowProvenance(workflowEnvelopes.get(row.node_id))
  return {
    id: row.node_id,
    kind: row.kind,
    label: evidenceLabel(row, provenance),
    scope: projectionScope(refs),
    ability_refs: refs,
    campaign_refs: campaignRefs.get(row.node_id) || [],
    metadata: {
      ...(metadata.get(row.node_id) || { run_ids: [], statuses: [], certificates: [], findings: [] }),
      ...provenance,
      lineage_distance: Number(row.lineage_distance),
      producer_contract_version: Number(row.producer_contract_version),
    },
  }
}

function edge(id, source, target, kind, metadata = {}) {
  return { id, source, target, kind, metadata }
}

function selectedEdges(store, nodeIds, abilityRows, evidenceNodeIds = new Set(nodeIds), availableNodeIds = new Set(nodeIds)) {
  const selected = new Set(nodeIds)
  const edges = []
  const incoming = new Set()
  for (const row of store.db.prepare('SELECT parent_node_id,child_node_id,edge_type,authorizes_reuse FROM edges ORDER BY parent_node_id,child_node_id,edge_type').all()) {
    if (!evidenceNodeIds.has(row.parent_node_id) || !evidenceNodeIds.has(row.child_node_id)) continue
    incoming.add(row.child_node_id)
    if (!selected.has(row.parent_node_id) && !selected.has(row.child_node_id)) continue
    if (!availableNodeIds.has(row.parent_node_id) || !availableNodeIds.has(row.child_node_id)) continue
    edges.push(edge(sha256(`${row.parent_node_id}:${row.child_node_id}:${row.edge_type}`), row.parent_node_id, row.child_node_id, row.edge_type, { authorizes_reuse: Boolean(row.authorizes_reuse) }))
  }
  for (const row of abilityRows) {
    const abilityId = abilityProjectionId(row.faction_id, row.ability_id)
    edges.push(edge(`edge:${GLOBAL_ROOT_ID}:${abilityId}`, GLOBAL_ROOT_ID, abilityId, 'contains'))
    for (const nodeId of selected) {
      if (incoming.has(nodeId)) continue
      const belongs = store.db.prepare('SELECT 1 FROM node_ability_refs WHERE node_id=? AND faction_id=? AND ability_id=?').get(nodeId, row.faction_id, row.ability_id)
      if (belongs) edges.push(edge(`edge:${abilityId}:${nodeId}`, abilityId, nodeId, 'evidence'))
    }
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id))
}

function abilityStatusMetadata(store, factionId, abilityId, campaignRefs, metadata) {
  const nodeIds = store.db.prepare('SELECT node_id FROM node_ability_refs WHERE faction_id=? AND ability_id=? ORDER BY node_id').all(factionId, abilityId).map(row => row.node_id)
  const statuses = new Set()
  const campaigns = new Set()
  for (const nodeId of nodeIds) {
    for (const status of metadata.get(nodeId)?.statuses || []) statuses.add(status)
    for (const campaign of campaignRefs.get(nodeId) || []) campaigns.add(campaign)
  }
  return { statuses: [...statuses].sort(), campaign_refs: [...campaigns].sort(), evidence_count: nodeIds.length }
}

function validateFilters(mode, filters) {
  if (!['index', 'ability', 'campaign'].includes(mode)) throw new GraphQueryError(400, 'invalid-mode')
  if (mode === 'index' && (filters.faction_id || filters.ability_id || filters.campaign_id)) throw new GraphQueryError(400, 'invalid-index-filters')
  if (mode === 'ability' && (!filters.faction_id || !filters.ability_id || filters.campaign_id)) throw new GraphQueryError(400, 'ability-filter-required')
  if (mode === 'campaign' && (!filters.campaign_id || filters.faction_id || filters.ability_id)) throw new GraphQueryError(400, 'campaign-filter-required')
}

export function graphSubscriptionRevision(store, query = {}) {
  const mode = query.mode || 'index'
  const filters = {
    mode,
    faction_id: query.faction_id || null,
    ability_id: query.ability_id || null,
    campaign_id: query.campaign_id || null,
  }
  validateFilters(mode, filters)
  boundedInteger(query.limit, mode === 'index' ? 2 : 3, mode === 'index' ? 250 : 400, mode === 'index' ? 1 : 3)
  if (mode !== 'index') boundedInteger(query.depth, 4, 8, 0)
  if (
    mode === 'ability' &&
    !projectionAbilityRows(store).some(row => row.faction_id === filters.faction_id && row.ability_id === filters.ability_id)
  ) throw new GraphQueryError(404, 'ability-not-found')
  if (mode === 'campaign' && !store.db.prepare('SELECT 1 FROM runs WHERE campaign_id=?').get(filters.campaign_id)) {
    throw new GraphQueryError(404, 'campaign-not-found')
  }
  return graphRevision(store)
}

export function globalGraphSnapshot(store, query = {}) {
  const mode = query.mode || 'index'
  const filters = {
    mode,
    faction_id: query.faction_id || null,
    ability_id: query.ability_id || null,
    campaign_id: query.campaign_id || null,
  }
  validateFilters(mode, filters)
  const revision = graphRevision(store)
  const workflowEnvelopes = trustedWorkflowEnvelopes(store)
  const campaignRefs = campaignRefsByNode(store, workflowEnvelopes)
  const metadata = projectionMetadataByNode(store)
  const abilityRefs = abilityRefsByNode(store)
  const projectionAbilities = projectionAbilityRows(store)
  const abilityByKey = new Map(projectionAbilities.map(row => [refKey(row.faction_id, row.ability_id), row]))
  if (mode === 'index') {
    const limit = boundedInteger(query.limit, 100, 250)
    const fingerprint = sha256(canonicalJson(filters))
    const after = cursorDecode(query.after, revision, fingerprint)
    const rows = projectionAbilities
      .map(row => ({ ...row, tuple: [row.faction_name || row.faction_id, row.ability_name || row.ability_id, row.faction_id, row.ability_id] }))
      .sort((a, b) => compareTuple(a.tuple, b.tuple))
      .filter(row => !after || compareTuple(row.tuple, after) > 0)
    const pageRows = rows.slice(0, limit)
    const truncated = rows.length > pageRows.length
    const nodes = [rootNode(revision), ...pageRows.map(row => abilityNode(row, abilityStatusMetadata(store, row.faction_id, row.ability_id, campaignRefs, metadata)))]
    const edges = pageRows.map(row => {
      const id = abilityProjectionId(row.faction_id, row.ability_id)
      return edge(`edge:${GLOBAL_ROOT_ID}:${id}`, GLOBAL_ROOT_ID, id, 'contains')
    })
    const next = truncated ? cursorEncode({ graph_revision: revision, fingerprint, tuple: pageRows.at(-1).tuple }) : null
    return { graph_revision: revision, root: GLOBAL_ROOT_ID, nodes, edges, page: { next_cursor: next, truncated }, filters }
  }

  const limit = boundedInteger(query.limit, 150, 400, 3)
  const depth = boundedInteger(query.depth, 4, 8, 0)
  const selectedCampaign = mode === 'campaign' ? store.db.prepare('SELECT run_id,campaign_id FROM runs WHERE campaign_id=?').get(filters.campaign_id) : null
  if (mode === 'campaign' && !selectedCampaign) throw new GraphQueryError(404, 'campaign-not-found')
  let abilityRows
  if (mode === 'ability') {
    const row = abilityByKey.get(refKey(filters.faction_id, filters.ability_id))
    if (!row) throw new GraphQueryError(404, 'ability-not-found')
    abilityRows = [row]
  } else {
    const keys = new Map()
    for (const [nodeId, campaigns] of campaignRefs) {
      if (!campaigns.includes(filters.campaign_id)) continue
      for (const ref of abilityRefs.get(nodeId) || []) keys.set(refKey(ref.faction_id, ref.ability_id), ref)
    }
    abilityRows = [...keys.values()].map(ref => abilityByKey.get(refKey(ref.faction_id, ref.ability_id))).filter(Boolean)
      .sort((a, b) => (a.faction_name || a.faction_id).localeCompare(b.faction_name || b.faction_id) || (a.ability_name || a.ability_id).localeCompare(b.ability_name || b.ability_id) || a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
  }
  const conditions = mode === 'ability'
    ? { sql: 'refs.faction_id=? AND refs.ability_id=?', args: [filters.faction_id, filters.ability_id] }
    : null
  let rows = mode === 'ability'
    ? store.db.prepare(`SELECT n.node_id,n.kind,n.producer_contract_version,n.payload_json,MIN(refs.distance) AS lineage_distance FROM nodes n JOIN node_ability_refs refs USING(node_id) WHERE ${conditions.sql} GROUP BY n.node_id,n.kind,n.producer_contract_version,n.payload_json`).all(...conditions.args)
    : store.db.prepare('SELECT n.node_id,n.kind,n.producer_contract_version,n.payload_json,MIN(refs.distance) AS lineage_distance FROM nodes n JOIN node_ability_refs refs USING(node_id) GROUP BY n.node_id,n.kind,n.producer_contract_version,n.payload_json').all()
        .filter(row => (campaignRefs.get(row.node_id) || []).includes(filters.campaign_id))
  rows = rows.filter(row => Number(row.lineage_distance) <= depth)
    .map(row => ({ ...row, tuple: [Number(row.lineage_distance), row.kind, row.node_id] }))
    .sort((a, b) => compareTuple(a.tuple, b.tuple))
  const evidenceNodeIds = new Set(rows.map(row => row.node_id))
  const fingerprint = sha256(canonicalJson({ ...filters, depth }))
  const after = cursorDecode(query.after, revision, fingerprint)
  const precedingNodeIds = new Set(rows.filter(row => after && compareTuple(row.tuple, after) <= 0).map(row => row.node_id))
  rows = rows.filter(row => !after || compareTuple(row.tuple, after) > 0)
  let pageRows
  let pageAbilityRows
  if (mode === 'ability') {
    pageAbilityRows = abilityRows
    pageRows = rows.slice(0, limit - 2)
  } else {
    const campaignAbilityKeys = new Set(abilityRows.map(row => refKey(row.faction_id, row.ability_id)))
    const selectedAbilities = new Map()
    pageRows = []
    for (const row of rows) {
      const referenced = (abilityRefs.get(row.node_id) || [])
        .filter(ref => campaignAbilityKeys.has(refKey(ref.faction_id, ref.ability_id)))
        .map(ref => abilityByKey.get(refKey(ref.faction_id, ref.ability_id)))
        .filter(Boolean)
      const additions = referenced.filter(ref => !selectedAbilities.has(refKey(ref.faction_id, ref.ability_id)))
      if (1 + pageRows.length + selectedAbilities.size + 1 + additions.length > limit) {
        if (!pageRows.length) throw new GraphQueryError(400, 'limit-too-small-for-campaign-node')
        break
      }
      pageRows.push(row)
      for (const ref of additions) selectedAbilities.set(refKey(ref.faction_id, ref.ability_id), ref)
    }
    pageAbilityRows = [...selectedAbilities.values()].sort((a, b) => (a.faction_name || a.faction_id).localeCompare(b.faction_name || b.faction_id) || (a.ability_name || a.ability_id).localeCompare(b.ability_name || b.ability_id))
  }
  const truncated = rows.length > pageRows.length
  const evidenceNodes = pageRows.map(row => evidenceNode(row, abilityRefs, campaignRefs, metadata, workflowEnvelopes))
  const nodes = [rootNode(revision), ...pageAbilityRows.map(row => abilityNode(row, abilityStatusMetadata(store, row.faction_id, row.ability_id, campaignRefs, metadata))), ...evidenceNodes]
  const availableNodeIds = new Set([...precedingNodeIds, ...evidenceNodes.map(node => node.id)])
  const edges = selectedEdges(store, evidenceNodes.map(node => node.id), pageAbilityRows, evidenceNodeIds, availableNodeIds)
  const next = truncated ? cursorEncode({ graph_revision: revision, fingerprint, tuple: pageRows.at(-1).tuple }) : null
  return { graph_revision: revision, root: GLOBAL_ROOT_ID, nodes, edges, page: { next_cursor: next, truncated }, filters: { ...filters, depth } }
}

export function globalGraphUpdates(store, query = {}) {
  const since = Number(query.since)
  if (!Number.isInteger(since) || since < 0) throw new GraphQueryError(400, 'invalid-sequence')
  const mode = query.mode || 'index'
  const filters = { mode, faction_id: query.faction_id || null, ability_id: query.ability_id || null, campaign_id: query.campaign_id || null }
  validateFilters(mode, filters)
  const limit = boundedInteger(query.limit, 100, 250)
  const revision = graphRevision(store)
  const campaignRefs = campaignRefsByNode(store)
  const refs = abilityRefsByNode(store)
  const rows = store.db.prepare('SELECT sequence,node_id,aggregate_id FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(since, limit + 1)
  const pageRows = rows.slice(0, limit)
  const affected = new Map()
  for (const row of pageRows) {
    for (const ref of refs.get(row.node_id) || []) {
      if (mode === 'ability' && (ref.faction_id !== filters.faction_id || ref.ability_id !== filters.ability_id)) continue
      if (mode === 'campaign' && !(campaignRefs.get(row.node_id) || []).includes(filters.campaign_id)) continue
      affected.set(refKey(ref.faction_id, ref.ability_id), { faction_id: ref.faction_id, ability_id: ref.ability_id })
    }
    if (mode !== 'ability') {
      const runId = store.db.prepare('SELECT run_id FROM runs WHERE run_id=? OR campaign_id=?').get(row.aggregate_id, row.aggregate_id)?.run_id
      if (runId) for (const claim of store.db.prepare('SELECT faction_id,ability_id FROM claims WHERE run_id=?').all(runId)) affected.set(refKey(claim.faction_id, claim.ability_id), { ...claim })
    }
  }
  const through = pageRows.length ? Number(pageRows.at(-1).sequence) : since
  return {
    graph_revision: revision,
    through,
    affected_ability_ids: [...affected.values()].sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id)),
    page: { next_cursor: rows.length > limit ? String(through) : null, truncated: rows.length > limit },
    filters,
  }
}

const EFFECT_CHILD_KEYS = ['effect', 'steps', 'options', 'reward', 'on_success', 'on_fail', 'success', 'failure']
const UNSUPPORTED_EFFECT_TYPES = new Set(['unsupported', 'unstructured', 'schema-resistant', 'represented-gap'])

function effectChildren(effect) {
  const children = []
  for (const key of EFFECT_CHILD_KEYS) {
    const value = effect?.[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          if (item.effect && typeof item.effect === 'object') children.push(item.effect)
          else if (typeof item.type === 'string') children.push(item)
        }
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') children.push(value)
  }
  if (effect?.risk?.on_fail && typeof effect.risk.on_fail === 'object') children.push(effect.risk.on_fail)
  return children
}

export function normalizedEffectSignature(effect) {
  return canonicalJson(normalizeValue(effect))
}

function effectMetrics(effect) {
  const leaves = []
  let maxDepth = 0
  let containerCount = 0
  let unsupportedShapeCount = 0
  const visit = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth)
    const children = effectChildren(node)
    if (UNSUPPORTED_EFFECT_TYPES.has(String(node?.type || ''))) unsupportedShapeCount += 1
    if (children.length) {
      containerCount += 1
      for (const child of children) visit(child, depth + 1)
    } else leaves.push(normalizedEffectSignature(node))
  }
  visit(effect, 1)
  return { leaves, max_depth: maxDepth, container_count: containerCount, unsupported_shape_count: unsupportedShapeCount }
}

function comparePriorities(left, right) {
  return left.bucket - right.bucket
    || (left.bucket === 3 ? right.certified_coverage_ratio - left.certified_coverage_ratio : 0)
    || right.repeat_count - left.repeat_count
    || left.uncertified_leaf_count - right.uncertified_leaf_count
    || left.leaf_count - right.leaf_count
    || left.max_depth - right.max_depth
    || left.faction_id.localeCompare(right.faction_id)
    || left.ability_id.localeCompare(right.ability_id)
}

export function rankMechanicCandidates(candidates, {
  active_claims = [],
  certified_abilities = [],
  source_unavailable = [],
  represented_gaps = [],
} = {}) {
  const active = new Set(active_claims)
  const certified = new Set(certified_abilities)
  const unavailable = new Set(source_unavailable)
  const gaps = new Set(represented_gaps)
  const measured = candidates.map(candidate => {
    const metrics = effectMetrics(candidate.effect)
    return { ...candidate, ...metrics, key: `${candidate.faction_id}/${candidate.ability_id}` }
  })
  const certifiedLeafSignatures = new Set(measured.filter(candidate => certified.has(candidate.key)).flatMap(candidate => candidate.leaves))
  const repeats = new Map()
  for (const candidate of measured) for (const signature of new Set(candidate.leaves)) repeats.set(signature, (repeats.get(signature) || 0) + 1)
  const eligible = []
  const excluded = []
  for (const candidate of measured) {
    let exclusion_reason = null
    if (active.has(candidate.key)) exclusion_reason = 'active-claim-or-lease'
    else if (certified.has(candidate.key)) exclusion_reason = 'already-certified'
    else if (unavailable.has(candidate.key) || candidate.source_available === false) exclusion_reason = 'source-unavailable'
    const certifiedLeafCount = candidate.leaves.filter(signature => certifiedLeafSignatures.has(signature)).length
    const leafCount = candidate.leaves.length
    const unsupportedShapeCount = candidate.unsupported_shape_count + (gaps.has(candidate.key) || candidate.schema_resistant ? 1 : 0)
    const repeatCount = Math.max(0, ...candidate.leaves.map(signature => repeats.get(signature) || 0))
    const uncertifiedLeafCount = leafCount - certifiedLeafCount
    const certifiedCoverageRatio = leafCount ? certifiedLeafCount / leafCount : 0
    let bucket
    if (leafCount === 1 && unsupportedShapeCount === 0 && repeatCount > 1) bucket = 1
    else if (leafCount > 1 && uncertifiedLeafCount === 0) bucket = 2
    else if (unsupportedShapeCount > 0) bucket = 4
    else bucket = 3
    const feature = {
      faction_id: candidate.faction_id,
      ability_id: candidate.ability_id,
      mechanic_signature: normalizedEffectSignature(candidate.effect),
      leaf_signatures: [...candidate.leaves],
      leaf_count: leafCount,
      max_depth: candidate.max_depth,
      container_count: candidate.container_count,
      unsupported_shape_count: unsupportedShapeCount,
      repeat_count: repeatCount,
      certified_leaf_count: certifiedLeafCount,
      uncertified_leaf_count: uncertifiedLeafCount,
      certified_coverage_ratio: certifiedCoverageRatio,
      bucket,
      exclusion_reason,
    }
    if (exclusion_reason) excluded.push(feature)
    else eligible.push(feature)
  }
  eligible.sort(comparePriorities)
  excluded.sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
  return { eligible, excluded }
}

function repositoryAbilities(repoRoot) {
  const root = join(repoRoot, 'data', 'enrichment')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = join(root, entry.name, 'abilities.json')
      if (!existsSync(path)) return []
      return JSON.parse(readFileSync(path, 'utf8')).map(ability => ({
        faction_id: entry.name,
        ability_id: ability.ability_id,
        effect: ability.effect,
      })).filter(ability => typeof ability.ability_id === 'string' && ability.effect && typeof ability.effect === 'object')
    })
}

function activeLeaseAbilityKeys(store, now = Date.now()) {
  const keys = []
  const leases = store.db.prepare("SELECT leases.run_id,leases.payload_json FROM leases JOIN runs USING(run_id) WHERE leases.state='active' AND runs.state NOT IN ('completed','aborted','superseded','failed-final')").all()
  for (const lease of leases) {
    const payload = JSON.parse(lease.payload_json || '{}')
    const expiry = Date.parse(payload.lease_expires_at || payload.expires_at || '')
    if (!Number.isFinite(expiry) || expiry <= now || typeof payload.task_id !== 'string' || typeof payload.attempt_id !== 'string') continue
    const task = store.db.prepare("SELECT payload_json FROM tasks WHERE id=? AND run_id=? AND state IN ('ready','running')").get(payload.task_id, lease.run_id)
    const attempt = store.db.prepare("SELECT 1 FROM attempts WHERE id=? AND run_id=? AND state IN ('allocated','running')").get(payload.attempt_id, lease.run_id)
    if (!task || !attempt) continue
    const taskPayload = JSON.parse(task.payload_json || '{}').payload ?? {}
    if (typeof taskPayload.faction_id === 'string' && typeof taskPayload.ability_id === 'string') keys.push(`${taskPayload.faction_id}/${taskPayload.ability_id}`)
  }
  return keys
}

export function wholeGraphPriorities(store, { repoRoot, candidates = null } = {}) {
  const activeClaims = store.db.prepare("SELECT faction_id,ability_id FROM claims WHERE state='active' ORDER BY faction_id,ability_id").all()
    .map(row => `${row.faction_id}/${row.ability_id}`)
  const states = store.db.prepare('SELECT id,state FROM ability_evidence ORDER BY id').all()
  const certified = states.filter(row => row.state === 'certified').map(row => row.id)
  const unavailable = states.filter(row => row.state === 'source-unavailable').map(row => row.id)
  const gaps = states.filter(row => ['represented-gap', 'refuted', 'needs-schema'].includes(row.state)).map(row => row.id)
  return rankMechanicCandidates(candidates || repositoryAbilities(repoRoot), {
    active_claims: [...new Set([...activeClaims, ...activeLeaseAbilityKeys(store)])],
    certified_abilities: certified,
    source_unavailable: unavailable,
    represented_gaps: gaps,
  })
}

function canonicalFacetFilter(value) {
  if (value === undefined || value === null || value === '') return null
  return canonicalizeMechanicFacetValue(value)
}

function requestedBoolean(value, name) {
  if (value === undefined || value === null || value === '') return false
  if (['true', '1', true, 1].includes(value)) return true
  if (['false', '0', false, 0].includes(value)) return false
  throw new GraphQueryError(400, `invalid-${name}`)
}

function claimQueryFilters(query = {}, unresolved = false) {
  const subjectRef = query.subject_ref || (
    query.faction_id || query.ability_id
      ? `ability:${query.faction_id || ''}/${query.ability_id || ''}`
      : null
  )
  if ((query.faction_id && !query.ability_id) || (!query.faction_id && query.ability_id)) {
    throw new GraphQueryError(400, 'subject-filter-incomplete')
  }
  const filters = {
    subject_ref: subjectRef,
    lifecycle_state: query.lifecycle_state || query.state || null,
    proposition_schema_id: query.proposition_schema_id || query.schema_id || null,
    predicate: query.predicate || null,
    actor: canonicalFacetFilter(query.actor),
    affected_entity: canonicalFacetFilter(query.affected_entity),
    event: canonicalFacetFilter(query.event),
    duration: canonicalFacetFilter(query.duration),
    threshold: query.threshold === undefined || query.threshold === null || query.threshold === ''
      ? null
      : Number.isInteger(Number(query.threshold)) ? Number(query.threshold)
        : (() => { throw new GraphQueryError(400, 'invalid-threshold-filter') })(),
    has_precondition: query.has_precondition === undefined || query.has_precondition === null || query.has_precondition === ''
      ? null
      : ['true', '1', true, 1].includes(query.has_precondition) ? 1
        : ['false', '0', false, 0].includes(query.has_precondition) ? 0
          : (() => { throw new GraphQueryError(400, 'invalid-precondition-filter') })(),
    semantic_key: query.semantic_key || null,
    origin_id: query.origin_id || null,
    origin_kind: query.origin_kind || null,
    origin_current_state: query.origin_current_state || null,
    include_history: !unresolved && requestedBoolean(query.include_history, 'include-history'),
    unresolved_kind: unresolved ? (query.kind || query.unresolved_kind || null) : null,
    obligation: unresolved ? (query.obligation || null) : null,
    resolution_state: unresolved ? (query.resolution_state || null) : null,
  }
  if (filters.lifecycle_state && !['proposed', 'accepted', 'contradicted', 'superseded', 'invalidated'].includes(filters.lifecycle_state)) {
    throw new GraphQueryError(400, 'invalid-lifecycle-state')
  }
  if (filters.unresolved_kind && !['ambiguous', 'unsupported', 'contradictory', 'incomplete_source', 'ontology_gap', 'awaiting_evidence'].includes(filters.unresolved_kind)) {
    throw new GraphQueryError(400, 'invalid-unresolved-kind')
  }
  if (filters.resolution_state && !['open', 'resolved', 'waived'].includes(filters.resolution_state)) {
    throw new GraphQueryError(400, 'invalid-resolution-state')
  }
  if (filters.origin_kind && !['primary-source', 'ability-dsl', 'generated-render', 'cruncher-projection', 'historical-artifact', 'review'].includes(filters.origin_kind)) {
    throw new GraphQueryError(400, 'invalid-origin-kind')
  }
  if (filters.origin_current_state && !['current', 'stale', 'historical'].includes(filters.origin_current_state)) {
    throw new GraphQueryError(400, 'invalid-origin-current-state')
  }
  return filters
}

function safeBinding(row) {
  const binding = {
    binding_id: row.binding_id,
    kind: row.kind,
    origin_id: row.origin_id,
  }
  if (row.kind === 'source_span') {
    binding.start_byte = row.start_byte
    binding.end_byte = row.end_byte
    binding.coordinate_unit = 'utf8_byte'
  } else if (row.kind === 'structured_path') {
    binding.path_kind = row.path_kind
    binding.path = row.path
  } else if (row.kind === 'private_source_ref') {
    binding.private_locator_hash = row.private_locator_hash
    binding.locator_authority = row.locator_authority
  } else if (row.kind === 'derived_evidence') {
    binding.derivation_rule_id = row.derivation_rule_id
    binding.derivation_rule_version = row.derivation_rule_version
  }
  return binding
}

function evidenceForAssertions(store, assertionIds) {
  if (!assertionIds.length) return []
  const placeholders = assertionIds.map(() => '?').join(',')
  return store.db.prepare(`
    SELECT cae.assertion_id,b.binding_id,b.kind,b.origin_id,b.start_byte,b.end_byte,
      b.path_kind,b.path,b.private_locator_hash,b.locator_authority,b.derivation_rule_id,b.derivation_rule_version
    FROM claim_assertion_evidence cae
    JOIN claim_evidence_bindings b ON b.binding_id=cae.binding_id
    WHERE cae.assertion_id IN (${placeholders})
    ORDER BY cae.assertion_id,b.binding_id
  `).all(...assertionIds)
}

function paginateClaimRows(store, query, { unresolved = false } = {}) {
  const filters = claimQueryFilters(query, unresolved)
  const revision = graphRevision(store)
  const fingerprint = sha256(canonicalJson({ type: unresolved ? 'unresolved' : 'claims', filters }))
  const after = cursorDecode(query.after, revision, fingerprint)
  const limit = boundedInteger(query.limit, 100, 250)
  const conditions = []
  const args = []
  const add = (sql, value) => { conditions.push(sql); args.push(value) }
  const subjectColumn = unresolved ? 'COALESCE(o.subject_ref,cs.subject_ref)' : 'o.subject_ref'
  if (filters.subject_ref) add(`${subjectColumn}=?`, filters.subject_ref)
  if (filters.lifecycle_state && !unresolved) add('o.state=?', filters.lifecycle_state)
  if (filters.proposition_schema_id) add('s.proposition_schema_id=?', filters.proposition_schema_id)
  if (filters.predicate) add('f.predicate=?', filters.predicate)
  if (filters.actor !== null) add('f.actor=?', filters.actor)
  if (filters.affected_entity !== null) add('f.affected_entity=?', filters.affected_entity)
  if (filters.event !== null) add('f.event=?', filters.event)
  if (filters.duration !== null) add('f.duration=?', filters.duration)
  if (filters.has_precondition !== null) add('f.has_precondition=?', filters.has_precondition)
  if (filters.threshold !== null) add('f.threshold=?', filters.threshold)
  if (filters.semantic_key) add('s.semantic_key=?', filters.semantic_key)
  if (filters.origin_id) add(unresolved ? 'e.origin_id=?' : 'o.origin_id=?', filters.origin_id)
  if (filters.origin_kind) add('origin.origin_kind=?', filters.origin_kind)
  if (filters.origin_current_state) add('origin.current_state=?', filters.origin_current_state)
  if (filters.unresolved_kind) add('u.kind=?', filters.unresolved_kind)
  if (filters.resolution_state) add('u.resolution_state=?', filters.resolution_state)
  if (filters.obligation) add("EXISTS (SELECT 1 FROM json_each(u.blocks_obligations_json) WHERE value=?)", filters.obligation)
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = unresolved
    ? `SELECT DISTINCT u.unresolved_key,u.kind,u.focus_json,u.blocks_obligations_json,u.resolution_state,u.extraction_id,
        e.origin_id,origin.origin_kind,origin.current_state AS origin_current_state,
        COALESCE(o.subject_ref,cs.subject_ref,origin.subject_ref) AS subject_ref
      FROM claim_unresolved u
      JOIN claim_extractions e ON e.extraction_id=u.extraction_id
      JOIN claim_origins origin ON origin.origin_id=e.origin_id
      LEFT JOIN claim_sets cs ON cs.origin_id=e.origin_id AND cs.adapter_id=e.adapter_id
      LEFT JOIN claim_unresolved_candidates uc ON uc.unresolved_key=u.unresolved_key
      LEFT JOIN semantic_claims s ON s.semantic_key=uc.candidate_semantic_key
      LEFT JOIN claim_occurrences o ON o.semantic_key=uc.candidate_semantic_key AND o.origin_id=e.origin_id
      LEFT JOIN mechanic_claim_facets f ON f.claim_occurrence_id=o.claim_occurrence_id
      ${where}`
    : `SELECT o.claim_occurrence_id,o.origin_id,origin.origin_kind,origin.current_state AS origin_current_state,
        o.subject_ref,o.state,o.semantic_key,
        s.adapter_id,s.proposition_schema_id,s.proposition_schema_version,s.identity_ontology_version,
        s.polarity,s.modality,s.proposition_json,f.predicate,f.actor,f.affected_entity,f.event,f.duration,
        f.threshold,f.has_precondition
      FROM claim_occurrences o
      JOIN claim_origins origin ON origin.origin_id=o.origin_id
      JOIN semantic_claims s ON s.semantic_key=o.semantic_key
      LEFT JOIN mechanic_claim_facets f ON f.claim_occurrence_id=o.claim_occurrence_id
      ${where}`
  const id = unresolved ? 'unresolved_key' : 'claim_occurrence_id'
  const rows = store.db.prepare(`${sql} ORDER BY ${unresolved ? 'u' : 'o'}.${id}`).all(...args)
    .map(row => ({ ...row, tuple: [row[id]] }))
    .filter(row => !after || compareTuple(row.tuple, after) > 0)
  const pageRows = rows.slice(0, limit)
  return { filters, revision, fingerprint, rows, pageRows, id }
}

function decodedFacet(value) {
  if (typeof value !== 'string' || !['{', '['].includes(value[0])) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function queryClaims(store, query = {}) {
  const page = paginateClaimRows(store, query)
  const includeHistory = page.filters.include_history || (page.filters.lifecycle_state && page.filters.lifecycle_state !== 'accepted')
  const assertionRows = page.pageRows.length
    ? store.db.prepare(`SELECT assertion_id,claim_occurrence_id,decision_state,independence_group_id FROM claim_assertions WHERE ${includeHistory ? '1=1' : "decision_state='accepted'"} AND claim_occurrence_id IN (${page.pageRows.map(() => '?').join(',')}) ORDER BY claim_occurrence_id,assertion_id`)
      .all(...page.pageRows.map(row => row.claim_occurrence_id))
    : []
  const assertionsByOccurrence = new Map()
  for (const row of assertionRows) {
    const assertions = assertionsByOccurrence.get(row.claim_occurrence_id) || []
    assertions.push(row)
    assertionsByOccurrence.set(row.claim_occurrence_id, assertions)
  }
  const bindingsByAssertion = new Map()
  for (const row of evidenceForAssertions(store, assertionRows.map(row => row.assertion_id))) {
    const bindings = bindingsByAssertion.get(row.assertion_id) || []
    bindings.push(safeBinding(row))
    bindingsByAssertion.set(row.assertion_id, bindings)
  }
  const occurrenceIds = page.pageRows.map(row => row.claim_occurrence_id)
  const membershipsByOccurrence = new Map()
  const relationsByOccurrence = new Map()
  if (occurrenceIds.length) {
    const placeholders = occurrenceIds.map(() => '?').join(',')
    for (const row of store.db.prepare(`
      SELECT claim_occurrence_id,claim_set_id,member_state
      FROM claim_set_members
      WHERE claim_occurrence_id IN (${placeholders})
      ORDER BY claim_occurrence_id,claim_set_id,member_state
    `).all(...occurrenceIds)) {
      const memberships = membershipsByOccurrence.get(row.claim_occurrence_id) || []
      memberships.push({ claim_set_id: row.claim_set_id, member_state: row.member_state })
      membershipsByOccurrence.set(row.claim_occurrence_id, memberships)
    }
    for (const row of store.db.prepare(`
      SELECT r.relation_id,r.source_occurrence_id,r.target_occurrence_id,
        source.origin_id AS source_origin_id,target.origin_id AS target_origin_id,r.relation_type
      FROM claim_relations r
      JOIN claim_occurrences source ON source.claim_occurrence_id=r.source_occurrence_id
      JOIN claim_occurrences target ON target.claim_occurrence_id=r.target_occurrence_id
      WHERE r.source_occurrence_id IN (${placeholders})
         OR r.target_occurrence_id IN (${placeholders})
      ORDER BY r.relation_id
    `).all(...occurrenceIds, ...occurrenceIds)) {
      for (const direction of ['source', 'target']) {
        const occurrenceId = row[`${direction}_occurrence_id`]
        if (!occurrenceIds.includes(occurrenceId)) continue
        const other = direction === 'source' ? 'target' : 'source'
        const relations = relationsByOccurrence.get(occurrenceId) || []
        relations.push({
          relation_id: row.relation_id,
          direction,
          type: row.relation_type,
          other_occurrence_id: row[`${other}_occurrence_id`],
          other_origin_id: row[`${other}_origin_id`],
        })
        relationsByOccurrence.set(occurrenceId, relations)
      }
    }
  }
  const claims = page.pageRows.map(row => {
    const assertions = assertionsByOccurrence.get(row.claim_occurrence_id) || []
    const acceptedEvidence = assertions
      .filter(assertion => assertion.decision_state === 'accepted')
      .flatMap(assertion => bindingsByAssertion.get(assertion.assertion_id) || [])
    return {
      claim_occurrence_id: row.claim_occurrence_id,
      semantic_key: row.semantic_key,
      origin_id: row.origin_id,
      origin_kind: row.origin_kind,
      origin_current_state: row.origin_current_state,
      subject_ref: row.subject_ref,
      lifecycle_state: row.state,
      adapter_id: row.adapter_id,
      proposition: JSON.parse(row.proposition_json),
      polarity: row.polarity,
      modality: row.modality,
      mechanic_facets: row.predicate ? {
        predicate: row.predicate, actor: decodedFacet(row.actor), affected_entity: decodedFacet(row.affected_entity),
        event: decodedFacet(row.event), duration: decodedFacet(row.duration), threshold: row.threshold,
        has_precondition: Boolean(row.has_precondition),
      } : null,
      memberships: membershipsByOccurrence.get(row.claim_occurrence_id) || [],
      independence_group_ids: [...new Set(assertions.map(assertion => assertion.independence_group_id))].sort(),
      relations: relationsByOccurrence.get(row.claim_occurrence_id) || [],
      evidence: acceptedEvidence,
      assertions: assertions.map(assertion => ({
        assertion_id: assertion.assertion_id,
        decision_state: assertion.decision_state,
        evidence: bindingsByAssertion.get(assertion.assertion_id) || [],
      })),
    }
  })
  const truncated = page.rows.length > claims.length
  return {
    graph_revision: page.revision,
    claims,
    page: {
      next_cursor: truncated ? cursorEncode({ graph_revision: page.revision, fingerprint: page.fingerprint, tuple: page.pageRows.at(-1).tuple }) : null,
      truncated,
    },
    filters: page.filters,
  }
}

export function queryUnresolved(store, query = {}) {
  const page = paginateClaimRows(store, query, { unresolved: true })
  const evidenceByUnresolved = new Map()
  if (page.pageRows.length) {
    const placeholders = page.pageRows.map(() => '?').join(',')
    for (const row of store.db.prepare(`
      SELECT ue.unresolved_key,b.binding_id,b.kind,b.origin_id,b.start_byte,b.end_byte,
        b.path_kind,b.path,b.private_locator_hash,b.locator_authority,b.derivation_rule_id,b.derivation_rule_version
      FROM claim_unresolved_evidence ue JOIN claim_evidence_bindings b ON b.binding_id=ue.binding_id
      WHERE ue.unresolved_key IN (${placeholders}) ORDER BY ue.unresolved_key,b.binding_id
    `).all(...page.pageRows.map(row => row.unresolved_key))) {
      const evidence = evidenceByUnresolved.get(row.unresolved_key) || []
      evidence.push(safeBinding(row))
      evidenceByUnresolved.set(row.unresolved_key, evidence)
    }
  }
  const unresolved = page.pageRows.map(row => ({
    unresolved_key: row.unresolved_key,
    extraction_id: row.extraction_id,
    origin_id: row.origin_id,
    origin_kind: row.origin_kind,
    origin_current_state: row.origin_current_state,
    subject_ref: row.subject_ref,
    kind: row.kind,
    focus: JSON.parse(row.focus_json),
    blocks_obligations: JSON.parse(row.blocks_obligations_json),
    resolution_state: row.resolution_state,
    evidence: evidenceByUnresolved.get(row.unresolved_key) || [],
  }))
  const truncated = page.rows.length > unresolved.length
  return {
    graph_revision: page.revision,
    unresolved,
    page: {
      next_cursor: truncated ? cursorEncode({ graph_revision: page.revision, fingerprint: page.fingerprint, tuple: page.pageRows.at(-1).tuple }) : null,
      truncated,
    },
    filters: page.filters,
  }
}
