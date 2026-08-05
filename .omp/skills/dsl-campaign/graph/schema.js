export const SCHEMA_VERSION = 2
export const PRODUCER_CONTRACT_VERSION = 1
export const FORMALIZATION_POLICY_VERSION = 1

const TABLES = [
  'source_snapshots', 'clause_maps', 'mechanic_signatures', 'tasks', 'attempts', 'leases',
  'checkpoints', 'decisions', 'findings', 'checks', 'certificates', 'ability_evidence',
  'family_templates', 'family_instances', 'construction_plans', 'apply_transactions',
  'legacy_observations',
]

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
`

const BASE_KEYS = ['kind', 'payload', 'input_node_ids', 'producer_contract_version', 'content_hash', 'node_id']

const OPEN_NODE_KINDS = new Set([
  'run', 'task', 'attempt', 'lease', 'checkpoint', 'decision', 'finding', 'check',
  'certificate', 'apply-transaction', 'family-template', 'family-instance', 'retrieval-match',
])
export const NODE_SCHEMAS = new Map([
  ['repository-version', ['workspace_hash', 'files', 'tool_versions', 'runner_hashes', 'schema_version', 'policy_version']],
  ['maintainer-decision', ['decision_id', 'state', 'text', 'authorizes_reuse']],
  ['legacy-observation', ['campaign_id', 'observation_type', 'status', 'summary', 'artifact_hashes', 'known_members', 'unknown_count', 'authorizes_reuse']],
  ['source-snapshot', ['faction_id', 'ability_id', 'store_key', 'provenance', 'byte_hash', 'clause_offsets']],
  ['clause-map', ['faction_id', 'ability_id', 'clauses']],
  ['mechanic-signature', ['faction_id', 'ability_id', 'signature']],
  ['source-formalization-certificate', ['faction_id', 'ability_id', 'status', 'fingerprints', 'claims']],
  ['candidate-certificate', ['faction_id', 'ability_id', 'status', 'fingerprints', 'checks']],
  ['certified-ability-evidence', ['faction_id', 'ability_id', 'status', 'reusable_fragment_ids', 'family_instance_ids', 'fingerprints']],
  ['construction-plan', ['faction_id', 'ability_id', 'source_claims', 'selected_parents', 'covered_claims', 'unmatched_claims', 'rejected_conflicts', 'new_specializations', 'composition_seams', 'required_checks']],
  ['workflow-output', ['output_kind', 'envelope', 'result']],
  ['invalid-output', ['run_id', 'task_id', 'classification', 'reason', 'output_hash']],
  ['intake-outcome', ['faction_id', 'ability_id', 'outcome', 'reason', 'fingerprints']],
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
