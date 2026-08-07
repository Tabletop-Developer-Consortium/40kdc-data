import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseConstructionPlan, normalizeMechanicSignature, rankMechanicCandidates, retrieveEvidence, validateCandidateClaimCoverage, validateCoveredClaimOccurrenceIds } from './retrieval.js'

const signature = { actor: 'bearer', affected_entity: 'enemy unit', event: 'attack', producer_ports: ['source'], consumer_ports: ['target'], polarity: 'positive', quantifier: 'each', timing: 'during attack', duration: 'instant', scope: 'visible', ordering: 'before roll', restrictions: ['ranged'], exclusions: [] }
const claimSetId = 's'.repeat(64)
const representAuthorization = { status: 'full', obligation: 'represent', claim_set_id: claimSetId }

test('signature normalization is stable and covers every dimension', () => {
  const one = normalizeMechanicSignature(signature)
  const two = normalizeMechanicSignature({ ...signature, restrictions: ['RANGED'] })
  assert.deepEqual(one, two)
  assert.equal(Object.keys(one.signature).length, 13)
})

test('exact evidence outranks substitution and discovery', () => {
  const matches = retrieveEvidence({ target_signature: signature, target_claim_occurrence_ids: ['c1'], candidates: [
    { node_id: 'c'.repeat(64), status: 'certified', current: true, signature: { ...signature, scope: 'within region' }, discovery_kind: 'embedding-llm-discovery' },
    { node_id: 'b'.repeat(64), status: 'certified', current: true, signature: { ...signature, actor: 'friendly bearer' }, admissible_substitutions: { actor: [{ from: 'friendly bearer', to: 'bearer' }] }, covers_claim_occurrence_ids: ['c1'] },
    { node_id: 'a'.repeat(64), status: 'certified', current: true, signature, covers_claim_occurrence_ids: ['c1'] },
  ] })
  assert.deepEqual(matches.map(match => match.match_type), ['exact-family-instance', 'admissible-family-substitution', 'embedding-llm-discovery'])
  assert.deepEqual(matches[2].covers_claim_occurrence_ids, [])
  assert.ok(matches[2].rejected_reason)
})

test('incompatible bindings and primitive discovery never cover occurrences', () => {
  const matches = retrieveEvidence({ target_signature: signature, target_claim_occurrence_ids: ['c1'], candidates: [
    { node_id: 'a'.repeat(64), status: 'certified', current: true, signature: { ...signature, quantifier: 'one' }, discovery_kind: 'primitive-discovery' },
    { node_id: 'b'.repeat(64), status: 'provisional', current: true, signature },
  ] })
  assert.ok(matches.every(match => match.covers_claim_occurrence_ids.length === 0))
})

test('construction plan records occurrence ownership, substitutions, and seams', () => {
  const claims = [{ claim_occurrence_id: 'c1' }, { claim_occurrence_id: 'c2' }]
  const matches = [
    { evidence_node_id: 'a', match_type: 'exact-family-instance', covers_claim_occurrence_ids: ['c1'], bindings: [], rejected_reason: null },
    { evidence_node_id: 'b', match_type: 'admissible-family-substitution', covers_claim_occurrence_ids: ['c2'], bindings: [{ field: 'actor', from: 'unit', to: 'bearer' }], rejected_reason: null },
    { evidence_node_id: 'c', match_type: 'primitive-discovery', covers_claim_occurrence_ids: [], bindings: [], rejected_reason: 'discovery only' },
  ]
  const plan = chooseConstructionPlan({ faction_id: 'fixture', ability_id: 'ability', claim_set_id: claimSetId, source_claims: claims, matches, authorization: representAuthorization, required_checks: ['schema'] })
  assert.deepEqual(plan.covered_claim_occurrence_ids.sort(), ['c1', 'c2'])
  assert.deepEqual(plan.unmatched_claim_occurrence_ids, [])
  assert.equal(plan.substitutions.length, 1)
  assert.equal(plan.composition_seams.length, 1)
  assert.equal(plan.rejected_conflicts.length, 1)
})
test('construction plans reject missing or wrong-obligation authorization', () => {
  const input = { faction_id: 'fixture', ability_id: 'ability', claim_set_id: claimSetId, source_claims: [{ claim_occurrence_id: 'c1' }], matches: [] }
  assert.throws(() => chooseConstructionPlan(input), /requires full represent authorization/)
  assert.throws(() => chooseConstructionPlan({ ...input, authorization: { ...representAuthorization, obligation: 'retrieve' } }), /requires full represent authorization/)
})


test('candidate coverage rejects omitted or foreign occurrences before representation acceptance', () => {
  const source_claims = [{ claim_occurrence_id: 'c1' }, { claim_occurrence_id: 'c2' }]
  const plan = {
    state: 'ready',
    covered_claim_occurrence_ids: ['c1', 'c2'],
    unmatched_claim_occurrence_ids: [],
    composition_seams: [{ left: 'one', right: 'two', after_claim_occurrence_id: 'c1', before_claim_occurrence_id: 'c2' }],
  }
  const input = {
    source_claims, plan, current_claim_occurrence_ids: ['c1', 'c2'],
    composition_seams: plan.composition_seams,
  }
  assert.equal(validateCandidateClaimCoverage({ ...input, covered_claim_occurrence_ids: ['c1'] }).reason, 'candidate-coverage-not-exact')
  assert.equal(validateCandidateClaimCoverage({ ...input, covered_claim_occurrence_ids: ['c1', 'foreign'] }).reason, 'foreign-covered-claim-occurrence-id')
  assert.equal(validateCandidateClaimCoverage({ ...input, covered_claim_occurrence_ids: ['c1', 'c2'] }).ok, true)
})

