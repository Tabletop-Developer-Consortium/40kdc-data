import {
  assertCharterFamily,
  assertScopedRefutations,
  assertRevision,
  assertShapeIdentity,
  classifyBlocker,
  countFamilyMechanics,
  freezeShapeCharter,
  mergeDeferredCandidates,
  normalizeFindingLedger,
  prototypeAgentInput,
  psykerSeverityFindings,
  prototypeAgentOptions,
  prototypeGateDecision,
  resolveFindingLedger,
  terminalOutcome,
  validateShapeCharter,
  validateShapePackage,
} from './wf-shape-scout-state.js'

export const meta = {
  name: 'dsl-shape-scout',
  description: 'Design a new DSL shape for a resisted mechanic — the kroot suite proposes, broadens, renders, and adversarially reviews it, emitting a warpsmith-ready shape package.',
  phases: [
    { title: 'Seed', detail: 'data-enginseer retrieves the resisted ability prose + committed DSL' },
    { title: 'Charter', detail: 'inquisitor freezes the exact mechanic slice, family, fixtures, and reopening rule' },
    { title: 'Shape', detail: 'kroot-flesh-shaper proposes a new shape (spawns decomposers + enginseer)' },
    { title: 'Broaden', detail: 'kroot-lone-spear adjudicates faithful coverage (spawns swarmlord)' },
    { title: 'Prototype', detail: 'warpsmith validates a disposable isolated vertical slice with skitarius evidence' },
    { title: 'Trail', detail: 'kroot-trail-shaper specs the describer (spawns psyker)' },
    { title: 'War', detail: 'kroot-war-shaper attacks sprawl/flattening/parity/family (spawns eversor + swarmlord)' },
  ],
}

// args: {
//   repo_root?,
//   seed: { ability_id, faction_id, raw_text?, resisted_schema? },  // the needs-schema ability
//   family_threshold?: 4,      // faithful family bar (exact+near, flatten-excluded) — the shape gate
//   max_rounds?: 3,            // cyclical review rounds before forcing terminal
//   prototype_workspaces?: string[], // driver-created jj workspaces for pure-JJ checkouts
// }
// Returns { seed, shape_charter, status, terminal, shape_package, rounds } where status ∈
//   shipped-ready | existing-fits | rejected-sprawl | rejected-singleton | not-converged | no-prose
//   rounds retain the full revision/prototype/review thread. `shape_charter.exact_family` is immutable:
//   discoveries outside it are deferred follow-ups unless inquisitor explicitly reopens the charter.
//   shape_package (on shipped-ready) is warpsmith's implement input: schema branch + describer + faithful family + cost.
// NO parent repo writes happen here. A prototype is a disposable isolated warpsmith worktree only.
//
// Spawn-native: the kroot leads spawn their OWN helper children (flesh -> decomposers+enginseer,
// lone-spear -> swarmlord, trail -> psyker, war -> eversor+swarmlord). Nested spawns need
// task.maxRecursionDepth >= 2 and the agents discoverable in .omp/agents. Every kroot output must
// carry its child evidence; a missing-evidence output fails LOUD (spawn-unavailable) rather than
// shipping an unverified shape.

