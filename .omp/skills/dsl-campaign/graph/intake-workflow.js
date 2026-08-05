import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { executePreparedIntake } from './intake.js'
import { createTrustedAgent } from './workflow-runtime.js'

export const meta = {
  name: 'claim-graph-certification-intake',
  description: 'Formalize selected source mechanics and certify current DSL without persisting source prose',
  phases: [
    { title: 'Formalize', detail: 'independent WHO, WHEN, and WHAT decomposition' },
    { title: 'Integrate', detail: 'inquisitor claim graph and deterministic coverage gate' },
    { title: 'Refute', detail: 'cold eversor review and terminal outcome' },
  ],
}

if (typeof args === 'string') args = JSON.parse(args)
if (!args?.repo_root || !args?.graph_root || !args?.prepared_batch_path) throw new Error('repo_root, graph_root, and prepared_batch_path required')
const prepared = JSON.parse(readFileSync(resolve(args.repo_root, args.prepared_batch_path), 'utf8'))
const rawStoreRoot = resolve(args.repo_root, '../40kdc-abilities')
const executionEnvelopes = Object.assign({}, ...prepared.entries.map(entry => entry.execution_envelopes))
const graphAgent = createTrustedAgent({
  driverArgs: { graph_root: resolve(args.repo_root, args.graph_root), execution_envelopes: executionEnvelopes },
  invokeAgent: agent,
})


const ROLE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['claims', 'confidence'],
  properties: {
    claims: { type: 'array', items: { type: 'object' } },
    confidence: { type: 'number' },
    uncovered: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['refuted', 'unresolved_findings', 'reason'],
  properties: {
    refuted: { type: 'boolean' }, reason: { type: 'string' },
    unresolved_findings: { type: 'array', items: { type: 'string' } },
  },
}

const result = await executePreparedIntake({
  repoRoot: args.repo_root,
  rawStoreRoot,
  prepared,
  analyze: async ({ entry, source_text, source_meta }) => {
    const common = { ability_id: entry.ability_id, faction_id: entry.faction_id, ability_type: 'unknown', raw_text: source_text }
    const [who, when, what] = await parallel([
      () => graphAgent(`Decompose WHO into own-words relational claims. Input: ${JSON.stringify(common)}`, { agentType: 'target-dummy', phase: 'Formalize', schema: ROLE_SCHEMA, label: `intake-who:${entry.ability_id}`, graphSourceTexts: [source_text] }),
      () => graphAgent(`Decompose WHEN into own-words timing claims. Input: ${JSON.stringify(common)}`, { agentType: 'chronomancer', phase: 'Formalize', schema: ROLE_SCHEMA, label: `intake-when:${entry.ability_id}`, graphSourceTexts: [source_text] }),
      () => graphAgent(`Decompose WHAT into own-words effect claims. Input: ${JSON.stringify(common)}`, { agentType: 'vox-hound', phase: 'Formalize', schema: ROLE_SCHEMA, label: `intake-what:${entry.ability_id}`, graphSourceTexts: [source_text] }),
    ])
    const claims = [...(who?.claims || []), ...(when?.claims || []), ...(what?.claims || [])].map((claim, index) => ({ id: `claim-${index + 1}`, ...claim }))
    const abilityFile = JSON.parse(readFileSync(join(args.repo_root, entry.dsl_path), 'utf8'))
    const candidate = abilityFile.find(item => (item.ability_id ?? item.id) === entry.ability_id)
    const approximation = JSON.stringify(candidate).includes('[APPROX]')
    const review = await graphAgent(`Cold-refute the CURRENT DSL against the source. Report only own-words findings. Input: ${JSON.stringify({ ...common, candidate, claims, source_hash: source_meta.byte_hash })}`,
      { agentType: 'eversor', phase: 'Refute', schema: REVIEW_SCHEMA, label: `intake-refute:${entry.ability_id}`, graphSourceTexts: [source_text] })
    const unresolved_findings = review?.unresolved_findings || []
    const uncovered = [...(who?.uncovered || []), ...(when?.uncovered || []), ...(what?.uncovered || [])]
    const certified = !approximation && !review?.refuted && !unresolved_findings.length && !uncovered.length && claims.length > 0
    return {
      outcome: certified ? 'certified' : review?.refuted ? 'refuted' : 'represented-gap',
      reason: certified ? 'independent formalization and cold review cover the current encoding' : review?.reason || 'certification gate retained a represented gap',
      claims,
      coverage: { covered_claims: certified ? claims.map(claim => claim.id) : [], composition_seams: [], required_checks: ['schema', 'integrity', 'four-port-render', 'lever-diff', 'cold-read'] },
      unresolved_findings: [...unresolved_findings, ...uncovered],
      approximation,
      reusable_fragment_ids: [],
      family_instance_ids: [],
    }
  },
})

log(`certification intake ${prepared.run_id}: ${result.outcomes.length} terminal outcomes`)
return result
