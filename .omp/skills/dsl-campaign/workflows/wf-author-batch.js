import { createTrustedAgent } from '../graph/workflow-runtime.js'
import { GraphStore } from '../graph/store.js'
import { projectedClaimSet, validateCandidateClaimCoverage, persistRepresentationClaimCoverage } from '../graph/retrieval.js'
import { sha256, canonicalJson } from '../graph/canonical.js'

export const meta = {
  name: 'dsl-author-batch',
  description: 'Construct → assemble → refute one batch from a verified claim-set plan (read-only agents; no repo writes)',
  phases: [
    { title: 'Retrieve', detail: 'data-enginseer prose lookup for independent refutation' },
    { title: 'Assemble', detail: 'arch-magos consumes accepted claim propositions and certified construction plan' },
    { title: 'Refute', detail: 'eversor panel independently reads source prose; concrete divergence blocks' },
  ],
}

// args: {
//   batch_id: string,
//   new_shapes: string[],          // recently shipped effect/condition types → 3-voter panel
//   abilities: [{ ability_id, faction_id, name?, ability_type?, detachment_id?,
//                 cos_start?, prior_reject?, previous_cosine? }]
// }
// Returns: { batch_id, results: [{ ability, status, candidate, verdicts, thread, decomposition, attempts }] }
//   thread: [{ attempt, dsl, describer_output, refuted, divergences }] — the FULL per-round
//   revision history (not just the terminal round), so cyclical revisions are recorded in loop-state.
// status ∈ accepted | rejected | needs-schema | no-prose | agent-error
// NO repo writes happen here. Prose (GW IP) transits agent JSON and this run's
// journal only — the driver must never copy it into a repo file.

// The runtime may deliver args as a JSON string — normalize before touching fields.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !Array.isArray(args.abilities)) throw new Error('args.abilities required')
if (args.abilities.length > 8) throw new Error(`batch too large: ${args.abilities.length} > 8 (grain is 5–6)`)
for (const ability of args.abilities) {
  for (const field of ['claim_set_certificate_node_id', 'construction_plan_node_id']) {
    if (typeof ability[field] !== 'string' || !/^[a-f0-9]{64}$/.test(ability[field]))
      throw new Error(`${ability.faction_id}/${ability.ability_id}: ${field} required`)
  }
  if (!Array.isArray(ability.selected_evidence_node_ids) ||
      ability.selected_evidence_node_ids.some(id => !/^[a-f0-9]{64}$/.test(id)))
    throw new Error(`${ability.faction_id}/${ability.ability_id}: selected_evidence_node_ids required`)
  if (!Array.isArray(ability.unmatched_claim_occurrence_ids))
    throw new Error(`${ability.faction_id}/${ability.ability_id}: unmatched_claim_occurrence_ids required`)
}

function loadAuthorPlan(graphRoot, ability) {
  const store = new GraphStore(graphRoot)
  try {
    const claimSet = projectedClaimSet(store, { certificate_node_id: ability.claim_set_certificate_node_id, obligation: 'represent' })
    if (claimSet.source_claims.some(claim => !claim.claim_occurrence_id)) throw new Error('claim-set contains legacy claim identifier')
    const expectedSubject = `ability:${ability.faction_id}/${ability.ability_id}`
    const subject = store.db.prepare('SELECT subject_ref FROM claim_sets WHERE claim_set_id=?').get(claimSet.claim_set_id)
    if (!subject || subject.subject_ref !== expectedSubject) throw new Error(`${ability.faction_id}/${ability.ability_id}: claim-set subject mismatch`)
    const planNode = store.db.prepare("SELECT payload_json FROM nodes WHERE node_id=? AND kind='construction-plan'").get(ability.construction_plan_node_id)
    if (!planNode) throw new Error(`${ability.faction_id}/${ability.ability_id}: construction plan missing`)
    const plan = JSON.parse(planNode.payload_json)
    if (plan.claim_set_id !== claimSet.claim_set_id || plan.state === 'blocked') throw new Error(`${ability.faction_id}/${ability.ability_id}: construction plan is stale or blocked`)
    if (JSON.stringify(plan.selected_evidence_node_ids) !== JSON.stringify(ability.selected_evidence_node_ids) ||
        JSON.stringify(plan.unmatched_claim_occurrence_ids) !== JSON.stringify(ability.unmatched_claim_occurrence_ids)) {
      throw new Error(`${ability.faction_id}/${ability.ability_id}: author input does not match construction plan`)
    }
    const planDependency = store.db.prepare('SELECT 1 FROM edges WHERE child_node_id=? AND parent_node_id=?').get(ability.construction_plan_node_id, ability.claim_set_certificate_node_id)
    if (!planDependency) throw new Error(`${ability.faction_id}/${ability.ability_id}: construction plan dependency missing`)
    const selected = new Set(plan.selected_evidence_node_ids)
    if (plan.covered_claim_occurrence_ids.some(id => !claimSet.source_claims.some(claim => claim.claim_occurrence_id === id))) {
      throw new Error(`${ability.faction_id}/${ability.ability_id}: construction plan covers foreign occurrence`)
    }
    if ([...selected].some(id => !store.hasNode(id))) throw new Error(`${ability.faction_id}/${ability.ability_id}: selected evidence missing`)
    return { claimSet, plan }
  } finally {
    store.close()
  }
}


