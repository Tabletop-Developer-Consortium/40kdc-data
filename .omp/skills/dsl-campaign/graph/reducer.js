import { canonicalJson, sha256 } from './canonical.js'
import {
  assertAllowedEvent,
  EVENT_CONTRACTS,
  NORMALIZED_CLAIM_TABLES,
  REBUILDABLE_PROJECTION_TABLES,
  SCHEMA_VERSION,
  TABLES,
} from './schema.js'
import { mechanicQueryFacets, MECHANIC_ADAPTER_ID } from './mechanic-claims.js'
import { rebuildNodeAbilityRefs } from './projection.js'

export const PROJECTION_SCHEMA_VERSION = 5

const TERMINAL_TASKS = ['succeeded', 'failed-final', 'cancelled', 'superseded', 'stale', 'invalid-output']

export const AGGREGATE_STATES = Object.freeze({
  run: ['planned', 'active', 'paused', 'reconciliation-required', 'completed', 'aborted', 'superseded', 'failed-final'],
  task: ['pending', 'ready', 'running', ...TERMINAL_TASKS],
  attempt: ['allocated', 'running', 'succeeded', 'retryable-failure', 'failed-final', 'stale', 'invalid-output'],
  lease: ['allocated', 'active', 'expired', 'released', 'superseded'],
  checkpoint: ['none', 'recorded'],
  decision: ['open', 'answered', 'superseded'],
  finding: ['open', 'resolved', 'rebutted', 'superseded'],
  certificate: ['provisional', 'certified', 'invalidated', 'refuted'],
  'apply-transaction': ['planned', 'applying', 'applied', 'verified', 'reconciliation-required', 'rolled-back', 'failed-final'],
})

export const AGGREGATE_EVENTS = Object.freeze({
  run: ['run-created', 'run-started', 'run-paused', 'run-resumed', 'run-completed', 'run-aborted', 'run-superseded', 'run-failed', 'repository-mismatch'],
  task: ['task-created', 'task-ready', 'task-started', 'task-succeeded', 'task-failed-final', 'task-cancelled', 'task-superseded', 'task-stale', 'task-invalid-output'],
  attempt: ['attempt-allocated', 'attempt-started', 'attempt-succeeded', 'attempt-retryable-failure', 'attempt-failed-final', 'attempt-stale', 'attempt-invalid-output'],
  lease: ['lease-allocated', 'lease-activated', 'lease-renewed', 'lease-expired', 'lease-released', 'lease-superseded'],
  checkpoint: ['checkpoint-recorded'],
  decision: ['decision-opened', 'decision-answered', 'decision-superseded'],
  finding: ['finding-opened', 'finding-resolved', 'finding-rebutted', 'finding-superseded'],
  certificate: ['certificate-provisional', 'certificate-certified', 'certificate-invalidated', 'certificate-refuted'],
  'apply-transaction': ['apply-planned', 'apply-started', 'apply-recorded', 'apply-verified', 'apply-reconciliation-required', 'apply-rolled-back', 'apply-failed-final'],
})

const RULES = {
  run: {
    'run-created': { from: ['planned'], to: 'planned' }, 'run-started': { from: ['planned', 'paused'], to: 'active' },
    'run-paused': { from: ['planned', 'active'], to: 'paused' }, 'run-resumed': { from: ['paused'], to: 'active' },
    'run-completed': { from: ['active'], to: 'completed' }, 'run-aborted': { from: ['planned', 'active', 'paused'], to: 'aborted' },
    'run-superseded': { from: ['planned', 'active', 'paused', 'reconciliation-required', 'completed', 'aborted', 'failed-final'], to: 'superseded' },
    'run-failed': { from: ['planned', 'active', 'paused', 'reconciliation-required'], to: 'failed-final' },
    'repository-mismatch': { from: ['planned', 'active', 'paused'], to: 'reconciliation-required', emitted: ['certificate-descendants-invalidated'] },
  },
  task: Object.fromEntries([
    ['task-created', ['pending'], 'pending'], ['task-ready', ['pending'], 'ready'], ['task-started', ['ready'], 'running'],
    ['task-succeeded', ['running'], 'succeeded'], ['task-failed-final', ['pending', 'ready', 'running'], 'failed-final'],
    ['task-cancelled', ['pending', 'ready', 'running'], 'cancelled'], ['task-superseded', ['pending', 'ready', 'running'], 'superseded'],
    ['task-stale', ['pending', 'ready', 'running'], 'stale'], ['task-invalid-output', ['running'], 'invalid-output'],
  ].map(([event, from, to]) => [event, { from, to }])),
  attempt: Object.fromEntries([
    ['attempt-allocated', ['allocated'], 'allocated'], ['attempt-started', ['allocated'], 'running'],
    ['attempt-succeeded', ['running'], 'succeeded'], ['attempt-retryable-failure', ['running'], 'retryable-failure'],
    ['attempt-failed-final', ['allocated', 'running', 'retryable-failure'], 'failed-final'],
    ['attempt-stale', ['allocated', 'running', 'retryable-failure'], 'stale'], ['attempt-invalid-output', ['running'], 'invalid-output'],
  ].map(([event, from, to]) => [event, { from, to }])),
  lease: Object.fromEntries([
    ['lease-allocated', ['allocated'], 'allocated'], ['lease-activated', ['allocated'], 'active'],
    ['lease-renewed', ['active'], 'active'], ['lease-expired', ['allocated', 'active'], 'expired'],
    ['lease-released', ['allocated', 'active'], 'released'], ['lease-superseded', ['allocated', 'active'], 'superseded'],
  ].map(([event, from, to]) => [event, { from, to }])),
  checkpoint: { 'checkpoint-recorded': { from: ['none', 'recorded'], to: 'recorded', checkpoint: true } },
  decision: {
    'decision-opened': { from: ['open'], to: 'open' }, 'decision-answered': { from: ['open'], to: 'answered' },
    'decision-superseded': { from: ['open', 'answered'], to: 'superseded' },
  },
  finding: {
    'finding-opened': { from: ['open'], to: 'open' }, 'finding-resolved': { from: ['open'], to: 'resolved' },
    'finding-rebutted': { from: ['open'], to: 'rebutted' }, 'finding-superseded': { from: ['open'], to: 'superseded' },
  },
  certificate: {
    'certificate-provisional': { from: ['provisional'], to: 'provisional' }, 'certificate-certified': { from: ['provisional'], to: 'certified' },
    'certificate-invalidated': { from: ['provisional', 'certified'], to: 'invalidated', emitted: ['certificate-descendants-invalidated'] },
    'certificate-refuted': { from: ['provisional', 'certified'], to: 'refuted', emitted: ['certificate-descendants-invalidated'] },
  },
  'apply-transaction': Object.fromEntries([
    ['apply-planned', ['planned'], 'planned'], ['apply-started', ['planned'], 'applying'], ['apply-recorded', ['applying'], 'applied'],
    ['apply-verified', ['applied'], 'verified'], ['apply-reconciliation-required', ['applying', 'applied'], 'reconciliation-required'],
    ['apply-rolled-back', ['applying', 'applied', 'reconciliation-required'], 'rolled-back'],
    ['apply-failed-final', ['planned', 'applying', 'applied', 'reconciliation-required'], 'failed-final'],
  ].map(([event, from, to]) => [event, { from, to }])),
}

export const TRANSITION_MATRIX = Object.freeze(Object.fromEntries(
  Object.entries(AGGREGATE_STATES).map(([kind, states]) => [
    kind,
    Object.fromEntries(states.map(state => [
      state,
      Object.fromEntries(AGGREGATE_EVENTS[kind].map(event => [event, RULES[kind][event]?.from.includes(state) ? RULES[kind][event].to : null])),
    ])),
  ]),
))

