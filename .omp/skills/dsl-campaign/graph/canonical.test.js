import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, checkerCacheKey, nodeIdentity } from './canonical.js'

test('canonical JSON sorts objects and preserves arrays', () => {
  assert.equal(canonicalJson({ z: [3, 2, 1], a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":[3,2,1]}')
})

test('canonical JSON rejects unsupported JSON values', () => {
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol('x'), new Date()]) assert.throws(() => canonicalJson(value))
  const sparse = []
  sparse[1] = true
  assert.throws(() => canonicalJson(sparse), /sparse/)
})

test('node identity pins exact formula and sorted parents', () => {
  const parentA = 'a'.repeat(64)
  const parentB = 'b'.repeat(64)
  const one = nodeIdentity({ kind: 'decision', payload: { z: 1, a: 2 }, input_node_ids: [parentB, parentA], producer_contract_version: 1 })
  const two = nodeIdentity({ kind: 'decision', payload: { a: 2, z: 1 }, input_node_ids: [parentA, parentB], producer_contract_version: 1 })
  assert.deepEqual(one, two)
  assert.equal(one.content_hash, 'c2985c5ba6f7d2a55e768f92490ca09388e95bc4cccb9fdf11b15f4d42f93e73')
  assert.throws(() => nodeIdentity({ kind: 'x', payload: {}, input_node_ids: [parentA, parentA] }), /duplicate/)
})

test('checker cache includes every version dimension', () => {
  const base = { subject_node_id: 'x', checker_id: 'gate', checker_version: 1, schema_version: 1, describer_version: 1, policy_version: 1 }
  assert.notEqual(checkerCacheKey(base), checkerCacheKey({ ...base, policy_version: 2 }))
})
