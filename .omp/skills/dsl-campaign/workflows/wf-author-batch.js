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
//   repo_root: string,              // required; must equal the workflow's actual cwd + jj root
//   campaign_id: string,
//   batch_id: string,
//   campaign_manifest_sha256: string,
//   candidate_commit_id: string,
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
if (!args.campaign_id || !args.batch_id || !args.campaign_manifest_sha256 || !args.candidate_commit_id)
  throw new Error('campaign_id, batch_id, campaign_manifest_sha256, and candidate_commit_id required')
if (!args.repo_root) throw new Error('args.repo_root required (workspace identity is enforced, not advisory)')
if (args.abilities.length > 8) throw new Error(`batch too large: ${args.abilities.length} > 8 (grain is 5–6)`)
const NEW_SHAPES = args.new_shapes || []
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
    `test "$(jj log -r @ --no-graph -T 'commit_id')" = ${quote(args.candidate_commit_id)}; ` +
    `grep -q '40kdc-data' AGENTS.md; printf '__DSL_WORKSPACE_OK__:%s\\n' "$expected"`, timeout: 20 })
  if (!resultText(check).includes('__DSL_WORKSPACE_OK__'))
    throw new Error(`workspace preflight failed: cwd and jj root must both equal ${args.repo_root}`)
  return { repo_root: args.repo_root, verified: true, role_manifest_verified: ROLE_MANIFEST }
}
const workspace = await assertWorkspace()
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}
const sha256Canonical = value => new Bun.CryptoHasher('sha256').update(canonicalJson(value)).digest('hex')
const PRE = `Verified repo root: ${args.repo_root}. The workflow hard-checked that its cwd and jj root ` +
  `match this path. Run every command there; never read or write another checkout.\n`

