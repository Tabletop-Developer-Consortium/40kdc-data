export const meta = {
  name: 'dsl-author-batch',
  description: 'Decompose → assemble → refute one batch of abilities (read-only agents; no repo writes)',
  phases: [
    { title: 'Retrieve', detail: 'data-enginseer prose + committed-DSL lookup per ability' },
    { title: 'Decompose', detail: 'target-dummy WHO ∥ chronomancer WHEN ∥ vox-hound WHAT' },
    { title: 'Assemble', detail: 'arch-magos, ≤4 attempts, revising on panel divergences' },
    { title: 'Refute', detail: 'eversor panel — 2 routine / 3 escalated; any concrete divergence blocks' },
  ],
}

// args: {
//   batch_id: string,
//   new_shapes: string[],          // recently shipped effect/condition types → 3-voter panel
//   abilities: [{ ability_id, faction_id, name?, ability_type?, detachment_id?,
//                 cos_start?, prior_reject?, previous_cosine? }]
// }
// Returns: { batch_id, results: [{ ability, status, candidate, verdicts, decomposition, attempts }] }
// status ∈ accepted | rejected | needs-schema | no-prose | agent-error
// NO repo writes happen here. Prose (GW IP) transits agent JSON and this run's
// journal only — the driver must never copy it into a repo file.

// The runtime may deliver args as a JSON string — normalize before touching fields.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !Array.isArray(args.abilities)) throw new Error('args.abilities required')
if (args.abilities.length > 8) throw new Error(`batch too large: ${args.abilities.length} > 8 (grain is 5–6)`)
const NEW_SHAPES = args.new_shapes || []
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
    comparison: { type: ['object', 'null'] },
    method: { enum: ['index-lookup', 'grep', 'embeddings'] },
    notes: { type: 'array' },
  },
}
const WHO_OUT = {
  type: 'object', required: ['ability_id', 'bearer', 'beneficiary', 'scope_target', 'confidence'],
  properties: {
    ability_id: { type: 'string' }, bearer: { type: 'string' }, beneficiary: { type: 'string' },
    applies_to: { type: ['object', 'null'] }, scope_target: { type: 'string' },
    effect_target_params: { type: ['object', 'null'] },
    keyword_gates: { type: 'array', items: { type: 'string' } },
    excludes: { type: 'array', items: { type: 'string' } },
    lookups_needed: { type: 'array' }, confidence: { type: 'number' },
  },
}
const WHEN_OUT = {
  type: 'object', required: ['ability_id', 'behavior', 'duration', 'confidence'],
  properties: {
    ability_id: { type: 'string' },
    behavior: { enum: ['passive', 'activated', 'reactive', 'aura'] },
    trigger: { type: ['object', 'null'] },
    phase_conditions: { type: 'array' },
    canonical_condition_ids: { type: 'array', items: { type: 'string' } },
    duration: { type: 'string' }, usage: { type: ['object', 'null'] },
    lookups_needed: { type: 'array' }, confidence: { type: 'number' },
  },
}
const WHAT_OUT = {
  type: 'object', required: ['ability_id', 'leaf_types_used', 'composition', 'buff_or_debuff', 'confidence'],
  properties: {
    ability_id: { type: 'string' }, effect_tree: { type: ['object', 'null'] },
    leaf_types_used: { type: 'array', items: { type: 'string' } },
    composition: { enum: ['choice', 'sequence', 'conditional', 'dice-gated', 'aura', 'none'] },
    dice_mechanics: { type: 'array' }, buff_or_debuff: { enum: ['buff', 'debuff', 'both', 'neutral'] },
    unmodelable_clauses: { type: 'array', items: { type: 'string' } },
    lookups_needed: { type: 'array' }, confidence: { type: 'number' },
  },
}
const ARCHMAGOS_OUT = {
  type: 'object',
  required: ['ability_id', 'dsl', 'approx_notes', 'dropped_clauses', 'adopted_shapes', 'self_grade', 'confidence'],
  properties: {
    ability_id: { type: 'string' }, dsl: { type: ['object', 'null'] },
    approx_notes: { type: 'array', items: { type: 'string' } },
    dropped_clauses: { type: 'array' },
    adopted_shapes: { type: 'array', items: { type: 'string' } },
    resisted_schema: { type: ['object', 'null'] },
    self_grade: { type: 'object', required: ['describer_output', 'verdict'],
      properties: { describer_output: { type: 'string' },
        verdict: { enum: ['faithful', 'approx', 'needs-schema'] }, concerns: { type: 'array' } } },
    confidence: { type: 'number' },
  },
}
const EVERSOR_OUT = {
  type: 'object', required: ['ability_id', 'refuted', 'divergences', 'approx_covered', 'confidence'],
  properties: {
    ability_id: { type: 'string' }, refuted: { type: 'boolean' },
    divergences: { type: 'array', items: { type: 'object',
      required: ['situation', 'prose_says', 'dsl_says'],
      properties: { situation: { type: 'string' }, prose_says: { type: 'string' }, dsl_says: { type: 'string' } } } },
    approx_covered: { type: 'boolean' }, confidence: { type: 'number' },
  },
}

