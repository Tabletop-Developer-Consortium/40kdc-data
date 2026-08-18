import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256 } from './canonical.js'
import {
  GLOBAL_ROOT_ID,
  abilityProjectionId,
  abilityProjectionLabel,
  projectionScope,
  rebuildNodeAbilityRefs,
  reconcileAbilityCatalog,
  registryProjection,
} from './projection.js'
import { GraphStore } from './store.js'

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mechanic-projection-repo-'))
  const graphRoot = join(repoRoot, 'graph')
  mkdirSync(join(repoRoot, 'data', 'core', 'fabricated-faction'), { recursive: true })
  mkdirSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction'), { recursive: true })
  writeFileSync(join(repoRoot, 'data', 'core', 'fabricated-faction', 'factions.json'), JSON.stringify([
    { id: 'fabricated-faction', name: 'Fabricated Faction' },
  ]))
  writeFileSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction', 'abilities.json'), JSON.stringify([
    { ability_id: 'alpha', name: 'Alpha' },
    { ability_id: 'beta', name: 'Beta' },
  ]))
  return { repoRoot, graphRoot, store: new GraphStore(graphRoot, { repositoryRoot: repoRoot }) }
}

function refsFor(store, nodeId) {
  return store.db.prepare('SELECT faction_id,ability_id,source_kind,distance FROM node_ability_refs WHERE node_id=? ORDER BY faction_id,ability_id').all(nodeId)
}

test('global projection uses stable synthetic IDs and safe repository labels', () => {
  const { repoRoot, store } = fixture()
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 2, policy_version: 1 } })
  const result = reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  assert.equal(GLOBAL_ROOT_ID, 'root:mechanic-evidence')
  assert.equal(abilityProjectionId('fabricated-faction', 'alpha'), 'ability:fabricated-faction:alpha')
  assert.equal(result.catalog_count, 2)
  const alpha = store.db.prepare('SELECT * FROM ability_catalog WHERE faction_id=? AND ability_id=?').get('fabricated-faction', 'alpha')
  assert.equal(abilityProjectionLabel(alpha), 'Alpha — Fabricated Faction (fabricated-faction) · alpha')
  assert.equal(alpha.repository_version_id, repository.node_id)
  store.close()
})

