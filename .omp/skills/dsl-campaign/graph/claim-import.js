import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { canonicalJson, nodeIdentity, sha256 } from './canonical.js'
import {
  canonicalizeClaimAssertion,
  claimOccurrenceId,
  claimOriginId,
  claimSetId,
  evidenceBindingId,
  extractionId,
  independenceGroupId,
  semanticKey,
  unresolvedKey,
} from './claims.js'
import { mapAbilityDslToCandidates } from './mechanic-claim-import.js'
import { buildMechanicRegistry, mechanicClaimAdapter } from './mechanic-claims.js'
import { PRODUCER_CONTRACT_VERSION } from './schema.js'

export const ABILITY_DSL_IMPORTER_CONTRACT = 'ability-dsl-candidate-v1'
export const LEGACY_IMPORTER_CONTRACT = 'legacy-candidate-v1'
export const STRUCTURED_REEXTRACTION_CONTRACT = 'structured-reextraction-v1'

function requiredString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} required`)
  return value
}

function hash(value, name) {
  requiredString(value, name)
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} must be sha256`)
  return value
}

function typedParents(parents) {
  if (!Array.isArray(parents) || parents.length === 0) throw new TypeError('artifact parents required')
  return parents.map(parent => typeof parent === 'string'
    ? { node_id: parent, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }
    : { node_id: parent.node_id, edge_type: parent.edge_type ?? 'derived_from', authorizes_reuse: false, metadata: parent.metadata ?? {} })
}

function predictedNodeId(kind, payload, parents) {
  return nodeIdentity({ kind, payload, input_node_ids: parents.map(parent => parent.node_id).sort(), producer_contract_version: PRODUCER_CONTRACT_VERSION }).node_id
}
function pointerToken(value) { return String(value).replaceAll('~', '~0').replaceAll('/', '~1') }

