import { canonicalJson, sha256 } from './canonical.js'
import { createExecutionEnvelope } from './workflow-lineage.js'

export const LEASE_TTL_MS = 600_000
export const HEARTBEAT_INTERVAL_MS = Math.min(60_000, LEASE_TTL_MS / 3)

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} required`)
  return value
}

function iso(value, name = 'now') {
  let timestamp
  if (value instanceof Date) timestamp = value.getTime()
  else if (typeof value === 'number') timestamp = value
  else timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} must be a valid timestamp`)
  return { timestamp, value: new Date(timestamp).toISOString() }
}

function taskId(runId, label) { return `${runId}:${label}` }
function taskPayload(row) { return JSON.parse(row.payload_json || '{}') }

function uniqueSorted(values, name) {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`)
  for (const value of values) requireString(value, `${name} entry`)
  if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${name}`)
  return [...values].sort()
}

function runRow(store, runId) {
  const row = store.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId)
  if (!row) throw new Error(`run not found: ${runId}`)
  return row
}

function dependencyRows(store, dependsOn) {
  if (!dependsOn.length) return []
  const get = store.db.prepare('SELECT * FROM tasks WHERE id=?')
  return dependsOn.map(function loadDependency(id) {
    const row = get.get(id)
    if (!row) throw new Error(`task dependency missing: ${id}`)
    return row
  })
}

function dependenciesSealed(store, dependsOn) {
  const rows = dependencyRows(store, dependsOn)
  return rows.every(row => row.state === 'succeeded' && typeof row.node_id === 'string' && store.hasNode(row.node_id))
}

function collectNodeIds(value, result) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectNodeIds(item, result)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key.endsWith('_node_id') || key.endsWith('_node_ids')) && typeof child === 'string') {
      result.add(child)
    } else if (key.endsWith('_node_ids') && Array.isArray(child)) {
      for (const nodeId of child) if (typeof nodeId === 'string') result.add(nodeId)
    } else {
      collectNodeIds(child, result)
    }
  }
}

function authorizedInputNodes(store, runId) {
  const allowed = new Set()
  for (const row of store.db.prepare('SELECT payload_json FROM events WHERE aggregate_id=? ORDER BY sequence').all(runId)) {
    collectNodeIds(JSON.parse(row.payload_json || '{}'), allowed)
  }
  for (const row of store.db.prepare("SELECT node_id FROM tasks WHERE run_id=? AND state='succeeded' AND node_id IS NOT NULL").all(runId)) allowed.add(row.node_id)
  for (const table of ['construction_plans', 'family_templates', 'family_instances']) {
    for (const row of store.db.prepare(`SELECT node_id,payload_json FROM ${table} WHERE run_id=? AND node_id IS NOT NULL`).all(runId)) {
      allowed.add(row.node_id)
      const payload = JSON.parse(row.payload_json || '{}')
      if (table === 'construction_plans') for (const parent of payload.selected_parents || []) {
        if (typeof parent === 'string') allowed.add(parent)
        else if (typeof parent?.node_id === 'string') allowed.add(parent.node_id)
      }
    }
  }
  return allowed
}

function validateExplicitInputs(store, runId, inputNodeIds) {
  const allowed = authorizedInputNodes(store, runId)
  for (const nodeId of inputNodeIds) {
    if (!store.hasNode(nodeId)) throw new Error(`foreign-input-node: ${nodeId}`)
    if (!allowed.has(nodeId)) throw new Error(`foreign-input-node: ${nodeId}`)
  }
}

export function ensureTask(store, { run_id, label, kind, depends_on = [], payload = {} }) {
  requireString(run_id, 'run_id')
  requireString(label, 'label')
  requireString(kind, 'kind')
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) throw new TypeError('task payload must be a plain object')
  const run = runRow(store, run_id)
  if (run.state === 'planned' && !label.startsWith('prioritize:')) throw new Error('planned run permits only prioritize tasks')
  if (run.state !== 'active' && run.state !== 'planned') throw new Error(`run is not schedulable: ${run.state}`)
  const dependencies = uniqueSorted(depends_on, 'depends_on')
  for (const dependency of dependencyRows(store, dependencies)) if (dependency.run_id !== run_id) throw new Error(`foreign task dependency: ${dependency.id}`)
  const id = taskId(run_id, label)
  const projectedPayload = { label, kind, depends_on: dependencies, payload }
  const existing = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
  if (existing) {
    if (existing.run_id !== run_id || canonicalJson(taskPayload(existing)) !== canonicalJson(projectedPayload)) throw new Error(`task definition changed: ${label}`)
    return { ...existing, payload: taskPayload(existing), created: false }
  }
  store.appendEvent('task-created', {
    row: { id, run_id, state: 'pending', payload: projectedPayload },
  }, { aggregate_kind: 'task', aggregate_id: id })
  if (dependenciesSealed(store, dependencies)) {
    store.appendEvent('task-ready', { expected_state: 'pending' }, { aggregate_kind: 'task', aggregate_id: id })
  }
  const row = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
  return { ...row, payload: taskPayload(row), created: true }
}

