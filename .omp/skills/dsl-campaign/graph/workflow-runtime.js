import { GraphStore } from './store.js'
import { assertInputEnvelope, sealOutput } from './workflow-lineage.js'

function lineageSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['run_id', 'task_id', 'attempt_id', 'lease_id', 'lease_expires_at', 'input_node_ids', 'producer_contract_version'],
    properties: {
      run_id: { type: 'string' }, task_id: { type: 'string' }, attempt_id: { type: 'string' }, lease_id: { type: 'string' },
      lease_expires_at: { type: 'string' }, input_node_ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      producer_contract_version: { const: 1 },
    },
  }
}

function schemaWithLineage(schema) {
  return {
    ...schema,
    required: [...new Set([...(schema.required || []), '_lineage'])],
    properties: { ...(schema.properties || {}), _lineage: lineageSchema() },
  }
}
function omitEphemeral(value, keys) {
  if (Array.isArray(value)) return value.map(item => omitEphemeral(item, keys))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !keys.has(key))
    .map(([key, child]) => [key, omitEphemeral(child, keys)]))
}


function assertActiveLease(store, expected, timestamp) {
  const lease = store.db.prepare(`
    SELECT leases.payload_json
    FROM leases
    JOIN tasks ON tasks.id=? AND tasks.run_id=leases.run_id
    JOIN attempts ON attempts.id=? AND attempts.run_id=leases.run_id
    WHERE leases.id=? AND leases.run_id=? AND leases.state='active'
      AND tasks.state IN ('ready','running')
      AND attempts.state IN ('allocated','running')
  `).get(expected.task_id, expected.attempt_id, expected.lease_id, expected.run_id)
  if (!lease) throw new Error('active graph lease mismatch')
  const payload = JSON.parse(lease.payload_json || '{}')
  if (payload.task_id !== expected.task_id || payload.attempt_id !== expected.attempt_id) throw new Error('active graph lease task or attempt mismatch')
  const expiresAt = payload.lease_expires_at || payload.expires_at
  if (expiresAt !== expected.lease_expires_at || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= timestamp) {
    throw new Error('active graph lease expired or superseded')
  }
}

export function createTrustedAgent({ driverArgs, invokeAgent, now = () => Date.now() }) {
  if (!driverArgs || !driverArgs.execution_envelopes) throw new Error('execution_envelopes required for graph-backed workflow')
  if (!driverArgs.graph_root) throw new Error('graph_root required for graph-backed workflow')
  return async (prompt, options) => {
    const { graphSourceTexts = [], graphEphemeralKeys = [], ...agentOptions } = options
    const label = agentOptions?.label
    const expected = driverArgs.execution_envelopes[label]
    if (!expected) throw new Error(`missing graph-issued envelope for ${label}`)
    assertInputEnvelope(expected, null, { now: now() })
    const raw = await invokeAgent(
      `${prompt}\nReturn _lineage exactly as supplied; copied or altered lineage is invalid. _lineage:\n${JSON.stringify(expected)}`,
      { ...agentOptions, schema: schemaWithLineage(agentOptions.schema) },
    )
    if (!raw) return raw
    assertInputEnvelope(raw._lineage, expected, { now: now() })
    const { _lineage, ...payload } = raw
    const persistedPayload = omitEphemeral(payload, new Set(graphEphemeralKeys))
    const store = new GraphStore(driverArgs.graph_root)
    let sealed
    try {
      assertActiveLease(store, expected, now())
      sealed = sealOutput(agentOptions.agentType || 'agent', persistedPayload, _lineage, { expected, now: now(), source_texts: graphSourceTexts })
      const node = store.createNode(sealed)
      store.appendEvent('workflow-output-sealed', { run_id: expected.run_id, task_id: expected.task_id, output_node_id: node.node_id }, {
        node_id: node.node_id, aggregate_kind: 'task', aggregate_id: expected.task_id,
        projection: db => {
          db.prepare("UPDATE tasks SET state='succeeded',node_id=? WHERE id=?").run(node.node_id, expected.task_id)
          db.prepare("UPDATE attempts SET state='succeeded',node_id=? WHERE id=?").run(node.node_id, expected.attempt_id)
          db.prepare("UPDATE leases SET state='released' WHERE id=?").run(expected.lease_id)
        },
      })
    } finally {
      store.close()
    }
    return { ...payload, sealed_output_node_id: sealed.node_id }
  }
}
