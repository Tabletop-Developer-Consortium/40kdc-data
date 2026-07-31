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
//   repo_root: string,
//   campaign_id: string,
//   campaign_manifest_sha256: string,
//   campaign_manifest_path: string, // frozen; discoveries are next-campaign only
//   seed: { ability_id, faction_id, raw_text?, evidence_packet?, architecture?, resisted_schema? },
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
if (!args.campaign_id || !args.campaign_manifest_sha256 || !args.campaign_manifest_path)
  throw new Error('campaign_id, campaign_manifest_path, and campaign_manifest_sha256 required')
const manifestFile = Bun.file(args.campaign_manifest_path)
if (!(await manifestFile.exists())) throw new Error('campaign manifest not found')
const manifestBytes = new Uint8Array(await manifestFile.arrayBuffer())
if (new Bun.CryptoHasher('sha256').update(manifestBytes).digest('hex') !== args.campaign_manifest_sha256)
  throw new Error('campaign manifest hash mismatch')
const campaignManifest = JSON.parse(new TextDecoder().decode(manifestBytes))
if (campaignManifest.campaign_id !== args.campaign_id || !Array.isArray(campaignManifest.worklist))
  throw new Error('campaign manifest identity/worklist mismatch')
const MANIFEST_KEYS = new Set(campaignManifest.worklist.map(x => `${x.faction_id}/${x.ability_id}`))
const SEED_KEY = `${args.seed.faction_id}/${args.seed.ability_id}`
if (MANIFEST_KEYS.size !== campaignManifest.worklist.length || !MANIFEST_KEYS.has(SEED_KEY))
  throw new Error('shape seed must occur exactly once in the frozen campaign manifest')