// ---- frozen Output contracts, transcribed to JSON Schema (do not redesign) ----
const ENGINSEER_OUT = {
  type: 'object', required: ['matches', 'method', 'evidence_packet'],
  properties: {
    matches: { type: 'array', items: { type: 'object', required: ['ability_id', 'faction', 'raw_text', 'has_dsl'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' },
        raw_text: { type: ['string', 'null'] }, has_dsl: { type: 'boolean' },
        committed_dsl_path: { type: ['string', 'null'] },
        other_faction_copies: { type: 'array', items: { type: 'string' } } } } },
    comparison: { type: ['object', 'null'], additionalProperties: true },
    method: { enum: ['index-lookup', 'grep', 'embeddings'] },
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
function validateEvidencePacket(packet, source, ability_id, faction_id) {
  if (!packet || packet.ability_id !== ability_id || packet.faction_id !== faction_id ||
      !Array.isArray(packet.clauses) || !packet.clauses.length || !packet.source_hash || !packet.packet_hash)
    return 'missing or misidentified source evidence packet'
  const sourceHash = new Bun.CryptoHasher('sha256').update(source).digest('hex')
  if (packet.source_hash !== sourceHash) return 'source evidence hash does not match complete raw text'
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
const LOOKUPS_OUT = {
  type: 'object', required: ['resolutions'],
  properties: { resolutions: { type: 'array', items: { type: 'object',
    required: ['lookup_id', 'status', 'evidence'], properties: {
      lookup_id: { type: 'string' }, status: { enum: ['resolved', 'unresolved'] },
      evidence: { type: 'string' },
    } } } },
}
const ARCHITECT_OUT = {
  type: 'object', required: ['mode', 'architecture'],
  properties: {
    mode: { const: 'architect' },
    architecture: { type: 'object',
      required: ['form', 'source_clause_ids', 'shared_invariants', 'local_actions', 'event_bindings',
        'existing_shape_fit', 'internal_family_size', 'route'],
      properties: {
        form: { enum: ['linear', 'choice', 'menu', 'resource-menu', 'state-machine', 'aura', 'composite', 'other'] },
        source_clause_ids: { type: 'array', items: { type: 'string' } },
        shared_invariants: { type: 'array', items: { type: 'object', additionalProperties: true } },
        local_actions: { type: 'array', items: { type: 'object',
          required: ['child_id', 'clause_ids', 'shared_contract_id', 'parent_id', 'parent_closed'],
          properties: { child_id: { type: 'string' }, clause_ids: { type: 'array', items: { type: 'string' } },
            shared_contract_id: { type: 'string' }, parent_id: { type: 'string' }, parent_closed: { type: 'boolean' } } } },
        resource_lifecycle: { type: ['object', 'null'], additionalProperties: true },
        event_bindings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        existing_shape_fit: { type: 'object', required: ['verdict', 'shapes_checked', 'unmapped_clause_ids'],
          properties: { verdict: { enum: ['exact', 'partial', 'none'] },
            shapes_checked: { type: 'array', items: { type: 'string' } },
            unmapped_clause_ids: { type: 'array', items: { type: 'string' } } } },
        internal_family_size: { type: 'integer', minimum: 0 },
        route: { enum: ['existing-shape', 'shape-scout'] },
        resisted_schema: { type: ['object', 'null'], additionalProperties: true },
      } },
  },
}
const WHO_OUT = {
  type: 'object', required: ['status', 'ability_id', 'bearer', 'beneficiary', 'scope_target', 'unresolved_clauses', 'confidence'],
  properties: {
    status: { enum: ['resolved', 'ambiguous', 'needs-schema', 'source-missing', 'error'] },
    ability_id: { type: 'string' }, bearer: { type: ['string', 'null'] }, beneficiary: { type: ['string', 'null'] },
    applies_to: { type: ['object', 'null'], additionalProperties: true }, scope_target: { type: ['string', 'null'] },
    effect_target_params: { type: ['object', 'null'], additionalProperties: true },
    keyword_gates: { type: 'array', items: { type: 'string' } },
    excludes: { type: 'array', items: { type: 'string' } },
    lookups_needed: { type: 'array', items: { type: 'object', required: ['lookup_id', 'question'],
      properties: { lookup_id: { type: 'string' }, question: { type: 'string' } } } },
    unresolved_clauses: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' },
  },
}
const WHEN_OUT = {
  type: 'object', required: ['status', 'ability_id', 'behavior', 'duration', 'unresolved_clauses', 'confidence'],
  properties: {
    status: { enum: ['resolved', 'ambiguous', 'needs-schema', 'source-missing', 'error'] },
    ability_id: { type: 'string' },
    behavior: { enum: ['passive', 'activated', 'reactive', 'aura', null] },
    trigger: { type: ['object', 'null'], additionalProperties: true },
    phase_conditions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    canonical_condition_ids: { type: 'array', items: { type: 'string' } },
    duration: { type: ['string', 'null'] }, usage: { type: ['object', 'null'], additionalProperties: true },
    lookups_needed: { type: 'array', items: { type: 'object', required: ['lookup_id', 'question'],
      properties: { lookup_id: { type: 'string' }, question: { type: 'string' } } } },
    unresolved_clauses: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' },
  },
}
const WHAT_OUT = {
  type: 'object', required: ['status', 'ability_id', 'leaf_types_used', 'composition', 'buff_or_debuff', 'unresolved_clauses', 'confidence'],
  properties: {
    status: { enum: ['resolved', 'ambiguous', 'needs-schema', 'source-missing', 'error'] },
    ability_id: { type: 'string' }, effect_tree: { type: ['object', 'null'], additionalProperties: true },
    leaf_types_used: { type: 'array', items: { type: 'string' } },
    composition: { enum: ['choice', 'sequence', 'conditional', 'dice-gated', 'aura', 'none', null] },
    dice_mechanics: { type: 'array', items: { type: 'object', additionalProperties: true } }, buff_or_debuff: { enum: ['buff', 'debuff', 'both', 'neutral', null] },
    unmodelable_clauses: { type: 'array', items: { type: 'string' } },
    lookups_needed: { type: 'array', items: { type: 'object', required: ['lookup_id', 'question'],
      properties: { lookup_id: { type: 'string' }, question: { type: 'string' } } } },
    unresolved_clauses: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' },
  },
}
const ARCHMAGOS_OUT = {
  type: 'object',
  required: ['ability_id', 'dsl', 'approx_notes', 'dropped_clauses', 'clause_coverage', 'adopted_shapes', 'self_grade', 'confidence'],
  properties: {
    ability_id: { type: 'string' }, dsl: { type: ['object', 'null'], additionalProperties: true },
    approx_notes: { type: 'array', maxItems: 0, items: { type: 'string' } },
    dropped_clauses: { type: 'array', items: { type: 'string' } },
    clause_coverage: { type: 'array', items: { type: 'object',
      required: ['clause_id', 'disposition', 'dsl_path', 'evidence', 'notes'],
      properties: { clause_id: { type: 'string' },
        disposition: { enum: ['exact', 'declared-nonmechanical', 'unresolved'] },
        dsl_path: { type: ['string', 'null'] },
        evidence: { enum: ['source-explicit', 'schema-derived', 'inference'] }, notes: { type: 'string' } } } },
    adopted_shapes: { type: 'array', items: { type: 'string' } },
    resisted_schema: { type: ['object', 'null'], additionalProperties: true },
    self_grade: { type: 'object', required: ['describer_output', 'verdict'],
      properties: { describer_output: { type: 'string' },
        verdict: { enum: ['faithful', 'approx', 'needs-schema'] }, concerns: { type: 'array', items: { type: 'string' } } } },
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

  async a => ({
    ability: a,
    retrieval: await runAgent(
      PRE + `Look up this ability's raw prose and committed DSL. Input:\n` +
      JSON.stringify({ query: { ability_id: a.ability_id, faction_id: a.faction_id } }),
      { agent: 'data-enginseer', schema: ENGINSEER_OUT, label: `retrieve:${a.ability_id}` }
    ),
  }),

  async ({ ability: a, retrieval: ret }) => {
    if (!ret) return { ability: a, status: 'agent-error', candidate: null, verdicts: [], attempts: 0 }
    const exactMatches = (ret.matches || []).filter(m =>
      m.ability_id === a.ability_id && m.faction === a.faction_id)
    const match = exactMatches.length === 1 ? exactMatches[0] : null
    if (!match || !match.raw_text)
      return { ability: a, status: 'no-prose', candidate: null, verdicts: [], attempts: 0 }
    const packet = ret.evidence_packet
    const packetError = validateEvidencePacket(packet, match.raw_text, a.ability_id, a.faction_id)
    if (packetError)
      return { ability: a, status: 'agent-error', reason: packetError, candidate: null, verdicts: [], attempts: 0 }
    const clauseIds = packet.clauses.map(c => c.clause_id)

    const baseInput = {
      ability_id: a.ability_id, name: a.name || a.ability_id, raw_text: match.raw_text,
      ability_type: a.ability_type || null, faction_id: a.faction_id,
      detachment_id: a.detachment_id || null,
      evidence_packet: packet,
    }
    const architecture = await runAgent(
      PRE + `Architect this mechanic BEFORE leaf decomposition. Reconstruct its global control structure; ` +
      `separate shared invariants from action-local triggers/targets/effects/durations and event bindings. ` +
      `An existing-shape route is legal only for exact coverage of every clause. A partial fit, note-only ` +
      `mechanic, unsupported composite control structure, or unresolved binding routes to shape-scout. Input:\n` +
      JSON.stringify({ mode: 'architect', artifacts: { source: baseInput } }),
      { agent: 'inquisitor', schema: ARCHITECT_OUT, label: `architect:${a.ability_id}` }
    )
    if (!architecture) return { ability: a, status: 'agent-error', reason: 'architecture agent returned nothing', candidate: null, verdicts: [], attempts: 0 }
    const arch = architecture.architecture
    const architectureCovered = new Set(arch.source_clause_ids || [])
    const missingArchitectureClauses = clauseIds.filter(id => !architectureCovered.has(id))
    const exactExistingFit = arch.route === 'existing-shape' && arch.existing_shape_fit.verdict === 'exact' &&
      arch.existing_shape_fit.unmapped_clause_ids.length === 0 && missingArchitectureClauses.length === 0
    if (!exactExistingFit) return {
      ability: a, status: 'needs-schema', reason: 'architecture gate rejected a partial or composite fit',
      candidate: null, architecture, evidence_packet: packet, verdicts: [], thread: [], attempts: 0,
      resisted_schema: arch.resisted_schema || { mechanic: `composite mechanic for ${a.ability_id}`,
        resists_schema: `unmapped clauses: ${[...missingArchitectureClauses, ...arch.existing_shape_fit.unmapped_clause_ids].join(', ') || 'container semantics'}`,
        proposal: `shape-scout the ${arch.form} control structure`, also_unblocks: '' },
    }
    const dec = JSON.stringify(baseInput)
    const [who, when, what] = await parallel([
      () => runAgent(PRE + `Decompose WHO for this ability. Input:\n${dec}`,
        { agent: 'target-dummy', schema: WHO_OUT, label: `who:${a.ability_id}` }),
      () => runAgent(PRE + `Decompose WHEN for this ability. Input:\n${dec}`,
        { agent: 'chronomancer', schema: WHEN_OUT, label: `when:${a.ability_id}` }),
      () => runAgent(PRE + `Decompose WHAT for this ability. Input:\n${dec}`,
        { agent: 'vox-hound', schema: WHAT_OUT, label: `what:${a.ability_id}` }),
    ])
    const unresolvedDecomposers = [who, when, what].filter(d => !d ||
      d.ability_id !== a.ability_id || d.status !== 'resolved' || d.unresolved_clauses.length)
    if (what && what.unmodelable_clauses && what.unmodelable_clauses.length) unresolvedDecomposers.push(what)
    if (unresolvedDecomposers.length) return {
      ability: a, status: unresolvedDecomposers.some(d => d && d.status === 'source-missing') ? 'no-prose' : 'needs-schema',
      reason: 'one or more decomposers reported ambiguity or an expressibility gap',
      candidate: null, architecture, evidence_packet: packet, verdicts: [], thread: [],
      decomposition: { who, when, what }, attempts: 0,
    }

    // Route the decomposers' deferred cross-references back to data-enginseer. Previously
    // who/when/what.lookups_needed were dropped on the floor (enginseer fired once, at
    // retrieve); a non-empty deferral now triggers a second scoped enginseer pass whose
    // result feeds the assembler as `lookups`.
    const deferred = [who, when, what].flatMap(d => (d && d.lookups_needed) || [])
    const lookups = deferred.length
      ? await runAgent(
          PRE + `Resolve these cross-references the decomposers deferred (other abilities, ` +
          `keyword meanings, sibling encodings). Input:\n` +
          JSON.stringify({ deferred, context_ability_id: a.ability_id, faction_id: a.faction_id }),
          { agent: 'data-enginseer', schema: LOOKUPS_OUT, label: `lookups:${a.ability_id}` }
        )
      : null
    if (deferred.length) {
      const requested = new Set(deferred.map(d => d.lookup_id))
      const resolved = new Map((lookups?.resolutions || []).map(r => [r.lookup_id, r]))
      if (requested.size !== deferred.length || (lookups?.resolutions || []).length !== requested.size ||
          resolved.size !== requested.size || [...requested].some(id => !resolved.has(id) ||
            resolved.get(id).status !== 'resolved' || !resolved.get(id).evidence.trim())) return {
        ability: a, status: 'needs-schema', reason: 'deferred cross-reference remained unresolved',
        candidate: null, architecture, evidence_packet: packet, verdicts: [], thread: [],
        decomposition: { who, when, what }, attempts: 0,
      }
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
        architecture, target: who, timing: when, effect: what, retrieval: ret, lookups,
        previous_dsl: match.has_dsl ? '(committed at ' + (match.committed_dsl_path || 'unknown') + ' — read it)' : null,
        previous_cosine: a.previous_cosine ?? a.cos_start ?? null,
      }
      const revision = thread.length
        ? `\n\n${thread.length} prior attempt(s) were refuted. Address or rebut EACH divergence across ` +
          `ALL rounds below — a rebuttal goes in self_grade.concerns with prose evidence; never silently ` +
          `drop a clause to dodge one, and never reintroduce a divergence an earlier round already resolved:\n` +
          JSON.stringify(thread.map(t => ({ round: t.attempt, refuted: t.refuted, divergences: t.divergences })))
        : ''
      candidate = await runAgent(
        PRE + `Assemble the DSL entry. The prose is authoritative over every decomposer block; ` +
        `placeholder lies are banned — if the schema cannot express the mechanic honestly, return resisted_schema. ` +
        `Input:\n${JSON.stringify(assembleInput)}${revision}`,
        { agent: 'arch-magos', schema: ARCHMAGOS_OUT, label: `assemble:${a.ability_id}#${attempts}` }
      )
      if (!candidate) return { ability: a, status: 'agent-error', candidate: null, verdicts, thread, decomposition: { who, when, what }, attempts }
      if (candidate.ability_id !== a.ability_id)
        return { ability: a, status: 'agent-error', reason: 'assembler returned another ability id', candidate, verdicts, thread, decomposition: { who, when, what }, attempts }
      if (candidate.resisted_schema)
        return { ability: a, status: 'needs-schema', candidate, verdicts, thread, decomposition: { who, when, what }, attempts }
      if (candidate.approx_notes.length)
        return { ability: a, status: 'needs-schema', reason: 'approx_notes are forbidden for accepted candidates', candidate, verdicts, thread, decomposition: { who, when, what }, attempts }
      const coverage = candidate.clause_coverage || []
      const byClause = new Map(coverage.map(c => [c.clause_id, c]))
      const expectedClauses = new Set(packet.clauses.map(c => c.clause_id))
      if (byClause.size !== coverage.length || byClause.size !== expectedClauses.size ||
          coverage.some(c => !expectedClauses.has(c.clause_id))) return {
        ability: a, status: 'needs-schema', reason: 'clause coverage has duplicate, missing, or extra rows',
        candidate, architecture, evidence_packet: packet, verdicts, thread,
        decomposition: { who, when, what }, attempts,
      }
      const incomplete = packet.clauses.filter(c => {
        const row = byClause.get(c.clause_id)
        if (!row) return true
        if (!c.mechanical) return row.disposition === 'unresolved'
        return row.disposition !== 'exact' || row.evidence === 'inference' || !row.dsl_path
      })
      if (!candidate.dsl || typeof candidate.dsl !== 'object' || candidate.self_grade.verdict !== 'faithful' ||
          candidate.dropped_clauses.length || incomplete.length) return {
        ability: a, status: 'needs-schema', reason: `clause coverage failed: ${incomplete.map(c => c.clause_id).join(', ')}`,
        candidate, architecture, evidence_packet: packet, verdicts, thread,
        decomposition: { who, when, what }, attempts,
      }

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
        runAgent(
          PRE + `You are refuter ${i + 1} of ${n}; work independently — do not assume the encoding is right. ` +
          `Derive expected behavior from the PROSE ONLY (never from the DSL's own vocabulary or describer render). ` +
          `refuted:true requires a CONCRETE constructed game state. approx_notes are forbidden; treat any ` +
          `mechanic not represented exactly by the DSL as a divergence. Input:\n${refuteInput}`,
          { agent: 'eversor', schema: EVERSOR_OUT, label: `refute:${a.ability_id}#${attempts}v${i + 1}` }
        )
      ))).filter(Boolean)

      // Record this round in the thread BEFORE deciding — the whole history survives to loop-state.
      thread.push({
        attempt: attempts,
        dsl: candidate.dsl,
        describer_output: candidate.self_grade?.describer_output || null,
        refuted: verdicts.some(v => v.refuted),
        divergences: verdicts.flatMap(v => v.divergences || []),
      })

      // Acceptance needs the exact requested panel, bound to this ability, with no divergence.
      if (verdicts.length === n && verdicts.every(v => v.ability_id === a.ability_id &&
        v.refuted === false && Array.isArray(v.divergences) && v.divergences.length === 0))
        return { ability: a, status: 'accepted', candidate, verdicts, thread, decomposition: { who, when, what }, attempts }
    }
    return { ability: a, status: 'rejected', candidate, verdicts, thread, decomposition: { who, when, what }, attempts }
  }
)

const out = results.filter(Boolean)
const counts = {}
for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1
log(`batch ${args.batch_id}: ${JSON.stringify(counts)}`)
const payload = {
  batch_id: args.batch_id,
  workspace,
  provenance: { workflow: 'dsl-author-batch', required_roles: ['data-enginseer', 'inquisitor', 'target-dummy', 'chronomancer', 'vox-hound', 'arch-magos', 'eversor'] },
  results: out,
}
const ability_keys = args.abilities.map(a => `${a.faction_id}/${a.ability_id}`).sort()
const payload_sha256 = new Bun.CryptoHasher('sha256').update(JSON.stringify(payload)).digest('hex')
const candidate_dsl_hashes = {}
for (const row of out.filter(x => x.status === 'accepted'))
  candidate_dsl_hashes[`${row.ability.faction_id}/${row.ability.ability_id}`] = sha256Canonical(row.candidate.dsl)
return { binding: { kind: 'author', campaign_id: args.campaign_id, batch_id: args.batch_id,
  campaign_manifest_sha256: args.campaign_manifest_sha256, ability_keys,
  author_candidate_commit_id: args.candidate_commit_id, candidate_dsl_hashes, payload_sha256 }, payload }
