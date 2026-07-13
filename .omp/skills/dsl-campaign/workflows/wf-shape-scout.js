export const meta = {
  name: 'dsl-shape-scout',
  description: 'Design a new DSL shape for a resisted mechanic — the kroot suite proposes, broadens, renders, and adversarially reviews it, emitting a warpsmith-ready shape package.',
  phases: [
    { title: 'Seed', detail: 'data-enginseer retrieves the resisted ability prose + committed DSL' },
    { title: 'Shape', detail: 'kroot-flesh-shaper proposes a new shape (spawns decomposers + enginseer)' },
    { title: 'Broaden', detail: 'kroot-lone-spear adjudicates faithful coverage (spawns swarmlord)' },
    { title: 'Trail', detail: 'kroot-trail-shaper specs the describer (spawns psyker)' },
    { title: 'War', detail: 'kroot-war-shaper attacks sprawl/flattening/parity/family (spawns eversor + swarmlord)' },
  ],
}

// args: {
//   repo_root?,
//   seed: { ability_id, faction_id, raw_text?, resisted_schema? },  // the needs-schema ability
//   family_threshold?: 4,      // faithful family bar (exact+near, flatten-excluded) — the shape gate
//   max_rounds?: 3,            // cyclical review rounds before forcing terminal
// }
// Returns { seed, status, shape_package, rounds } where status ∈
//   shipped-ready | existing-fits | rejected-sprawl | rejected-singleton | not-converged | no-prose
//   rounds: [{ round, flesh, lone, trail, war, verdict }] — the FULL review thread (loop-round capture).
//   shape_package (on shipped-ready) is warpsmith's implement input: schema branch + describer + faithful family + cost.
// NO repo writes happen here. Prose (GW IP) transits agent JSON and this run's journal only.
//
// Spawn-native: the kroot leads spawn their OWN helper children (flesh -> decomposers+enginseer,
// lone-spear -> swarmlord, trail -> psyker, war -> eversor+swarmlord). Nested spawns need
// task.maxRecursionDepth >= 2 and the agents discoverable in .omp/agents. Every kroot output must
// carry its child evidence; a missing-evidence output fails LOUD (spawn-unavailable) rather than
// shipping an unverified shape.

if (typeof args === 'string') args = JSON.parse(args)
if (!args || !args.seed || !args.seed.ability_id) throw new Error('args.seed.ability_id required')
const THRESHOLD = args.family_threshold || 4
const MAX_ROUNDS = args.max_rounds || 3
// Pin every agent to the loop workspace (subagents inherit the DRIVER cwd, which may be another checkout).
const PRE = args.repo_root
  ? `Repo root: ${args.repo_root} — cd there first; run every command and resolve every ` +
    `relative path (including ../40kdc-abilities and ../40kdc-embeddings) against it. ` +
    `Never read or write any other checkout of this repo.\n`
  : ''