if (!args.repo_root) throw new Error('args.repo_root required (workspace identity is enforced, not advisory)')
const THRESHOLD = args.family_threshold || 4
const MAX_ROUNDS = args.max_rounds || 3
if (THRESHOLD !== 4) throw new Error('family_threshold is fixed at 4 and cannot be weakened')
if (!Number.isInteger(MAX_ROUNDS) || MAX_ROUNDS < 1 || MAX_ROUNDS > 3)
  throw new Error('max_rounds must be an integer from 1 through 3')
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`
const ROLE_MANIFEST = ['arch-magos', 'chronomancer', 'cogitator', 'data-enginseer', 'eversor',
  'inquisitor', 'kroot-flesh-shaper', 'kroot-lone-spear', 'kroot-trail-shaper',
  'kroot-war-shaper', 'psyker', 'skitarius', 'swarmlord', 'target-dummy', 'vox-hound', 'warpsmith']
function resultText(v) {
  if (typeof v === 'string') return v
  if (!v) return ''
  if (typeof v.text === 'string') return v.text
  if (typeof v.output === 'string') return v.output
  if (typeof v.stdout === 'string') return v.stdout
  if (Array.isArray(v.content)) return v.content.map(x => typeof x === 'string' ? x : (x.text || '')).join('\n')
  return ''
}
const runAgent = (prompt, options) => agent(prompt, {
  ...options, model: 'openai-codex/gpt-5.6-luna', schemaMode: 'strict',
})
async function assertWorkspace() {
  const root = quote(args.repo_root)
  const check = await tool.bash({ command:
    `set -eu; expected=$(cd ${root} && pwd -P); ` +
    `test "$(pwd -P)" = "$expected"; test "$(jj root)" = "$expected"; ` +
    `test -f AGENTS.md; test -f .omp/skills/dsl-campaign/SKILL.md; ` +
    `for role in ${ROLE_MANIFEST.map(quote).join(' ')}; do file=".omp/agents/$role.md"; ` +
    `test -f "$file"; model=$(sed -n 's/^model: //p' "$file"); test "$model" = "openai-codex/gpt-5.6-luna"; done; ` +
    `grep -q '40kdc-data' AGENTS.md; printf '__DSL_WORKSPACE_OK__:%s\\n' "$expected"`, timeout: 20 })
  if (!resultText(check).includes('__DSL_WORKSPACE_OK__'))
    throw new Error(`workspace preflight failed: cwd and jj root must both equal ${args.repo_root}`)
  return { repo_root: args.repo_root, verified: true, role_manifest_verified: ROLE_MANIFEST }
}
const workspace = await assertWorkspace()
const PRE = `Verified repo root: ${args.repo_root}. The workflow hard-checked that its cwd and jj root ` +
  `match this path. Run every command there; never read or write another checkout.\n`

// ---- frozen Output contracts, transcribed to JSON Schema (mirror the agent output: frontmatter) ----
const ENGINSEER_OUT = {
  type: 'object', required: ['matches', 'method', 'evidence_packet'],
  properties: {
    matches: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'raw_text', 'has_dsl'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        raw_text: { type: ['string', 'null'] }, has_dsl: { type: 'boolean' },
        committed_dsl_path: { type: ['string', 'null'] },
        other_faction_copies: { type: 'array', items: { type: 'string' } } } } },
    comparison: { type: ['object', 'null'], additionalProperties: true }, method: { enum: ['index-lookup', 'grep', 'embeddings'] },
    notes: { type: 'array', items: { type: 'string' } },
    evidence_packet: { type: ['object', 'null'], additionalProperties: true },
  },
}
function evidencePayload(packet) {
  return {
    ability_id: packet.ability_id, faction_id: packet.faction_id, source_hash: packet.source_hash,
    clauses: packet.clauses.map(c => ({ clause_id: c.clause_id, start: c.start, end: c.end,
      source_text_hash: c.source_text_hash, mechanical: c.mechanical, kind: c.kind })),
    relationships: packet.relationships || [], tables: packet.tables || [],
  }
}
function validateEvidencePacket(packet, source) {
  if (!packet || packet.ability_id !== args.seed.ability_id || packet.faction_id !== args.seed.faction_id ||
      !Array.isArray(packet.clauses) || !packet.clauses.length || !packet.source_hash || !packet.packet_hash)
    return 'missing or misidentified source evidence packet'
  if (packet.source_hash !== new Bun.CryptoHasher('sha256').update(source).digest('hex'))
    return 'source evidence hash does not match complete raw text'
  let cursor = 0
  const ids = new Set()
  for (const clause of packet.clauses) {
    if (!clause.clause_id || ids.has(clause.clause_id) || clause.start !== cursor ||
        !Number.isInteger(clause.end) || clause.end <= clause.start || clause.end > source.length ||
        typeof clause.mechanical !== 'boolean' || !clause.kind) return 'invalid clause partition'
    ids.add(clause.clause_id)
    const hash = new Bun.CryptoHasher('sha256').update(source.slice(clause.start, clause.end)).digest('hex')
    if (hash !== clause.source_text_hash) return `source slice hash mismatch for ${clause.clause_id}`
    cursor = clause.end
  }
  if (cursor !== source.length) return 'clause partition does not cover complete raw text'
  const packetHash = new Bun.CryptoHasher('sha256').update(JSON.stringify(evidencePayload(packet))).digest('hex')
  return packetHash === packet.packet_hash ? null : 'evidence packet hash mismatch'
}
const FLESH_OUT = {
  type: 'object',
  required: ['seed_ability_id', 'mechanic', 'decomposition', 'retrieval', 'proposed_shape', 'nearest_existing_shapes', 'internal_family', 'self_grade'],
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
    internal_family: { type: 'array', items: { type: 'object',
      required: ['member', 'clause_ids', 'shared_contract_id', 'parent_id', 'homogeneous_contract'],
      properties: { member: { type: 'string' }, clause_ids: { type: 'array', items: { type: 'string' } },
        shared_contract_id: { type: 'string' }, parent_id: { type: 'string' }, homogeneous_contract: { type: 'boolean' } } } },
    self_grade: { type: 'object', required: ['verdict', 'confidence'],
      properties: { verdict: { enum: ['new-shape', 'existing-fits', 'singleton'] }, confidence: { type: 'number' }, concerns: { type: 'array', items: { type: 'string' } } } },
  },
}
const LONESPEAR_OUT = {
  type: 'object', required: ['proposed_shape_name', 'swarmlord_sweep', 'coverage', 'faithful_family_size', 'internal_family_size', 'confidence'],
  properties: {
    proposed_shape_name: { type: 'string' }, swarmlord_sweep: { type: ['object', 'null'], additionalProperties: true },
    coverage: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'fit', 'evidence'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        fit: { enum: ['faithful', 'needs-param', 'would-flatten'] },
        evidence: { type: 'string' },
        match_strength: { enum: ['exact', 'near', 'stretch'] },
        param_needed: { type: ['string', 'null'] }, flatten_reason: { type: ['string', 'null'] } } } },
    faithful_family_size: { type: 'integer' },
    internal_family_size: { type: 'integer' },
    parameter_deltas: { type: 'array', items: { type: 'object', required: ['param', 'change', 'unblocks'],
      properties: { param: { type: 'string' }, change: { type: 'string' }, unblocks: { type: 'array', items: { type: 'string' } } } } },
    members_needing_own_shape: { type: 'array', items: { type: 'object', required: ['ability_id', 'why'],
      properties: { ability_id: { type: 'string' }, why: { type: 'string' } } } }, confidence: { type: 'number' },
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
    psyker_read: { type: ['object', 'null'], additionalProperties: false,
      required: ['faction_id', 'findings', 'clean'], properties: {
        faction_id: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['ability_id', 'describer_output', 'problem', 'player_reading', 'severity'], properties: {
            ability_id: { type: 'string' }, describer_output: { type: 'string' },
            problem: { enum: ['ambiguous', 'misleading', 'ungrammatical', 'jargon-leak', 'missing-clause-signal'] },
            player_reading: { type: 'string' }, severity: { type: 'integer', minimum: 1, maximum: 3 } } } },
        clean: { type: 'array', items: { type: 'string' } } } },
    cost: { type: 'object', required: ['spec_bump', 'schema_change', 'files'],
      properties: { spec_bump: { type: 'boolean' }, schema_change: { type: 'boolean' },
        files: { type: 'array', items: { type: 'string' } }, conformance_cases: { type: 'integer' } } },
    confidence: { type: 'number' },
  },
}
const WAR_OUT = {
  type: 'object', required: ['proposed_shape_name', 'family_mode', 'eversor_refutations', 'swarmlord_recheck',
    'prior_finding_resolutions', 'findings', 'verdict', 'confidence'],
  properties: {
    proposed_shape_name: { type: 'string' },
    family_mode: { enum: ['external', 'internal'] },
    eversor_refutations: { type: 'array', items: { type: 'object',
      required: ['ability_id', 'faction', 'internal_child_id', 'refuted', 'divergences'], properties: {
        ability_id: { type: 'string' }, faction: { type: 'string' }, refuted: { type: 'boolean' },
        internal_child_id: { type: ['string', 'null'] },
        divergences: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    swarmlord_recheck: { type: ['object', 'null'], additionalProperties: true },
    prior_finding_resolutions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['round', 'axis', 'situation', 'resolved', 'evidence'], properties: {
        round: { type: 'integer', minimum: 1 }, axis: { type: 'string' }, situation: { type: 'string' },
        resolved: { type: 'boolean' }, evidence: { type: 'string' } } } },
    findings: { type: 'array', items: { type: 'object', required: ['axis', 'severity', 'situation', 'required_change'],
      properties: { axis: { enum: ['sprawl', 'flattening', 'fidelity', 'parity', 'family'] },
        severity: { type: 'integer', minimum: 1, maximum: 3 }, situation: { type: 'string' }, required_change: { type: 'string' } } } },
    verdict: { enum: ['accept', 'revise', 'reject-as-sprawl', 'reject-as-singleton'] },
    shape_package: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['name', 'kind', 'schema_branch', 'parameters', 'seed_encoding', 'describer',
        'faithful_family', 'parameter_deltas', 'seed_ability_id', 'implementation_matrix'],
      properties: {
        name: { type: 'string' }, kind: { enum: ['effect-leaf', 'condition', 'container', 'modifier-extension'] },
        schema_branch: { type: 'object', additionalProperties: true },
        parameters: { type: 'array', items: { type: 'object', required: ['name', 'type', 'load_bearing'], additionalProperties: true } },
        seed_encoding: { type: 'object', additionalProperties: true },
        describer: { type: 'object', required: ['render_rules', 'conformance_cases'], properties: {
          render_rules: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true } },
          conformance_cases: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true } },
          port_notes: { type: 'array', items: { type: 'string' } } } },
        faithful_family: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'fit'],
          properties: { ability_id: { type: 'string' }, faction: { type: 'string' }, fit: { enum: ['faithful', 'needs-param'] } } } },
        parameter_deltas: { type: 'array', items: { type: 'object', additionalProperties: true } },
        seed_ability_id: { type: 'string' }, implementation_matrix: { type: 'object', additionalProperties: true },
      } }] }, confidence: { type: 'number' },
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
const retrieval = await runAgent(
  PRE + `Look up this resisted ability's raw prose and committed DSL. Input:\n` +
  JSON.stringify({ query: { ability_id: args.seed.ability_id, faction_id: args.seed.faction_id } }),
  { agent: 'data-enginseer', schema: ENGINSEER_OUT, label: `seed:${args.seed.ability_id}` }
)
const seedMatches = (retrieval && retrieval.matches) || []
const exactMatches = seedMatches.filter(m => m.ability_id === args.seed.ability_id && m.faction === args.seed.faction_id)
const match = exactMatches.length === 1 ? exactMatches[0] : null
const raw_text = match && match.raw_text
if (!raw_text) return { seed: args.seed, status: 'no-prose', shape_package: null, rounds: [], workspace,
  provenance: { workflow: 'dsl-shape-scout', required_roles: ['data-enginseer'] } }