const results = await pipeline(
  args.abilities,

  a => agent(
    PRE + `Look up this ability's raw prose and committed DSL. Input:\n` +
    JSON.stringify({ query: { ability_id: a.ability_id, faction_id: a.faction_id } }),
    { agentType: 'data-enginseer', phase: 'Retrieve', schema: ENGINSEER_OUT, label: `retrieve:${a.ability_id}` }
  ),

  async (ret, a) => {
    if (!ret) return { ability: a, status: 'agent-error', candidate: null, verdicts: [], attempts: 0 }
    const match =
      (ret.matches || []).find(m => m.faction === a.faction_id) || (ret.matches || [])[0] || null
    if (!match || !match.raw_text)
      return { ability: a, status: 'no-prose', candidate: null, verdicts: [], attempts: 0 }

    const baseInput = {
      ability_id: a.ability_id, name: a.name || a.ability_id, raw_text: match.raw_text,
      ability_type: a.ability_type || null, faction_id: a.faction_id,
      detachment_id: a.detachment_id || null,
    }
    const dec = JSON.stringify(baseInput)
    const [who, when, what] = await parallel([
      () => agent(PRE + `Decompose WHO for this ability. Input:\n${dec}`,
        { agentType: 'target-dummy', phase: 'Decompose', schema: WHO_OUT, label: `who:${a.ability_id}` }),
      () => agent(PRE + `Decompose WHEN for this ability. Input:\n${dec}`,
        { agentType: 'chronomancer', phase: 'Decompose', schema: WHEN_OUT, label: `when:${a.ability_id}` }),
      () => agent(PRE + `Decompose WHAT for this ability. Input:\n${dec}`,
        { agentType: 'vox-hound', phase: 'Decompose', schema: WHAT_OUT, label: `what:${a.ability_id}` }),
    ])

    let candidate = null
    let verdicts = []
    let attempts = 0
    for (let attempt = 0; attempt < 4; attempt++) {          // retry cap: 4 (forced terminal after)
      attempts = attempt + 1
      const assembleInput = {
        ...baseInput,
        target: who, timing: when, effect: what, retrieval: ret,
        previous_dsl: match.has_dsl ? '(committed at ' + (match.committed_dsl_path || 'unknown') + ' — read it)' : null,
        previous_cosine: a.previous_cosine ?? a.cos_start ?? null,
      }
      const revision = verdicts.length
        ? `\n\nA prior attempt was refuted. Address or rebut EACH divergence below — a rebuttal ` +
          `goes in self_grade.concerns with prose evidence; never silently drop a clause to dodge one:\n` +
          JSON.stringify(verdicts.flatMap(v => v.divergences || []))
        : ''
      candidate = await agent(
        PRE + `Assemble the DSL entry. The prose is authoritative over every decomposer block; ` +
        `placeholder lies are banned — if the schema cannot express the mechanic honestly, return resisted_schema. ` +
        `Input:\n${JSON.stringify(assembleInput)}${revision}`,
        { agentType: 'arch-magos', phase: 'Assemble', schema: ARCHMAGOS_OUT, label: `assemble:${a.ability_id}#${attempts}` }
      )
      if (!candidate) return { ability: a, status: 'agent-error', candidate: null, verdicts, decomposition: { who, when, what }, attempts }
      if (candidate.resisted_schema)
        return { ability: a, status: 'needs-schema', candidate, verdicts, decomposition: { who, when, what }, attempts }

      const escalate =
        (typeof candidate.confidence === 'number' && candidate.confidence < 0.7) ||
        !!a.prior_reject || attempt > 0 ||
        (candidate.adopted_shapes || []).some(s => NEW_SHAPES.includes(s))
      const n = escalate ? 3 : 2

      const refuteInput = JSON.stringify({
        ability_id: a.ability_id, raw_text: match.raw_text, dsl: candidate.dsl,
        describer_output: candidate.self_grade?.describer_output || null,
        approx_notes: candidate.approx_notes || [],
      })
      verdicts = (await parallel(Array.from({ length: n }, (_, i) => () =>
        agent(
          PRE + `You are refuter ${i + 1} of ${n}; work independently — do not assume the encoding is right. ` +
          `Derive expected behavior from the PROSE ONLY (never from the DSL's own vocabulary or describer render). ` +
          `refuted:true requires a CONCRETE constructed game state. A clause declared in approx_notes is not a divergence; ` +
          `an undeclared gap is. Input:\n${refuteInput}`,
          { agentType: 'eversor', phase: 'Refute', schema: EVERSOR_OUT, label: `refute:${a.ability_id}#${attempts}v${i + 1}` }
        )
      ))).filter(Boolean)

      // Acceptance needs a real panel: ≥2 surviving verdicts, none refuted (anti-condition 5).
      if (verdicts.length >= 2 && verdicts.every(v => !v.refuted))
        return { ability: a, status: 'accepted', candidate, verdicts, decomposition: { who, when, what }, attempts }
    }
    return { ability: a, status: 'rejected', candidate, verdicts, decomposition: { who, when, what }, attempts }
  }
)

const out = results.filter(Boolean)
const counts = {}
for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1
log(`batch ${args.batch_id}: ${JSON.stringify(counts)}`)
return { batch_id: args.batch_id, results: out }
