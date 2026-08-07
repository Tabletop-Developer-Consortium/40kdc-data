import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  assertAllowedEvent,
  assertAllowedNode,
  NORMALIZED_CLAIM_TABLES,
  REBUILDABLE_PROJECTION_TABLES,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './schema.js'

test('schema five closes claim objects and tagged origin identity', () => {
  assert.equal(SCHEMA_VERSION, 5)
  assert.doesNotThrow(() => assertAllowedNode('source-snapshot', {
    source_snapshot_id: 'snapshot', faction_id: 'faction', ability_id: 'ability', store_key: 'key', provenance: {}, byte_hash: 'hash',
  }))
  assert.throws(() => assertAllowedNode('source-snapshot', {
    source_snapshot_id: 'snapshot', faction_id: 'faction', ability_id: 'ability', store_key: 'key', provenance: {}, byte_hash: 'hash', clause_offsets: [],
  }), /unknown key clause_offsets/)
  assert.doesNotThrow(() => assertAllowedNode('claim-occurrence', {
    claim_occurrence_id: 'occurrence', origin_id: 'origin', semantic_key: 'semantic', subject_ref: 'ability:faction/ability', state: 'proposed',
  }))
  assert.throws(() => assertAllowedNode('claim-occurrence', {
    claim_occurrence_id: 'occurrence', origin_id: 'origin', semantic_key: 'semantic', subject_ref: 'ability:faction/ability', state: 'proposed', extra: true,
  }), /unknown key extra/)
})

test('schema five claim events require immutable IDs and rows', () => {
  assert.throws(() => assertAllowedEvent('claim-extraction-recorded', {
    extraction_id: 'extract', origin_id: 'origin',
  }, { aggregate_kind: 'projection', aggregate_id: 'projection' }), /missing rows/)
  assert.doesNotThrow(() => assertAllowedEvent('representation-coverage-recorded', {
    representation_node_id: 'representation', claim_set_id: 'set', claim_occurrence_id: 'occurrence', construction_plan_node_id: 'plan', rows: {},
  }, { aggregate_kind: 'projection', aggregate_id: 'projection' }))
})

test('schema five DDL defines normalized origin dependencies and query indexes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(SCHEMA_SQL)
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    for (const table of NORMALIZED_CLAIM_TABLES) assert.ok(tables.has(table), `${table} missing`)
    assert.deepEqual(REBUILDABLE_PROJECTION_TABLES.slice(-NORMALIZED_CLAIM_TABLES.length), NORMALIZED_CLAIM_TABLES)
    const occurrenceForeignKeys = db.prepare('PRAGMA foreign_key_list(claim_occurrences)').all()
    assert.ok(occurrenceForeignKeys.some(row => row.table === 'claim_origins' && row.from === 'origin_id'))
    assert.ok(occurrenceForeignKeys.some(row => row.table === 'semantic_claims' && row.from === 'semantic_key'))
    const coverageKey = db.prepare('PRAGMA table_info(representation_claim_coverage)').all()
      .filter(row => row.pk > 0).sort((left, right) => left.pk - right.pk).map(row => row.name)
    assert.deepEqual(coverageKey, ['representation_node_id', 'claim_set_id', 'claim_occurrence_id'])
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name))
    for (const index of ['claim_occurrences_origin', 'claim_occurrences_subject', 'claim_occurrences_semantic_key', 'claim_occurrences_state', 'claim_unresolved_kind', 'mechanic_claim_facets_predicate', 'mechanic_claim_facets_actor', 'mechanic_claim_facets_affected_entity', 'mechanic_claim_facets_event', 'mechanic_claim_facets_duration', 'mechanic_claim_facets_threshold']) assert.ok(indexes.has(index), `${index} missing`)
  } finally {
    db.close()
  }
})
