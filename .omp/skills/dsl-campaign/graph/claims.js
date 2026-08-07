import { canonicalJson, sha256 } from './canonical.js'

const HASH = /^[a-f0-9]{64}$/
const POLARITIES = new Set(['affirms', 'denies'])
const MODALITIES = new Set(['asserted', 'conditional', 'permitted', 'required', 'possible'])
const UNRESOLVED_KINDS = new Set(['ambiguous', 'unsupported', 'contradictory', 'incomplete_source', 'ontology_gap', 'awaiting_evidence'])
const OCCURRENCE_STATES = new Set(['proposed', 'accepted', 'contradicted', 'superseded', 'invalidated'])
const UNRESOLVED_STATES = new Set(['open', 'resolved', 'waived'])
const RELATION_TYPES = new Set(['semantically_equivalent_to', 'specializes', 'generalizes', 'contradicts', 'supersedes'])
const DECISIONS = new Set(['accept', 'reject', 'contradict', 'supersede', 'invalidate', 'resolve', 'waive'])
const ORIGIN_KINDS = new Set(['primary-source', 'ability-dsl', 'generated-render', 'cruncher-projection', 'historical-artifact', 'review'])
const STRUCTURED_EVIDENCE_ORIGINS = new Set(['primary-source', 'ability-dsl', 'generated-render', 'cruncher-projection', 'historical-artifact'])
const EXTRACTOR_KINDS = new Set(['model', 'deterministic', 'legacy'])


function fail(message) {
  throw new TypeError(message)
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${name} must be a plain object`)
  return value
}

function exactKeys(value, keys, name) {
  object(value, name)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${name} has invalid fields`)
}

function string(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`)
  return value
}

function hash(value, name) {
  string(value, name)
  if (!HASH.test(value)) fail(`${name} must be a lowercase SHA-256 id`)
  return value
}

function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`)
  return value
}

function uniqueStrings(value, name, validator = string) {
  const values = array(value, name).map((item, index) => validator(item, `${name}[${index}]`))
  if (new Set(values).size !== values.length) fail(`${name} contains duplicates`)
  return values
}

function sorted(values) {
  return [...values].sort()
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function setHashes(value, name) {
  return sorted(uniqueStrings(value, name, hash))
}

function version(value, name) {
  if ((typeof value !== 'string' || value.length === 0) && (!Number.isInteger(value) || value < 1)) fail(`${name} must be a non-empty string or positive integer`)
  return value
}

function canonicalHash(value) {
  return sha256(canonicalJson(value))
}

function canonicalProposition(proposition, adapter) {
  exactKeys(proposition, ['schema_id', 'schema_version', 'value'], 'proposition')
  string(proposition.schema_id, 'proposition.schema_id')
  version(proposition.schema_version, 'proposition.schema_version')
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.canonicalizeProposition !== 'function') {
    fail('adapter.canonicalizeProposition is required')
  }
  if (typeof adapter.validateProposition === 'function') adapter.validateProposition(proposition)
  const canonical = adapter.canonicalizeProposition(proposition.value, proposition)
  const result = canonical !== null && typeof canonical === 'object' && !Array.isArray(canonical) &&
    Object.hasOwn(canonical, 'schema_id') && Object.hasOwn(canonical, 'schema_version') && Object.hasOwn(canonical, 'value')
    ? canonical
    : { ...proposition, value: canonical }
  exactKeys(result, ['schema_id', 'schema_version', 'value'], 'canonical proposition')
  string(result.schema_id, 'canonical proposition.schema_id')
  version(result.schema_version, 'canonical proposition.schema_version')
  canonicalJson(result.value)
  return result
}

function adapterId(adapter, supplied) {
  const id = supplied ?? adapter?.adapter_id
  string(id, 'adapter_id')
  if (adapter?.adapter_id !== undefined && adapter.adapter_id !== id) fail('adapter_id does not match adapter')
  return id
}

