PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS streams (
  stream_id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL REFERENCES streams(stream_id),
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  command_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(stream_id, stream_version),
  UNIQUE(command_id, event_type, stream_version)
);
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  result_first_seq INTEGER NOT NULL,
  result_last_seq INTEGER NOT NULL,
  result_sha256 TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_len INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  canonicalization TEXT NOT NULL,
  relative_cas_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(sensitivity, sha256)
);
CREATE TABLE IF NOT EXISTS artifact_parents (
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  parent_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  PRIMARY KEY(artifact_id, parent_artifact_id)
);
CREATE TABLE IF NOT EXISTS event_artifacts (
  global_seq INTEGER NOT NULL REFERENCES events(global_seq),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  relation TEXT NOT NULL,
  PRIMARY KEY(global_seq, artifact_id, relation)
);
CREATE TABLE IF NOT EXISTS leases (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','executing','observed','failed','unreconciled')),
  fencing_token INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  result_artifact_id TEXT REFERENCES artifacts(artifact_id),
  last_error_code TEXT
);
CREATE TABLE IF NOT EXISTS effect_receipts (
  idempotency_key TEXT PRIMARY KEY,
  effect_kind TEXT NOT NULL,
  observed_identity_json TEXT NOT NULL,
  observed_sha256 TEXT NOT NULL,
  completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  reducer_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, stream_version, reducer_version)
);
