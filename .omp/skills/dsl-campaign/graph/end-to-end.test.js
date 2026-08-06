import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { acceptIntake, prepareIntake } from './intake.js'
import { bootstrapRegistry, recoverLegacy } from './legacy.js'
import { projectRegistry, reconcileAbilityCatalog } from './projection.js'
import { nextCampaignId, readiness, startCampaign } from './readiness.js'
import { wholeGraphPriorities } from './retrieval.js'
import { GraphStore } from './store.js'
import { repositoryVersionPayload } from './versions.js'
import { intakeManifest, legacyFixture } from './test-fixtures.js'

const repoRoot = resolve('.')
const manifest = intakeManifest(repoRoot)

function completeFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'graph-e2e-'))
  const { registryPath, loopStateRoot } = legacyFixture(temp)
  const store = new GraphStore(join(temp, 'graph'))
  bootstrapRegistry(store, { repoRoot, registryPath })
  const prepared = prepareIntake(store, { repoRoot, manifest })
  const outcomes = prepared.prepared.entries.map((entry, index) => ({
    faction_id: entry.faction_id, ability_id: entry.ability_id, envelope: entry.envelope,
    outcome: index === 1 ? 'represented-gap' : 'certified', reason: index === 1 ? 'known approximation remains represented' : 'fixture certification',
    source: { store_key: entry.ability_id, provenance: { kind: 'fixture' }, byte_hash: 'd'.repeat(64), clause_offsets: [[0, 1]] },
    claims: [{ id: 'claim-1', actor: 'bearer', affected_entity: 'target', event: 'fixture', producer_ports: [], consumer_ports: [], polarity: 'positive', quantifier: 'one', timing: 'event', duration: 'instant', scope: 'unit', ordering: 'ordered', restrictions: [], exclusions: [] }],
    coverage: { covered_claims: ['claim-1'], required_checks: ['schema', 'policy'] }, unresolved_findings: [], approximation: index === 1,
  }))
  for (const entry of prepared.prepared.entries) for (const envelope of Object.values(entry.execution_envelopes)) {
    store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(envelope.task_id)
    store.db.prepare("UPDATE attempts SET state='succeeded' WHERE id=?").run(envelope.attempt_id)
    store.db.prepare("UPDATE leases SET state='released' WHERE id=?").run(envelope.lease_id)
  }
  acceptIntake(store, { repoRoot, result: { schema_version: 1, run_id: prepared.runId, manifest_hash: prepared.prepared.manifest_hash, outcomes } })
  recoverLegacy(store, { repoRoot, loopStateRoot })
  const repository = store.db.prepare("SELECT node_id FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
  reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  projectRegistry(store, registryPath)
  return { store, registryPath }
}

test('fabricated full path reaches readiness and protects active claims', () => {
  const { store, registryPath } = completeFixture()
  const gate = readiness(store, { repoRoot, registryPath })
  assert.equal(gate.ready, true, gate.errors.join('; '))
  assert.equal(gate.next_campaign_id, nextCampaignId(store))
  assert.equal(gate.intake_outcomes, 12)
  assert.equal(gate.excluded_claims.filter(claim => claim.run_id === 'legacy-c005').length, 9)
  const campaignId = gate.next_campaign_id
  const worklist = [{ faction_id: 'fixture-faction', ability_id: 'fixture-ability' }]
  const sequence = store.sequence()
  const dry = startCampaign(store, { id: campaignId, repoRoot, registryPath, worklist, dryRun: true })
  assert.equal(dry.dry_run, true)
  assert.equal(store.sequence(), sequence)
  assert.deepEqual(dry.dag.map(task => task.kind), ['source-formalization', 'certified-retrieval', 'construction-plan', 'author'])
  const overlap = startCampaign(store, { id: campaignId, repoRoot, registryPath, worklist: [{ faction_id: 'aeldari', ability_id: 'far-reaching-doom' }], dryRun: false })
  assert.equal(overlap.started, false)
  assert.match(overlap.gate.errors.join(' '), /overlaps active claims/)
  store.close()
})

