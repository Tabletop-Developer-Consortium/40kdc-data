import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bootstrapRegistry, campaignView, recoverLegacy } from './legacy.js'
import { projectRegistry, verifyProjection } from './projection.js'
import { GraphStore } from './store.js'

const repoRoot = resolve('.')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-graph-'))
  const registryPath = join(root, 'registry.json')
  copyFileSync('_private/loop-state/registry.json', registryPath)
  const store = new GraphStore(join(root, 'graph'))
  return { root, registryPath, store }
}

test('bootstrap imports all allowlisted state and migrates c005 claims', () => {
  const { store, registryPath } = fixture()
  const first = bootstrapRegistry(store, { repoRoot, registryPath })
  const second = bootstrapRegistry(store, { repoRoot, registryPath })
  assert.equal(first.idempotent, false)
  assert.equal(second.idempotent, true)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM claims WHERE run_id='legacy-c005' AND state='active'").get().n, 9)
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='registry_writer_frozen'").get().value, '1')
  store.close()
})

test('legacy recovery preserves c007-c009 without granting authority', () => {
  const { store, registryPath } = fixture()
  bootstrapRegistry(store, { repoRoot, registryPath })
  const first = recoverLegacy(store, { repoRoot })
  const sequence = store.sequence()
  const second = recoverLegacy(store, { repoRoot })
  assert.equal(first.idempotent, false)
  assert.equal(second.idempotent, true)
  assert.equal(store.sequence(), sequence)
  const c007 = campaignView(store, 'c007')
  assert.equal(c007.run.state, 'aborted')
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM certificates WHERE run_id='legacy-c007'").get().n, 0)
  const c008 = campaignView(store, 'c008')
  assert.equal(c008.observations.length, 4)
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM edges WHERE edge_type='corresponds_to_current_implementation' AND authorizes_reuse=0").get().n, 2)
  const c009 = campaignView(store, 'c009')
  assert.equal(c009.run.state, 'superseded')
  assert.equal(c009.claims.filter(claim => claim.state === 'released').length, 6)
  assert.ok(c009.events.some(event => event.event_type === 'run-superseded'))
  store.close()
})

test('registry projection is byte-stable and maps superseded to aborted', () => {
  const { store, registryPath } = fixture()
  bootstrapRegistry(store, { repoRoot, registryPath })
  recoverLegacy(store, { repoRoot })
  const first = projectRegistry(store, registryPath)
  const second = projectRegistry(store, registryPath)
  assert.equal(first.hash, second.hash)
  assert.equal(second.changed, false)
  assert.equal(second.projection.campaigns.find(campaign => campaign.id === 'c009').status, 'aborted')
  assert.equal(verifyProjection(store, registryPath).ok, true)
  store.close()
})
