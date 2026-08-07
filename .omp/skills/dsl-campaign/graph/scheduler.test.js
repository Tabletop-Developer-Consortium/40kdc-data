import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertActiveLease,
  completeTask,
  ensureTask,
  issueReadyTask,
  LEASE_TTL_MS,
  recordRetryableFailure,
  renewLease,
} from './scheduler.js'
import { GraphStore } from './store.js'

function fixture(runId = 'c012') {
  const store = new GraphStore(mkdtempSync(join(tmpdir(), 'scheduler-')))
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 3, policy_version: 2 } })
  const readiness = store.createNode({
    kind: 'decision', payload: { state: 'answered' },
    parents: [{ node_id: repository.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }],
  })
  store.appendEvent('run-created', {
    row: { run_id: runId, campaign_id: runId, state: 'planned', kind: 'graph-backed' },
    repository_parent_node_id: repository.node_id,
    readiness_parent_node_id: readiness.node_id,
  }, { aggregate_kind: 'run', aggregate_id: runId, node_id: readiness.node_id })
  store.appendEvent('run-started', { expected_state: 'planned' }, { aggregate_kind: 'run', aggregate_id: runId })
  return { store, runId, repository, readiness }
}

function output(store, envelope, marker) {
  return store.createNode({
    kind: 'finding', payload: { state: 'resolved', marker },
    parents: envelope.input_node_ids.map(node_id => ({ node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} })),
  })
}

test('unsealed dependencies create no attempts or leases', () => {
  const { store, runId } = fixture()
  const parent = ensureTask(store, { run_id: runId, label: 'parent', kind: 'fixture', payload: {} })
  ensureTask(store, { run_id: runId, label: 'child', kind: 'fixture', depends_on: [parent.id], payload: {} })
  const before = store.sequence()
  const issued = issueReadyTask(store, { run_id: runId, label: 'child', now: 1_800_000_000_000 })
  assert.deepEqual(issued, { issued: false, reason: 'task-dependencies-unsealed', task_id: `${runId}:child` })
  assert.equal(store.sequence(), before)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM leases').get().n, 0)
  store.close()
})

test('sealed dependency output becomes immutable child input', () => {
  const { store, runId } = fixture()
  const parent = ensureTask(store, { run_id: runId, label: 'parent', kind: 'fixture', payload: {} })
  ensureTask(store, { run_id: runId, label: 'child', kind: 'fixture', depends_on: [parent.id], payload: {} })
  const parentIssue = issueReadyTask(store, { run_id: runId, label: 'parent', now: 1_800_000_000_000 })
  const parentOutput = output(store, parentIssue.envelope, 'parent')
  completeTask(store, { envelope: parentIssue.envelope, output_node_id: parentOutput.node_id, now: 1_800_000_000_001 })
  const childIssue = issueReadyTask(store, { run_id: runId, label: 'child', now: 1_800_000_000_002 })
  assert.equal(childIssue.issued, true)
  assert.deepEqual(childIssue.envelope.input_node_ids, [parentOutput.node_id])
  assert.match(childIssue.envelope.input_hash, /^[a-f0-9]{64}$/)
  store.close()
})

test('foreign explicit inputs fail before attempt allocation', () => {
  const { store, runId } = fixture()
  const foreign = store.createNode({ kind: 'finding', payload: { state: 'open' } })
  ensureTask(store, { run_id: runId, label: 'foreign', kind: 'fixture', payload: { input_node_ids: [foreign.node_id] } })
  assert.throws(() => issueReadyTask(store, { run_id: runId, label: 'foreign', now: 1_800_000_000_000 }), /foreign-input-node/)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0)
  store.close()
})

test('renewal retains attempt and input hash beyond original expiry', () => {
  const { store, runId, readiness } = fixture()
  ensureTask(store, { run_id: runId, label: 'long', kind: 'fixture', payload: { input_node_ids: [readiness.node_id] } })
  const issuedAt = 1_800_000_000_000
  const issued = issueReadyTask(store, { run_id: runId, label: 'long', now: issuedAt })
  const originalExpiry = Date.parse(issued.envelope.lease_expires_at)
  const renewed = renewLease(store, {
    lease_id: issued.envelope.lease_id,
    attempt_id: issued.envelope.attempt_id,
    input_hash: issued.envelope.input_hash,
    now: issuedAt + LEASE_TTL_MS - 1,
  })
  assert.ok(Date.parse(renewed.expires_at) > originalExpiry)
  assert.equal(renewed.input_hash, issued.envelope.input_hash)
  assertActiveLease(store, issued.envelope, originalExpiry + 1)
  const node = output(store, issued.envelope, 'renewed')
  completeTask(store, { envelope: issued.envelope, output_node_id: node.node_id, now: originalExpiry + 1 })
  assert.equal(store.db.prepare('SELECT state FROM attempts WHERE id=?').get(issued.envelope.attempt_id).state, 'succeeded')
  assert.equal(store.db.prepare('SELECT state FROM leases WHERE id=?').get(issued.envelope.lease_id).state, 'released')
  store.close()
})

test('retry preserves task while issuing next deterministic attempt', () => {
  const { store, runId } = fixture()
  ensureTask(store, { run_id: runId, label: 'retry', kind: 'fixture', payload: {} })
  const first = issueReadyTask(store, { run_id: runId, label: 'retry', now: 1_800_000_000_000 })
  recordRetryableFailure(store, { envelope: first.envelope, reason: 'fixture', now: 1_800_000_000_001 })
  const second = issueReadyTask(store, { run_id: runId, label: 'retry', now: 1_800_000_000_002 })
  assert.equal(second.envelope.attempt_id, `${runId}:retry:attempt:2`)
  assert.equal(second.envelope.input_hash, first.envelope.input_hash)
  assert.equal(store.db.prepare('SELECT state FROM tasks WHERE id=?').get(`${runId}:retry`).state, 'running')
  store.close()
})
