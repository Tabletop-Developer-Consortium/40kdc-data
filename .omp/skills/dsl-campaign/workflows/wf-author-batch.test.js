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
    .replace("import { GraphStore } from '../graph/store.js'", '')
    .replace("import { projectedClaimSet, validateCandidateClaimCoverage, persistRepresentationClaimCoverage } from '../graph/retrieval.js'", '')
    .replace("import { sha256, canonicalJson } from '../graph/canonical.js'", '')
    .replace('export const meta =', 'const meta =')
  return new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'pipeline', 'parallel', 'log', 'createTrustedAgent', 'GraphStore', 'projectedClaimSet', 'validateCandidateClaimCoverage', 'persistRepresentationClaimCoverage', 'sha256', 'canonicalJson', source)
}

describe('dsl author batch workflow', () => {
  test('stage two keeps the original ability descriptor instead of the pipeline index', async () => {
    const ability = {
      ability_id: 'ability-zero', faction_id: 'faction-zero', name: 'Fixture Ability', ability_type: 'unit',
      claim_set_certificate_node_id: 'a'.repeat(64),
      construction_plan_node_id: 'b'.repeat(64),
      selected_evidence_node_ids: ['c'.repeat(64)],
      unmatched_claim_occurrence_ids: [],
    }
    const execution_envelopes = {}
    const calls = []
    for (const label of [
      'retrieve:ability-zero',
      'assemble:ability-zero#1', 'refute:ability-zero#1v1', 'refute:ability-zero#1v2',
    ]) execution_envelopes[label] = {
      run_id: 'run', task_id: `task:${label}`, attempt_id: `attempt:${label}`, lease_id: `lease:${label}`,
      lease_expires_at: '2099-01-01T00:00:00.000Z', input_node_ids: [], input_hash: 'd'.repeat(64), producer_contract_version: 2,
    }
    const graph_root = mkdtempSync(join(tmpdir(), 'wf-author-graph-'))
    const store = new GraphStore(graph_root)
    store.db.prepare('INSERT INTO runs(run_id,campaign_id,state) VALUES (?,?,?)').run('run', 'campaign', 'active')
    for (const envelope of Object.values(execution_envelopes)) {
      store.db.prepare('INSERT INTO tasks(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(envelope.task_id, envelope.run_id, 'running', '{}')
      store.db.prepare('INSERT INTO attempts(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(envelope.attempt_id, envelope.run_id, 'running', JSON.stringify({ input_hash: envelope.input_hash }))
      store.db.prepare('INSERT INTO leases(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(envelope.lease_id, envelope.run_id, 'active', JSON.stringify({ task_id: envelope.task_id, attempt_id: envelope.attempt_id, input_hash: envelope.input_hash, expires_at: envelope.lease_expires_at }))
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
          covered_claim_occurrence_ids: ['occurrence'],
          composition_seams: [],
          _lineage: execution_envelopes[options.label],
        }
      }
      return { refuted: false, divergences: [], _lineage: execution_envelopes[options.label] }
    }
    const parallel = async (tasks) => Promise.all(tasks.map((run) => run()))
    const trustedAgent = ({ invokeAgent }) => (prompt, options) => invokeAgent(prompt, options)
    const pipeline = async (items, retrieve, author) => {
      const results = []
      for (let index = 0; index < items.length; index += 1) {
        const retrieved = await retrieve(items[index], index)
        results.push(await author(retrieved, index))
      }
      return results
    }
    const coverageEvents = []
    class FakeStore {
      constructor() {
        this.db = { prepare: sql => ({ get: (...values) => {
          if (sql.includes('SELECT subject_ref')) return { subject_ref: 'ability:faction-zero/ability-zero' }
          if (sql.includes("kind='construction-plan'")) return { payload_json: JSON.stringify({
            claim_set_id: 'set', state: 'ready', selected_evidence_node_ids: ability.selected_evidence_node_ids,
            unmatched_claim_occurrence_ids: [], covered_claim_occurrence_ids: ['occurrence'], composition_seams: [],
          }) }
          if (sql.includes('FROM edges')) return { ok: 1 }
          if (sql.includes('FROM source_snapshots')) return { payload_json: JSON.stringify({ byte_hash: 'hash' }) }
          return null
        } }) }
      }
      hasNode() { return true }
      transaction(action) { return action() }
      createNode() { return { node_id: 'representation' } }
      appendEvent(type, payload) { coverageEvents.push({ type, payload }) }
      close() {}
    }
    const claimSet = { claim_set_id: 'set', source_snapshot_id: 'snapshot', source_claims: [{ claim_occurrence_id: 'occurrence', proposition: {}, signature: {} }], unresolved: [] }

    const validateCandidateClaimCoverage = ({ source_claims, plan, covered_claim_occurrence_ids, composition_seams, current_claim_occurrence_ids }) => {
      if (plan.state !== 'ready' || JSON.stringify(covered_claim_occurrence_ids) !== JSON.stringify(current_claim_occurrence_ids) || JSON.stringify(composition_seams) !== JSON.stringify(plan.composition_seams)) return { ok: false, reason: 'invalid-coverage' }
      return { ok: true, covered_claim_occurrence_ids: source_claims.map(claim => claim.claim_occurrence_id) }
    }
    const persistRepresentationClaimCoverage = (store, input) => {
      for (const claim_occurrence_id of input.claim_occurrence_ids) store.appendEvent('representation-coverage-recorded', { ...input, claim_occurrence_id })
    }
    const output = await loadWorkflow()({ batch_id: 'workflow-regression', abilities: [ability], graph_root, run_id: 'run', execution_envelopes }, agent, pipeline, parallel, () => {}, trustedAgent, FakeStore, () => claimSet, validateCandidateClaimCoverage, persistRepresentationClaimCoverage, () => 'hash', JSON.stringify)
    assert.equal(output.results.length, 1)
    assert.deepEqual(output.results[0].ability, ability)
    assert.equal(output.results[0].status, 'accepted')
    assert.equal(coverageEvents.length, 1)
    assert.equal(coverageEvents[0].payload.claim_occurrence_id, 'occurrence')
    assert.ok(calls.every(({ prompt }) => !prompt.includes('undefined')))
  })
})
