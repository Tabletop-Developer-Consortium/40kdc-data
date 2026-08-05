import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { createExecutionEnvelope, sanitizeGraphPayload } from './workflow-lineage.js'
import { createRepositoryVersion } from './versions.js'

export const INTAKE_SELECTION_TEXT = 'maintainer selected all data-changing terminal entries from c004, c006, and c008 for intake; certification gates remain authoritative'
export const INTAKE_KEYS = [
  'aeldari/deceptive-feint-fateful-performance', 'aeldari/hallucinogen-grenades', 'aeldari/monofilament-web',
  'aeldari/titanic-strides', 'aeldari/tormentors', 'chaos-knights/super-heavy-walker',
  'imperial-knights/super-heavy-walker', 'necrons/power-matrix', 'orks/tuff-git-blitz-brigade',
  'thousand-sons/flow-of-magic', 'tyranids/untrammelled-ferocity-crusher-stampede',
  'world-eaters/super-heavy-war-engine',
]
const OUTCOMES = new Set(['certified', 'represented-gap', 'source-unavailable', 'refuted'])

function findAbility(repoRoot, entry) {
  const records = JSON.parse(readFileSync(join(repoRoot, entry.dsl_path), 'utf8'))
  return records.find(record => (record.ability_id ?? record.id) === entry.ability_id)
}

export function validateIntakeManifest(repoRoot, manifest) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.entries)) throw new TypeError('intake manifest schema_version 1 and entries required')
  const keys = manifest.entries.map(entry => `${entry.faction_id}/${entry.ability_id}`).sort()
  if (canonicalJson(keys) !== canonicalJson([...INTAKE_KEYS].sort())) throw new TypeError('intake manifest must contain exactly the selected 12 entries')
  for (const entry of manifest.entries) {
    if (Object.keys(entry).sort().join(',') !== 'ability_id,dsl_hash,dsl_path,faction_id') throw new TypeError(`manifest entry has non-allowlisted fields: ${entry.faction_id}/${entry.ability_id}`)
    const ability = findAbility(repoRoot, entry)
    if (!ability) throw new TypeError(`DSL ability missing: ${entry.faction_id}/${entry.ability_id}`)
    const actual = sha256(JSON.stringify(ability))
    if (actual !== entry.dsl_hash) throw new TypeError(`DSL hash mismatch: ${entry.faction_id}/${entry.ability_id}`)
  }
  return manifest
}

