import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { canonicalSourceText, persistClaimExtraction, persistSourceSnapshot, resolveSourceBinding } from '../graph/formalization.js'
import { MECHANIC_REGISTRY, mechanicClaimAdapter } from '../graph/mechanic-claims.js'
import { completeTask, ensureTask, issueReadyTask } from '../graph/scheduler.js'
import { GraphStore } from '../graph/store.js'
const WORKFLOW = new URL('./wf-formalize-batch.js', import.meta.url)

function loadWorkflow() {
  const source = readFileSync(WORKFLOW, 'utf8')
    .replace(/import \{ readFileSync \} from 'node:fs'\n/, '')
    .replace(/import \{ join \} from 'node:path'\n/, '')
    .replace(/import \{\n[\s\S]*?\n\} from '\.\.\/graph\/formalization\.js'\n/, '')
    .replace(/import \{ MECHANIC_REGISTRY, mechanicClaimAdapter \} from '\.\.\/graph\/mechanic-claims\.js'\n/, '')
    .replace(/import \{ failTask, ensureTask, issueReadyTask \} from '\.\.\/graph\/scheduler\.js'\n/, '')
    .replace(/import \{ GraphStore \} from '\.\.\/graph\/store\.js'\n/, '')
    .replace(/import \{ createTrustedAgent \} from '\.\.\/graph\/workflow-runtime\.js'\n/, '')
    .replaceAll('export const ', 'const ')
  return new (Object.getPrototypeOf(async function () {}).constructor)(
    'args', 'agent', 'pipeline', 'parallel', 'log', 'readFileSync', 'join',
    'canonicalSourceText', 'resolveSourceBinding', 'persistSourceSnapshot', 'persistClaimExtraction', 'MECHANIC_REGISTRY', 'mechanicClaimAdapter',
    'failTask', 'ensureTask', 'issueReadyTask', 'GraphStore', 'createTrustedAgent', source,
  )
}

const model_identities = { who: 'fixture/who@1', when: 'fixture/when@1', what: 'fixture/what@1', formalizer: 'fixture/formalizer@1' }
const ability = { faction_id: 'fixture-faction', ability_id: 'fixture-ability' }
const sourceText = 'When this fabricated ability is selected, its friendly unit gains +1 Move until end of turn.'

function formalOutput({ legacy = false } = {}) {
  const assertion = {
    extraction_local_id: 'modifier',
    proposition: { schema_id: '40k.mechanic-claim', schema_version: '1', value: { predicate: 'mechanic.trigger', arguments: [], qualifiers: [] } },
    polarity: 'affirms', modality: 'asserted',
    evidence_bindings: [{ kind: 'source_span', start: 0, end: Buffer.byteLength(sourceText), coordinate_unit: 'utf8_byte' }],
    derivation_parent_labels: [],
  }
  if (legacy) assertion.claim_id = 'legacy-claim-id'
  return {
    clauses: [{ extraction_local_id: 'whole-source', start: 0, end: Buffer.byteLength(sourceText) }],
    assertions: [assertion],
    unresolved: [{ extraction_local_id: 'uncertain-duration', extraction_local_focus: ['modifier'], kind: 'ambiguous', evidence_bindings: [], candidate_local_labels: ['modifier'], blocks_obligations: ['represent'] }],
    signatures: { aggregate: {}, assertions: [{ extraction_local_id: 'modifier', signature: {} }] },
    completeness: { state: 'disputed', obligations_checked: ['represent'] },
  }
}

