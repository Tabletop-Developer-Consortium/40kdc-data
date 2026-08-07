import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canonicalJson, sha256 } from './canonical.js'
import {
  claimOccurrenceId,
  claimSetId,
  computeInvalidations,
  evidenceBindingId,
  extractionId,
  semanticKey,
  unresolvedKey,
} from './claims.js'
import {
  MECHANIC_ADAPTER_ID,
  MECHANIC_IDENTITY_ONTOLOGY_VERSION,
  MECHANIC_ONTOLOGY_VERSION,
  MECHANIC_PROPOSITION_SCHEMA_ID,
  MECHANIC_PROPOSITION_SCHEMA_VERSION,
  canonicalizeMechanicValue,
  mechanicClaimAdapter,
  mechanicQueryFacets,
} from './mechanic-claims.js'

const fixturePath = new URL('./fixtures/claim-conformance-v1.json', import.meta.url)
const copiedFixturePath = new URL('../../../../../Adversarial-claim-extraction/backend/tests/fixtures/claim-conformance-v1.json', import.meta.url)
const hash = value => sha256(canonicalJson(value))
const assertionId = assertion => hash({
  extraction_id: assertion.extraction_id,
  extraction_local_id: assertion.extraction_local_id,
  claim_occurrence_id: assertion.claim_occurrence_id,
  evidence_binding_ids_sorted: [...assertion.evidence_binding_ids].sort(),
  derivation_parent_claim_occurrence_ids_ordered: assertion.derivation_parent_claim_occurrence_ids,
})

async function loadFixture() {
  const bytes = await readFile(fixturePath)
  return { bytes, fixture: JSON.parse(bytes) }
}

function assertHash(value) {
  assert.match(value, /^[a-f0-9]{64}$/)
}

const nonHashIdentityFields = new Set(['adapter_id', 'agent_contract_id', 'extraction_local_id', 'implementation_id', 'model_id', 'policy_id', 'proposition_schema_id', 'schema_id'])

function assertAllExpectedHashes(value) {
  if (Array.isArray(value)) return value.forEach(assertAllExpectedHashes)
  if (value === null || typeof value !== 'object') return
  for (const [childKey, child] of Object.entries(value)) {
    if (/(?:_id|_key|_sha256)$/.test(childKey) && !nonHashIdentityFields.has(childKey)) assertHash(child)
    assertAllExpectedHashes(child)
  }
}

function expectedInvalidation(change, dependencies) {
  const result = computeInvalidations(change, dependencies)
  return {
    reextract: result.reextract,
    rebuild_adapter_projections: result.rebuild_adapter_projections,
    rebuild_retrieval_and_construction: result.rebuild_retrieval_and_construction,
    recertify_representations: result.recertify_representations,
    reassess: result.reassess,
    invalidated: {
      claim_occurrence_ids: result.invalidated.claim_occurrence_ids,
      claim_set_ids: result.invalidated.claim_set_ids,
      representation_certificate_ids: result.invalidated.representation_certificate_ids,
      assessment_ids: result.invalidated.assessment_ids,
    },
  }
}

test('mechanic registry enforces schema, ordering, and vocabulary', () => {
  const unordered = {
    predicate: 'mechanic.effect.characteristic-modifier',
    arguments: [
      { role: 'target', value: { unit: 'fabricated' } },
      { role: 'operation', value: { add: 1 } },
      { role: 'characteristic', value: 'fabrication' },
    ],
    qualifiers: [
      { kind: 'selection.nearby', value: true },
      { kind: 'selection.friendly', value: true },
    ],
  }
  assert.deepEqual(canonicalizeMechanicValue(unordered), {
    ...unordered,
    arguments: [unordered.arguments[2], unordered.arguments[1], unordered.arguments[0]],
    qualifiers: [unordered.qualifiers[1], unordered.qualifiers[0]],
  })
  assert.throws(() => canonicalizeMechanicValue({ ...unordered, arguments: [unordered.arguments[0], unordered.arguments[0]] }), /duplicate role/)
  assert.throws(() => canonicalizeMechanicValue({ ...unordered, qualifiers: [{ kind: 'unregistered.kind', value: true }] }), /unknown kind/)
  assert.throws(() => mechanicClaimAdapter.validateProposition({ schema_id: MECHANIC_PROPOSITION_SCHEMA_ID, schema_version: '2', value: unordered }), /schema_version/)
  assert.throws(() => canonicalizeMechanicValue({ ...unordered, qualifiers: [{ kind: 'bad_kind', value: true }] }), /kebab-case identifier/)
})

test('query facets are derived annotations rather than proposition identity', () => {
  const value = {
    predicate: 'mechanic.precondition.no-advance',
    arguments: [{ role: 'source-unit', value: 'fabricated-unit' }],
    qualifiers: [{ kind: 'condition.no-advance', value: true }],
  }
  assert.deepEqual(mechanicQueryFacets(value), {
    predicate: 'mechanic.precondition.no-advance', actor: null, affected_entity: null,
    event: null, duration: null, threshold: null, has_precondition: true,
  })
  assert.equal(Object.isFrozen(mechanicQueryFacets(value)), true)
})

