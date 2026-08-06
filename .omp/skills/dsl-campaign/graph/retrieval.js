import { canonicalJson, sha256 } from './canonical.js'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { GLOBAL_ROOT_ID, abilityProjectionId, abilityProjectionLabel, missingAbilityLabel, projectionScope } from './projection.js'

export const SIGNATURE_FIELDS = [
  'actor', 'affected_entity', 'event', 'producer_ports', 'consumer_ports', 'polarity', 'quantifier',
  'timing', 'duration', 'scope', 'ordering', 'restrictions', 'exclusions',
]
export const RETRIEVAL_ORDER = ['exact-family-instance', 'admissible-family-substitution', 'certified-connected-subfamily', 'primitive-discovery', 'embedding-llm-discovery']
const COVERING = new Set(RETRIEVAL_ORDER.slice(0, 3))

function normalizeValue(value) {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return [...value].map(normalizeValue).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeValue(value[key])]))
  if (typeof value === 'string') return value.trim().toLowerCase()
  return value
}

export function normalizeMechanicSignature(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('mechanic signature must be an object')
  const signature = Object.fromEntries(SIGNATURE_FIELDS.map(field => [field, normalizeValue(input[field])]))
  return { signature, signature_hash: sha256(canonicalJson(signature)) }
}

function compatible(target, candidate, substitutions) {
  const bindings = []
  for (const field of SIGNATURE_FIELDS) {
    if (canonicalJson(target[field]) === canonicalJson(candidate[field])) continue
    const allowed = substitutions?.[field]
    if (!allowed || !allowed.some(pair => canonicalJson(pair.from) === canonicalJson(candidate[field]) && canonicalJson(pair.to) === canonicalJson(target[field]))) {
      return { compatible: false, bindings, conflict: field }
    }
    bindings.push({ field, from: candidate[field], to: target[field] })
  }
  return { compatible: true, bindings, conflict: null }
}

export function retrieveEvidence({ target_signature, target_claim_ids, candidates }) {
  const target = normalizeMechanicSignature(target_signature).signature
  const matches = []
  for (const candidate of candidates) {
    if (candidate.status !== 'certified' || !candidate.current) {
      matches.push({ evidence_node_id: candidate.node_id, match_type: candidate.discovery_kind || 'embedding-llm-discovery', covers_claim_ids: [], bindings: [], rejected_reason: 'evidence is not a current certificate' })
      continue
    }
    const normalized = normalizeMechanicSignature(candidate.signature).signature
    const check = compatible(target, normalized, candidate.admissible_substitutions)
    let match_type
    if (check.compatible && check.bindings.length === 0) match_type = 'exact-family-instance'
    else if (check.compatible) match_type = 'admissible-family-substitution'
    else if (Array.isArray(candidate.covered_claim_ids) && candidate.covered_claim_ids.length) match_type = 'certified-connected-subfamily'
    else match_type = candidate.discovery_kind || 'primitive-discovery'
    const covers = COVERING.has(match_type) ? (candidate.covered_claim_ids || target_claim_ids) : []
    matches.push({ evidence_node_id: candidate.node_id, match_type, covers_claim_ids: covers, bindings: check.bindings, rejected_reason: COVERING.has(match_type) ? null : `incompatible ${check.conflict || 'discovery-only'} binding` })
  }
  return matches.sort((a, b) => RETRIEVAL_ORDER.indexOf(a.match_type) - RETRIEVAL_ORDER.indexOf(b.match_type) || a.evidence_node_id.localeCompare(b.evidence_node_id))
}

function candidatePlans(claimIds, matches) {
  const covering = matches.filter(match => COVERING.has(match.match_type) && !match.rejected_reason)
  const plans = []
  const count = 1 << Math.min(covering.length, 20)
  for (let mask = 0; mask < count; mask += 1) {
    const selected = covering.filter((_, index) => mask & (1 << index))
    const covered = new Set(selected.flatMap(match => match.covers_claim_ids))
    const unmatched = claimIds.filter(id => !covered.has(id))
    const exact = selected.filter(match => match.match_type === 'exact-family-instance').length
    plans.push({ selected, covered: [...covered], unmatched, exact, seams: Math.max(0, selected.length - 1) })
  }
  return plans
}

export function chooseConstructionPlan({ faction_id, ability_id, source_claims, matches, required_checks = [] }) {
  const claimIds = source_claims.map(claim => claim.id)
  const plans = candidatePlans(claimIds, matches)
  plans.sort((a, b) => b.exact - a.exact || a.unmatched.length - b.unmatched.length || a.seams - b.seams || a.selected.length - b.selected.length)
  const best = plans[0]
  return {
    faction_id, ability_id, source_claims,
    selected_parents: best.selected.map(match => match.evidence_node_id),
    covered_claims: best.covered,
    unmatched_claims: best.unmatched,
    rejected_conflicts: matches.filter(match => match.rejected_reason),
    new_specializations: best.selected.filter(match => match.bindings.length).map(match => ({ evidence_node_id: match.evidence_node_id, bindings: match.bindings })),
    composition_seams: best.seams ? best.selected.slice(1).map((match, index) => ({ left: best.selected[index].evidence_node_id, right: match.evidence_node_id })) : [],
    required_checks,
  }
}