function identityOntologyVersion(adapter) {
  return version(adapter?.identity_ontology_version, 'adapter.identity_ontology_version')
}

function sourceBytes(context) {
  const bytes = context?.source_bytes
  if (bytes === undefined) return null
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8')
  if (bytes instanceof Uint8Array) return Buffer.from(bytes)
  fail('context.source_bytes must be a string or Uint8Array')
}

function utf8Boundary(bytes, offset) {
  return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80
}

function validateBindingOrigin(binding, context, allowedKinds) {
  if (context?.origin_id !== undefined && binding.origin_id !== context.origin_id) fail('evidence binding origin_id does not match context')
  const originKind = context?.origin_kind
  if (originKind !== undefined && !allowedKinds.has(originKind)) fail(`evidence binding is not valid for ${originKind}`)
}


function canonicalBinding(binding, context) {
  object(binding, 'evidence binding')
  switch (binding.kind) {
    case 'source_span': {
      exactKeys(binding, ['kind', 'origin_id', 'start', 'end', 'coordinate_unit'], 'source_span evidence binding')
      hash(binding.origin_id, 'source_span.origin_id')
      if (binding.coordinate_unit !== 'utf8_byte') fail('source_span.coordinate_unit must be utf8_byte')
      if (!Number.isInteger(binding.start) || !Number.isInteger(binding.end) || binding.start < 0 || binding.end <= binding.start) fail('source_span offsets must be a non-empty byte range')
      validateBindingOrigin(binding, context, new Set(['primary-source']))
      const bytes = sourceBytes(context)
      if (bytes !== null && (binding.end > bytes.length || !utf8Boundary(bytes, binding.start) || !utf8Boundary(bytes, binding.end))) fail('source_span offsets must be UTF-8 boundaries')
      return binding
    }
    case 'structured_path': {
      exactKeys(binding, ['kind', 'origin_id', 'path_kind', 'path'], 'structured_path evidence binding')
      hash(binding.origin_id, 'structured_path.origin_id')
      if (binding.path_kind !== 'json_pointer') fail('structured_path.path_kind must be json_pointer')
      if (typeof binding.path !== 'string' || (binding.path !== '' && (!binding.path.startsWith('/') || /~(?:[^01]|$)/.test(binding.path)))) fail('structured_path.path must be an RFC 6901 JSON Pointer')
      validateBindingOrigin(binding, context, STRUCTURED_EVIDENCE_ORIGINS)
      return binding
    }
    case 'private_source_ref': {
      exactKeys(binding, ['kind', 'origin_id', 'private_locator_hash', 'locator_authority'], 'private_source_ref evidence binding')
      hash(binding.origin_id, 'private_source_ref.origin_id')
      hash(binding.private_locator_hash, 'private_source_ref.private_locator_hash')
      string(binding.locator_authority, 'private_source_ref.locator_authority')
      validateBindingOrigin(binding, context, new Set(['primary-source']))
      return binding
    }
    case 'derived_evidence': {
      exactKeys(binding, ['kind', 'parent_claim_occurrence_ids', 'derivation_rule_id', 'derivation_rule_version'], 'derived_evidence binding')
      const parents = uniqueStrings(binding.parent_claim_occurrence_ids, 'derived_evidence.parent_claim_occurrence_ids', hash)
      if (parents.length === 0) fail('derived_evidence requires parent claims')
      string(binding.derivation_rule_id, 'derived_evidence.derivation_rule_id')
      version(binding.derivation_rule_version, 'derived_evidence.derivation_rule_version')
      if (context?.current_accepted_parent_ids === undefined) fail('derived_evidence requires current accepted parent context')
      const accepted = new Set(uniqueStrings(context.current_accepted_parent_ids, 'context.current_accepted_parent_ids', hash))
      if (parents.some(parent => !accepted.has(parent))) fail('derived_evidence parent is not currently accepted')
      return binding
    }
    default:
      fail('evidence binding kind is invalid')
  }
}

