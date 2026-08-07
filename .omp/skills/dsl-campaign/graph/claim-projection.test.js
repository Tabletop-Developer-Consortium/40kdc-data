import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { projectionChecksum, rebuildProjections } from './reducer.js'
import { SCHEMA_SQL } from './schema.js'
import { GraphStore } from './store.js'

function graph() {
  const store = new GraphStore(mkdtempSync(join(tmpdir(), 'claim-projection-')), { verify: false })
  const source = store.createNode({ kind: 'source-snapshot', payload: { source_snapshot_id: 'snapshot', faction_id: 'fabricated', ability_id: 'ability', store_key: 'fixture', provenance: {}, byte_hash: 'a'.repeat(64) } })
  const origin = store.createNode({ kind: 'claim-origin', payload: { origin_id: 'snapshot', subject_ref: 'ability:fabricated/ability', origin_kind: 'primary-source', source_snapshot_id: 'snapshot', artifact_node_id: null, content_sha256: null, current_state: 'current' }, parents: [{ node_id: source.node_id, edge_type: 'derived_from', metadata: {} }] })
  const extraction = store.createNode({ kind: 'extraction-identity', payload: { extraction_id: 'extract', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', identity: {} }, parents: [{ node_id: source.node_id, edge_type: 'derived_from', metadata: {} }] })
  const semantic = store.createNode({ kind: 'semantic-claim', payload: { semantic_key: 'semantic', adapter_id: '40k-mechanic', proposition_schema_id: '40k.mechanic-claim', proposition_schema_version: '1', identity_ontology_version: '1', polarity: 'affirms', modality: 'asserted', proposition: { schema_id: '40k.mechanic-claim', schema_version: '1', value: { predicate: 'mechanic.trigger', arguments: [], qualifiers: [] } } } })
  const occurrence = store.createNode({ kind: 'claim-occurrence', payload: { claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'proposed' } })
  const evidence = store.createNode({ kind: 'claim-evidence-binding', payload: { binding_id: 'evidence', kind: 'source_span', origin_id: 'snapshot', start: 0, end: 1, coordinate_unit: 'utf8_byte' } })
  const assertion = store.createNode({ kind: 'claim-assertion', payload: { assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'occurrence', decision_state: 'proposed', independence_group_id: 'group', evidence_binding_ids: ['evidence'], derivation_parent_claim_occurrence_ids: [] } })
  const decision = store.createNode({ kind: 'claim-review-decision', payload: { decision_id: 'decision', subject_node_id: assertion.node_id, decision: 'accept', reviewer_kind: 'validator', policy_version: '1' } })
  const certificate = store.createNode({ kind: 'claim-set-certificate', payload: { claim_set_id: 'set', certificate_id: 'certificate', extraction_id: 'extract', assertion_ids: ['assertion'], decision_ids: ['decision'], unresolved_keys: [], status: 'certified' } })
  const representation = store.createNode({ kind: 'candidate-certificate', payload: { faction_id: 'fabricated', ability_id: 'ability', status: 'certified', fingerprints: {}, checks: [] } })
  const plan = store.createNode({ kind: 'construction-plan', payload: { faction_id: 'fabricated', ability_id: 'ability', claim_set_id: 'set', selected_evidence_node_ids: [], covered_claim_occurrence_ids: [], unmatched_claim_occurrence_ids: ['occurrence'], state: 'ready', blocking_unresolved_keys: [], substitutions: [], composition_seams: [], required_checks: [] } })
  const invalidation = store.createNode({ kind: 'finding', payload: { state: 'open' } })
  return { store, source, origin, extraction, semantic, occurrence, evidence, assertion, decision, certificate, representation, plan, invalidation }
}
function event(store, type, payload, node) {
  const aggregateKind = type === 'claim-origin-recorded' ? 'claim-origin' : 'projection'
  store.appendEvent(type, payload, { aggregate_kind: aggregateKind, aggregate_id: `${type}:${store.sequence()}`, node_id: node })
}

function seedOrigin(fixture) {
  const { store, source, origin } = fixture
  event(store, 'source-snapshot-recorded', { source_snapshot_id: 'snapshot', source_node_id: source.node_id, rows: { source_snapshots: [{ id: 'snapshot', run_id: null, state: null, node_id: source.node_id, payload: {} }] } }, source.node_id)
  event(store, 'claim-origin-recorded', { schema_version: 5, origin_id: 'snapshot', rows: { claim_origins: [{ origin_id: 'snapshot', subject_ref: 'ability:fabricated/ability', origin_kind: 'primary-source', artifact_node_id: null, content_sha256: null, source_snapshot_id: 'snapshot', current_state: 'current', node_id: origin.node_id }] } }, origin.node_id)
}
function seed(fixture) {
  const { store, extraction, semantic, occurrence, evidence, assertion } = fixture
  seedOrigin(fixture)
  event(store, 'claim-extraction-recorded', { extraction_id: 'extract', origin_id: 'snapshot', rows: { claim_extractions: [{ extraction_id: 'extract', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', identity_json: '{}', node_id: extraction.node_id }], semantic_claims: [{ semantic_key: 'semantic', adapter_id: '40k-mechanic', proposition_schema_id: '40k.mechanic-claim', proposition_schema_version: '1', identity_ontology_version: '1', polarity: 'affirms', modality: 'asserted', proposition_json: '{"schema_id":"40k.mechanic-claim","schema_version":"1","value":{"arguments":[],"predicate":"mechanic.trigger","qualifiers":[]}}', node_id: semantic.node_id }], claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'proposed', node_id: occurrence.node_id }], claim_evidence_bindings: [{ binding_id: 'evidence', origin_id: 'snapshot', kind: 'source_span', start_byte: 0, end_byte: 1, path_kind: null, path: null, private_locator_hash: null, locator_authority: null, derivation_rule_id: null, derivation_rule_version: null, node_id: evidence.node_id }], claim_assertions: [{ assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'occurrence', decision_state: 'proposed', independence_group_id: 'group', node_id: assertion.node_id }], claim_assertion_evidence: [{ assertion_id: 'assertion', binding_id: 'evidence' }] } }, extraction.node_id)
}
function accept(fixture) {
  const { store, assertion, decision } = fixture
  event(store, 'claim-review-recorded', { decision_id: 'decision', subject_node_id: assertion.node_id, rows: { claim_review_decisions: [{ decision_id: 'decision', subject_node_id: assertion.node_id, decision: 'accept', reviewer_kind: 'validator', policy_version: '1', node_id: decision.node_id }], claim_assertions: [{ assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'occurrence', decision_state: 'accepted', independence_group_id: 'group', node_id: assertion.node_id }] } }, decision.node_id)
}


test('claim rows replay identically through acceptance, coverage, and invalidation', () => {
  const f = graph(); seed(f); accept(f)
  event(f.store, 'claim-set-projected', { claim_set_id: 'set', certificate_node_id: f.certificate.node_id, rows: { claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'accepted', node_id: f.occurrence.node_id }], claim_sets: [{ claim_set_id: 'set', subject_ref: 'ability:fabricated/ability', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', completeness_state: 'complete', obligations_checked_json: '[]', certificate_node_id: f.certificate.node_id }], claim_set_members: [{ claim_set_id: 'set', claim_occurrence_id: 'occurrence', member_state: 'accepted' }] } }, f.certificate.node_id)
  event(f.store, 'representation-coverage-recorded', { representation_node_id: f.representation.node_id, claim_set_id: 'set', claim_occurrence_id: 'occurrence', construction_plan_node_id: f.plan.node_id, rows: { representation_claim_coverage: [{ representation_node_id: f.representation.node_id, claim_set_id: 'set', claim_occurrence_id: 'occurrence', coverage_state: 'covered', construction_plan_node_id: f.plan.node_id }] } }, f.representation.node_id)
  event(f.store, 'claim-dependencies-invalidated', { invalidation_node_id: f.invalidation.node_id, invalidated_node_ids: [f.occurrence.node_id, f.representation.node_id], rows: { claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'invalidated', node_id: f.occurrence.node_id }], representation_claim_coverage: [{ representation_node_id: f.representation.node_id, claim_set_id: 'set', claim_occurrence_id: 'occurrence', coverage_state: 'blocked', construction_plan_node_id: f.plan.node_id }] } }, f.invalidation.node_id)
  assert.equal(f.store.db.prepare('SELECT state FROM claim_occurrences').get().state, 'invalidated')
  const replay = new DatabaseSync(':memory:'); replay.exec(SCHEMA_SQL)
  rebuildProjections(replay, f.store.eventRows(), { objects: f.store.db.prepare('SELECT * FROM objects').all(), nodes: f.store.db.prepare('SELECT * FROM nodes').all(), edges: f.store.db.prepare('SELECT * FROM edges').all() })
  assert.equal(projectionChecksum(replay), projectionChecksum(f.store.db))
  f.store.close(); replay.close()
})

test('claim projection rejects incomplete acceptance and rolls back', () => {
  const f = graph()
  seedOrigin(f)
  assert.throws(() => event(f.store, 'claim-extraction-recorded', { extraction_id: 'extract', origin_id: 'snapshot', claim_set_id: 'set', certificate_node_id: f.certificate.node_id, rows: { claim_extractions: [{ extraction_id: 'extract', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', identity_json: '{}', node_id: f.extraction.node_id }], semantic_claims: [], claim_occurrences: [], claim_assertions: [{ assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'missing', decision_state: 'accepted', independence_group_id: 'group', node_id: f.assertion.node_id }] } }, f.extraction.node_id))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_extractions').get().count, 0)
  f.store.close()
})


test('accepted assertion without evidence rolls back review rows', () => {
  const f = graph(); seed(f); f.store.db.exec('DELETE FROM claim_assertion_evidence')
  assert.throws(() => event(f.store, 'claim-review-recorded', { decision_id: 'decision', subject_node_id: f.assertion.node_id, rows: { claim_review_decisions: [{ decision_id: 'decision', subject_node_id: f.assertion.node_id, decision: 'accept', reviewer_kind: 'validator', policy_version: '1', node_id: f.decision.node_id }], claim_assertions: [{ assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'occurrence', decision_state: 'accepted', independence_group_id: 'group', node_id: f.assertion.node_id }] } }, f.decision.node_id))
  assert.equal(f.store.db.prepare('SELECT decision_state FROM claim_assertions').get().decision_state, 'proposed'); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_review_decisions').get().count, 0); f.store.close()
})

test('accepted occurrence without accepted assertion rolls back', () => {
  const f = graph(); seed(f)
  assert.throws(() => event(f.store, 'claim-set-projected', { claim_set_id: 'set', certificate_node_id: f.certificate.node_id, rows: { claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'accepted', node_id: f.occurrence.node_id }], claim_sets: [{ claim_set_id: 'set', subject_ref: 'ability:fabricated/ability', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', completeness_state: 'complete', obligations_checked_json: '[]', certificate_node_id: f.certificate.node_id }], claim_set_members: [{ claim_set_id: 'set', claim_occurrence_id: 'occurrence', member_state: 'accepted' }] } }, f.certificate.node_id))
  assert.equal(f.store.db.prepare('SELECT state FROM claim_occurrences').get().state, 'proposed'); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_sets').get().count, 0); f.store.close()
})

test('complete claim set with checked open blocker rolls back', () => {
  const f = graph(); seed(f); const u = f.store.createNode({ kind: 'unresolved-item', payload: { unresolved_key: 'unresolved', extraction_id: 'extract', extraction_local_id: 'u', extraction_local_focus: [], kind: 'ambiguous', evidence_binding_ids: [], candidate_semantic_keys: [], blocks_obligations: ['represent'], resolution_state: 'open' } })
  assert.throws(() => event(f.store, 'claim-set-projected', { claim_set_id: 'set', certificate_node_id: f.certificate.node_id, rows: { claim_sets: [{ claim_set_id: 'set', subject_ref: 'ability:fabricated/ability', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', completeness_state: 'complete', obligations_checked_json: '[\"represent\"]', certificate_node_id: f.certificate.node_id }], claim_unresolved: [{ unresolved_key: 'unresolved', extraction_id: 'extract', kind: 'ambiguous', focus_json: '[]', blocks_obligations_json: '[\"represent\"]', resolution_state: 'open', node_id: u.node_id }], claim_set_unresolved: [{ claim_set_id: 'set', unresolved_key: 'unresolved' }] } }, f.certificate.node_id))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_sets').get().count, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_unresolved').get().count, 0); f.store.close()
})

test('duplicate accepted assertion rolls back', () => {
  const f = graph(); seed(f)
  accept(f)
  const duplicate = f.store.createNode({ kind: 'claim-assertion', payload: { assertion_id: 'assertion-two', extraction_id: 'extract', extraction_local_id: 'two', claim_occurrence_id: 'occurrence', decision_state: 'accepted', independence_group_id: 'group-two', evidence_binding_ids: ['evidence'], derivation_parent_claim_occurrence_ids: [] } })
  assert.throws(() => event(f.store, 'claim-review-recorded', { decision_id: 'decision-two', subject_node_id: duplicate.node_id, rows: { claim_assertions: [{ assertion_id: 'assertion-two', extraction_id: 'extract', extraction_local_id: 'two', claim_occurrence_id: 'occurrence', decision_state: 'accepted', independence_group_id: 'group-two', node_id: duplicate.node_id }], claim_review_decisions: [{ decision_id: 'decision-two', subject_node_id: duplicate.node_id, decision: 'accept', reviewer_kind: 'validator', policy_version: '1', node_id: f.decision.node_id }], claim_assertion_evidence: [{ assertion_id: 'assertion-two', binding_id: 'evidence' }] } }, f.decision.node_id))
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_assertions').get().count, 1); f.store.close()
})

test('derivation cycle rolls back review rows', () => {
  const f = graph(); seed(f)
  assert.throws(() => event(f.store, 'claim-review-recorded', { decision_id: 'decision', subject_node_id: f.assertion.node_id, rows: { claim_review_decisions: [{ decision_id: 'decision', subject_node_id: f.assertion.node_id, decision: 'accept', reviewer_kind: 'validator', policy_version: '1', node_id: f.decision.node_id }], claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'accepted', node_id: f.occurrence.node_id }], claim_assertions: [{ assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'occurrence', decision_state: 'accepted', independence_group_id: 'group', node_id: f.assertion.node_id }], claim_derivation_parents: [{ assertion_id: 'assertion', parent_claim_occurrence_id: 'occurrence', ordinal: 0 }] } }, f.decision.node_id), /cycle/)
  assert.equal(f.store.db.prepare('SELECT state FROM claim_occurrences').get().state, 'proposed')
  assert.equal(f.store.db.prepare('SELECT decision_state FROM claim_assertions').get().decision_state, 'proposed')
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM claim_derivation_parents').get().count, 0)
  f.store.close()
})

test('review decisions cannot authorize an unrelated assertion lifecycle', () => {
  const f = graph(); seed(f)
  assert.throws(() => event(f.store, 'claim-review-recorded', {
    decision_id: 'decision', subject_node_id: f.assertion.node_id,
    rows: {
      claim_review_decisions: [{ decision_id: 'decision', subject_node_id: f.assertion.node_id, decision: 'reject', reviewer_kind: 'validator', policy_version: '1', node_id: f.decision.node_id }],
      claim_assertions: [{ assertion_id: 'assertion', extraction_id: 'extract', extraction_local_id: 'local', claim_occurrence_id: 'occurrence', decision_state: 'accepted', independence_group_id: 'group', node_id: f.assertion.node_id }],
    },
  }, f.decision.node_id))
  assert.equal(f.store.db.prepare('SELECT decision_state FROM claim_assertions WHERE assertion_id=?').get('assertion').decision_state, 'proposed')
  f.store.close()
})

test('source snapshot invalidation cannot leave a dependent claim set current', () => {
  const f = graph(); seed(f); accept(f)
  event(f.store, 'claim-set-projected', { claim_set_id: 'set', certificate_node_id: f.certificate.node_id, rows: {
    claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'accepted', node_id: f.occurrence.node_id }],
    claim_sets: [{ claim_set_id: 'set', subject_ref: 'ability:fabricated/ability', origin_id: 'snapshot', adapter_id: '40k-mechanic', ontology_version: '1', completeness_state: 'complete', obligations_checked_json: '[]', state: 'current', certificate_node_id: f.certificate.node_id }],
    claim_set_members: [{ claim_set_id: 'set', claim_occurrence_id: 'occurrence', member_state: 'accepted' }],
  } }, f.certificate.node_id)
  const invalidation = f.store.createNode({ kind: 'claim-dependency-invalidation', payload: { origin_id: 'next', invalidated_node_ids: [f.occurrence.node_id], reason: 'source-snapshot-changed' } })
  assert.throws(() => event(f.store, 'claim-dependencies-invalidated', {
    invalidation_node_id: invalidation.node_id, invalidated_node_ids: [f.occurrence.node_id],
    rows: { claim_occurrences: [{ claim_occurrence_id: 'occurrence', origin_id: 'snapshot', semantic_key: 'semantic', subject_ref: 'ability:fabricated/ability', state: 'invalidated', node_id: f.occurrence.node_id }] },
  }, invalidation.node_id))
  assert.equal(f.store.db.prepare('SELECT state FROM claim_sets WHERE claim_set_id=?').get('set').state, 'current')
  f.store.close()
})