export function persistRetrieval(store, { run_id, faction_id, ability_id, formalization_node_id, target_signature, source_claims, candidates, required_checks = [] }) {
  const matches = retrieveEvidence({ target_signature, target_claim_ids: source_claims.map(claim => claim.id), candidates })
  const matchNodes = matches.map(match => store.createNode({ kind: 'retrieval-match', payload: { faction_id, ability_id, ...match }, input_node_ids: [formalization_node_id, ...(match.evidence_node_id && store.hasNode(match.evidence_node_id) ? [match.evidence_node_id] : [])], edge_type: match.rejected_reason ? 'similar_mechanic' : 'satisfies', authorizes_reuse: !match.rejected_reason && COVERING.has(match.match_type) }))
  const plan = chooseConstructionPlan({ faction_id, ability_id, source_claims, matches, required_checks })
  const planNode = store.createNode({ kind: 'construction-plan', payload: plan, input_node_ids: [formalization_node_id, ...matchNodes.map(node => node.node_id)], edge_type: 'derived_from', authorizes_reuse: false })
  store.db.prepare('INSERT OR REPLACE INTO construction_plans(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(`${faction_id}/${ability_id}`, run_id, plan.unmatched_claims.length ? 'incomplete' : 'ready', planNode.node_id, canonicalJson(plan))
  return { matches, match_node_ids: matchNodes.map(node => node.node_id), plan, plan_node_id: planNode.node_id }
}

const GRAPH_PROJECTION_TABLES = [
  'source_snapshots', 'clause_maps', 'mechanic_signatures', 'tasks', 'attempts', 'leases',
  'checkpoints', 'decisions', 'findings', 'checks', 'certificates', 'ability_evidence',
  'family_templates', 'family_instances', 'construction_plans', 'apply_transactions',
  'legacy_observations',
]

function refKey(factionId, abilityId) {
  return `${factionId}\0${abilityId}`
}

export class GraphQueryError extends Error {
  constructor(status, code, details = {}) {
    super(code)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function graphRevision(store) {
  return sha256(canonicalJson({ sequence: store.sequence(), projection: store.projectionChecksum() }))
}

function cursorEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function cursorDecode(value, revision, fingerprint) {
  if (!value) return null
  let parsed
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new GraphQueryError(400, 'invalid-cursor') }
  if (parsed.graph_revision !== revision) throw new GraphQueryError(409, 'stale-cursor', { graph_revision: revision })
  if (parsed.fingerprint !== fingerprint || !Array.isArray(parsed.tuple)) throw new GraphQueryError(400, 'cursor-filter-mismatch')
  return parsed.tuple
}

function boundedInteger(value, fallback, maximum, minimum = 1) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new GraphQueryError(400, 'invalid-bound')
  return Math.min(parsed, maximum)
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a).localeCompare(String(b))
  }
  return 0
}

function parsedWorkflowEnvelope(row) {
  if (row.kind !== 'workflow-output') return null
  const payload = JSON.parse(row.payload_json || '{}')
  const envelope = payload.envelope
  if (!envelope || typeof envelope !== 'object') return null
  const outputKind = typeof payload.output_kind === 'string' ? payload.output_kind : null
  const runId = typeof envelope.run_id === 'string' ? envelope.run_id : null
  const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : null
  const attemptId = typeof envelope.attempt_id === 'string' ? envelope.attempt_id : null
  if (!outputKind || !runId || !taskId || !attemptId || envelope.producer_contract_version !== Number(row.producer_contract_version)) return null
  const provenance = {
    run_id: runId,
    task_id: taskId,
    attempt_id: attemptId,
    output_kind: outputKind,
  }
  const taskParts = taskId.split(':')
  const attemptParts = attemptId.split(':')
  const taskMarker = taskParts.lastIndexOf('task')
  const attemptMarker = attemptParts.lastIndexOf('attempt')
  if (
    taskMarker >= 6 &&
    attemptMarker >= 6 &&
    /^\d+$/.test(taskParts[taskMarker + 1] || '') &&
    /^\d+$/.test(attemptParts[attemptMarker + 1] || '') &&
    taskParts.slice(0, taskMarker).join(':') === attemptParts.slice(0, attemptMarker).join(':') &&
    outputKind === taskParts[taskMarker - 1]
  ) {
    provenance.workflow_stage = taskParts[2]
    provenance.workflow_task = taskParts[3]
    provenance.workflow_round = taskParts[4]
    provenance.workflow_lane = taskParts[5]
    provenance.attempt_number = Number(attemptParts[attemptMarker + 1])
  } else {
    const attemptNumber = attemptId.match(/(?:^|-)attempt-(\d+)$/)?.[1]
    if (attemptNumber) provenance.attempt_number = Number(attemptNumber)
  }
  return provenance
}