function canonicalCompleteness(value) {
  exactKeys(value, ['state', 'obligations_checked'], 'completeness')
  if (!['complete', 'incomplete', 'disputed'].includes(value.state)) fail('completeness.state is invalid')
  return { state: value.state, obligations_checked: sorted(uniqueStrings(value.obligations_checked, 'completeness.obligations_checked')) }
}

function assertionState(assertion, decisions) {
  const initial = assertion.state ?? 'proposed'
  if (!OCCURRENCE_STATES.has(initial)) fail('assertion state is invalid')
  let state = initial
  for (const decision of decisions) {
    if (decision.assertion_id !== assertion.assertion_id) continue
    if (!DECISIONS.has(decision.decision) || !['accept', 'reject', 'supersede', 'invalidate'].includes(decision.decision)) {
      fail('claim review decision is invalid for assertion')
    }
    if (decision.decision === 'accept') state = 'accepted'
    if (decision.decision === 'reject') state = 'rejected'
    if (decision.decision === 'supersede') state = 'superseded'
    if (decision.decision === 'invalidate') state = 'invalidated'
  }
  return state
}

function assertionIdFor({ extraction_id, extraction_local_id, claim_occurrence_id, evidence_binding_ids, derivation_parent_claim_occurrence_ids }) {
  return canonicalHash({
    extraction_id: hash(extraction_id, 'extraction_id'),
    extraction_local_id: string(extraction_local_id, 'extraction_local_id'),
    claim_occurrence_id: hash(claim_occurrence_id, 'claim_occurrence_id'),
    evidence_binding_ids_sorted: setHashes(evidence_binding_ids, 'evidence_binding_ids'),
    derivation_parent_claim_occurrence_ids_ordered: uniqueStrings(derivation_parent_claim_occurrence_ids, 'derivation_parent_claim_occurrence_ids', hash),
  })
}

function relationIdFor({ source_claim_occurrence_id, target_claim_occurrence_id, relation_type, decision_node_id }) {
  if (!RELATION_TYPES.has(relation_type)) fail('claim relation type is invalid')
  return canonicalHash({
    source_claim_occurrence_id: hash(source_claim_occurrence_id, 'source_claim_occurrence_id'),
    target_claim_occurrence_id: hash(target_claim_occurrence_id, 'target_claim_occurrence_id'),
    relation_type,
    decision_node_id: hash(decision_node_id, 'decision_node_id'),
  })
}

function canonicalExtractorIdentity(identity) {
  object(identity, 'extractor identity')
  if (!EXTRACTOR_KINDS.has(identity.kind)) fail('extractor identity kind is invalid')
  if (identity.kind === 'model') {
    exactKeys(identity, ['kind', 'model_id', 'prompt_sha256', 'output_schema_sha256', 'agent_contract_id'], 'model extractor identity')
    return { kind: 'model', model_id: string(identity.model_id, 'model_id'), prompt_sha256: hash(identity.prompt_sha256, 'prompt_sha256'), output_schema_sha256: hash(identity.output_schema_sha256, 'output_schema_sha256'), agent_contract_id: string(identity.agent_contract_id, 'agent_contract_id') }
  }
  if (identity.kind === 'deterministic') {
    exactKeys(identity, ['kind', 'implementation_id', 'implementation_version', 'input_schema_sha256'], 'deterministic extractor identity')
    return { kind: 'deterministic', implementation_id: string(identity.implementation_id, 'implementation_id'), implementation_version: version(identity.implementation_version, 'implementation_version'), input_schema_sha256: hash(identity.input_schema_sha256, 'input_schema_sha256') }
  }
  exactKeys(identity, ['kind', 'artifact_node_id', 'lineage_state'], 'legacy extractor identity')
  if (!['exact', 'incomplete'].includes(identity.lineage_state)) fail('legacy lineage_state is invalid')
  return { kind: 'legacy', artifact_node_id: hash(identity.artifact_node_id, 'artifact_node_id'), lineage_state: identity.lineage_state }
}

