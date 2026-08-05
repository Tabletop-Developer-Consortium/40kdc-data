import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GraphStore } from './store.js'

function temporaryRoot() { return mkdtempSync(join(tmpdir(), 'claim-graph-')) }

test('objects are immutable and require existing unique parents', () => {
  const store = new GraphStore(temporaryRoot())
  const parent = store.createNode({ kind: 'decision', payload: { decision_id: 'd', state: 'answered', text: 'selected', authorizes_reuse: false } })
  const child = store.createNode({ kind: 'finding', payload: { state: 'open' }, input_node_ids: [parent.node_id] })
  assert.equal(store.createNode({ kind: 'finding', payload: { state: 'open' }, input_node_ids: [parent.node_id] }).node_id, child.node_id)
  assert.throws(() => store.createNode({ kind: 'finding', payload: {}, input_node_ids: ['f'.repeat(64)] }), /missing parent/)
  assert.throws(() => store.createNode({ kind: 'finding', payload: {}, input_node_ids: [parent.node_id, parent.node_id] }), /duplicate/)
  writeFileSync(store.objectPath(child.node_id), '{}\n')
  assert.throws(() => store.createNode({ kind: 'finding', payload: { state: 'open' }, input_node_ids: [parent.node_id] }), /collision quarantined/)
  store.close()
})

test('event mirror is fully verified and repaired from SQLite', () => {
  const root = temporaryRoot()
  const store = new GraphStore(root)
  store.appendEvent('run-created', { run_id: 'r1' })
  store.appendEvent('run-completed', { run_id: 'r1' })
  const expected = readFileSync(join(root, 'events.jsonl'), 'utf8')
  writeFileSync(join(root, 'events.jsonl'), `${expected.split('\n')[0]}\ncorrupt\n`)
  store.close()
  const reopened = new GraphStore(root)
  assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), expected)
  assert.equal(reopened.verifyEvents().sequence, 2)
  reopened.close()
})

test('event and projection roll back together', () => {
  const store = new GraphStore(temporaryRoot())
  assert.throws(() => store.appendEvent('run-created', {}, { projection: () => { throw new Error('projection failed') } }), /projection failed/)
  assert.equal(store.sequence(), 0)
  store.close()
})

test('unknown event version quarantines metadata and pauses affected run', () => {
  const store = new GraphStore(temporaryRoot())
  store.db.prepare('INSERT INTO runs(run_id,campaign_id,state) VALUES (?,?,?)').run('r1', 'c1', 'active')
  store.appendEvent('future', { forbidden_agent_payload: 'not persisted' }, { event_version: 99, aggregate_kind: 'run', aggregate_id: 'r1' })
  assert.equal(store.db.prepare('SELECT state FROM runs WHERE run_id=?').get('r1').state, 'paused')
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 0)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM quarantine_events').get().n, 1)
  store.close()
})