function maybeReady(store, row) {
  if (row.state !== 'pending') return row
  const payload = taskPayload(row)
  if (!dependenciesSealed(store, payload.depends_on || [])) return row
  store.appendEvent('task-ready', { expected_state: 'pending' }, { aggregate_kind: 'task', aggregate_id: row.id })
  return store.db.prepare('SELECT * FROM tasks WHERE id=?').get(row.id)
}

export function issueReadyTask(store, { run_id, label, now = Date.now(), input_node_ids = null }) {
  const run = runRow(store, run_id)
  if (run.state === 'planned' && !label.startsWith('prioritize:')) throw new Error('planned run permits only prioritize tasks')
  if (!['planned', 'active'].includes(run.state)) throw new Error(`run is not schedulable: ${run.state}`)
  const id = taskId(run_id, label)
  let task = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
  if (!task) throw new Error(`task not registered: ${label}`)
  task = maybeReady(store, task)
  if (task.state === 'pending') return { issued: false, reason: 'task-dependencies-unsealed', task_id: id }
  if (!['ready', 'running'].includes(task.state)) return { issued: false, reason: `task-${task.state}`, task_id: id }
  const activeAttempt = store.db.prepare("SELECT id FROM attempts WHERE run_id=? AND state IN ('allocated','running') AND json_extract(payload_json,'$.task_id')=?").get(run_id, id)
  const activeLease = store.db.prepare("SELECT id FROM leases WHERE run_id=? AND state IN ('allocated','active') AND json_extract(payload_json,'$.task_id')=?").get(run_id, id)
  if (activeAttempt || activeLease) return { issued: false, reason: 'task-attempt-active', task_id: id }
  const definition = taskPayload(task)
  const explicitInputs = uniqueSorted(
    input_node_ids === null ? definition.payload?.input_node_ids || [] : input_node_ids,
    'input_node_ids',
  )
  validateExplicitInputs(store, run_id, explicitInputs)
  const dependencies = dependencyRows(store, definition.depends_on || [])
  if (!dependencies.every(row => row.state === 'succeeded' && row.node_id && store.hasNode(row.node_id))) {
    return { issued: false, reason: 'task-dependencies-unsealed', task_id: id }
  }
  const inputNodeIds = [...new Set([...explicitInputs, ...dependencies.map(row => row.node_id)])].sort()
  const inputHash = sha256(canonicalJson({ task_id: id, task_payload: definition.payload, input_node_ids: inputNodeIds }))
  const attemptNumber = Number(store.db.prepare("SELECT count(*) AS n FROM attempts WHERE run_id=? AND json_extract(payload_json,'$.task_id')=?").get(run_id, id).n) + 1
  const attemptId = `${id}:attempt:${attemptNumber}`
  const leaseId = `${attemptId}:lease:1`
  const issuedAt = iso(now)
  const expiresAt = new Date(issuedAt.timestamp + LEASE_TTL_MS).toISOString()
  store.transaction(() => {
    if (task.state === 'ready') store.appendEvent('task-started', { expected_state: 'ready' }, { aggregate_kind: 'task', aggregate_id: id })
    store.appendEvent('attempt-allocated', {
      row: { id: attemptId, run_id, state: 'allocated', payload: { task_id: id, attempt_number: attemptNumber, input_hash: inputHash, input_node_ids: inputNodeIds } },
    }, { aggregate_kind: 'attempt', aggregate_id: attemptId })
    store.appendEvent('attempt-started', { expected_state: 'allocated' }, { aggregate_kind: 'attempt', aggregate_id: attemptId })
    store.appendEvent('lease-allocated', {
      row: { id: leaseId, run_id, state: 'allocated', payload: { task_id: id, attempt_id: attemptId, input_hash: inputHash, input_node_ids: inputNodeIds, issued_at: issuedAt.value, expires_at: expiresAt } },
    }, { aggregate_kind: 'lease', aggregate_id: leaseId })
    store.appendEvent('lease-activated', { expected_state: 'allocated' }, { aggregate_kind: 'lease', aggregate_id: leaseId })
  })
  return {
    issued: true,
    envelope: createExecutionEnvelope({
      run_id, task_id: id, attempt_id: attemptId, lease_id: leaseId,
      lease_expires_at: expiresAt, input_node_ids: inputNodeIds, input_hash: inputHash,
    }),
  }
}

export function assertActiveLease(store, envelope, now = Date.now()) {
  const current = store.db.prepare('SELECT * FROM leases WHERE id=? AND run_id=?').get(envelope.lease_id, envelope.run_id)
  if (!current || current.state !== 'active') throw new Error('active graph lease mismatch')
  const payload = JSON.parse(current.payload_json || '{}')
  if (payload.task_id !== envelope.task_id || payload.attempt_id !== envelope.attempt_id || payload.input_hash !== envelope.input_hash) throw new Error('active graph lease task, attempt, or input mismatch')
  const timestamp = iso(now).timestamp
  if (!Number.isFinite(Date.parse(payload.expires_at)) || Date.parse(payload.expires_at) <= timestamp) throw new Error('active graph lease expired or superseded')
  return { ...current, payload }
}

