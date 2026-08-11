CREATE TABLE IF NOT EXISTS projection_checkpoints (
  name TEXT PRIMARY KEY,
  global_seq INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_status (
  campaign_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  manifest_hash TEXT,
  sealed_head TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ability_ledger (
  campaign_id TEXT NOT NULL,
  faction_id TEXT NOT NULL,
  ability_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  candidate_hash TEXT,
  applied_hash TEXT,
  verification_hash TEXT,
  PRIMARY KEY(campaign_id, faction_id, ability_id)
);
CREATE TABLE IF NOT EXISTS shape_ledger (
  campaign_id TEXT NOT NULL,
  shape_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  review_round INTEGER NOT NULL,
  package_hash TEXT,
  PRIMARY KEY(campaign_id, shape_id)
);
CREATE TABLE IF NOT EXISTS ready_work (
  work_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  priority INTEGER NOT NULL,
  available_at INTEGER NOT NULL
);