test('coverage rejects foreign, overlapping, and non-contiguous occurrence ownership', () => {
  assert.equal(validateCoveredClaimOccurrenceIds(['c1', 'c2', 'c3'], ['c1', 'foreign']).reason, 'foreign-covered-claim-occurrence-id')
  assert.equal(validateCoveredClaimOccurrenceIds(['c1', 'c2', 'c3'], ['c1', 'c3']).reason, 'covered-claim-occurrences-non-contiguous')
  const plan = chooseConstructionPlan({
    faction_id: 'fixture', ability_id: 'ability', claim_set_id: claimSetId,
    authorization: representAuthorization,
    source_claims: [{ claim_occurrence_id: 'c1' }, { claim_occurrence_id: 'c2' }],
    matches: [
      { evidence_node_id: 'a', match_type: 'exact-family-instance', covers_claim_occurrence_ids: ['c1', 'c2'], bindings: [], rejected_reason: null },
      { evidence_node_id: 'b', match_type: 'exact-family-instance', covers_claim_occurrence_ids: ['c2'], bindings: [], rejected_reason: null },
    ],
  })
  assert.deepEqual(plan.selected_evidence_node_ids, ['a'])
})

test('blocked represent obligation prevents a ready construction plan', () => {
  const plan = chooseConstructionPlan({
    faction_id: 'fixture', ability_id: 'ability', claim_set_id: claimSetId,
    authorization: representAuthorization,
    source_claims: [{ claim_occurrence_id: 'c1' }],
    matches: [{ evidence_node_id: 'a', match_type: 'exact-family-instance', covers_claim_occurrence_ids: ['c1'], bindings: [], rejected_reason: null }],
    unresolved: [{ unresolved_key: 'u1', resolution_state: 'open', blocks_obligations: ['represent'] }],
  })
  assert.equal(plan.state, 'blocked')
  assert.deepEqual(plan.blocking_unresolved_keys, ['u1'])
})

test('more than twenty valid candidates fails instead of truncating', () => {
  const matches = Array.from({ length: 21 }, (_, index) => ({
    evidence_node_id: `node-${index.toString().padStart(2, '0')}`,
    match_type: 'exact-family-instance',
    covers_claim_occurrence_ids: ['c1'],
    bindings: [],
    rejected_reason: null,
  }))
  assert.throws(() => chooseConstructionPlan({
    faction_id: 'fixture', ability_id: 'ability', claim_set_id: claimSetId, source_claims: [{ claim_occurrence_id: 'c1' }], matches, authorization: representAuthorization,
  }), /construction-plan-candidate-limit-exceeded: 21 > 20/)
})

test('whole-graph ranking advances repeated primitives then certified-precedent compounds', () => {
  const sustained = { type: 'keyword-grant', target: 'unit', modifier: { keyword: 'Sustained Hits 1' } }
  const ward = { type: 'invulnerable-save', target: 'unit', modifier: { invuln_sv: 5 } }
  const candidates = [
    { faction_id: 'fixture-a', ability_id: 'sustained-certified', effect: sustained },
    { faction_id: 'fixture-b', ability_id: 'sustained-open', effect: sustained },
    { faction_id: 'fixture-c', ability_id: 'ward-certified', effect: ward },
    { faction_id: 'fixture-d', ability_id: 'compound-open', effect: { type: 'sequence', steps: [sustained, ward] } },
    { faction_id: 'fixture-e', ability_id: 'resistant-open', effect: { type: 'schema-resistant', target: 'unit' }, schema_resistant: true },
  ]
  const ranked = rankMechanicCandidates(candidates, {
    certified_abilities: ['fixture-a/sustained-certified', 'fixture-c/ward-certified'],
  })
  assert.deepEqual(ranked.eligible.map(item => item.ability_id), ['sustained-open', 'compound-open', 'resistant-open'])
  assert.deepEqual(ranked.eligible.map(item => item.bucket), [1, 2, 4])
  const compound = ranked.eligible[1]
  assert.equal(compound.leaf_count, 2)
  assert.equal(compound.max_depth, 2)
  assert.equal(compound.container_count, 1)
  assert.equal(compound.certified_leaf_count, 2)
  assert.equal(compound.uncertified_leaf_count, 0)
  assert.equal(compound.certified_coverage_ratio, 1)
  for (const field of ['mechanic_signature', 'repeat_count', 'unsupported_shape_count', 'exclusion_reason']) assert.ok(Object.hasOwn(compound, field))
})

test('active c005-shaped claims and source-unavailable candidates never enter the worklist', () => {
  const candidates = [
    { faction_id: 'aeldari', ability_id: 'far-reaching-doom', effect: { type: 'damage-reduction', target: 'unit', modifier: { amount: 1 } } },
    { faction_id: 'fixture', ability_id: 'source-missing', effect: { type: 'invulnerable-save', target: 'unit', modifier: { invuln_sv: 5 } } },
    { faction_id: 'fixture', ability_id: 'eligible', effect: { type: 'invulnerable-save', target: 'unit', modifier: { invuln_sv: 5 } } },
  ]
  const ranked = rankMechanicCandidates(candidates, {
    active_claims: ['aeldari/far-reaching-doom'],
    source_unavailable: ['fixture/source-missing'],
  })
  assert.deepEqual(ranked.eligible.map(item => item.ability_id), ['eligible'])
  assert.deepEqual(ranked.excluded.map(item => [item.ability_id, item.exclusion_reason]), [
    ['far-reaching-doom', 'active-claim-or-lease'],
    ['source-missing', 'source-unavailable'],
  ])
})
