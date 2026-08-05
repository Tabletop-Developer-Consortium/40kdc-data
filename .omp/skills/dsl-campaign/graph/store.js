import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, nodeIdentity, sha256 } from './canonical.js'
import { assertAllowedNode, assertObjectEnvelope, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'
import { rebuildNodeAbilityRefs, reconcileAbilityCatalog } from './projection.js'
import { eventAffectsProjection } from './reducer.js'
import { sanitizeGraphPayload } from './workflow-lineage.js'

const ZERO_HASH = '0'.repeat(64)

function eventData({ sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, payload, payload_json, previous_event_hash }) {
  const encodedPayload = payload === undefined ? payload_json : payload
  return {
    sequence: Number(sequence),
    event_type,
    event_version: Number(event_version),
    aggregate_kind,
    aggregate_id,
    node_id,
    payload: typeof encodedPayload === 'string' ? JSON.parse(encodedPayload) : encodedPayload,
    previous_event_hash,
  }
}

function eventRecord(row) {
  return { ...eventData(row), event_hash: row.event_hash }
}

function eventHash(event) {
  return sha256(canonicalJson(eventData(event)))
}

function durableWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function objectFiles(root) {
  const base = join(root, 'objects')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true }).flatMap(prefix => {
    if (!prefix.isDirectory()) return []
    return readdirSync(join(base, prefix.name), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(base, prefix.name, entry.name))
  })
}