function result(classification, currentState, nextState, emittedEvents, reason) {
  return { classification, next_state: classification === 'accepted' ? nextState : currentState, emitted_events: emittedEvents, reason }
}

function validPayload(payload) { return payload && Object.getPrototypeOf(payload) === Object.prototype }

export function transition(aggregateKind, currentState, eventType, payload) {
  try {
    if (!AGGREGATE_STATES[aggregateKind]) return result('rejected', currentState, currentState, [], 'unknown aggregate kind')
    if (!AGGREGATE_STATES[aggregateKind].includes(currentState)) return result('rejected', currentState, currentState, [], 'unknown current state')
    if (!AGGREGATE_EVENTS[aggregateKind].includes(eventType)) return result('rejected', currentState, currentState, [], 'unknown event type')
    if (!validPayload(payload)) return result('rejected', currentState, currentState, [], 'malformed payload')
    if (payload.expected_state !== undefined && payload.expected_state !== currentState) return result('stale', currentState, currentState, [], 'expected state mismatch')
    const rule = RULES[aggregateKind][eventType]
    const next = TRANSITION_MATRIX[aggregateKind][currentState][eventType]
    if (next === null) {
      if (rule.to === currentState) return result('idempotent', currentState, currentState, [], 'already applied')
      return result('rejected', currentState, currentState, [], 'transition not allowed')
    }
    if (rule.checkpoint) {
      if (!Number.isInteger(payload.sequence) || payload.sequence < 1 || typeof payload.hash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.hash)) {
        return result('rejected', currentState, currentState, [], 'invalid checkpoint sequence or hash')
      }
      if (currentState === 'recorded') {
        if (payload.previous_sequence === payload.sequence && payload.previous_hash === payload.hash) return result('idempotent', currentState, currentState, [], 'checkpoint already recorded')
        if (Number.isInteger(payload.previous_sequence) && payload.sequence <= payload.previous_sequence) return result('stale', currentState, currentState, [], 'checkpoint is stale')
        if (payload.previous_hash && payload.expected_previous_hash !== payload.previous_hash) return result('rejected', currentState, currentState, [], 'checkpoint hash chain mismatch')
      }
    }
    if (aggregateKind === 'lease' && eventType === 'lease-expired') {
      const now = Date.parse(payload.now)
      const expires = Date.parse(payload.expires_at)
      if (!Number.isFinite(now) || !Number.isFinite(expires)) return result('rejected', currentState, currentState, [], 'invalid lease timestamps')
      if (now < expires) return result('stale', currentState, currentState, [], 'lease is still live')
    }
    if (aggregateKind === 'lease' && eventType === 'lease-renewed') {
      const previous = Date.parse(payload.previous_expires_at)
      const expires = Date.parse(payload.expires_at)
      if (!Number.isFinite(previous) || !Number.isFinite(expires) || expires <= previous) {
        return result('rejected', currentState, currentState, [], 'renewal must extend lease expiry')
      }
      for (const key of ['task_id', 'attempt_id', 'input_hash']) if (typeof payload[key] !== 'string' || !payload[key]) {
        return result('rejected', currentState, currentState, [], `renewal missing ${key}`)
      }
      return result('accepted', currentState, currentState, [], 'lease renewed')
    }
    if (next === currentState) return result('idempotent', currentState, currentState, [], 'already applied')
    return result('accepted', currentState, next, rule.emitted || [], 'transition accepted')
  } catch {
    return result('rejected', currentState, currentState, [], 'malformed payload')
  }
}

const GENERIC_TABLE_BY_KIND = Object.freeze({
  task: 'tasks', attempt: 'attempts', lease: 'leases', checkpoint: 'checkpoints', decision: 'decisions',
  finding: 'findings', certificate: 'certificates', 'apply-transaction': 'apply_transactions',
})
const GENERIC_TABLES = new Set(TABLES)
const PROJECTION_TABLES = new Set(REBUILDABLE_PROJECTION_TABLES)

function assertProjectionTable(table) {
  if (!PROJECTION_TABLES.has(table)) throw new TypeError(`unsupported projection table: ${table}`)
}

function normalizeGenericRow(row) {
  if (!row || typeof row.id !== 'string' || !row.id) throw new TypeError('projection row requires id')
  return {
    id: row.id,
    run_id: row.run_id ?? null,
    state: row.state ?? null,
    node_id: row.node_id ?? null,
    payload_json: typeof row.payload_json === 'string' ? row.payload_json : canonicalJson(row.payload ?? {}),
  }
}

function normalizeSourceSnapshotRow(row) {
  const value = normalizeGenericRow(row)
  return { ...value, run_id: null, node_id: null }
}
const CLAIM_TABLES = new Set([
  'claim_origins', 'claim_imports', 'claim_extractions', 'semantic_claims', 'claim_occurrences',
  'claim_evidence_bindings', 'claim_assertions', 'claim_assertion_evidence',
  'claim_derivation_parents', 'claim_evidence_binding_parents', 'claim_unresolved',
  'claim_unresolved_candidates', 'claim_unresolved_evidence', 'claim_review_decisions',
  'claim_relations', 'claim_source_revision_invalidations', 'claim_sets', 'claim_set_members',
  'claim_set_unresolved', 'mechanic_claim_facets', 'representation_claim_coverage',
])

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)
}

const MUTABLE_PROJECTION_COLUMNS = Object.freeze({
  claim_origins: ['current_state'],
  claim_occurrences: ['state'],
  claim_assertions: ['decision_state'],
  claim_unresolved: ['resolution_state'],
  claim_sets: ['state', 'certificate_node_id'],
  representation_claim_coverage: ['coverage_state', 'construction_plan_node_id'],
})

const STATE_TRANSITIONS = Object.freeze({
  claim_origins: { current: ['stale', 'historical'], stale: [], historical: ['current'] },
  claim_occurrences: { proposed: ['accepted', 'contradicted', 'superseded', 'invalidated'], accepted: ['contradicted', 'superseded', 'invalidated'], contradicted: ['superseded', 'invalidated'], superseded: ['invalidated'], invalidated: [] },
  claim_assertions: { proposed: ['accepted', 'rejected', 'superseded', 'invalidated'], accepted: ['superseded', 'invalidated'], rejected: ['superseded', 'invalidated'], superseded: ['invalidated'], invalidated: [] },
  claim_unresolved: { open: ['resolved', 'waived'], resolved: [], waived: [] },
  claim_sets: { current: ['invalidated'], invalidated: [] },
})