function trustedWorkflowEnvelopes(store) {
  const tasks = new Map(store.db.prepare('SELECT id,run_id,node_id FROM tasks').all().map(row => [row.id, row]))
  const attempts = new Map(store.db.prepare('SELECT id,run_id,node_id FROM attempts').all().map(row => [row.id, row]))
  const envelopes = new Map()
  for (const row of store.db.prepare("SELECT node_id,kind,producer_contract_version,payload_json FROM nodes WHERE kind='workflow-output'").all()) {
    const envelope = parsedWorkflowEnvelope(row)
    const task = envelope ? tasks.get(envelope.task_id) : null
    const attempt = envelope ? attempts.get(envelope.attempt_id) : null
    if (!envelope || task?.run_id !== envelope.run_id || task.node_id !== row.node_id || attempt?.run_id !== envelope.run_id || attempt.node_id !== row.node_id) continue
    envelopes.set(row.node_id, envelope)
  }
  return envelopes
}

function campaignRefsByNode(store, workflowEnvelopes = trustedWorkflowEnvelopes(store)) {
  const refs = new Map()
  const runs = new Map(store.db.prepare('SELECT run_id,campaign_id FROM runs').all().map(row => [row.run_id, row.campaign_id]))
  const add = (nodeId, campaignId) => {
    if (!nodeId || !campaignId) return
    if (!refs.has(nodeId)) refs.set(nodeId, new Set())
    refs.get(nodeId).add(campaignId)
  }
  for (const table of GRAPH_PROJECTION_TABLES) {
    for (const row of store.db.prepare(`SELECT node_id,run_id FROM ${table} WHERE node_id IS NOT NULL AND run_id IS NOT NULL`).all()) add(row.node_id, runs.get(row.run_id))
  }
  for (const row of store.db.prepare('SELECT node_id,aggregate_id FROM events WHERE node_id IS NOT NULL').all()) add(row.node_id, runs.get(row.aggregate_id) || store.db.prepare('SELECT campaign_id FROM runs WHERE campaign_id=?').get(row.aggregate_id)?.campaign_id)
  for (const [nodeId, envelope] of workflowEnvelopes) add(nodeId, runs.get(envelope.run_id))
  return new Map([...refs].map(([nodeId, values]) => [nodeId, [...values].sort()]))
}

function abilityRefsByNode(store) {
  const refs = new Map()
  for (const row of store.db.prepare(`
    SELECT refs.node_id,refs.faction_id,refs.ability_id,refs.source_kind,refs.distance,
           catalog.ability_name,catalog.faction_name
    FROM node_ability_refs AS refs
    LEFT JOIN ability_catalog AS catalog
      ON catalog.faction_id=refs.faction_id AND catalog.ability_id=refs.ability_id
    ORDER BY refs.node_id,refs.faction_id,refs.ability_id
  `).all()) {
    if (!refs.has(row.node_id)) refs.set(row.node_id, [])
    refs.get(row.node_id).push({
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      label: row.ability_name ? abilityProjectionLabel(row) : missingAbilityLabel(row.faction_id, row.ability_id),
      metadata_status: row.ability_name ? 'current' : 'missing',
      source_kind: row.source_kind,
      distance: Number(row.distance),
    })
  }
  return refs
}

function projectionMetadataByNode(store) {
  const metadata = new Map()
  for (const table of GRAPH_PROJECTION_TABLES) {
    for (const row of store.db.prepare(`SELECT id,run_id,state,node_id FROM ${table} WHERE node_id IS NOT NULL ORDER BY id`).all()) {
      if (!metadata.has(row.node_id)) metadata.set(row.node_id, { run_ids: new Set(), statuses: new Set(), certificates: [], findings: [] })
      const value = metadata.get(row.node_id)
      if (row.run_id) value.run_ids.add(row.run_id)
      if (row.state) value.statuses.add(row.state)
      if (table === 'certificates') value.certificates.push(row.id)
      if (table === 'findings') value.findings.push(row.id)
    }
  }
  return new Map([...metadata].map(([nodeId, value]) => [nodeId, {
    run_ids: [...value.run_ids].sort(),
    statuses: [...value.statuses].sort(),
    certificates: value.certificates.sort(),
    findings: value.findings.sort(),
  }]))
}

function rootNode(revision) {
  return {
    id: GLOBAL_ROOT_ID,
    kind: 'mechanic-evidence-root',
    label: 'Mechanic Evidence',
    scope: 'global',
    ability_refs: [],
    campaign_refs: [],
    metadata: { graph_revision: revision },
  }
}

function abilityRowLabel(row) {
  return row.metadata_status === 'missing'
    ? missingAbilityLabel(row.faction_id, row.ability_id)
    : abilityProjectionLabel(row)
}

