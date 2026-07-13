export const meta = {
  name: 'dsl-verify-batch',
  description: 'Post-apply verification: skitarius gates ∥ cogitator lever diff ∥ psyker cold-read',
  phases: [
    { title: 'Gates', detail: 'validate / test / translate-smoke / drift in the loop workspace' },
    { title: 'Levers', detail: 'cruncher-lever before/after diff vs committed baseline' },
    { title: 'ColdRead', detail: 'psyker intelligibility pass over the new renders, per faction' },
  ],
}

// args: {
//   batch_id: string,
//   ability_ids: string[],           // the batch (worklist ids just applied by warpsmith)
//   faction_ids: string[],           // factions touched by the batch
//   touched_files: string[],         // data files warpsmith edited
//   gates?: string[],                // default: all four
// }
// Run AFTER warpsmith applied the batch to the working tree and BEFORE the batch
// commit: cogitator's baseline "committed" diffs working tree vs jj-committed state.
// Returns { batch_id, skitarius, cogitator, psyker: [...] } — the driver interprets:
// !overall_pass, verdict:"regressed", or any severity-3 finding fails the batch.

// The runtime may deliver args as a JSON string — normalize before touching fields.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !Array.isArray(args.ability_ids) || !args.ability_ids.length) throw new Error('args.ability_ids required')
if (!Array.isArray(args.faction_ids) || !args.faction_ids.length) throw new Error('args.faction_ids required')
const GATES = args.gates || ['validate', 'test', 'translate-smoke', 'drift']
// Pin every agent to the loop workspace: subagents inherit the DRIVER session's cwd,
// which may be a different checkout of this repo (a parallel session's working copy).
const PRE = args.repo_root
  ? `Repo root: ${args.repo_root} — cd there first; run every command and resolve every ` +
    `relative path (including ../40kdc-abilities and ../40kdc-embeddings) against it. ` +
    `Never read or write any other checkout of this repo.\n`
  : ''

// ---- frozen Output contracts, transcribed to JSON Schema (do not redesign) ----
const SKITARIUS_OUT = {
  type: 'object', required: ['gates_run', 'overall_pass', 'not_run'],
  properties: {
    gates_run: { type: 'array', items: { type: 'object', required: ['gate', 'command', 'pass'],
      properties: { gate: { type: 'string' }, command: { type: 'string' }, pass: { type: 'boolean' },
        failures: { type: 'array', items: { type: 'string' } } } } },
    overall_pass: { type: 'boolean' },
    not_run: { type: 'array', items: { type: 'string' } },
  },
}
const COGITATOR_OUT = {
  type: 'object', required: ['ability_ids', 'levers_before', 'levers_after', 'regressions', 'additions', 'verdict'],
  properties: {
    ability_ids: { type: 'array', items: { type: 'string' } },
    levers_before: { type: 'object', additionalProperties: true }, levers_after: { type: 'object', additionalProperties: true },
    regressions: { type: 'array', items: { type: 'object', required: ['ability_id', 'lever', 'change'],
      properties: { ability_id: { type: 'string' }, lever: { type: 'string' }, change: { type: 'string' } } } },
    additions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    verdict: { enum: ['clean', 'regressed'] },
  },
}
const PSYKER_OUT = {
  type: 'object', required: ['faction_id', 'findings', 'clean'],
  properties: {
    faction_id: { type: 'string' },
    findings: { type: 'array', items: { type: 'object',
      required: ['ability_id', 'describer_output', 'problem', 'player_reading', 'severity'],
      properties: { ability_id: { type: 'string' }, describer_output: { type: 'string' },
        problem: { enum: ['ambiguous', 'misleading', 'ungrammatical', 'jargon-leak', 'missing-clause-signal'] },
        player_reading: { type: 'string' }, severity: { type: 'integer', minimum: 1, maximum: 3 } } } },
    clean: { type: 'array', items: { type: 'string' } },
  },
}

const idsByFaction = {}
for (const f of args.faction_ids) idsByFaction[f] = []
for (const id of args.ability_ids) {
  // shape-led batches span factions; ability ids arrive as "faction/ability_id" or bare
  const slash = id.indexOf('/')
  if (slash > 0 && idsByFaction[id.slice(0, slash)]) idsByFaction[id.slice(0, slash)].push(id.slice(slash + 1))
  else args.faction_ids.forEach(f => idsByFaction[f].push(id))
}

const [skitarius, cogitator, ...psyker] = await parallel([
  () => agent(
    PRE + `Run exactly these mechanical gates in this workspace and report honestly (a gate you ` +
    `could not run goes in not_run, never in gates_run as passed). Input:\n` +
    JSON.stringify({ gates: GATES, touched: { factions: args.faction_ids, files: args.touched_files || [] } }),
    { agentType: 'skitarius', phase: 'Gates', schema: SKITARIUS_OUT, label: `gates:${args.batch_id}` }
  ),
  () => agent(
    PRE + `Diff cruncher levers for these abilities, working tree vs committed. Any dropped lever is a ` +
    `regression regardless of how much prettier the new phrasing reads. Input:\n` +
    JSON.stringify({ ability_ids: args.ability_ids.map(i => i.includes('/') ? i.split('/')[1] : i),
      factions: args.faction_ids, baseline: 'committed' }),
    { agentType: 'cogitator', phase: 'Levers', schema: COGITATOR_OUT, label: `levers:${args.batch_id}` }
  ),
  ...args.faction_ids.map(f => () =>
    agent(
      PRE + `Cold-read the describer renders for these just-edited abilities. Input:\n` +
      JSON.stringify({ faction_id: f, scope: idsByFaction[f] }),
      { agentType: 'psyker', phase: 'ColdRead', schema: PSYKER_OUT, label: `coldread:${f}:${args.batch_id}` }
    )
  ),
])

const psy = psyker.filter(Boolean)
const sev3 = psy.flatMap(p => (p.findings || []).filter(x => x.severity === 3))
log(`verify ${args.batch_id}: gates=${skitarius ? (skitarius.overall_pass ? 'PASS' : 'FAIL') : 'ERROR'} ` +
  `levers=${cogitator ? cogitator.verdict : 'ERROR'} sev3=${sev3.length}`)
return { batch_id: args.batch_id, skitarius, cogitator, psyker: psy }
