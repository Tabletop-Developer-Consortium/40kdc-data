import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, nodeIdentity, sha256 } from './canonical.js'
import {
  assertAllowedEdgeType,
  assertAllowedEvent,
  assertAllowedNode,
  assertObjectEnvelope,
  PRODUCER_CONTRACT_VERSION,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './schema.js'
import { applyEvent, finalizeProjectionState, projectionChecksum as fullProjectionChecksum } from './reducer.js'
import { sanitizeGraphPayload } from './workflow-lineage.js'

const ZERO_HASH = '0'.repeat(64)

function eventData({ sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, payload, payload_json, previous_event_hash }) {
  const encodedPayload = payload === undefined ? JSON.parse(payload_json || '{}') : payload
  return {
    sequence: Number(sequence), event_type, event_version: Number(event_version), aggregate_kind: aggregate_kind ?? null,
    aggregate_id: aggregate_id ?? null, node_id: node_id ?? null, payload: encodedPayload, previous_event_hash,
  }
}

function eventRecord(row) {
  return { ...eventData(row), event_hash: row.event_hash }
}

function eventHash(event) {
  return sha256(canonicalJson(eventData(event)))
}

function durableWrite(path, bytes, synchronize = true) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    if (synchronize) fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  if (synchronize) {
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

function synchronizeBulkWrites(paths) {
  try {
    execFileSync('sync')
    return
  } catch {
    // Windows has no `sync`; retain the same durability contract file by file.
  }
  const directories = new Set()
  for (const path of paths) {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    directories.add(dirname(path))
  }
  for (const directoryPath of directories) {
    const directory = openSync(directoryPath, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

function objectFiles(root) {
  const base = join(root, 'objects')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true }).flatMap(prefix => {
    const directory = join(base, prefix.name)
    if (!prefix.isDirectory()) return []
    return readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith('.json')).map(file => join(directory, file.name))
  })
}

function canonicalParent(parent) {
  if (!parent || Object.getPrototypeOf(parent) !== Object.prototype) throw new TypeError('parent must be a plain object')
  const allowed = new Set(['node_id', 'edge_type', 'authorizes_reuse', 'metadata'])
  for (const key of Object.keys(parent)) if (!allowed.has(key)) throw new TypeError(`parent: unknown key ${key}`)
  if (typeof parent.node_id !== 'string' || !parent.node_id) throw new TypeError('parent node_id required')
  assertAllowedEdgeType(parent.edge_type)
  if (parent.authorizes_reuse !== undefined && typeof parent.authorizes_reuse !== 'boolean') throw new TypeError('parent authorizes_reuse must be boolean')
  const metadata = parent.metadata ?? {}
  if (Object.getPrototypeOf(metadata) !== Object.prototype) throw new TypeError('parent metadata must be a plain object')
  return {
    node_id: parent.node_id,
    edge_type: parent.edge_type,
    authorizes_reuse: parent.authorizes_reuse === true,
    metadata,
  }
}

export class GraphStore {
  constructor(root = process.env.DSL_CLAIM_GRAPH_ROOT || '_private/claim-graph', { verify = true, repositoryRoot = process.cwd(), migrationMode = false, readOnly = false } = {}) {
    this.root = root
    this.repositoryRoot = repositoryRoot
    this.migrationMode = migrationMode
    this.readOnly = readOnly
    this.transactionDepth = 0
    this.createdObjectPaths = null
    this.mirrorDirty = false
    this.projectionRefsDirty = false
    if (!readOnly) mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, 'index.sqlite'), readOnly ? { readOnly: true } : {})
    const existingSchema = (() => {
      try { return this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() }
      catch { return null }
    })()
    if (!readOnly && !(migrationMode && existingSchema && Number(existingSchema.value) !== SCHEMA_VERSION)) {
      this.db.exec(SCHEMA_SQL)
      this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION))
    }
    const schema = existingSchema ?? this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
    if (!schema) throw new Error('graph schema_version missing')
    this.schemaVersion = Number(schema.value)
    if (this.schemaVersion === 4 && !migrationMode) throw new Error('schema version 4 requires migrate-projections')
    if (this.schemaVersion !== SCHEMA_VERSION && !(migrationMode && this.schemaVersion === 4)) {
      throw new Error(`schema version ${this.schemaVersion} unsupported; migration requires schema 4`)
    }
    if (verify) this.reconcile()
  }


  assertWritable() {
    if (this.readOnly) throw new Error('graph store is read-only')
  }
  close() { this.db.close() }

  transaction(callback) {
    this.assertWritable()
    if (this.transactionDepth > 0) return callback()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth = 1
    this.createdObjectPaths = new Set()
    const priorMirrorDirty = this.mirrorDirty
    const priorProjectionRefsDirty = this.projectionRefsDirty
    try {
      const result = callback()
      if (this.migrationMode && this.createdObjectPaths.size > 0) {
        synchronizeBulkWrites(this.createdObjectPaths)
      }
      if (this.projectionRefsDirty) finalizeProjectionState(this.db)
      this.db.exec('COMMIT')
      this.transactionDepth = 0
      this.createdObjectPaths = null
      this.projectionRefsDirty = false
      if (this.mirrorDirty) {
        this.syncMirror()
        this.mirrorDirty = false
      }
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      for (const path of this.createdObjectPaths) {
        try { unlinkSync(path) } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError
        }
      }
      this.transactionDepth = 0
      this.createdObjectPaths = null
      this.mirrorDirty = priorMirrorDirty
      this.projectionRefsDirty = priorProjectionRefsDirty
      throw error
    }
  }

  sequence() { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM events').get().value) }

  objectPath(nodeId) { return join(this.root, 'objects', nodeId.slice(0, 2), `${nodeId}.json`) }

  hasNode(nodeId) { return Boolean(this.db.prepare('SELECT 1 FROM nodes WHERE node_id=?').get(nodeId)) }

  createNode(options) {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw new TypeError('createNode options must be a plain object')
    const allowed = new Set(['kind', 'payload', 'parents', 'producer_contract_version', 'source_texts'])
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`createNode: unknown key ${key}`)
    const { kind, payload, parents = [], producer_contract_version = PRODUCER_CONTRACT_VERSION, source_texts = [] } = options
    if (!Array.isArray(parents)) throw new TypeError('parents must be an array')
    const canonicalParents = parents.map(canonicalParent).sort((left, right) => left.node_id.localeCompare(right.node_id) || left.edge_type.localeCompare(right.edge_type))
    const inputNodeIds = canonicalParents.map(parent => parent.node_id)
    if (new Set(inputNodeIds).size !== inputNodeIds.length) throw new TypeError('duplicate parent node')
    for (const parent of canonicalParents) if (!this.hasNode(parent.node_id)) throw new Error(`missing parent node: ${parent.node_id}`)
    const safePayload = sanitizeGraphPayload(payload, { source_texts })
    assertAllowedNode(kind, safePayload)
    const identity = nodeIdentity({ kind, payload: safePayload, input_node_ids: inputNodeIds, producer_contract_version })
    const object = {
      kind,
      payload: safePayload,
      input_node_ids: [...inputNodeIds].sort(),
      producer_contract_version,
      content_hash: identity.content_hash,
      node_id: identity.node_id,
    }
    assertObjectEnvelope(object)
    const bytes = `${canonicalJson(object)}\n`
    const path = this.objectPath(identity.node_id)
    return this.transaction(() => {
      if (existsSync(path)) {
        const existing = readFileSync(path, 'utf8')
        if (existing !== bytes) {
          const collision = join(this.root, 'quarantine', `collision-${identity.node_id}-${Date.now()}.json`)
          durableWrite(collision, existing)
          throw new Error(`object collision quarantined: ${identity.node_id}`)
        }
      } else {
        durableWrite(path, bytes, !this.migrationMode)
        this.createdObjectPaths.add(path)
      }
      this.db.prepare('INSERT OR IGNORE INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)')
        .run(identity.node_id, identity.content_hash, kind, relative(this.root, path), sha256(bytes))
      this.db.prepare('INSERT OR IGNORE INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)')
        .run(identity.node_id, kind, producer_contract_version, canonicalJson(safePayload))
      for (const parent of canonicalParents) {
        const safeMetadata = sanitizeGraphPayload(parent.metadata, { source_texts })
        this.db.prepare('INSERT OR IGNORE INTO edges(parent_node_id,child_node_id,edge_type,authorizes_reuse,metadata_json) VALUES (?,?,?,?,?)')
          .run(parent.node_id, identity.node_id, parent.edge_type, parent.authorizes_reuse ? 1 : 0, canonicalJson(safeMetadata))
      }
      return object
    })
  }

  appendEvent(event_type, payload = {}, options = {}) {
    if (Object.hasOwn(options, 'projection')) throw new TypeError('appendEvent projection option is not supported')
    const { event_version = 1, aggregate_kind = null, aggregate_id = null, node_id = null } = options
    const safe = sanitizeGraphPayload(payload)
    assertAllowedEvent(event_type, safe, { event_version, aggregate_kind, aggregate_id })
    if (node_id !== null && !this.hasNode(node_id)) throw new Error(`missing event node: ${node_id}`)
    return this.transaction(() => {
      const sequence = this.sequence() + 1
      const prior = this.db.prepare('SELECT event_hash FROM events ORDER BY sequence DESC LIMIT 1').get()
      const previous_event_hash = prior?.event_hash || ZERO_HASH
      const event_hash = eventHash({ sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, payload: safe, previous_event_hash })
      const event = { sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, payload: safe, previous_event_hash, event_hash }
      this.db.prepare('INSERT INTO events(sequence,event_type,event_version,aggregate_kind,aggregate_id,node_id,payload_json,previous_event_hash,event_hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sequence, event_type, event_version, aggregate_kind, aggregate_id, node_id, canonicalJson(safe), previous_event_hash, event_hash)
      applyEvent(this.db, event, { rebuild_refs: false, finalize_projection: false })
      this.projectionRefsDirty = true
      this.db.prepare("INSERT INTO progress(name,sequence,checksum) VALUES ('events',?,?) ON CONFLICT(name) DO UPDATE SET sequence=excluded.sequence,checksum=excluded.checksum")
        .run(sequence, event_hash)
      this.mirrorDirty = true
      return { sequence, event_hash, previous_event_hash }
    })
  }

  quarantineUnsupported(metadata) {
    const safe = sanitizeGraphPayload(metadata)
    this.transaction(() => {
      this.db.prepare('INSERT INTO quarantine_events(created_at,reason,raw_metadata_json) VALUES (?,?,?)')
        .run(new Date().toISOString(), 'unsupported-event-version', canonicalJson(safe))
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
        if (this.readOnly) throw new Error(`orphan object in read-only graph: ${nodeId}`)
        const quarantine = join(this.root, 'quarantine', `orphan-${nodeId}.json`)
        mkdirSync(dirname(quarantine), { recursive: true })
        renameSync(path, quarantine)
      }
    }
    if (!this.readOnly) this.syncMirror()
    return integrity
  }

  replayChecksum() {
    const rows = this.db.prepare('SELECT event_hash FROM events ORDER BY sequence').all().map(row => row.event_hash)
    return sha256(canonicalJson(rows))
  }

  projectionChecksum() { return fullProjectionChecksum(this.db) }
}

export function resetGraphRoot(root) {
  if (existsSync(root) && statSync(root).isDirectory()) rmSync(root, { recursive: true, force: true })
}
