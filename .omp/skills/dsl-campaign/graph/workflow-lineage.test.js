import { canonicalJson, sha256 } from './canonical.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTrustedAgent } from './workflow-runtime.js'
import { GraphStore } from './store.js'
import { assertInputEnvelope, createExecutionEnvelope, sanitizeGraphPayload, sealOutput, trustedExecutionIdentity, verifyGraphIpBoundary } from './workflow-lineage.js'

function envelope(overrides = {}) {
  return createExecutionEnvelope({
    run_id: 'run-1', task_id: 'task-1', attempt_id: 'attempt-1', lease_id: 'lease-1',
    lease_expires_at: '2099-01-01T00:00:00.000Z', input_node_ids: [], input_hash: 'a'.repeat(64), ...overrides,
  })
}

function activeRunFixture(parent = null) {
  const root = mkdtempSync(join(tmpdir(), 'trusted-agent-graph-'))
  const store = new GraphStore(root)
  const input = parent || store.createNode({ kind: 'decision', payload: { state: 'answered' } })
  store.appendEvent('run-created', {
    row: { run_id: 'run-1', campaign_id: 'campaign-run-1', state: 'planned' },
    input_node_id: input.node_id,
  }, { aggregate_kind: 'run', aggregate_id: 'run-1', node_id: input.node_id })
  store.appendEvent('run-started', { expected_state: 'planned' }, { aggregate_kind: 'run', aggregate_id: 'run-1' })
  store.close()
  return { root, input }
}

function returnedLineage(prompt) {
  return JSON.parse(prompt.split('_lineage:\n').at(-1))
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
  assert.deepEqual(one.parents.map(parent => parent.node_id), input.input_node_ids)
})

test('trusted execution identity is deterministic, prompt-sensitive, and model-sensitive', () => {
  const identity = {
    source_snapshot_id: 'snapshot-1',
    agent_contract_id: 'formalizer-contract@1',
    model_id: 'provider/model-2026-08',
    prompt_id: 'formalizer',
    prompt_version: 1,
    prompt_sha256: sha256('rendered prompt'),
    invoked_prompt_sha256: sha256('rendered prompt\nlineage'),
    output_schema_sha256: sha256(canonicalJson({ type: 'object' })),
    ordered_parent_evidence_ids: ['a'.repeat(64), 'b'.repeat(64)],
  }
  const one = trustedExecutionIdentity(identity)
  const two = trustedExecutionIdentity(identity)
  assert.deepEqual(one, two)
  assert.equal(one.independence_group_id, sha256(canonicalJson({
    source_snapshot_id: identity.source_snapshot_id,
    agent_contract_id: identity.agent_contract_id,
    model_id: identity.model_id,
    prompt_sha256: identity.prompt_sha256,
    output_schema_sha256: identity.output_schema_sha256,
    ordered_parent_evidence_ids: identity.ordered_parent_evidence_ids,
  })))
  assert.notEqual(one.independence_group_id, trustedExecutionIdentity({
    ...identity,
    prompt_sha256: sha256('changed prompt'),
  }).independence_group_id)
  assert.notEqual(one.independence_group_id, trustedExecutionIdentity({
    ...identity,
    model_id: 'provider/model-2026-09',
  }).independence_group_id)
})

test('sealed outputs persist authoritative execution identity', () => {
  const executionIdentity = trustedExecutionIdentity({
    source_snapshot_id: 'snapshot-1',
    agent_contract_id: 'formalizer-contract@1',
    model_id: 'provider/model-2026-08',
    prompt_id: 'formalizer',
    prompt_version: 1,
    prompt_sha256: sha256('rendered prompt'),
    invoked_prompt_sha256: sha256('rendered prompt\nlineage'),
    output_schema_sha256: sha256(canonicalJson({ type: 'object' })),
    ordered_parent_evidence_ids: [],
  })
  const sealed = sealOutput('child', { finding: 'clear' }, envelope(), { execution_identity: executionIdentity })
  assert.deepEqual(sealed.payload.execution_identity, executionIdentity)
})

test('trusted agent persists and returns the scheduler-issued lineage-bound child', async () => {
  const { root, input } = activeRunFixture()
  const graphAgent = createTrustedAgent({
    driverArgs: { graph_root: root, run_id: 'run-1' },
    invokeAgent: async (prompt, options) => {
      assert.ok(options.schema.required.includes('_lineage'))
      return { value: 1, _lineage: returnedLineage(prompt) }
    },
  })
  const result = await graphAgent('work', {
    label: 'child', agentType: 'helper', inputNodeIds: [input.node_id],
    schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
  })
  assert.equal(result.value, 1)
  const store = new GraphStore(root)
  assert.ok(store.hasNode(result.sealed_output_node_id))
  assert.deepEqual(store.db.prepare('SELECT parent_node_id FROM edges WHERE child_node_id=?').all(result.sealed_output_node_id).map(row => ({ ...row })), [{ parent_node_id: input.node_id }])
  assert.equal(store.db.prepare("SELECT state FROM tasks WHERE id='run-1:child'").get().state, 'succeeded')
  store.close()
})

