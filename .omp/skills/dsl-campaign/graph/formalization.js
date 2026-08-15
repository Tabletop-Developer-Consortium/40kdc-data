import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { canonicalizeClaimAssertion, claimOccurrenceId, claimOriginId, claimSetId, claimSourceRevisionInvalidationId, classifyClaimRelation, evidenceBindingId, extractionId, independenceGroupId, projectClaimSet, semanticKey, unresolvedKey } from './claims.js'
import { mechanicClaimAdapter, mechanicQueryFacets } from './mechanic-claims.js'
import { assertActiveLease, completeTask, recordRetryableFailure } from './scheduler.js'

const SOURCE_KINDS = new Set(['pdf', 'game-datacards', 'json', 'mfm'])
const EDITIONS = new Set(['10e', '11e'])
const PHASES = new Set(['command', 'movement', 'shooting', 'charge', 'fight'])
const HASH = /^[a-f0-9]{64}$/
const frozenSources = new WeakMap()

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} required`)
  return value.trim()
}

function hash(value, name) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(`${name} must be sha256`)
  return value
}

export function canonicalSourceText(entry) {
  if (!entry || Object.getPrototypeOf(entry) !== Object.prototype) throw new TypeError('source-unavailable')
  if (typeof entry.raw_text === 'string' && entry.raw_text.trim()) return entry.raw_text.trim()
  if (entry.ability_type !== 'stratagem') throw new TypeError('source-unavailable')
  const fields = ['when', 'target', 'effect']
  if (!fields.every(field => typeof entry[field] === 'string' && entry[field].trim())) throw new TypeError('source-unavailable')
  if (entry.restrictions !== undefined && typeof entry.restrictions !== 'string') throw new TypeError('source-unavailable')
  return [...fields, 'restrictions'].filter(field => typeof entry[field] === 'string' && entry[field].trim())
    .map(field => `${field.toUpperCase()}:\n${entry[field].trim()}`).join('\n\n')
}

function authoritativeEntry(rawStoreRoot, factionId, abilityId, storeKey) {
  const expectedKey = `${factionId}/${abilityId}`
  if (storeKey !== expectedKey) throw new Error(`source store key mismatch: expected ${expectedKey}`)
  const rows = JSON.parse(readFileSync(join(rawStoreRoot, `${factionId}.json`), 'utf8'))
  if (!Array.isArray(rows)) throw new TypeError('raw store faction file must be an array')
  const matches = rows.filter(entry => (entry.ability_id ?? entry.id) === abilityId)
  if (matches.length !== 1) throw new Error(`authoritative source entry count: ${matches.length}`)
  return matches[0]
}

export function resolveSourceBinding(rawStoreRoot, factionId, abilityId) {
  const entry = authoritativeEntry(rawStoreRoot, factionId, abilityId, `${factionId}/${abilityId}`)
  const text = canonicalSourceText(entry)
  return { store_key: `${factionId}/${abilityId}`, byte_hash: sha256(Buffer.from(text, 'utf8')) }
}

function sourceProvenance(entry) {
  const source = entry.source
  if (!source || Object.getPrototypeOf(source) !== Object.prototype) throw new TypeError('source provenance required')
  if (!SOURCE_KINDS.has(source.kind)) throw new TypeError(`unknown source kind: ${source.kind}`)
  if (typeof source.ref !== 'string' || !source.ref) throw new TypeError('source ref required')
  if (source.edition != null && !EDITIONS.has(source.edition)) throw new TypeError(`unknown source edition: ${source.edition}`)
  const phases = [...new Set((source.phases ?? []).map(phase => {
    const value = requiredString(phase, 'source phase').toLowerCase()
    if (!PHASES.has(value)) throw new TypeError(`unknown source phase: ${phase}`)
    return value
  }))].sort()
  return { kind: source.kind, locator_sha256: sha256(source.ref), ...(source.edition ? { edition: source.edition } : {}), phases }
}

function typedParents(parents) {
  if (!Array.isArray(parents)) throw new TypeError('parents must be an array')
  return parents.map(parent => typeof parent === 'string'
    ? { node_id: parent, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }
    : parent)
}

function withFailure(store, envelope, action) {
  try { return action() } catch (error) {
    if (envelope) {
      const lease = store.db.prepare('SELECT state FROM leases WHERE id=?').get(envelope.lease_id)
      if (lease?.state === 'active') recordRetryableFailure(store, { envelope, reason: 'invalid-formalization', now: Date.now() })
    }
    throw error
  }
}
function sameCompletedTask(store, envelope, outputNodeId) {
  const task = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(envelope?.task_id)
  if (!task || task.state !== 'succeeded') return false
  const attempt = store.db.prepare('SELECT * FROM attempts WHERE id=?').get(envelope.attempt_id)
  const lease = store.db.prepare('SELECT * FROM leases WHERE id=?').get(envelope.lease_id)
  const attemptPayload = attempt ? JSON.parse(attempt.payload_json || '{}') : {}
  const leasePayload = lease ? JSON.parse(lease.payload_json || '{}') : {}
  if (task.run_id !== envelope.run_id || task.node_id !== outputNodeId ||
      attempt?.run_id !== envelope.run_id || attempt?.state !== 'succeeded' ||
      lease?.run_id !== envelope.run_id || lease?.state !== 'released' ||
      attemptPayload.task_id !== envelope.task_id || leasePayload.task_id !== envelope.task_id ||
      leasePayload.attempt_id !== envelope.attempt_id ||
      attemptPayload.input_hash !== envelope.input_hash || leasePayload.input_hash !== envelope.input_hash) {
    throw new Error(`succeeded task output identity mismatch: ${canonicalJson({ task: { run_id: task.run_id, node_id: task.node_id }, expected: { run_id: envelope.run_id, node_id: outputNodeId, attempt_id: envelope.attempt_id, lease_id: envelope.lease_id, input_hash: envelope.input_hash }, attempt: attempt && { run_id: attempt.run_id, state: attempt.state, payload: attemptPayload }, lease: lease && { run_id: lease.run_id, state: lease.state, payload: leasePayload } })}`)
  }
  return true
}

function sourceCache(store) {
  let cache = frozenSources.get(store)
  if (!cache) { cache = new Map(); frozenSources.set(store, cache) }
  return cache
}

function nodePayload(store, nodeId, kind) {
  const row = store.db.prepare('SELECT kind,payload_json FROM nodes WHERE node_id=?').get(nodeId)
  if (!row || row.kind !== kind) throw new Error(`missing ${kind} node`)
  return JSON.parse(row.payload_json)
}

function sourceRow(store, sourceSnapshotNodeId) {
  const source = nodePayload(store, sourceSnapshotNodeId, 'source-snapshot')
  const row = store.db.prepare('SELECT id FROM source_snapshots WHERE id=?').get(source.source_snapshot_id)
  if (!row) throw new Error('source snapshot projection missing')
  return source
}

function frozenSourceBytes(store, source, rawStoreRoot) {
  const cached = sourceCache(store).get(source.source_snapshot_id)
  if (cached) return cached
  if (typeof rawStoreRoot !== 'string' || !rawStoreRoot) throw new Error('raw_store_root required to reload frozen source')
  const entry = authoritativeEntry(rawStoreRoot, source.faction_id, source.ability_id, source.store_key)
  const text = canonicalSourceText(entry)
  const bytes = Buffer.from(text, 'utf8')
  if (sha256(bytes) !== source.byte_hash) throw new Error('frozen source byte hash changed')
  const expected = sha256(canonicalJson({
    subject_ref: `ability:${source.faction_id}/${source.ability_id}`,
    store_key: source.store_key,
    byte_hash: source.byte_hash,
    provenance: sourceProvenance(entry),
  }))
  if (expected !== source.source_snapshot_id) throw new Error('frozen source snapshot identity changed')
  sourceCache(store).set(source.source_snapshot_id, bytes)
  return bytes
}

function exactSourceBinding(binding) {
  if (!binding || Object.getPrototypeOf(binding) !== Object.prototype) throw new TypeError('source binding required')
  if (Object.keys(binding).some(key => !['store_key', 'byte_hash'].includes(key))) throw new TypeError('source binding has unknown keys')
  return { store_key: requiredString(binding.store_key, 'source.store_key'), byte_hash: hash(binding.byte_hash, 'source.byte_hash') }
}

export function persistSourceSnapshot(store, input) {
  const { run_id, faction_id, ability_id, envelope, raw_store_root, source_binding, parents = envelope?.input_node_ids ?? [] } = input ?? {}
  return withFailure(store, envelope, () => {
    const binding = exactSourceBinding(source_binding)
    const entry = authoritativeEntry(raw_store_root, faction_id, ability_id, binding.store_key)
    const text = canonicalSourceText(entry)
    const byte_hash = sha256(Buffer.from(text, 'utf8'))
    if (binding.byte_hash !== byte_hash) throw new Error('source byte hash mismatch')
    const provenance = sourceProvenance(entry)
    const subject_ref = `ability:${faction_id}/${ability_id}`
    const source_snapshot_id = sha256(canonicalJson({ subject_ref, store_key: binding.store_key, byte_hash, provenance }))
    const existingProjection = store.db.prepare('SELECT 1 FROM source_snapshots WHERE id=?').get(source_snapshot_id)
    const existing = existingProjection
      ? store.db.prepare("SELECT node_id FROM nodes WHERE kind='source-snapshot' AND json_extract(payload_json,'$.source_snapshot_id')=? ORDER BY node_id LIMIT 1").get(source_snapshot_id)
      : null
    if (existing) {
      if (sameCompletedTask(store, envelope, existing.node_id)) return { source_snapshot_id, source_node_id: existing.node_id, idempotent: true }
      assertActiveLease(store, envelope, Date.now())
      completeTask(store, { envelope, output_node_id: existing.node_id })
      return { source_snapshot_id, source_node_id: existing.node_id, idempotent: true }
    }
    assertActiveLease(store, envelope, Date.now())
    let sourceNode
    store.transaction(() => {
      sourceNode = store.createNode({ kind: 'source-snapshot', payload: { source_snapshot_id, faction_id, ability_id, store_key: binding.store_key, provenance, byte_hash }, parents: typedParents(parents), source_texts: [text] })
      store.appendEvent('source-snapshot-recorded', {
        source_snapshot_id, source_node_id: sourceNode.node_id,
        rows: { source_snapshots: [{ id: source_snapshot_id, run_id: null, state: 'current', node_id: sourceNode.node_id, payload: sourceNode.payload }] },
      }, { aggregate_kind: 'projection', aggregate_id: source_snapshot_id, node_id: sourceNode.node_id })
      sourceCache(store).set(source_snapshot_id, Buffer.from(text, 'utf8'))
      completeTask(store, { envelope, output_node_id: sourceNode.node_id })
    })
    return { source_snapshot_id, source_node_id: sourceNode.node_id }
  })
}

function normalizeEvidence(assertion, originId, context, localToOccurrence = new Map()) {
  const raw = assertion.evidence_bindings ?? assertion.evidence ?? []
  if (!Array.isArray(raw)) throw new TypeError('assertion evidence_bindings must be an array')
  return raw.map(rawBinding => {
    if (!rawBinding || Object.getPrototypeOf(rawBinding) !== Object.prototype) throw new TypeError('evidence binding must be an object')
    let binding
    if (rawBinding.kind === 'source_span' || rawBinding.kind === 'structured_path' || rawBinding.kind === 'private_source_ref') {
      binding = { ...rawBinding, origin_id: originId }
      if (binding.kind === 'private_source_ref' && Object.hasOwn(binding, 'private_locator')) {
        binding.private_locator_hash = sha256(binding.private_locator)
        delete binding.private_locator
      }
    } else if (rawBinding.kind === 'derived_evidence') {
      const labels = rawBinding.derivation_local_parent_ids
      if (!Array.isArray(labels) || labels.length === 0 || labels.some(label => typeof label !== 'string' || !localToOccurrence.has(label))) throw new TypeError('derived evidence requires known derivation_local_parent_ids')
      binding = { kind: 'derived_evidence', parent_claim_occurrence_ids: labels.map(label => localToOccurrence.get(label)), derivation_rule_id: rawBinding.derivation_rule_id, derivation_rule_version: rawBinding.derivation_rule_version }
    } else {
      binding = rawBinding
    }
    return { binding, binding_id: evidenceBindingId(binding, { ...context, origin_id: originId, origin_kind: 'primary-source' }) }
  })
}

function resolveParents(assertions, localToOccurrence, acceptedByLocal = new Map()) {
  const edges = new Map()
  for (const assertion of assertions) {
    const labels = assertion.derivation_parent_labels ?? assertion.derivation_local_parents ?? []
    if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) throw new TypeError('derivation_parent_labels must be an array')
    edges.set(assertion.extraction_local_id, labels)
  }
  const visiting = new Set(); const visited = new Set()
  const visit = label => {
    if (visiting.has(label)) throw new TypeError('derivation cycle')
    if (visited.has(label)) return
    visiting.add(label)
    for (const parent of edges.get(label) ?? []) {
      if (edges.has(parent)) visit(parent)
      else if (!acceptedByLocal.has(parent)) throw new TypeError(`unknown derivation parent: ${parent}`)
    }
    visiting.delete(label)
    visited.add(label)
  }
  for (const label of edges.keys()) visit(label)
  return assertions.map(assertion => ({ ...assertion, derivation_parent_claim_occurrence_ids: (edges.get(assertion.extraction_local_id) ?? []).map(label => localToOccurrence.get(label) ?? acceptedByLocal.get(label)) }))
}

function identityFor(input, originId) {
  const supplied = input.extraction_identity
  if (!supplied || Object.getPrototypeOf(supplied) !== Object.prototype) throw new TypeError('extraction_identity required')
  const extractor_identity = supplied.extractor_identity ?? (supplied.model_and_prompt_identity && {
    kind: 'model',
    model_id: supplied.model_and_prompt_identity.model_id,
    prompt_sha256: supplied.model_and_prompt_identity.prompt_sha256,
    output_schema_sha256: supplied.model_and_prompt_identity.output_schema_sha256,
    agent_contract_id: supplied.model_and_prompt_identity.agent_contract_id,
  })
  if (extractor_identity?.kind !== 'model') throw new TypeError('primary source extraction requires model extractor identity')
  const identity = {
    origin_id: originId,
    extractor_contract_version: supplied.extractor_contract_version,
    formalization_policy_version: supplied.formalization_policy_version,
    normalization_version: supplied.normalization_version,
    extractor_implementation: supplied.extractor_implementation,
    extractor_identity,
    ordered_parent_evidence_ids: supplied.ordered_parent_evidence_ids ?? [],
    lineage_root_origin_ids: supplied.lineage_root_origin_ids ?? [],
  }
  return {
    identity,
    extraction_id: extractionId(identity),
    independence_group_id: independenceGroupId({ origin_id: originId, extractor_identity, lineage_root_origin_ids: [] }),
  }
}

function decisionId(assertionId, extractionIdValue) {
  return sha256(canonicalJson({ assertion_id: assertionId, extraction_id: extractionIdValue, reviewer_kind: 'validator', policy_version: '2', decision: 'accept' }))
}

function rowsForBinding(binding, bindingId, nodeId) {
  const base = { binding_id: bindingId, kind: binding.kind, origin_id: binding.origin_id ?? null, start_byte: null, end_byte: null, path_kind: null, path: null, private_locator_hash: null, locator_authority: null, derivation_rule_id: null, derivation_rule_version: null, node_id: nodeId }
  if (binding.kind === 'source_span') Object.assign(base, { start_byte: binding.start, end_byte: binding.end })
  if (binding.kind === 'structured_path') Object.assign(base, { path_kind: binding.path_kind, path: binding.path })
  if (binding.kind === 'private_source_ref') Object.assign(base, { private_locator_hash: binding.private_locator_hash, locator_authority: binding.locator_authority })
  if (binding.kind === 'derived_evidence') Object.assign(base, { derivation_rule_id: binding.derivation_rule_id, derivation_rule_version: String(binding.derivation_rule_version) })
  return base
}

function normalizeSignatures(signatures, assertionLabels) {
  if (!signatures || Object.getPrototypeOf(signatures) !== Object.prototype || !Object.hasOwn(signatures, 'aggregate') || !Array.isArray(signatures.assertions)) throw new TypeError('aggregate and assertion signatures required')
  canonicalJson(signatures.aggregate)
  const byLabel = new Map()
  for (const item of signatures.assertions) {
    const label = requiredString(item.extraction_local_id, 'signature.extraction_local_id')
    if (!assertionLabels.has(label) || byLabel.has(label)) throw new TypeError('assertion signature label is invalid')
    canonicalJson(item.signature)
    byLabel.set(label, item.signature)
  }
  if (byLabel.size !== assertionLabels.size) throw new TypeError('every assertion requires one signature')
  return { aggregate: signatures.aggregate, byLabel }
}

function assertionId({ extraction_id, extraction_local_id, claim_occurrence_id, evidence_binding_ids, derivation_parent_claim_occurrence_ids }) {
  return sha256(canonicalJson({ extraction_id, extraction_local_id, claim_occurrence_id, evidence_binding_ids_sorted: [...evidence_binding_ids].sort(), derivation_parent_claim_occurrence_ids_ordered: derivation_parent_claim_occurrence_ids }))
}
function occurrenceProjectionRow(row, state = row.state) {
  return { claim_occurrence_id: row.claim_occurrence_id, origin_id: row.origin_id, semantic_key: row.semantic_key, subject_ref: row.subject_ref, state, node_id: row.node_id }
}


function relationId({ source_occurrence_id, target_occurrence_id, relation_type, decision_node_id }) {
  return sha256(canonicalJson({ source_claim_occurrence_id: source_occurrence_id, target_claim_occurrence_id: target_occurrence_id, relation_type, decision_node_id }))
}

function extractionResult(store, extractionIdValue) {
  const row = store.db.prepare('SELECT node_id,origin_id FROM claim_extractions WHERE extraction_id=?').get(extractionIdValue)
  if (!row) return null
  const certificate = store.db.prepare("SELECT node_id,payload_json FROM nodes WHERE kind='claim-set-certificate' AND json_extract(payload_json,'$.extraction_id')=? ORDER BY node_id LIMIT 1").get(extractionIdValue)
  if (!certificate) throw new Error('idempotent extraction certificate is missing')
  const payload = JSON.parse(certificate.payload_json)
  return { extraction_id: extractionIdValue, claim_set_id: payload.claim_set_id, certificate_node_id: certificate.node_id, extraction_node_id: row.node_id, accepted_claim_occurrence_ids: payload.assertion_ids.map(id => store.db.prepare('SELECT claim_occurrence_id FROM claim_assertions WHERE assertion_id=?').get(id).claim_occurrence_id), idempotent: true }
}

export function reconcileClaimOrigins(store, { subject_ref, source_origin_id, source_occurrence_ids, candidate_claim_set_ids = [], policy_version = '1' }) {
  const current = source_occurrence_ids.map(id => {
    const row = store.db.prepare('SELECT o.*,s.proposition_json,s.polarity,s.modality FROM claim_occurrences o JOIN semantic_claims s USING(semantic_key) WHERE o.claim_occurrence_id=?').get(id)
    return { ...row, proposition: JSON.parse(row.proposition_json) }
  })
  const setFilter = candidate_claim_set_ids.length ? `AND cs.claim_set_id IN (${candidate_claim_set_ids.map(() => '?').join(',')})` : ''
  const prior = store.db.prepare(`
    SELECT DISTINCT o.*,s.proposition_json,s.polarity,s.modality
    FROM claim_occurrences o JOIN semantic_claims s USING(semantic_key)
    JOIN claim_set_members m USING(claim_occurrence_id) JOIN claim_sets cs USING(claim_set_id)
    WHERE o.subject_ref=? AND o.origin_id<>? ${setFilter}
    ORDER BY o.claim_occurrence_id
  `).all(subject_ref, source_origin_id, ...candidate_claim_set_ids).map(row => ({ ...row, proposition: JSON.parse(row.proposition_json) }))
  const comparisons = []
  for (const currentClaim of current) for (const priorClaim of prior) {
    const comparison = classifyClaimRelation(currentClaim, priorClaim, mechanicClaimAdapter)
    if (comparison) comparisons.push({ current: currentClaim, prior: priorClaim, ...comparison, policy_version })
  }
  return comparisons.sort((left, right) => left.prior.claim_occurrence_id.localeCompare(right.prior.claim_occurrence_id) || left.current.claim_occurrence_id.localeCompare(right.current.claim_occurrence_id) || left.relation_type.localeCompare(right.relation_type))
}

export function persistClaimExtraction(store, input) {
  const { faction_id, ability_id, envelope, source_snapshot_node_id, raw_store_root, adapter = mechanicClaimAdapter, assertions, unresolved = [], signatures, completeness, parents = envelope?.input_node_ids ?? [] } = input ?? {}
  return withFailure(store, envelope, () => {
    if (!Array.isArray(assertions) || !Array.isArray(unresolved)) throw new TypeError('assertions and unresolved must be arrays')
    if (completeness?.state === 'complete' && !['retrieve', 'represent'].every(obligation => completeness.obligations_checked?.includes(obligation))) {
      throw new TypeError('complete source formalization must check retrieve and represent')
    }
    if (assertions.some(item => Object.hasOwn(item ?? {}, 'claim_id'))) throw new TypeError('legacy claim_id is not supported')
    const source = sourceRow(store, source_snapshot_node_id)
    const subject_ref = `ability:${faction_id}/${ability_id}`
    if (source.faction_id !== faction_id || source.ability_id !== ability_id) throw new Error('source snapshot subject does not match extraction subject')
    const sourceBytes = frozenSourceBytes(store, source, raw_store_root)
    const originPayload = { subject_ref, origin_kind: 'primary-source', source_snapshot_id: source.source_snapshot_id }
    const origin_id = claimOriginId(originPayload)
    const extraction = identityFor(input, origin_id)
    const existing = extractionResult(store, extraction.extraction_id)
    if (existing) {
      if (sameCompletedTask(store, envelope, existing.certificate_node_id)) return existing
      assertActiveLease(store, envelope, Date.now())
      completeTask(store, { envelope, output_node_id: existing.certificate_node_id })
      return existing
    }
    assertActiveLease(store, envelope, Date.now())
    const labels = new Set()
    const preliminary = assertions.map(item => {
      if (!item || Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError('assertion must be an object')
      const extraction_local_id = requiredString(item.extraction_local_id, 'extraction_local_id')
      if (labels.has(extraction_local_id)) throw new TypeError(`duplicate extraction_local_id: ${extraction_local_id}`)
      labels.add(extraction_local_id)
      adapter.validateProposition?.(item.proposition)
      const semantic_key = semanticKey({ adapter_id: adapter.adapter_id, proposition: item.proposition, polarity: item.polarity, modality: item.modality }, adapter)
      const claim_occurrence_id = claimOccurrenceId({ origin_id, semantic_key })
      return { ...item, extraction_local_id, semantic_key, claim_occurrence_id }
    })
    const signatureSet = normalizeSignatures(signatures, labels)
    const localToOccurrence = new Map(preliminary.map(item => [item.extraction_local_id, item.claim_occurrence_id]))
    const acceptedParents = new Map(store.db.prepare(`
      SELECT a.extraction_local_id,a.claim_occurrence_id FROM claim_assertions a
      JOIN claim_occurrences o USING(claim_occurrence_id)
      WHERE o.subject_ref=? AND o.state='accepted'
    `).all(subject_ref).map(row => [row.extraction_local_id, row.claim_occurrence_id]))
    for (const [label, occurrence] of acceptedParents) if (!localToOccurrence.has(label)) localToOccurrence.set(label, occurrence)
    const evidenceContext = { source_bytes: sourceBytes, origin_id, origin_kind: 'primary-source', current_accepted_parent_ids: [...acceptedParents.values()] }
    const normalized = resolveParents(preliminary, localToOccurrence, acceptedParents).map(item => {
      const evidence = normalizeEvidence(item, origin_id, evidenceContext, localToOccurrence)
      const canonical = canonicalizeClaimAssertion({ extraction_local_id: item.extraction_local_id, proposition: item.proposition, polarity: item.polarity, modality: item.modality, evidence_binding_ids: evidence.map(entry => entry.binding_id), derivation_parent_claim_occurrence_ids: item.derivation_parent_claim_occurrence_ids }, adapter)
      const assertion_id = assertionId({ extraction_id: extraction.extraction_id, claim_occurrence_id: item.claim_occurrence_id, ...canonical })
      return { ...item, ...canonical, assertion_id, evidence }
    })
    const unresolvedNormalized = unresolved.map((item, index) => {
      const evidence = normalizeEvidence(item, origin_id, evidenceContext, localToOccurrence)
      const candidates = (item.candidate_local_labels ?? []).map(label => {
        const target = preliminary.find(assertion => assertion.extraction_local_id === label)
        if (!target) throw new TypeError(`unknown unresolved candidate: ${label}`)
        return target.semantic_key
      })
      const canonical_focus = item.canonical_focus ?? item.extraction_local_focus
      const candidate_semantic_keys = item.candidate_semantic_keys ?? candidates
      const unresolved_key = unresolvedKey({ origin_id, kind: item.kind, canonical_focus, candidate_semantic_keys, blocks_obligations: item.blocks_obligations })
      return { ...item, extraction_local_id: item.extraction_local_id ?? `unresolved-${index}`, canonical_focus, candidate_semantic_keys, unresolved_key, resolution_state: item.resolution_state ?? 'open', evidence }
    })
    const blockedSemanticKeys = new Set(unresolvedNormalized.filter(item => item.resolution_state === 'open' && ['ambiguous', 'contradictory'].includes(item.kind)).flatMap(item => item.candidate_semantic_keys))
    const existingAuthorities = new Map(store.db.prepare(`
      SELECT o.claim_occurrence_id,a.assertion_id,a.node_id,r.decision_id,r.node_id AS decision_node_id
      FROM claim_occurrences o
      JOIN claim_assertions a USING(claim_occurrence_id)
      JOIN claim_review_decisions r ON r.subject_node_id=a.node_id
      WHERE o.origin_id=? AND o.state='accepted' AND a.decision_state='accepted'
        AND r.decision='accept' AND r.reviewer_kind='validator'
      ORDER BY o.claim_occurrence_id,r.decision_id
    `).all(origin_id).map(row => [row.claim_occurrence_id, row]))
    const acceptedOccurrences = new Set()
    const acceptedAssertions = normalized.filter(item => {
      const eligibleEvidence = item.evidence.some(entry =>
        entry.binding.kind === 'source_span' ||
        (entry.binding.kind === 'structured_path' && originPayload.origin_kind === 'primary-source'))
      if (!eligibleEvidence || blockedSemanticKeys.has(item.semantic_key) || acceptedOccurrences.has(item.claim_occurrence_id) || existingAuthorities.has(item.claim_occurrence_id)) return false
      acceptedOccurrences.add(item.claim_occurrence_id)
      return true
    })
    const decisions = acceptedAssertions.map(item => ({ assertion_id: item.assertion_id, decision: 'accept' }))
    const finalProjection = projectClaimSet({
      subject_ref,
      origin_id,
      origin_kind: 'primary-source',
      adapter,
      extractions: [{ origin_id, extraction_id: extraction.extraction_id, extraction_identity: extraction.identity, evidence_context: evidenceContext, evidence_bindings: [...normalized.flatMap(item => item.evidence.map(entry => entry.binding)), ...unresolvedNormalized.flatMap(item => item.evidence.map(entry => entry.binding))], assertions: normalized, unresolved: unresolvedNormalized }],
      decisions,
      completeness,
    })
    for (const occurrenceId of existingAuthorities.keys()) {
      if (!normalized.some(item => item.claim_occurrence_id === occurrenceId)) continue
      if (!finalProjection.accepted_claim_occurrence_ids.includes(occurrenceId)) finalProjection.accepted_claim_occurrence_ids.push(occurrenceId)
      finalProjection.candidate_claim_occurrence_ids = finalProjection.candidate_claim_occurrence_ids.filter(id => id !== occurrenceId)
    }
    finalProjection.accepted_claim_occurrence_ids.sort()
    finalProjection.claim_set_id = claimSetId({
      subject_ref,
      origin_id,
      adapter_id: adapter.adapter_id,
      ontology_version: adapter.ontology_version,
      accepted_claim_occurrence_ids: finalProjection.accepted_claim_occurrence_ids,
      candidate_claim_occurrence_ids: finalProjection.candidate_claim_occurrence_ids,
      open_unresolved_keys: finalProjection.open_unresolved_keys,
      completeness: finalProjection.completeness,
    })
    let result
    store.transaction(() => {
      let originNode
      const existingOrigin = store.db.prepare('SELECT * FROM claim_origins WHERE origin_id=?').get(origin_id)
      if (existingOrigin) originNode = { node_id: existingOrigin.node_id }
      else {
        originNode = store.createNode({ kind: 'claim-origin', payload: { origin_id, ...originPayload, current_state: 'current' }, parents: [{ node_id: source_snapshot_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
        store.appendEvent('claim-origin-recorded', { schema_version: 5, origin_id, rows: { claim_origins: [{ origin_id, subject_ref, origin_kind: 'primary-source', artifact_node_id: null, content_sha256: null, source_snapshot_id: source.source_snapshot_id, current_state: 'current', node_id: originNode.node_id }] } }, { aggregate_kind: 'claim-origin', aggregate_id: origin_id, node_id: originNode.node_id })
      }
      const extractionNode = store.createNode({ kind: 'extraction-identity', payload: { extraction_id: extraction.extraction_id, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), identity: extraction.identity }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }, ...typedParents(parents)] })
      const semanticNodes = new Map()
      const occurrenceNodes = new Map()
      const bindingNodes = new Map()
      const assertionNodes = new Map()
      for (const item of normalized) {
        if (!store.db.prepare('SELECT 1 FROM semantic_claims WHERE semantic_key=?').get(item.semantic_key) && !semanticNodes.has(item.semantic_key)) semanticNodes.set(item.semantic_key, store.createNode({ kind: 'semantic-claim', payload: { semantic_key: item.semantic_key, adapter_id: adapter.adapter_id, proposition_schema_id: item.proposition.schema_id, proposition_schema_version: item.proposition.schema_version, identity_ontology_version: String(adapter.identity_ontology_version), polarity: item.polarity, modality: item.modality, proposition: item.proposition }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
        if (!store.db.prepare('SELECT 1 FROM claim_occurrences WHERE claim_occurrence_id=?').get(item.claim_occurrence_id) && !occurrenceNodes.has(item.claim_occurrence_id)) occurrenceNodes.set(item.claim_occurrence_id, store.createNode({ kind: 'claim-occurrence', payload: { claim_occurrence_id: item.claim_occurrence_id, origin_id, semantic_key: item.semantic_key, subject_ref, state: 'proposed' }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
        for (const entry of item.evidence) if (!store.db.prepare('SELECT 1 FROM claim_evidence_bindings WHERE binding_id=?').get(entry.binding_id) && !bindingNodes.has(entry.binding_id)) bindingNodes.set(entry.binding_id, store.createNode({ kind: 'claim-evidence-binding', payload: { binding_id: entry.binding_id, ...entry.binding }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
        assertionNodes.set(item.assertion_id, store.createNode({ kind: 'claim-assertion', payload: { assertion_id: item.assertion_id, extraction_id: extraction.extraction_id, extraction_local_id: item.extraction_local_id, claim_occurrence_id: item.claim_occurrence_id, decision_state: 'proposed', independence_group_id: extraction.independence_group_id, signature: { aggregate: signatureSet.aggregate, assertion: signatureSet.byLabel.get(item.extraction_local_id) }, evidence_binding_ids: item.evidence_binding_ids, derivation_parent_claim_occurrence_ids: item.derivation_parent_claim_occurrence_ids }, parents: [{ node_id: extractionNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
      }
      for (const item of unresolvedNormalized) for (const entry of item.evidence) if (!store.db.prepare('SELECT 1 FROM claim_evidence_bindings WHERE binding_id=?').get(entry.binding_id) && !bindingNodes.has(entry.binding_id)) bindingNodes.set(entry.binding_id, store.createNode({ kind: 'claim-evidence-binding', payload: { binding_id: entry.binding_id, ...entry.binding }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
      const unresolvedNodes = new Map(unresolvedNormalized.map(item => [item.unresolved_key, store.createNode({ kind: 'unresolved-item', payload: { unresolved_key: item.unresolved_key, extraction_id: extraction.extraction_id, extraction_local_id: item.extraction_local_id, extraction_local_focus: item.canonical_focus, kind: item.kind, evidence_binding_ids: item.evidence.map(entry => entry.binding_id), candidate_semantic_keys: item.candidate_semantic_keys, blocks_obligations: item.blocks_obligations, resolution_state: item.resolution_state }, parents: [{ node_id: extractionNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })]))
      const allEvidence = [...normalized.flatMap(item => item.evidence), ...unresolvedNormalized.flatMap(item => item.evidence)]
      const rows = {
        claim_extractions: [{ extraction_id: extraction.extraction_id, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), identity_json: canonicalJson(extraction.identity), node_id: extractionNode.node_id }],
        semantic_claims: [...semanticNodes].map(([semantic_key, node]) => { const item = normalized.find(value => value.semantic_key === semantic_key); return { semantic_key, adapter_id: adapter.adapter_id, proposition_schema_id: item.proposition.schema_id, proposition_schema_version: item.proposition.schema_version, identity_ontology_version: String(adapter.identity_ontology_version), polarity: item.polarity, modality: item.modality, proposition_json: canonicalJson(item.proposition), node_id: node.node_id } }),
        claim_occurrences: [...occurrenceNodes].map(([claim_occurrence_id, node]) => { const item = normalized.find(value => value.claim_occurrence_id === claim_occurrence_id); return { claim_occurrence_id, origin_id, semantic_key: item.semantic_key, subject_ref, state: 'proposed', node_id: node.node_id } }),
        claim_evidence_bindings: [...bindingNodes].map(([binding_id, node]) => { const entry = allEvidence.find(value => value.binding_id === binding_id); return rowsForBinding(entry.binding, binding_id, node.node_id) }),
        claim_assertions: normalized.map(item => ({ assertion_id: item.assertion_id, extraction_id: extraction.extraction_id, extraction_local_id: item.extraction_local_id, claim_occurrence_id: item.claim_occurrence_id, decision_state: 'proposed', independence_group_id: extraction.independence_group_id, node_id: assertionNodes.get(item.assertion_id).node_id })),
        claim_assertion_evidence: normalized.flatMap(item => item.evidence.map(entry => ({ assertion_id: item.assertion_id, binding_id: entry.binding_id }))),
        claim_derivation_parents: normalized.flatMap(item => item.derivation_parent_claim_occurrence_ids.map((parent_claim_occurrence_id, ordinal) => ({ assertion_id: item.assertion_id, parent_claim_occurrence_id, ordinal }))),
        claim_evidence_binding_parents: normalized.flatMap(item => item.evidence.filter(entry => entry.binding.kind === 'derived_evidence').flatMap(entry => entry.binding.parent_claim_occurrence_ids.map((parent_claim_occurrence_id, ordinal) => ({ binding_id: entry.binding_id, parent_claim_occurrence_id, ordinal })))),
        claim_unresolved: unresolvedNormalized.map(item => ({ unresolved_key: item.unresolved_key, extraction_id: extraction.extraction_id, kind: item.kind, focus_json: canonicalJson(item.canonical_focus), blocks_obligations_json: canonicalJson(item.blocks_obligations), resolution_state: item.resolution_state, node_id: unresolvedNodes.get(item.unresolved_key).node_id })),
        claim_unresolved_candidates: unresolvedNormalized.flatMap(item => item.candidate_semantic_keys.map(candidate_semantic_key => ({ unresolved_key: item.unresolved_key, candidate_semantic_key }))),
        claim_unresolved_evidence: unresolvedNormalized.flatMap(item => item.evidence.map(entry => ({ unresolved_key: item.unresolved_key, binding_id: entry.binding_id }))),
      }
      store.appendEvent('claim-extraction-recorded', { extraction_id: extraction.extraction_id, origin_id, rows }, { aggregate_kind: 'projection', aggregate_id: extraction.extraction_id, node_id: extractionNode.node_id })
      const reviewNodes = new Map()
      for (const item of acceptedAssertions.sort((a, b) => a.assertion_id.localeCompare(b.assertion_id))) {
        const node = store.createNode({ kind: 'claim-review-decision', payload: { decision_id: decisionId(item.assertion_id, extraction.extraction_id), subject_node_id: assertionNodes.get(item.assertion_id).node_id, decision: 'accept', reviewer_kind: 'validator', reviewer_id: 'source-evidence-validator', rationale_hash: sha256('eligible-current-primary-evidence'), policy_version: '2', blocks_obligations: [] }, parents: [{ node_id: assertionNodes.get(item.assertion_id).node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
        reviewNodes.set(item.assertion_id, node)
        const assertionRow = rows.claim_assertions.find(row => row.assertion_id === item.assertion_id)
        const occurrenceRow = rows.claim_occurrences.find(row => row.claim_occurrence_id === item.claim_occurrence_id) ?? store.db.prepare('SELECT * FROM claim_occurrences WHERE claim_occurrence_id=?').get(item.claim_occurrence_id)
        store.appendEvent('claim-review-recorded', { decision_id: node.payload.decision_id, subject_node_id: node.payload.subject_node_id, rows: { claim_assertions: [{ ...assertionRow, decision_state: 'accepted' }], claim_occurrences: [{ ...occurrenceRow, state: 'accepted' }], claim_review_decisions: [{ decision_id: node.payload.decision_id, subject_node_id: node.payload.subject_node_id, decision: 'accept', reviewer_kind: 'validator', reviewer_id: node.payload.reviewer_id, rationale_hash: node.payload.rationale_hash, policy_version: '2', blocks_obligations_json: canonicalJson([]), node_id: node.node_id }] } }, { aggregate_kind: 'projection', aggregate_id: node.payload.decision_id, node_id: node.node_id })
      }
      const authorityRows = [
        ...[...existingAuthorities.values()].filter(row => finalProjection.accepted_claim_occurrence_ids.includes(row.claim_occurrence_id)),
        ...acceptedAssertions.map(item => ({
          claim_occurrence_id: item.claim_occurrence_id,
          assertion_id: item.assertion_id,
          node_id: assertionNodes.get(item.assertion_id).node_id,
          decision_id: reviewNodes.get(item.assertion_id).payload.decision_id,
          decision_node_id: reviewNodes.get(item.assertion_id).node_id,
        })),
      ].sort((left, right) => left.assertion_id.localeCompare(right.assertion_id))
      const claimSetNode = store.createNode({ kind: 'claim-set', payload: { claim_set_id: finalProjection.claim_set_id, subject_ref, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), mechanic_signature: signatureSet.aggregate, accepted_claim_occurrence_ids: finalProjection.accepted_claim_occurrence_ids, candidate_claim_occurrence_ids: finalProjection.candidate_claim_occurrence_ids, open_unresolved_keys: finalProjection.open_unresolved_keys, completeness: finalProjection.completeness }, parents: [{ node_id: extractionNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
      const dependencyNodeIds = [...new Set([source_snapshot_node_id, originNode.node_id, extractionNode.node_id, claimSetNode.node_id, ...authorityRows.flatMap(row => [row.node_id, row.decision_node_id])])].sort()
      const certificateNode = store.createNode({ kind: 'claim-set-certificate', payload: { claim_set_id: finalProjection.claim_set_id, certificate_id: sha256(canonicalJson({ claim_set_id: finalProjection.claim_set_id, extraction_id: extraction.extraction_id, assertion_ids: authorityRows.map(row => row.assertion_id) })), extraction_id: extraction.extraction_id, extraction_node_id: extractionNode.node_id, claim_set_node_id: claimSetNode.node_id, mechanic_signature: signatureSet.aggregate, assertion_ids: authorityRows.map(row => row.assertion_id), assertion_node_ids: authorityRows.map(row => row.node_id).sort(), decision_ids: authorityRows.map(row => row.decision_id).sort(), review_decision_node_ids: authorityRows.map(row => row.decision_node_id).sort(), unresolved_keys: finalProjection.open_unresolved_keys, waiver_decision_node_ids: [], dependency_node_ids: dependencyNodeIds, status: 'current' }, parents: dependencyNodeIds.map(node_id => ({ node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} })) })
      store.appendEvent('claim-set-projected', { claim_set_id: finalProjection.claim_set_id, certificate_node_id: certificateNode.node_id, rows: { claim_sets: [{ claim_set_id: finalProjection.claim_set_id, subject_ref, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), completeness_state: finalProjection.completeness.state, obligations_checked_json: canonicalJson(finalProjection.completeness.obligations_checked), state: 'current', certificate_node_id: certificateNode.node_id }], claim_set_members: [...finalProjection.accepted_claim_occurrence_ids.map(claim_occurrence_id => ({ claim_set_id: finalProjection.claim_set_id, claim_occurrence_id, member_state: 'accepted' })), ...finalProjection.candidate_claim_occurrence_ids.filter(id => !finalProjection.accepted_claim_occurrence_ids.includes(id)).map(claim_occurrence_id => ({ claim_set_id: finalProjection.claim_set_id, claim_occurrence_id, member_state: 'candidate' }))], claim_set_unresolved: finalProjection.open_unresolved_keys.map(unresolved_key => ({ claim_set_id: finalProjection.claim_set_id, unresolved_key })) } }, { aggregate_kind: 'projection', aggregate_id: finalProjection.claim_set_id, node_id: certificateNode.node_id })

      const candidateSets = store.db.prepare("SELECT claim_set_id FROM claim_sets WHERE subject_ref=? AND origin_id<>? AND state='current'").all(subject_ref, origin_id).map(row => row.claim_set_id)
      const comparisons = reconcileClaimOrigins(store, { subject_ref, source_origin_id: origin_id, source_occurrence_ids: finalProjection.accepted_claim_occurrence_ids, candidate_claim_set_ids: candidateSets, policy_version: '1' })
      const sourceMayDisplace = finalProjection.completeness.state === 'complete' &&
        ['retrieve', 'represent'].every(obligation => finalProjection.completeness.obligations_checked.includes(obligation)) &&
        finalProjection.candidate_claim_occurrence_ids.length === 0 &&
        finalProjection.open_unresolved_keys.length === 0 &&
        finalProjection.accepted_claim_occurrence_ids.length > 0
      const relationRows = []
      const invalidationRows = []
      const classifierEvents = []
      const oldOrigins = new Map()
      if (sourceMayDisplace) {
        for (const row of store.db.prepare("SELECT * FROM claim_origins WHERE subject_ref=? AND origin_kind='primary-source' AND current_state='current' AND origin_id<>?").all(subject_ref, origin_id)) oldOrigins.set(row.origin_id, row)
      }
      for (const comparison of comparisons) {
        const authority = authorityRows.find(row => row.claim_occurrence_id === comparison.current.claim_occurrence_id)
        const review = authority ? { node_id: authority.decision_node_id } : null
        if (!review) continue
        if (comparison.relation_type === 'contradicts' && comparison.prior.state === 'proposed') {
          const decision_id = sha256(canonicalJson({ prior_occurrence_id: comparison.prior.claim_occurrence_id, current_occurrence_id: comparison.current.claim_occurrence_id, classifier: adapter.adapter_id, policy_version: '1', decision: 'contradict' }))
          const decision = store.createNode({ kind: 'claim-review-decision', payload: { decision_id, subject_node_id: comparison.prior.node_id, decision: 'contradict', reviewer_kind: 'validator', reviewer_id: adapter.adapter_id, rationale_hash: sha256(canonicalJson(comparison.comparison_context)), policy_version: '1', blocks_obligations: [] }, parents: [{ node_id: comparison.prior.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }, { node_id: review.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
          classifierEvents.push({ decision, prior: comparison.prior })
        }
        const relation_id = relationId({ source_occurrence_id: comparison.current.claim_occurrence_id, target_occurrence_id: comparison.prior.claim_occurrence_id, relation_type: comparison.relation_type, decision_node_id: review.node_id })
        if (!store.db.prepare('SELECT 1 FROM claim_relations WHERE relation_id=?').get(relation_id)) {
          const node = store.createNode({ kind: 'claim-relation', payload: { relation_id, source_claim_occurrence_id: comparison.current.claim_occurrence_id, target_claim_occurrence_id: comparison.prior.claim_occurrence_id, source_origin_id: origin_id, target_origin_id: comparison.prior.origin_id, relation_type: comparison.relation_type, comparison_context: comparison.comparison_context, decision_node_id: review.node_id }, parents: [{ node_id: comparison.current.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }, { node_id: comparison.prior.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }, { node_id: review.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
          relationRows.push({ relation_id, source_occurrence_id: comparison.current.claim_occurrence_id, target_occurrence_id: comparison.prior.claim_occurrence_id, relation_type: comparison.relation_type, decision_node_id: review.node_id, node_id: node.node_id })
        }
        const priorOrigin = sourceMayDisplace
          ? store.db.prepare("SELECT * FROM claim_origins WHERE origin_id=? AND origin_kind='primary-source' AND current_state='current'").get(comparison.prior.origin_id)
          : null
        if (priorOrigin && comparison.prior.state === 'accepted') oldOrigins.set(priorOrigin.origin_id, priorOrigin)
      }
      for (const item of classifierEvents.sort((a, b) => a.prior.claim_occurrence_id.localeCompare(b.prior.claim_occurrence_id))) {
        store.appendEvent('claim-review-recorded', { schema_version: 5, decision_id: item.decision.payload.decision_id, subject_node_id: item.prior.node_id, rows: { claim_review_decisions: [{ decision_id: item.decision.payload.decision_id, subject_node_id: item.prior.node_id, decision: 'contradict', reviewer_kind: 'validator', reviewer_id: adapter.adapter_id, rationale_hash: item.decision.payload.rationale_hash, policy_version: '1', blocks_obligations_json: canonicalJson([]), node_id: item.decision.node_id }], claim_occurrences: [occurrenceProjectionRow(item.prior, 'contradicted')] } }, { aggregate_kind: 'projection', aggregate_id: item.decision.payload.decision_id, node_id: item.decision.node_id })
      }
      const revisionDecision = store.createNode({ kind: 'decision', payload: { state: 'answered', decision: 'source-revision', subject_ref, new_origin_id: origin_id }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
      for (const oldOrigin of oldOrigins.values()) {
        const oldOccurrences = store.db.prepare("SELECT * FROM claim_occurrences WHERE origin_id=? AND state='accepted'").all(oldOrigin.origin_id)
        for (const oldOccurrence of oldOccurrences) {
          const invalidation_id = claimSourceRevisionInvalidationId({ old_occurrence_id: oldOccurrence.claim_occurrence_id, old_origin_id: oldOrigin.origin_id, new_origin_id: origin_id, decision_node_id: revisionDecision.node_id })
          const node = store.createNode({ kind: 'claim-source-revision-invalidation', payload: { invalidation_id, old_occurrence_id: oldOccurrence.claim_occurrence_id, old_origin_id: oldOrigin.origin_id, new_origin_id: origin_id, decision_node_id: revisionDecision.node_id }, parents: [{ node_id: oldOccurrence.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }, { node_id: revisionDecision.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
          invalidationRows.push({ invalidation_id, old_occurrence_id: oldOccurrence.claim_occurrence_id, old_origin_id: oldOrigin.origin_id, new_origin_id: origin_id, decision_node_id: revisionDecision.node_id, node_id: node.node_id })
        }
      }
      if (relationRows.length || invalidationRows.length || oldOrigins.size) {
        const oldOriginIds = [...oldOrigins.keys()].sort()
        const oldSets = oldOriginIds.flatMap(old_origin_id => store.db.prepare("SELECT * FROM claim_sets WHERE origin_id=? AND state='current'").all(old_origin_id))
        const oldOccurrences = oldOriginIds.flatMap(old_origin_id => store.db.prepare("SELECT * FROM claim_occurrences WHERE origin_id=? AND state='accepted'").all(old_origin_id))
        const coverages = oldSets.flatMap(set => store.db.prepare('SELECT * FROM representation_claim_coverage WHERE claim_set_id=?').all(set.claim_set_id))
        const plans = oldSets.flatMap(set => store.db.prepare("SELECT * FROM construction_plans WHERE json_extract(payload_json,'$.claim_set_id')=? AND state NOT IN ('invalidated','refuted')").all(set.claim_set_id))
        const certificateNodeIds = [...new Set([...oldSets.map(set => set.certificate_node_id), ...coverages.map(row => row.representation_node_id)])]
        const certificates = certificateNodeIds.length ? store.db.prepare(`SELECT * FROM certificates WHERE node_id IN (${certificateNodeIds.map(() => '?').join(',')}) AND state NOT IN ('invalidated','refuted')`).all(...certificateNodeIds) : []
        store.appendEvent('claim-source-revision-recorded', { schema_version: 5, subject_ref, new_origin_id: origin_id, old_origin_ids: oldOriginIds, relation_ids: relationRows.map(row => row.relation_id).sort(), invalidation_ids: invalidationRows.map(row => row.invalidation_id).sort(), rows: { claim_relations: relationRows, claim_source_revision_invalidations: invalidationRows, claim_occurrences: oldOccurrences.map(row => ({ ...row, state: 'invalidated' })), claim_sets: oldSets.map(row => ({ ...row, state: 'invalidated' })), certificates: certificates.map(row => ({ ...row, state: 'invalidated' })), construction_plans: plans.map(row => ({ ...row, state: 'invalidated' })), representation_claim_coverage: coverages.map(row => ({ ...row, coverage_state: 'blocked' })), claim_origins: [{ ...store.db.prepare('SELECT * FROM claim_origins WHERE origin_id=?').get(origin_id), current_state: 'current' }, ...oldOriginIds.map(id => ({ ...oldOrigins.get(id), current_state: 'stale' }))] } }, { aggregate_kind: 'claim-origin', aggregate_id: origin_id, node_id: revisionDecision.node_id })
      }
      completeTask(store, { envelope, output_node_id: certificateNode.node_id })
      result = { extraction_id: extraction.extraction_id, claim_set_id: finalProjection.claim_set_id, certificate_node_id: certificateNode.node_id, extraction_node_id: extractionNode.node_id, accepted_claim_occurrence_ids: finalProjection.accepted_claim_occurrence_ids, origin_id, idempotent: false }
    })
    return result
  })
}