export function independenceGroupId({ origin_id, extractor_identity, lineage_root_origin_ids = [] }) {
  const extractor = canonicalExtractorIdentity(extractor_identity)
  if (extractor.kind === 'model') return canonicalHash({ origin_id: hash(origin_id, 'origin_id'), model_id: extractor.model_id, prompt_sha256: extractor.prompt_sha256, output_schema_sha256: extractor.output_schema_sha256, agent_contract_id: extractor.agent_contract_id })
  const roots = setHashes(lineage_root_origin_ids, 'lineage_root_origin_ids')
  if (roots.length === 0) fail('derivative extraction requires a lineage root origin')
  return canonicalHash({ lineage_root_origin_ids_sorted: roots })
}


export function canonicalizeClaimAssertion(assertion, adapter) {
  exactKeys(assertion, ['extraction_local_id', 'proposition', 'polarity', 'modality', 'evidence_binding_ids', 'derivation_parent_claim_occurrence_ids'], 'claim assertion')
  string(assertion.extraction_local_id, 'claim assertion.extraction_local_id')
  if (!POLARITIES.has(assertion.polarity)) fail('claim assertion polarity is invalid')
  if (!MODALITIES.has(assertion.modality)) fail('claim assertion modality is invalid')
  return {
    extraction_local_id: assertion.extraction_local_id,
    proposition: canonicalProposition(assertion.proposition, adapter),
    polarity: assertion.polarity,
    modality: assertion.modality,
    evidence_binding_ids: setHashes(assertion.evidence_binding_ids, 'claim assertion.evidence_binding_ids'),
    derivation_parent_claim_occurrence_ids: uniqueStrings(assertion.derivation_parent_claim_occurrence_ids, 'claim assertion.derivation_parent_claim_occurrence_ids', hash),
  }
}

export function semanticKey({ adapter_id, proposition, polarity, modality }, adapter) {
  const canonical = canonicalProposition(proposition, adapter)
  const id = adapterId(adapter, adapter_id)
  if (!POLARITIES.has(polarity)) fail('polarity is invalid')
  if (!MODALITIES.has(modality)) fail('modality is invalid')
  return canonicalHash({
    adapter_id: id,
    proposition_schema_id: canonical.schema_id,
    identity_ontology_version: identityOntologyVersion(adapter),
    canonical_proposition_value: canonical.value,
    polarity,
    modality,
  })
}

export function claimOriginId(origin) {
  object(origin, 'claim origin')
  if (!ORIGIN_KINDS.has(origin.origin_kind)) fail('claim origin kind is invalid')
  if (origin.origin_kind === 'primary-source') {
    exactKeys(origin, ['subject_ref', 'origin_kind', 'source_snapshot_id'], 'primary source origin')
    return canonicalHash({ subject_ref: string(origin.subject_ref, 'subject_ref'), origin_kind: origin.origin_kind, source_snapshot_id: hash(origin.source_snapshot_id, 'source_snapshot_id') })
  }
  exactKeys(origin, ['subject_ref', 'origin_kind', 'artifact_node_id', 'content_sha256'], 'artifact claim origin')
  return canonicalHash({ subject_ref: string(origin.subject_ref, 'subject_ref'), origin_kind: origin.origin_kind, artifact_node_id: hash(origin.artifact_node_id, 'artifact_node_id'), content_sha256: hash(origin.content_sha256, 'content_sha256') })
}

export function claimOccurrenceId({ origin_id, semantic_key }) {
  return canonicalHash({ origin_id: hash(origin_id, 'origin_id'), semantic_key: hash(semantic_key, 'semantic_key') })
}

