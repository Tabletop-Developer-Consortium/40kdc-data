export const SCHEMA_VERSION = 5
export const PRODUCER_CONTRACT_VERSION = 2
export const FORMALIZATION_POLICY_VERSION = 2

// These tables retain the common id/run/state/node/payload projection shape.
export const TABLES = Object.freeze([
  'source_snapshots', 'clause_maps', 'mechanic_signatures', 'tasks', 'attempts', 'leases',
  'checkpoints', 'decisions', 'findings', 'checks', 'certificates', 'ability_evidence',
  'family_templates', 'family_instances', 'construction_plans', 'apply_transactions',
  'legacy_observations',
])

// Claim projections are normalized deliberately: they must not use the generic table shape.
export const NORMALIZED_CLAIM_TABLES = Object.freeze([
  'claim_origins', 'claim_extractions', 'semantic_claims', 'claim_occurrences',
  'claim_evidence_bindings', 'claim_assertions', 'claim_assertion_evidence',
  'claim_derivation_parents', 'claim_evidence_binding_parents', 'claim_unresolved',
  'claim_unresolved_candidates', 'claim_unresolved_evidence', 'claim_review_decisions',
  'claim_relations', 'claim_source_revision_invalidations', 'claim_sets', 'claim_set_members',
  'claim_set_unresolved', 'claim_imports', 'mechanic_claim_facets', 'representation_claim_coverage',
])

export const GRAPH_CORE_TABLES = Object.freeze(['objects', 'nodes', 'edges', 'events'])
export const REBUILDABLE_PROJECTION_TABLES = Object.freeze([
  'runs', 'claims', 'progress', 'ability_catalog', 'node_ability_refs', ...TABLES, ...NORMALIZED_CLAIM_TABLES,
])

export const EDGE_TYPES = Object.freeze([
  'derived_from',
  'similar_mechanic',
  'generalizes',
  'specializes',
  'satisfies',
  'certified_by',
  'corresponds_to_current_implementation',
])
const EDGE_TYPE_SET = new Set(EDGE_TYPES)

export function assertAllowedEdgeType(edgeType) {
  if (!EDGE_TYPE_SET.has(edgeType)) throw new TypeError(`unsupported edge type: ${edgeType}`)
  return edgeType
}

