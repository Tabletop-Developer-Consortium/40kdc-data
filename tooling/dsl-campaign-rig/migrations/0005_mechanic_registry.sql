CREATE TABLE mechanic_registry_revisions (
  revision_id TEXT PRIMARY KEY,
  parent_revision TEXT REFERENCES mechanic_registry_revisions(revision_id),
  corpus_root_hash TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  body_json BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE mechanic_registry_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision_id TEXT NOT NULL REFERENCES mechanic_registry_revisions(revision_id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE campaign_registry_promotions (
  campaign_id TEXT PRIMARY KEY,
  source_revision TEXT NOT NULL REFERENCES mechanic_registry_revisions(revision_id),
  promoted_revision TEXT NOT NULL REFERENCES mechanic_registry_revisions(revision_id),
  close_evidence_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX mechanic_registry_revisions_parent
  ON mechanic_registry_revisions(parent_revision);