export function extractionId(identity) {
  exactKeys(identity, ['origin_id', 'extractor_contract_version', 'formalization_policy_version', 'normalization_version', 'extractor_implementation', 'extractor_identity', 'ordered_parent_evidence_ids', 'lineage_root_origin_ids'], 'extraction identity')
  return canonicalHash({
    origin_id: hash(identity.origin_id, 'origin_id'),
    extractor_contract_version: version(identity.extractor_contract_version, 'extractor_contract_version'),
    formalization_policy_version: version(identity.formalization_policy_version, 'formalization_policy_version'),
    normalization_version: version(identity.normalization_version, 'normalization_version'),
    extractor_implementation: string(identity.extractor_implementation, 'extractor_implementation'),
    extractor_identity: canonicalExtractorIdentity(identity.extractor_identity),
    ordered_parent_evidence_ids: uniqueStrings(identity.ordered_parent_evidence_ids, 'ordered_parent_evidence_ids', hash),
    lineage_root_origin_ids: setHashes(identity.lineage_root_origin_ids, 'lineage_root_origin_ids'),
  })
}


export function evidenceBindingId(binding, context = undefined) {
  return canonicalHash(canonicalBinding(binding, context))
}

export function unresolvedKey(item) {
  exactKeys(item, ['origin_id', 'kind', 'canonical_focus', 'candidate_semantic_keys', 'blocks_obligations'], 'unresolved item identity')
  if (!UNRESOLVED_KINDS.has(item.kind)) fail('unresolved item kind is invalid')
  canonicalJson(item.canonical_focus)
  return canonicalHash({
    origin_id: hash(item.origin_id, 'origin_id'),
    kind: item.kind,
    canonical_focus: item.canonical_focus,
    candidate_semantic_keys_sorted: setHashes(item.candidate_semantic_keys, 'candidate_semantic_keys'),
    blocks_obligations_sorted: sorted(uniqueStrings(item.blocks_obligations, 'blocks_obligations')),
  })
}

export function claimSourceRevisionInvalidationId({ old_occurrence_id, old_origin_id, new_origin_id, decision_node_id }) {
  return canonicalHash({
    old_occurrence_id: hash(old_occurrence_id, 'old_occurrence_id'),
    old_origin_id: hash(old_origin_id, 'old_origin_id'),
    new_origin_id: hash(new_origin_id, 'new_origin_id'),
    decision_node_id: hash(decision_node_id, 'decision_node_id'),
  })
}

export function claimSetId(projection) {
  exactKeys(projection, ['subject_ref', 'origin_id', 'adapter_id', 'ontology_version', 'accepted_claim_occurrence_ids', 'candidate_claim_occurrence_ids', 'open_unresolved_keys', 'completeness'], 'claim set projection')
  return canonicalHash({
    subject_ref: string(projection.subject_ref, 'subject_ref'),
    origin_id: hash(projection.origin_id, 'origin_id'),
    adapter_id: string(projection.adapter_id, 'adapter_id'),
    ontology_version: version(projection.ontology_version, 'ontology_version'),
    accepted_claim_occurrence_ids_sorted: setHashes(projection.accepted_claim_occurrence_ids, 'accepted_claim_occurrence_ids'),
    candidate_claim_occurrence_ids_sorted: setHashes(projection.candidate_claim_occurrence_ids, 'candidate_claim_occurrence_ids'),
    open_unresolved_keys_sorted: setHashes(projection.open_unresolved_keys, 'open_unresolved_keys'),
    completeness: canonicalCompleteness(projection.completeness),
  })
}