function safeGeneratedArtifact(row) {
  const string_hashes = {}
  const numeric_metadata = {}
  const walk = (value, pointer = '') => {
    if (typeof value === 'string') {
      string_hashes[pointer || '/'] = sha256(value)
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      numeric_metadata[pointer || '/'] = value
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}/${index}`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, `${pointer}/${pointerToken(key)}`)
    }
  }
  walk(row)
  return {
    faction_id: row.faction,
    ability_id: row.ability_id,
    content_sha256: sha256(canonicalJson(row)),
    string_hashes,
    numeric_metadata,
  }
}


export function snapshotClaimArtifact(store, { subject_ref, origin_kind, artifact_value, path, json_pointer, parents }) {
  requiredString(subject_ref, 'subject_ref')
  if (origin_kind === 'primary-source') throw new TypeError('artifact origin cannot be primary-source')
  const canonicalBytes = canonicalJson(artifact_value)
  const content_sha256 = sha256(canonicalBytes)
  const canonicalParents = typedParents(parents)
  for (const parent of canonicalParents) if (!store.hasNode(parent.node_id)) throw new Error(`missing artifact parent: ${parent.node_id}`)
  const artifact_payload = {
    subject_ref,
    origin_kind: requiredString(origin_kind, 'origin_kind'),
    content_sha256,
    ...(path === undefined ? {} : { path: requiredString(path, 'path') }),
    ...(json_pointer === undefined ? {} : { json_pointer }),
  }
  const artifact_node_id = predictedNodeId('claim-origin-artifact', artifact_payload, canonicalParents)
  const origin_payload = { subject_ref, origin_kind, artifact_node_id, content_sha256 }
  const origin_id = claimOriginId(origin_payload)
  return { origin_id, ...origin_payload, artifact_payload, artifact_parents: canonicalParents, artifact_value }
}

function assertionId({ extraction_id, extraction_local_id, claim_occurrence_id, evidence_binding_ids, derivation_parent_claim_occurrence_ids }) {
  return sha256(canonicalJson({
    extraction_id,
    extraction_local_id,
    claim_occurrence_id,
    evidence_binding_ids_sorted: [...evidence_binding_ids].sort(),
    derivation_parent_claim_occurrence_ids_ordered: derivation_parent_claim_occurrence_ids,
  }))
}

function rowsForBinding(binding, binding_id, node_id) {
  const row = { binding_id, kind: binding.kind, origin_id: binding.origin_id ?? null, start_byte: null, end_byte: null, path_kind: null, path: null, private_locator_hash: null, locator_authority: null, derivation_rule_id: null, derivation_rule_version: null, node_id }
  if (binding.kind === 'source_span') Object.assign(row, { start_byte: binding.start, end_byte: binding.end })
  if (binding.kind === 'structured_path') Object.assign(row, { path_kind: binding.path_kind, path: binding.path })
  if (binding.kind === 'private_source_ref') Object.assign(row, { private_locator_hash: binding.private_locator_hash, locator_authority: binding.locator_authority })
  if (binding.kind === 'derived_evidence') Object.assign(row, { derivation_rule_id: binding.derivation_rule_id, derivation_rule_version: String(binding.derivation_rule_version) })
  return row
}

function importId({ origin_id, importer_contract_version, adapter_id, registry_schema_sha256 }) {
  return sha256(canonicalJson({ origin_id, importer_contract_version, adapter_id, registry_schema_sha256 }))
}

export function persistCandidateImport(store, {
  origin,
  adapter = mechanicClaimAdapter,
  importer_contract_version,
  registry_schema_sha256,
  extractor_identity,
  lineage_root_origin_ids,
  assertions,
  unresolved = [],
  completeness,
  artifact_parents,
}) {
  const origin_id = hash(origin?.origin_id, 'origin.origin_id')
  requiredString(importer_contract_version, 'importer_contract_version')
  hash(registry_schema_sha256, 'registry_schema_sha256')
  if (claimOriginId({ subject_ref: origin.subject_ref, origin_kind: origin.origin_kind, artifact_node_id: origin.artifact_node_id, content_sha256: origin.content_sha256 }) !== origin_id) throw new Error('origin_id does not match origin payload')
  const import_id = importId({ origin_id, importer_contract_version, adapter_id: adapter.adapter_id, registry_schema_sha256 })
  const existing = store.db.prepare('SELECT * FROM claim_imports WHERE import_id=?').get(import_id)
  if (existing) return { import_id, origin_id, claim_set_id: existing.claim_set_id, idempotent: true }
  if (!Array.isArray(assertions) || !Array.isArray(unresolved)) throw new TypeError('assertions and unresolved must be arrays')

  const extraction_identity = {
    origin_id,
    extractor_contract_version: importer_contract_version,
    formalization_policy_version: '2',
    normalization_version: '1',
    extractor_implementation: extractor_identity.kind === 'legacy' ? 'legacy-claim-import' : 'deterministic-claim-import',
    extractor_identity,
    ordered_parent_evidence_ids: [],
    lineage_root_origin_ids,
  }
  const extraction_id = extractionId(extraction_identity)
  const independence_group_id = independenceGroupId({ origin_id, extractor_identity, lineage_root_origin_ids })
  const subject_ref = origin.subject_ref
  const normalizedAssertions = assertions.map(item => {
    adapter.validateProposition?.(item.proposition)
    const semantic_key = item.semantic_key
    const claim_occurrence_id = claimOccurrenceId({ origin_id, semantic_key })
    const evidence = (item.evidence ?? []).map(binding => ({ binding, binding_id: evidenceBindingId(binding, { origin_id, origin_kind: origin.origin_kind }) }))
    const canonical = canonicalizeClaimAssertion({
      extraction_local_id: item.extraction_local_id,
      proposition: item.proposition,
      polarity: item.polarity,
      modality: item.modality,
      evidence_binding_ids: evidence.map(entry => entry.binding_id),
      derivation_parent_claim_occurrence_ids: item.derivation_parent_claim_occurrence_ids ?? [],
    }, adapter)
    const assertion_id = assertionId({ extraction_id, claim_occurrence_id, ...canonical })
    return { ...item, ...canonical, semantic_key, claim_occurrence_id, evidence, assertion_id }
  })
  const unresolvedNormalized = unresolved.map((item, index) => {
    const canonical_focus = item.canonical_focus ?? { index }
    const candidate_semantic_keys = item.candidate_semantic_keys ?? []
    const unresolved_key = unresolvedKey({ origin_id, kind: item.kind, canonical_focus, candidate_semantic_keys, blocks_obligations: item.blocks_obligations })
    return { ...item, extraction_local_id: item.extraction_local_id ?? `unresolved-${index}`, canonical_focus, candidate_semantic_keys, unresolved_key, resolution_state: item.resolution_state ?? 'open', evidence: item.evidence ?? [] }
  })
  const candidateIds = [...new Set(normalizedAssertions.map(item => item.claim_occurrence_id))].sort()
  const openKeys = unresolvedNormalized.filter(item => item.resolution_state === 'open').map(item => item.unresolved_key).sort()
  const claim_set_id = claimSetId({ subject_ref, origin_id, adapter_id: adapter.adapter_id, ontology_version: adapter.ontology_version, accepted_claim_occurrence_ids: [], candidate_claim_occurrence_ids: candidateIds, open_unresolved_keys: openKeys, completeness })

  return store.transaction(() => {
    const artifactNode = store.createNode({ kind: 'claim-origin-artifact', payload: origin.artifact_payload, parents: artifact_parents ?? origin.artifact_parents })
    if (artifactNode.node_id !== origin.artifact_node_id) throw new Error('artifact node identity conflict')
    let originNode
    const existingOrigin = store.db.prepare('SELECT * FROM claim_origins WHERE origin_id=?').get(origin_id)
    if (!existingOrigin) {
      originNode = store.createNode({ kind: 'claim-origin', payload: { origin_id, subject_ref, origin_kind: origin.origin_kind, artifact_node_id: origin.artifact_node_id, content_sha256: origin.content_sha256, current_state: origin.origin_kind === 'historical-artifact' ? 'historical' : 'current' }, parents: [{ node_id: artifactNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
      const originRow = { origin_id, subject_ref, origin_kind: origin.origin_kind, artifact_node_id: origin.artifact_node_id, content_sha256: origin.content_sha256, source_snapshot_id: null, current_state: origin.origin_kind === 'historical-artifact' ? 'historical' : 'current', node_id: originNode.node_id }
      store.appendEvent('claim-origin-recorded', { schema_version: 5, origin_id, rows: { claim_origins: [originRow] } }, { aggregate_kind: 'claim-origin', aggregate_id: origin_id, node_id: originNode.node_id })
      if (origin.origin_kind === 'ability-dsl') {
        const prior = store.db.prepare("SELECT * FROM claim_origins WHERE subject_ref=? AND origin_kind='ability-dsl' AND current_state='current' AND origin_id<>? ORDER BY origin_id").all(subject_ref, origin_id)
        for (const row of prior) {
          const decision = store.createNode({ kind: 'decision', payload: { state: 'answered' }, parents: [
            { node_id: row.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} },
            { node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} },
          ] })
          store.appendEvent('claim-origin-currentness-changed', { schema_version: 5, origin_id: row.origin_id, from_state: 'current', to_state: 'historical', reason: 'artifact-content-changed', rows: { claim_origins: [{ ...row, current_state: 'historical' }] } }, { aggregate_kind: 'claim-origin', aggregate_id: row.origin_id, node_id: decision.node_id })
        }
      }
    } else {
      originNode = { node_id: existingOrigin.node_id }
    }

    const extractionNode = store.createNode({ kind: 'extraction-identity', payload: { extraction_id, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), identity: extraction_identity }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
    const semanticNodes = new Map()
    const occurrenceNodes = new Map()
    const bindingNodes = new Map()
    const assertionNodes = new Map()
    for (const item of normalizedAssertions) {
      const semanticExisting = store.db.prepare('SELECT node_id FROM semantic_claims WHERE semantic_key=?').get(item.semantic_key)
      if (!semanticExisting && !semanticNodes.has(item.semantic_key)) semanticNodes.set(item.semantic_key, store.createNode({ kind: 'semantic-claim', payload: { semantic_key: item.semantic_key, adapter_id: adapter.adapter_id, proposition_schema_id: item.proposition.schema_id, proposition_schema_version: item.proposition.schema_version, identity_ontology_version: String(adapter.identity_ontology_version), polarity: item.polarity, modality: item.modality, proposition: item.proposition }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
      if (!occurrenceNodes.has(item.claim_occurrence_id)) occurrenceNodes.set(item.claim_occurrence_id, store.createNode({ kind: 'claim-occurrence', payload: { claim_occurrence_id: item.claim_occurrence_id, origin_id, semantic_key: item.semantic_key, subject_ref, state: 'proposed' }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
      for (const entry of item.evidence) if (!bindingNodes.has(entry.binding_id)) bindingNodes.set(entry.binding_id, store.createNode({ kind: 'claim-evidence-binding', payload: { binding_id: entry.binding_id, ...entry.binding }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
      assertionNodes.set(item.assertion_id, store.createNode({ kind: 'claim-assertion', payload: { assertion_id: item.assertion_id, extraction_id, extraction_local_id: item.extraction_local_id, claim_occurrence_id: item.claim_occurrence_id, decision_state: 'proposed', independence_group_id, signature: { imported: true }, evidence_binding_ids: item.evidence.map(entry => entry.binding_id), derivation_parent_claim_occurrence_ids: item.derivation_parent_claim_occurrence_ids }, parents: [{ node_id: extractionNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }))
    }
    const unresolvedNodes = new Map(unresolvedNormalized.map(item => [item.unresolved_key, store.createNode({ kind: 'unresolved-item', payload: { unresolved_key: item.unresolved_key, extraction_id, extraction_local_id: item.extraction_local_id, extraction_local_focus: item.canonical_focus, kind: item.kind, evidence_binding_ids: [], candidate_semantic_keys: item.candidate_semantic_keys, blocks_obligations: item.blocks_obligations, resolution_state: item.resolution_state }, parents: [{ node_id: extractionNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })]))
    const claimSetNode = store.createNode({ kind: 'claim-set', payload: { claim_set_id, subject_ref, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), mechanic_signature: { imported: true }, accepted_claim_occurrence_ids: [], candidate_claim_occurrence_ids: candidateIds, open_unresolved_keys: openKeys, completeness }, parents: [{ node_id: extractionNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
    const importNode = store.createNode({ kind: 'claim-import', payload: { import_id, origin_id, importer_contract_version, registry_schema_sha256, claim_set_id }, parents: [{ node_id: claimSetNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
    const allEvidence = normalizedAssertions.flatMap(item => item.evidence)
    const rows = {
      claim_imports: [{ import_id, origin_id, importer_contract_version, registry_schema_sha256, claim_set_id, event_node_id: importNode.node_id }],
      claim_extractions: [{ extraction_id, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), identity_json: canonicalJson(extraction_identity), node_id: extractionNode.node_id }],
      semantic_claims: [...semanticNodes].map(([semantic_key, node]) => { const item = normalizedAssertions.find(value => value.semantic_key === semantic_key); return { semantic_key, adapter_id: adapter.adapter_id, proposition_schema_id: item.proposition.schema_id, proposition_schema_version: item.proposition.schema_version, identity_ontology_version: String(adapter.identity_ontology_version), polarity: item.polarity, modality: item.modality, proposition_json: canonicalJson(item.proposition), node_id: node.node_id } }),
      claim_occurrences: [...occurrenceNodes].map(([claim_occurrence_id, node]) => { const item = normalizedAssertions.find(value => value.claim_occurrence_id === claim_occurrence_id); return { claim_occurrence_id, origin_id, semantic_key: item.semantic_key, subject_ref, state: 'proposed', node_id: node.node_id } }),
      claim_evidence_bindings: [...bindingNodes].map(([binding_id, node]) => { const entry = allEvidence.find(value => value.binding_id === binding_id); return rowsForBinding(entry.binding, binding_id, node.node_id) }),
      claim_assertions: normalizedAssertions.map(item => ({ assertion_id: item.assertion_id, extraction_id, extraction_local_id: item.extraction_local_id, claim_occurrence_id: item.claim_occurrence_id, decision_state: 'proposed', independence_group_id, node_id: assertionNodes.get(item.assertion_id).node_id })),
      claim_assertion_evidence: normalizedAssertions.flatMap(item => item.evidence.map(entry => ({ assertion_id: item.assertion_id, binding_id: entry.binding_id }))),
      claim_derivation_parents: normalizedAssertions.flatMap(item => item.derivation_parent_claim_occurrence_ids.map((parent_claim_occurrence_id, ordinal) => ({ assertion_id: item.assertion_id, parent_claim_occurrence_id, ordinal }))),
      claim_unresolved: unresolvedNormalized.map(item => ({ unresolved_key: item.unresolved_key, extraction_id, kind: item.kind, focus_json: canonicalJson(item.canonical_focus), blocks_obligations_json: canonicalJson(item.blocks_obligations), resolution_state: item.resolution_state, node_id: unresolvedNodes.get(item.unresolved_key).node_id })),
      claim_unresolved_candidates: unresolvedNormalized.flatMap(item => item.candidate_semantic_keys.map(candidate_semantic_key => ({ unresolved_key: item.unresolved_key, candidate_semantic_key }))),
      claim_unresolved_evidence: [],
      claim_sets: [{ claim_set_id, subject_ref, origin_id, adapter_id: adapter.adapter_id, ontology_version: String(adapter.ontology_version), completeness_state: completeness.state, obligations_checked_json: canonicalJson(completeness.obligations_checked), state: 'current', certificate_node_id: claimSetNode.node_id }],
      claim_set_members: candidateIds.map(claim_occurrence_id => ({ claim_set_id, claim_occurrence_id, member_state: 'candidate' })),
      claim_set_unresolved: openKeys.map(unresolved_key => ({ claim_set_id, unresolved_key })),
    }
    store.appendEvent('claim-candidate-imported', { schema_version: 5, import_id, origin_id, claim_set_id, rows }, { aggregate_kind: 'claim-import', aggregate_id: import_id, node_id: importNode.node_id })
    return { import_id, origin_id, claim_set_id, extraction_id, candidate_claim_occurrence_ids: candidateIds, idempotent: false }
  })
}

export function importAbilityDslCandidates(store, { repo_root, repository_version_node_id, faction_id, file_path, record_index, ability, registry = buildMechanicRegistry() }) {
  const subject_ref = `ability:${faction_id}/${ability.ability_id}`
  const path = relative(resolve(repo_root), resolve(repo_root, file_path)).replaceAll('\\', '/')
  const pointer = `/${record_index}`
  const origin = snapshotClaimArtifact(store, { subject_ref, origin_kind: 'ability-dsl', artifact_value: ability, path, json_pointer: pointer, parents: [repository_version_node_id] })
  const mapped = mapAbilityDslToCandidates({ faction_id, ability, origin_id: origin.origin_id, registry, ability_pointer: pointer })
  const awaiting = { kind: 'awaiting_evidence', canonical_focus: { origin_id: origin.origin_id, reason: 'representation-candidate-requires-current-source' }, candidate_semantic_keys: [...new Set(mapped.assertions.map(item => item.semantic_key))], blocks_obligations: ['retrieve', 'represent'] }
  return persistCandidateImport(store, { origin, adapter: mechanicClaimAdapter, importer_contract_version: ABILITY_DSL_IMPORTER_CONTRACT, registry_schema_sha256: registry.registry_schema_sha256, extractor_identity: { kind: 'deterministic', implementation_id: 'ability-dsl-mapper', implementation_version: '1', input_schema_sha256: registry.registry_schema_sha256 }, lineage_root_origin_ids: [origin.origin_id], assertions: mapped.assertions, unresolved: [...mapped.unresolved, awaiting], completeness: { state: 'incomplete', obligations_checked: ['retrieve', 'represent'] }, artifact_parents: origin.artifact_parents })
}

function abilityFiles(repoRoot) {
  const base = join(repoRoot, 'data', 'enrichment')
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const path = join(base, entry.name, 'abilities.json')
    return existsSync(path) ? [{ faction_id: entry.name, path }] : []
  }).sort((left, right) => left.path.localeCompare(right.path))
}

function persistGeneratedObservation(store, { origin, source_origin_id, faction_id, ability_id, observation_type }) {
  const existing = store.db.prepare('SELECT node_id FROM claim_origins WHERE origin_id=?').get(origin.origin_id)
  let originNode = existing
  if (!originNode) {
    const artifactNode = store.createNode({ kind: 'claim-origin-artifact', payload: origin.artifact_payload, parents: origin.artifact_parents })
    const node = store.createNode({ kind: 'claim-origin', payload: { origin_id: origin.origin_id, subject_ref: origin.subject_ref, origin_kind: origin.origin_kind, artifact_node_id: origin.artifact_node_id, content_sha256: origin.content_sha256, current_state: 'current' }, parents: [{ node_id: artifactNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: { lineage_root_origin_id: source_origin_id } }] })
    const row = { origin_id: origin.origin_id, subject_ref: origin.subject_ref, origin_kind: origin.origin_kind, artifact_node_id: origin.artifact_node_id, content_sha256: origin.content_sha256, source_snapshot_id: null, current_state: 'current', node_id: node.node_id }
    store.appendEvent('claim-origin-recorded', { schema_version: 5, origin_id: origin.origin_id, rows: { claim_origins: [row] } }, { aggregate_kind: 'claim-origin', aggregate_id: origin.origin_id, node_id: node.node_id })
    originNode = node
  }
  const observationId = sha256(canonicalJson({ origin_id: origin.origin_id, source_origin_id, observation_type }))
  if (!store.db.prepare('SELECT 1 FROM legacy_observations WHERE id=?').get(observationId)) {
    const node = store.createNode({ kind: 'legacy-observation', payload: { campaign_id: 'claim-import', observation_type, status: 'observed', summary: `${observation_type} retained as a correlated non-authoritative observation.`, artifact_hashes: [origin.content_sha256], known_members: [`${faction_id}/${ability_id}`], unknown_count: 0, authorizes_reuse: false, reason: `shares lineage with ${source_origin_id}` }, parents: [{ node_id: originNode.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: { lineage_root_origin_id: source_origin_id } }] })
    store.appendEvent('legacy-observation-recorded', { rows: { legacy_observations: [{ id: observationId, run_id: null, state: 'recorded', node_id: node.node_id, payload_json: canonicalJson(node.payload) }] } }, { aggregate_kind: 'run', aggregate_id: observationId, node_id: node.node_id })
  }
  return { origin_id: origin.origin_id, idempotent: Boolean(existing) }
}

export function importGeneratedClaimObservations(store, { repo_root, repository_version_node_id, ability_origin_index = new Map() }) {
  const specs = [
    { file: join(repo_root, 'data', '_audit', 'phrasing.json'), field: 'rows', origin_kind: 'generated-render', observation_type: 'generated-render' },
    { file: join(repo_root, 'data', '_audit', 'coverage.json'), field: 'worklist', origin_kind: 'cruncher-projection', observation_type: 'cruncher-projection' },
  ]
  const results = []
  let skipped = 0
  for (const spec of specs) {
    if (!existsSync(spec.file)) continue
    const rows = JSON.parse(readFileSync(spec.file, 'utf8'))[spec.field] ?? []
    for (const [index, row] of rows.entries()) {
      const faction_id = row.faction
      const ability_id = row.ability_id
      const source = ability_origin_index.get(`${faction_id}/${ability_id}`)
      if (!source) { skipped += 1; continue }
      const subject_ref = `ability:${faction_id}/${ability_id}`
      const origin = snapshotClaimArtifact(store, { subject_ref, origin_kind: spec.origin_kind, artifact_value: safeGeneratedArtifact(row), path: relative(repo_root, spec.file).replaceAll('\\\\', '/'), json_pointer: `/${spec.field}/${index}`, parents: [repository_version_node_id, source.node_id] })
      results.push(persistGeneratedObservation(store, { origin, source_origin_id: source.origin_id, faction_id, ability_id, observation_type: spec.observation_type }))
    }
  }
  return { imported: results.filter(result => !result.idempotent).length, idempotent: results.filter(result => result.idempotent).length, skipped, results }
}

export function importLegacyClaimCandidates(store, { artifact_node_id, subject_ref, claims, claims_pointer = '/claims' }) {
  hash(artifact_node_id, 'artifact_node_id')
  if (!Array.isArray(claims)) throw new TypeError('legacy claims must be an array')
  const origin = snapshotClaimArtifact(store, { subject_ref, origin_kind: 'historical-artifact', artifact_value: claims, json_pointer: claims_pointer, parents: [artifact_node_id] })
  const parsed = []
  let unknown_count = 0
  for (const [index, claim] of claims.entries()) {
    if (!claim || Object.getPrototypeOf(claim) !== Object.prototype ||
        Object.keys(claim).sort().join(',') !== 'id,object,relation,subject' ||
        !['id', 'subject', 'relation', 'object'].every(key => typeof claim[key] === 'string')) {
      unknown_count += 1
      continue
    }
    const proposition = {
      schema_id: '40k.mechanic-claim',
      schema_version: '1',
      value: {
        predicate: 'mechanic.legacy.relational-assertion',
        arguments: [
          { role: 'affected-entity', value: claim.subject },
          { role: 'operation', value: claim.relation },
          { role: 'target', value: claim.object },
        ],
        qualifiers: [],
      },
    }
    const semantic_key = semanticKey({ adapter_id: mechanicClaimAdapter.adapter_id, proposition, polarity: 'affirms', modality: 'asserted' }, mechanicClaimAdapter)
    const itemPointer = `${claims_pointer}/${index}`
    parsed.push({
      extraction_local_id: claim.id,
      proposition,
      semantic_key,
      polarity: 'affirms',
      modality: 'asserted',
      evidence: ['', 'id', 'subject', 'relation', 'object'].map(field => ({
        kind: 'structured_path',
        origin_id: origin.origin_id,
        path_kind: 'json_pointer',
        path: field ? `${itemPointer}/${pointerToken(field)}` : itemPointer,
      })),
    })
  }
  const registry = buildMechanicRegistry()
  const result = persistCandidateImport(store, {
    origin,
    adapter: mechanicClaimAdapter,
    importer_contract_version: LEGACY_IMPORTER_CONTRACT,
    registry_schema_sha256: registry.registry_schema_sha256,
    extractor_identity: { kind: 'legacy', artifact_node_id, lineage_state: 'incomplete' },
    lineage_root_origin_ids: [origin.origin_id],
    assertions: parsed,
    unresolved: [{
      kind: 'awaiting_evidence',
      canonical_focus: { origin_id: origin.origin_id, lineage_state: 'incomplete', unknown_count },
      candidate_semantic_keys: parsed.map(item => item.semantic_key),
      blocks_obligations: ['retrieve', 'represent'],
    }],
    completeness: { state: 'incomplete', obligations_checked: ['retrieve', 'represent'] },
    artifact_parents: origin.artifact_parents,
  })
  const parsed_occurrence_ids = parsed.map(item => claimOccurrenceId({ origin_id: origin.origin_id, semantic_key: item.semantic_key })).sort()
  const observation_id = sha256(canonicalJson({ artifact_node_id, origin_id: origin.origin_id, claims_pointer, unknown_count, parsed_occurrence_ids }))
  if (!store.db.prepare('SELECT 1 FROM legacy_observations WHERE id=?').get(observation_id)) {
    const node = store.createNode({
      kind: 'legacy-observation',
      payload: {
        campaign_id: 'claim-import',
        observation_type: 'legacy-claim-candidates',
        status: unknown_count ? 'partial' : 'parsed',
        summary: 'Legacy relational assertions imported as non-authoritative candidates.',
        artifact_hashes: [origin.content_sha256],
        known_members: parsed_occurrence_ids,
        unknown_count,
        authorizes_reuse: false,
        reason: 'incomplete historical provenance',
      },
      parents: [{ node_id: artifact_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }],
    })
    store.appendEvent('legacy-observation-recorded', { rows: { legacy_observations: [{ id: observation_id, run_id: null, state: 'recorded', node_id: node.node_id, payload_json: canonicalJson(node.payload) }] } }, { aggregate_kind: 'run', aggregate_id: observation_id, node_id: node.node_id })
  }
  return { ...result, parsed: parsed.length, residuals: unknown_count, observation_id }
}
function persistResidualObservation(store, row, reason) {
  const payloadHash = sha256(row.payload_json)
  const observation_id = sha256(canonicalJson({ artifact_node_id: row.node_id, payload_sha256: payloadHash, reason }))
  if (store.db.prepare('SELECT 1 FROM legacy_observations WHERE id=?').get(observation_id)) return { observation_id, idempotent: true }
  const node = store.createNode({
    kind: 'legacy-observation',
    payload: {
      campaign_id: 'claim-import',
      observation_type: 'legacy-claim-residual',
      status: 'unparsed',
      summary: 'Historical claim artifact retained without inferred claim identity.',
      artifact_hashes: [payloadHash],
      known_members: [],
      unknown_count: 1,
      authorizes_reuse: false,
      reason,
    },
    parents: [{ node_id: row.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }],
  })
  store.appendEvent('legacy-observation-recorded', { rows: { legacy_observations: [{ id: observation_id, run_id: null, state: 'recorded', node_id: node.node_id, payload_json: canonicalJson(node.payload) }] } }, { aggregate_kind: 'run', aggregate_id: observation_id, node_id: node.node_id })
  return { observation_id, idempotent: false }
}


export function importExtantClaimCandidates(store, { repo_root, repository_version_node_id }) {
  return store.transaction(() => {
  const results = []
  const ability_origin_index = new Map()
  const registry = buildMechanicRegistry()
  for (const file of abilityFiles(repo_root)) {
    const records = JSON.parse(readFileSync(file.path, 'utf8'))
    for (const [record_index, ability] of records.entries()) {
      const result = importAbilityDslCandidates(store, { repo_root, repository_version_node_id, faction_id: file.faction_id, file_path: file.path, record_index, ability, registry })
      results.push(result)
      const originRow = store.db.prepare('SELECT node_id FROM claim_origins WHERE origin_id=?').get(result.origin_id)
      ability_origin_index.set(`${file.faction_id}/${ability.ability_id}`, { origin_id: result.origin_id, node_id: originRow.node_id })
    }
  }
  const legacyResults = []
  const residualResults = []
  for (const row of store.db.prepare("SELECT node_id,kind,payload_json FROM nodes WHERE kind IN ('source-formalization-certificate','workflow-output') ORDER BY node_id").all()) {
    const payload = JSON.parse(row.payload_json)
    const claims = Array.isArray(payload.claims) ? payload.claims : (Array.isArray(payload.result?.claims) ? payload.result.claims : null)
    if (!claims) {
      residualResults.push(persistResidualObservation(store, row, 'claim-array-unavailable'))
      continue
    }
    const factionId = payload.faction_id ?? payload.result?.faction_id
    const abilityId = payload.ability_id ?? payload.result?.ability_id
    const subject_ref = factionId && abilityId
      ? `ability:${factionId}/${abilityId}`
      : claims.find(item => item && typeof item.subject === 'string')?.subject
    if (typeof subject_ref !== 'string' || !subject_ref.startsWith('ability:')) {
      residualResults.push(persistResidualObservation(store, row, 'claim-subject-unrecoverable'))
      continue
    }
    legacyResults.push(importLegacyClaimCandidates(store, { artifact_node_id: row.node_id, subject_ref, claims, claims_pointer: Array.isArray(payload.claims) ? '/claims' : '/result/claims' }))
  }
  const generated = importGeneratedClaimObservations(store, { repo_root, repository_version_node_id, ability_origin_index })
  return {
    ability_dsl: { imported: results.filter(result => !result.idempotent).length, idempotent: results.filter(result => result.idempotent).length, results },
    legacy: {
      imported: legacyResults.filter(result => !result.idempotent).length,
      idempotent: legacyResults.filter(result => result.idempotent).length,
      parsed: legacyResults.reduce((sum, result) => sum + result.parsed, 0),
      residuals: legacyResults.reduce((sum, result) => sum + result.residuals, 0) + residualResults.length,
      residual_artifacts: {
        imported: residualResults.filter(result => !result.idempotent).length,
        idempotent: residualResults.filter(result => result.idempotent).length,
      },
      results: legacyResults,
    },
    generated,
  }
  })
}