export function renewLease(store, { lease_id, attempt_id, input_hash, now = Date.now() }) {
  requireString(lease_id, 'lease_id')
  requireString(attempt_id, 'attempt_id')
  requireString(input_hash, 'input_hash')
  const lease = store.db.prepare('SELECT * FROM leases WHERE id=?').get(lease_id)
  if (!lease || lease.state !== 'active') throw new Error('lease is not active')
  const payload = JSON.parse(lease.payload_json || '{}')
  if (payload.attempt_id !== attempt_id || payload.input_hash !== input_hash) throw new Error('lease renewal identity mismatch')
  const current = iso(now)
  const expiresAt = new Date(current.timestamp + LEASE_TTL_MS).toISOString()
  if (Date.parse(expiresAt) <= Date.parse(payload.expires_at)) throw new Error('lease renewal must move expiry later')
  store.appendEvent('lease-renewed', {
    task_id: payload.task_id,
    attempt_id,
    input_hash,
    previous_expires_at: payload.expires_at,
    expires_at: expiresAt,
    renewed_at: current.value,
    projected_payload: { expires_at: expiresAt, renewed_at: current.value },
  }, { aggregate_kind: 'lease', aggregate_id: lease_id })
  return { lease_id, expires_at: expiresAt, input_hash }
}

export function completeTask(store, { envelope, output_node_id, now = Date.now() }) {
  requireString(output_node_id, 'output_node_id')
  if (!store.hasNode(output_node_id)) throw new Error(`missing output node: ${output_node_id}`)
  assertActiveLease(store, envelope, now)
  store.appendEvent('workflow-output-sealed', {
    run_id: envelope.run_id,
    task_id: envelope.task_id,
    output_node_id,
    completion: { ...envelope, output_node_id },
  }, { aggregate_kind: 'task', aggregate_id: envelope.task_id, node_id: output_node_id })
  return { task_id: envelope.task_id, output_node_id, state: 'succeeded' }
}

export function recordRetryableFailure(store, { envelope, reason, now = Date.now() }) {
  assertActiveLease(store, envelope, now)
  store.transaction(() => {
    store.appendEvent('attempt-retryable-failure', { expected_state: 'running', reason }, { aggregate_kind: 'attempt', aggregate_id: envelope.attempt_id })
    store.appendEvent('lease-released', { expected_state: 'active', reason }, { aggregate_kind: 'lease', aggregate_id: envelope.lease_id })
  })
  return { task_id: envelope.task_id, state: 'running', retryable: true }
}

export function loseHeartbeat(store, { envelope, reason, now = Date.now() }) {
  const timestamp = iso(now).value
  store.appendEvent('lease-heartbeat-lost', {
    run_id: envelope.run_id,
    task_id: envelope.task_id,
    attempt_id: envelope.attempt_id,
    lease_id: envelope.lease_id,
    input_hash: envelope.input_hash,
    now: timestamp,
    reason,
  }, { aggregate_kind: 'lease', aggregate_id: envelope.lease_id })
  return { task_id: envelope.task_id, state: 'running', stale: true }
}

export function failTask(store, { run_id, label, reason, now = Date.now() }) {
  const id = taskId(run_id, label)
  const task = store.db.prepare('SELECT * FROM tasks WHERE id=? AND run_id=?').get(id, run_id)
  if (!task) throw new Error(`task not found: ${label}`)
  const timestamp = iso(now).value
  store.transaction(() => {
    const attempt = store.db.prepare("SELECT * FROM attempts WHERE run_id=? AND state IN ('allocated','running','retryable-failure') AND json_extract(payload_json,'$.task_id')=? ORDER BY id DESC LIMIT 1").get(run_id, id)
    if (attempt && attempt.state !== 'failed-final') store.appendEvent('attempt-failed-final', { expected_state: attempt.state, reason, at: timestamp }, { aggregate_kind: 'attempt', aggregate_id: attempt.id })
    const lease = store.db.prepare("SELECT * FROM leases WHERE run_id=? AND state IN ('allocated','active') AND json_extract(payload_json,'$.task_id')=? ORDER BY id DESC LIMIT 1").get(run_id, id)
    if (lease) store.appendEvent('lease-released', { expected_state: lease.state, reason, at: timestamp }, { aggregate_kind: 'lease', aggregate_id: lease.id })
    store.appendEvent('task-failed-final', { expected_state: task.state, reason, at: timestamp }, { aggregate_kind: 'task', aggregate_id: id })
  })
  return { task_id: id, state: 'failed-final' }
}