test('refs are direct, forward-inherited, family-unioned, cycle-safe, and never backward-propagated', () => {
  const { store } = fixture()
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'b'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 2, policy_version: 1 } })
  const alpha = store.createNode({ kind: 'finding', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', state: 'open' } })
  const inherited = store.createNode({ kind: 'finding', payload: { state: 'open' }, input_node_ids: [alpha.node_id] })
  const cycle = store.createNode({ kind: 'finding', payload: { state: 'open', marker: 'cycle' }, input_node_ids: [inherited.node_id] })
  store.db.prepare("INSERT INTO edges(parent_node_id,child_node_id,edge_type,metadata_json) VALUES (?,?, 'derived_from','{}')").run(cycle.node_id, alpha.node_id)

  const template = store.createNode({ kind: 'family-template', payload: { state: 'current' } })
  const alphaInstance = store.createNode({ kind: 'family-instance', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha' } })
  const betaInstance = store.createNode({ kind: 'family-instance', payload: { faction_id: 'fabricated-faction', ability_id: 'beta' } })
  for (const [id, node] of [['alpha-instance', alphaInstance], ['beta-instance', betaInstance]]) {
    store.db.prepare('INSERT INTO family_instances(id,state,node_id,payload_json) VALUES (?,?,?,?)').run(id, 'current', node.node_id, JSON.stringify({ family_template_node_id: template.node_id }))
  }
  rebuildNodeAbilityRefs(store)

  assert.deepEqual(refsFor(store, inherited.node_id).map(ref => ({ ...ref })), [{ faction_id: 'fabricated-faction', ability_id: 'alpha', source_kind: 'lineage', distance: 1 }])
  assert.deepEqual(refsFor(store, cycle.node_id).map(ref => ({ ...ref })), [{ faction_id: 'fabricated-faction', ability_id: 'alpha', source_kind: 'lineage', distance: 2 }])
  assert.deepEqual(refsFor(store, template.node_id).map(ref => ref.ability_id), ['alpha', 'beta'])
  assert.equal(projectionScope(refsFor(store, template.node_id)), 'family')
  assert.equal(projectionScope(refsFor(store, repository.node_id)), 'global')
  assert.deepEqual(refsFor(store, repository.node_id), [])
  store.close()
})

test('projection rebuild preserves immutable object and event bytes', () => {
  const { repoRoot, store } = fixture()
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'c'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 2, policy_version: 1 } })
  const evidence = store.createNode({ kind: 'finding', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', state: 'resolved' } })
  store.appendEvent('finding-resolved', { finding_id: 'fixture' }, { aggregate_kind: 'finding', aggregate_id: 'fixture', node_id: evidence.node_id })
  const objectHash = sha256(readFileSync(store.objectPath(evidence.node_id)))
  const eventHash = sha256(readFileSync(join(store.root, 'events.jsonl')))
  reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  rebuildNodeAbilityRefs(store)
  assert.equal(sha256(readFileSync(store.objectPath(evidence.node_id))), objectHash)
  assert.equal(sha256(readFileSync(join(store.root, 'events.jsonl'))), eventHash)
  assert.equal(store.verifyEvents().sequence, 1)
  store.close()
})

test('registry projection adds graph-only campaigns and preserves existing human fields', () => {
  const { store } = fixture()
  store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,started) VALUES (?,?,?,?,?,?)')
    .run('legacy-c009', 'c009', 'active', 'shape-led', 'existing-target', '2026-08-01')
  const terminalStates = [
    ['c010', 'completed', 'converged'],
    ['c011', 'converged', 'converged'],
    ['c012', 'aborted', 'aborted'],
    ['c013', 'superseded', 'aborted'],
    ['c014', 'failed-final', 'aborted'],
  ]
  const insertRun = store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,started,finished) VALUES (?,?,?,?,?,?,?)')
  for (const [id, state] of terminalStates) {
    insertRun.run(id, id, state, 'graph-backed', 'curated', '2026-08-05', '2026-08-06')
  }
  store.db.prepare('INSERT INTO claims(faction_id,ability_id,run_id,state,claimed_sequence) VALUES (?,?,?,?,?)')
    .run('fabricated-faction', 'alpha', 'c010', 'released', 1)
  store.db.prepare('INSERT INTO checks(id,run_id,state,payload_json) VALUES (?,?,?,?)')
    .run('terminal', 'c010', 'passed', JSON.stringify({
      baseline_mean: 0.6,
      terminal_mean: 0.7,
      bookmark: 'task/c010',
      pr: 'https://example.test/pull/10',
    }))

  const projection = registryProjection(store, {
    campaigns: [
      {
        id: 'c009',
        kind: 'shape-led',
        target: 'existing-target',
        bookmark: 'task/bookmark',
        status: 'open',
        pr: null,
        worklist_size: 3,
        mean_before: 0.5,
        mean_after: null,
        started: '2026-08-01',
        finished: null,
        notes: 'Human-authored note.',
      },
      {
        id: 'c010',
        notes: 'Generated compatibility projection: active in the Mechanic Evidence Graph.',
      },
    ],
  })
  const existing = projection.campaigns.find(campaign => campaign.id === 'c009')
  const added = projection.campaigns.find(campaign => campaign.id === 'c010')
  assert.equal(existing.bookmark, 'task/bookmark')
  assert.equal(existing.notes, 'Human-authored note.')
  assert.deepEqual(added, {
    id: 'c010',
    kind: 'graph-backed',
    target: 'curated',
    bookmark: 'task/c010',
    status: 'converged',
    pr: 'https://example.test/pull/10',
    worklist_size: 1,
    mean_before: 0.6,
    mean_after: 0.7,
    started: '2026-08-05',
    finished: '2026-08-06',
    notes: 'Generated compatibility projection: completed in the Mechanic Evidence Graph.',
  })
  for (const [id, , expected] of terminalStates) {
    assert.equal(projection.campaigns.find(campaign => campaign.id === id).status, expected)
  }
  store.close()
})
