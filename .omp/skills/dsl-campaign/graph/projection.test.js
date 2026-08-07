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
  const inherited = store.createNode({ kind: 'finding', payload: { state: 'open' }, parents: [{ node_id: alpha.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
  const cycle = store.createNode({ kind: 'finding', payload: { state: 'open', marker: 'cycle' }, parents: [{ node_id: inherited.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
  store.db.prepare("INSERT INTO edges(parent_node_id,child_node_id,edge_type,metadata_json) VALUES (?,?, 'derived_from','{}')").run(cycle.node_id, alpha.node_id)

  const template = store.createNode({ kind: 'family-template', payload: { state: 'current' } })
  const alphaInstance = store.createNode({ kind: 'family-instance', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha' }, parents: [{ node_id: template.node_id, edge_type: 'generalizes', authorizes_reuse: true, metadata: {} }] })
  const betaInstance = store.createNode({ kind: 'family-instance', payload: { faction_id: 'fabricated-faction', ability_id: 'beta' }, parents: [{ node_id: template.node_id, edge_type: 'generalizes', authorizes_reuse: true, metadata: {} }] })
  store.appendEvent('shape-family-certified', {
    run_id: 'fixture',
    template: { id: 'template', state: 'current', node_id: template.node_id, payload: {} },
    instances: [
      { id: 'alpha-instance', state: 'current', node_id: alphaInstance.node_id, payload: { family_template_node_id: template.node_id } },
      { id: 'beta-instance', state: 'current', node_id: betaInstance.node_id, payload: { family_template_node_id: template.node_id } },
    ],
  }, { aggregate_kind: 'family-template', aggregate_id: 'template', node_id: template.node_id })

  assert.deepEqual(refsFor(store, inherited.node_id).map(ref => ({ ...ref })), [{ faction_id: 'fabricated-faction', ability_id: 'alpha', source_kind: 'lineage', distance: 1 }])
  assert.deepEqual(refsFor(store, cycle.node_id).map(ref => ({ ...ref })), [{ faction_id: 'fabricated-faction', ability_id: 'alpha', source_kind: 'lineage', distance: 2 }])
  assert.deepEqual(refsFor(store, template.node_id).map(ref => ref.ability_id), ['alpha', 'beta'])
  assert.equal(projectionScope(refsFor(store, template.node_id)), 'family')
  assert.equal(projectionScope(refsFor(store, repository.node_id)), 'global')
  assert.deepEqual(refsFor(store, repository.node_id), [])
  store.close()
})

test('normalized claim nodes and claim-set certificates project their subject ability ownership', () => {
  const { store } = fixture()
  const node = kind => store.createNode({ kind, payload: {} }).node_id
  const source = node('source-snapshot')
  const origin = store.createNode({ kind: 'claim-origin', payload: { origin_id: 'origin', subject_ref: 'ability:fabricated-faction/alpha', origin_kind: 'primary-source', source_snapshot_id: 'snapshot', current_state: 'current' }, parents: [{ node_id: source, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] }).node_id
  const extraction = node('extraction-identity')
  const semantic = node('semantic-claim')
  const occurrence = node('claim-occurrence')
  const assertion = node('claim-assertion')
  const evidence = node('claim-evidence-binding')
  const claimSet = store.createNode({ kind: 'claim-set', payload: { subject_ref: 'ability:fabricated-faction/alpha' } }).node_id
  const unresolved = node('unresolved-item')
  const certificate = node('claim-set-certificate')
  store.db.prepare('INSERT INTO source_snapshots(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run('snapshot', null, 'current', source, '{}')
  store.db.prepare('INSERT INTO claim_origins(origin_id,subject_ref,origin_kind,source_snapshot_id,current_state,node_id) VALUES (?,?,?,?,?,?)').run('origin', 'ability:fabricated-faction/alpha', 'primary-source', 'snapshot', 'current', origin)
  store.db.prepare('INSERT INTO claim_extractions(extraction_id,origin_id,adapter_id,ontology_version,identity_json,node_id) VALUES (?,?,?,?,?,?)').run('extraction', 'origin', '40k-mechanic', '1', '{}', extraction)
  store.db.prepare('INSERT INTO semantic_claims(semantic_key,adapter_id,proposition_schema_id,proposition_schema_version,identity_ontology_version,polarity,modality,proposition_json,node_id) VALUES (?,?,?,?,?,?,?,?,?)').run('semantic', '40k-mechanic', '40k.mechanic-claim', '1', '1', 'affirms', 'asserted', '{"schema_id":"40k.mechanic-claim","schema_version":"1","value":{"predicate":"mechanic.trigger","arguments":[],"qualifiers":[]}}', semantic)
  store.db.prepare('INSERT INTO claim_occurrences(claim_occurrence_id,origin_id,semantic_key,subject_ref,state,node_id) VALUES (?,?,?,?,?,?)').run('occurrence', 'origin', 'semantic', 'ability:fabricated-faction/alpha', 'accepted', occurrence)
  store.db.prepare('INSERT INTO claim_assertions(assertion_id,extraction_id,extraction_local_id,claim_occurrence_id,decision_state,independence_group_id,node_id) VALUES (?,?,?,?,?,?,?)').run('assertion', 'extraction', 'local', 'occurrence', 'accepted', 'fixture', assertion)
  store.db.prepare('INSERT INTO claim_evidence_bindings(binding_id,kind,origin_id,node_id) VALUES (?,?,?,?)').run('binding', 'source_span', 'origin', evidence)
  store.db.prepare('INSERT INTO claim_unresolved(unresolved_key,extraction_id,kind,focus_json,blocks_obligations_json,resolution_state,node_id) VALUES (?,?,?,?,?,?,?)').run('unresolved', 'extraction', 'unsupported', '[]', '[]', 'open', unresolved)
  store.db.prepare('INSERT INTO claim_sets(claim_set_id,subject_ref,origin_id,adapter_id,ontology_version,completeness_state,obligations_checked_json,state,certificate_node_id) VALUES (?,?,?,?,?,?,?,?,?)').run('set', 'ability:fabricated-faction/alpha', 'origin', '40k-mechanic', '1', 'incomplete', '[]', 'current', certificate)
  rebuildNodeAbilityRefs(store)
  for (const nodeId of [origin, extraction, semantic, occurrence, assertion, evidence, unresolved, claimSet, certificate]) {
    assert.deepEqual(refsFor(store, nodeId).map(ref => [ref.faction_id, ref.ability_id]), [['fabricated-faction', 'alpha']])
  }
  store.close()
})

test('projection rebuild preserves immutable object and event bytes', () => {
  const { repoRoot, store } = fixture()
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'c'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 2, policy_version: 1 } })
  const evidence = store.createNode({ kind: 'finding', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', state: 'resolved' } })
  store.appendEvent('finding-opened', { row: { id: 'fixture', run_id: 'run', state: 'open', node_id: evidence.node_id, payload: {} } }, { aggregate_kind: 'finding', aggregate_id: 'fixture', node_id: evidence.node_id })
  store.appendEvent('finding-resolved', { expected_state: 'open' }, { aggregate_kind: 'finding', aggregate_id: 'fixture', node_id: evidence.node_id })
  reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  const objectHash = sha256(readFileSync(store.objectPath(evidence.node_id)))
  const eventHash = sha256(readFileSync(join(store.root, 'events.jsonl')))
  reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  assert.equal(sha256(readFileSync(store.objectPath(evidence.node_id))), objectHash)
  assert.equal(sha256(readFileSync(join(store.root, 'events.jsonl'))), eventHash)
  assert.equal(store.verifyEvents().sequence, 3)
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