export function projectClaimSet({ subject_ref, origin_id, origin_kind, adapter, extractions, decisions = [], relations = [], completeness }) {
  const id = adapterId(adapter)
  const ontology = version(adapter?.ontology_version, 'adapter.ontology_version')
  hash(origin_id, 'origin_id')
  if (!ORIGIN_KINDS.has(origin_kind)) fail('origin_kind is invalid')
  string(subject_ref, 'subject_ref')
  const allAssertions = []
  const allUnresolved = []
  const normalizedExtractions = []
  for (const extraction of array(extractions, 'extractions')) {
    object(extraction, 'extraction')
    if (extraction.origin_id !== origin_id) fail('extraction origin_id does not match claim set')
    const computedExtractionId = extraction.extraction_identity === undefined ? undefined : extractionId(extraction.extraction_identity)
    if (extraction.extraction_id !== undefined && computedExtractionId !== undefined && extraction.extraction_id !== computedExtractionId) fail('extraction_id does not match extraction identity')
    const extraction_id = extraction.extraction_id ?? computedExtractionId
    const evidenceContext = { ...(extraction.evidence_context ?? {}), origin_id, origin_kind }
    const evidenceById = new Map()
    for (const evidence of array(extraction.evidence_bindings ?? [], 'extraction.evidence_bindings')) {
      const binding_id = evidenceBindingId(evidence, evidenceContext)
      evidenceById.set(binding_id, evidence)
    }
    const independence_group_id = extraction.extraction_identity === undefined
      ? undefined
      : independenceGroupId({
          origin_id,
          extractor_identity: extraction.extraction_identity.extractor_identity,
          lineage_root_origin_ids: extraction.extraction_identity.lineage_root_origin_ids,
        })
    normalizedExtractions.push({ extraction_id, ...(independence_group_id === undefined ? {} : { independence_group_id }) })
    for (const assertion of array(extraction.assertions ?? [], 'extraction.assertions')) allAssertions.push({ assertion, extraction_id, evidenceIds: new Set(evidenceById.keys()), evidenceById, independence_group_id })
    for (const item of array(extraction.unresolved ?? [], 'extraction.unresolved')) allUnresolved.push(item)
  }
  const reviewDecisions = array(decisions, 'decisions').map(decision => {
    exactKeys(decision, ['assertion_id', 'decision'], 'claim review decision')
    return { assertion_id: hash(decision.assertion_id, 'decision.assertion_id'), decision: string(decision.decision, 'decision.decision') }
  })
  const normalizedRelations = array(relations, 'relations').map(relation => {
    object(relation, 'claim relation')
    const relation_id = relationIdFor(relation)
    if (relation.relation_id !== undefined && hash(relation.relation_id, 'relation.relation_id') !== relation_id) fail('relation_id does not match relation identity')
    return { ...relation, relation_id }
  })
  const accepted = []
  const candidates = []
  const assertion_states = []
  const seenAssertions = new Set()
  for (const entry of allAssertions) {
    const { assertion, extraction_id, evidenceIds, evidenceById, independence_group_id } = entry
    object(assertion, 'projected assertion')
    hash(assertion.claim_occurrence_id, 'assertion.claim_occurrence_id')
    const hasIdentityFields = ['extraction_local_id', 'evidence_binding_ids', 'derivation_parent_claim_occurrence_ids'].every(key => Object.hasOwn(assertion, key))
    if (assertion.assertion_id === undefined && (!hasIdentityFields || extraction_id === undefined)) fail('assertion identity fields and extraction_id are required when assertion_id is absent')
    const computedAssertionId = hasIdentityFields && extraction_id !== undefined
      ? assertionIdFor({ extraction_id, ...assertion })
      : undefined
    const assertion_id = assertion.assertion_id ?? computedAssertionId
    if (assertion.assertion_id !== undefined && computedAssertionId !== undefined && assertion.assertion_id !== computedAssertionId) {
      fail('assertion_id does not match assertion identity')
    }
    hash(assertion_id, 'assertion.assertion_id')
    if (assertion.evidence_binding_ids !== undefined && assertion.evidence_binding_ids.some(binding_id => !evidenceIds.has(binding_id))) {
      fail('assertion references an unvalidated evidence binding')
    }
    const derivedBindings = (assertion.evidence_binding_ids ?? []).map(bindingId => evidenceById.get(bindingId))
      .filter(binding => binding?.kind === 'derived_evidence')
    if (!derivedBindings.length && (assertion.derivation_parent_claim_occurrence_ids?.length ?? 0)) {
      fail('assertion derivation parents require derived evidence')
    }
    for (const binding of derivedBindings) {
      if (!exactArray(assertion.derivation_parent_claim_occurrence_ids ?? [], binding.parent_claim_occurrence_ids)) {
        fail('assertion derivation parents must exactly match derived evidence parents')
      }
    }
    if (seenAssertions.has(assertion_id)) fail('duplicate assertion_id')
    seenAssertions.add(assertion_id)
    const state = assertionState({ ...assertion, assertion_id }, reviewDecisions)
    if (state === 'accepted' && (assertion.evidence_binding_ids?.length ?? 0) === 0 && (assertion.derivation_parent_claim_occurrence_ids?.length ?? 0) === 0) {
      fail('accepted assertion requires evidence or an accepted derived parent')
    }
    assertion_states.push({ assertion_id, claim_occurrence_id: assertion.claim_occurrence_id, state, ...(independence_group_id === undefined ? {} : { independence_group_id }) })
    if (state === 'accepted') accepted.push(assertion.claim_occurrence_id)
    else if (state === 'proposed') candidates.push(assertion.claim_occurrence_id)
  }
  if (new Set(accepted).size !== accepted.length) fail('duplicate accepted assertions for one occurrence')
  const unresolved = allUnresolved.map(item => {
    object(item, 'projected unresolved item')
    if (!UNRESOLVED_STATES.has(item.resolution_state ?? 'open')) fail('unresolved resolution_state is invalid')
    const identity = {
      origin_id,
      kind: item.kind,
      canonical_focus: item.canonical_focus ?? item.extraction_local_focus,
      candidate_semantic_keys: item.candidate_semantic_keys,
      blocks_obligations: item.blocks_obligations,
    }
    return { unresolved_key: item.unresolved_key ?? unresolvedKey(identity), resolution_state: item.resolution_state ?? 'open', blocks_obligations: sorted(uniqueStrings(item.blocks_obligations, 'unresolved blocks_obligations')) }
  })
  if (new Set(unresolved.map(item => item.unresolved_key)).size !== unresolved.length) fail('duplicate unresolved_key')
  const normalizedCompleteness = canonicalCompleteness(completeness)
  const open = unresolved.filter(item => item.resolution_state === 'open')
  if (normalizedCompleteness.state === 'complete') {
    const checked = new Set(normalizedCompleteness.obligations_checked)
    if (open.some(item => item.blocks_obligations.some(obligation => checked.has(obligation)))) fail('complete claim set has an open unresolved blocker')
  }
  const projection = {
    subject_ref,
    origin_id,
    adapter_id: id,
    ontology_version: ontology,
    accepted_claim_occurrence_ids: sorted(accepted),
    candidate_claim_occurrence_ids: sorted(candidates),
    open_unresolved_keys: sorted(open.map(item => item.unresolved_key)),
    completeness: normalizedCompleteness,
  }
  return { claim_set_id: claimSetId(projection), ...projection, assertion_states, unresolved, relations: normalizedRelations, extractions: normalizedExtractions }
}