function certifyCandidateCoverage(graphRoot, ability, expectedPlan, candidate) {
  const current = loadAuthorPlan(graphRoot, ability)
  if (current.claimSet.claim_set_id !== expectedPlan.claimSet.claim_set_id ||
      current.claimSet.source_snapshot_id !== expectedPlan.claimSet.source_snapshot_id) {
    return { ok: false, reason: 'claim-set-currentness-failed' }
  }
  const currentClaimOccurrenceIds = current.claimSet.source_claims.map(claim => claim.claim_occurrence_id)
  const gate = validateCandidateClaimCoverage({
    source_claims: current.claimSet.source_claims,
    plan: current.plan,
    covered_claim_occurrence_ids: candidate.covered_claim_occurrence_ids,
    composition_seams: candidate.composition_seams,
    current_claim_occurrence_ids: currentClaimOccurrenceIds,
  })
  if (!gate.ok) return gate

  const store = new GraphStore(graphRoot)
  try {
    let representation
    store.transaction(() => {
      representation = store.createNode({
        kind: 'candidate-certificate',
        payload: {
          faction_id: ability.faction_id,
          ability_id: ability.ability_id,
          status: 'accepted',
          fingerprints: { candidate_sha256: sha256(canonicalJson(candidate)) },
          checks: { claim_coverage: 'exact-once-no-foreign-current-seams' },
        },
        parents: [
          { node_id: ability.claim_set_certificate_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} },
          { node_id: ability.construction_plan_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} },
        ],
      })
      persistRepresentationClaimCoverage(store, {
        representation_node_id: representation.node_id,
        claim_set_id: current.claimSet.claim_set_id,
        construction_plan_node_id: ability.construction_plan_node_id,
        claim_occurrence_ids: gate.covered_claim_occurrence_ids,
      })
    })
    return { ok: true, representation_node_id: representation.node_id }
  } finally {
    store.close()
  }
}
const authorPlans = new Map(args.abilities.map(ability => [`${ability.faction_id}/${ability.ability_id}`, loadAuthorPlan(args.graph_root, ability)]))
const NEW_SHAPES = args.new_shapes || []
const graphAgent = createTrustedAgent({ driverArgs: args, invokeAgent: agent })
const TASK_LABEL_PREFIX = typeof args.task_label_prefix === 'string' && args.task_label_prefix
  ? `${args.task_label_prefix}:`
  : ''
// Pin every agent to the loop workspace: subagents inherit the DRIVER session's cwd,
// which may be a different checkout of this repo (a parallel session's working copy).
const PRE = args.repo_root
  ? `Repo root: ${args.repo_root} — cd there first; run every command and resolve every ` +
    `relative path (including ../40kdc-abilities and ../40kdc-embeddings) against it. ` +
    `Never read or write any other checkout of this repo.\n`
  : ''

