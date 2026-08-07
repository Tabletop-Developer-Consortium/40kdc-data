import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GraphStore } from './store.js'
import { acceptIntake, INTAKE_SELECTION_TEXT, prepareIntake, validateIntakeManifest } from './intake.js'

const repoRoot = resolve('.')
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile('_private/loop-state/claim-graph-intake-c004-c006-c008.json', 'utf8'))
function root() { return mkdtempSync(join(tmpdir(), 'intake-graph-')) }
function validOutcomes(prepared) {
  return prepared.prepared.entries.map(entry => ({
    faction_id: entry.faction_id, ability_id: entry.ability_id, envelope: entry.envelope,
    outcome: 'certified', reason: 'covered',
    source: { store_key: entry.ability_id, provenance: { kind: 'fixture' }, byte_hash: 'a'.repeat(64) },
    claims: [{ claim_occurrence_id: 'claim-1', actor: 'bearer', effect: 'fixture effect' }],
    coverage: { covered_claim_occurrence_ids: ['claim-1'], required_checks: ['schema'] }, unresolved_findings: [], approximation: false,
  }))
}


test('manifest is exact and current', () => {
  assert.equal(validateIntakeManifest(repoRoot, manifest).entries.length, 12)
  assert.throws(() => validateIntakeManifest(repoRoot, { ...manifest, entries: manifest.entries.slice(1) }), /exactly/)
})

test('prepare is idempotent and preallocates graph-issued leases', () => {
  const store = new GraphStore(root())
  const first = prepareIntake(store, { repoRoot, manifest })
  const second = prepareIntake(store, { repoRoot, manifest })
  assert.equal(first.runId, second.runId)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE event_type='intake-prepared'").get().n, 1)
  assert.equal(first.prepared.entries.length, 12)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM leases WHERE run_id=? AND state='active'").get(first.runId).n, 60)
  const decision = JSON.parse(store.db.prepare("SELECT payload_json FROM nodes WHERE kind='maintainer-decision'").get().payload_json)
  assert.equal(decision.text, INTAKE_SELECTION_TEXT)
  store.close()
})

test('accept records one terminal outcome and reusable evidence only for certified rows', () => {
  const store = new GraphStore(root())
  const prepared = prepareIntake(store, { repoRoot, manifest })
  const outcomes = prepared.prepared.entries.map((entry, index) => ({
    faction_id: entry.faction_id, ability_id: entry.ability_id, envelope: entry.envelope,
    outcome: index === 0 ? 'represented-gap' : 'certified', reason: index === 0 ? 'known approximation' : 'covered',
    source: { store_key: entry.ability_id, provenance: { kind: 'fixture' }, byte_hash: 'a'.repeat(64) },
    claims: [{ claim_occurrence_id: 'claim-1', actor: 'bearer', effect: 'fixture effect' }],
    coverage: { covered_claim_occurrence_ids: ['claim-1'], required_checks: ['schema'] }, unresolved_findings: [], approximation: index === 0,
  }))
  const result = { schema_version: 1, run_id: prepared.runId, manifest_hash: prepared.prepared.manifest_hash, outcomes }
  const accepted = acceptIntake(store, { repoRoot, result })
  assert.equal(accepted.outcomes.outcomes.length, 12)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM nodes WHERE kind='certified-ability-evidence'").get().n, 0)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM nodes WHERE kind='legacy-observation'").get().n, 11)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM ability_evidence WHERE state='represented-gap'").get().n, 1)
  assert.equal(acceptIntake(store, { repoRoot, result }).idempotent, true)
  store.close()
})

test('certification rejects incomplete coverage', () => {
  const store = new GraphStore(root())
  const prepared = prepareIntake(store, { repoRoot, manifest })
  const outcomes = prepared.prepared.entries.map(entry => ({ faction_id: entry.faction_id, ability_id: entry.ability_id, envelope: entry.envelope, outcome: 'certified', reason: 'bad', source: null }))
  assert.throws(() => acceptIntake(store, { repoRoot, result: { schema_version: 1, run_id: prepared.runId, manifest_hash: prepared.prepared.manifest_hash, outcomes } }), /gate incomplete/)
  store.close()
})

test('duplicate, missing, and unexpected intake keys fail before graph mutation', () => {
  for (const [label, mutate, pattern] of [
    ['duplicate', outcomes => [outcomes[0], outcomes[0], ...outcomes.slice(2)], /duplicate=/],
    ['missing', outcomes => outcomes.slice(1), /missing=/],
    ['unexpected', outcomes => [{ ...outcomes[0], faction_id: 'unexpected-faction' }, ...outcomes.slice(1)], /unexpected=/],
  ]) {
    const store = new GraphStore(root())
    const prepared = prepareIntake(store, { repoRoot, manifest })
    const before = {
      sequence: store.sequence(),
      nodes: Number(store.db.prepare('SELECT count(*) AS n FROM nodes').get().n),
      objects: Number(store.db.prepare('SELECT count(*) AS n FROM objects').get().n),
    }
    const result = { schema_version: 1, run_id: prepared.runId, manifest_hash: prepared.prepared.manifest_hash, outcomes: mutate(validOutcomes(prepared)) }
    assert.throws(() => acceptIntake(store, { repoRoot, result }), pattern, label)
    assert.deepEqual({
      sequence: store.sequence(),
      nodes: Number(store.db.prepare('SELECT count(*) AS n FROM nodes').get().n),
      objects: Number(store.db.prepare('SELECT count(*) AS n FROM objects').get().n),
    }, before)
    store.close()
  }
})
