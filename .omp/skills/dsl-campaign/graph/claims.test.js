import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson, sha256 } from './canonical.js'
import {
  canonicalizeClaimAssertion,
  semanticKey,
  claimOccurrenceId,
  extractionId,
  evidenceBindingId,
  unresolvedKey,
  claimSetId,
  projectClaimSet,
  computeInvalidations,
} from './claims.js'

const id = letter => letter.repeat(64)
const source = id('a')
const occurrence = id('b')
const assertion = id('c')
const binding = id('d')
const adapter = {
  adapter_id: 'test-adapter',
  ontology_version: 1,
  identity_ontology_version: 1,
  canonicalizeProposition(value) {
    return { ...value, labels: [...value.labels].sort() }
  },
}
const proposition = { schema_id: 'test.proposition', schema_version: 1, value: { labels: ['z', 'a'], value: -0 } }
const assertionWire = {
  extraction_local_id: 'one',
  proposition,

  polarity: 'affirms',
  modality: 'asserted',
  evidence_binding_ids: [id('e'), id('d')],
  derivation_parent_claim_occurrence_ids: [id('f'), id('0')],
}

const expectedHash = value => sha256(canonicalJson(value))

function throws(fn, match) {
  assert.throws(fn, { message: new RegExp(match) })
}

test('canonicalizes adapter-owned assertions without changing ordered derivation lineage', () => {
  const value = canonicalizeClaimAssertion(assertionWire, adapter)
  assert.deepEqual(value.evidence_binding_ids, [id('d'), id('e')])
  assert.deepEqual(value.derivation_parent_claim_occurrence_ids, [id('f'), id('0')])
  assert.deepEqual(value.proposition.value.labels, ['a', 'z'])
  throws(() => canonicalizeClaimAssertion({ ...assertionWire, evidence_binding_ids: [id('d'), id('d')] }, adapter), 'duplicates')
  throws(() => canonicalizeClaimAssertion({ ...assertionWire, polarity: 'maybe' }, adapter), 'polarity')
})

test('semantic identity uses canonical JSON, normalizes negative zero, and honors adapter identity version', () => {
  const zero = semanticKey({ adapter_id: 'test-adapter', proposition: { ...proposition, value: { labels: ['a', 'z'], value: 0 } }, polarity: 'affirms', modality: 'asserted' }, adapter)
  const negativeZero = semanticKey({ adapter_id: 'test-adapter', proposition, polarity: 'affirms', modality: 'asserted' }, adapter)
  assert.equal(negativeZero, zero)
  const v2 = { ...adapter, identity_ontology_version: 2 }
  assert.notEqual(negativeZero, semanticKey({ adapter_id: 'test-adapter', proposition, polarity: 'affirms', modality: 'asserted' }, v2))
  throws(() => semanticKey({ adapter_id: 'other', proposition, polarity: 'affirms', modality: 'asserted' }, adapter), 'does not match')
})

test('occurrence and extraction identities have their pinned order semantics', () => {
  const key = semanticKey({ adapter_id: 'test-adapter', proposition, polarity: 'affirms', modality: 'asserted' }, adapter)
  assert.notEqual(claimOccurrenceId({ origin_id: source, semantic_key: key }), claimOccurrenceId({ origin_id: id('9'), semantic_key: key }))
  const base = {
    origin_id: source,
    extractor_contract_version: 1,
    formalization_policy_version: 1,
    normalization_version: 1,
    extractor_implementation: 'build-1',
    extractor_identity: { kind: 'model', model_id: 'fabricated-model', prompt_sha256: id('3'), output_schema_sha256: id('4'), agent_contract_id: 'agent-v1' },
    ordered_parent_evidence_ids: [id('1'), id('2')],
    lineage_root_origin_ids: [],
  }
  assert.notEqual(extractionId(base), extractionId({ ...base, ordered_parent_evidence_ids: [id('2'), id('1')] }))
  throws(() => extractionId({ ...base, ordered_parent_evidence_ids: [id('1'), id('1')] }), 'duplicates')
})

