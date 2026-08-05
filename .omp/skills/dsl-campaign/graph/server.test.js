import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { reconcileAbilityCatalog } from './projection.js'
import { createMechanicGraphServer } from './server.js'

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mechanic-graph-server-repo-'))
  const root = join(repoRoot, 'graph')
  mkdirSync(join(repoRoot, 'data', 'core', 'fabricated-faction'), { recursive: true })
  mkdirSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction'), { recursive: true })
  writeFileSync(join(repoRoot, 'data', 'core', 'fabricated-faction', 'factions.json'), JSON.stringify([
    { id: 'fabricated-faction', name: 'Fabricated Faction' },
  ]))
  writeFileSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction', 'abilities.json'), JSON.stringify([
    { ability_id: 'alpha', name: 'Alpha' },
    { ability_id: 'beta', name: 'Beta' },
    { ability_id: 'gamma', name: 'Gamma' },
  ]))
  const runtime = createMechanicGraphServer({ root, port: 0, repositoryRoot: repoRoot })
  const { store } = runtime
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 2, policy_version: 1 } })
  reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  for (const [runId, campaignId] of [['run-1', 'campaign-1'], ['run-2', 'campaign-2']]) {
    store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target) VALUES (?,?,?,?,?)').run(runId, campaignId, 'active', 'fixture', 'alpha')
  }
  const first = store.createNode({ kind: 'finding', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', state: 'resolved' } })
  const second = store.createNode({ kind: 'candidate-certificate', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', status: 'certified', fingerprints: {}, checks: [] } })
  store.db.prepare('INSERT INTO findings(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run('finding-1', 'run-1', 'resolved', first.node_id, '{}')
  store.db.prepare('INSERT INTO certificates(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run('certificate-2', 'run-2', 'certified', second.node_id, '{}')
  store.appendEvent('finding-resolved', { run_id: 'run-1' }, { aggregate_kind: 'run', aggregate_id: 'run-1', node_id: first.node_id })
  store.appendEvent('certificate-certified', { run_id: 'run-2' }, { aggregate_kind: 'run', aggregate_id: 'run-2', node_id: second.node_id })
  return { runtime, first, second }
}

async function listen(runtime) {
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject)
    runtime.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${runtime.server.address().port}`
}

async function close(runtime) {
  await new Promise(resolve => runtime.server.close(resolve))
}

test('global ability view unifies campaigns and campaign mode filters the same node identities', async () => {
  const { runtime, first, second } = fixture()
  const origin = await listen(runtime)
  const ability = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha`).then(response => response.json())
  assert.equal(ability.root, 'root:mechanic-evidence')
  assert.ok(ability.nodes.some(node => node.id === first.node_id && node.campaign_refs.includes('campaign-1')))
  assert.ok(ability.nodes.some(node => node.id === second.node_id && node.campaign_refs.includes('campaign-2')))
  const campaign = await fetch(`${origin}/api/v1/graph/snapshot?mode=campaign&campaign_id=campaign-1`).then(response => response.json())
  assert.ok(campaign.nodes.some(node => node.id === first.node_id))
  assert.equal(campaign.nodes.some(node => node.id === second.node_id), false)
  assert.ok(ability.nodes.every(node => !JSON.stringify(node).includes('payload')))
  await close(runtime)
})

test('index pagination is deterministic and stale revisions fail with current revision', async () => {
  const { runtime, first } = fixture()
  const origin = await listen(runtime)
  const page1Response = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=1`)
  const page1 = await page1Response.json()
  assert.equal(page1.nodes.length, 2)
  assert.equal(page1.nodes[1].metadata.ability_id, 'alpha')
  assert.equal(page1.page.truncated, true)
  const page2 = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=1&after=${encodeURIComponent(page1.page.next_cursor)}`).then(response => response.json())
  assert.equal(page2.nodes[1].metadata.ability_id, 'beta')
  runtime.store.appendEvent('finding-reopened', { run_id: 'run-1' }, { aggregate_kind: 'run', aggregate_id: 'run-1', node_id: first.node_id })
  const stale = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=1&after=${encodeURIComponent(page1.page.next_cursor)}`)
  assert.equal(stale.status, 409)
  const staleBody = await stale.json()
  assert.equal(staleBody.code, 'stale-cursor')
  assert.notEqual(staleBody.graph_revision, page1.graph_revision)
  await close(runtime)
})

test('filters fail closed, legacy graph routes are removed, and updates stay bounded', async () => {
  const { runtime } = fixture()
  const origin = await listen(runtime)
  assert.equal((await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction`)).status, 400)
  assert.equal((await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=unknown`)).status, 404)
  assert.equal((await fetch(`${origin}/api/v1/campaigns/campaign-1/snapshot`)).status, 404)
  const update = await fetch(`${origin}/api/v1/graph/updates?since=0&mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=1`).then(response => response.json())
  assert.equal(update.page.truncated, true)
  assert.deepEqual(update.affected_ability_ids, [{ faction_id: 'fabricated-faction', ability_id: 'alpha' }])
  assert.equal('nodes' in update, false)
  await close(runtime)
})

test('referenced abilities without repository metadata remain navigable with fallback labels', async () => {
  const { runtime } = fixture()
  const nodeId = 'd'.repeat(64)
  runtime.store.db.prepare('INSERT INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)').run(nodeId, nodeId, 'finding', `objects/${nodeId}.json`, nodeId)
  runtime.store.db.prepare('INSERT INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)').run(nodeId, 'finding', 1, '{}')
  runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)').run(nodeId, 'missing-faction', 'missing-ability', 'ownership', 0)
  const origin = await listen(runtime)
  const index = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=100`).then(response => response.json())
  const fallback = index.nodes.find(node => node.metadata?.ability_id === 'missing-ability')
  assert.equal(fallback.label, 'Unknown ability (missing-ability) — missing-faction')
  assert.equal(fallback.metadata.metadata_status, 'missing')
  const ability = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=missing-faction&ability_id=missing-ability`).then(response => response.json())
  assert.ok(ability.nodes.some(node => node.id === nodeId))
  await close(runtime)
})

test('truncated descendant pages always provide a deterministic continuation cursor', async () => {
  const { runtime } = fixture()
  const origin = await listen(runtime)
  const response = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=3`)
  const page = await response.json()
  assert.equal(response.status, 200)
  assert.equal(page.nodes.length, 3)
  assert.equal(page.page.truncated, true)
  assert.ok(page.page.next_cursor)
  assert.equal((await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=2`)).status, 400)
  await close(runtime)
})

test('ability responses enforce the 400-node hard cap', async () => {
  const { runtime } = fixture()
  runtime.store.transaction(() => {
    const objectInsert = runtime.store.db.prepare('INSERT INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)')
    const nodeInsert = runtime.store.db.prepare('INSERT INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)')
    const refInsert = runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
    for (let index = 0; index < 410; index += 1) {
      const nodeId = index.toString(16).padStart(64, '0')
      objectInsert.run(nodeId, nodeId, 'finding', `objects/${nodeId}.json`, nodeId)
      nodeInsert.run(nodeId, 'finding', 1, '{}')
      refInsert.run(nodeId, 'fabricated-faction', 'alpha', 'ownership', 0)
    }
  })
  const origin = await listen(runtime)
  const response = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=999&depth=8`).then(value => value.json())
  assert.equal(response.nodes.length, 400)
  assert.equal(response.page.truncated, true)
  assert.ok(response.page.next_cursor)
  await close(runtime)
})