export function classifyClaimRelation(currentClaim, priorClaim, adapter) {
  if (typeof adapter?.compare === 'function') return adapter.compare(currentClaim, priorClaim)
  const current = canonicalProposition(currentClaim.proposition, adapter)
  const prior = canonicalProposition(priorClaim.proposition, adapter)
  if (currentClaim.polarity !== priorClaim.polarity || currentClaim.modality !== priorClaim.modality ||
      current.schema_id !== prior.schema_id || current.schema_version !== prior.schema_version) return null
  if (canonicalJson(current.value) === canonicalJson(prior.value)) return { relation_type: 'semantically_equivalent_to', comparison_context: {} }
  if (current.value.predicate !== prior.value.predicate) return null
  const currentArgs = Object.fromEntries(current.value.arguments.map(item => [item.role, item.value]))
  const priorArgs = Object.fromEntries(prior.value.arguments.map(item => [item.role, item.value]))
  if (current.value.predicate === 'mechanic.effect.feel-no-pain') {
    const currentContext = { affected_entity: currentArgs['affected-entity'] ?? null, scope: currentArgs.scope ?? null }
    const priorContext = { affected_entity: priorArgs['affected-entity'] ?? null, scope: priorArgs.scope ?? null }
    if (canonicalJson(currentContext) !== canonicalJson(priorContext)) return null
    if (currentArgs.threshold !== priorArgs.threshold) return { relation_type: 'contradicts', comparison_context: currentContext }
  }
  const restrictionRoles = ['required-keywords', 'excluded-keywords']
  const comparable = restrictionRoles.some(role => Array.isArray(currentArgs[role]) || Array.isArray(priorArgs[role]))
  if (comparable) {
    const currentRestrictions = restrictionRoles.flatMap(role => (currentArgs[role] ?? []).map(value => `${role}:${canonicalJson(value)}`)).sort()
    const priorRestrictions = restrictionRoles.flatMap(role => (priorArgs[role] ?? []).map(value => `${role}:${canonicalJson(value)}`)).sort()
    const currentSet = new Set(currentRestrictions)
    const priorSet = new Set(priorRestrictions)
    const currentContainsPrior = priorRestrictions.every(value => currentSet.has(value))
    const priorContainsCurrent = currentRestrictions.every(value => priorSet.has(value))
    if (currentContainsPrior && !priorContainsCurrent) return { relation_type: 'specializes', comparison_context: { predicate: current.value.predicate } }
    if (priorContainsCurrent && !currentContainsPrior) return { relation_type: 'generalizes', comparison_context: { predicate: current.value.predicate } }
  }
  return null
}