test('validates exact evidence binding variants, source matches, UTF-8 boundaries, and derived parents', () => {
  const span = { kind: 'source_span', origin_id: source, start: 0, end: 2, coordinate_unit: 'utf8_byte' }
  assert.match(evidenceBindingId(span, { origin_id: source, origin_kind: 'primary-source', source_bytes: 'éx' }), /^[a-f0-9]{64}$/)
  throws(() => evidenceBindingId({ ...span, start: 1 }, { origin_id: source, origin_kind: 'primary-source', source_bytes: 'éx' }), 'UTF-8')
  throws(() => evidenceBindingId({ ...span, origin_id: id('9') }, { origin_id: source, origin_kind: 'primary-source' }), 'does not match')
  assert.match(evidenceBindingId({ kind: 'structured_path', origin_id: source, path_kind: 'json_pointer', path: '/a~1b' }, { origin_id: source, origin_kind: 'primary-source' }), /^[a-f0-9]{64}$/)
  throws(() => evidenceBindingId({ kind: 'structured_path', origin_id: source, path_kind: 'json_pointer', path: '/bad~2' }, { origin_id: source, origin_kind: 'primary-source' }), 'RFC 6901')
  assert.match(evidenceBindingId({ kind: 'private_source_ref', origin_id: source, private_locator_hash: id('8'), locator_authority: 'test' }, { origin_id: source, origin_kind: 'primary-source' }), /^[a-f0-9]{64}$/)
  const derived = { kind: 'derived_evidence', parent_claim_occurrence_ids: [occurrence], derivation_rule_id: 'test.rule', derivation_rule_version: 1 }
  assert.match(evidenceBindingId(derived, { current_accepted_parent_ids: [occurrence] }), /^[a-f0-9]{64}$/)
  throws(() => evidenceBindingId(derived, { current_accepted_parent_ids: [id('9')] }), 'not currently accepted')
  throws(() => evidenceBindingId({ ...span, extra: true }), 'invalid fields')
})

test('unresolved and claim-set IDs sort their set-valued fields while retaining complete projections', () => {
  const unresolved = { origin_id: source, kind: 'ambiguous', canonical_focus: ['question'], candidate_semantic_keys: [id('2'), id('1')], blocks_obligations: ['represent', 'retrieve'] }
  assert.equal(unresolvedKey(unresolved), unresolvedKey({ ...unresolved, candidate_semantic_keys: [id('1'), id('2')], blocks_obligations: ['retrieve', 'represent'] }))
  const projection = {
    subject_ref: 'ability:test/example', origin_id: source, adapter_id: 'test-adapter', ontology_version: 1,
    accepted_claim_occurrence_ids: [id('2'), id('1')], candidate_claim_occurrence_ids: [], open_unresolved_keys: [id('4'), id('3')],
    completeness: { state: 'incomplete', obligations_checked: ['retrieve', 'represent'] },
  }
  assert.equal(claimSetId(projection), claimSetId({ ...projection, accepted_claim_occurrence_ids: [id('1'), id('2')], open_unresolved_keys: [id('3'), id('4')], completeness: { ...projection.completeness, obligations_checked: ['represent', 'retrieve'] } }))
  throws(() => unresolvedKey({ ...unresolved, kind: 'freeform' }), 'kind')
})