test('JSON-valued facets use canonical SQLite-safe bytes', () => {
  const facets = mechanicQueryFacets({
    predicate: 'mechanic.trigger',
    arguments: [{ role: 'actor', value: { unit: 'fabricated', keywords: ['z', 'a'] } }],
    qualifiers: [],
  })
  assert.equal(facets.actor, '{"keywords":["z","a"],"unit":"fabricated"}')
})

test('frozen fixture independently reproduces every JavaScript identity', async () => {
  const { bytes, fixture } = await loadFixture()
  // The top-level SHA excludes only fixture_sha256, preventing self-referential hashing.
  const withoutFixtureHash = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'fixture_sha256'))
  assert.equal(hash(withoutFixtureHash), fixture.fixture_sha256)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(await readFile(copiedFixturePath)).digest('hex'))
  assertAllExpectedHashes(fixture)
  assert.deepEqual(fixture.adapter, {
    adapter_id: MECHANIC_ADAPTER_ID,
    ontology_version: MECHANIC_ONTOLOGY_VERSION,
    identity_ontology_version: MECHANIC_IDENTITY_ONTOLOGY_VERSION,
    proposition_schema_id: MECHANIC_PROPOSITION_SCHEMA_ID,
    proposition_schema_version: MECHANIC_PROPOSITION_SCHEMA_VERSION,
  })
  for (const entry of Object.values(fixture.mechanics)) {
    assert.equal(extractionId(entry.extraction_identity), entry.extraction_id)
    for (const [index, binding] of entry.evidence_bindings.entries()) {
      assert.equal(evidenceBindingId(binding, { origin_id: entry.origin_id, origin_kind: 'primary-source', source_bytes: entry.prose }), entry.assertions[index].evidence_binding_ids[0])
    }
    const accepted = []
    for (const assertion of entry.assertions) {
      assert.equal(semanticKey({ adapter_id: MECHANIC_ADAPTER_ID, proposition: assertion.proposition, polarity: assertion.polarity, modality: assertion.modality }, mechanicClaimAdapter), assertion.semantic_key)
      assert.equal(claimOccurrenceId({ origin_id: entry.origin_id, semantic_key: assertion.semantic_key }), assertion.claim_occurrence_id)
      assert.equal(assertionId(assertion), assertion.assertion_id)
      accepted.push(assertion.claim_occurrence_id)
    }
    assert.equal(claimSetId({ subject_ref: entry === fixture.mechanics.b ? 'ability:fabricated/mechanic-b' : 'ability:fabricated/mechanic-a', origin_id: entry.origin_id, adapter_id: MECHANIC_ADAPTER_ID, ontology_version: 1, accepted_claim_occurrence_ids: accepted, candidate_claim_occurrence_ids: [], open_unresolved_keys: [], completeness: { state: 'complete', obligations_checked: ['represent'] } }), entry.claim_set_id)
  }
  const { unresolved_key, ...unresolved } = fixture.risk_c.unresolved
  assert.equal(unresolvedKey(unresolved), unresolved_key)
  for (const relation of fixture.relations.same_semantics_exact_equivalence) {
    assert.equal(hash({ source_claim_occurrence_id: relation.source_claim_occurrence_id, target_claim_occurrence_id: relation.target_claim_occurrence_id, relation_type: relation.relation_type, decision_node_id: relation.decision_node_id }), relation.relation_id)
  }
  assert.deepEqual(expectedInvalidation({ kind: 'source_snapshot' }, fixture.invalidations.source_snapshot_change.invalidated), fixture.invalidations.source_snapshot_change)
})

test('fixture proves stability, revisions, authorization boundaries, and evaluation partitions', async () => {
  const { fixture } = await loadFixture()
  const { a_t0: a0, a_reordered_resegmented: reordered, a_t1_same_semantics: same, a_t1_changed_duration: changed, b } = fixture.mechanics
  assert.deepEqual(a0.assertions.map(row => row.semantic_key).sort(), reordered.assertions.map(row => row.semantic_key).sort())
  assert.deepEqual(a0.assertions.map(row => row.claim_occurrence_id).sort(), reordered.assertions.map(row => row.claim_occurrence_id).sort())
  assert.equal(a0.claim_set_id, reordered.claim_set_id)
  assert.deepEqual(a0.assertions.map(row => row.semantic_key).sort(), same.assertions.map(row => row.semantic_key).sort())
  assert.notDeepEqual(a0.assertions.map(row => row.claim_occurrence_id).sort(), same.assertions.map(row => row.claim_occurrence_id).sort())
  assert.notEqual(a0.claim_set_id, same.claim_set_id)
  assert.deepEqual(a0.assertions.slice(0, 2).map(row => row.semantic_key), changed.assertions.slice(0, 2).map(row => row.semantic_key))
  assert.notEqual(a0.assertions[2].semantic_key, changed.assertions[2].semantic_key)
  assert.equal(b.assertions.some(row => row.facets.has_precondition), true)
  assert.deepEqual(Object.keys(fixture.partitions).sort(), ['contrast_pairs', 'family_holdout', 'family_train', 'policy_v1', 'policy_v2', 'question_holdout', 'temporal_t0', 'temporal_t1'])
  assert.equal(fixture.expectations.false_authorization.rate, 0)
})