function projectionAbilityRows(store) {
  const rows = new Map()
  for (const row of store.db.prepare('SELECT * FROM ability_catalog').all()) {
    rows.set(refKey(row.faction_id, row.ability_id), { ...row, metadata_status: 'current' })
  }
  for (const row of store.db.prepare('SELECT DISTINCT faction_id,ability_id FROM node_ability_refs ORDER BY faction_id,ability_id').all()) {
    const key = refKey(row.faction_id, row.ability_id)
    if (!rows.has(key)) rows.set(key, {
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      ability_name: null,
      faction_name: null,
      repository_version_id: null,
      metadata_status: 'missing',
    })
  }
  return [...rows.values()]
}

function abilityNode(row, statusMetadata = {}) {
  const label = abilityRowLabel(row)
  return {
    id: abilityProjectionId(row.faction_id, row.ability_id),
    kind: 'ability',
    label,
    scope: 'ability',
    ability_refs: [{
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      label,
      metadata_status: row.metadata_status,
      source_kind: row.metadata_status === 'missing' ? 'projection-ref' : 'catalog',
      distance: 0,
    }],
    campaign_refs: statusMetadata.campaign_refs || [],
    metadata: {
      metadata_status: row.metadata_status,
      faction_id: row.faction_id,
      ability_id: row.ability_id,
      statuses: statusMetadata.statuses || [],
      evidence_count: statusMetadata.evidence_count || 0,
    },
  }
}

function browserWorkflowProvenance(envelope) {
  if (!envelope) return {}
  return {
    output_kind: envelope.output_kind,
    task_id: envelope.task_id,
    attempt_id: envelope.attempt_id,
    workflow_stage: envelope.workflow_stage,
    workflow_task: envelope.workflow_task,
    workflow_round: envelope.workflow_round,
    workflow_lane: envelope.workflow_lane,
    attempt_number: envelope.attempt_number,
  }
}

function evidenceLabel(row, provenance) {
  const role = provenance.output_kind || row.kind
  return `${role.replaceAll('-', ' ')}${provenance.output_kind ? ' output' : ''}`
}


function evidenceNode(row, abilityRefs, campaignRefs, metadata, workflowEnvelopes) {
  const refs = abilityRefs.get(row.node_id) || []
  const provenance = browserWorkflowProvenance(workflowEnvelopes.get(row.node_id))
  return {
    id: row.node_id,
    kind: row.kind,
    label: evidenceLabel(row, provenance),
    scope: projectionScope(refs),
    ability_refs: refs,
    campaign_refs: campaignRefs.get(row.node_id) || [],
    metadata: {
      ...(metadata.get(row.node_id) || { run_ids: [], statuses: [], certificates: [], findings: [] }),
      ...provenance,
      lineage_distance: Number(row.lineage_distance),
      producer_contract_version: Number(row.producer_contract_version),
    },
  }
}

function edge(id, source, target, kind, metadata = {}) {
  return { id, source, target, kind, metadata }
}

function selectedEdges(store, nodeIds, abilityRows, evidenceNodeIds = new Set(nodeIds), availableNodeIds = new Set(nodeIds)) {
  const selected = new Set(nodeIds)
  const edges = []
  const incoming = new Set()
  for (const row of store.db.prepare('SELECT parent_node_id,child_node_id,edge_type,authorizes_reuse FROM edges ORDER BY parent_node_id,child_node_id,edge_type').all()) {
    if (!evidenceNodeIds.has(row.parent_node_id) || !evidenceNodeIds.has(row.child_node_id)) continue
    incoming.add(row.child_node_id)
    if (!selected.has(row.parent_node_id) && !selected.has(row.child_node_id)) continue
    if (!availableNodeIds.has(row.parent_node_id) || !availableNodeIds.has(row.child_node_id)) continue
    edges.push(edge(sha256(`${row.parent_node_id}:${row.child_node_id}:${row.edge_type}`), row.parent_node_id, row.child_node_id, row.edge_type, { authorizes_reuse: Boolean(row.authorizes_reuse) }))
  }
  for (const row of abilityRows) {
    const abilityId = abilityProjectionId(row.faction_id, row.ability_id)
    edges.push(edge(`edge:${GLOBAL_ROOT_ID}:${abilityId}`, GLOBAL_ROOT_ID, abilityId, 'contains'))
    for (const nodeId of selected) {
      if (incoming.has(nodeId)) continue
      const belongs = store.db.prepare('SELECT 1 FROM node_ability_refs WHERE node_id=? AND faction_id=? AND ability_id=?').get(nodeId, row.faction_id, row.ability_id)
      if (belongs) edges.push(edge(`edge:${abilityId}:${nodeId}`, abilityId, nodeId, 'evidence'))
    }
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id))
}