test('projects lifecycle states and rejects duplicate acceptance and complete blocked sets', () => {
  const firstParent = id('1')
  const secondParent = id('2')
  const firstDerived = { kind: 'derived_evidence', parent_claim_occurrence_ids: [firstParent], derivation_rule_id: 'test.rule', derivation_rule_version: 1 }
  const secondDerived = { kind: 'derived_evidence', parent_claim_occurrence_ids: [secondParent], derivation_rule_id: 'test.rule', derivation_rule_version: 1 }
  const evidence_context = { current_accepted_parent_ids: [firstParent, secondParent] }
  const firstBindingId = evidenceBindingId(firstDerived, evidence_context)
  const secondBindingId = evidenceBindingId(secondDerived, evidence_context)
  const projected = projectClaimSet({
    subject_ref: 'ability:test/example', origin_id: source, origin_kind: 'primary-source', adapter,
    extractions: [{ origin_id: source, evidence_context, evidence_bindings: [firstDerived], assertions: [{ assertion_id: assertion, claim_occurrence_id: occurrence, evidence_binding_ids: [firstBindingId], derivation_parent_claim_occurrence_ids: [firstParent] }], unresolved: [{ kind: 'unsupported', extraction_local_focus: ['gap'], candidate_semantic_keys: [], blocks_obligations: ['represent'], resolution_state: 'open' }] }],
    decisions: [{ assertion_id: assertion, decision: 'accept' }], relations: [],
    completeness: { state: 'incomplete', obligations_checked: ['represent'] },
  })
  assert.deepEqual(projected.accepted_claim_occurrence_ids, [occurrence])
  assert.equal(projected.assertion_states[0].state, 'accepted')
  assert.equal(projected.open_unresolved_keys.length, 1)
  throws(() => projectClaimSet({
    subject_ref: 'ability:test/example', origin_id: source, origin_kind: 'primary-source', adapter,
    extractions: [{ origin_id: source, evidence_context, evidence_bindings: [firstDerived, secondDerived], assertions: [{ assertion_id: assertion, claim_occurrence_id: occurrence, evidence_binding_ids: [firstBindingId], derivation_parent_claim_occurrence_ids: [firstParent] }, { assertion_id: id('e'), claim_occurrence_id: occurrence, evidence_binding_ids: [secondBindingId], derivation_parent_claim_occurrence_ids: [secondParent] }], unresolved: [] }],
    decisions: [{ assertion_id: assertion, decision: 'accept' }, { assertion_id: id('e'), decision: 'accept' }], relations: [], completeness: { state: 'incomplete', obligations_checked: [] },
  }), 'duplicate accepted')
  throws(() => projectClaimSet({
    subject_ref: 'ability:test/example', origin_id: source, origin_kind: 'primary-source', adapter,
    extractions: [{ origin_id: source, assertions: [], unresolved: [{ kind: 'ambiguous', extraction_local_focus: ['gap'], candidate_semantic_keys: [], blocks_obligations: ['represent'] }] }],
    relations: [], completeness: { state: 'complete', obligations_checked: ['represent'] },
  }), 'open unresolved blocker')
})

test('derives and verifies assertion, relation, and independence identities in the projection', () => {
  const extractionIdentity = {
    origin_id: source, extractor_contract_version: 1, formalization_policy_version: 1,
    normalization_version: 1, extractor_implementation: 'build-1',
    extractor_identity: { kind: 'model', model_id: 'fabricated-model', prompt_sha256: id('3'), output_schema_sha256: id('4'), agent_contract_id: 'agent-v1' },
    ordered_parent_evidence_ids: [binding], lineage_root_origin_ids: [],
  }
  const evidence = { kind: 'source_span', origin_id: source, start: 0, end: 1, coordinate_unit: 'utf8_byte' }
  const derivedEvidence = { kind: 'derived_evidence', parent_claim_occurrence_ids: [id('1'), id('2')], derivation_rule_id: 'test.rule', derivation_rule_version: 1 }
  const evidence_context = { origin_id: source, origin_kind: 'primary-source', source_bytes: 'x', current_accepted_parent_ids: [id('1'), id('2')] }
  const evidenceId = evidenceBindingId(evidence, evidence_context)
  const derivedEvidenceId = evidenceBindingId(derivedEvidence, evidence_context)
  const assertionInput = {
    extraction_local_id: 'local-a', claim_occurrence_id: occurrence, evidence_binding_ids: [evidenceId, derivedEvidenceId],
    derivation_parent_claim_occurrence_ids: [id('1'), id('2')], state: 'accepted',
  }
  const result = projectClaimSet({
    subject_ref: 'ability:test/example', origin_id: source, origin_kind: 'primary-source', adapter,
    extractions: [{
      origin_id: source, extraction_identity: extractionIdentity,
      evidence_context, evidence_bindings: [evidence, derivedEvidence],
      assertions: [assertionInput], unresolved: [],
    }],
    relations: [{ source_claim_occurrence_id: occurrence, target_claim_occurrence_id: id('5'), relation_type: 'supersedes', decision_node_id: id('6') }],
    completeness: { state: 'complete', obligations_checked: [] },
  })
  const projectedAssertionId = result.assertion_states[0].assertion_id
  assert.equal(projectedAssertionId, expectedHash({
    extraction_id: extractionId(extractionIdentity),
    extraction_local_id: 'local-a',
    claim_occurrence_id: occurrence,
    evidence_binding_ids_sorted: [evidenceId, derivedEvidenceId].sort(),
    derivation_parent_claim_occurrence_ids_ordered: [id('1'), id('2')],
  }))
  assert.equal(result.assertion_states[0].independence_group_id, expectedHash({
    origin_id: source, model_id: 'fabricated-model', prompt_sha256: id('3'),
    output_schema_sha256: id('4'), agent_contract_id: 'agent-v1',
  }))
  assert.equal(result.relations[0].relation_id, expectedHash({
    source_claim_occurrence_id: occurrence, target_claim_occurrence_id: id('5'),
    relation_type: 'supersedes', decision_node_id: id('6'),
  }))
  const reorderedDerivedEvidence = { ...derivedEvidence, parent_claim_occurrence_ids: [id('2'), id('1')] }
  const reorderedDerivedEvidenceId = evidenceBindingId(reorderedDerivedEvidence, evidence_context)
  assert.notEqual(
    result.assertion_states[0].assertion_id,
    projectClaimSet({
      subject_ref: 'ability:test/example', origin_id: source, origin_kind: 'primary-source', adapter,
      extractions: [{ origin_id: source, extraction_identity: extractionIdentity, evidence_context, evidence_bindings: [evidence, reorderedDerivedEvidence], assertions: [{ ...assertionInput, evidence_binding_ids: [evidenceId, reorderedDerivedEvidenceId], derivation_parent_claim_occurrence_ids: [id('2'), id('1')] }], unresolved: [] }],
      relations: [], completeness: { state: 'complete', obligations_checked: [] },
    }).assertion_states[0].assertion_id,
  )
  throws(() => projectClaimSet({
    subject_ref: 'ability:test/example', origin_id: source, origin_kind: 'primary-source', adapter,
    extractions: [{ origin_id: source, extraction_identity: extractionIdentity, evidence_context, evidence_bindings: [evidence, derivedEvidence], assertions: [{ ...assertionInput, assertion_id: id('9') }], unresolved: [] }],
    relations: [], completeness: { state: 'complete', obligations_checked: [] },
  }), 'does not match assertion identity')
})

