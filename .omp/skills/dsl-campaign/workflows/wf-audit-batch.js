import { createTrustedAgent } from '../graph/workflow-runtime.js'

export const meta = {
  name: 'dsl-audit-batch',
  description: 'Final human audit: source rule plus baseline and updated describer renders',
  phases: [
    { title: 'Audit', detail: 'data-enginseer binds source prose to the before/after roundtrip records' },
  ],
}

// args: {
//   batch_id: string,
//   abilities: [{ ability_id, faction_id }],
//   baseline_roundtrip_report_path: string,
//   updated_roundtrip_report_path: string,
// }
//
// Run only after the post-apply roundtrip report is available and all mechanical gates pass.
// Returns source prose solely in the workflow result/session journal. The driver MUST present
// it to the maintainer and MUST NOT persist it under repo_root.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !Array.isArray(args.abilities) || !args.abilities.length)
  throw new Error('args.abilities required')
if (!args.baseline_roundtrip_report_path || !args.updated_roundtrip_report_path)
  throw new Error('both roundtrip report paths are required')
const graphAgent = createTrustedAgent({ driverArgs: args, invokeAgent: agent })

const PRE = args.repo_root
  ? `Repo root: ${args.repo_root} — cd there first; resolve every relative path there. ` +
    `The sibling raw-text store is read-only. Never write GW prose to any repository file.\n`
  : ''

const AUDIT_OUT = {
  type: 'object',
  required: ['batch_id', 'audits'],
  properties: {
    batch_id: { type: 'string' },
    audits: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'ability_id', 'faction_id', 'original_rule',
          'baseline_describer_output', 'updated_describer_output',
          'baseline_score', 'updated_score',
        ],
        properties: {
          ability_id: { type: 'string' },
          faction_id: { type: 'string' },
          original_rule: { type: 'string' },
          baseline_describer_output: { type: 'string' },
          updated_describer_output: { type: 'string' },
          baseline_score: { type: 'number' },
          updated_score: { type: 'number' },
        },
      },
    },
  },
}

phase('Audit')
const audit = await graphAgent(PRE + `Produce a maintainer-facing final audit for exactly these abilities. Read the specified ` +
`baseline and updated roundtrip reports. Retrieve every original rule verbatim from the raw-text ` +
`store; do not reconstruct it from a report preview. For each requested key, pair that source text with ` +
`the baseline report's English render and score, then the updated report's English render and score. ` +
`Return entries in input order. This output is ephemeral: it will be shown to the maintainer but never ` +
`written to the repository. Input:\n` +
JSON.stringify({
  batch_id: args.batch_id,
  abilities: args.abilities,
  baseline_roundtrip_report_path: args.baseline_roundtrip_report_path,
  updated_roundtrip_report_path: args.updated_roundtrip_report_path,
}),
{ agentType: 'data-enginseer', phase: 'Audit', schema: AUDIT_OUT, label: `audit:${args.batch_id}`, graphEphemeralKeys: ['raw_text', 'original_rule'] })
if (!audit) throw new Error('data-enginseer returned nothing — cannot surface final audit')
if (audit.audits.length !== args.abilities.length)
  throw new Error(`audit count ${audit.audits.length} does not match requested ${args.abilities.length}`)
for (let i = 0; i < args.abilities.length; i++) {
  const expected = args.abilities[i]
  const actual = audit.audits[i]
  if (actual.ability_id !== expected.ability_id || actual.faction_id !== expected.faction_id)
    throw new Error(`audit key mismatch at index ${i}`)
}
log(`audit ${args.batch_id}: ${audit.audits.length} ability render comparison(s) ready for maintainer review`)
return audit