function abilityStatusMetadata(store, factionId, abilityId, campaignRefs, metadata) {
  const nodeIds = store.db.prepare('SELECT node_id FROM node_ability_refs WHERE faction_id=? AND ability_id=? ORDER BY node_id').all(factionId, abilityId).map(row => row.node_id)
  const statuses = new Set()
  const campaigns = new Set()
  for (const nodeId of nodeIds) {
    for (const status of metadata.get(nodeId)?.statuses || []) statuses.add(status)
    for (const campaign of campaignRefs.get(nodeId) || []) campaigns.add(campaign)
  }
  return { statuses: [...statuses].sort(), campaign_refs: [...campaigns].sort(), evidence_count: nodeIds.length }
}

function validateFilters(mode, filters) {
  if (!['index', 'ability', 'campaign'].includes(mode)) throw new GraphQueryError(400, 'invalid-mode')
  if (mode === 'index' && (filters.faction_id || filters.ability_id || filters.campaign_id)) throw new GraphQueryError(400, 'invalid-index-filters')
  if (mode === 'ability' && (!filters.faction_id || !filters.ability_id || filters.campaign_id)) throw new GraphQueryError(400, 'ability-filter-required')
  if (mode === 'campaign' && (!filters.campaign_id || filters.faction_id || filters.ability_id)) throw new GraphQueryError(400, 'campaign-filter-required')
}

export function graphSubscriptionRevision(store, query = {}) {
  const mode = query.mode || 'index'
  const filters = {
    mode,
    faction_id: query.faction_id || null,
    ability_id: query.ability_id || null,
    campaign_id: query.campaign_id || null,
  }
  validateFilters(mode, filters)
  boundedInteger(query.limit, mode === 'index' ? 2 : 3, mode === 'index' ? 250 : 400, mode === 'index' ? 1 : 3)
  if (mode !== 'index') boundedInteger(query.depth, 4, 8, 0)
  if (
    mode === 'ability' &&
    !projectionAbilityRows(store).some(row => row.faction_id === filters.faction_id && row.ability_id === filters.ability_id)
  ) throw new GraphQueryError(404, 'ability-not-found')
  if (mode === 'campaign' && !store.db.prepare('SELECT 1 FROM runs WHERE campaign_id=?').get(filters.campaign_id)) {
    throw new GraphQueryError(404, 'campaign-not-found')
  }
  return graphRevision(store)
}