test('computes each deterministic invalidation boundary without cross-category leakage', () => {
  const dependencies = { claim_occurrence_ids: [occurrence], claim_set_ids: [id('e')], representation_certificate_ids: [id('f')], assessment_ids: [id('0')] }
  const sourceChange = computeInvalidations({ kind: 'source_snapshot' }, dependencies)
  assert.equal(sourceChange.reextract, true)
  assert.deepEqual(sourceChange.invalidated.claim_set_ids, [id('e')])
  assert.equal(sourceChange.recertify_representations, true)
  assert.equal(sourceChange.reassess, true)
  assert.equal(computeInvalidations({ kind: 'extraction_identity', claim_set_id_changed: false }, dependencies).invalidated.representation_certificate_ids.length, 0)
  const changedExtraction = computeInvalidations({ kind: 'extraction_identity', claim_set_id_changed: true }, dependencies)
  assert.deepEqual(changedExtraction.invalidated.representation_certificate_ids, [id('f')])
  assert.deepEqual(changedExtraction.invalidated.claim_set_ids, [id('e')])
  assert.deepEqual(changedExtraction.invalidated.assessment_ids, [id('0')])
  const ontology = computeInvalidations({ kind: 'identity_ontology' }, dependencies)
  assert.equal(ontology.reextract, true)
  assert.equal(ontology.recertify_representations, true)
  assert.equal(ontology.reassess, true)
  assert.deepEqual(ontology.invalidated.assessment_ids, [id('0')])
  assert.equal(computeInvalidations({ kind: 'adapter_annotation' }, dependencies).rebuild_adapter_projections, true)
  assert.equal(computeInvalidations({ kind: 'mechanic_signature_or_embedding' }, dependencies).rebuild_retrieval_and_construction, true)
  assert.equal(computeInvalidations({ kind: 'ability_dsl_schema_or_describer' }, dependencies).recertify_representations, true)
  assert.equal(computeInvalidations({ kind: 'assessment_context_or_policy_or_model_or_prompt_or_contract' }, dependencies).reassess, true)
  throws(() => computeInvalidations({ kind: 'unknown' }), 'invalid')
})
