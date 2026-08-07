import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importExtantClaimCandidates, persistCandidateImport, snapshotClaimArtifact } from './claim-import.js'
import { buildMechanicRegistry, mechanicClaimAdapter } from './mechanic-claims.js'
import { recordPreV1ClaimObservations } from './legacy.js'
import { projectionRows, rebuildProjections } from './reducer.js'
import { NORMALIZED_CLAIM_TABLES, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'
import { GraphStore } from './store.js'
import { verifyGraphIpBoundary } from './workflow-lineage.js'

function graphCore(store) {
  return {
    objects: store.db.prepare('SELECT * FROM objects ORDER BY node_id').all(),
    nodes: store.db.prepare('SELECT * FROM nodes ORDER BY node_id').all(),
    edges: store.db.prepare('SELECT * FROM edges ORDER BY parent_node_id,child_node_id,edge_type').all(),
  }
}

export function replayProjectionCheck(store) {
  const replay = new DatabaseSync(':memory:')
  try {
    replay.exec(SCHEMA_SQL)
    const replayChecksum = rebuildProjections(replay, store.eventRows(), graphCore(store))
    const liveChecksum = store.projectionChecksum()
    return {
      integrity: store.verifyEvents(),
      projection_match: replayChecksum === liveChecksum,
      live_projection_checksum: liveChecksum,
      replay_projection_checksum: replayChecksum,
    }
  } finally {
    replay.close()
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function replaceLegacyClaimProjectionSchema(store) {
  const existing = NORMALIZED_CLAIM_TABLES.filter(table => tableExists(store.db, table))
  const groups = new Map()
  if (existing.includes('claim_occurrences') && existing.includes('semantic_claims')) {
    const columns = new Set(store.db.prepare('PRAGMA table_info(claim_occurrences)').all().map(row => row.name))
    const sourceIdentity = columns.has('source_snapshot_id') ? 'o.source_snapshot_id' : 'o.origin_id'
    const rows = store.db.prepare(`
      SELECT o.claim_occurrence_id,${sourceIdentity} AS source_identity,o.semantic_key,o.subject_ref,o.state,o.node_id,
             s.proposition_json,s.polarity,s.modality,
             COALESCE(ss.node_id,o.node_id) AS source_node_id
      FROM claim_occurrences o
      JOIN semantic_claims s USING(semantic_key)
      LEFT JOIN source_snapshots ss ON ss.id=${sourceIdentity}
      ORDER BY o.subject_ref,o.claim_occurrence_id
    `).all()
    for (const row of rows) {
      if (!groups.has(row.subject_ref)) groups.set(row.subject_ref, [])
      groups.get(row.subject_ref).push(row)
    }
  }
  const rowCount = existing.reduce((sum, table) => sum + Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0)
  for (const table of [...existing].reverse()) store.db.exec(`DROP TABLE IF EXISTS ${table}`)
  store.db.exec(SCHEMA_SQL)
  return { replaced_tables: existing.length, legacy_claim_projection_rows: rowCount, groups: [...groups] }
}

function importLegacyNormalizedClaims(store, groups) {
  const registry = buildMechanicRegistry()
  const results = []
  for (const [subject_ref, rows] of groups) {
    const artifactValue = {
      schema_version: 4,
      subject_ref,
      claims: rows.map(row => ({ claim_occurrence_id: row.claim_occurrence_id, semantic_key: row.semantic_key, state: row.state })),
    }
    const parents = [...new Set(rows.map(row => row.source_node_id))].sort()
    const origin = snapshotClaimArtifact(store, { subject_ref, origin_kind: 'historical-artifact', artifact_value: artifactValue, json_pointer: '/claims', parents })
    const assertions = rows.map((row, index) => ({
      extraction_local_id: `schema4-${index}`,
      proposition: JSON.parse(row.proposition_json),
      polarity: row.polarity,
      modality: row.modality,
      semantic_key: row.semantic_key,
      evidence: [{ kind: 'structured_path', origin_id: origin.origin_id, path_kind: 'json-pointer', path: `/claims/${index}` }],
      derivation_parent_claim_occurrence_ids: [],
    }))
    const candidateSemanticKeys = [...new Set(rows.map(row => row.semantic_key))].sort()
    results.push(persistCandidateImport(store, {
      origin,
      adapter: mechanicClaimAdapter,
      importer_contract_version: 'schema4-normalized-candidate-v1',
      registry_schema_sha256: registry.registry_schema_sha256,
      extractor_identity: { kind: 'legacy', artifact_node_id: origin.artifact_node_id, lineage_state: 'incomplete' },
      lineage_root_origin_ids: [origin.origin_id],
      assertions,
      unresolved: [{ kind: 'awaiting_evidence', canonical_focus: { origin_id: origin.origin_id, reason: 'schema4-origin-requires-current-source' }, candidate_semantic_keys: candidateSemanticKeys, blocks_obligations: ['retrieve', 'represent'] }],
      completeness: { state: 'incomplete', obligations_checked: ['retrieve', 'represent'] },
      artifact_parents: origin.artifact_parents,
    }))
  }
  return results
}

function importedCount(result) {
  if (!result) return 0
  return Number(result.ability_dsl?.imported ?? 0) + Number(result.legacy?.imported ?? 0) + Number(result.legacy?.residual_observations?.imported ?? 0) + Number(result.generated?.imported ?? 0)
}

function migrateCopy(store, { repo_root, import_candidates }) {
  let baseline = null
  let legacy = { excluded_pre_v1_claim_payload_count: 0 }
  let claimSchema = null
  let normalizedImports = []
  let migrated = false
  if (store.schemaVersion === 4) {
    claimSchema = replaceLegacyClaimProjectionSchema(store)
    legacy = recordPreV1ClaimObservations(store)
    const rows = projectionRows(store.db, { baseline: true })
    store.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION))
    store.schemaVersion = SCHEMA_VERSION
    baseline = store.appendEvent('projection-baseline-imported', { schema_version: SCHEMA_VERSION, rows }, { aggregate_kind: 'projection', aggregate_id: `schema-${SCHEMA_VERSION}` })
    normalizedImports = importLegacyNormalizedClaims(store, claimSchema.groups)
    migrated = true
  } else if (store.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`schema version ${store.schemaVersion} unsupported; migration requires schema 4`)
  }

  let candidates = null
  if (import_candidates) {
    const repository = store.db.prepare("SELECT node_id FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
    if (!repository) throw new Error('repository-version node required for candidate import')
    candidates = importExtantClaimCandidates(store, { repo_root, repository_version_node_id: repository.node_id })
  }
  const replay = replayProjectionCheck(store)
  if (!replay.projection_match) throw new Error('projection migration replay mismatch')
  return {
    migrated,
    schema_version: SCHEMA_VERSION,
    baseline_sequence: baseline?.sequence ?? null,
    legacy_claim_payload_count: legacy.excluded_pre_v1_claim_payload_count,
    claim_schema: claimSchema && {
      replaced_tables: claimSchema.replaced_tables,
      legacy_claim_projection_rows: claimSchema.legacy_claim_projection_rows,
      candidate_imports: normalizedImports.filter(result => !result.idempotent).length,
    },
    candidate_imports: candidates,
    changed: migrated || importedCount(candidates) > 0,
    replay,
  }
}

export function migrateGraphRoot({ graph_root, repo_root, raw_store_root, write = false, import_candidates = false }) {
  const stagingParent = mkdtempSync(join(dirname(graph_root), `.${basename(graph_root)}-migration-`))
  const stagedRoot = join(stagingParent, 'graph')
  const backupRoot = join(stagingParent, 'backup')
  cpSync(graph_root, stagedRoot, { recursive: true, preserveTimestamps: true })
  try {
    const inspection = new GraphStore(stagedRoot, { repositoryRoot: repo_root, migrationMode: true, readOnly: true, verify: false })
    let boundary
    let schemaVersion
    let legacyRows = 0
    try {
      schemaVersion = inspection.schemaVersion
      boundary = verifyGraphIpBoundary(inspection, raw_store_root)
      if (schemaVersion === 4) {
        legacyRows = NORMALIZED_CLAIM_TABLES.reduce((sum, table) => tableExists(inspection.db, table) ? sum + Number(inspection.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) : sum, 0)
      }
    } finally {
      inspection.close()
    }
    if (!boundary.clean) throw new Error(`IP boundary failed: ${boundary.violations.length} violation(s)`)
    if (!write) {
      return { migrated: false, dry_run: true, schema_version: schemaVersion, legacy_claim_projection_rows: legacyRows, import_candidates_requested: import_candidates, ip_boundary: boundary }
    }

    const staged = new GraphStore(stagedRoot, { repositoryRoot: repo_root, migrationMode: true })
    let result
    try {
      result = migrateCopy(staged, { repo_root, import_candidates })
    } finally {
      staged.close()
    }
    if (result.changed) {
      renameSync(graph_root, backupRoot)
      try {
        renameSync(stagedRoot, graph_root)
      } catch (error) {
        renameSync(backupRoot, graph_root)
        throw error
      }
      rmSync(backupRoot, { recursive: true, force: true })
    }
    return { ...result, dry_run: false, import_candidates_requested: import_candidates, ip_boundary: boundary }
  } finally {
    rmSync(stagingParent, { recursive: true, force: true })
  }
}
