import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const WORKFLOW = new URL('./wf-author-batch.js', import.meta.url)

function loadWorkflow() {
  const source = readFileSync(WORKFLOW, 'utf8').replace('export const meta =', 'const meta =')
  return new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'pipeline', 'parallel', 'log', source)
}

describe('dsl author batch workflow', () => {
  test('stage two keeps the original ability descriptor instead of the pipeline index', async () => {
    const ability = { ability_id: 'ability-zero', faction_id: 'faction-zero', name: 'Fixture Ability', ability_type: 'unit' }
    const calls = []
    const agent = async (prompt, options) => {
      calls.push({ prompt, options })
      if (options.phase === 'Retrieve') return { matches: [{ faction: ability.faction_id, raw_text: 'fixture' }] }
      if (options.phase === 'Decompose') return { lookups_needed: [] }
      if (options.phase === 'Assemble') {
        return {
          resisted_schema: false,
          confidence: 1,
          adopted_shapes: [],
          dsl: { type: 'sequence', steps: [] },
          self_grade: { describer_output: 'fixture' },
        }
      }
      return { refuted: false, divergences: [] }
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

    const output = await loadWorkflow()({ batch_id: 'workflow-regression', abilities: [ability] }, agent, pipeline, parallel, () => {})
    assert.equal(output.results.length, 1)
    assert.deepEqual(output.results[0].ability, ability)
    assert.equal(output.results[0].status, 'accepted')
    assert.ok(calls.every(({ prompt }) => !prompt.includes('undefined')))
  })
})