export function globalGraphSnapshot(store, query = {}) {
  const mode = query.mode || 'index'
  const filters = {
    mode,
    faction_id: query.faction_id || null,
    ability_id: query.ability_id || null,
    campaign_id: query.campaign_id || null,
  }
  validateFilters(mode, filters)
  const revision = graphRevision(store)
  const workflowEnvelopes = trustedWorkflowEnvelopes(store)
  const campaignRefs = campaignRefsByNode(store, workflowEnvelopes)
  const metadata = projectionMetadataByNode(store)
  const abilityRefs = abilityRefsByNode(store)
  const projectionAbilities = projectionAbilityRows(store)
  const abilityByKey = new Map(projectionAbilities.map(row => [refKey(row.faction_id, row.ability_id), row]))
  if (mode === 'index') {
    const limit = boundedInteger(query.limit, 100, 250)
    const fingerprint = sha256(canonicalJson(filters))
    const after = cursorDecode(query.after, revision, fingerprint)
    const rows = projectionAbilities
      .map(row => ({ ...row, tuple: [row.faction_name || row.faction_id, row.ability_name || row.ability_id, row.faction_id, row.ability_id] }))
      .sort((a, b) => compareTuple(a.tuple, b.tuple))
      .filter(row => !after || compareTuple(row.tuple, after) > 0)
    const pageRows = rows.slice(0, limit)
    const truncated = rows.length > pageRows.length
    const nodes = [rootNode(revision), ...pageRows.map(row => abilityNode(row, abilityStatusMetadata(store, row.faction_id, row.ability_id, campaignRefs, metadata)))]
    const edges = pageRows.map(row => {
      const id = abilityProjectionId(row.faction_id, row.ability_id)
      return edge(`edge:${GLOBAL_ROOT_ID}:${id}`, GLOBAL_ROOT_ID, id, 'contains')
    })
    const next = truncated ? cursorEncode({ graph_revision: revision, fingerprint, tuple: pageRows.at(-1).tuple }) : null
    return { graph_revision: revision, root: GLOBAL_ROOT_ID, nodes, edges, page: { next_cursor: next, truncated }, filters }
  }

  const limit = boundedInteger(query.limit, 150, 400, 3)
  const depth = boundedInteger(query.depth, 4, 8, 0)
  const selectedCampaign = mode === 'campaign' ? store.db.prepare('SELECT run_id,campaign_id FROM runs WHERE campaign_id=?').get(filters.campaign_id) : null
  if (mode === 'campaign' && !selectedCampaign) throw new GraphQueryError(404, 'campaign-not-found')
  let abilityRows
  if (mode === 'ability') {
    const row = abilityByKey.get(refKey(filters.faction_id, filters.ability_id))
    if (!row) throw new GraphQueryError(404, 'ability-not-found')
    abilityRows = [row]
  } else {
    const keys = new Map()
    for (const [nodeId, campaigns] of campaignRefs) {
      if (!campaigns.includes(filters.campaign_id)) continue
      for (const ref of abilityRefs.get(nodeId) || []) keys.set(refKey(ref.faction_id, ref.ability_id), ref)
    }
    abilityRows = [...keys.values()].map(ref => abilityByKey.get(refKey(ref.faction_id, ref.ability_id))).filter(Boolean)
      .sort((a, b) => (a.faction_name || a.faction_id).localeCompare(b.faction_name || b.faction_id) || (a.ability_name || a.ability_id).localeCompare(b.ability_name || b.ability_id) || a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
  }
  const conditions = mode === 'ability'
    ? { sql: 'refs.faction_id=? AND refs.ability_id=?', args: [filters.faction_id, filters.ability_id] }
    : null
  let rows = mode === 'ability'
    ? store.db.prepare(`SELECT n.node_id,n.kind,n.producer_contract_version,n.payload_json,MIN(refs.distance) AS lineage_distance FROM nodes n JOIN node_ability_refs refs USING(node_id) WHERE ${conditions.sql} GROUP BY n.node_id,n.kind,n.producer_contract_version,n.payload_json`).all(...conditions.args)
    : store.db.prepare('SELECT n.node_id,n.kind,n.producer_contract_version,n.payload_json,MIN(refs.distance) AS lineage_distance FROM nodes n JOIN node_ability_refs refs USING(node_id) GROUP BY n.node_id,n.kind,n.producer_contract_version,n.payload_json').all()
        .filter(row => (campaignRefs.get(row.node_id) || []).includes(filters.campaign_id))
  rows = rows.filter(row => Number(row.lineage_distance) <= depth)
    .map(row => ({ ...row, tuple: [Number(row.lineage_distance), row.kind, row.node_id] }))
    .sort((a, b) => compareTuple(a.tuple, b.tuple))
  const evidenceNodeIds = new Set(rows.map(row => row.node_id))
  const fingerprint = sha256(canonicalJson({ ...filters, depth }))
  const after = cursorDecode(query.after, revision, fingerprint)
  const precedingNodeIds = new Set(rows.filter(row => after && compareTuple(row.tuple, after) <= 0).map(row => row.node_id))
  rows = rows.filter(row => !after || compareTuple(row.tuple, after) > 0)
  let pageRows
  let pageAbilityRows
  if (mode === 'ability') {
    pageAbilityRows = abilityRows
    pageRows = rows.slice(0, limit - 2)
  } else {
    const campaignAbilityKeys = new Set(abilityRows.map(row => refKey(row.faction_id, row.ability_id)))
    const selectedAbilities = new Map()
    pageRows = []
    for (const row of rows) {
      const referenced = (abilityRefs.get(row.node_id) || [])
        .filter(ref => campaignAbilityKeys.has(refKey(ref.faction_id, ref.ability_id)))
        .map(ref => abilityByKey.get(refKey(ref.faction_id, ref.ability_id)))
        .filter(Boolean)
      const additions = referenced.filter(ref => !selectedAbilities.has(refKey(ref.faction_id, ref.ability_id)))
      if (1 + pageRows.length + selectedAbilities.size + 1 + additions.length > limit) {
        if (!pageRows.length) throw new GraphQueryError(400, 'limit-too-small-for-campaign-node')
        break
      }
      pageRows.push(row)
      for (const ref of additions) selectedAbilities.set(refKey(ref.faction_id, ref.ability_id), ref)
    }
    pageAbilityRows = [...selectedAbilities.values()].sort((a, b) => (a.faction_name || a.faction_id).localeCompare(b.faction_name || b.faction_id) || (a.ability_name || a.ability_id).localeCompare(b.ability_name || b.ability_id))
  }
  const truncated = rows.length > pageRows.length
  const evidenceNodes = pageRows.map(row => evidenceNode(row, abilityRefs, campaignRefs, metadata, workflowEnvelopes))
  const nodes = [rootNode(revision), ...pageAbilityRows.map(row => abilityNode(row, abilityStatusMetadata(store, row.faction_id, row.ability_id, campaignRefs, metadata))), ...evidenceNodes]
  const availableNodeIds = new Set([...precedingNodeIds, ...evidenceNodes.map(node => node.id)])
  const edges = selectedEdges(store, evidenceNodes.map(node => node.id), pageAbilityRows, evidenceNodeIds, availableNodeIds)
  const next = truncated ? cursorEncode({ graph_revision: revision, fingerprint, tuple: pageRows.at(-1).tuple }) : null
  return { graph_revision: revision, root: GLOBAL_ROOT_ID, nodes, edges, page: { next_cursor: next, truncated }, filters: { ...filters, depth } }
}

export function globalGraphUpdates(store, query = {}) {
  const since = Number(query.since)
  if (!Number.isInteger(since) || since < 0) throw new GraphQueryError(400, 'invalid-sequence')
  const mode = query.mode || 'index'
  const filters = { mode, faction_id: query.faction_id || null, ability_id: query.ability_id || null, campaign_id: query.campaign_id || null }
  validateFilters(mode, filters)
  const limit = boundedInteger(query.limit, 100, 250)
  const revision = graphRevision(store)
  const campaignRefs = campaignRefsByNode(store)
  const refs = abilityRefsByNode(store)
  const rows = store.db.prepare('SELECT sequence,node_id,aggregate_id FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(since, limit + 1)
  const pageRows = rows.slice(0, limit)
  const affected = new Map()
  for (const row of pageRows) {
    for (const ref of refs.get(row.node_id) || []) {
      if (mode === 'ability' && (ref.faction_id !== filters.faction_id || ref.ability_id !== filters.ability_id)) continue
      if (mode === 'campaign' && !(campaignRefs.get(row.node_id) || []).includes(filters.campaign_id)) continue
      affected.set(refKey(ref.faction_id, ref.ability_id), { faction_id: ref.faction_id, ability_id: ref.ability_id })
    }
    if (mode !== 'ability') {
      const runId = store.db.prepare('SELECT run_id FROM runs WHERE run_id=? OR campaign_id=?').get(row.aggregate_id, row.aggregate_id)?.run_id
      if (runId) for (const claim of store.db.prepare('SELECT faction_id,ability_id FROM claims WHERE run_id=?').all(runId)) affected.set(refKey(claim.faction_id, claim.ability_id), { ...claim })
    }
  }
  const through = pageRows.length ? Number(pageRows.at(-1).sequence) : since
  return {
    graph_revision: revision,
    through,
    affected_ability_ids: [...affected.values()].sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id)),
    page: { next_cursor: rows.length > limit ? String(through) : null, truncated: rows.length > limit },
    filters,
  }
}