const LIFECYCLE_EVENTS = Object.freeze({
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

const DOMAIN_EVENTS = Object.freeze({
  'ability-evidence-certified': 'ability-evidence',
  'ability-evidence-family-linked': 'ability-evidence',
  'ability-evidence-identity-corrected': 'ability-evidence',
  'ability-gap-recorded': 'ability-evidence',
  'check-recorded': 'check',
  'construction-plan-parent-authorized': 'construction-plan',
  'family-instance-certified': 'family-instance',
  'family-template-certified': 'family-template',
  'intake-prepared': 'run',
  'intake-outcome-recorded': 'task',
  'intake-completed': 'run',
  'lineage-mismatch': 'run',
  'registry-bootstrapped': null,
  'legacy-observation-recorded': 'run',
  'repository-reconciled': 'repository',
  'workflow-output-sealed': 'task',
  'projection-baseline-imported': 'projection',
  'source-formalization-recorded': 'task',
  'construction-plan-recorded': 'construction-plan',
  'shape-family-certified': 'family-template',
  'campaign-scope-expanded': 'run',
  'lease-heartbeat-lost': 'lease',
  'describer-scope-checked': 'run',
  'source-snapshot-recorded': 'projection',
  'claim-origin-recorded': 'claim-origin',
  'claim-origin-currentness-changed': 'claim-origin',
  'claim-candidate-imported': 'claim-import',
  'claim-source-revision-recorded': 'claim-origin',
  'claim-extraction-recorded': 'projection',
  'claim-review-recorded': 'projection',
  'claim-relation-recorded': 'projection',
  'claim-set-projected': 'projection',
  'claim-dependencies-invalidated': 'projection',
  'representation-coverage-recorded': 'projection',
})

function plainPayload(payload, eventType) {
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new TypeError(`${eventType}: payload must be a plain object`)
  }
}

function requireKeys(payload, eventType, keys) {
  plainPayload(payload, eventType)
  for (const key of keys) if (!(key in payload)) throw new TypeError(`${eventType}: missing ${key}`)
}

const EVENT_REQUIRED_KEYS = Object.freeze({
  'projection-baseline-imported': ['schema_version', 'rows'],
  'source-formalization-recorded': ['run_id', 'faction_id', 'ability_id', 'rows', 'completion'],
  'construction-plan-recorded': ['run_id', 'faction_id', 'ability_id', 'rows'],
  'shape-family-certified': ['run_id', 'template', 'instances'],
  'campaign-scope-expanded': ['run_id', 'family_template_node_id', 'family_members', 'source_bindings', 'apply_transaction', 'claims', 'tasks'],
  'lease-heartbeat-lost': ['lease_id', 'attempt_id', 'task_id', 'input_hash', 'now', 'reason'],
  'describer-scope-checked': ['run_id', 'baseline_hash', 'updated_hash', 'changed_keys', 'authorized_keys'],
  'source-snapshot-recorded': ['source_snapshot_id', 'source_node_id', 'rows'],
  'claim-origin-recorded': ['schema_version', 'origin_id', 'rows'],
  'claim-origin-currentness-changed': ['schema_version', 'origin_id', 'from_state', 'to_state', 'reason', 'rows'],
  'claim-candidate-imported': ['schema_version', 'import_id', 'origin_id', 'claim_set_id', 'rows'],
  'claim-source-revision-recorded': ['schema_version', 'subject_ref', 'new_origin_id', 'old_origin_ids', 'relation_ids', 'invalidation_ids', 'rows'],
  'claim-extraction-recorded': ['extraction_id', 'origin_id', 'rows'],
  'claim-review-recorded': ['decision_id', 'subject_node_id', 'rows'],
  'claim-relation-recorded': ['relation_id', 'source_claim_occurrence_id', 'target_claim_occurrence_id', 'rows'],
  'claim-set-projected': ['claim_set_id', 'certificate_node_id', 'rows'],
  'claim-dependencies-invalidated': ['invalidation_node_id', 'invalidated_node_ids', 'rows'],
  'representation-coverage-recorded': ['representation_node_id', 'claim_set_id', 'claim_occurrence_id', 'construction_plan_node_id', 'rows'],
})

export const EVENT_CONTRACTS = new Map()
for (const [aggregateKind, eventTypes] of Object.entries(LIFECYCLE_EVENTS)) {
  for (const eventType of eventTypes) EVENT_CONTRACTS.set(eventType, Object.freeze({ event_version: 1, aggregate_kind: aggregateKind }))
}
for (const [eventType, aggregateKind] of Object.entries(DOMAIN_EVENTS)) {
  EVENT_CONTRACTS.set(eventType, Object.freeze({ event_version: 1, aggregate_kind: aggregateKind }))
}

export function assertAllowedEvent(eventType, payload, { event_version = 1, aggregate_kind = null, aggregate_id = null } = {}) {
  const contract = EVENT_CONTRACTS.get(eventType)
  if (!contract) throw new TypeError(`unknown event type: ${eventType}`)
  if (event_version !== contract.event_version) throw new TypeError(`${eventType}: unsupported event version ${event_version}`)
  if (contract.aggregate_kind !== null && aggregate_kind !== contract.aggregate_kind) {
    throw new TypeError(`${eventType}: aggregate kind must be ${contract.aggregate_kind}`)
  }
  if (contract.aggregate_kind !== null && (typeof aggregate_id !== 'string' || !aggregate_id)) {
    throw new TypeError(`${eventType}: aggregate id required`)
  }
  const required = EVENT_REQUIRED_KEYS[eventType]
  if (required) requireKeys(payload, eventType, required)
  else plainPayload(payload, eventType)
  return contract
}

export const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS objects (node_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, kind TEXT NOT NULL, relative_path TEXT NOT NULL, byte_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY REFERENCES objects(node_id), kind TEXT NOT NULL, producer_contract_version INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges (parent_node_id TEXT NOT NULL REFERENCES nodes(node_id), child_node_id TEXT NOT NULL REFERENCES nodes(node_id), edge_type TEXT NOT NULL DEFAULT 'derived_from', authorizes_reuse INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(parent_node_id, child_node_id, edge_type));
CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, event_type TEXT NOT NULL, event_version INTEGER NOT NULL, aggregate_kind TEXT, aggregate_id TEXT, node_id TEXT REFERENCES nodes(node_id), payload_json TEXT NOT NULL, previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS quarantine_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, reason TEXT NOT NULL, raw_metadata_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, campaign_id TEXT UNIQUE, state TEXT NOT NULL, kind TEXT, target TEXT, started TEXT, finished TEXT, source_hash TEXT, paused_reason TEXT);
CREATE TABLE IF NOT EXISTS claims (faction_id TEXT NOT NULL, ability_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), state TEXT NOT NULL, claimed_sequence INTEGER NOT NULL, released_sequence INTEGER, PRIMARY KEY(faction_id, ability_id, run_id));
CREATE UNIQUE INDEX IF NOT EXISTS claims_one_active ON claims(faction_id, ability_id) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS progress (name TEXT PRIMARY KEY, sequence INTEGER NOT NULL, checksum TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS ability_catalog (
  faction_id TEXT NOT NULL,
  ability_id TEXT NOT NULL,
  ability_name TEXT NOT NULL,
  faction_name TEXT NOT NULL,
  repository_version_id TEXT NOT NULL,
  PRIMARY KEY(faction_id, ability_id)
);
CREATE TABLE IF NOT EXISTS node_ability_refs (
  node_id TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  faction_id TEXT NOT NULL,
  ability_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  distance INTEGER NOT NULL CHECK(distance >= 0),
  PRIMARY KEY(node_id, faction_id, ability_id)
);
CREATE INDEX IF NOT EXISTS node_ability_refs_ability ON node_ability_refs(faction_id, ability_id, distance, node_id);
${TABLES.map(table => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, run_id TEXT, state TEXT, node_id TEXT REFERENCES nodes(node_id), payload_json TEXT NOT NULL DEFAULT '{}');`).join('\n')}
CREATE TABLE IF NOT EXISTS claim_origins (
  origin_id TEXT PRIMARY KEY, subject_ref TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('primary-source','ability-dsl','generated-render','cruncher-projection','historical-artifact','review')),
  artifact_node_id TEXT REFERENCES nodes(node_id), content_sha256 TEXT, source_snapshot_id TEXT REFERENCES source_snapshots(id),
  current_state TEXT NOT NULL CHECK(current_state IN ('current','stale','historical')), node_id TEXT NOT NULL UNIQUE REFERENCES nodes(node_id),
  CHECK((origin_kind='primary-source' AND source_snapshot_id IS NOT NULL AND artifact_node_id IS NULL AND content_sha256 IS NULL) OR
        (origin_kind<>'primary-source' AND source_snapshot_id IS NULL AND artifact_node_id IS NOT NULL AND content_sha256 IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS claim_imports (
  import_id TEXT PRIMARY KEY, origin_id TEXT NOT NULL REFERENCES claim_origins(origin_id),
  importer_contract_version TEXT NOT NULL, registry_schema_sha256 TEXT NOT NULL,
  claim_set_id TEXT NOT NULL, event_node_id TEXT NOT NULL UNIQUE REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_extractions (
  extraction_id TEXT PRIMARY KEY, origin_id TEXT NOT NULL REFERENCES claim_origins(origin_id),
  adapter_id TEXT NOT NULL, ontology_version TEXT NOT NULL, identity_json TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS semantic_claims (
  semantic_key TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, proposition_schema_id TEXT NOT NULL,
  proposition_schema_version TEXT NOT NULL, identity_ontology_version TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK(polarity IN ('affirms','denies')),
  modality TEXT NOT NULL CHECK(modality IN ('asserted','conditional','permitted','required','possible')),
  proposition_json TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_occurrences (
  claim_occurrence_id TEXT PRIMARY KEY, origin_id TEXT NOT NULL REFERENCES claim_origins(origin_id),
  semantic_key TEXT NOT NULL REFERENCES semantic_claims(semantic_key), subject_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','accepted','contradicted','superseded','invalidated')),
  node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_evidence_bindings (
  binding_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('source_span','structured_path','private_source_ref','derived_evidence')),
  origin_id TEXT REFERENCES claim_origins(origin_id), start_byte INTEGER, end_byte INTEGER,
  path_kind TEXT, path TEXT, private_locator_hash TEXT, locator_authority TEXT,
  derivation_rule_id TEXT, derivation_rule_version TEXT, node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_assertions (
  assertion_id TEXT PRIMARY KEY, extraction_id TEXT NOT NULL REFERENCES claim_extractions(extraction_id),
  extraction_local_id TEXT NOT NULL, claim_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  decision_state TEXT NOT NULL CHECK(decision_state IN ('proposed','accepted','rejected','superseded','invalidated')),
  independence_group_id TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_assertion_evidence (
  assertion_id TEXT NOT NULL REFERENCES claim_assertions(assertion_id),
  binding_id TEXT NOT NULL REFERENCES claim_evidence_bindings(binding_id),
  PRIMARY KEY(assertion_id, binding_id)
);
CREATE TABLE IF NOT EXISTS claim_derivation_parents (
  assertion_id TEXT NOT NULL REFERENCES claim_assertions(assertion_id),
  parent_claim_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(assertion_id, parent_claim_occurrence_id),
  UNIQUE(assertion_id, ordinal)
);
CREATE TABLE IF NOT EXISTS claim_evidence_binding_parents (
  binding_id TEXT NOT NULL REFERENCES claim_evidence_bindings(binding_id),
  parent_claim_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(binding_id, parent_claim_occurrence_id),
  UNIQUE(binding_id, ordinal)
);
CREATE TABLE IF NOT EXISTS claim_unresolved (
  unresolved_key TEXT PRIMARY KEY, extraction_id TEXT NOT NULL REFERENCES claim_extractions(extraction_id),
  kind TEXT NOT NULL CHECK(kind IN ('ambiguous','unsupported','contradictory','incomplete_source','ontology_gap','awaiting_evidence')),
  focus_json TEXT NOT NULL, blocks_obligations_json TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK(resolution_state IN ('open','resolved','waived')),
  node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_unresolved_candidates (
  unresolved_key TEXT NOT NULL REFERENCES claim_unresolved(unresolved_key),
  candidate_semantic_key TEXT NOT NULL REFERENCES semantic_claims(semantic_key), PRIMARY KEY(unresolved_key, candidate_semantic_key)
);
CREATE TABLE IF NOT EXISTS claim_unresolved_evidence (
  unresolved_key TEXT NOT NULL REFERENCES claim_unresolved(unresolved_key),
  binding_id TEXT NOT NULL REFERENCES claim_evidence_bindings(binding_id), PRIMARY KEY(unresolved_key, binding_id)
);
CREATE TABLE IF NOT EXISTS claim_review_decisions (
  decision_id TEXT PRIMARY KEY, subject_node_id TEXT NOT NULL REFERENCES nodes(node_id),
  decision TEXT NOT NULL CHECK(decision IN ('accept','reject','contradict','supersede','invalidate','resolve','waive')),
  reviewer_kind TEXT NOT NULL CHECK(reviewer_kind IN ('validator','human')),
  reviewer_id TEXT, rationale_hash TEXT, policy_version TEXT NOT NULL, blocks_obligations_json TEXT,
  node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_relations (
  relation_id TEXT PRIMARY KEY, source_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  target_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  relation_type TEXT NOT NULL CHECK(relation_type IN ('semantically_equivalent_to','specializes','generalizes','contradicts','supersedes')),
  decision_node_id TEXT NOT NULL REFERENCES nodes(node_id), node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_sets (
  claim_set_id TEXT PRIMARY KEY, subject_ref TEXT NOT NULL, origin_id TEXT NOT NULL REFERENCES claim_origins(origin_id),
  adapter_id TEXT NOT NULL, ontology_version TEXT NOT NULL,
  completeness_state TEXT NOT NULL CHECK(completeness_state IN ('complete','incomplete','disputed')),
  obligations_checked_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'current' CHECK(state IN ('current','invalidated')),
  certificate_node_id TEXT NOT NULL REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS claim_set_members (
  claim_set_id TEXT NOT NULL REFERENCES claim_sets(claim_set_id),
  claim_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  member_state TEXT NOT NULL CHECK(member_state IN ('accepted','candidate')),
  PRIMARY KEY(claim_set_id, claim_occurrence_id)
);
CREATE TABLE IF NOT EXISTS claim_set_unresolved (
  claim_set_id TEXT NOT NULL REFERENCES claim_sets(claim_set_id),
  unresolved_key TEXT NOT NULL REFERENCES claim_unresolved(unresolved_key), PRIMARY KEY(claim_set_id, unresolved_key)
);
CREATE TABLE IF NOT EXISTS claim_source_revision_invalidations (
  invalidation_id TEXT PRIMARY KEY, old_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  old_origin_id TEXT NOT NULL REFERENCES claim_origins(origin_id), new_origin_id TEXT NOT NULL REFERENCES claim_origins(origin_id),
  decision_node_id TEXT NOT NULL REFERENCES nodes(node_id), node_id TEXT NOT NULL UNIQUE REFERENCES nodes(node_id)
);
CREATE TABLE IF NOT EXISTS mechanic_claim_facets (
  claim_occurrence_id TEXT PRIMARY KEY REFERENCES claim_occurrences(claim_occurrence_id),
  predicate TEXT NOT NULL, actor TEXT, affected_entity TEXT, event TEXT, duration TEXT, threshold INTEGER,
  has_precondition INTEGER NOT NULL CHECK(has_precondition IN (0,1))
);
CREATE TABLE IF NOT EXISTS representation_claim_coverage (
  representation_node_id TEXT NOT NULL REFERENCES nodes(node_id),
  claim_set_id TEXT NOT NULL REFERENCES claim_sets(claim_set_id),
  claim_occurrence_id TEXT NOT NULL REFERENCES claim_occurrences(claim_occurrence_id),
  coverage_state TEXT NOT NULL CHECK(coverage_state IN ('covered','unmatched','blocked')),
  construction_plan_node_id TEXT NOT NULL REFERENCES nodes(node_id),
  PRIMARY KEY(representation_node_id, claim_set_id, claim_occurrence_id)
);
CREATE INDEX IF NOT EXISTS claim_extractions_origin ON claim_extractions(origin_id);
CREATE INDEX IF NOT EXISTS semantic_claims_adapter_schema ON semantic_claims(adapter_id, proposition_schema_id);
CREATE INDEX IF NOT EXISTS claim_occurrences_origin ON claim_occurrences(origin_id);
CREATE INDEX IF NOT EXISTS claim_occurrences_subject ON claim_occurrences(subject_ref);
CREATE INDEX IF NOT EXISTS claim_occurrences_semantic_key ON claim_occurrences(semantic_key);
CREATE INDEX IF NOT EXISTS claim_occurrences_state ON claim_occurrences(state);
CREATE INDEX IF NOT EXISTS claim_assertions_occurrence ON claim_assertions(claim_occurrence_id, decision_state);
CREATE INDEX IF NOT EXISTS claim_unresolved_kind ON claim_unresolved(kind, resolution_state);
CREATE INDEX IF NOT EXISTS claim_binding_parents_occurrence ON claim_evidence_binding_parents(parent_claim_occurrence_id);
CREATE INDEX IF NOT EXISTS claim_sets_origin ON claim_sets(origin_id);
CREATE INDEX IF NOT EXISTS claim_sets_subject ON claim_sets(subject_ref);
CREATE INDEX IF NOT EXISTS mechanic_claim_facets_predicate ON mechanic_claim_facets(predicate);
CREATE INDEX IF NOT EXISTS mechanic_claim_facets_actor ON mechanic_claim_facets(actor);
CREATE INDEX IF NOT EXISTS mechanic_claim_facets_affected_entity ON mechanic_claim_facets(affected_entity);
CREATE INDEX IF NOT EXISTS mechanic_claim_facets_event ON mechanic_claim_facets(event);
CREATE INDEX IF NOT EXISTS mechanic_claim_facets_duration ON mechanic_claim_facets(duration);
CREATE INDEX IF NOT EXISTS mechanic_claim_facets_threshold ON mechanic_claim_facets(threshold);
CREATE INDEX IF NOT EXISTS representation_claim_coverage_claim ON representation_claim_coverage(claim_occurrence_id, coverage_state);
`

const BASE_KEYS = ['kind', 'payload', 'input_node_ids', 'producer_contract_version', 'content_hash', 'node_id']

const OPEN_NODE_KINDS = new Set([
  'run', 'task', 'attempt', 'lease', 'checkpoint', 'decision', 'finding', 'check',
  'certificate', 'apply-transaction', 'family-template', 'family-instance', 'retrieval-match',
])
export const NODE_SCHEMAS = new Map([
  ['repository-version', ['workspace_hash', 'files', 'tool_versions', 'runner_hashes', 'schema_version', 'policy_version']],
  ['maintainer-decision', ['decision_id', 'state', 'text', 'authorizes_reuse']],
  ['legacy-observation', ['campaign_id', 'observation_type', 'status', 'summary', 'artifact_hashes', 'known_members', 'unknown_count', 'authorizes_reuse', 'reason']],
  ['source-snapshot', ['source_snapshot_id', 'faction_id', 'ability_id', 'store_key', 'provenance', 'byte_hash']],
  ['clause-map', ['faction_id', 'ability_id', 'clauses']],
  ['mechanic-signature', ['faction_id', 'ability_id', 'signature']],
  ['source-formalization-certificate', ['faction_id', 'ability_id', 'status', 'fingerprints', 'claims']],
  ['candidate-certificate', ['faction_id', 'ability_id', 'status', 'fingerprints', 'checks']],
  ['certified-ability-evidence', ['faction_id', 'ability_id', 'status', 'reusable_fragment_ids', 'family_instance_ids', 'fingerprints']],
  ['construction-plan', ['faction_id', 'ability_id', 'claim_set_id', 'selected_evidence_node_ids', 'covered_claim_occurrence_ids', 'unmatched_claim_occurrence_ids', 'state', 'blocking_unresolved_keys', 'substitutions', 'composition_seams', 'required_checks']],
  ['workflow-output', ['output_kind', 'envelope', 'result', 'execution_identity']],
  ['invalid-output', ['run_id', 'task_id', 'classification', 'reason', 'output_hash']],
  ['intake-outcome', ['faction_id', 'ability_id', 'outcome', 'reason', 'fingerprints']],
  ['extraction-identity', ['extraction_id', 'origin_id', 'adapter_id', 'ontology_version', 'identity']],
  ['claim-origin-artifact', ['subject_ref', 'origin_kind', 'content_sha256', 'path', 'json_pointer']],
  ['claim-origin', ['origin_id', 'subject_ref', 'origin_kind', 'source_snapshot_id', 'artifact_node_id', 'content_sha256', 'current_state']],
  ['claim-import', ['import_id', 'origin_id', 'importer_contract_version', 'registry_schema_sha256', 'claim_set_id']],
  ['claim-evidence-binding', ['binding_id', 'kind', 'origin_id', 'start', 'end', 'coordinate_unit', 'path_kind', 'path', 'private_locator_hash', 'locator_authority', 'parent_claim_occurrence_ids', 'derivation_rule_id', 'derivation_rule_version']],
  ['semantic-claim', ['semantic_key', 'adapter_id', 'proposition_schema_id', 'proposition_schema_version', 'identity_ontology_version', 'polarity', 'modality', 'proposition']],
  ['claim-occurrence', ['claim_occurrence_id', 'origin_id', 'semantic_key', 'subject_ref', 'state']],
  ['claim-assertion', ['assertion_id', 'extraction_id', 'extraction_local_id', 'claim_occurrence_id', 'decision_state', 'independence_group_id', 'signature', 'evidence_binding_ids', 'derivation_parent_claim_occurrence_ids']],
  ['unresolved-item', ['unresolved_key', 'extraction_id', 'extraction_local_id', 'extraction_local_focus', 'kind', 'evidence_binding_ids', 'candidate_semantic_keys', 'blocks_obligations', 'resolution_state']],
  ['claim-relation', ['relation_id', 'source_claim_occurrence_id', 'target_claim_occurrence_id', 'source_origin_id', 'target_origin_id', 'relation_type', 'comparison_context', 'decision_node_id']],
  ['claim-source-revision-invalidation', ['invalidation_id', 'old_occurrence_id', 'old_origin_id', 'new_origin_id', 'decision_node_id']],
  ['claim-review-decision', ['decision_id', 'subject_node_id', 'decision', 'reviewer_kind', 'reviewer_id', 'rationale_hash', 'policy_version', 'blocks_obligations']],
  ['claim-set', ['claim_set_id', 'subject_ref', 'origin_id', 'adapter_id', 'ontology_version', 'mechanic_signature', 'accepted_claim_occurrence_ids', 'candidate_claim_occurrence_ids', 'open_unresolved_keys', 'completeness']],
  ['claim-set-certificate', ['claim_set_id', 'certificate_id', 'extraction_id', 'extraction_node_id', 'claim_set_node_id', 'mechanic_signature', 'assertion_ids', 'assertion_node_ids', 'decision_ids', 'review_decision_node_ids', 'unresolved_keys', 'waiver_decision_node_ids', 'dependency_node_ids', 'status']],
  ['claim-dependency-invalidation', ['origin_id', 'invalidated_node_ids', 'reason']],
])

export function assertAllowedNode(kind, payload) {
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype) throw new TypeError(`${kind}: payload must be a plain object`)
  const allowed = NODE_SCHEMAS.get(kind)
  if (!allowed) {
    if (!OPEN_NODE_KINDS.has(kind)) throw new TypeError(`unsupported node kind: ${kind}`)
    return payload
  }
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new TypeError(`${kind}: unknown key ${key}`)
  return payload
}

export function assertObjectEnvelope(value) {
  for (const key of Object.keys(value)) if (!BASE_KEYS.includes(key)) throw new TypeError(`object: unknown key ${key}`)
  return value
}