export function computeInvalidations(change, dependencies = {}) {
  object(change, 'change')
  const kind = string(change.kind, 'change.kind')
  const ids = name => sorted(uniqueStrings(dependencies[name] ?? [], `dependencies.${name}`, hash))
  const invalidated = {
    claim_occurrence_ids: [], claim_set_ids: [], claim_set_certificate_ids: [],
    construction_plan_ids: [], representation_certificate_ids: [], representation_coverage_ids: [], assessment_ids: [],
  }
  const result = { reextract: false, rebuild_adapter_projections: false, rebuild_retrieval_and_construction: false, recertify_representations: false, reassess: false, invalidated }
  const invalidateClaimAuthority = () => {
    invalidated.claim_occurrence_ids = ids('claim_occurrence_ids')
    invalidated.claim_set_ids = ids('claim_set_ids')
    invalidated.claim_set_certificate_ids = ids('claim_set_certificate_ids')
    invalidated.construction_plan_ids = ids('construction_plan_ids')
    invalidated.representation_certificate_ids = ids('representation_certificate_ids')
    invalidated.representation_coverage_ids = ids('representation_coverage_ids')
  }
  if (kind === 'source_snapshot') {
    result.reextract = true
    result.recertify_representations = true
    result.reassess = true
    invalidateClaimAuthority()
    invalidated.assessment_ids = ids('assessment_ids')
  } else if (kind === 'extraction_identity') {
    result.reextract = true
    if (change.claim_set_id_changed === true) {
      result.recertify_representations = true
      result.reassess = true
      invalidateClaimAuthority()
      invalidated.assessment_ids = ids('assessment_ids')
    }
  } else if (kind === 'identity_ontology') {
    result.reextract = true
    result.recertify_representations = true
    result.reassess = true
    invalidateClaimAuthority()
    invalidated.assessment_ids = ids('assessment_ids')
  } else if (kind === 'adapter_annotation') {
    result.rebuild_adapter_projections = true
  } else if (kind === 'mechanic_signature_or_embedding') {
    result.rebuild_retrieval_and_construction = true
  } else if (kind === 'ability_dsl_schema_or_describer') {
    result.recertify_representations = true
    invalidated.representation_certificate_ids = ids('representation_certificate_ids')
  } else if (kind === 'assessment_context_or_policy_or_model_or_prompt_or_contract') {
    result.reassess = true
    invalidated.assessment_ids = ids('assessment_ids')
  } else {
    fail('change.kind is invalid')
  }
  return result
}