function harness({ legacy = false } = {}) {
  const calls = []
  const persisted = []
  const sourceSnapshots = []
  class Store { close() {} }
  const sourceNode = 'source-node'
  const helpers = { who: 'who-node', when: 'when-node', what: 'what-node' }
  const graphAgent = async (prompt, options) => {
    assert.equal(sourceSnapshots.length, 1, 'source snapshot must exist before any model invocation')
    calls.push({ prompt, options })
    if (options.label.endsWith(':who')) return { sealed_output_node_id: helpers.who }
    if (options.label.endsWith(':when')) return { sealed_output_node_id: helpers.when }
    if (options.label.endsWith(':what')) return { sealed_output_node_id: helpers.what }
    return {
      ...formalOutput({ legacy }), execution_envelope: { input_node_ids: [helpers.who, helpers.when, helpers.what] },
      execution_identity: { model_id: model_identities.formalizer, prompt_sha256: 'p'.repeat(64), output_schema_sha256: 's'.repeat(64), agent_contract_id: 'inquisitor@1' },
    }
  }
  return {
    calls, persisted, sourceSnapshots,
    dependencies: {
      readFileSync: () => JSON.stringify([{ ...ability, raw_text: sourceText }]), join: (...parts) => parts.join('/'),
      canonicalSourceText: entry => entry.raw_text,
      resolveSourceBinding: () => ({ store_key: 'fixture-faction/fixture-ability', byte_hash: 'b'.repeat(64) }),
      persistSourceSnapshot: (_store, value) => { sourceSnapshots.push(value); return { source_snapshot_id: 'snapshot-id', source_node_id: sourceNode } },
      persistClaimExtraction: (_store, value) => {
        if (value.assertions.some(assertion => 'claim_id' in assertion)) throw new TypeError('claim_id is not allowed in v1 extraction')
        persisted.push(value)
        return { extraction_id: 'extraction-id', claim_set_id: 'claim-set-id', certificate_node_id: 'certificate-node' }
      },
      failTask: () => {}, ensureTask: () => {}, issueReadyTask: () => ({ issued: true, envelope: { input_node_ids: [] } }), GraphStore: Store,
      createTrustedAgent: () => graphAgent,
    },
  }
}

async function run(value, overrides = {}) {
  const deps = value.dependencies
  return loadWorkflow()(
    { repo_root: '/repo', graph_root: '/graph', run_id: 'run', raw_store_root: '/raw', model_identities, abilities: [ability], ...overrides },
    () => { throw new Error('raw agent must be wrapped') },
    async (items, work) => Promise.all(items.map(work)), async tasks => Promise.all(tasks.map(task => task())), () => {},
    deps.readFileSync, deps.join, deps.canonicalSourceText, deps.resolveSourceBinding, deps.persistSourceSnapshot, deps.persistClaimExtraction, MECHANIC_REGISTRY, {},
    deps.failTask, deps.ensureTask, deps.issueReadyTask, deps.GraphStore, deps.createTrustedAgent,
  )
}

async function runRealPersistenceWorkflow() {
  const root = mkdtempSync(join(tmpdir(), 'wf-formalize-real-'))
  const raw = join(root, 'raw'); const graph = join(root, 'graph')
  mkdirSync(raw)
  writeFileSync(join(raw, 'fixture-faction.json'), JSON.stringify([{ ...ability, raw_text: sourceText, source: { kind: 'json', ref: 'fabricated://wf', edition: '11e', phases: ['Command'] } }]))
  const seed = new GraphStore(graph)
  const repository = seed.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 4, policy_version: 2 } })
  const readiness = seed.createNode({ kind: 'decision', payload: {} })
  seed.appendEvent('run-created', { row: { run_id: 'run', campaign_id: 'run', state: 'planned', kind: 'graph-backed' }, repository_parent_node_id: repository.node_id, readiness_parent_node_id: readiness.node_id }, { aggregate_kind: 'run', aggregate_id: 'run', node_id: readiness.node_id })
  seed.appendEvent('run-started', { expected_state: 'planned' }, { aggregate_kind: 'run', aggregate_id: 'run' })
  seed.close()
  const trusted = () => async (_prompt, options) => {
    const store = new GraphStore(graph)
    try {
      if (options.label.endsWith(':who') || options.label.endsWith(':when') || options.label.endsWith(':what')) {
        const sourceTask = store.db.prepare('SELECT node_id FROM tasks WHERE id=?').get('run:ability:fixture-faction/fixture-ability:initial:source-retrieval')
        ensureTask(store, {
          run_id: 'run',
          label: options.label,
          kind: options.taskKind,
          depends_on: ['run:ability:fixture-faction/fixture-ability:initial:source-retrieval'],
          payload: { input_node_ids: [sourceTask.node_id] },
        })
        const envelope = issueReadyTask(store, { run_id: 'run', label: options.label, now: Date.now() }).envelope
        const output = store.createNode({ kind: 'decision', payload: { label: options.label }, parents: [{ node_id: sourceTask.node_id, edge_type: 'derived_from' }] })
        completeTask(store, { envelope, output_node_id: output.node_id })
        return { sealed_output_node_id: output.node_id }
      }
      const helperTaskIds = options.dependsOn.map(label => `run:${label}`)
      ensureTask(store, {
        run_id: 'run',
        label: options.label,
        kind: 'source-formalization',
        depends_on: helperTaskIds,
        payload: { input_node_ids: options.inputNodeIds },
      })
      const envelope = issueReadyTask(store, { run_id: 'run', label: options.label, now: Date.now() }).envelope
      return {
        ...formalOutput(),
        execution_envelope: envelope,
        execution_identity: {
          model_id: model_identities.formalizer,
          prompt_sha256: 'a'.repeat(64),
          output_schema_sha256: 'b'.repeat(64),
          agent_contract_id: 'inquisitor@1',
        },
      }
    } finally {
      store.close()
    }
  }
  const output = await loadWorkflow()(
    { repo_root: root, graph_root: graph, run_id: 'run', raw_store_root: raw, model_identities, abilities: [ability] },
    () => {}, async (items, work) => Promise.all(items.map(work)), async tasks => Promise.all(tasks.map(task => task())), () => {},
    readFileSync, join, canonicalSourceText, resolveSourceBinding, persistSourceSnapshot, persistClaimExtraction, MECHANIC_REGISTRY, mechanicClaimAdapter,
    () => {}, ensureTask, issueReadyTask, GraphStore, trusted,
  )
  const store = new GraphStore(graph)
  try {
    return { output, assertion: JSON.parse(store.db.prepare("SELECT payload_json FROM nodes WHERE kind='claim-assertion'").get().payload_json), binding: JSON.parse(store.db.prepare("SELECT payload_json FROM nodes WHERE kind='claim-evidence-binding'").get().payload_json) }
  } finally { store.close() }
}

