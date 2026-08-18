import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { nodeIdentity } from './canonical.js'
import { PRODUCER_CONTRACT_VERSION } from './schema.js'

const PROHIBITED_KEY = /^(raw_text|original_rule|prompt|transcript|prose|source_text|verbatim|messages?)$/i
const ENVELOPE_KEYS = [
  'run_id', 'task_id', 'attempt_id', 'lease_id', 'lease_expires_at', 'input_node_ids',
  'producer_contract_version',
]

function normalizeWords(text) {
  return text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []
}

function sourceSpans(sourceTexts) {
  const spans = new Set()
  for (const source of sourceTexts) {
    const words = normalizeWords(source)
    for (let index = 0; index + 12 <= words.length; index += 1) spans.add(words.slice(index, index + 12).join(' '))
  }
  return spans
}

export function sanitizeGraphPayload(value, { source_texts = [] } = {}) {
  const spans = sourceSpans(source_texts)
  const visit = (item, path) => {
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError(`${path}: non-finite number`)
      return item
    }
    if (typeof item === 'string') {
      const words = normalizeWords(item)
      for (let index = 0; index + 12 <= words.length; index += 1) {
        if (spans.has(words.slice(index, index + 12).join(' '))) throw new TypeError(`${path}: contains 12-word source span`)
      }
      return item
    }
    if (typeof item !== 'object') throw new TypeError(`${path}: unsupported ${typeof item}`)
    if (Array.isArray(item)) {
      if (item.some((_, index) => !Object.hasOwn(item, index))) throw new TypeError(`${path}: sparse array`)
      return item.map((child, index) => visit(child, `${path}[${index}]`))
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError(`${path}: non-plain object`)
    const result = {}
    for (const [key, child] of Object.entries(item)) {
      if (PROHIBITED_KEY.test(key)) throw new TypeError(`${path}.${key}: prohibited IP field`)
      result[key] = visit(child, `${path}.${key}`)
    }
    return result
  }
  return visit(value, '$')
}

export function assertInputEnvelope(envelope, expected = null, { now = Date.now() } = {}) {
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype) throw new TypeError('lineage envelope required')
  for (const key of Object.keys(envelope)) if (!ENVELOPE_KEYS.includes(key)) throw new TypeError(`unknown envelope key ${key}`)
  for (const key of ['run_id', 'task_id', 'attempt_id', 'lease_id', 'lease_expires_at']) {
    if (typeof envelope[key] !== 'string' || !envelope[key]) throw new TypeError(`${key} required`)
  }
  if (!Array.isArray(envelope.input_node_ids) || new Set(envelope.input_node_ids).size !== envelope.input_node_ids.length) {
    throw new TypeError('unique input_node_ids required')
  }
  if (envelope.producer_contract_version !== PRODUCER_CONTRACT_VERSION) throw new TypeError('producer contract mismatch')
  const expiry = Date.parse(envelope.lease_expires_at)
  if (!Number.isFinite(expiry) || expiry <= now) throw new TypeError('lease expired')
  if (expected) {
    for (const key of ENVELOPE_KEYS) {
      if (JSON.stringify(envelope[key]) !== JSON.stringify(expected[key])) throw new TypeError(`lineage mismatch: ${key}`)
    }
  }
  return envelope
}

export function sealOutput(kind, payload, envelope, options = {}) {
  assertInputEnvelope(envelope, options.expected, options)
  const result = sanitizeGraphPayload(payload, options)
  const identity = nodeIdentity({
    kind: 'workflow-output',
    payload: { output_kind: kind, envelope, result },
    input_node_ids: envelope.input_node_ids,
    producer_contract_version: envelope.producer_contract_version,
  })
  return {
    kind: 'workflow-output',
    payload: { output_kind: kind, envelope, result },
    input_node_ids: envelope.input_node_ids,
    producer_contract_version: envelope.producer_contract_version,
    ...identity,
    output_node_id: identity.node_id,
  }
}

export function createExecutionEnvelope({ run_id, task_id, attempt_id, lease_id, lease_expires_at, input_node_ids = [] }) {
  return { run_id, task_id, attempt_id, lease_id, lease_expires_at, input_node_ids, producer_contract_version: PRODUCER_CONTRACT_VERSION }
}

function pointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1')
}

function normalizedProhibitedText(value) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function prohibitedStoreStrings(storePath) {
  const indexPath = existsSync(storePath) && statSync(storePath).isDirectory() ? join(storePath, 'index.json') : storePath
  if (!existsSync(indexPath)) throw new Error(`raw-text store missing: ${storePath}`)
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  if (!index?.factions || typeof index.factions !== 'object') throw new TypeError('raw-text store index requires factions')
  const entries = []
  const collect = (value, storeKey) => {
    if (typeof value === 'string') {
      const normalized = normalizedProhibitedText(value)
      if (normalized) entries.push({ store_key: storeKey, text: normalized })
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) collect(child, storeKey)
      return
    }
    if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child, storeKey)
  }
  for (const [factionId, abilities] of Object.entries(index.factions)) {
    if (!abilities || typeof abilities !== 'object') continue
    for (const [abilityId, entry] of Object.entries(abilities)) {
      if (!entry || typeof entry !== 'object') continue
      const storeKey = `${factionId}/${abilityId}`
      for (const field of ['raw_text', 'when', 'target', 'effect', 'restrictions']) if (Object.hasOwn(entry, field)) collect(entry[field], storeKey)
    }
  }
  return entries.sort((a, b) => a.store_key.localeCompare(b.store_key) || a.text.localeCompare(b.text))
}

export function verifyGraphIpBoundary(store, storePath) {
  const prohibited = prohibitedStoreStrings(storePath)
  const violations = []
  const scan = (value, recordType, recordId, path = '') => {
    if (typeof value === 'string') {
      const normalized = normalizedProhibitedText(value)
      for (const entry of prohibited) {
        if (normalized === entry.text || normalized.includes(entry.text)) {
          violations.push({ record_type: recordType, record_id: recordId, json_pointer: path || '/', store_key: entry.store_key })
        }
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => scan(child, recordType, recordId, `${path}/${index}`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) scan(child, recordType, recordId, `${path}/${pointerToken(key)}`)
    }
  }
  for (const row of store.db.prepare('SELECT node_id,payload_json FROM nodes ORDER BY node_id').all()) scan(JSON.parse(row.payload_json), 'node', row.node_id)
  for (const row of store.db.prepare('SELECT event_hash,payload_json FROM events ORDER BY sequence').all()) scan(JSON.parse(row.payload_json), 'event', row.event_hash)
  return { clean: violations.length === 0, prohibited_entry_count: prohibited.length, violations }
}
