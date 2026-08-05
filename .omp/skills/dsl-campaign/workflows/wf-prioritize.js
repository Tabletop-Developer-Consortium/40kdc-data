import { GraphStore } from '../graph/store.js'
import { wholeGraphPriorities } from '../graph/retrieval.js'

import { createTrustedAgent } from '../graph/workflow-runtime.js'

export const meta = {
  name: 'dsl-prioritize',
  description: 'Scout shape families, then inquisitor curates the next campaign worklist',
  phases: [
    { title: 'Scout', detail: 'swarmlord family sweep per candidate shape (skipped when none)' },
    { title: 'Curate', detail: 'inquisitor picks the campaign from live signals' },
  ],
}

// args: {
//   scout_shapes: [{ shape: {effect_type|condition_type|pattern, example_ability_id?}, exclude_factions?: [] }],
//   artifacts: {                       // paths + small excerpts the driver prepared
//     roundtrip_report_path,           // the fresh --faction all report (json)
//     sub080_summary,                  // driver-computed: [{faction, mean, n_below, worst: [{id, cos}]}]
//     loop_state_paths,                // _private/loop-state/*.md in THIS workspace
//     registry_excerpt,                // campaigns[] statuses + blocked_shapes[] (dedup source)
//   },
//   worklist_cap: number,
// }
// Returns { scouts, curation }. The DRIVER materializes the worklist, writes the
// registry entry and roundtrip-<target>.md — no writes happen in this workflow.

// The runtime may deliver args as a JSON string — normalize before touching fields.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !args.artifacts) throw new Error('args.artifacts required')
const CAP = args.worklist_cap || 30
if (CAP > 40) throw new Error(`worklist_cap ${CAP} exceeds the hard cap of 40`)
if (!args.graph_root) throw new Error('args.graph_root required')
const priorityStore = new GraphStore(args.graph_root, { repositoryRoot: args.repo_root })
let ranking
try {
  ranking = wholeGraphPriorities(priorityStore, { repoRoot: args.repo_root })
} finally {
  priorityStore.close()
}
const graphAgent = createTrustedAgent({ driverArgs: args, invokeAgent: agent })
// Pin every agent to the loop workspace: subagents inherit the DRIVER session's cwd,
// which may be a different checkout of this repo (a parallel session's working copy).
const PRE = args.repo_root
  ? `Repo root: ${args.repo_root} — cd there first; run every command and resolve every ` +
    `relative path (including ../40kdc-abilities and ../40kdc-embeddings) against it. ` +
    `Never read or write any other checkout of this repo.\n`
  : ''

// ---- frozen Output contracts, transcribed to JSON Schema (do not redesign) ----
const SWARMLORD_OUT = {
  type: 'object',
  required: ['shape', 'candidates', 'keyword_sweep_terms', 'sweep_counts', 'estimated_family_size'],
  properties: {
    shape: { type: 'object', additionalProperties: true },
    candidates: { type: 'array', items: { type: 'object',
      required: ['ability_id', 'faction', 'evidence', 'match_strength', 'already_authored', 'current_encoding'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' }, evidence: { type: 'string' },
        match_strength: { enum: ['exact', 'near', 'stretch'] }, already_authored: { type: 'boolean' },
        current_encoding: { enum: ['empty-stub', 'opaque-grant', 'wrong-shape', 'none'] } } } },
    keyword_sweep_terms: { type: 'array', items: { type: 'string' } },
    sweep_counts: { type: 'object', additionalProperties: true },
    estimated_family_size: { type: 'integer' },
  },
}
const INQUISITOR_OUT = {
  type: 'object', required: ['mode', 'priorities'],
  properties: {
    mode: { enum: ['curate', 'review'] },
    priorities: { type: 'array', items: { type: 'object', required: ['target', 'reason', 'expected_gain'],
      properties: { target: { type: 'string' }, reason: { type: 'string' },
        expected_gain: { enum: ['fidelity', 'coverage', 'lever', 'schema-unblock'] } } } },
    reviews: { type: 'array', items: { type: 'object', additionalProperties: true } },
    inbox_updates: { type: 'array', items: { type: 'object', additionalProperties: true,
      required: ['mechanic', 'resists_schema', 'proposal', 'also_unblocks'] } },
    escalate_to_user: { type: 'array', items: { type: 'string' } },
  },
}

phase('Scout')
const scouts = (await parallel((args.scout_shapes || []).map(s => () =>
  graphAgent(PRE + `Scout the cross-faction family for this shape. estimated_family_size counts exact+near only ` +
  `— stretches don't justify shapes. Input:\n` + JSON.stringify(s),
  { agentType: 'swarmlord', phase: 'Scout', schema: SWARMLORD_OUT,
    label: `scout:${s.shape.effect_type || s.shape.condition_type || s.shape.pattern}` })
))).filter(Boolean)

phase('Curate')
const curation = await graphAgent(PRE + `Curate the next campaign. Pick ONE coherent worklist chunk (≤ ${CAP} abilities) from the ` +
`sub-0.80-cosine corpus: per-faction worst tail, a swarmlord family (exact+near, family size ≥ 4), ` +
`or an inbox schema-unblock. Do not re-propose anything in registry blocked_shapes (its reopen_when ` +
`must be met with the new evidence cited). No cherry-picking easy chunks — draw from the worst tail ` +
`or a real family. Reserve escalate_to_user for genuine maintainer calls. Input:\n` +
JSON.stringify({
  mode: 'curate',
  artifacts: {
    roundtrip_report_path: args.artifacts.roundtrip_report_path,
    sub080_summary: args.artifacts.sub080_summary,
    loop_state_paths: args.artifacts.loop_state_paths,
    registry_excerpt: args.artifacts.registry_excerpt,
    agent_outputs: scouts,
    excluded_claims: args.excluded_claims || [],
    whole_graph_ranking: { eligible: ranking.eligible.slice(0, CAP * 4), excluded: ranking.excluded },
  },
}),
{ agentType: 'inquisitor', phase: 'Curate', schema: INQUISITOR_OUT, label: 'curate' })
if (!curation) throw new Error('inquisitor returned nothing — cannot pick a campaign')
const excluded = new Set((args.excluded_claims || []).map(claim =>
  typeof claim === 'string' ? claim : `${claim.faction_id}/${claim.ability_id}`))
const overlaps = curation.priorities.filter(priority => excluded.has(priority.target))
if (overlaps.length) throw new Error(`curation returned active claims: ${overlaps.map(priority => priority.target).join(', ')}`)
const eligible = new Set(ranking.eligible.map(candidate => `${candidate.faction_id}/${candidate.ability_id}`))
const outsideRanking = curation.priorities.filter(priority => !eligible.has(priority.target))
if (outsideRanking.length) throw new Error(`curation returned ineligible priorities: ${outsideRanking.map(priority => priority.target).join(', ')}`)

log(`curated: ${curation.priorities.length} priorities, ${scouts.length} families scouted` +
  (curation.escalate_to_user && curation.escalate_to_user.length ? `, ${curation.escalate_to_user.length} escalation(s)` : ''))
return { scouts, curation, ranking }