function immutableRow(db, table, row) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all()
  const columns = info.map(column => column.name)
  const value = Object.fromEntries(columns.map(column => [
    column,
    Object.hasOwn(row, column) ? row[column] : (table === 'claim_sets' && column === 'state' ? 'current' : null),
  ]))
  const missing = info.filter(column => column.notnull && value[column.name] === null).map(column => column.name)
  if (missing.length) throw new TypeError(`${table}: immutable row missing columns ${missing.join(',')}`)
  const where = info.filter(column => column.pk).sort((a, b) => a.pk - b.pk)
  if (!where.length) throw new TypeError(`${table}: immutable projection requires a primary key`)
  const predicate = where.map(column => `${column.name}=?`).join(' AND ')
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${predicate}`).get(...where.map(column => value[column.name]))
  if (existing) {
    const mutable = MUTABLE_PROJECTION_COLUMNS[table] || []
    const immutable = Object.fromEntries(columns.filter(column => !mutable.includes(column)).map(column => [column, value[column]]))
    const priorImmutable = Object.fromEntries(columns.filter(column => !mutable.includes(column)).map(column => [column, existing[column]]))
    if (canonicalJson(priorImmutable) !== canonicalJson(immutable)) throw new Error(`${table}: immutable row conflicts with existing key`)
    const changed = mutable.filter(column => existing[column] !== value[column])
    if (!changed.length) return
    const transitions = STATE_TRANSITIONS[table]
    if (transitions && changed.includes(mutable[0]) && !transitions[existing[mutable[0]]]?.includes(value[mutable[0]])) throw new Error(`${table}: invalid projection state transition`)
    db.prepare(`UPDATE ${table} SET ${changed.map(column => `${column}=?`).join(',')} WHERE ${predicate}`)
      .run(...changed.map(column => value[column]), ...where.map(column => value[column.name]))
    return
  }
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => value[column]))
}

function upsertRow(db, table, row) {
  if (table === 'source_snapshots') {
    immutableRow(db, table, normalizeSourceSnapshotRow(row))
    return
  }
  assertProjectionTable(table)
  if (CLAIM_TABLES.has(table)) {
    immutableRow(db, table, row)
    return
  }
  if (GENERIC_TABLES.has(table)) {
    const value = normalizeGenericRow(row)
    db.prepare(`INSERT OR REPLACE INTO ${table}(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)`)
      .run(value.id, value.run_id, value.state, value.node_id, value.payload_json)
    return
  }
  if (table === 'runs') {
    if (!row || typeof row.run_id !== 'string' || !row.run_id) throw new TypeError('run row requires run_id')
    db.prepare('INSERT OR REPLACE INTO runs(run_id,campaign_id,state,kind,target,started,finished,source_hash,paused_reason) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.run_id, row.campaign_id ?? null, row.state, row.kind ?? null, row.target ?? null, row.started ?? null, row.finished ?? null, row.source_hash ?? null, row.paused_reason ?? null)
    return
  }
  if (table === 'claims') {
    db.prepare('INSERT OR REPLACE INTO claims(faction_id,ability_id,run_id,state,claimed_sequence,released_sequence) VALUES (?,?,?,?,?,?)')
      .run(row.faction_id, row.ability_id, row.run_id, row.state, row.claimed_sequence, row.released_sequence ?? null)
    return
  }
  if (table === 'ability_catalog') {
    db.prepare('INSERT OR REPLACE INTO ability_catalog(faction_id,ability_id,ability_name,faction_name,repository_version_id) VALUES (?,?,?,?,?)')
      .run(row.faction_id, row.ability_id, row.ability_name, row.faction_name, row.repository_version_id)
    return
  }
  if (table === 'node_ability_refs') {
    db.prepare('INSERT OR REPLACE INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
      .run(row.node_id, row.faction_id, row.ability_id, row.source_kind, row.distance)
    return
  }
  if (table === 'progress') {
    db.prepare('INSERT OR REPLACE INTO progress(name,sequence,checksum) VALUES (?,?,?)').run(row.name, row.sequence, row.checksum)
    return
  }
  throw new TypeError(`no row projector for ${table}`)
}

function applyRows(db, rows, { replace = false } = {}) {
  if (!rows || Object.getPrototypeOf(rows) !== Object.prototype) throw new TypeError('projection rows must be an object')
  for (const table of Object.keys(rows)) assertProjectionTable(table)
  const tables = REBUILDABLE_PROJECTION_TABLES.filter(table => Object.hasOwn(rows, table))
  for (const table of tables) {
    assertProjectionTable(table)
    if (!Array.isArray(rows[table])) throw new TypeError(`${table}: rows must be an array`)
    if (replace) db.exec(`DELETE FROM ${table}`)
    for (const row of rows[table]) upsertRow(db, table, row)
  }
}

const OCCURRENCE_STATES = new Set(['proposed', 'accepted', 'contradicted', 'superseded', 'invalidated'])
const UNRESOLVED_STATES = new Set(['open', 'resolved', 'waived'])
const COVERAGE_STATES = new Set(['covered', 'unmatched', 'blocked'])
const RELATION_TYPES = new Set(['semantically_equivalent_to', 'specializes', 'generalizes', 'contradicts', 'supersedes'])
const ASSERTION_STATES = new Set(['proposed', 'accepted', 'rejected', 'superseded', 'invalidated'])

function has(db, table, key, value) {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(value))
}

function requireNode(db, nodeId, label) {
  if (typeof nodeId !== 'string' || !has(db, 'nodes', 'node_id', nodeId)) throw new Error(`${label}: missing node parent`)
}

function nodeKind(db, nodeId) {
  return db.prepare('SELECT kind FROM nodes WHERE node_id=?').get(nodeId)?.kind ?? null
}

function orderedParents(db, table, ownerColumn, ownerId) {
  return db.prepare(`SELECT parent_claim_occurrence_id FROM ${table} WHERE ${ownerColumn}=? ORDER BY ordinal`).all(ownerId)
    .map(row => row.parent_claim_occurrence_id)
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function parseJsonArray(value, label) {
  let result
  try { result = JSON.parse(value) } catch { throw new Error(`${label}: invalid JSON`) }
  if (!Array.isArray(result) || result.some(item => typeof item !== 'string') || new Set(result).size !== result.length) {
    throw new Error(`${label}: expected unique string array`)
  }
  return result
}

function derivedDescendantOccurrenceIds(db, parentIds) {
  if (!parentIds.length) return []
  const placeholders = parentIds.map(() => '?').join(',')
  return db.prepare(`
    WITH RECURSIVE descendants(claim_occurrence_id) AS (
      SELECT a.claim_occurrence_id
      FROM claim_derivation_parents p
      JOIN claim_assertions a ON a.assertion_id=p.assertion_id
      WHERE p.parent_claim_occurrence_id IN (${placeholders})
      UNION
      SELECT a.claim_occurrence_id
      FROM claim_derivation_parents p
      JOIN claim_assertions a ON a.assertion_id=p.assertion_id
      JOIN descendants d ON d.claim_occurrence_id=p.parent_claim_occurrence_id
    )
    SELECT DISTINCT claim_occurrence_id FROM descendants
  `).all(...parentIds).map(row => row.claim_occurrence_id)
}

function assertClaimRows(db) {
  for (const row of db.prepare('SELECT * FROM claim_origins').all()) {
    const primary = row.origin_kind === 'primary-source'
    if (primary !== (row.source_snapshot_id !== null) || primary === (row.artifact_node_id !== null) || primary === (row.content_sha256 !== null)) throw new Error('claim origin: invalid tagged identity')
    if (primary && !has(db, 'source_snapshots', 'id', row.source_snapshot_id)) throw new Error('claim origin: missing source snapshot')
    if (!primary) requireNode(db, row.artifact_node_id, 'claim origin artifact')
    requireNode(db, row.node_id, 'claim origin')
  }
  for (const row of db.prepare('SELECT * FROM claim_imports').all()) {
    if (!has(db, 'claim_origins', 'origin_id', row.origin_id) || !has(db, 'claim_sets', 'claim_set_id', row.claim_set_id)) throw new Error('claim import: missing parent')
    requireNode(db, row.event_node_id, 'claim import')
  }
  for (const row of db.prepare('SELECT * FROM claim_extractions').all()) {
    if (!has(db, 'claim_origins', 'origin_id', row.origin_id)) throw new Error('claim extraction: missing origin')
    requireNode(db, row.node_id, 'claim extraction')
  }
  for (const row of db.prepare('SELECT * FROM semantic_claims').all()) requireNode(db, row.node_id, 'semantic claim')
  for (const row of db.prepare('SELECT * FROM claim_occurrences').all()) {
    if (!has(db, 'claim_origins', 'origin_id', row.origin_id) || !has(db, 'semantic_claims', 'semantic_key', row.semantic_key)) throw new Error('claim occurrence: missing parent')
    if (!OCCURRENCE_STATES.has(row.state)) throw new Error(`claim occurrence: unknown state ${row.state}`)
    if (row.state === 'accepted') {
      const acceptedAssertions = db.prepare("SELECT assertion_id FROM claim_assertions WHERE claim_occurrence_id=? AND decision_state='accepted'").all(row.claim_occurrence_id)
      if (acceptedAssertions.length !== 1) throw new Error('claim occurrence: accepted occurrence requires exactly one accepted assertion')
    }
    requireNode(db, row.node_id, 'claim occurrence')
  }
  for (const row of db.prepare('SELECT * FROM claim_evidence_bindings').all()) {
    if (row.origin_id !== null && !has(db, 'claim_origins', 'origin_id', row.origin_id)) throw new Error('claim evidence binding: missing origin')
    const origin = row.origin_id === null ? null : db.prepare('SELECT origin_kind FROM claim_origins WHERE origin_id=?').get(row.origin_id)
    if (row.kind === 'source_span' && origin?.origin_kind !== 'primary-source') throw new Error('source span evidence requires primary source origin')
    if (row.kind === 'private_source_ref' && origin?.origin_kind !== 'primary-source') throw new Error('private source evidence requires primary source origin')
    const parents = orderedParents(db, 'claim_evidence_binding_parents', 'binding_id', row.binding_id)
    if (row.kind === 'derived_evidence') {
      if (!parents.length) throw new Error('derived evidence binding: requires parents')
      for (const parentId of parents) {
        if (!has(db, 'claim_occurrences', 'claim_occurrence_id', parentId)) throw new Error('derived evidence binding: missing parent occurrence')
      }
    } else if (parents.length) throw new Error('non-derived evidence binding: cannot have derivation parents')
    requireNode(db, row.node_id, 'claim evidence binding')
  }
  for (const row of db.prepare('SELECT * FROM claim_assertions').all()) {
    if (!has(db, 'claim_extractions', 'extraction_id', row.extraction_id) || !has(db, 'claim_occurrences', 'claim_occurrence_id', row.claim_occurrence_id)) throw new Error('claim assertion: missing parent')
    const occurrence = db.prepare('SELECT origin_id FROM claim_occurrences WHERE claim_occurrence_id=?').get(row.claim_occurrence_id)
    const extraction = db.prepare('SELECT origin_id FROM claim_extractions WHERE extraction_id=?').get(row.extraction_id)
    if (occurrence.origin_id !== extraction.origin_id) throw new Error('claim assertion: origin mismatch')
    if (!ASSERTION_STATES.has(row.decision_state)) throw new Error(`claim assertion: unknown decision state ${row.decision_state}`)
    if (row.decision_state === 'accepted') {
      const duplicate = db.prepare('SELECT assertion_id FROM claim_assertions WHERE claim_occurrence_id=? AND decision_state=? AND assertion_id<>?').get(row.claim_occurrence_id, 'accepted', row.assertion_id)
      const evidenceCount = db.prepare('SELECT COUNT(*) AS count FROM claim_assertion_evidence WHERE assertion_id=?').get(row.assertion_id).count
      const parentCount = db.prepare('SELECT COUNT(*) AS count FROM claim_derivation_parents WHERE assertion_id=?').get(row.assertion_id).count
      if (!evidenceCount && !parentCount) throw new Error('claim assertion: accepted assertion requires evidence or accepted derivation parent')
      if (duplicate) throw new Error('claim assertion: duplicate accepted assertion for occurrence')
    }
    requireNode(db, row.node_id, 'claim assertion')
  }
  for (const row of db.prepare('SELECT * FROM claim_assertion_evidence').all()) {
    if (!has(db, 'claim_assertions', 'assertion_id', row.assertion_id) || !has(db, 'claim_evidence_bindings', 'binding_id', row.binding_id)) throw new Error('claim assertion evidence: missing parent')
    const assertion = db.prepare('SELECT extraction_id FROM claim_assertions WHERE assertion_id=?').get(row.assertion_id)
    const extraction = db.prepare('SELECT origin_id FROM claim_extractions WHERE extraction_id=?').get(assertion.extraction_id)
    const binding = db.prepare('SELECT origin_id FROM claim_evidence_bindings WHERE binding_id=?').get(row.binding_id)
    if (binding.origin_id !== null && binding.origin_id !== extraction.origin_id) throw new Error('claim assertion evidence: origin mismatch')
  }
  for (const row of db.prepare('SELECT * FROM claim_derivation_parents').all()) {
    const assertion = db.prepare('SELECT claim_occurrence_id FROM claim_assertions WHERE assertion_id=?').get(row.assertion_id)
    if (!assertion) throw new Error('claim derivation parent: missing assertion')
    if (!has(db, 'claim_occurrences', 'claim_occurrence_id', row.parent_claim_occurrence_id)) throw new Error('claim derivation parent: missing parent occurrence')
    const cycle = db.prepare(`
      WITH RECURSIVE ancestors(claim_occurrence_id) AS (
        SELECT parent_claim_occurrence_id FROM claim_derivation_parents WHERE assertion_id=?
        UNION
        SELECT p.parent_claim_occurrence_id
        FROM claim_derivation_parents p
        JOIN claim_assertions a ON a.assertion_id=p.assertion_id
        JOIN ancestors ancestor ON ancestor.claim_occurrence_id=a.claim_occurrence_id
      )
      SELECT 1 FROM ancestors WHERE claim_occurrence_id=? LIMIT 1
    `).get(row.assertion_id, assertion.claim_occurrence_id)
    if (cycle) throw new Error('claim derivation parent: cycle')
  }
  for (const assertion of db.prepare('SELECT assertion_id FROM claim_assertions').all()) {
    const assertionParents = orderedParents(db, 'claim_derivation_parents', 'assertion_id', assertion.assertion_id)
    const derivedBindings = db.prepare(`
      SELECT b.binding_id FROM claim_assertion_evidence ae
      JOIN claim_evidence_bindings b ON b.binding_id=ae.binding_id
      WHERE ae.assertion_id=? AND b.kind='derived_evidence'
    `).all(assertion.assertion_id)
    if (!derivedBindings.length && assertionParents.length) throw new Error('claim assertion: derivation parents require derived evidence')
    for (const binding of derivedBindings) {
      const bindingParents = orderedParents(db, 'claim_evidence_binding_parents', 'binding_id', binding.binding_id)
      if (!exactArray(assertionParents, bindingParents)) throw new Error('claim assertion: derivation parents must exactly match derived evidence parents')
    }
  }
  for (const row of db.prepare('SELECT * FROM claim_unresolved').all()) {
    if (!has(db, 'claim_extractions', 'extraction_id', row.extraction_id)) throw new Error('claim unresolved: missing extraction')
    if (!UNRESOLVED_STATES.has(row.resolution_state)) throw new Error(`claim unresolved: unknown resolution state ${row.resolution_state}`)
    requireNode(db, row.node_id, 'claim unresolved')
  }
  for (const row of db.prepare('SELECT * FROM claim_unresolved_candidates').all()) {
    if (!has(db, 'claim_unresolved', 'unresolved_key', row.unresolved_key) || !has(db, 'semantic_claims', 'semantic_key', row.candidate_semantic_key)) throw new Error('claim unresolved candidate: missing parent')
  }
  for (const row of db.prepare('SELECT * FROM claim_unresolved_evidence').all()) {
    if (!has(db, 'claim_unresolved', 'unresolved_key', row.unresolved_key) || !has(db, 'claim_evidence_bindings', 'binding_id', row.binding_id)) throw new Error('claim unresolved evidence: missing parent')
  }
  for (const row of db.prepare('SELECT * FROM claim_review_decisions').all()) {
    requireNode(db, row.subject_node_id, 'claim review decision subject')
    requireNode(db, row.node_id, 'claim review decision')
    const kind = nodeKind(db, row.subject_node_id)
    const assertion = db.prepare('SELECT decision_state FROM claim_assertions WHERE node_id=?').get(row.subject_node_id)
    const occurrence = db.prepare('SELECT state FROM claim_occurrences WHERE node_id=?').get(row.subject_node_id)
    const unresolved = db.prepare('SELECT resolution_state,blocks_obligations_json FROM claim_unresolved WHERE node_id=?').get(row.subject_node_id)
    const subjects = [assertion, occurrence, unresolved].filter(Boolean)
    if (subjects.length !== 1) throw new Error('claim review decision: subject must resolve to exactly one claim lifecycle object')
    if (assertion) {
      const transitions = { accept: 'accepted', reject: 'rejected', supersede: 'superseded', invalidate: 'invalidated' }
      if (transitions[row.decision] === undefined || assertion.decision_state !== transitions[row.decision]) {
        throw new Error('claim review decision: assertion decision does not authorize assertion transition')
      }
    } else if (occurrence) {
      const transitions = { contradict: 'contradicted', supersede: 'superseded', invalidate: 'invalidated' }
      if (transitions[row.decision] === undefined || occurrence.state !== transitions[row.decision]) {
        throw new Error('claim review decision: occurrence decision does not authorize occurrence transition')
      }
    } else if (unresolved) {
      const transitions = { resolve: 'resolved', waive: 'waived' }
      if (transitions[row.decision] === undefined || unresolved.resolution_state !== transitions[row.decision]) {
        throw new Error('claim review decision: unresolved decision does not authorize unresolved transition')
      }
      if (row.decision === 'waive') {
        if (row.reviewer_kind !== 'human' || typeof row.reviewer_id !== 'string' || !row.reviewer_id ||
            typeof row.rationale_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.rationale_hash) ||
            typeof row.policy_version !== 'string' || !row.policy_version) {
          throw new Error('claim review decision: waiver requires human reviewer identity, rationale hash, and policy version')
        }
        const waived = parseJsonArray(row.blocks_obligations_json, 'claim review decision waiver obligations')
        const blocked = parseJsonArray(unresolved.blocks_obligations_json, 'claim unresolved obligations')
        if (!exactArray([...waived].sort(), [...blocked].sort())) throw new Error('claim review decision: waiver obligations must exactly match unresolved blocker')
      }
    } else {
      throw new Error(`claim review decision: ${kind} cannot be a review subject`)
    }
  }
  for (const row of db.prepare('SELECT * FROM claim_relations').all()) {
    if (!RELATION_TYPES.has(row.relation_type)) throw new Error(`claim relation: unknown relation type ${row.relation_type}`)
    if (!has(db, 'claim_occurrences', 'claim_occurrence_id', row.source_occurrence_id) || !has(db, 'claim_occurrences', 'claim_occurrence_id', row.target_occurrence_id)) throw new Error('claim relation: missing occurrence parent')
    requireNode(db, row.node_id, 'claim relation')
    const decision = db.prepare(`
      SELECT d.decision,a.claim_occurrence_id FROM claim_review_decisions d
      JOIN claim_assertions a ON a.node_id=d.subject_node_id
      WHERE d.node_id=?
    `).get(row.decision_node_id)
    if (!decision || decision.decision !== 'accept' || ![row.source_occurrence_id, row.target_occurrence_id].includes(decision.claim_occurrence_id)) {
      throw new Error('claim relation: relation must be authorized by an accepting review of one related occurrence')
    }
  }
  for (const row of db.prepare('SELECT * FROM claim_source_revision_invalidations').all()) {
    if (!has(db, 'claim_occurrences', 'claim_occurrence_id', row.old_occurrence_id) ||
        !has(db, 'claim_origins', 'origin_id', row.old_origin_id) || !has(db, 'claim_origins', 'origin_id', row.new_origin_id)) {
      throw new Error('claim source revision invalidation: missing parent')
    }
    requireNode(db, row.decision_node_id, 'claim source revision invalidation decision')
    requireNode(db, row.node_id, 'claim source revision invalidation')
  }
  for (const row of db.prepare('SELECT * FROM claim_sets').all()) {
    if (!has(db, 'claim_origins', 'origin_id', row.origin_id)) throw new Error('claim set: missing origin')
    if (!['current', 'invalidated'].includes(row.state)) throw new Error(`claim set: unknown state ${row.state}`)
    requireNode(db, row.certificate_node_id, 'claim set certificate')
  }
  for (const row of db.prepare('SELECT * FROM claim_set_members').all()) {
    if (!has(db, 'claim_sets', 'claim_set_id', row.claim_set_id) || !has(db, 'claim_occurrences', 'claim_occurrence_id', row.claim_occurrence_id)) throw new Error('claim set member: missing parent')
    if (!['accepted', 'candidate'].includes(row.member_state)) throw new Error('claim set member: invalid state')
    const claimSet = db.prepare('SELECT origin_id FROM claim_sets WHERE claim_set_id=?').get(row.claim_set_id)
    const occurrence = db.prepare('SELECT origin_id FROM claim_occurrences WHERE claim_occurrence_id=?').get(row.claim_occurrence_id)
    if (claimSet.origin_id !== occurrence.origin_id) throw new Error('claim set member: origin mismatch')
  }
  for (const row of db.prepare('SELECT * FROM claim_set_unresolved').all()) {
    if (!has(db, 'claim_sets', 'claim_set_id', row.claim_set_id) || !has(db, 'claim_unresolved', 'unresolved_key', row.unresolved_key)) throw new Error('claim set unresolved: missing parent')
  }
  for (const set of db.prepare("SELECT * FROM claim_sets WHERE completeness_state='complete'").all()) {
    const checked = new Set(JSON.parse(set.obligations_checked_json))
    const blockers = db.prepare(`
      SELECT u.blocks_obligations_json FROM claim_set_unresolved su
      JOIN claim_unresolved u ON u.unresolved_key=su.unresolved_key
      WHERE su.claim_set_id=? AND u.resolution_state='open'
    `).all(set.claim_set_id)
    for (const blocker of blockers) for (const obligation of JSON.parse(blocker.blocks_obligations_json)) {
      if (checked.has(obligation)) throw new Error('claim set: complete projection has open blocking unresolved item')
    }
  }
  for (const row of db.prepare('SELECT * FROM representation_claim_coverage').all()) {
    if (!COVERAGE_STATES.has(row.coverage_state)) throw new Error(`representation coverage: unknown state ${row.coverage_state}`)
    if (!has(db, 'claim_sets', 'claim_set_id', row.claim_set_id) || !has(db, 'claim_occurrences', 'claim_occurrence_id', row.claim_occurrence_id)) throw new Error('representation coverage: missing parent')
    if (!db.prepare('SELECT 1 FROM claim_set_members WHERE claim_set_id=? AND claim_occurrence_id=?').get(row.claim_set_id, row.claim_occurrence_id)) throw new Error('representation coverage: occurrence is not a claim-set member')
    const claimSet = db.prepare('SELECT state FROM claim_sets WHERE claim_set_id=?').get(row.claim_set_id)
    const occurrence = db.prepare('SELECT state FROM claim_occurrences WHERE claim_occurrence_id=?').get(row.claim_occurrence_id)
    if ((claimSet.state !== 'current' || occurrence.state !== 'accepted') && row.coverage_state !== 'blocked') {
      throw new Error('representation coverage: stale claim authority must be blocked')
    }
    requireNode(db, row.representation_node_id, 'representation coverage')
    requireNode(db, row.construction_plan_node_id, 'representation coverage construction plan')
  }
}

function recomputeMechanicFacets(db) {
  if (!PROJECTION_TABLES.has('mechanic_claim_facets')) return
  db.exec('DELETE FROM mechanic_claim_facets')
  const rows = db.prepare(`
    SELECT o.claim_occurrence_id, s.adapter_id, s.proposition_json
    FROM claim_occurrences o JOIN semantic_claims s ON s.semantic_key=o.semantic_key
  `).all()
  for (const row of rows) {
    if (row.adapter_id !== MECHANIC_ADAPTER_ID) continue
    const proposition = JSON.parse(row.proposition_json)
    const facets = mechanicQueryFacets(proposition.value)
    immutableRow(db, 'mechanic_claim_facets', {
      claim_occurrence_id: row.claim_occurrence_id,
      ...facets,
      has_precondition: facets.has_precondition ? 1 : 0,
    })
  }
}

function projectionStore(db) {
  return {
    db,
    hasNode(nodeId) { return Boolean(db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(nodeId)) },
    transaction(callback) { return callback() },
  }
}

function rebuildRefs(db) {
  rebuildNodeAbilityRefs(projectionStore(db))
}

function aggregateRow(db, aggregateKind, aggregateId) {
  if (aggregateKind === 'run') return db.prepare('SELECT * FROM runs WHERE run_id=?').get(aggregateId)
  const table = GENERIC_TABLE_BY_KIND[aggregateKind]
  if (!table) throw new TypeError(`aggregate ${aggregateKind} has no projection table`)
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(aggregateId)
}

function createAggregate(db, event, row) {
  const { aggregate_kind: kind, aggregate_id: id } = event
  if (kind === 'run') {
    const value = { ...row, run_id: id }
    const outcome = transition(kind, value.state, event.event_type, event.payload)
    if (!['accepted', 'idempotent'].includes(outcome.classification)) throw new Error(`${event.event_type}: ${outcome.reason}`)
    upsertRow(db, 'runs', value)
    return
  }
  const table = GENERIC_TABLE_BY_KIND[kind]
  if (!table) throw new TypeError(`${event.event_type}: unsupported aggregate ${kind}`)
  const value = { ...row, id }
  const outcome = transition(kind, value.state, event.event_type, event.payload)
  if (!['accepted', 'idempotent'].includes(outcome.classification)) throw new Error(`${event.event_type}: ${outcome.reason}`)
  upsertRow(db, table, value)
}

function updateAggregate(db, event) {
  const current = aggregateRow(db, event.aggregate_kind, event.aggregate_id)
  if (!current) {
    if (!event.payload.row) throw new Error(`${event.event_type}: aggregate not found`)
    createAggregate(db, event, event.payload.row)
    return
  }
  const outcome = transition(event.aggregate_kind, current.state, event.event_type, event.payload)
  if (outcome.classification !== 'accepted') throw new Error(`${event.event_type}: ${outcome.reason}`)
  if (event.aggregate_kind === 'run') {
    const next = { ...current, ...(event.payload.row || {}), state: outcome.next_state }
    upsertRow(db, 'runs', next)
  } else {
    const table = GENERIC_TABLE_BY_KIND[event.aggregate_kind]
    const payload = JSON.parse(current.payload_json || '{}')
    const nextPayload = event.payload.projected_payload ? { ...payload, ...event.payload.projected_payload } : payload
    upsertRow(db, table, {
      ...current,
      state: outcome.next_state,
      node_id: event.node_id ?? event.payload.node_id ?? current.node_id,
      payload_json: canonicalJson(nextPayload),
    })
  }
  if (event.payload.rows) applyRows(db, event.payload.rows)
}

function assertExecutionIdentity(db, completion) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(completion.task_id)
  const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(completion.attempt_id)
  const lease = db.prepare('SELECT * FROM leases WHERE id=?').get(completion.lease_id)
  if (!task || !attempt || !lease) throw new Error('execution aggregate missing')
  const attemptPayload = JSON.parse(attempt.payload_json || '{}')
  const leasePayload = JSON.parse(lease.payload_json || '{}')
  if (task.run_id !== completion.run_id || attempt.run_id !== completion.run_id || lease.run_id !== completion.run_id) throw new Error('execution run mismatch')
  if (leasePayload.task_id !== task.id || leasePayload.attempt_id !== attempt.id) throw new Error('execution identity mismatch')
  if (completion.input_hash && (attemptPayload.input_hash !== completion.input_hash || leasePayload.input_hash !== completion.input_hash)) throw new Error('execution input hash mismatch')
  return { task, attempt, lease, attemptPayload, leasePayload }
}

function completeExecution(db, completion, nodeId) {
  const { task, attempt, lease } = assertExecutionIdentity(db, completion)
  for (const [kind, current, eventType] of [
    ['task', task.state, 'task-succeeded'],
    ['attempt', attempt.state, 'attempt-succeeded'],
    ['lease', lease.state, 'lease-released'],
  ]) {
    const outcome = transition(kind, current, eventType, {})
    if (outcome.classification !== 'accepted') throw new Error(`${eventType}: ${outcome.reason}`)
  }
  upsertRow(db, 'tasks', { ...task, state: 'succeeded', node_id: nodeId })
  upsertRow(db, 'attempts', { ...attempt, state: 'succeeded', node_id: nodeId })
  upsertRow(db, 'leases', { ...lease, state: 'released' })
}

function applyDomainEvent(db, event, { finalize_projection = true } = {}) {
  const { event_type: eventType, payload } = event
  if ([
    'source-snapshot-recorded',
    'claim-origin-recorded',
    'claim-origin-currentness-changed',
    'claim-candidate-imported',
    'claim-source-revision-recorded',
    'claim-extraction-recorded',
    'claim-review-recorded',
    'claim-relation-recorded',
    'claim-set-projected',
    'claim-dependencies-invalidated',
    'representation-coverage-recorded',
  ].includes(eventType)) {
    applyClaimEvent(db, event, { finalize_projection })
    return
  }
  if (eventType === 'projection-baseline-imported') {
    if (payload.schema_version !== SCHEMA_VERSION) throw new Error(`baseline schema version must be ${SCHEMA_VERSION}`)
    for (const table of [...REBUILDABLE_PROJECTION_TABLES].reverse()) db.exec(`DELETE FROM ${table}`)
    applyRows(db, payload.rows)
    if (finalize_projection) {
      recomputeMechanicFacets(db)
      if (PROJECTION_TABLES.has('claim_sets')) assertClaimRows(db)
    }
    return
  }
  if (eventType === 'repository-reconciled') {
    db.exec('DELETE FROM ability_catalog')
    applyRows(db, { ability_catalog: payload.catalog_rows || [] })
    return
  }
  if (eventType === 'registry-bootstrapped') {
    applyRows(db, payload.rows || {})
    if (payload.source_hash) db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('registry_bootstrap_hash',?)").run(payload.source_hash)
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('registry_writer_frozen','1')").run()
    if (payload.graph_projection) db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('registry_is_graph_projection','1')").run()
    return
  }
  if (eventType === 'legacy-observation-recorded') {
    applyRows(db, payload.rows || {})
    if (payload.marker) db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(payload.marker.key, payload.marker.value)
    return
  }
  if (eventType === 'workflow-output-sealed') {
    completeExecution(db, payload.completion, payload.output_node_id)
    return
  }
  if (eventType === 'source-formalization-recorded') {
    applyRows(db, payload.rows)
    completeExecution(db, payload.completion, payload.completion.output_node_id)
    return
  }
  if (eventType === 'construction-plan-recorded') {
    applyRows(db, payload.rows)
    return
  }
  if (eventType === 'shape-family-certified') {
    applyRows(db, { family_templates: [payload.template], family_instances: payload.instances })
    return
  }
  if (eventType === 'campaign-scope-expanded') {
    applyRows(db, {
      claims: payload.claims,
      tasks: payload.tasks,
      apply_transactions: [payload.apply_transaction],
    })
    return
  }
  if (eventType === 'describer-scope-checked') {
    if (payload.check) applyRows(db, { checks: [payload.check] })
    return
  }
  if (eventType === 'lease-heartbeat-lost') {
    const completion = { run_id: payload.run_id, task_id: payload.task_id, attempt_id: payload.attempt_id, lease_id: payload.lease_id, input_hash: payload.input_hash }
    const { attempt, lease, leasePayload } = assertExecutionIdentity(db, completion)
    const expired = Date.parse(payload.now) >= Date.parse(leasePayload.expires_at)
    const leaseEvent = expired ? 'lease-expired' : 'lease-superseded'
    const leaseOutcome = transition('lease', lease.state, leaseEvent, expired ? { now: payload.now, expires_at: leasePayload.expires_at } : {})
    const attemptOutcome = transition('attempt', attempt.state, 'attempt-stale', {})
    if (leaseOutcome.classification !== 'accepted' || attemptOutcome.classification !== 'accepted') throw new Error('heartbeat loss transition rejected')
    upsertRow(db, 'leases', { ...lease, state: leaseOutcome.next_state })
    upsertRow(db, 'attempts', { ...attempt, state: 'stale' })
    return
  }
  if (eventType === 'intake-completed') {
    updateAggregate(db, { ...event, event_type: 'run-completed', aggregate_kind: 'run', aggregate_id: payload.run_id })
    return
  }
  if (payload.rows) applyRows(db, payload.rows)
}

function eventRow(rows, table, key, value, eventType) {
  if (!rows[table]?.some(row => row[key] === value)) throw new Error(`${eventType}: immutable ${table} row is missing`)
}

function applyClaimEvent(db, event, { finalize_projection = true } = {}) {
  const rows = event.payload.rows
  if (!rows || Object.getPrototypeOf(rows) !== Object.prototype) throw new TypeError(`${event.event_type}: rows required`)
  const { event_type: eventType, payload } = event
  if (['claim-origin-recorded', 'claim-origin-currentness-changed', 'claim-candidate-imported', 'claim-source-revision-recorded'].includes(eventType) && payload.schema_version !== 5) {
    throw new Error(`${eventType}: projection schema version must be 5`)
  }
  if (eventType === 'source-snapshot-recorded') eventRow(rows, 'source_snapshots', 'id', payload.source_snapshot_id, eventType)
  if (eventType === 'claim-origin-recorded') {
    eventRow(rows, 'claim_origins', 'origin_id', payload.origin_id, eventType)
    if (Object.keys(rows).some(table => table !== 'claim_origins')) throw new Error(`${eventType}: owns only claim_origins`)
  }
  if (eventType === 'claim-origin-currentness-changed') {
    eventRow(rows, 'claim_origins', 'origin_id', payload.origin_id, eventType)
    if (Object.keys(rows).some(table => table !== 'claim_origins') || rows.claim_origins.length !== 1) throw new Error(`${eventType}: requires one origin replacement`)
    const prior = db.prepare('SELECT current_state FROM claim_origins WHERE origin_id=?').get(payload.origin_id)
    if (!prior || prior.current_state !== payload.from_state || rows.claim_origins[0].current_state !== payload.to_state) throw new Error(`${eventType}: stale origin transition`)
  }
  if (eventType === 'claim-candidate-imported') {
    eventRow(rows, 'claim_imports', 'import_id', payload.import_id, eventType)
    eventRow(rows, 'claim_sets', 'claim_set_id', payload.claim_set_id, eventType)
    const forbidden = ['claim_origins', 'claim_review_decisions', 'claim_relations', 'claim_source_revision_invalidations']
    if (forbidden.some(table => Object.hasOwn(rows, table))) throw new Error(`${eventType}: contains forbidden rows`)
  }
  if (eventType === 'claim-source-revision-recorded') {
    for (const invalidationId of payload.invalidation_ids) eventRow(rows, 'claim_source_revision_invalidations', 'invalidation_id', invalidationId, eventType)
    eventRow(rows, 'claim_origins', 'origin_id', payload.new_origin_id, eventType)
  }
  if (eventType === 'claim-extraction-recorded') {
    eventRow(rows, 'claim_extractions', 'extraction_id', payload.extraction_id, eventType)
  }
  if (eventType === 'claim-review-recorded') eventRow(rows, 'claim_review_decisions', 'decision_id', payload.decision_id, eventType)
  if (eventType === 'claim-relation-recorded') eventRow(rows, 'claim_relations', 'relation_id', payload.relation_id, eventType)
  if (eventType === 'claim-set-projected') eventRow(rows, 'claim_sets', 'claim_set_id', payload.claim_set_id, eventType)
  if (eventType === 'representation-coverage-recorded') {
    if (!rows.representation_claim_coverage?.some(row => row.representation_node_id === payload.representation_node_id && row.claim_set_id === payload.claim_set_id && row.claim_occurrence_id === payload.claim_occurrence_id)) {
      throw new Error(`${eventType}: immutable coverage row is missing`)
    }
  }
  if (eventType === 'claim-dependencies-invalidated') {
    requireNode(db, payload.invalidation_node_id, 'claim dependency invalidation')
    for (const nodeId of payload.invalidated_node_ids) requireNode(db, nodeId, 'claim dependency invalidation target')
    const invalidation = db.prepare('SELECT payload_json FROM nodes WHERE node_id=?').get(payload.invalidation_node_id)
    if (JSON.parse(invalidation.payload_json).reason === 'source-snapshot-changed') {
      const invalidatedOccurrences = payload.invalidated_node_ids.length ? db.prepare(`
        SELECT claim_occurrence_id FROM claim_occurrences WHERE node_id IN (${payload.invalidated_node_ids.map(() => '?').join(',')})
      `).all(...payload.invalidated_node_ids).map(row => row.claim_occurrence_id) : []
      const descendants = derivedDescendantOccurrenceIds(db, invalidatedOccurrences)
      for (const claimOccurrenceId of descendants) {
        const occurrence = db.prepare('SELECT state FROM claim_occurrences WHERE claim_occurrence_id=?').get(claimOccurrenceId)
        if (occurrence.state !== 'invalidated' && !(rows.claim_occurrences ?? []).some(row => row.claim_occurrence_id === claimOccurrenceId && row.state === 'invalidated')) {
          throw new Error('source snapshot invalidation: every derived descendant must become non-current')
        }
      }
      const memberClaimSetIds = invalidatedOccurrences.length ? db.prepare(`
        SELECT DISTINCT claim_set_id FROM claim_set_members WHERE claim_occurrence_id IN (${invalidatedOccurrences.map(() => '?').join(',')})
      `).all(...invalidatedOccurrences).map(row => row.claim_set_id) : []
      const scopedClaimSetIds = typeof payload.subject_ref === 'string' && payload.subject_ref
        ? db.prepare("SELECT claim_set_id FROM claim_sets WHERE subject_ref=? AND source_snapshot_id<>? AND state<>'invalidated'").all(payload.subject_ref, payload.source_snapshot_id).map(row => row.claim_set_id)
        : []
      const claimSetIds = [...new Set([...memberClaimSetIds, ...scopedClaimSetIds])]
      for (const claimSetId of claimSetIds) {
        if (!(rows.claim_sets ?? []).some(row => row.claim_set_id === claimSetId && row.state === 'invalidated')) {
          throw new Error('source snapshot invalidation: every dependent claim set must be invalidated')
        }
        const coverage = db.prepare('SELECT representation_node_id,claim_occurrence_id FROM representation_claim_coverage WHERE claim_set_id=?').all(claimSetId)
        for (const item of coverage) if (!(rows.representation_claim_coverage ?? []).some(row =>
          row.representation_node_id === item.representation_node_id && row.claim_set_id === claimSetId &&
          row.claim_occurrence_id === item.claim_occurrence_id && row.coverage_state === 'blocked')) {
          throw new Error('source snapshot invalidation: every dependent coverage row must be blocked')
        }
        const plans = db.prepare("SELECT id FROM construction_plans WHERE json_extract(payload_json, '$.claim_set_id')=? AND state NOT IN ('invalidated','refuted')").all(claimSetId)
        for (const plan of plans) if (!(rows.construction_plans ?? []).some(row => row.id === plan.id && row.state === 'invalidated')) {
          throw new Error('source snapshot invalidation: every dependent construction plan must be invalidated')
        }
        const certificateNodes = [
          db.prepare('SELECT certificate_node_id FROM claim_sets WHERE claim_set_id=?').get(claimSetId)?.certificate_node_id,
          ...coverage.map(item => item.representation_node_id),
        ].filter(Boolean)
        for (const nodeId of certificateNodes) {
          const certificate = db.prepare("SELECT id FROM certificates WHERE node_id=? AND state NOT IN ('invalidated','refuted')").get(nodeId)
          if (certificate && !(rows.certificates ?? []).some(row => row.id === certificate.id && row.state === 'invalidated')) {
            throw new Error('source snapshot invalidation: every dependent representation or claim-set certificate must be invalidated')
          }
        }
      }
    }
  }
  applyRows(db, rows)
  if (finalize_projection) {
    recomputeMechanicFacets(db)
    assertClaimRows(db)
  }
}

const NO_PROJECTION_EVENTS = new Set([
  'ability-evidence-certified',
  'ability-evidence-family-linked',
  'ability-evidence-identity-corrected',
  'ability-gap-recorded',
  'check-recorded',
  'construction-plan-parent-authorized',
  'family-instance-certified',
  'family-template-certified',
  'lineage-mismatch',
])

export const EVENT_REGISTRY = new Map([...EVENT_CONTRACTS].map(([eventType, contract]) => [
  `${eventType}@${contract.event_version}`,
  Object.freeze({ event_type: eventType, event_version: contract.event_version, affects_projection: !NO_PROJECTION_EVENTS.has(eventType) }),
]))

export function eventAffectsProjection(eventType, eventVersion = 1) {
  return EVENT_REGISTRY.get(`${eventType}@${eventVersion}`)?.affects_projection === true
}

function normalizedEvent(event) {
  const payload = event.payload ?? JSON.parse(event.payload_json || '{}')
  return { ...event, event_version: Number(event.event_version ?? 1), payload }
}

export function finalizeProjectionState(db) {
  recomputeMechanicFacets(db)
  if (PROJECTION_TABLES.has('claim_sets')) assertClaimRows(db)
  rebuildRefs(db)
}

export function rebuildProjectionReferences(db) {
  rebuildRefs(db)
}

export function applyEvent(db, rawEvent, { rebuild_refs = true, finalize_projection = true } = {}) {
  db.exec('SAVEPOINT reducer_event')
  try {
    const event = normalizedEvent(rawEvent)
    assertAllowedEvent(event.event_type, event.payload, event)
    const key = `${event.event_type}@${event.event_version}`
    if (!EVENT_REGISTRY.has(key)) throw new TypeError(`unregistered event: ${key}`)
    const registration = EVENT_REGISTRY.get(key)
    if (AGGREGATE_EVENTS[event.aggregate_kind]?.includes(event.event_type)) updateAggregate(db, event)
    else if (registration.affects_projection) applyDomainEvent(db, event, { finalize_projection })
    if (rebuild_refs) rebuildRefs(db)
    db.exec('RELEASE SAVEPOINT reducer_event')
    return event
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT reducer_event')
    db.exec('RELEASE SAVEPOINT reducer_event')
    throw error
  }
}

function insertGraphCore(db, graphCore) {
  if (!graphCore) return
  for (const row of graphCore.objects || []) db.prepare('INSERT OR IGNORE INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)')
    .run(row.node_id, row.content_hash, row.kind, row.relative_path, row.byte_hash)
  for (const row of graphCore.nodes || []) db.prepare('INSERT OR IGNORE INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)')
    .run(row.node_id, row.kind, row.producer_contract_version, row.payload_json)
  for (const row of graphCore.edges || []) db.prepare('INSERT OR IGNORE INTO edges(parent_node_id,child_node_id,edge_type,authorizes_reuse,metadata_json) VALUES (?,?,?,?,?)')
    .run(row.parent_node_id, row.child_node_id, row.edge_type, row.authorizes_reuse, row.metadata_json)
}

export function rebuildProjections(db, rawEvents, graphCore = null) {
  const events = rawEvents.map(normalizedEvent).sort((a, b) => Number(a.sequence) - Number(b.sequence))
  insertGraphCore(db, graphCore)
  for (const table of [...REBUILDABLE_PROJECTION_TABLES].reverse()) db.exec(`DELETE FROM ${table}`)
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event_type === 'projection-baseline-imported') {
      start = index
      break
    }
  }
  for (const event of events.slice(start)) {
    applyEvent(db, event, { rebuild_refs: false, finalize_projection: false })
  }
  const terminal = events.at(-1)
  if (terminal) db.prepare("INSERT OR REPLACE INTO progress(name,sequence,checksum) VALUES ('events',?,?)").run(Number(terminal.sequence), terminal.event_hash)
  finalizeProjectionState(db)
  return projectionChecksum(db)
}

function orderedRows(db, table) {
  const order = {
    runs: 'run_id',
    claims: 'faction_id,ability_id,run_id',
    progress: 'name',
    ability_catalog: 'faction_id,ability_id',
    node_ability_refs: 'node_id,faction_id,ability_id',
    claim_origins: 'origin_id',
    claim_imports: 'import_id',
    claim_extractions: 'extraction_id',
    semantic_claims: 'semantic_key',
    claim_occurrences: 'claim_occurrence_id',
    claim_evidence_bindings: 'binding_id',
    claim_assertions: 'assertion_id',
    claim_assertion_evidence: 'assertion_id,binding_id',
    claim_derivation_parents: 'assertion_id,ordinal,parent_claim_occurrence_id',
    claim_evidence_binding_parents: 'binding_id,ordinal,parent_claim_occurrence_id',
    claim_unresolved_candidates: 'unresolved_key,candidate_semantic_key',
    claim_unresolved_evidence: 'unresolved_key,binding_id',
    claim_unresolved: 'unresolved_key',
    claim_review_decisions: 'decision_id',
    claim_relations: 'relation_id',
    claim_source_revision_invalidations: 'invalidation_id',
    claim_sets: 'claim_set_id',
    claim_set_members: 'claim_set_id,claim_occurrence_id',
    claim_set_unresolved: 'claim_set_id,unresolved_key',
    mechanic_claim_facets: 'claim_occurrence_id',
    representation_claim_coverage: 'representation_node_id,claim_set_id,claim_occurrence_id',
  }[table]
  if (!order && NORMALIZED_CLAIM_TABLES.includes(table)) {
    throw new Error(`missing deterministic checksum order for normalized projection table: ${table}`)
  }
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order || 'id'}`).all()
}

export function projectionRows(db, { baseline = false } = {}) {
  const result = {}
  for (const table of REBUILDABLE_PROJECTION_TABLES) {
    result[table] = orderedRows(db, table).map(row => ({ ...row }))
  }
  return result
}

export function projectionChecksum(db) {
  return sha256(canonicalJson(projectionRows(db)))
}

export { TERMINAL_TASKS }