export function prepareIntake(store, { repoRoot, manifest }) {
  validateIntakeManifest(repoRoot, manifest)
  const manifestHash = sha256(canonicalJson(manifest))
  const runId = `intake-${manifestHash.slice(0, 16)}`
  const existing = store.db.prepare('SELECT state FROM runs WHERE run_id=?').get(runId)
  const repository = createRepositoryVersion(store, repoRoot, manifest.entries.map(entry => entry.dsl_path))
  const decision = store.createNode({ kind: 'maintainer-decision', payload: {
    decision_id: `${runId}-selection`, state: 'answered', text: INTAKE_SELECTION_TEXT, authorizes_reuse: false,
  }, input_node_ids: [repository.node.node_id] })
  const leaseExpiresAt = '2099-01-01T00:00:00.000Z'
  const entries = manifest.entries.map((entry, index) => {
    const ordinal = String(index + 1).padStart(2, '0')
    const taskId = `${runId}-task-${ordinal}`
    const execution_envelopes = {}
    for (const stage of ['who', 'when', 'what', 'refute']) {
      const label = `intake-${stage}:${entry.ability_id}`
      const stageTaskId = `${taskId}-${stage}`
      execution_envelopes[label] = createExecutionEnvelope({
        run_id: runId,
        task_id: stageTaskId,
        attempt_id: `${stageTaskId}-attempt-1`,
        lease_id: `${stageTaskId}-attempt-1-lease-1`,
        lease_expires_at: leaseExpiresAt,
        input_node_ids: [decision.node_id, repository.node.node_id],
      })
    }
    return {
      ...entry,
      envelope: createExecutionEnvelope({
        run_id: runId, task_id: taskId, attempt_id: `${taskId}-attempt-1`,
        lease_id: `${taskId}-attempt-1-lease-1`, lease_expires_at: leaseExpiresAt,
        input_node_ids: [decision.node_id, repository.node.node_id],
      }),
      execution_envelopes,
    }
  })
  if (!existing) {
    store.appendEvent('intake-prepared', { run_id: runId, manifest_hash: manifestHash, task_count: entries.length }, {
      aggregate_kind: 'run', aggregate_id: runId, node_id: decision.node_id,
      projection: (db, sequence) => {
        db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,source_hash) VALUES (?,?,?,?,?,?)').run(runId, runId, 'active', 'certification-intake', 'c004-c006-c008', manifestHash)
        for (const item of entries) {
          const envelopes = [item.envelope, ...Object.values(item.execution_envelopes)]
          for (const envelope of envelopes) {
            db.prepare('INSERT INTO tasks(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(envelope.task_id, runId, 'running', null, canonicalJson({ faction_id: item.faction_id, ability_id: item.ability_id }))
            db.prepare('INSERT INTO attempts(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(envelope.attempt_id, runId, 'running', null, '{}')
            db.prepare('INSERT INTO leases(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(envelope.lease_id, runId, 'active', null, canonicalJson({ task_id: envelope.task_id, attempt_id: envelope.attempt_id, expires_at: envelope.lease_expires_at }))
          }
        }
      },
    })
  }
  const prepared = sanitizeGraphPayload({ schema_version: 1, run_id: runId, manifest_hash: manifestHash, repository_node_id: repository.node.node_id, decision_node_id: decision.node_id, entries })
  const path = join(store.root, 'outbox', `${runId}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(prepared, null, 2)}\n`)
  return { runId, path, prepared, node_ids: [repository.node.node_id, decision.node_id] }
}

function sourceEntry(rawStoreRoot, entry) {
  const path = join(rawStoreRoot, `${entry.faction_id}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')).find(record => (record.ability_id ?? record.id) === entry.ability_id) || null
}

function clauseOffsets(text) {
  const offsets = []
  let start = 0
  for (const match of text.matchAll(/[.;](?:\s+|$)/g)) {
    offsets.push([start, match.index + 1])
    start = match.index + match[0].length
  }
  if (start < text.length) offsets.push([start, text.length])
  return offsets
}

export async function executePreparedIntake({ repoRoot, rawStoreRoot, prepared, analyze }) {
  const outcomes = []
  for (const entry of prepared.entries) {
    const source = sourceEntry(rawStoreRoot, entry)
    if (!source || typeof source.raw_text !== 'string' || !source.raw_text.trim()) {
      outcomes.push({ faction_id: entry.faction_id, ability_id: entry.ability_id, envelope: entry.envelope, outcome: 'source-unavailable', reason: 'current raw source unavailable', source: null })
      continue
    }
    const sourceMeta = { store_key: entry.ability_id, provenance: source.source || null, byte_hash: sha256(source.raw_text), clause_offsets: clauseOffsets(source.raw_text) }
    const analysis = await analyze({ entry, source_text: source.raw_text, source_meta: sourceMeta })
    outcomes.push(sanitizeGraphPayload({ faction_id: entry.faction_id, ability_id: entry.ability_id, envelope: entry.envelope, source: sourceMeta, ...analysis }, { source_texts: [source.raw_text] }))
  }
  return sanitizeGraphPayload({ schema_version: 1, run_id: prepared.run_id, manifest_hash: prepared.manifest_hash, outcomes })
}

export function acceptIntake(store, { repoRoot, result }) {
  if (result?.schema_version !== 1 || !Array.isArray(result.outcomes)) throw new TypeError('intake result must contain outcomes')
  const run = store.db.prepare('SELECT state,source_hash FROM runs WHERE run_id=?').get(result.run_id)
  if (!run || run.source_hash !== result.manifest_hash) throw new Error('intake result does not match prepared run')
  const prepared = JSON.parse(readFileSync(join(store.root, 'outbox', `${result.run_id}.json`), 'utf8'))
  const expected = new Map(prepared.entries.map(entry => [`${entry.faction_id}/${entry.ability_id}`, entry]))
  const actualKeys = result.outcomes.map(outcome => `${outcome.faction_id}/${outcome.ability_id}`)
  const duplicateKeys = [...new Set(actualKeys.filter((key, index) => actualKeys.indexOf(key) !== index))].sort()
  const actual = new Set(actualKeys)
  const missingKeys = [...expected.keys()].filter(key => !actual.has(key)).sort()
  const unexpectedKeys = [...actual].filter(key => !expected.has(key)).sort()
  if (duplicateKeys.length || missingKeys.length || unexpectedKeys.length) {
    throw new Error(`intake key mismatch: duplicate=[${duplicateKeys.join(',')}], missing=[${missingKeys.join(',')}], unexpected=[${unexpectedKeys.join(',')}]`)
  }
  const existing = store.db.prepare("SELECT count(*) AS n FROM tasks WHERE run_id=? AND state IN ('succeeded','failed-final','invalid-output')").get(result.run_id)
  if (Number(existing.n) === 12) return { idempotent: true, outcomes: intakeReport(store, result.run_id), node_ids: [] }
  const nodes = []
  for (const outcome of result.outcomes) {
    const key = `${outcome.faction_id}/${outcome.ability_id}`
    const item = expected.get(key)
    if (!item || canonicalJson(item.envelope) !== canonicalJson(outcome.envelope)) throw new Error(`intake lineage mismatch: ${key}`)
    if (!OUTCOMES.has(outcome.outcome)) throw new TypeError(`invalid intake outcome: ${key}`)
    if (outcome.outcome === 'certified' && (!outcome.source || !outcome.claims || !outcome.coverage || outcome.unresolved_findings?.length || outcome.approximation)) {
      throw new Error(`certification gate incomplete: ${key}`)
    }
    const parents = item.envelope.input_node_ids
    let terminalParents = parents
    if (outcome.source) {
      const source = store.createNode({ kind: 'source-snapshot', payload: { faction_id: outcome.faction_id, ability_id: outcome.ability_id, store_key: outcome.source.store_key, provenance: outcome.source.provenance, byte_hash: outcome.source.byte_hash, clause_offsets: outcome.source.clause_offsets }, input_node_ids: parents })
      nodes.push(source.node_id)
      terminalParents = [source.node_id]
    }
    if (outcome.outcome === 'certified') {
      const formal = store.createNode({ kind: 'source-formalization-certificate', payload: { faction_id: outcome.faction_id, ability_id: outcome.ability_id, status: 'certified', fingerprints: { dsl_hash: item.dsl_hash, manifest_hash: result.manifest_hash }, claims: outcome.claims }, input_node_ids: terminalParents, authorizes_reuse: true })
      const plan = store.createNode({ kind: 'construction-plan', payload: { faction_id: outcome.faction_id, ability_id: outcome.ability_id, source_claims: outcome.claims, selected_parents: [formal.node_id], covered_claims: outcome.coverage.covered_claims || outcome.claims.map(claim => claim.id), unmatched_claims: [], rejected_conflicts: [], new_specializations: [], composition_seams: outcome.coverage.composition_seams || [], required_checks: outcome.coverage.required_checks || [] }, input_node_ids: [formal.node_id], authorizes_reuse: true })
      const evidence = store.createNode({ kind: 'certified-ability-evidence', payload: { faction_id: outcome.faction_id, ability_id: outcome.ability_id, status: 'certified', reusable_fragment_ids: outcome.reusable_fragment_ids || [], family_instance_ids: outcome.family_instance_ids || [], fingerprints: { dsl_hash: item.dsl_hash, manifest_hash: result.manifest_hash } }, input_node_ids: [formal.node_id, plan.node_id], authorizes_reuse: true })
      nodes.push(formal.node_id, plan.node_id, evidence.node_id)
      terminalParents = [evidence.node_id]
    }
    const terminal = store.createNode({ kind: 'intake-outcome', payload: { faction_id: outcome.faction_id, ability_id: outcome.ability_id, outcome: outcome.outcome, reason: outcome.reason || null, fingerprints: { dsl_hash: item.dsl_hash, manifest_hash: result.manifest_hash } }, input_node_ids: terminalParents, authorizes_reuse: outcome.outcome === 'certified' })
    nodes.push(terminal.node_id)
    store.appendEvent('intake-outcome-recorded', { run_id: result.run_id, faction_id: outcome.faction_id, ability_id: outcome.ability_id, outcome: outcome.outcome }, {
      aggregate_kind: 'task', aggregate_id: item.envelope.task_id, node_id: terminal.node_id,
      projection: db => {
        db.prepare("UPDATE tasks SET state=?,node_id=? WHERE id=?").run(outcome.outcome === 'certified' ? 'succeeded' : 'failed-final', terminal.node_id, item.envelope.task_id)
        db.prepare("UPDATE attempts SET state=?,node_id=? WHERE id=?").run(outcome.outcome === 'certified' ? 'succeeded' : 'failed-final', terminal.node_id, item.envelope.attempt_id)
        db.prepare("UPDATE leases SET state='released' WHERE id=?").run(item.envelope.lease_id)
        db.prepare('INSERT OR REPLACE INTO ability_evidence(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(key, result.run_id, outcome.outcome, terminal.node_id, '{}')
      },
    })
  }
  store.appendEvent('intake-completed', { run_id: result.run_id, outcome_count: 12 }, { aggregate_kind: 'run', aggregate_id: result.run_id, projection: db => db.prepare("UPDATE runs SET state='completed',finished=? WHERE run_id=?").run(new Date().toISOString(), result.run_id) })
  return { idempotent: false, outcomes: intakeReport(store, result.run_id), node_ids: nodes }
}

export function intakeReport(store, runId = null) {
  const run = runId ? store.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId) : store.db.prepare("SELECT * FROM runs WHERE kind='certification-intake' ORDER BY rowid DESC LIMIT 1").get()
  if (!run) return { run: null, outcomes: [] }
  const outcomes = store.db.prepare('SELECT id,state,node_id FROM ability_evidence WHERE run_id=? ORDER BY id').all(run.run_id)
  return { run, outcomes }
}