const evidence_packet = args.seed.evidence_packet || (retrieval && retrieval.evidence_packet) || null
const packetError = validateEvidencePacket(evidence_packet, raw_text)
if (packetError) throw new Error(packetError)
const sourceClauseIds = new Set(evidence_packet.clauses.map(c => c.clause_id))
if (sourceClauseIds.size !== evidence_packet.clauses.length || sourceClauseIds.has(undefined))
  throw new Error('shape-scout source evidence has missing or duplicate clause ids')

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
  const flesh = await runAgent(
    PRE + `Propose a new DSL shape for this resisted mechanic. SPAWN the decomposers (target-dummy, ` +
    `chronomancer, vox-hound) and data-enginseer to ground it. COPY the child JSON outputs verbatim: ` +
    `decomposition.who=target-dummy, decomposition.when=chronomancer, decomposition.what=vox-hound, ` +
    `retrieval=data-enginseer. If any child is missing, retry or fail loudly; do NOT yield null/empty ` +
    `proof fields. Then prove each nearest existing shape would flatten it (the obelisk/tau collision is ` +
    `the defect to avoid). Input:\n` +
    JSON.stringify({ seed_ability_id: args.seed.ability_id, faction_id: args.seed.faction_id,
      raw_text, evidence_packet, architecture: args.seed.architecture || null,
      resisted_schema: args.seed.resisted_schema || null, retrieval }) + revision,
    { agent: 'kroot-flesh-shaper', schema: FLESH_OUT, label: `flesh:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-flesh-shaper', flesh, [
    { path: 'decomposition.who', msg: 'flesh-shaper must spawn target-dummy' },
    { path: 'decomposition.when', msg: 'flesh-shaper must spawn chronomancer' },
    { path: 'decomposition.what', msg: 'flesh-shaper must spawn vox-hound' },
    { path: 'retrieval', msg: 'flesh-shaper must spawn data-enginseer' },
    { path: 'proposed_shape', msg: 'no shape proposed' },
  ])
  if (flesh.seed_ability_id !== args.seed.ability_id)
    throw new Error('flesh-shaper output is bound to another seed')
  for (const [role, child] of Object.entries(flesh.decomposition)) {
    if (!child || child.ability_id !== args.seed.ability_id || child.status !== 'resolved' ||
        !Array.isArray(child.unresolved_clauses) || child.unresolved_clauses.length)
      throw new Error(`flesh-shaper ${role} child is missing, unresolved, or misidentified`)
  }
  const fleshRetrievalMatches = flesh.retrieval?.matches || []
  if (fleshRetrievalMatches.filter(x => x.ability_id === args.seed.ability_id &&
    x.faction === args.seed.faction_id).length !== 1 ||
    validateEvidencePacket(flesh.retrieval?.evidence_packet, raw_text) ||
    flesh.retrieval.evidence_packet.packet_hash !== evidence_packet.packet_hash)
    throw new Error('flesh-shaper retrieval is not exactly bound to the seed evidence packet')
  const fverdict = flesh.self_grade && flesh.self_grade.verdict
  const internalMembers = (flesh.internal_family || []).filter(m => m.homogeneous_contract)
  const uniqueInternalMembers = new Set(internalMembers.map(m => m.member))
  const invalidInternal = internalMembers.some(m => !m.member || !m.clause_ids.length ||
    m.clause_ids.some(id => !sourceClauseIds.has(id)))
  if (invalidInternal || uniqueInternalMembers.size !== internalMembers.length)
    throw new Error('internal-family evidence has duplicate members or unknown/empty clause ids')
  if (fverdict === 'existing-fits') {
    rounds.push({ round: rn, flesh, verdict: 'existing-fits' })
    return { seed: args.seed, status: 'existing-fits', shape_package: null, rounds, workspace,
      provenance: { workflow: 'dsl-shape-scout', required_roles: ['data-enginseer', 'kroot-flesh-shaper'] } }
  }
  if (fverdict === 'singleton') {
    rounds.push({ round: rn, flesh, verdict: 'singleton' })
    if (uniqueInternalMembers.size < THRESHOLD) { status = 'rejected-singleton'; break }
  }

  phase(`Broaden (round ${rn})`)
  const lone = await runAgent(
    PRE + `Broaden coverage for this proposed shape WITHOUT flattening. SPAWN swarmlord for the corpus ` +
    `sweep, then adjudicate each candidate faithful / needs-param / would-flatten. Input:\n` +
    JSON.stringify({ proposed_shape: flesh.proposed_shape, seed_ability_id: args.seed.ability_id,
      faction_id: args.seed.faction_id, internal_family: flesh.internal_family }),
    { agent: 'kroot-lone-spear', schema: LONESPEAR_OUT, label: `spear:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-lone-spear', lone, [{ path: 'swarmlord_sweep', msg: 'lone-spear must spawn swarmlord' }])

  phase(`Trail (round ${rn})`)
  const trail = await runAgent(
    PRE + `Spec the describer output for this proposed shape across EVERY render form (inline + container; ` +
    `condition lead-in + predicate/negated). SPAWN psyker to cold-read the render. Input:\n` +
    JSON.stringify({ proposed_shape: flesh.proposed_shape,
      lone_spear: { parameter_deltas: lone.parameter_deltas || [], coverage: lone.coverage || [] } }),
    { agent: 'kroot-trail-shaper', schema: TRAIL_OUT, label: `trail:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-trail-shaper', trail, [
    { path: 'psyker_read', msg: 'trail-shaper must spawn psyker' },
    { path: 'render_rules', msg: 'no render rules specified' },
  ])
  if (trail.psyker_read.faction_id !== args.seed.faction_id ||
      trail.psyker_read.findings.some(x => x.ability_id !== args.seed.ability_id) ||
      trail.psyker_read.clean.some(x => x !== args.seed.ability_id) ||
      trail.psyker_read.findings.length + trail.psyker_read.clean.length !== 1 ||
      trail.psyker_read.findings.some(x => x.severity === 3))
    throw new Error('trail psyker read must exactly cover the seed faction/ability and contain no severity-3 finding')
  const forms = new Set(trail.render_rules.map(x => x.form))
  const requiredForms = flesh.proposed_shape.kind === 'condition'
    ? ['condition-lead-in', 'condition-predicate', 'negated']
    : flesh.proposed_shape.kind === 'effect-leaf'
      ? ['inline-single-effect', 'container']
      : flesh.proposed_shape.kind === 'container'
        ? ['container'] : ['inline-single-effect', 'container']
  if (requiredForms.some(form => !forms.has(form)))
    throw new Error(`render rules omit forms required for ${flesh.proposed_shape.kind}: ${requiredForms.join(', ')}`)

  phase(`War (round ${rn})`)
  const war = await runAgent(
    PRE + `Adversarially review this proposed shape on all four axes (sprawl / flattening / fidelity-parity / ` +
    `family). SPAWN eversor per sample family member and swarmlord for an INDEPENDENT family recheck. Family ` +
    `threshold is ${THRESHOLD} (exact+near, flatten-excluded). On accept, return a complete shape_package. Input:\n` +
    JSON.stringify({ flesh, lone_spear: lone, trail, prior_findings, family_threshold: THRESHOLD,
      frozen_manifest_keys: [...MANIFEST_KEYS],
      package_policy: 'faithful_family is the manifest intersection; report other discoveries for next campaign only' }),
    { agent: 'kroot-war-shaper', schema: WAR_OUT, label: `war:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-war-shaper', war, [
    { path: 'eversor_refutations', msg: 'war-shaper must spawn eversor against sample members' },
    { path: 'swarmlord_recheck', msg: 'war-shaper must spawn swarmlord for an independent recheck' },
  ])

  rounds.push({ round: rn, flesh, lone, trail, war, verdict: war.verdict })

  if (war.verdict === 'accept') {
    // A shape may have an external cross-ability family OR an internal family of
    // homogeneous child records in one closed composite mechanic.
    const faithfulExternal = new Set((lone.coverage || [])
      .filter(m => ['faithful', 'needs-param'].includes(m.fit) && ['exact', 'near'].includes(m.match_strength) && m.evidence.trim())
      .map(m => `${m.faction}/${m.ability_id}`))
    const invalidParamMember = (lone.coverage || []).some(m => m.fit === 'needs-param' &&
      (!m.param_needed || !(lone.parameter_deltas || []).some(d => d.param === m.param_needed &&
        (d.unblocks || []).includes(m.ability_id))))
    if (invalidParamMember) throw new Error('needs-param family member lacks a matching parameter delta')
    if (lone.faithful_family_size !== faithfulExternal.size ||
        lone.internal_family_size !== uniqueInternalMembers.size)
      throw new Error('lone-spear family counts do not match the supplied member evidence')
    const internalArchitectureCount = args.seed.architecture?.architecture?.internal_family_size ??
      args.seed.architecture?.internal_family_size ?? 0
    const architect = args.seed.architecture?.architecture || args.seed.architecture || {}
    const architectChildren = (architect.local_actions || []).filter(x => x.parent_closed)
    const architectIds = new Set(architectChildren.map(x => x.child_id))
    const architectClauses = architectChildren.flatMap(x => x.clause_ids || [])
    const fleshClauses = internalMembers.flatMap(x => x.clause_ids)
    const oneContract = new Set(architectChildren.map(x => x.shared_contract_id)).size === 1 &&
      new Set(internalMembers.map(x => x.shared_contract_id)).size === 1 &&
      architectChildren[0]?.shared_contract_id === internalMembers[0]?.shared_contract_id
    const oneParent = new Set(architectChildren.map(x => x.parent_id)).size === 1 &&
      new Set(internalMembers.map(x => x.parent_id)).size === 1 &&
      architectChildren[0]?.parent_id === internalMembers[0]?.parent_id
    const internalSetsMatch = architectIds.size === uniqueInternalMembers.size &&
      [...architectIds].every(id => uniqueInternalMembers.has(id)) &&
      new Set(architectClauses).size === architectClauses.length &&
      new Set(fleshClauses).size === fleshClauses.length &&
      architectClauses.length === fleshClauses.length &&
      architectClauses.every(id => fleshClauses.includes(id)) && oneContract && oneParent
    const independentFamily = new Set((war.swarmlord_recheck?.candidates || [])
      .filter(m => ['exact', 'near'].includes(m.match_strength) && m.evidence && m.evidence.trim())
      .map(m => `${m.faction}/${m.ability_id}`))
    if (independentFamily.size !== (war.swarmlord_recheck?.candidates || [])
      .filter(m => ['exact', 'near'].includes(m.match_strength) && m.evidence && m.evidence.trim()).length)
      throw new Error('independent family sweep contains duplicate qualifying pairs')
    const externalQualifies = faithfulExternal.size >= THRESHOLD &&
      faithfulExternal.size === independentFamily.size &&
      [...faithfulExternal].every(key => independentFamily.has(key))
    const internalQualifies = uniqueInternalMembers.size >= THRESHOLD &&
      internalArchitectureCount === uniqueInternalMembers.size && internalSetsMatch
    const familyQualifies = externalQualifies || internalQualifies
    if (!familyQualifies) { status = 'rejected-singleton'; break }
    const unresolvedPrior = prior_findings.filter(prior => !(war.prior_finding_resolutions || []).some(row =>
      row.round === prior.round && row.axis === prior.axis && row.situation === prior.situation && row.resolved && row.evidence.trim()))
    const resolutionKeys = (war.prior_finding_resolutions || []).map(row => `${row.round}\0${row.axis}\0${row.situation}`)
    const priorKeys = prior_findings.map(row => `${row.round}\0${row.axis}\0${row.situation}`)
    if (new Set(resolutionKeys).size !== resolutionKeys.length || resolutionKeys.length !== priorKeys.length ||
        resolutionKeys.some(key => !priorKeys.includes(key)) || unresolvedPrior.length ||
        (war.findings || []).some(x => x.severity === 3))
      throw new Error('war-shaper cannot accept with a current severity-3 or unresolved prior finding')
    if ((war.eversor_refutations || []).length < 2 ||
        war.eversor_refutations.some(x => x.refuted !== false || x.divergences.length))
      throw new Error('war-shaper acceptance requires at least two non-refuting eversor results')
    if (!war.shape_package) throw new Error('war-shaper accepted but returned no shape_package (false pass)')
    const sampled = new Set(war.eversor_refutations.map(x => `${x.faction}/${x.ability_id}`))
    const sampledChildren = new Set(war.eversor_refutations.map(x => x.internal_child_id).filter(Boolean))
    const family = new Set(war.shape_package.faithful_family.map(x => `${x.faction}/${x.ability_id}`))
    const campaignExternal = new Set([...faithfulExternal].filter(key => MANIFEST_KEYS.has(key)))
    if (!family.has(SEED_KEY)) throw new Error('shape package faithful_family must explicitly contain its seed faction/ability pair')
    const outOfManifest = [...family].filter(key => !MANIFEST_KEYS.has(key))
    if (outOfManifest.length)
      throw new Error(`shape package includes out-of-manifest discoveries (record for next campaign; do not edit/render): ${outOfManifest.join(', ')}`)
    if (war.family_mode === 'external' && (!externalQualifies || family.size !== campaignExternal.size ||
        [...family].some(key => !campaignExternal.has(key)) || sampled.size < 2 ||
        [...sampled].some(key => !faithfulExternal.has(key)) || sampledChildren.size))
      throw new Error('external family requires two distinct faithful refutations; package is manifest-intersection only')
    if (war.family_mode === 'internal' && (!internalQualifies || sampled.size !== 1 || !sampled.has(SEED_KEY) ||
        sampledChildren.size < 2 || [...sampledChildren].some(id => !uniqueInternalMembers.has(id))))
      throw new Error('internal family requires one seed ability and two distinct machine-bound internal-child refutations')
    if (war.shape_package.name !== flesh.proposed_shape.name || war.shape_package.kind !== flesh.proposed_shape.kind ||
        war.shape_package.seed_ability_id !== args.seed.ability_id ||
        JSON.stringify(war.shape_package.schema_branch) !== JSON.stringify(flesh.proposed_shape.schema_sketch) ||
        JSON.stringify(war.shape_package.parameters) !== JSON.stringify(flesh.proposed_shape.parameters) ||
        JSON.stringify(war.shape_package.seed_encoding) !== JSON.stringify(flesh.proposed_shape.seed_encoding) ||
        JSON.stringify(war.shape_package.parameter_deltas) !== JSON.stringify(lone.parameter_deltas) ||
        JSON.stringify(war.shape_package.describer.render_rules) !== JSON.stringify(trail.render_rules) ||
        JSON.stringify(war.shape_package.describer.conformance_cases) !== JSON.stringify(trail.conformance_cases))
      throw new Error('shape_package is inconsistent with the accepted flesh/lone/trail artifacts')
    const matrix = war.shape_package.implementation_matrix
    const requiredSurfaces = ['canonical_schema', 'typescript_describer', 'rust_describer',
      'python_describer', 'go_describer', 'typescript_cruncher', 'rust_cruncher',
      'python_cruncher', 'go_cruncher', 'conformance', 'spec_version', 'generated_types',
      'embedded_schemas', 'rust_bundle', 'python_bundle', 'go_bundle', 'version_lockstep', 'data']
    const missingSurfaces = requiredSurfaces.filter(k => !matrix || !matrix[k] ||
      matrix[k].required !== true || !Array.isArray(matrix[k].files) || matrix[k].files.length === 0)
    if (missingSurfaces.length)
      throw new Error(`war-shaper accepted an incomplete implementation matrix: ${missingSurfaces.join(', ')}`)
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
return {
  seed: args.seed, status, shape_package, rounds, workspace,
  provenance: { workflow: 'dsl-shape-scout', required_roles: ['data-enginseer', 'kroot-flesh-shaper',
    'target-dummy', 'chronomancer', 'vox-hound', 'kroot-lone-spear', 'swarmlord',
    'kroot-trail-shaper', 'psyker', 'kroot-war-shaper', 'eversor'] },
}