// ---- frozen Output contracts, transcribed to JSON Schema (mirror the agent output: frontmatter) ----
const ENGINSEER_OUT = {
  type: 'object', required: ['matches', 'method'],
  properties: {
    matches: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'raw_text', 'has_dsl'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        raw_text: { type: ['string', 'null'] }, has_dsl: { type: 'boolean' },
        committed_dsl_path: { type: ['string', 'null'] },
        other_faction_copies: { type: 'array', items: { type: 'string' } } } } },
    comparison: { type: ['object', 'null'], additionalProperties: true }, method: { enum: ['index-lookup', 'grep', 'embeddings'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
}
const FLESH_OUT = {
  type: 'object',
  required: ['seed_ability_id', 'mechanic', 'decomposition', 'retrieval', 'proposed_shape', 'nearest_existing_shapes', 'self_grade'],
  properties: {
    seed_ability_id: { type: 'string' }, mechanic: { type: 'string' },
    decomposition: { type: 'object', required: ['who', 'when', 'what'],
      properties: { who: { type: ['object', 'null'], additionalProperties: true }, when: { type: ['object', 'null'], additionalProperties: true }, what: { type: ['object', 'null'], additionalProperties: true } } },
    retrieval: { type: ['object', 'null'], additionalProperties: true },
    proposed_shape: { type: 'object', required: ['name', 'kind', 'parameters', 'schema_sketch', 'seed_encoding'],
      properties: { name: { type: 'string' }, kind: { enum: ['effect-leaf', 'condition', 'container', 'modifier-extension'] },
        parameters: { type: 'array', items: { type: 'object', required: ['name', 'type', 'load_bearing'],
          properties: { name: { type: 'string' }, type: { type: 'string' }, load_bearing: { type: 'boolean' }, notes: { type: 'string' } } } },
        schema_sketch: { type: 'object', additionalProperties: true }, seed_encoding: { type: 'object', additionalProperties: true } } },
    nearest_existing_shapes: { type: 'array', items: { type: 'object', required: ['shape', 'why_rejected', 'flatten_risk'],
      properties: { shape: { type: 'string' }, why_rejected: { type: 'string' }, flatten_risk: { enum: ['high', 'medium', 'low'] } } } },
    self_grade: { type: 'object', required: ['verdict', 'confidence'],
      properties: { verdict: { enum: ['new-shape', 'existing-fits', 'singleton'] }, confidence: { type: 'number' }, concerns: { type: 'array', items: { type: 'string' } } } },
  },
}
const LONESPEAR_OUT = {
  type: 'object', required: ['proposed_shape_name', 'swarmlord_sweep', 'coverage', 'faithful_family_size', 'confidence'],
  properties: {
    proposed_shape_name: { type: 'string' }, swarmlord_sweep: { type: ['object', 'null'], additionalProperties: true },
    coverage: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'fit'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        fit: { enum: ['faithful', 'needs-param', 'would-flatten'] },
        match_strength: { enum: ['exact', 'near', 'stretch'] },
        param_needed: { type: ['string', 'null'] }, flatten_reason: { type: ['string', 'null'] } } } },
    faithful_family_size: { type: 'integer' },
    parameter_deltas: { type: 'array', items: { type: 'object', required: ['param', 'change', 'unblocks'],
      properties: { param: { type: 'string' }, change: { type: 'string' }, unblocks: { type: 'array', items: { type: 'string' } } } } },
    members_needing_own_shape: { type: 'array', items: { type: 'object', additionalProperties: true } }, confidence: { type: 'number' },
  },
}
const TRAIL_OUT = {
  type: 'object', required: ['proposed_shape_name', 'render_rules', 'port_notes', 'conformance_cases', 'psyker_read', 'cost', 'confidence'],
  properties: {
    proposed_shape_name: { type: 'string' },
    render_rules: { type: 'array', items: { type: 'object', required: ['form', 'template', 'expected_output'],
      properties: { form: { enum: ['inline-single-effect', 'container', 'condition-lead-in', 'condition-predicate', 'negated'] },
        template: { type: 'string' }, example_input: { type: 'object', additionalProperties: true }, expected_output: { type: 'string' } } } },
    shared_helpers: { type: 'array', items: { type: 'string' } }, port_notes: { type: 'array', items: { type: 'string' } },
    conformance_cases: { type: 'array', items: { type: 'object', required: ['case', 'expected_phrase'],
      properties: { case: { type: 'string' }, expected_phrase: { type: 'string' } } } },
    psyker_read: { type: ['object', 'null'], additionalProperties: true },
    cost: { type: 'object', required: ['spec_bump', 'schema_change', 'files'],
      properties: { spec_bump: { type: 'boolean' }, schema_change: { type: 'boolean' },
        files: { type: 'array', items: { type: 'string' } }, conformance_cases: { type: 'integer' } } },
    confidence: { type: 'number' },
  },
}
const WAR_OUT = {
  type: 'object', required: ['proposed_shape_name', 'eversor_refutations', 'swarmlord_recheck', 'findings', 'verdict', 'confidence'],
  properties: {
    proposed_shape_name: { type: 'string' },
    eversor_refutations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    swarmlord_recheck: { type: ['object', 'null'], additionalProperties: true },
    findings: { type: 'array', items: { type: 'object', required: ['axis', 'severity', 'situation', 'required_change'],
      properties: { axis: { enum: ['sprawl', 'flattening', 'fidelity', 'parity', 'family'] },
        severity: { type: 'integer', minimum: 1, maximum: 3 }, situation: { type: 'string' }, required_change: { type: 'string' } } } },
    verdict: { enum: ['accept', 'revise', 'reject-as-sprawl', 'reject-as-singleton'] },
    shape_package: { type: ['object', 'null'], additionalProperties: true }, confidence: { type: 'number' },
  },
}

