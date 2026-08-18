import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTrustedAgent } from './workflow-runtime.js'
import { GraphStore } from './store.js'
import { assertInputEnvelope, createExecutionEnvelope, sanitizeGraphPayload, sealOutput, verifyGraphIpBoundary } from './workflow-lineage.js'

function envelope(overrides = {}) {
  return createExecutionEnvelope({
    run_id: 'run-1', task_id: 'task-1', attempt_id: 'attempt-1', lease_id: 'lease-1',
    lease_expires_at: '2099-01-01T00:00:00.000Z', input_node_ids: [], ...overrides,
  })
}
function leaseFixture(expected, { leaseState = 'active', leaseId = expected.lease_id, expiresAt = expected.lease_expires_at, taskId = expected.task_id, attemptId = expected.attempt_id } = {}, root = mkdtempSync(join(tmpdir(), 'trusted-agent-graph-'))) {
  const store = new GraphStore(root)
  store.db.prepare('INSERT INTO runs(run_id,campaign_id,state) VALUES (?,?,?)').run(expected.run_id, `campaign-${expected.run_id}`, 'active')
  store.db.prepare('INSERT INTO tasks(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(expected.task_id, expected.run_id, 'running', '{}')
  store.db.prepare('INSERT INTO attempts(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(expected.attempt_id, expected.run_id, 'running', '{}')
  store.db.prepare('INSERT INTO leases(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(leaseId, expected.run_id, leaseState, JSON.stringify({ task_id: taskId, attempt_id: attemptId, expires_at: expiresAt }))
  store.close()
  return root
}


test('trusted envelopes reject stale and mismatched lineage', () => {
  const expected = envelope()
  assert.equal(assertInputEnvelope(expected), expected)
  assert.throws(() => assertInputEnvelope({ ...expected, task_id: 'other' }, expected), /lineage mismatch/)
  assert.throws(() => assertInputEnvelope({ ...expected, lease_expires_at: '2000-01-01T00:00:00Z' }), /expired/)
})

test('recursive sanitizer rejects prohibited fields and source spans', () => {
  assert.throws(() => sanitizeGraphPayload({ nested: { raw_text: 'x' } }), /prohibited IP field/)
  const source = 'one two three four five six seven eight nine ten eleven twelve thirteen'
  assert.throws(() => sanitizeGraphPayload({ summary: `prefix ${source} suffix` }, { source_texts: [source] }), /12-word source span/)
  assert.deepEqual(sanitizeGraphPayload({ summary: 'community-authored mechanic summary' }, { source_texts: [source] }), { summary: 'community-authored mechanic summary' })
})

test('sealed outputs bind exact lineage and parent ids', () => {
  const input = envelope({ input_node_ids: ['a'.repeat(64)] })
  const one = sealOutput('child', { finding: 'clear' }, input)
  const two = sealOutput('child', { finding: 'clear' }, input)
  assert.equal(one.output_node_id, two.output_node_id)
  assert.notEqual(one.output_node_id, sealOutput('child', { finding: 'changed' }, input).output_node_id)
  assert.deepEqual(one.input_node_ids, input.input_node_ids)
})

test('trusted agent persists and returns the lineage-bound child', async () => {
  const graphRoot = mkdtempSync(join(tmpdir(), 'trusted-agent-parent-'))
  const parentStore = new GraphStore(graphRoot)
  const parent = parentStore.createNode({ kind: 'decision', payload: { state: 'answered' } })
  parentStore.close()
  const expected = envelope({ input_node_ids: [parent.node_id] })
  leaseFixture(expected, {}, graphRoot)
  const graphAgent = createTrustedAgent({
    driverArgs: { graph_root: graphRoot, execution_envelopes: { child: expected } },
    invokeAgent: async (_prompt, options) => {
      assert.ok(options.schema.required.includes('_lineage'))
      return { value: 1, _lineage: expected }
    },
  })
  const result = await graphAgent('work', { label: 'child', agentType: 'helper', schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } } })
  assert.equal(result.value, 1)
  const store = new GraphStore(graphRoot)
  assert.ok(store.hasNode(result.sealed_output_node_id))
  assert.deepEqual(store.db.prepare('SELECT parent_node_id FROM edges WHERE child_node_id=?').all(result.sealed_output_node_id).map(row => ({ ...row })), [{ parent_node_id: parent.node_id }])
  store.close()
})

test('trusted agent rejects copied cross-task echo', async () => {
  const expected = envelope()
  const graphAgent = createTrustedAgent({
    driverArgs: { graph_root: leaseFixture(expected), execution_envelopes: { child: expected } },
    invokeAgent: async () => ({ value: 1, _lineage: { ...expected, task_id: 'wrong' } }),
  })
  await assert.rejects(() => graphAgent('work', { label: 'child', agentType: 'helper', schema: { type: 'object', properties: {} } }), /lineage mismatch/)
})

test('trusted agent rejects released, expired, superseded, and mismatched graph leases atomically', async () => {
  for (const fixture of [
    { leaseState: 'released' },
    { leaseState: 'superseded' },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { leaseId: 'other-lease' },
    { taskId: 'other-task' },
    { attemptId: 'other-attempt' },
  ]) {
    const expected = envelope()
    const graphRoot = leaseFixture(expected, fixture)
    const graphAgent = createTrustedAgent({
      driverArgs: { graph_root: graphRoot, execution_envelopes: { child: expected } },
      invokeAgent: async () => ({ value: 1, _lineage: expected }),
    })
    await assert.rejects(() => graphAgent('work', { label: 'child', agentType: 'helper', schema: { type: 'object', properties: {} } }), /active graph lease/)
    const store = new GraphStore(graphRoot)
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM nodes WHERE kind='workflow-output'").get().n, 0)
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE event_type='workflow-output-sealed'").get().n, 0)
    store.close()
  }
})

test('IP boundary verification reports exact and contained fabricated prose without echoing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-ip-boundary-'))
  const rawStore = join(root, 'raw-store')
  mkdirSync(rawStore)
  const prohibited = 'Fabricated defenders reduce incoming harm during the test window.'
  writeFileSync(join(rawStore, 'index.json'), JSON.stringify({
    schema_version: 1,
    factions: { fixture: { 'defensive-primitive': { faction: 'Fixture', raw_text: prohibited } } },
  }))
  const store = new GraphStore(join(root, 'graph'))
  store.createNode({ kind: 'finding', payload: { faction_id: 'fixture', ability_id: 'safe-name', summary: 'community-authored defensive summary' } })
  assert.equal(verifyGraphIpBoundary(store, rawStore).clean, true)
  const exact = store.createNode({ kind: 'finding', payload: { summary: prohibited } })
  const contained = store.createNode({ kind: 'finding', payload: { summary: `prefix ${prohibited} suffix` } })
  const result = verifyGraphIpBoundary(store, rawStore)
  assert.equal(result.clean, false)
  assert.deepEqual(result.violations.map(item => item.record_id).sort(), [contained.node_id, exact.node_id].sort())
  assert.ok(result.violations.every(item => item.json_pointer === '/summary' && item.store_key === 'fixture/defensive-primitive'))
  assert.equal(JSON.stringify(result).includes(prohibited), false)
  store.close()
})