export class GraphStore {
  constructor(root = process.env.DSL_CLAIM_GRAPH_ROOT || '_private/claim-graph', { verify = true, repositoryRoot = process.cwd() } = {}) {
    this.root = root
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, 'index.sqlite'))
    this.db.exec(SCHEMA_SQL)
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION))
    const version = Number(this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value)
    if (version === 1 && SCHEMA_VERSION === 2) {
      const repository = this.db.prepare("SELECT node_id FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
      if (repository && existsSync(join(repositoryRoot, 'data'))) reconcileAbilityCatalog(this, repositoryRoot, repository.node_id)
      else rebuildNodeAbilityRefs(this)
      this.db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION))
    } else if (version !== SCHEMA_VERSION) throw new Error(`schema version ${version} unsupported`)
    if (verify) this.reconcile()
  }

  close() { this.db.close() }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }


  sequence() { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get().value) }

  objectPath(nodeId) { return join(this.root, 'objects', nodeId.slice(0, 2), `${nodeId}.json`) }

  hasNode(nodeId) { return Boolean(this.db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(nodeId)) }

  createNode({ kind, payload, input_node_ids = [], producer_contract_version = 1, edge_type = 'derived_from', authorizes_reuse = false, source_texts = [] }) {
    const safePayload = sanitizeGraphPayload(payload, { source_texts })
    assertAllowedNode(kind, safePayload)
    if (new Set(input_node_ids).size !== input_node_ids.length) throw new TypeError('duplicate parent node')
    for (const parent of input_node_ids) if (!this.hasNode(parent)) throw new Error(`missing parent node: ${parent}`)
    const identity = nodeIdentity({ kind, payload: safePayload, input_node_ids, producer_contract_version })
    const object = { kind, payload: safePayload, input_node_ids: [...input_node_ids].sort(), producer_contract_version, content_hash: identity.content_hash, node_id: identity.node_id }
    assertObjectEnvelope(object)
    const bytes = `${canonicalJson(object)}\n`
    const path = this.objectPath(identity.node_id)
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8')
      if (existing !== bytes) {
        const collision = join(this.root, 'quarantine', `collision-${identity.node_id}-${Date.now()}.json`)
        durableWrite(collision, existing)
        throw new Error(`object collision quarantined: ${identity.node_id}`)
      }
    } else durableWrite(path, bytes)
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)')
        .run(identity.node_id, identity.content_hash, kind, relative(this.root, path), sha256(bytes))
      this.db.prepare('INSERT OR IGNORE INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)')
        .run(identity.node_id, kind, producer_contract_version, canonicalJson(safePayload))
      for (const parent of input_node_ids) this.db.prepare('INSERT OR IGNORE INTO edges(parent_node_id,child_node_id,edge_type,authorizes_reuse,metadata_json) VALUES (?,?,?,?,?)')
        .run(parent, identity.node_id, edge_type, authorizes_reuse ? 1 : 0, '{}')
    })
    rebuildNodeAbilityRefs(this)
    return object
  }

  appendEvent(event_type, payload = {}, { event_version = 1, aggregate_kind = null, aggregate_id = null, node_id = null, projection = null } = {}) {
    const safe = sanitizeGraphPayload(payload)
    if (event_version !== 1) return this.quarantineUnsupported({ event_type, event_version, aggregate_kind, aggregate_id, node_id })
    const result = this.transaction(() => {
      const sequence = this.sequence() + 1
      const prior = this.db.prepare('SELECT event_hash FROM events ORDER BY sequence DESC LIMIT 1').get()
      const previous_event_hash = prior?.event_hash || ZERO_HASH
      const event_hash = eventHash({ sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, payload: safe, previous_event_hash })
      this.db.prepare('INSERT INTO events(sequence,event_type,event_version,aggregate_kind,aggregate_id,node_id,payload_json,previous_event_hash,event_hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, canonicalJson(safe), previous_event_hash, event_hash)
      if (projection) projection(this.db, sequence)
      this.db.prepare("INSERT INTO progress(name,sequence,checksum) VALUES ('events',?,?) ON CONFLICT(name) DO UPDATE SET sequence=excluded.sequence,checksum=excluded.checksum")
        .run(sequence, event_hash)
      return { sequence, event_hash, previous_event_hash }
    })
    this.syncMirror()
    if (eventAffectsProjection(event_type)) rebuildNodeAbilityRefs(this)
    return result
  }

  quarantineUnsupported(metadata) {
    const safe = sanitizeGraphPayload(metadata)
    this.transaction(() => {
      this.db.prepare('INSERT INTO quarantine_events(created_at,reason,raw_metadata_json) VALUES (?,?,?)')
        .run(new Date().toISOString(), 'unsupported-event-version', canonicalJson(safe))
      if (safe.aggregate_kind === 'run' && safe.aggregate_id) {
        this.db.prepare("UPDATE runs SET state='paused',paused_reason='unsupported-event-version' WHERE run_id=? AND state NOT IN ('completed','aborted','superseded','failed-final')").run(safe.aggregate_id)
      }
    })
    return { quarantined: true }
  }

  eventRows() { return this.db.prepare('SELECT * FROM events ORDER BY sequence').all() }

  mirrorBytes() {
    return this.eventRows().map(row => `${canonicalJson(eventRecord(row))}\n`).join('')
  }

  syncMirror() {
    const expected = this.mirrorBytes()
    const path = join(this.root, 'events.jsonl')
    if (!existsSync(path) || readFileSync(path, 'utf8') !== expected) durableWrite(path, expected)
  }

  verifyEvents() {
    let prior = ZERO_HASH
    let expectedSequence = 1
    for (const row of this.eventRows()) {
      if (Number(row.sequence) !== expectedSequence) throw new Error(`event sequence gap at ${expectedSequence}`)
      if (row.previous_event_hash !== prior) throw new Error(`previous event hash mismatch at ${expectedSequence}`)
      const expected = eventHash({ ...row, sequence: expectedSequence, previous_event_hash: prior })
      if (row.event_hash !== expected) throw new Error(`event hash mismatch at ${expectedSequence}`)
      prior = row.event_hash
      expectedSequence += 1
    }
    return { sequence: expectedSequence - 1, checksum: prior }
  }

  reconcile() {
    const integrity = this.verifyEvents()
    const indexed = new Map(this.db.prepare('SELECT * FROM objects').all().map(row => [row.node_id, row]))
    for (const [nodeId, row] of indexed) {
      const path = join(this.root, row.relative_path)
      if (!existsSync(path)) throw new Error(`missing referenced object: ${nodeId}`)
      const bytes = readFileSync(path, 'utf8')
      if (sha256(bytes) !== row.byte_hash) throw new Error(`object/index hash disagreement: ${nodeId}`)
      const parsed = JSON.parse(bytes)
      if (parsed.node_id !== nodeId || parsed.content_hash !== row.content_hash) throw new Error(`object identity disagreement: ${nodeId}`)
    }
    for (const path of objectFiles(this.root)) {
      const nodeId = path.slice(path.lastIndexOf('/') + 1, -5)
      if (!indexed.has(nodeId)) {
        const quarantine = join(this.root, 'quarantine', `orphan-${nodeId}.json`)
        mkdirSync(dirname(quarantine), { recursive: true })
        renameSync(path, quarantine)
      }
    }
    this.syncMirror()
    return integrity
  }

  replayChecksum() {
    const rows = this.db.prepare('SELECT event_hash FROM events ORDER BY sequence').all().map(row => row.event_hash)
    return sha256(canonicalJson(rows))
  }

  projectionChecksum() {
    const catalog = this.db.prepare('SELECT * FROM ability_catalog ORDER BY faction_id,ability_id').all().map(row => ({ ...row }))
    const refs = this.db.prepare('SELECT * FROM node_ability_refs ORDER BY node_id,faction_id,ability_id').all().map(row => ({ ...row }))
    return sha256(canonicalJson({ catalog, refs }))
  }
}

export function resetGraphRoot(root) {
  if (existsSync(root) && statSync(root).isDirectory()) rmSync(root, { recursive: true, force: true })
}