describe('dsl formalize batch workflow', () => {
  test('persists workflow-local evidence and signatures through the real graph store', async () => {
    const value = await runRealPersistenceWorkflow()
    assert.equal(value.output.results[0].status, 'certified')
    assert.equal(value.binding.origin_id.length, 64)
    assert.equal(Object.hasOwn(value.binding, 'source_snapshot_id'), false)
    assert.deepEqual(value.assertion.signature.aggregate, {})
    assert.deepEqual(value.assertion.signature.assertion, {})
  })

  test('freezes source before parallel helpers and persists an unresolved closed extraction', async () => {
    const value = harness()
    const output = await run(value)
    assert.equal(output.results[0].status, 'certified')
    const helpers = value.calls.slice(0, 3)
    assert.deepEqual(helpers.map(call => call.options.label.split(':').at(-1)), ['who', 'when', 'what'])
    assert.ok(helpers.every(call => call.options.dependsOn.includes('ability:fixture-faction/fixture-ability:initial:source-retrieval')))
    assert.ok(helpers.every(call => call.options.inputNodeIds[0] === 'source-node'))
    assert.deepEqual(helpers.map(call => call.options.modelId), [model_identities.who, model_identities.when, model_identities.what])
    const formalizer = value.calls.at(-1)
    assert.deepEqual(formalizer.options.inputNodeIds, ['who-node', 'when-node', 'what-node'])
    assert.match(formalizer.prompt, /sealed_helper_node_ids/)
    assert.match(formalizer.prompt, /who-node/)
    assert.deepEqual(value.persisted[0].extraction_identity.ordered_parent_evidence_ids, ['who-node', 'when-node', 'what-node'])
    assert.equal(value.persisted[0].unresolved[0].kind, 'ambiguous')
  })

  test('rejects missing model identity before any model call', async () => {
    const value = harness()
    await assert.rejects(() => run(value, { model_identities: { ...model_identities, what: '' } }), /model_identities/)
    assert.equal(value.calls.length, 0)
    assert.equal(value.sourceSnapshots.length, 0)
  })

  test('rejects malformed legacy claim_id extraction shape', async () => {
    const value = harness({ legacy: true })
    await assert.rejects(() => run(value), /claim_id is not allowed/)
    assert.equal(value.persisted.length, 0)
  })
})
