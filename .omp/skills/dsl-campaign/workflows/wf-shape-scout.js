import { join } from 'node:path'
import { certifyShapeFamily, expandCampaignScope } from '../graph/scope.js'
import { GraphStore } from '../graph/store.js'
import { createTrustedAgent } from '../graph/workflow-runtime.js'

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
  preflightShapeCharter,
  resolveFindingLedger,
  terminalOutcome,
  validateShapeCharter,
  validateShapePackage,
} from './wf-shape-scout-state.js'

export const meta = {
  name: 'dsl-shape-scout',
  description: 'Design a new DSL shape for a resisted mechanic through scheduler-visible helper and lead tasks.',
  phases: [
    { title: 'Seed', detail: 'data-enginseer retrieves the resisted ability prose + committed DSL' },
    { title: 'Charter', detail: 'inquisitor freezes the exact mechanic slice, family, fixtures, and reopening rule' },
    { title: 'Shape', detail: 'scheduler-visible decomposers and retrieval seal before the kroot shape proposal' },
    { title: 'Broaden', detail: 'scheduler-visible corpus sweep seals before family adjudication' },
    { title: 'Prototype', detail: 'warpsmith prototype seals before an independent skitarius gate' },
    { title: 'Trail', detail: 'describer design seals before an independent psyker read' },
    { title: 'War', detail: 'source retrieval, eversor refutations, and corpus recheck seal before adversarial review' },
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
//   shipped-ready | existing-fits | rejected-sprawl | rejected-singleton | rejected-charter | not-converged | no-prose
//   rounds retain the full revision/prototype/review thread. `shape_charter.exact_family` is immutable:
//   discoveries outside it are deferred follow-ups unless inquisitor explicitly reopens the charter.
//   shape_package (on shipped-ready) is warpsmith's implement input: schema branch + describer + faithful family + cost.
// NO parent repo writes happen here. A prototype is a disposable isolated warpsmith worktree only.
// Every helper is invoked by this workflow as its own scheduler task. Lead agents consume sealed helper
// outputs through dependsOn labels; no lead agent may hide child work in a nested spawn.

if (typeof args === 'string') args = JSON.parse(args)
if (!args || !args.seed || !args.seed.ability_id) throw new Error('args.seed.ability_id required')
const THRESHOLD = Math.max(args.family_threshold || 4, 4)
const MAX_ROUNDS = Math.min(Math.max(args.max_rounds || 3, 1), 3)
if (args.prototype_workspaces && (!Array.isArray(args.prototype_workspaces) ||
  args.prototype_workspaces.length < MAX_ROUNDS ||
  args.prototype_workspaces.some(workspace => typeof workspace !== 'string' || !workspace.startsWith('/')))) {
  throw new Error(`prototype_workspaces requires ${MAX_ROUNDS} absolute jj workspace paths`)
}
const graphAgent = createTrustedAgent({ driverArgs: args, invokeAgent: agent })
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
    exact_family: { type: 'array', minItems: 1, items: { type: 'object', required: ['ability_id', 'faction', 'slice_signature'], properties: { ability_id: { type: 'string' }, faction: { type: 'string' }, slice_signature: { type: 'object', minProperties: 1, additionalProperties: true }, parameter_values: { type: 'object', additionalProperties: true }, rationale: { type: 'string' } } } },
    required_semantics: { type: 'array', minItems: 1, items: { type: 'string' } },
    non_goals: { type: 'array', items: { type: 'string' } },
    deferred_candidates: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction'], properties: { ability_id: { type: 'string' }, faction: { type: 'string' } }, additionalProperties: true } },
    acceptance_fixtures: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'polarity', 'input', 'expected'], properties: { id: { type: 'string', minLength: 1 }, polarity: { enum: ['positive', 'negative'] }, input: {}, expected: {} }, additionalProperties: false } },
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
const ANY_HELPER_OUT = { type: 'object', minProperties: 1, additionalProperties: true }
const PROTOTYPE_BUILD_OUT = {
  type: 'object', required: ['prototype', 'diagnostics'],
  properties: { prototype: PROTOTYPE_OUT.properties.prototype, diagnostics: PROTOTYPE_OUT.properties.diagnostics },
}
const PROTOTYPE_GATE_OUT = PROTOTYPE_OUT.properties.skitarius
const TRAIL_BUILD_OUT = {
  ...TRAIL_OUT,
  required: TRAIL_OUT.required.filter(key => key !== 'psyker_read'),
  properties: Object.fromEntries(Object.entries(TRAIL_OUT.properties).filter(([key]) => key !== 'psyker_read')),
}
const EVERSOR_OUT = WAR_OUT.properties.eversor_refutations.items