test('authoritative trusted agent fails closed before scheduling or model invocation when identity is absent', async () => {
  for (const missing of ['modelId', 'promptId', 'promptVersion', 'agentContractId']) {
    const { root, input } = activeRunFixture()
    let calls = 0
    const graphAgent = createTrustedAgent({
      driverArgs: { graph_root: root, run_id: 'run-1' },
      invokeAgent: async () => {
        calls += 1
        return null
      },
    })
    const options = {
      label: 'authoritative-child',
      agentType: 'formalizer',
      authoritative: true,
      modelId: 'provider/model-2026-08',
      promptId: 'formalizer',
      promptVersion: 1,
      agentContractId: 'formalizer-contract@1',
      sourceSnapshotId: 'snapshot-1',
      inputNodeIds: [input.node_id],
      schema: { type: 'object', properties: {} },
    }
    delete options[missing]
    await assert.rejects(() => graphAgent('work', options), /nonempty/)
    assert.equal(calls, 0)
    const store = new GraphStore(root)
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM tasks WHERE id='run-1:authoritative-child'").get().n, 0)
    store.close()
  }
})

test('authoritative trusted agent seals exact execution identity and reuses a correlation group', async () => {
  const { root, input } = activeRunFixture()
  const calls = []
  const graphAgent = createTrustedAgent({
    driverArgs: { graph_root: root, run_id: 'run-1' },
    invokeAgent: async (prompt, options) => {
      calls.push({ prompt, schema: options.schema })
      return { value: 1, _lineage: returnedLineage(prompt) }
    },
  })
  const options = {
    agentType: 'formalizer',
    authoritative: true,
    modelId: 'provider/model-2026-08',
    promptId: 'formalizer',
    promptVersion: 1,
    agentContractId: 'formalizer-contract@1',
    sourceSnapshotId: 'snapshot-1',
    orderedParentEvidenceNodeIds: [input.node_id],
    inputNodeIds: [input.node_id],
    schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
  }
  const first = await graphAgent('work', { ...options, label: 'authoritative-first' })
  const second = await graphAgent('work', { ...options, label: 'authoritative-second' })
  assert.equal(first.execution_identity.independence_group_id, second.execution_identity.independence_group_id)
  assert.equal(first.execution_identity.prompt_sha256, sha256('work'))
  assert.equal(first.execution_identity.invoked_prompt_sha256, sha256(calls[0].prompt))
  assert.equal(first.execution_identity.output_schema_sha256, sha256(canonicalJson(calls[0].schema)))
  const store = new GraphStore(root)
  const persisted = JSON.parse(store.db.prepare('SELECT payload_json FROM nodes WHERE node_id=?').get(first.sealed_output_node_id).payload_json)
  assert.deepEqual(persisted.execution_identity, first.execution_identity)
  store.close()
})

test('trusted agent rejects copied cross-task echo', async () => {
  const { root } = activeRunFixture()
  const graphAgent = createTrustedAgent({
    driverArgs: { graph_root: root, run_id: 'run-1' },
    invokeAgent: async prompt => ({ value: 1, _lineage: { ...returnedLineage(prompt), task_id: 'wrong' } }),
  })
  await assert.rejects(() => graphAgent('work', { label: 'child', agentType: 'helper', schema: { type: 'object', properties: {} } }), /lineage mismatch/)
})

test('trusted agent rejects released, expired, and mismatched scheduler leases atomically', async () => {
  for (const mutation of [
    payload => ({ state: 'released', payload }),
    payload => ({ state: 'superseded', payload }),
    payload => ({ state: 'active', payload: { ...payload, expires_at: '2000-01-01T00:00:00.000Z' } }),
    payload => ({ state: 'active', payload: { ...payload, task_id: 'other-task' } }),
    payload => ({ state: 'active', payload: { ...payload, attempt_id: 'other-attempt' } }),
    payload => ({ state: 'active', payload: { ...payload, input_hash: 'b'.repeat(64) } }),
  ]) {
    const { root } = activeRunFixture()
    const graphAgent = createTrustedAgent({
      driverArgs: { graph_root: root, run_id: 'run-1' },
      invokeAgent: async prompt => {
        const issued = returnedLineage(prompt)
        const mutator = new GraphStore(root)
        const lease = mutator.db.prepare('SELECT payload_json FROM leases WHERE id=?').get(issued.lease_id)
        const next = mutation(JSON.parse(lease.payload_json))
        mutator.db.prepare('UPDATE leases SET state=?,payload_json=? WHERE id=?').run(next.state, JSON.stringify(next.payload), issued.lease_id)
        mutator.close()
        return { value: 1, _lineage: issued }
      },
    })
    await assert.rejects(() => graphAgent('work', { label: 'child', agentType: 'helper', schema: { type: 'object', properties: {} } }), /active graph lease/)
    const store = new GraphStore(root)
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
  const incidentalFragment = 'selected target'
  writeFileSync(join(rawStore, 'index.json'), JSON.stringify({
    schema_version: 1,
    factions: {
      fixture: {
        'defensive-primitive': { faction: 'Fixture', raw_text: prohibited },
        'structured-fragment': { faction: 'Fixture', target: incidentalFragment },
      },
    },
  }))
  const store = new GraphStore(join(root, 'graph'))
  store.createNode({ kind: 'finding', payload: { faction_id: 'fixture', ability_id: 'safe-name', summary: 'community-authored defensive summary' } })
  store.createNode({ kind: 'finding', payload: { summary: incidentalFragment } })
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
