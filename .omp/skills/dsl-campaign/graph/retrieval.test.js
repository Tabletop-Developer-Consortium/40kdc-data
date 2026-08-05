import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseConstructionPlan, normalizeMechanicSignature, rankMechanicCandidates, retrieveEvidence } from './retrieval.js'

const signature = { actor: 'bearer', affected_entity: 'enemy unit', event: 'attack', producer_ports: ['source'], consumer_ports: ['target'], polarity: 'positive', quantifier: 'each', timing: 'during attack', duration: 'instant', scope: 'visible', ordering: 'before roll', restrictions: ['ranged'], exclusions: [] }

test('signature normalization is stable and covers every dimension', () => {
  const one = normalizeMechanicSignature(signature)
  const two = normalizeMechanicSignature({ ...signature, restrictions: ['RANGED'] })
  assert.deepEqual(one, two)
  assert.equal(Object.keys(one.signature).length, 13)
})

test('exact evidence outranks substitution and discovery', () => {
  const matches = retrieveEvidence({ target_signature: signature, target_claim_ids: ['c1'], candidates: [
    { node_id: 'c'.repeat(64), status: 'certified', current: true, signature: { ...signature, scope: 'within region' }, discovery_kind: 'embedding-llm-discovery' },
    { node_id: 'b'.repeat(64), status: 'certified', current: true, signature: { ...signature, actor: 'friendly bearer' }, admissible_substitutions: { actor: [{ from: 'friendly bearer', to: 'bearer' }] } },
    { node_id: 'a'.repeat(64), status: 'certified', current: true, signature },
  ] })
  assert.deepEqual(matches.map(match => match.match_type), ['exact-family-instance', 'admissible-family-substitution', 'embedding-llm-discovery'])
  assert.deepEqual(matches[2].covers_claim_ids, [])
  assert.ok(matches[2].rejected_reason)
})

test('incompatible bindings and primitive discovery never cover claims', () => {
  const matches = retrieveEvidence({ target_signature: signature, target_claim_ids: ['c1'], candidates: [
    { node_id: 'a'.repeat(64), status: 'certified', current: true, signature: { ...signature, quantifier: 'one' }, discovery_kind: 'primitive-discovery' },
    { node_id: 'b'.repeat(64), status: 'provisional', current: true, signature },
  ] })
  assert.ok(matches.every(match => match.covers_claim_ids.length === 0))
})

test('construction plan records unmatched claims, conflicts, substitutions, and seams', () => {
  const claims = [{ id: 'c1' }, { id: 'c2' }]
  const matches = [
    { evidence_node_id: 'a', match_type: 'exact-family-instance', covers_claim_ids: ['c1'], bindings: [], rejected_reason: null },
    { evidence_node_id: 'b', match_type: 'admissible-family-substitution', covers_claim_ids: ['c2'], bindings: [{ field: 'actor', from: 'unit', to: 'bearer' }], rejected_reason: null },
    { evidence_node_id: 'c', match_type: 'primitive-discovery', covers_claim_ids: [], bindings: [], rejected_reason: 'discovery only' },
  ]
  const plan = chooseConstructionPlan({ faction_id: 'fixture', ability_id: 'ability', source_claims: claims, matches, required_checks: ['schema'] })
  assert.deepEqual(plan.covered_claims.sort(), ['c1', 'c2'])
  assert.deepEqual(plan.unmatched_claims, [])
  assert.equal(plan.new_specializations.length, 1)
  assert.equal(plan.composition_seams.length, 1)
  assert.equal(plan.rejected_conflicts.length, 1)
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