function assertSealedEvidence(agentLabel, obj, checks) {
  if (!obj) throw new Error(`${agentLabel} returned nothing`)
  for (const { path, msg } of checks) {
    const value = path.split('.').reduce((parent, key) => (parent == null ? parent : parent[key]), obj)
    const empty = value == null || (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    if (empty) throw new Error(`${agentLabel}: missing sealed helper evidence "${path}" — ${msg}`)
  }
}

phase('Seed')
const retrieval = await graphAgent(PRE + `Look up this resisted ability's raw prose and committed DSL. Input:\n` +
JSON.stringify({ query: { ability_id: args.seed.ability_id, faction_id: args.seed.faction_id } }),
{ agentType: 'data-enginseer', phase: 'Seed', schema: ENGINSEER_OUT, label: `seed:${args.seed.ability_id}`, graphEphemeralKeys: ['raw_text', 'original_rule'] })
const seedMatches = (retrieval && retrieval.matches) || []
const match = seedMatches.find(m => m.faction === args.seed.faction_id) || seedMatches[0] || null
const raw_text = args.seed.raw_text || (match && match.raw_text) || null
if (!raw_text) return { seed: args.seed, status: 'no-prose', shape_package: null, rounds: [] }

phase('Charter')
const charterDraft = await graphAgent(PRE + `Act as the authoritative shape-scout charterer. Freeze the smallest exact mechanic family before design.
The family threshold remains ${THRESHOLD} unique ability ids; retain cross-faction copies as evidence but count a
shared ability id once. Include only exact/near candidates honestly sharing this mechanic slice. Every family member
must carry the same normalized slice_signature; put member differences only in parameter_values. State required
semantics, explicit non-goals/orthogonal gaps, deferred candidates, one positive and one negative fabricated
acceptance fixture using exactly {id, polarity, input, expected}, and the explicit reopening rule. Never include raw prose. Input:\n` +
JSON.stringify({ mode: 'charter', seed: args.seed, raw_text, resisted_schema: args.seed.resisted_schema || null, retrieval, family_threshold: THRESHOLD }),
{ agentType: 'inquisitor', phase: 'Charter', schema: CHARTER_OUT, label: `charter:${args.seed.ability_id}`, dependsOn: [`seed:${args.seed.ability_id}`] })
const shape_charter = freezeShapeCharter({ seed: args.seed, mechanic_slice: charterDraft.mechanic_slice,
  family: charterDraft.exact_family, required_semantics: charterDraft.required_semantics, non_goals: charterDraft.non_goals,
  deferred_candidates: charterDraft.deferred_candidates, acceptance_fixtures: charterDraft.acceptance_fixtures,
  reopening_rules: charterDraft.reopening_rules })
const charterPreflight = preflightShapeCharter(shape_charter, THRESHOLD)
if (!charterPreflight.ok) {
  const status = charterPreflight.reason === 'below-threshold' ? 'rejected-singleton' : 'rejected-charter'
  return { seed: args.seed, shape_charter, status, reason: charterPreflight.reason, terminal: true, shape_package: null, rounds: [] }
}

const rounds = []
let finding_ledger = []
let previous_shape = null
let family_scope = null
let status = 'not-converged'
let shape_package = null
let revisionParentLabel = `charter:${args.seed.ability_id}`

for (let round = 0; round < MAX_ROUNDS; round++) {
  const rn = round + 1
  phase(`Shape (round ${rn})`)
  const roundParent = revisionParentLabel
  const helperPrefix = `shape-helper:${args.seed.ability_id}#${rn}`
  const [who, when, what, mechanicRetrieval] = await parallel([
    () => graphAgent(PRE + `Decompose WHO this mechanic applies to. Input:\n` + JSON.stringify({
      ability_id: args.seed.ability_id, faction_id: args.seed.faction_id, ability_type: args.seed.ability_type || 'unit', raw_text,
    }), { agentType: 'target-dummy', phase: 'Shape', schema: ANY_HELPER_OUT, label: `${helperPrefix}:who`, dependsOn: [roundParent], graphSourceTexts: [raw_text] }),
    () => graphAgent(PRE + `Decompose WHEN this mechanic fires. Input:\n` + JSON.stringify({
      ability_id: args.seed.ability_id, faction_id: args.seed.faction_id, ability_type: args.seed.ability_type || 'unit', raw_text,
    }), { agentType: 'chronomancer', phase: 'Shape', schema: ANY_HELPER_OUT, label: `${helperPrefix}:when`, dependsOn: [roundParent], graphSourceTexts: [raw_text] }),
    () => graphAgent(PRE + `Decompose WHAT this mechanic does. Input:\n` + JSON.stringify({
      ability_id: args.seed.ability_id, faction_id: args.seed.faction_id, ability_type: args.seed.ability_type || 'unit', raw_text,
    }), { agentType: 'vox-hound', phase: 'Shape', schema: ANY_HELPER_OUT, label: `${helperPrefix}:what`, dependsOn: [roundParent], graphSourceTexts: [raw_text] }),
    () => graphAgent(PRE + `Retrieve certified analogues for this exact mechanic slice. Input:\n` + JSON.stringify({
      query: { mechanic: shape_charter.mechanic_slice, example_ability_id: args.seed.ability_id, faction_id: args.seed.faction_id },
    }), { agentType: 'data-enginseer', phase: 'Shape', schema: ENGINSEER_OUT, label: `${helperPrefix}:retrieval`, dependsOn: [roundParent], graphEphemeralKeys: ['raw_text', 'original_rule'] }),
  ])
  const fleshDependencies = ['who', 'when', 'what', 'retrieval'].map(suffix => `${helperPrefix}:${suffix}`)
  const flesh = await graphAgent(PRE + `Design the chartered mechanic slice only. Use the sealed helper evidence supplied here; do not spawn helpers.
  On round one propose the smallest honest shape; on later rounds REVISE previous_shape rather than resynthesizing it:
  retain its name/kind and report explicit changes. Every open ledger finding must be addressed; orthogonal gaps remain
  deferred separate primitives. Copy decomposition and retrieval evidence into the output. Input:\n` + JSON.stringify({
    seed_ability_id: args.seed.ability_id, faction_id: args.seed.faction_id, raw_text,
    resisted_schema: args.seed.resisted_schema || null, shape_charter, previous_shape, finding_ledger,
    sealed_helpers: { decomposition: { who, when, what }, retrieval: mechanicRetrieval },
  }),
  { agentType: 'kroot-flesh-shaper', phase: 'Shape', schema: FLESH_OUT, label: `flesh:${args.seed.ability_id}#${rn}`, dependsOn: fleshDependencies, graphSourceTexts: [raw_text] })
  assertSealedEvidence('kroot-flesh-shaper', flesh, [
    { path: 'decomposition.what', msg: 'sealed decomposer evidence was not copied' },
    { path: 'retrieval', msg: 'sealed retrieval evidence was not copied' },
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
  const sweepLabel = `sweep:${args.seed.ability_id}#${rn}`
  const swarmlordSweep = await graphAgent(PRE + `Sweep other factions for the family of this proposed shape. Input:\n` + JSON.stringify({
    shape: flesh.proposed_shape, example_ability_id: args.seed.ability_id, frozen_charter: shape_charter,
  }), { agentType: 'swarmlord', phase: 'Broaden', schema: ANY_HELPER_OUT, label: sweepLabel, dependsOn: [`flesh:${args.seed.ability_id}#${rn}`] })
  const lone = await graphAgent(PRE + `Adjudicate the sealed corpus sweep; do not spawn helpers. The coverage array MUST contain exactly one
  entry for every frozen exact-family member and no other ability. Put every discovery outside that frozen family in
  deferred_candidates, even when it is near or needs a parameter. Count a shared ability id once while retaining
  cross-faction copies as evidence. Do not mutate the charter or inflate acceptance. Copy sealed_swarmlord_sweep
  verbatim to swarmlord_sweep. Input:\n` + JSON.stringify({
    proposed_shape: flesh.proposed_shape, seed_ability_id: args.seed.ability_id,
    faction_id: args.seed.faction_id, shape_charter, previous_shape, sealed_swarmlord_sweep: swarmlordSweep,
  }),
  { agentType: 'kroot-lone-spear', phase: 'Broaden', schema: LONESPEAR_OUT, label: `spear:${args.seed.ability_id}#${rn}`, dependsOn: [sweepLabel] })
  assertSealedEvidence('kroot-lone-spear', lone, [{ path: 'swarmlord_sweep', msg: 'sealed swarmlord evidence was not copied' }])
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
      `Pass the same absolute workspace path and path rule to the separate skitarius task. Never read, edit, generate into, ` +
      `or run a command in the parent checkout ${args.repo_root}. `
    : PRE
  const prototypeBuildLabel = `prototype-build:${args.seed.ability_id}#${rn}`
  const prototypeBuild = await graphAgent(prototypePRE + `Implement a disposable minimal vertical prototype of this proposed shape in an
  ISOLATED, NON-APPLIED worktree. Do not edit the parent checkout or data. Implement the actual schema branch,
  necessary generated/TS surface, one describer path, and fabricated positive/negative probes. Do not spawn skitarius;
  return the worktree and concrete prototype evidence for its separate scheduler task. applied_to_parent MUST be false.
  Input:\n` + JSON.stringify(prototypeAgentInput({
    proposed_shape: flesh.proposed_shape,
    shape_charter,
    deferred_family,
    lone_spear: lone,
    workspace: prototypeWorkspace,
  })),
  { agentType: 'warpsmith', phase: 'Prototype', schema: PROTOTYPE_BUILD_OUT, label: prototypeBuildLabel,
    dependsOn: [`spear:${args.seed.ability_id}#${rn}`], ...prototypeAgentOptions(prototypeWorkspace) })
  const prototypeGateLabel = `prototype-gate:${args.seed.ability_id}#${rn}`
  const skitarius = await graphAgent(prototypePRE + `Run the targeted compiler, schema positive/negative, and describer render
  gates against this sealed prototype worktree. Do not edit it. Return concrete compiler_evidence, schema_evidence,
  and render_evidence. Input:\n` + JSON.stringify({ prototype: prototypeBuild.prototype, proposed_shape: flesh.proposed_shape }),
  { agentType: 'skitarius', phase: 'Prototype', schema: PROTOTYPE_GATE_OUT, label: prototypeGateLabel, dependsOn: [prototypeBuildLabel] })
  const prototype = { ...prototypeBuild, skitarius }
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
    revisionParentLabel = prototypeGateLabel
    continue
  }

  phase(`Trail (round ${rn})`)
  const trailBuildLabel = `trail-build:${args.seed.ability_id}#${rn}`
  const trailBuild = await graphAgent(PRE + `Spec the describer for the chartered mechanic slice across all applicable forms.
  Prototype diagnostics are binding repair input; do not solve charter non-goals and do not spawn psyker. Return the
  proposed render rules for a separate cold-read task. Input:\n` +
  JSON.stringify({ proposed_shape: flesh.proposed_shape, shape_charter, prototype,
    lone_spear: { parameter_deltas: lone.parameter_deltas || [], coverage: lone.coverage || [] } }),
  { agentType: 'kroot-trail-shaper', phase: 'Trail', schema: TRAIL_BUILD_OUT, label: trailBuildLabel, dependsOn: [prototypeGateLabel] })
  const psykerLabel = `psyker:${args.seed.ability_id}#${rn}`
  const psykerRead = await graphAgent(PRE + `Cold-read these proposed describer renders for intelligibility and fidelity. Return
  findings with severity and concrete phrasing evidence. Input:\n` + JSON.stringify({
    ability_ids: shape_charter.exact_family.map(member => member.ability_id),
    proposed_shape: flesh.proposed_shape,
    render_rules: trailBuild.render_rules,
  }), { agentType: 'psyker', phase: 'Trail', schema: ANY_HELPER_OUT, label: psykerLabel, dependsOn: [trailBuildLabel] })
  const trail = { ...trailBuild, psyker_read: psykerRead }
  assertSealedEvidence('kroot-trail-shaper', trail, [
    { path: 'psyker_read', msg: 'sealed psyker evidence missing' },
    { path: 'render_rules', msg: 'no render rules specified' },
  ])
  finding_ledger = normalizeFindingLedger(finding_ledger, psykerSeverityFindings(trail.psyker_read), shape_charter)

  phase(`War (round ${rn})`)
  const reviewMembers = shape_charter.exact_family.filter((member, index, family) =>
    family.findIndex(candidate => candidate.ability_id === member.ability_id) === index).slice(0, 2)
  if (reviewMembers.length < 2) throw new Error('war review requires two distinct frozen ability ids')
  const reviewSourceLabels = reviewMembers.map((_, index) => `war-source:${args.seed.ability_id}#${rn}:${index + 1}`)
  const swarmlordRecheckLabel = `war-sweep:${args.seed.ability_id}#${rn}`
  const sourceAndSweep = await parallel([
    ...reviewMembers.map((member, index) => () => graphAgent(PRE + `Retrieve the authoritative raw prose for this frozen family member. Input:\n` +
      JSON.stringify({ query: { ability_id: member.ability_id, faction_id: member.faction } }),
    { agentType: 'data-enginseer', phase: 'War', schema: ENGINSEER_OUT, label: reviewSourceLabels[index], dependsOn: [psykerLabel], graphEphemeralKeys: ['raw_text', 'original_rule'] })),
    () => graphAgent(PRE + `Independently re-check the cross-faction family for this proposed shape. Input:\n` +
      JSON.stringify({ shape: flesh.proposed_shape, example_ability_id: args.seed.ability_id, frozen_charter: shape_charter }),
    { agentType: 'swarmlord', phase: 'War', schema: ANY_HELPER_OUT, label: swarmlordRecheckLabel, dependsOn: [psykerLabel] }),
  ])
  const swarmlordRecheck = sourceAndSweep.at(-1)
  const reviewSources = sourceAndSweep.slice(0, -1)
  const eversorLabels = reviewMembers.map((_, index) => `eversor:${args.seed.ability_id}#${rn}:${index + 1}`)
  const eversorRefutations = await parallel(reviewMembers.map((member, index) => () => {
    const lookup = reviewSources[index]
    const sourceMatch = lookup.matches.find(item => item.ability_id === member.ability_id && item.faction === member.faction) || lookup.matches[0]
    if (!sourceMatch?.raw_text) throw new Error(`war source unavailable: ${member.faction}/${member.ability_id}`)
    return graphAgent(PRE + `Cold-read this frozen member against the proposed shape only within the chartered mechanic slice.
    Do not review orthogonal prose. Return voter_id exactly as the supplied label, the sampled ability_id, matching
    review_scope.mechanic_slice, refuted, and concrete divergences. Input:\n` + JSON.stringify({
      voter_id: eversorLabels[index], ability_id: member.ability_id, raw_text: sourceMatch.raw_text,
      candidate_shape: flesh.proposed_shape, review_scope: { mechanic_slice: shape_charter.mechanic_slice },
    }), { agentType: 'eversor', phase: 'War', schema: EVERSOR_OUT, label: eversorLabels[index],
      dependsOn: [reviewSourceLabels[index]], graphSourceTexts: [sourceMatch.raw_text] })
  }))
  const warDependencies = [...eversorLabels, swarmlordRecheckLabel]
  const war = await graphAgent(PRE + `Adversarially review the frozen charter mechanic slice on all four axes using only the sealed
  refutations and family recheck; do not spawn helpers. A blocker requires a concrete in-slice divergence on a frozen
  exact member that is not honestly composable/separate. Closure derives only from an evidence-gated terminal ledger
  state. Accept only when every finding is terminal. Copy sealed_eversor_refutations and sealed_swarmlord_recheck
  verbatim into the output. Orthogonal gaps are deferred. Input:\n` +
  JSON.stringify({ flesh, lone_spear: lone, trail, prototype, shape_charter, finding_ledger, family_threshold: THRESHOLD,
    sealed_eversor_refutations: eversorRefutations, sealed_swarmlord_recheck: swarmlordRecheck }),
  { agentType: 'kroot-war-shaper', phase: 'War', schema: WAR_OUT, label: `war:${args.seed.ability_id}#${rn}`, dependsOn: warDependencies })
  assertSealedEvidence('kroot-war-shaper', war, [
    { path: 'eversor_refutations', msg: 'sealed eversor evidence missing' },
    { path: 'swarmlord_recheck', msg: 'sealed swarmlord recheck missing' },
  ])
  assertScopedRefutations(war.eversor_refutations, shape_charter.mechanic_slice, shape_charter)
  finding_ledger = normalizeFindingLedger(finding_ledger, (war.findings || []).map(finding => ({ round: rn, ...finding })), shape_charter)
  const openFindings = finding_ledger.filter(finding => finding.state === 'open')
  const blockers = openFindings.map(classifyBlocker).filter(result => result.blocks)
  rounds.push({ round: rn, flesh, lone, prototype, trail, war, finding_ledger, blockers, verdict: war.verdict })
  revisionParentLabel = `war:${args.seed.ability_id}#${rn}`

  if (war.verdict === 'accept') {
    if (openFindings.length) throw new Error('war-shaper accepted with unresolved findings')
    if (!prototype.skitarius.overall_pass) { status = 'not-converged'; continue }
    validateShapePackage(war.shape_package, shape_charter, args.seed, flesh.proposed_shape, lone.coverage, trail, prototype)
    status = 'shipped-ready'
    shape_package = war.shape_package
    const scopeStore = new GraphStore(args.graph_root, { repositoryRoot: args.repo_root })
    try {
      const repository = scopeStore.db.prepare("SELECT payload_json FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
      if (!repository) throw new Error('repository-version node missing before family scope expansion')
      const certified = certifyShapeFamily(scopeStore, {
        run_id: args.run_id,
        shape_package,
        shape_package_node_id: war.sealed_output_node_id,
      })
      family_scope = {
        ...certified,
        expansion: expandCampaignScope(scopeStore, {
          run_id: args.run_id,
          expected_repository_hash: JSON.parse(repository.payload_json).workspace_hash,
          raw_store_root: join(args.repo_root, '..', '40kdc-abilities'),
          family_template_node_id: certified.family_template_node_id,
          family_members: certified.family_members,
          apply_transaction_id: `${args.run_id}:family-apply:${certified.family_template_node_id.slice(0, 16)}`,
        }),
      }
    } finally {
      scopeStore.close()
    }
    break
  }
  if (war.verdict === 'reject-as-sprawl') { status = 'rejected-sprawl'; break }
  if (war.verdict === 'reject-as-singleton') { status = 'rejected-singleton'; break }
}

const terminal = status === 'not-converged' ? terminalOutcome({ rounds: rounds.length, max_rounds: MAX_ROUNDS, finding_ledger }) : null
return { seed: args.seed, shape_charter: validateShapeCharter(shape_charter, args.seed), status, terminal, shape_package, family_scope, rounds }