const EFFECT_CHILD_KEYS = ['effect', 'steps', 'options', 'reward', 'on_success', 'on_fail', 'success', 'failure']
const UNSUPPORTED_EFFECT_TYPES = new Set(['unsupported', 'unstructured', 'schema-resistant', 'represented-gap'])

function effectChildren(effect) {
  const children = []
  for (const key of EFFECT_CHILD_KEYS) {
    const value = effect?.[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          if (item.effect && typeof item.effect === 'object') children.push(item.effect)
          else if (typeof item.type === 'string') children.push(item)
        }
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') children.push(value)
  }
  if (effect?.risk?.on_fail && typeof effect.risk.on_fail === 'object') children.push(effect.risk.on_fail)
  return children
}

export function normalizedEffectSignature(effect) {
  return canonicalJson(normalizeValue(effect))
}

function effectMetrics(effect) {
  const leaves = []
  let maxDepth = 0
  let containerCount = 0
  let unsupportedShapeCount = 0
  const visit = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth)
    const children = effectChildren(node)
    if (UNSUPPORTED_EFFECT_TYPES.has(String(node?.type || ''))) unsupportedShapeCount += 1
    if (children.length) {
      containerCount += 1
      for (const child of children) visit(child, depth + 1)
    } else leaves.push(normalizedEffectSignature(node))
  }
  visit(effect, 1)
  return { leaves, max_depth: maxDepth, container_count: containerCount, unsupported_shape_count: unsupportedShapeCount }
}

function comparePriorities(left, right) {
  return left.bucket - right.bucket
    || (left.bucket === 3 ? right.certified_coverage_ratio - left.certified_coverage_ratio : 0)
    || right.repeat_count - left.repeat_count
    || left.uncertified_leaf_count - right.uncertified_leaf_count
    || left.leaf_count - right.leaf_count
    || left.max_depth - right.max_depth
    || left.faction_id.localeCompare(right.faction_id)
    || left.ability_id.localeCompare(right.ability_id)
}

