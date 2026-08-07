import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GraphStore } from './store.js'

function temporaryRoot() { return mkdtempSync(join(tmpdir(), 'claim-graph-')) }
function parent(nodeId, edgeType = 'derived_from') {
  return { node_id: nodeId, edge_type: edgeType, authorizes_reuse: false, metadata: {} }
}

test('objects are immutable and require existing unique typed parents', () => {
  const store = new GraphStore(temporaryRoot())
  const parentNode = store.createNode({ kind: 'decision', payload: { decision_id: 'd', state: 'answered', text: 'selected', authorizes_reuse: false } })
  const child = store.createNode({ kind: 'finding', payload: { state: 'open' }, parents: [parent(parentNode.node_id)] })
  assert.equal(store.createNode({ kind: 'finding', payload: { state: 'open' }, parents: [parent(parentNode.node_id)] }).node_id, child.node_id)
  assert.throws(() => store.createNode({ kind: 'finding', payload: {}, parents: [parent('f'.repeat(64))] }), /missing parent/)
  assert.throws(() => store.createNode({ kind: 'finding', payload: {}, parents: [parent(parentNode.node_id), parent(parentNode.node_id)] }), /duplicate/)
  assert.throws(() => store.createNode({ kind: 'finding', payload: {}, parents: [{ ...parent(parentNode.node_id), edge_type: 'invented' }] }), /unsupported edge type/)
  assert.throws(() => store.createNode({ kind: 'finding', payload: {}, input_node_ids: [parentNode.node_id] }), /unknown key input_node_ids/)
  writeFileSync(store.objectPath(child.node_id), '{}\n')
  assert.throws(() => store.createNode({ kind: 'finding', payload: { state: 'open' }, parents: [parent(parentNode.node_id)] }), /collision quarantined/)
  store.close()
})

test('event mirror is fully verified and repaired from SQLite', () => {
  const root = temporaryRoot()
  const store = new GraphStore(root)
  store.appendEvent('run-created', { row: { run_id: 'r1', campaign_id: 'c1', state: 'planned' } }, { aggregate_kind: 'run', aggregate_id: 'r1' })
  store.appendEvent('run-started', { expected_state: 'planned' }, { aggregate_kind: 'run', aggregate_id: 'r1' })
  store.appendEvent('run-completed', { expected_state: 'active' }, { aggregate_kind: 'run', aggregate_id: 'r1' })
  const expected = readFileSync(join(root, 'events.jsonl'), 'utf8')
  writeFileSync(join(root, 'events.jsonl'), `${expected.split('\n')[0]}\ncorrupt\n`)
  store.close()
  const reopened = new GraphStore(root)
  assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), expected)
  assert.equal(reopened.verifyEvents().sequence, 3)
  reopened.close()
})

test('invalid transitions and former projection callbacks append nothing', () => {
  const store = new GraphStore(temporaryRoot())
  assert.throws(() => store.appendEvent('run-completed', {}, { aggregate_kind: 'run', aggregate_id: 'missing' }), /aggregate not found/)
  assert.throws(() => store.appendEvent('run-created', {}, { aggregate_kind: 'run', aggregate_id: 'r1', projection() {} }), /projection option is not supported/)
  assert.equal(store.sequence(), 0)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0)
  store.close()
})

test('unknown events and versions are rejected without projection mutation', () => {
  const store = new GraphStore(temporaryRoot())
  store.appendEvent('run-created', { row: { run_id: 'r1', campaign_id: 'c1', state: 'planned' } }, { aggregate_kind: 'run', aggregate_id: 'r1' })
  assert.throws(() => store.appendEvent('future', {}, { aggregate_kind: 'run', aggregate_id: 'r1' }), /unknown event type/)
  assert.throws(() => store.appendEvent('run-started', {}, { event_version: 99, aggregate_kind: 'run', aggregate_id: 'r1' }), /unsupported event version/)
  assert.equal(store.db.prepare('SELECT state FROM runs WHERE run_id=?').get('r1').state, 'planned')
  assert.equal(store.sequence(), 1)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM quarantine_events').get().n, 0)
  assert.equal(existsSync(join(store.root, 'events.jsonl')), true)
  store.close()
})

test('only schema four stores admit explicit migration mode', () => {
  const root = temporaryRoot()
  const initialized = new GraphStore(root, { verify: false })
  initialized.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run('4')
  initialized.close()
  assert.throws(() => new GraphStore(root, { verify: false }), /schema version 4 requires migrate-projections/)
  const indexPath = join(root, 'index.sqlite')
  const before = readFileSync(indexPath)
  const migration = new GraphStore(root, { verify: false, migrationMode: true, readOnly: true })
  assert.equal(migration.schemaVersion, 4)
  migration.close()
  assert.deepEqual(readFileSync(indexPath), before)
  for (const unsupported of [2, 3]) {
    const unsupportedRoot = temporaryRoot()
    const store = new GraphStore(unsupportedRoot, { verify: false })
    store.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(unsupported))
    store.close()
    assert.throws(() => new GraphStore(unsupportedRoot, { verify: false, migrationMode: true, readOnly: true }), /unsupported; migration requires schema 4/)
  }
})
