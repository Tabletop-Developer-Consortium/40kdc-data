import { canonicalJson, sha256 } from './canonical.js'
import { PRODUCER_CONTRACT_VERSION } from './schema.js'
import {
  assertActiveLease,
  completeTask,
  ensureTask,
  HEARTBEAT_INTERVAL_MS,
  issueReadyTask,
  loseHeartbeat,
  recordRetryableFailure,
  renewLease,
} from './scheduler.js'
import { GraphStore } from './store.js'
import { assertEnvelopeIdentity, assertInputEnvelope, sealOutput, trustedExecutionIdentity } from './workflow-lineage.js'

function lineageSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['run_id', 'task_id', 'attempt_id', 'lease_id', 'lease_expires_at', 'input_node_ids', 'input_hash', 'producer_contract_version'],
    properties: {
      run_id: { type: 'string' }, task_id: { type: 'string' }, attempt_id: { type: 'string' }, lease_id: { type: 'string' },
      lease_expires_at: { type: 'string' }, input_node_ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      input_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      producer_contract_version: { const: PRODUCER_CONTRACT_VERSION },
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

function dependencyTaskIds(runId, dependsOn) {
  if (!Array.isArray(dependsOn)) throw new TypeError('dependsOn must be an array')
  return dependsOn.map(label => label.startsWith(`${runId}:`) ? label : `${runId}:${label}`)
}

export function createTrustedAgent({
  driverArgs,
  invokeAgent,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  if (!driverArgs?.graph_root) throw new Error('graph_root required for graph-backed workflow')
  if (!driverArgs?.run_id) throw new Error('run_id required for graph-backed workflow')
  return async (prompt, options = {}) => {
    const {
      graphSourceTexts = [],
      graphEphemeralKeys = [],
      dependsOn = [],
      inputNodeIds = [],
      completion = 'sealed',
      taskPayload = {},
      taskKind = null,
      authoritative = false,
      modelId,
      promptId,
      promptVersion,
      agentContractId,
      sourceSnapshotId,
      orderedParentEvidenceNodeIds = inputNodeIds,
      ...agentOptions
    } = options
    const label = agentOptions.label
    if (typeof label !== 'string' || !label) throw new Error('scheduler label required')
    if (!['sealed', 'deferred'].includes(completion)) throw new TypeError(`unsupported completion mode: ${completion}`)
    if (typeof prompt !== 'string') throw new TypeError('prompt must be a string')
    const lineagePromptPrefix = `${prompt}\nReturn _lineage exactly as supplied; copied or altered lineage is invalid. _lineage:\n`
    const invokedSchema = schemaWithLineage(agentOptions.schema)
    if (authoritative) {
      trustedExecutionIdentity({
        source_snapshot_id: sourceSnapshotId,
        agent_contract_id: agentContractId,
        model_id: modelId,
        prompt_id: promptId,
        prompt_version: promptVersion,
        prompt_sha256: '0'.repeat(64),
        invoked_prompt_sha256: '0'.repeat(64),
        output_schema_sha256: '0'.repeat(64),
        ordered_parent_evidence_ids: orderedParentEvidenceNodeIds,
      })
    }
    const store = new GraphStore(driverArgs.graph_root)
    let envelope
    let executionIdentity = null
    let heartbeat
    let heartbeatError = null
    let raw
    let invocationError = null
    try {
      ensureTask(store, {
        run_id: driverArgs.run_id,
        label,
        kind: taskKind || agentOptions.agentType || 'agent',
        depends_on: dependencyTaskIds(driverArgs.run_id, dependsOn),
        payload: taskPayload,
      })
      const issued = issueReadyTask(store, {
        run_id: driverArgs.run_id,
        label,
        now: now(),
        input_node_ids: inputNodeIds,
      })
      if (!issued.issued) throw new Error(issued.reason)
      envelope = issued.envelope
      executionIdentity = authoritative
        ? trustedExecutionIdentity({
          source_snapshot_id: sourceSnapshotId,
          agent_contract_id: agentContractId,
          model_id: modelId,
          prompt_id: promptId,
          prompt_version: promptVersion,
          prompt_sha256: sha256(prompt),
          invoked_prompt_sha256: sha256(`${lineagePromptPrefix}${JSON.stringify(envelope)}`),
          output_schema_sha256: sha256(canonicalJson(invokedSchema)),
          ordered_parent_evidence_ids: orderedParentEvidenceNodeIds,
        })
        : null
      assertInputEnvelope(envelope, null, { now: now() })
      heartbeat = setIntervalFn(() => {
        if (heartbeatError) return
        try {
          renewLease(store, { lease_id: envelope.lease_id, attempt_id: envelope.attempt_id, input_hash: envelope.input_hash, now: now() })
        } catch (error) {
          heartbeatError = error
        }
      }, HEARTBEAT_INTERVAL_MS)
      try {
        raw = await invokeAgent(
          `${lineagePromptPrefix}${JSON.stringify(envelope)}`,
          { ...agentOptions, schema: invokedSchema },
        )
      } catch (error) {
        invocationError = error
      }
      if (heartbeatError) {
        loseHeartbeat(store, { envelope, reason: heartbeatError.message, now: now() })
        throw heartbeatError
      }
      if (invocationError || !raw) {
        recordRetryableFailure(store, { envelope, reason: invocationError?.message || 'null-agent-output', now: now() })
        if (invocationError) throw invocationError
        return null
      }
      assertEnvelopeIdentity(raw._lineage, envelope)
      assertActiveLease(store, envelope, now())
      const { _lineage, ...payload } = raw
      const persistedPayload = omitEphemeral(payload, new Set(graphEphemeralKeys))
      if (completion === 'deferred') {
        return {
          ...payload,
          execution_envelope: envelope,
          ...(executionIdentity ? { execution_identity: executionIdentity } : {}),
        }
      }
      const sealed = sealOutput(agentOptions.agentType || 'agent', persistedPayload, _lineage, {
        expected: envelope,
        source_texts: graphSourceTexts,
        ...(executionIdentity ? { execution_identity: executionIdentity } : {}),
      })
      const node = store.createNode({
        kind: sealed.kind,
        payload: sealed.payload,
        parents: sealed.parents,
        producer_contract_version: sealed.producer_contract_version,
        source_texts: graphSourceTexts,
      })
      completeTask(store, { envelope, output_node_id: node.node_id, now: now() })
      return {
        ...payload,
        sealed_output_node_id: node.node_id,
        ...(executionIdentity ? { execution_identity: executionIdentity } : {}),
      }
    } finally {
      if (heartbeat !== undefined) clearIntervalFn(heartbeat)
      store.close()
    }
  }
}