test('campaign IDs advance after completed graph runs', () => {
  const { store } = completeFixture()
  const campaignId = nextCampaignId(store)
  const next = `c${(BigInt(campaignId.slice(1)) + 1n).toString().padStart(3, '0')}`
  store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target) VALUES (?,?,?,?,?)')
    .run(campaignId, campaignId, 'completed', 'graph-backed', 'curated')
  assert.equal(nextCampaignId(store), next)
  store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target) VALUES (?,?,?,?,?)')
    .run('large', 'c9007199254740993', 'completed', 'graph-backed', 'curated')
  assert.equal(nextCampaignId(store), 'c9007199254740994')
  store.close()
})

test('readiness lists every referenced ability missing repository metadata', () => {
  const { store, registryPath } = completeFixture()
  const referenced = store.db.prepare('SELECT faction_id,ability_id FROM node_ability_refs ORDER BY faction_id,ability_id LIMIT 1').get()
  store.db.prepare('DELETE FROM ability_catalog WHERE faction_id=? AND ability_id=?').run(referenced.faction_id, referenced.ability_id)
  const key = `${referenced.faction_id}/${referenced.ability_id}`
  const gate = readiness(store, { repoRoot, registryPath })
  assert.equal(gate.ready, false)
  assert.ok(gate.missing_ability_metadata.includes(key))
  store.close()
})

test('non-dry start claims worklist and creates mandatory task DAG atomically', () => {
  const { store, registryPath } = completeFixture()
  const worklist = [{ faction_id: 'fixture-faction', ability_id: 'fixture-ability' }]
  const campaignId = nextCampaignId(store)
  const started = startCampaign(store, { id: campaignId, repoRoot, registryPath, worklist, dryRun: false })
  assert.equal(started.started, true)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM claims WHERE run_id=? AND state='active'").get(campaignId).n, 1)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks WHERE run_id=?').get(campaignId).n, 4)
  store.close()
})

test('active lease excludes a start-campaign task after its claim is released', () => {
  const { store, registryPath } = completeFixture()
  const worklist = [{ faction_id: 'fixture-faction', ability_id: 'fixture-ability' }]
  const campaignId = nextCampaignId(store)
  const started = startCampaign(store, { id: campaignId, repoRoot, registryPath, worklist, dryRun: false })
  assert.equal(started.started, true)
  store.db.prepare("UPDATE claims SET state='released' WHERE run_id=?").run(campaignId)
  const task = started.dag[0]
  store.db.prepare('INSERT INTO attempts(id,run_id,state,payload_json) VALUES (?,?,?,?)').run('attempt-active', campaignId, 'running', '{}')
  store.db.prepare('INSERT INTO leases(id,run_id,state,payload_json) VALUES (?,?,?,?)').run('lease-active', campaignId, 'active', JSON.stringify({ task_id: task.task_id, attempt_id: 'attempt-active', expires_at: '2099-01-01T00:00:00.000Z' }))
  const ranking = wholeGraphPriorities(store, {
    repoRoot,
    candidates: [{ faction_id: 'fixture-faction', ability_id: 'fixture-ability', effect: { type: 'invulnerable-save', target: 'unit', modifier: { invuln_sv: 5 } } }],
  })
  assert.equal(task.faction_id, 'fixture-faction')
  assert.deepEqual(ranking.eligible, [])
  assert.equal(ranking.excluded[0].exclusion_reason, 'active-claim-or-lease')
  store.close()
})

test('repository identity ignores operating-system metadata files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'graph-version-'))
  const goRoot = join(temp, 'go')
  mkdirSync(goRoot, { recursive: true })
  writeFileSync(join(goRoot, 'version.go'), 'package gofixture\n')
  const before = repositoryVersionPayload(temp)
  writeFileSync(join(goRoot, '.DS_Store'), `volatile-${Date.now()}`)
  const after = repositoryVersionPayload(temp)
  assert.equal(after.workspace_hash, before.workspace_hash)
})
