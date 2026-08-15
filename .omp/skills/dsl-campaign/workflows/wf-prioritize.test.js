import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { canonicalJson, sha256 } from '../graph/canonical.js'

const WORKFLOW = new URL('./wf-prioritize.js', import.meta.url)

function loadWorkflow() {
  const source = readFileSync(WORKFLOW, 'utf8')
    .replace(/import \{ canonicalJson, sha256 \} from '\.\.\/graph\/canonical\.js'\n/, '')
    .replace(/import \{ GraphStore \} from '\.\.\/graph\/store\.js'\n/, '')
    .replace(/import \{ wholeGraphPriorities \} from '\.\.\/graph\/retrieval\.js'\n/, '')
    .replace(/import \{ createTrustedAgent \} from '\.\.\/graph\/workflow-runtime\.js'\n/, '')
    .replace('export const meta =', 'const meta =')
  return new (Object.getPrototypeOf(async function () {}).constructor)(
    'args', 'agent', 'parallel', 'phase', 'log', 'canonicalJson', 'sha256', 'GraphStore',
    'wholeGraphPriorities', 'createTrustedAgent', source,
  )
}

test('uses the prepared prioritize DAG task labels, definitions, and frozen curation input', async () => {
  const scoutShapes = [
    { shape: { pattern: 'zeta' }, exclude_factions: ['fixture-a'] },
    { shape: { condition_type: 'charged' }, exclude_factions: [] },
  ]
  const ranking = {
    eligible: [
      { faction_id: 'fixture-a', ability_id: 'ability-a' },
      { faction_id: 'fixture-b', ability_id: 'ability-b' },
    ],
    excluded: [{ faction_id: 'fixture-c', ability_id: 'ability-c' }],
  }
  const artifacts = {
    roundtrip_report_path: '/reports/roundtrip.json',
    sub080_summary: [{ faction: 'fixture-a', mean: 0.7, n_below: 1, worst: [{ id: 'ability-a', cos: 0.5 }] }],
    loop_state_paths: ['/loop-state/roundtrip.md'],
    registry_excerpt: { campaigns: [], blocked_shapes: [] },
  }
  const excluded_claims = [{ faction_id: 'fixture-c', ability_id: 'ability-c', run_id: 'old' }]
  const calls = []
  const agent = async (_prompt, options) => {
    calls.push(options)
    if (options.phase === 'Scout') return { shape: options.taskPayload.shape, candidates: [] }
    return {
      mode: 'curate',
      priorities: [{ target: 'fixture-a/ability-a', reason: 'fixture', expected_gain: 'fidelity' }],
    }
  }
  class FakeStore { close() {} }
  const createTrustedAgent = ({ invokeAgent }) => (prompt, options) => invokeAgent(prompt, options)
  const output = await loadWorkflow()(
    {
      repo_root: '/repo', graph_root: '/graph', run_id: 'c013', worklist_cap: 7,
      scout_shapes: scoutShapes, artifacts, excluded_claims,
    },
    agent,
    async tasks => Promise.all(tasks.map(task => task())),
    () => {}, () => {}, canonicalJson, sha256, FakeStore, () => ranking, createTrustedAgent,
  )

  const canonical = scoutShapes
    .map(shape => ({ shape, encoded: canonicalJson(shape) }))
    .sort((left, right) => left.encoded.localeCompare(right.encoded))
  const labels = canonical.map(({ encoded }, index) =>
    `prioritize:scout:${String(index + 1).padStart(2, '0')}:${sha256(encoded).slice(0, 12)}`)
  assert.deepEqual(calls.slice(0, 2).map(call => call.label), labels)
  assert.ok(calls.slice(0, 2).every(call => call.agentType === 'swarmlord'))
  assert.ok(calls.slice(0, 2).every(call => call.taskKind === 'prioritize-scout'))
  assert.deepEqual(calls.slice(0, 2).map(call => call.taskPayload), canonical.map(({ shape }) => ({ shape })))
  assert.ok(calls.slice(0, 2).every(call => Array.isArray(call.dependsOn) && call.dependsOn.length === 0))

  const curator = calls.at(-1)
  assert.equal(curator.label, 'prioritize:curate')
  assert.equal(curator.agentType, 'inquisitor')
  assert.equal(curator.taskKind, 'prioritize-curate')
  assert.deepEqual(curator.dependsOn, labels)
  assert.deepEqual(curator.taskPayload, {
    worklist_cap: 7,
    artifacts,
    excluded_claims,
    frozen_whole_graph_ranking: ranking,
  })
  assert.equal(output.curation.priorities[0].target, 'fixture-a/ability-a')
})