// Fail LOUD when a kroot agent's spawn evidence is missing — a nested spawn that silently
// no-ops (depth gate, undiscovered agent) must not pass as a verified shape.
function assertSpawned(agentLabel, obj, checks) {
  if (!obj) throw new Error(`${agentLabel} returned nothing`)
  for (const { path, msg } of checks) {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
    const empty = v == null || (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
    if (empty) throw new Error(
      `${agentLabel}: missing spawn evidence "${path}" — ${msg}. This usually means nested ` +
      `agent-spawning is unavailable: check task.maxRecursionDepth >= 2 and that the helper agents ` +
      `are discoverable in .omp/agents. Failing loud rather than shipping an unverified shape.`)
  }
}

phase('Seed')
const retrieval = await agent(
  PRE + `Look up this resisted ability's raw prose and committed DSL. Input:\n` +
  JSON.stringify({ query: { ability_id: args.seed.ability_id, faction_id: args.seed.faction_id } }),
  { agentType: 'data-enginseer', phase: 'Seed', schema: ENGINSEER_OUT, label: `seed:${args.seed.ability_id}` }
)
const seedMatches = (retrieval && retrieval.matches) || []
const match = seedMatches.find(m => m.faction === args.seed.faction_id) || seedMatches[0] || null
const raw_text = args.seed.raw_text || (match && match.raw_text) || null
if (!raw_text) return { seed: args.seed, status: 'no-prose', shape_package: null, rounds: [] }

const rounds = []
let prior_findings = []   // accumulated across review rounds (thread capture)
let status = 'not-converged'
let shape_package = null

for (let round = 0; round < MAX_ROUNDS; round++) {
  const rn = round + 1
  phase(`Shape (round ${rn})`)
  const revision = prior_findings.length
    ? `\n\nPrior review rounds raised the findings below — resolve EACH (the WHOLE thread, not just ` +
      `the last round), and never reintroduce a flattening/sprawl an earlier round already fixed:\n` +
      JSON.stringify(prior_findings)
    : ''
  const flesh = await agent(
    PRE + `Propose a new DSL shape for this resisted mechanic. SPAWN the decomposers (target-dummy, ` +
    `chronomancer, vox-hound) and data-enginseer to ground it. COPY the child JSON outputs verbatim: ` +
    `decomposition.who=target-dummy, decomposition.when=chronomancer, decomposition.what=vox-hound, ` +
    `retrieval=data-enginseer. If any child is missing, retry or fail loudly; do NOT yield null/empty ` +
    `proof fields. Then prove each nearest existing shape would flatten it (the obelisk/tau collision is ` +
    `the defect to avoid). Input:\n` +
    JSON.stringify({ seed_ability_id: args.seed.ability_id, faction_id: args.seed.faction_id,
      raw_text, resisted_schema: args.seed.resisted_schema || null, retrieval }) + revision,
    { agentType: 'kroot-flesh-shaper', phase: 'Shape', schema: FLESH_OUT, label: `flesh:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-flesh-shaper', flesh, [
    { path: 'decomposition.what', msg: 'flesh-shaper must spawn the decomposers' },
    { path: 'retrieval', msg: 'flesh-shaper must spawn data-enginseer' },
    { path: 'proposed_shape', msg: 'no shape proposed' },
  ])
  const fverdict = flesh.self_grade && flesh.self_grade.verdict
  if (fverdict === 'existing-fits') {
    rounds.push({ round: rn, flesh, verdict: 'existing-fits' })
    return { seed: args.seed, status: 'existing-fits', shape_package: null, rounds }
  }
  if (fverdict === 'singleton') {
    rounds.push({ round: rn, flesh, verdict: 'singleton' })
    status = 'rejected-singleton'
    break
  }

  phase(`Broaden (round ${rn})`)
  const lone = await agent(
    PRE + `Broaden coverage for this proposed shape WITHOUT flattening. SPAWN swarmlord for the corpus ` +
    `sweep, then adjudicate each candidate faithful / needs-param / would-flatten. Input:\n` +
    JSON.stringify({ proposed_shape: flesh.proposed_shape, seed_ability_id: args.seed.ability_id,
      faction_id: args.seed.faction_id }),
    { agentType: 'kroot-lone-spear', phase: 'Broaden', schema: LONESPEAR_OUT, label: `spear:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-lone-spear', lone, [{ path: 'swarmlord_sweep', msg: 'lone-spear must spawn swarmlord' }])

  phase(`Trail (round ${rn})`)
  const trail = await agent(
    PRE + `Spec the describer output for this proposed shape across EVERY render form (inline + container; ` +
    `condition lead-in + predicate/negated). SPAWN psyker to cold-read the render. Input:\n` +
    JSON.stringify({ proposed_shape: flesh.proposed_shape,
      lone_spear: { parameter_deltas: lone.parameter_deltas || [], coverage: lone.coverage || [] } }),
    { agentType: 'kroot-trail-shaper', phase: 'Trail', schema: TRAIL_OUT, label: `trail:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-trail-shaper', trail, [
    { path: 'psyker_read', msg: 'trail-shaper must spawn psyker' },
    { path: 'render_rules', msg: 'no render rules specified' },
  ])

  phase(`War (round ${rn})`)
  const war = await agent(
    PRE + `Adversarially review this proposed shape on all four axes (sprawl / flattening / fidelity-parity / ` +
    `family). SPAWN eversor per sample family member and swarmlord for an INDEPENDENT family recheck. Family ` +
    `threshold is ${THRESHOLD} (exact+near, flatten-excluded). On accept, return a complete shape_package. Input:\n` +
    JSON.stringify({ flesh, lone_spear: lone, trail, prior_findings, family_threshold: THRESHOLD }),
    { agentType: 'kroot-war-shaper', phase: 'War', schema: WAR_OUT, label: `war:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-war-shaper', war, [
    { path: 'eversor_refutations', msg: 'war-shaper must spawn eversor against sample members' },
    { path: 'swarmlord_recheck', msg: 'war-shaper must spawn swarmlord for an independent recheck' },
  ])

  rounds.push({ round: rn, flesh, lone, trail, war, verdict: war.verdict })

  if (war.verdict === 'accept') {
    // Enforce the family bar independently of the agent's self-report (anti cosine/coverage laundering).
    if ((lone.faithful_family_size || 0) < THRESHOLD) { status = 'rejected-singleton'; break }
    if (!war.shape_package) throw new Error('war-shaper accepted but returned no shape_package (false pass)')
    status = 'shipped-ready'
    shape_package = war.shape_package
    break
  }
  if (war.verdict === 'reject-as-sprawl') { status = 'rejected-sprawl'; break }
  if (war.verdict === 'reject-as-singleton') { status = 'rejected-singleton'; break }
  // revise → accumulate this round's findings into the thread and loop
  prior_findings = prior_findings.concat((war.findings || []).map(f => ({ round: rn, ...f })))
}

log(`shape-scout ${args.seed.ability_id}: ${status} after ${rounds.length} round(s)`)
return { seed: args.seed, status, shape_package, rounds }