// ---- frozen Output contracts, transcribed to JSON Schema (do not redesign) ----
const ENGINSEER_OUT = {
  type: 'object', required: ['matches', 'method'],
  properties: {
    matches: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'raw_text', 'has_dsl'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        raw_text: { type: ['string', 'null'] }, has_dsl: { type: 'boolean' },
        committed_dsl_path: { type: ['string', 'null'] },
        other_faction_copies: { type: 'array', items: { type: 'string' } } } } },
    comparison: { type: ['object', 'null'], additionalProperties: true },
    method: { enum: ['index-lookup', 'grep', 'embeddings'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
}
const ARCHMAGOS_OUT = {
  type: 'object',
  required: ['ability_id', 'dsl', 'approx_notes', 'dropped_clauses', 'adopted_shapes', 'self_grade', 'confidence', 'covered_claim_occurrence_ids', 'composition_seams'],
  properties: {
    ability_id: { type: 'string' }, dsl: { type: ['object', 'null'], additionalProperties: true },
    approx_notes: { type: 'array', items: { type: 'string' } },
    dropped_clauses: { type: 'array', items: { type: 'string' } },
    adopted_shapes: { type: 'array', items: { type: 'string' } },
    resisted_schema: { type: ['object', 'null'], additionalProperties: true },
    self_grade: { type: 'object', required: ['describer_output', 'verdict'],
      properties: { describer_output: { type: 'string' },
        verdict: { enum: ['faithful', 'approx', 'needs-schema'] }, concerns: { type: 'array', items: { type: 'string' } } } },
    confidence: { type: 'number' },
    covered_claim_occurrence_ids: { type: 'array', items: { type: 'string' } },
    composition_seams: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
}
const EVERSOR_OUT = {
  type: 'object', required: ['ability_id', 'refuted', 'divergences', 'approx_covered', 'review_scope', 'confidence'],
  properties: {
    ability_id: { type: 'string' }, refuted: { type: 'boolean' },
    review_scope: { type: ['object', 'null'], additionalProperties: true },
    divergences: { type: 'array', items: { type: 'object',
      required: ['situation', 'prose_says', 'dsl_says'],
      properties: {
        situation: { type: 'string' }, prose_says: { type: 'string' }, dsl_says: { type: 'string' },
        affected_claim_occurrence_ids: { type: 'array', items: { type: 'string' } },
      } } },
    approx_covered: { type: 'boolean' }, confidence: { type: 'number' },
  },
}
const results = await pipeline(
  args.abilities,

  async a => ({
    ability: a,
    retrieval: await graphAgent(PRE + `Look up this ability's raw prose and committed DSL. Input:\n` +
    JSON.stringify({ query: { ability_id: a.ability_id, faction_id: a.faction_id } }),
    { agentType: 'data-enginseer', phase: 'Retrieve', schema: ENGINSEER_OUT, label: `${TASK_LABEL_PREFIX}retrieve:${a.ability_id}`, graphEphemeralKeys: ['raw_text', 'original_rule'] }),
  }),

  async retrieved => {
    const { ability: a, retrieval: ret } = retrieved || {}
    if (!a) return { ability: a, status: 'agent-error', candidate: null, verdicts: [], attempts: 0 }
    if (!ret) return { ability: a, status: 'agent-error', candidate: null, verdicts: [], attempts: 0 }
    const match =
      (ret.matches || []).find(m => m.faction === a.faction_id) || (ret.matches || [])[0] || null
    if (!match || !match.raw_text)
      return { ability: a, status: 'no-prose', candidate: null, verdicts: [], attempts: 0 }

    const planContext = authorPlans.get(`${a.faction_id}/${a.ability_id}`)
    if (!planContext) return { ability: a, status: 'agent-error', candidate: null, verdicts: [], attempts: 0 }
    const snapshot = new GraphStore(args.graph_root)
    try {
      const source = snapshot.db.prepare('SELECT payload_json FROM source_snapshots WHERE id=?').get(planContext.claimSet.source_snapshot_id)
      if (!source || JSON.parse(source.payload_json).byte_hash !== sha256(match.raw_text)) {
        throw new Error(`${a.faction_id}/${a.ability_id}: retrieved prose does not match claim-set source snapshot`)
      }
    } finally {
      snapshot.close()
    }
    const baseInput = {
      ability_id: a.ability_id, name: a.name || a.ability_id, raw_text: match.raw_text,
      ability_type: a.ability_type || null, faction_id: a.faction_id,
      detachment_id: a.detachment_id || null,
    }
    const planInput = {
      claim_set_id: planContext.claimSet.claim_set_id,
      claim_set_certificate_node_id: a.claim_set_certificate_node_id,
      construction_plan_node_id: a.construction_plan_node_id,
      accepted_claims: planContext.claimSet.source_claims,
      unresolved_items: planContext.claimSet.unresolved,
      selected_evidence_node_ids: planContext.plan.selected_evidence_node_ids,
      covered_claim_occurrence_ids: planContext.plan.covered_claim_occurrence_ids,
      unmatched_claim_occurrence_ids: planContext.plan.unmatched_claim_occurrence_ids,
      substitutions: planContext.plan.substitutions,
      composition_seams: planContext.plan.composition_seams,
    }

    let candidate = null
    let verdicts = []
    let attempts = 0
    // Full revision thread across attempts (loop-round capture): every attempt's DSL +
    // panel divergences, so a revision sees ALL prior rounds — not just the last — and
    // cannot silently re-break a divergence an earlier round already resolved. The whole
    // thread rides back to the driver for loop-state, not just the terminal verdicts.
    const thread = []
    for (let attempt = 0; attempt < 4; attempt++) {          // retry cap: 4 (forced terminal after)
      attempts = attempt + 1
      const assembleInput = {
        ...baseInput,
        claim_plan: planInput,
        retrieval: ret,
        previous_dsl: match.has_dsl ? '(committed at ' + (match.committed_dsl_path || 'unknown') + ' — read it)' : null,
        previous_cosine: a.previous_cosine ?? a.cos_start ?? null,
      }
      const revision = thread.length
        ? `\n\n${thread.length} prior attempt(s) were refuted. Address or rebut EACH divergence across ` +
          `ALL rounds below — a rebuttal goes in self_grade.concerns with evidence; never silently ` +
          `drop an accepted occurrence to dodge one, and never reintroduce a resolved divergence:\n` +
          JSON.stringify(thread.map(t => ({ round: t.attempt, refuted: t.refuted, divergences: t.divergences })))
        : ''
      candidate = await graphAgent(PRE + `Assemble the DSL entry from the accepted claim propositions and certified plan. ` +
      `The source prose remains authoritative; every covered occurrence must be represented exactly once, no foreign occurrence may be represented, ` +
      `and blocked or unmatched occurrences must not be silently invented. If the schema cannot express an accepted claim honestly, return resisted_schema. ` +
      `Input:\n${JSON.stringify(assembleInput)}${revision}`,
      { agentType: 'arch-magos', phase: 'Assemble', schema: ARCHMAGOS_OUT, label: `${TASK_LABEL_PREFIX}assemble:${a.ability_id}#${attempts}` })
      if (!candidate) return { ability: a, status: 'agent-error', candidate: null, verdicts, thread, attempts }
      if (candidate.resisted_schema)
        return { ability: a, status: 'needs-schema', candidate, verdicts, thread, attempts }

      const escalate =
        (typeof candidate.confidence === 'number' && candidate.confidence < 0.7) ||
        !!a.prior_reject || attempt > 0 ||
        (candidate.adopted_shapes || []).some(s => NEW_SHAPES.includes(s))
      const n = escalate ? 3 : 2

      const refuteInput = JSON.stringify({
        ability_id: a.ability_id, raw_text: match.raw_text, dsl: candidate.dsl,
        describer_output: candidate.self_grade?.describer_output || null,
        approx_notes: candidate.approx_notes || [],
        claim_occurrence_ids: planContext.claimSet.source_claims.map(claim => claim.claim_occurrence_id),
      })
      verdicts = (await parallel(Array.from({ length: n }, (_, i) => () =>
        graphAgent(PRE + `You are refuter ${i + 1} of ${n}; work independently — derive expected behavior from the PROSE ONLY. ` +
        `refuted:true requires a CONCRETE constructed game state. A clause declared in approx_notes is not a divergence; ` +
        `an undeclared gap is. Name affected_claim_occurrence_ids when the divergence can be associated with an accepted claim. ` +
        `Input:\n${refuteInput}`,
        { agentType: 'eversor', phase: 'Refute', schema: EVERSOR_OUT, label: `${TASK_LABEL_PREFIX}refute:${a.ability_id}#${attempts}v${i + 1}` })
      ))).filter(Boolean)

      thread.push({
        attempt: attempts,
        dsl: candidate.dsl,
        describer_output: candidate.self_grade?.describer_output || null,
        refuted: verdicts.some(v => v.refuted),
        divergences: verdicts.flatMap(v => v.divergences || []),
      })
      if (verdicts.length >= 2 && verdicts.every(v => !v.refuted)) {
        const coverage = certifyCandidateCoverage(args.graph_root, a, planContext, candidate)
        if (!coverage.ok) {
          thread.push({ attempt: attempts, dsl: candidate.dsl, describer_output: candidate.self_grade?.describer_output || null, refuted: true, divergences: [{ situation: 'claim coverage gate', prose_says: 'candidate must cover each current planned occurrence exactly once', dsl_says: coverage.reason }] })
          continue
        }
        return { ability: a, status: 'accepted', candidate, verdicts, thread, claim_plan: planInput, representation_node_id: coverage.representation_node_id, attempts }
      }
    }
    return { ability: a, status: 'rejected', candidate, verdicts, thread, claim_plan: planInput, attempts }
  }
)

const out = results.filter(Boolean)
const counts = {}
for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1
log(`batch ${args.batch_id}: ${JSON.stringify(counts)}`)
return { batch_id: args.batch_id, results: out }
