import { createHash } from 'node:crypto'

function assertJsonValue(value, path = '$') {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`)
    return
  }
  if (type !== 'object') throw new TypeError(`${path}: unsupported ${type}`)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${path}: sparse array`)
      assertJsonValue(value[index], `${path}[${index}]`)
    }
    return
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${path}: non-plain object`)
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`)
}

export function canonicalJson(value) {
  assertJsonValue(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function nodeIdentity({ kind, payload, input_node_ids = [], producer_contract_version = 1 }) {
  if (typeof kind !== 'string' || !kind) throw new TypeError('kind required')
  if (!Number.isInteger(producer_contract_version) || producer_contract_version < 1) {
    throw new TypeError('producer_contract_version must be a positive integer')
  }
  if (!Array.isArray(input_node_ids) || input_node_ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throw new TypeError('input_node_ids must contain lowercase SHA-256 ids')
  }
  if (new Set(input_node_ids).size !== input_node_ids.length) throw new TypeError('duplicate parent node')
  const content_hash = sha256(canonicalJson(payload))
  const identity = { kind, content_hash, input_node_ids: [...input_node_ids].sort(), producer_contract_version }
  return { content_hash, node_id: sha256(canonicalJson(identity)), identity }
}

export function checkerCacheKey({ subject_node_id, checker_id, checker_version, schema_version, describer_version, policy_version }) {
  return sha256(canonicalJson({ subject_node_id, checker_id, checker_version, schema_version, describer_version, policy_version }))
}
