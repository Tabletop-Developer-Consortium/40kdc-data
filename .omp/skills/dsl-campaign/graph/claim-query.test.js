import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GraphQueryError, queryClaims, queryUnresolved } from './retrieval.js'
import { GraphStore } from './store.js'

function seededStore() {
  const store = new GraphStore(mkdtempSync(join(tmpdir(), 'claim-query-')), { verify: false })
  const node = kind => store.createNode({ kind, payload: {} }).node_id
  const sourceNode = node('source-snapshot'); const originNode = node('claim-origin'); const extractionNode = node('extraction-identity')
  const semanticNode = node('semantic-claim'); const occurrenceNode = node('claim-occurrence')
  const evidenceNode = node('claim-evidence-binding'); const assertionNode = node('claim-assertion'); const unresolvedNode = node('unresolved-item')
  store.db.prepare('INSERT INTO source_snapshots(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run('snapshot', null, 'current', sourceNode, '{}')
  store.db.prepare('INSERT INTO claim_origins(origin_id,subject_ref,origin_kind,source_snapshot_id,current_state,node_id) VALUES (?,?,?,?,?,?)').run('origin', 'ability:fabricated/alpha', 'primary-source', 'snapshot', 'current', originNode)
  store.db.prepare('INSERT INTO claim_extractions(extraction_id,origin_id,adapter_id,ontology_version,identity_json,node_id) VALUES (?,?,?,?,?,?)').run('extract', 'origin', '40k-mechanic', '1', '{}', extractionNode)
  for (const [key, predicate] of [['semantic-a', 'mechanic.trigger'], ['semantic-b', 'mechanic.duration']]) {
    store.db.prepare('INSERT INTO semantic_claims(semantic_key,adapter_id,proposition_schema_id,proposition_schema_version,identity_ontology_version,polarity,modality,proposition_json,node_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(key, '40k-mechanic', '40k.mechanic-claim', '1', '1', 'affirms', 'asserted', JSON.stringify({ schema_id: '40k.mechanic-claim', schema_version: '1', value: { predicate, arguments: [], qualifiers: [] } }), semanticNode)
  }
  for (const [id, key] of [['occurrence-a', 'semantic-a'], ['occurrence-b', 'semantic-b']]) {
    store.db.prepare('INSERT INTO claim_occurrences(claim_occurrence_id,origin_id,semantic_key,subject_ref,state,node_id) VALUES (?,?,?,?,?,?)').run(id, 'origin', key, 'ability:fabricated/alpha', 'accepted', occurrenceNode)
    store.db.prepare('INSERT INTO mechanic_claim_facets(claim_occurrence_id,predicate,actor,affected_entity,event,duration,has_precondition) VALUES (?,?,?,?,?,?,?)').run(id, key === 'semantic-a' ? 'mechanic.trigger' : 'mechanic.duration', 'fabricated-unit', key === 'semantic-a' ? 'source-unit' : 'selected-friendly', 'start-of-turn', key === 'semantic-b' ? 'end-of-turn' : null, key === 'semantic-b' ? 1 : 0)
    store.db.prepare('INSERT INTO claim_assertions(assertion_id,extraction_id,extraction_local_id,claim_occurrence_id,decision_state,independence_group_id,node_id) VALUES (?,?,?,?,?,?,?)').run(`assertion-${id}`, 'extract', id, id, 'accepted', 'group', assertionNode)
  }
  store.db.prepare('INSERT INTO claim_evidence_bindings(binding_id,kind,origin_id,private_locator_hash,locator_authority,node_id) VALUES (?,?,?,?,?,?)').run('private-binding', 'private_source_ref', 'origin', 'safe-hash', 'fixture', evidenceNode)
  store.db.prepare('INSERT INTO claim_assertion_evidence(assertion_id,binding_id) VALUES (?,?)').run('assertion-occurrence-a', 'private-binding')
  store.db.prepare('INSERT INTO claim_assertion_evidence(assertion_id,binding_id) VALUES (?,?)').run('assertion-occurrence-b', 'private-binding')
  store.db.prepare('INSERT INTO claim_assertions(assertion_id,extraction_id,extraction_local_id,claim_occurrence_id,decision_state,independence_group_id,node_id) VALUES (?,?,?,?,?,?,?)').run('assertion-proposed-history', 'extract', 'history', 'occurrence-a', 'proposed', 'group', assertionNode)
  store.db.prepare('INSERT INTO claim_assertion_evidence(assertion_id,binding_id) VALUES (?,?)').run('assertion-proposed-history', 'private-binding')
  store.db.prepare('INSERT INTO claim_unresolved(unresolved_key,extraction_id,kind,focus_json,blocks_obligations_json,resolution_state,node_id) VALUES (?,?,?,?,?,?,?)').run('unresolved-a', 'extract', 'contradictory', '["exploitability"]', '["assess","represent"]', 'open', unresolvedNode)
  store.db.prepare('INSERT INTO claim_unresolved_evidence(unresolved_key,binding_id) VALUES (?,?)').run('unresolved-a', 'private-binding')
  store.db.prepare('INSERT INTO claim_unresolved_candidates(unresolved_key,candidate_semantic_key) VALUES (?,?)').run('unresolved-a', 'semantic-a')
  store.db.prepare('INSERT INTO claim_unresolved(unresolved_key,extraction_id,kind,focus_json,blocks_obligations_json,resolution_state,node_id) VALUES (?,?,?,?,?,?,?)').run('unresolved-resolved', 'extract', 'unsupported', '["other"]', '["assess"]', 'resolved', unresolvedNode)
  store.db.prepare('INSERT INTO claim_unresolved_candidates(unresolved_key,candidate_semantic_key) VALUES (?,?)').run('unresolved-resolved', 'semantic-b')
  return store
}

test('claim query filters facets and exposes safe evidence metadata', () => {
  const store = seededStore()
  const result = queryClaims(store, { faction_id: 'fabricated', ability_id: 'alpha', lifecycle_state: 'accepted', proposition_schema_id: '40k.mechanic-claim', predicate: 'mechanic.duration', actor: 'fabricated-unit', affected_entity: 'selected-friendly', event: 'start-of-turn', duration: 'end-of-turn', has_precondition: 'true', semantic_key: 'semantic-b', origin_id: 'origin', origin_kind: 'primary-source', origin_current_state: 'current' })
  assert.deepEqual(result.claims.map(claim => claim.claim_occurrence_id), ['occurrence-b'])
  assert.deepEqual(result.claims[0].independence_group_ids, ['group'])
  assert.equal(result.claims[0].origin_id, 'origin')
  const safe = queryClaims(store, { semantic_key: 'semantic-a' }).claims[0].evidence[0]
  assert.equal(JSON.stringify(safe).includes('"private_locator":'), false)
  assert.equal(JSON.stringify(safe).includes('private_locator'), true)
  assert.equal('private_locator' in safe, false)
  store.close()
})

test('claim histories retain non-authoritative evidence and unresolved predicates use exact candidates', () => {
  const store = seededStore()
  const claim = queryClaims(store, { semantic_key: 'semantic-a', include_history: true }).claims[0]
  assert.deepEqual(claim.proposition, { schema_id: '40k.mechanic-claim', schema_version: '1', value: { predicate: 'mechanic.trigger', arguments: [], qualifiers: [] } })
  assert.deepEqual(claim.assertions.map(assertion => assertion.decision_state), ['accepted', 'proposed'])
  assert.equal(claim.evidence.length, 1)
  assert.equal(claim.assertions[1].evidence.length, 1)
  assert.deepEqual(queryUnresolved(store, { predicate: 'mechanic.duration' }).unresolved.map(item => item.unresolved_key), ['unresolved-resolved'])
  assert.deepEqual(queryUnresolved(store, { semantic_key: 'semantic-a', resolution_state: 'open' }).unresolved.map(item => item.unresolved_key), ['unresolved-a'])
  assert.deepEqual(queryUnresolved(store, { resolution_state: 'waived' }).unresolved, [])
  store.db.prepare("UPDATE mechanic_claim_facets SET actor=? WHERE claim_occurrence_id='occurrence-a'").run('{"unit":"source"}')
  const objectFacet = queryClaims(store, { actor: { unit: 'source' } }).claims[0]
  assert.deepEqual(objectFacet.mechanic_facets.actor, { unit: 'source' })
  store.close()
})

test('claim and unresolved queries use deterministic cursors and reject stale cursors', () => {
  const store = seededStore()
  const first = queryClaims(store, { limit: 1 })
  const second = queryClaims(store, { limit: 1, after: first.page.next_cursor })
  assert.deepEqual(first.claims.map(claim => claim.claim_occurrence_id), ['occurrence-a'])
  assert.deepEqual(second.claims.map(claim => claim.claim_occurrence_id), ['occurrence-b'])
  assert.throws(() => queryClaims(store, { predicate: 'mechanic.trigger', after: first.page.next_cursor }), error => error instanceof GraphQueryError && error.code === 'cursor-filter-mismatch')
  store.appendEvent('repository-reconciled', { catalog_rows: [] }, { aggregate_kind: 'repository', aggregate_id: 'fixture' })
  assert.throws(() => queryClaims(store, { after: first.page.next_cursor }), error => error instanceof GraphQueryError && error.code === 'stale-cursor')
  const unresolved = queryUnresolved(store, { kind: 'contradictory', obligation: 'represent' })
  assert.deepEqual(unresolved.unresolved.map(item => item.unresolved_key), ['unresolved-a'])
  assert.equal('private_locator' in unresolved.unresolved[0].evidence[0], false)
  store.close()
})