if (typeof args === 'string') args = JSON.parse(args)
if (!args || !args.seed || !args.seed.ability_id) throw new Error('args.seed.ability_id required')
const THRESHOLD = Math.max(args.family_threshold || 4, 4)
const MAX_ROUNDS = Math.min(Math.max(args.max_rounds || 3, 1), 3)
if (args.prototype_workspaces && (!Array.isArray(args.prototype_workspaces) ||
  args.prototype_workspaces.length < MAX_ROUNDS ||
  args.prototype_workspaces.some(workspace => typeof workspace !== 'string' || !workspace.startsWith('/')))) {
  throw new Error(`prototype_workspaces requires ${MAX_ROUNDS} absolute jj workspace paths`)
}
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
const CHARTER_OUT = {
  type: 'object', required: ['mechanic_slice', 'exact_family', 'required_semantics', 'non_goals', 'deferred_candidates', 'acceptance_fixtures', 'reopening_rules'],
  properties: {
    mechanic_slice: { type: 'string' },
    exact_family: { type: 'array', minItems: 1, items: { type: 'object', required: ['ability_id', 'faction'], properties: { ability_id: { type: 'string' }, faction: { type: 'string' }, rationale: { type: 'string' } } } },
    required_semantics: { type: 'array', minItems: 1, items: { type: 'string' } },
    non_goals: { type: 'array', items: { type: 'string' } },
    deferred_candidates: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction'], properties: { ability_id: { type: 'string' }, faction: { type: 'string' } }, additionalProperties: true } },
    acceptance_fixtures: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true } },
    reopening_rules: { type: 'string' },
  },
}
const PROTOTYPE_OUT = {
  type: 'object', required: ['prototype', 'skitarius', 'diagnostics'],
  properties: {
    prototype: { type: 'object', required: ['worktree', 'applied_to_parent', 'proposed_shape', 'positive_probe', 'negative_probe', 'render_evidence'],
      properties: { worktree: { type: 'string', minLength: 1 }, applied_to_parent: { const: false }, proposed_shape: { type: 'object', minProperties: 1, additionalProperties: true }, positive_probe: { type: 'object', minProperties: 1, additionalProperties: true }, negative_probe: { type: 'object', minProperties: 1, additionalProperties: true }, render_evidence: { type: 'object', minProperties: 1, additionalProperties: true } } },
    skitarius: { type: 'object', required: ['worktree', 'gates_run', 'overall_pass', 'compiler_evidence', 'schema_evidence', 'render_evidence'], properties: {
      worktree: { type: 'string', minLength: 1 }, gates_run: { type: 'array', minItems: 1 }, overall_pass: { type: 'boolean' },
      compiler_evidence: { type: 'object', minProperties: 1, additionalProperties: true }, schema_evidence: { type: 'object', minProperties: 1, additionalProperties: true }, render_evidence: { type: 'object', minProperties: 1, additionalProperties: true },
    }, additionalProperties: true },
    diagnostics: { type: 'array', items: { type: 'string' } },
  },
}
const FLESH_OUT = {
  type: 'object',
  required: ['seed_ability_id', 'mechanic', 'decomposition', 'retrieval', 'proposed_shape', 'revision', 'nearest_existing_shapes', 'self_grade'],
  properties: {
    seed_ability_id: { type: 'string' }, mechanic: { type: 'string' },
    decomposition: { type: 'object', required: ['who', 'when', 'what'],
      properties: { who: { type: ['object', 'null'], additionalProperties: true }, when: { type: ['object', 'null'], additionalProperties: true }, what: { type: ['object', 'null'], additionalProperties: true } } },
    retrieval: { type: ['object', 'null'], additionalProperties: true },
    proposed_shape: { type: 'object', required: ['name', 'kind', 'parameters', 'schema_sketch', 'seed_encoding'],
      properties: { name: { type: 'string' }, kind: { enum: ['effect-leaf', 'condition', 'container', 'modifier-extension'] },
        parameters: { type: 'array', items: { type: 'object', required: ['name', 'type', 'load_bearing'],
          properties: { name: { type: 'string' }, type: { type: 'string' }, load_bearing: { type: 'boolean' }, notes: { type: 'string' } } } },
        schema_sketch: { type: 'object', minProperties: 1, additionalProperties: true }, seed_encoding: { type: 'object', minProperties: 1, additionalProperties: true } } },
    revision: {
      oneOf: [
        { type: 'null' },
        { type: 'object', required: ['changes'], properties: {
          changes: { type: 'array', minItems: 1, items: {
            type: 'object', required: ['op', 'path', 'finding_id'],
            properties: {
              op: { enum: ['add', 'replace', 'remove'] },
              path: { type: 'string', minLength: 1 },
              finding_id: { type: 'string', minLength: 1 },
              value: {},
            },
          } },
        } },
      ],
    },
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
    coverage: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'fit', 'match_strength'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        fit: { enum: ['faithful', 'needs-param', 'would-flatten'] },
        match_strength: { enum: ['exact', 'near', 'stretch'] },
        param_needed: { type: ['string', 'null'] }, flatten_reason: { type: ['string', 'null'] } } } },
    faithful_family_size: { type: 'integer' },
    parameter_deltas: { type: 'array', items: { type: 'object', required: ['param', 'change', 'unblocks'],
      properties: { param: { type: 'string' }, change: { type: 'string' }, unblocks: { type: 'array', items: { type: 'string' } } } } },
    deferred_candidates: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction'], properties: { ability_id: { type: 'string' }, faction: { type: 'string' } }, additionalProperties: true } },
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
    cost: { type: 'object', required: ['spec_bump', 'schema_change', 'files', 'conformance_cases'],
      properties: { spec_bump: { type: 'boolean' }, schema_change: { type: 'boolean' },
        files: { type: 'array', items: { type: 'string' } }, conformance_cases: { type: 'integer', minimum: 1 } } },
    confidence: { type: 'number' },
    prototype: { type: ['object', 'null'], additionalProperties: true },
  },
}
const SHAPE_PACKAGE_OUT = {
  type: 'object',
  required: ['name', 'kind', 'schema_branch', 'seed_encoding', 'parameters', 'describer', 'faithful_family', 'cost', 'seed_ability_id', 'seed_faction_id'],
  properties: {
    name: { type: 'string', minLength: 1 },
    kind: { enum: ['effect-leaf', 'condition', 'container', 'modifier-extension'] },
    schema_branch: { type: 'object', minProperties: 1, additionalProperties: true },
    seed_encoding: { type: 'object', minProperties: 1, additionalProperties: true },
    parameters: { type: 'array', items: { type: 'object', required: ['name', 'type', 'load_bearing'],
      properties: { name: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 }, load_bearing: { type: 'boolean' }, notes: { type: 'string' } } } },
    describer: { type: 'object', required: ['render_rules', 'port_notes', 'conformance_cases'],
      properties: {
        render_rules: { type: 'array', minItems: 1, items: { type: 'object', required: ['form', 'template', 'expected_output'],
          properties: { form: { enum: ['inline-single-effect', 'container', 'condition-lead-in', 'condition-predicate', 'negated'] }, template: { type: 'string', minLength: 1 }, example_input: { type: 'object', additionalProperties: true }, expected_output: { type: 'string', minLength: 1 } } } },
        port_notes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        conformance_cases: { type: 'array', minItems: 1, items: { type: 'object', required: ['case', 'expected_phrase'],
          properties: { case: { type: 'string', minLength: 1 }, expected_phrase: { type: 'string', minLength: 1 } } } },
      } },
    faithful_family: { type: 'array', minItems: 1, items: { type: 'object', required: ['ability_id', 'faction', 'fit', 'match_strength'],
      properties: { ability_id: { type: 'string', minLength: 1 }, faction: { type: 'string', minLength: 1 }, fit: { enum: ['faithful', 'needs-param', 'would-flatten'] }, match_strength: { enum: ['exact', 'near', 'stretch'] } } } },
    cost: { type: 'object', required: ['schema_change', 'spec_bump', 'files', 'conformance_cases'],
      properties: { schema_change: { type: 'boolean' }, spec_bump: { type: 'boolean' }, files: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, conformance_cases: { type: 'integer', minimum: 1 } } },
    seed_ability_id: { type: 'string', minLength: 1 },
    seed_faction_id: { type: 'string', minLength: 1 },
  },
}
const WAR_OUT = {
  type: 'object', required: ['proposed_shape_name', 'eversor_refutations', 'swarmlord_recheck', 'findings', 'verdict', 'confidence'],
  properties: {
    proposed_shape_name: { type: 'string' },
    eversor_refutations: { type: 'array', minItems: 2, items: { type: 'object', required: ['voter_id', 'ability_id', 'review_scope', 'refuted', 'divergences'],
      properties: { voter_id: { type: 'string', minLength: 1 }, ability_id: { type: 'string', minLength: 1 }, review_scope: { type: 'object', required: ['mechanic_slice'], properties: { mechanic_slice: { type: 'string', minLength: 1 } } }, refuted: { type: 'boolean' }, divergences: { type: 'array' } } } },
    swarmlord_recheck: { type: ['object', 'null'], additionalProperties: true },
    findings: { type: 'array', items: { type: 'object', required: ['key', 'state', 'axis', 'severity', 'situation', 'required_change', 'blocker_evidence'],
      properties: { key: { type: 'string' }, state: { enum: ['open', 'resolved', 'out-of-scope', 'superseded'] }, resolution_evidence: {}, scope_evidence: {}, supersession_evidence: {}, superseded_by: { type: 'string' },
        axis: { enum: ['sprawl', 'flattening', 'fidelity', 'parity', 'family'] }, severity: { type: 'integer', minimum: 1, maximum: 3 }, situation: { type: 'string' }, required_change: { type: 'string' },
        blocker_evidence: { type: 'object', required: ['concrete_slice_divergence', 'frozen_exact_member', 'not_honestly_composable_or_separate', 'resolved_or_out_of_scope'], properties: { concrete_slice_divergence: { type: 'boolean' }, frozen_exact_member: { type: 'boolean' }, not_honestly_composable_or_separate: { type: 'boolean' }, resolved_or_out_of_scope: { type: 'boolean' } } } } } },
    verdict: { enum: ['accept', 'revise', 'reject-as-sprawl', 'reject-as-singleton'] },
    shape_package: { ...SHAPE_PACKAGE_OUT, type: ['object', 'null'] }, confidence: { type: 'number' },
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

phase('Charter')
const charterDraft = await agent(
  PRE + `Act as the authoritative shape-scout charterer. Freeze the smallest exact mechanic family before design.
The family threshold remains ${THRESHOLD} unique ability ids; retain cross-faction copies as evidence but count a
shared ability id once. Include only exact/near candidates honestly sharing this mechanic slice. State required
semantics, explicit non-goals/orthogonal gaps, deferred candidates, fabricated acceptance fixtures, and the rule
that only an explicit inquisitor reopening may change this exact family. Never include raw prose. Input:\n` +
  JSON.stringify({ mode: 'charter', seed: args.seed, raw_text, resisted_schema: args.seed.resisted_schema || null, retrieval, family_threshold: THRESHOLD }),
  { agentType: 'inquisitor', phase: 'Charter', schema: CHARTER_OUT, label: `charter:${args.seed.ability_id}` }
)
const shape_charter = freezeShapeCharter({ seed: args.seed, mechanic_slice: charterDraft.mechanic_slice,
  family: charterDraft.exact_family, required_semantics: charterDraft.required_semantics, non_goals: charterDraft.non_goals,
  deferred_candidates: charterDraft.deferred_candidates, acceptance_fixtures: charterDraft.acceptance_fixtures,
  reopening_rules: charterDraft.reopening_rules })
const charterFamilySize = countFamilyMechanics(shape_charter.exact_family)
if (charterFamilySize < THRESHOLD) throw new Error(`shape_charter canonical mechanic family below threshold: ${charterFamilySize} < ${THRESHOLD}`)

const rounds = []
let finding_ledger = []
let previous_shape = null
let status = 'not-converged'
let shape_package = null

for (let round = 0; round < MAX_ROUNDS; round++) {
  const rn = round + 1
  phase(`Shape (round ${rn})`)
  const flesh = await agent(
    PRE + `Design the chartered mechanic slice only. On round one propose the smallest honest shape; on later rounds
REVISE previous_shape rather than resynthesizing it: retain its name/kind and report explicit changes. Every open
ledger finding must be addressed; orthogonal gaps remain deferred separate primitives. Spawn the required grounding
helpers and copy their outputs verbatim. Input:\n` + JSON.stringify({
      seed_ability_id: args.seed.ability_id, faction_id: args.seed.faction_id, raw_text,
      resisted_schema: args.seed.resisted_schema || null, retrieval, shape_charter, previous_shape, finding_ledger }),
    { agentType: 'kroot-flesh-shaper', phase: 'Shape', schema: FLESH_OUT, label: `flesh:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-flesh-shaper', flesh, [
    { path: 'decomposition.what', msg: 'flesh-shaper must spawn the decomposers' },
    { path: 'retrieval', msg: 'flesh-shaper must spawn data-enginseer' },
    { path: 'proposed_shape', msg: 'no shape proposed' },
  ])
  assertShapeIdentity(previous_shape, flesh.proposed_shape)
  if (previous_shape) assertRevision(previous_shape, flesh.proposed_shape, flesh.revision, finding_ledger)
  else if (flesh.revision != null) throw new Error('first-round revision must be null')
  const fverdict = flesh.self_grade && flesh.self_grade.verdict
  if (fverdict === 'existing-fits') {
    rounds.push({ round: rn, flesh, finding_ledger, verdict: 'existing-fits' })
    return { seed: args.seed, shape_charter, status: 'existing-fits', shape_package: null, rounds }
  }
  if (fverdict === 'singleton') {
    rounds.push({ round: rn, flesh, finding_ledger, verdict: 'singleton' })
    status = 'rejected-singleton'
    break
  }
  previous_shape = flesh.proposed_shape

  phase(`Broaden (round ${rn})`)
  const lone = await agent(
    PRE + `The coverage array MUST contain exactly one entry for every frozen exact-family member and no other
ability. Put every discovery outside that frozen family in deferred_candidates, even when it is near or needs a
parameter. Count a shared ability id once while retaining cross-faction copies as evidence. Do not mutate the
charter or inflate acceptance. Input:\n` +
    JSON.stringify({ proposed_shape: flesh.proposed_shape, seed_ability_id: args.seed.ability_id,
      faction_id: args.seed.faction_id, shape_charter, previous_shape }),
    { agentType: 'kroot-lone-spear', phase: 'Broaden', schema: LONESPEAR_OUT, label: `spear:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-lone-spear', lone, [{ path: 'swarmlord_sweep', msg: 'lone-spear must spawn swarmlord' }])
  const deferred_family = mergeDeferredCandidates(shape_charter, lone.deferred_candidates)
  const exactFamilySize = assertCharterFamily(shape_charter, lone.coverage)
  if (lone.faithful_family_size !== exactFamilySize) throw new Error('faithful_family_size must count canonical exact-or-near frozen mechanics')
  if (exactFamilySize < THRESHOLD) { status = 'rejected-singleton'; rounds.push({ round: rn, flesh, lone, finding_ledger, verdict: status }); break }

  phase(`Prototype (round ${rn})`)
  const prototypeWorkspace = args.prototype_workspaces ? args.prototype_workspaces[round] : null
  const prototypePRE = prototypeWorkspace
    ? `Prototype workspace: ${prototypeWorkspace}. Every Read/Grep/Glob/Edit/Write path MUST be an absolute path ` +
      `under that exact workspace, and every Bash call MUST set cwd to that exact workspace or a descendant. ` +
      `Never use a relative file-tool path: the agent session itself remains rooted in the parent checkout. ` +
      `Pass the same absolute workspace path and path rule to every child spawn. Never read, edit, generate into, ` +
      `or run a command in the parent checkout ${args.repo_root}. `
    : PRE
  const prototype = await agent(
    prototypePRE + `Implement a disposable minimal vertical prototype of this proposed shape in an ISOLATED,
NON-APPLIED worktree. Do not edit the parent checkout or data. Implement the actual schema branch, necessary
generated/TS surface, one describer path, and fabricated positive/negative probes. In that SAME worktree SPAWN
skitarius to run the targeted compiler/schema/render gates. Return concrete commands/results and diagnostics;
applied_to_parent MUST be false. Input:\n` + JSON.stringify(prototypeAgentInput({
      proposed_shape: flesh.proposed_shape,
      shape_charter,
      deferred_family,
      lone_spear: lone,
      workspace: prototypeWorkspace,
    })),
    { agentType: 'warpsmith', phase: 'Prototype', schema: PROTOTYPE_OUT, label: `prototype:${args.seed.ability_id}#${rn}`,
      ...prototypeAgentOptions(prototypeWorkspace) }
  )
  const prototypeDecision = prototypeGateDecision(prototype, flesh.proposed_shape, prototypeWorkspace)
  if (!prototypeDecision.passes) {
    const prototypeFinding = {
      key: `prototype:${rn}`,
      axis: 'parity',
      situation: prototypeDecision.reason,
      required_change: 'repair prototype evidence',
      blocker_evidence: {
        concrete_slice_divergence: false,
        frozen_exact_member: false,
        not_honestly_composable_or_separate: false,
        resolved_or_out_of_scope: false,
      },
    }
    finding_ledger = normalizeFindingLedger(finding_ledger, [prototypeFinding], shape_charter)
    rounds.push({ round: rn, flesh, lone, prototype, finding_ledger, verdict: 'prototype-revise' })
    continue
  }

  phase(`Trail (round ${rn})`)
  const trail = await agent(
    PRE + `Spec the describer for the chartered mechanic slice across all applicable forms. Prototype diagnostics
are binding repair input; do not solve charter non-goals. Spawn psyker. Input:\n` +
    JSON.stringify({ proposed_shape: flesh.proposed_shape, shape_charter, prototype,
      lone_spear: { parameter_deltas: lone.parameter_deltas || [], coverage: lone.coverage || [] } }),
    { agentType: 'kroot-trail-shaper', phase: 'Trail', schema: TRAIL_OUT, label: `trail:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-trail-shaper', trail, [
    { path: 'psyker_read', msg: 'trail-shaper must spawn psyker' },
    { path: 'render_rules', msg: 'no render rules specified' },
  ])
  finding_ledger = normalizeFindingLedger(
    finding_ledger,
    psykerSeverityFindings(trail.psyker_read),
    shape_charter,
  )

  phase(`War (round ${rn})`)
  const war = await agent(
    PRE + `Adversarially review the frozen charter mechanic slice on all four axes. A blocker requires a
concrete in-slice divergence on a frozen exact member that is not honestly composable/separate. Closure derives
only from an evidence-gated terminal ledger state; blocker_evidence.resolved_or_out_of_scope cannot close an open
finding. Accept only when every finding is terminal. Preserve all four booleans, distinct eversor voter/task ids,
and distinct frozen sample ability ids. Orthogonal gaps are deferred, not failures of this shape. Prototype
evidence is mandatory review input. Input:\n` +
    JSON.stringify({ flesh, lone_spear: lone, trail, prototype, shape_charter, finding_ledger, family_threshold: THRESHOLD }),
    { agentType: 'kroot-war-shaper', phase: 'War', schema: WAR_OUT, label: `war:${args.seed.ability_id}#${rn}` }
  )
  assertSpawned('kroot-war-shaper', war, [
    { path: 'eversor_refutations', msg: 'war-shaper must spawn eversor against sample members' },
    { path: 'swarmlord_recheck', msg: 'war-shaper must spawn swarmlord for an independent recheck' },
  ])
  assertScopedRefutations(war.eversor_refutations, shape_charter.mechanic_slice, shape_charter)
  finding_ledger = normalizeFindingLedger(finding_ledger, (war.findings || []).map(finding => ({ round: rn, ...finding })), shape_charter)
  const openFindings = finding_ledger.filter(finding => finding.state === 'open')
  const blockers = openFindings.map(classifyBlocker).filter(result => result.blocks)
  rounds.push({ round: rn, flesh, lone, prototype, trail, war, finding_ledger, blockers, verdict: war.verdict })

  if (war.verdict === 'accept') {
    if (openFindings.length) throw new Error('war-shaper accepted with unresolved findings')
    if (!prototype.skitarius.overall_pass) { status = 'not-converged'; continue }
    validateShapePackage(war.shape_package, shape_charter, args.seed, flesh.proposed_shape, lone.coverage, trail, prototype)
    status = 'shipped-ready'
    shape_package = war.shape_package
    break
  }
  if (war.verdict === 'reject-as-sprawl') { status = 'rejected-sprawl'; break }
  if (war.verdict === 'reject-as-singleton') { status = 'rejected-singleton'; break }
}

const terminal = status === 'not-converged' ? terminalOutcome({ rounds: rounds.length, max_rounds: MAX_ROUNDS, finding_ledger }) : null
log(`shape-scout ${args.seed.ability_id}: ${status} after ${rounds.length} round(s)`)
return { seed: args.seed, shape_charter: validateShapeCharter(shape_charter, args.seed), status, terminal, shape_package, rounds }