export function rankMechanicCandidates(candidates, {
  active_claims = [],
  certified_abilities = [],
  source_unavailable = [],
  represented_gaps = [],
} = {}) {
  const active = new Set(active_claims)
  const certified = new Set(certified_abilities)
  const unavailable = new Set(source_unavailable)
  const gaps = new Set(represented_gaps)
  const measured = candidates.map(candidate => {
    const metrics = effectMetrics(candidate.effect)
    return { ...candidate, ...metrics, key: `${candidate.faction_id}/${candidate.ability_id}` }
  })
  const certifiedLeafSignatures = new Set(measured.filter(candidate => certified.has(candidate.key)).flatMap(candidate => candidate.leaves))
  const repeats = new Map()
  for (const candidate of measured) for (const signature of new Set(candidate.leaves)) repeats.set(signature, (repeats.get(signature) || 0) + 1)
  const eligible = []
  const excluded = []
  for (const candidate of measured) {
    let exclusion_reason = null
    if (active.has(candidate.key)) exclusion_reason = 'active-claim-or-lease'
    else if (certified.has(candidate.key)) exclusion_reason = 'already-certified'
    else if (unavailable.has(candidate.key) || candidate.source_available === false) exclusion_reason = 'source-unavailable'
    const certifiedLeafCount = candidate.leaves.filter(signature => certifiedLeafSignatures.has(signature)).length
    const leafCount = candidate.leaves.length
    const unsupportedShapeCount = candidate.unsupported_shape_count + (gaps.has(candidate.key) || candidate.schema_resistant ? 1 : 0)
    const repeatCount = Math.max(0, ...candidate.leaves.map(signature => repeats.get(signature) || 0))
    const uncertifiedLeafCount = leafCount - certifiedLeafCount
    const certifiedCoverageRatio = leafCount ? certifiedLeafCount / leafCount : 0
    let bucket
    if (leafCount === 1 && unsupportedShapeCount === 0 && repeatCount > 1) bucket = 1
    else if (leafCount > 1 && uncertifiedLeafCount === 0) bucket = 2
    else if (unsupportedShapeCount > 0) bucket = 4
    else bucket = 3
    const feature = {
      faction_id: candidate.faction_id,
      ability_id: candidate.ability_id,
      mechanic_signature: normalizedEffectSignature(candidate.effect),
      leaf_signatures: [...candidate.leaves],
      leaf_count: leafCount,
      max_depth: candidate.max_depth,
      container_count: candidate.container_count,
      unsupported_shape_count: unsupportedShapeCount,
      repeat_count: repeatCount,
      certified_leaf_count: certifiedLeafCount,
      uncertified_leaf_count: uncertifiedLeafCount,
      certified_coverage_ratio: certifiedCoverageRatio,
      bucket,
      exclusion_reason,
    }
    if (exclusion_reason) excluded.push(feature)
    else eligible.push(feature)
  }
  eligible.sort(comparePriorities)
  excluded.sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
  return { eligible, excluded }
}

function repositoryAbilities(repoRoot) {
  const root = join(repoRoot, 'data', 'enrichment')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = join(root, entry.name, 'abilities.json')
      if (!existsSync(path)) return []
      return JSON.parse(readFileSync(path, 'utf8')).map(ability => ({
        faction_id: entry.name,
        ability_id: ability.ability_id,
        effect: ability.effect,
      })).filter(ability => typeof ability.ability_id === 'string' && ability.effect && typeof ability.effect === 'object')
    })
}

function activeLeaseAbilityKeys(store, now = Date.now()) {
  const keys = []
  const leases = store.db.prepare("SELECT leases.run_id,leases.payload_json FROM leases JOIN runs USING(run_id) WHERE leases.state='active' AND runs.state NOT IN ('completed','aborted','superseded','failed-final')").all()
  for (const lease of leases) {
    const payload = JSON.parse(lease.payload_json || '{}')
    const expiry = Date.parse(payload.lease_expires_at || payload.expires_at || '')
    if (!Number.isFinite(expiry) || expiry <= now || typeof payload.task_id !== 'string' || typeof payload.attempt_id !== 'string') continue
    const task = store.db.prepare("SELECT payload_json FROM tasks WHERE id=? AND run_id=? AND state IN ('ready','running')").get(payload.task_id, lease.run_id)
    const attempt = store.db.prepare("SELECT 1 FROM attempts WHERE id=? AND run_id=? AND state IN ('allocated','running')").get(payload.attempt_id, lease.run_id)
    if (!task || !attempt) continue
    const taskPayload = JSON.parse(task.payload_json || '{}')
    if (typeof taskPayload.faction_id === 'string' && typeof taskPayload.ability_id === 'string') keys.push(`${taskPayload.faction_id}/${taskPayload.ability_id}`)
  }
  return keys
}

export function wholeGraphPriorities(store, { repoRoot, candidates = null } = {}) {
  const activeClaims = store.db.prepare("SELECT faction_id,ability_id FROM claims WHERE state='active' ORDER BY faction_id,ability_id").all()
    .map(row => `${row.faction_id}/${row.ability_id}`)
  const states = store.db.prepare('SELECT id,state FROM ability_evidence ORDER BY id').all()
  const certified = states.filter(row => row.state === 'certified').map(row => row.id)
  const unavailable = states.filter(row => row.state === 'source-unavailable').map(row => row.id)
  const gaps = states.filter(row => ['represented-gap', 'refuted', 'needs-schema'].includes(row.state)).map(row => row.id)
  return rankMechanicCandidates(candidates || repositoryAbilities(repoRoot), {
    active_claims: [...new Set([...activeClaims, ...activeLeaseAbilityKeys(store)])],
    certified_abilities: certified,
    source_unavailable: unavailable,
    represented_gaps: gaps,
  })
}
