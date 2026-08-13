CREATE TABLE reusable_read_only_evidence (
  identity_hash TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  normalized_dsl_hash TEXT NOT NULL,
  semantic_validator_hash TEXT NOT NULL,
  prompt_manifest_hash TEXT NOT NULL,
  role_schema_hashes_json BLOB NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX reusable_evidence_source_dsl
  ON reusable_read_only_evidence(source_hash, normalized_dsl_hash);
