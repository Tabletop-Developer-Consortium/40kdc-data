import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createTrustedAgent } from '../graph/workflow-runtime.js'
import { GraphStore } from '../graph/store.js'

const WORKFLOW = new URL('./wf-author-batch.js', import.meta.url)

function loadWorkflow() {
  const source = readFileSync(WORKFLOW, 'utf8')
    .replace("import { createTrustedAgent } from '../graph/workflow-runtime.js'", '')
    .replace('export const meta =', 'const meta =')
  return new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'pipeline', 'parallel', 'log', 'createTrustedAgent', source)
}

describe('dsl author batch workflow', () => {
  test('stage two keeps the original ability descriptor instead of the pipeline index', async () => {
    const ability = {
      ability_id: 'ability-zero', faction_id: 'faction-zero', name: 'Fixture Ability', ability_type: 'unit',
      source_formalization_certificate_node_id: 'a'.repeat(64),
      construction_plan_node_id: 'b'.repeat(64),
      selected_evidence_node_ids: ['c'.repeat(64)],
      unmatched_claim_ids: [],
    }
    const calls = []
    const execution_envelopes = {}
    for (const label of [
      'retrieve:ability-zero', 'who:ability-zero', 'when:ability-zero', 'what:ability-zero',
      'assemble:ability-zero#1', 'refute:ability-zero#1v1', 'refute:ability-zero#1v2',
    ]) execution_envelopes[label] = {
      run_id: 'run', task_id: `task:${label}`, attempt_id: `attempt:${label}`, lease_id: `lease:${label}`,
      lease_expires_at: '2099-01-01T00:00:00.000Z', input_node_ids: [], producer_contract_version: 1,
    }
    const graph_root = mkdtempSync(join(tmpdir(), 'wf-author-graph-'))
    const store = new GraphStore(graph_root)
    store.db.prepare('INSERT INTO runs(run_id,campaign_id,state) VALUES (?,?,?)').run('run', 'campaign', 'active')
    for (const envelope of Object.values(execution_envelopes)) {
      store.db.prepare('INSERT INTO tasks(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(envelope.task_id, envelope.run_id, 'running', '{}')
      store.db.prepare('INSERT INTO attempts(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(envelope.attempt_id, envelope.run_id, 'running', '{}')
      store.db.prepare('INSERT INTO leases(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(envelope.lease_id, envelope.run_id, 'active', JSON.stringify({ task_id: envelope.task_id, attempt_id: envelope.attempt_id, expires_at: envelope.lease_expires_at }))
    }
    store.close()
    const agent = async (prompt, options) => {
      calls.push({ prompt, options })
      if (options.phase === 'Retrieve') return { matches: [{ faction: ability.faction_id, raw_text: 'fixture' }], _lineage: execution_envelopes[options.label] }
      if (options.phase === 'Decompose') return { lookups_needed: [], _lineage: execution_envelopes[options.label] }
      if (options.phase === 'Assemble') {
        return {
          resisted_schema: false,
          confidence: 1,
          adopted_shapes: [],
          dsl: { type: 'sequence', steps: [] },
          self_grade: { describer_output: 'fixture' },
          _lineage: execution_envelopes[options.label],
        }
      }
      return { refuted: false, divergences: [], _lineage: execution_envelopes[options.label] }
    }
    const parallel = async (tasks) => Promise.all(tasks.map((run) => run()))
    const pipeline = async (items, retrieve, author) => {
      const results = []
      for (let index = 0; index < items.length; index += 1) {
        const retrieved = await retrieve(items[index], index)
        results.push(await author(retrieved, index))
      }
      return results
    }

    const output = await loadWorkflow()({ batch_id: 'workflow-regression', abilities: [ability], graph_root, execution_envelopes }, agent, pipeline, parallel, () => {}, createTrustedAgent)
    assert.equal(output.results.length, 1)
    assert.deepEqual(output.results[0].ability, ability)
    assert.equal(output.results[0].status, 'accepted')
    assert.ok(calls.every(({ prompt }) => !prompt.includes('undefined')))
  })
})
