import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateGraphRoot } from './migration.js'
import { GraphStore } from './store.js'

function treeHash(root) {
  const hash = createHash('sha256')
  const visit = (path, relative = '') => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name)
      const key = relative ? `${relative}/${name}` : name
      const stat = statSync(child)
      hash.update(`${stat.isDirectory() ? 'd' : 'f'}:${key}\0`)
      if (stat.isDirectory()) visit(child, key)
      else hash.update(readFileSync(child))
    }
  }
  visit(root)
  return hash.digest('hex')
}

function fixture({ prohibited = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claim-migration-'))
  const graph = join(root, 'graph')
  const raw = join(root, 'raw')
  const repo = join(root, 'repo')
  mkdirSync(raw)
  mkdirSync(join(repo, 'data', 'enrichment', 'fabricated'), { recursive: true })
  const sourceText = 'Fabricated source sentence that must remain outside the graph.'
  writeFileSync(join(raw, 'index.json'), JSON.stringify({ schema_version: 1, factions: { fabricated: { 'helix-test': { raw_text: sourceText } } } }))
  writeFileSync(join(repo, 'data', 'enrichment', 'fabricated', 'abilities.json'), JSON.stringify([{
    ability_id: 'helix-test', name: 'Helix Test', authored_by: 'community', game_version: { edition: '11th', dataslate: 'test' }, ability_type: 'datasheet', behavior: 'passive',
    effect: { type: 'feel-no-pain', target: 'unit', modifier: { threshold: 6 } }, scope: { range: 'unit', duration: 'permanent' },
  }]))
  const store = new GraphStore(graph, { verify: false })
  store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 5, policy_version: 2 } })
  if (prohibited) store.createNode({ kind: 'finding', payload: { summary: sourceText } })
  store.db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run()
  store.close()
  return { graph, raw, repo }
}

test('schema four migrates atomically, imports candidates once, and replays exactly', () => {
  const value = fixture()
  const before = treeHash(value.graph)
  const dryRun = migrateGraphRoot({ graph_root: value.graph, repo_root: value.repo, raw_store_root: value.raw, import_candidates: true })
  assert.equal(dryRun.dry_run, true)
  assert.equal(dryRun.schema_version, 4)
  assert.equal(treeHash(value.graph), before)

  const migrated = migrateGraphRoot({ graph_root: value.graph, repo_root: value.repo, raw_store_root: value.raw, write: true, import_candidates: true })
  assert.equal(migrated.migrated, true)
  assert.equal(migrated.schema_version, 5)
  assert.equal(migrated.candidate_imports.ability_dsl.imported, 1)
  assert.equal(migrated.replay.projection_match, true)
  const store = new GraphStore(value.graph)
  assert.equal(store.schemaVersion, 5)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM claim_origins WHERE origin_kind='ability-dsl'").get().n, 1)
  store.close()

  const once = treeHash(value.graph)
  const replay = migrateGraphRoot({ graph_root: value.graph, repo_root: value.repo, raw_store_root: value.raw, write: true, import_candidates: true })
  assert.equal(replay.migrated, false)
  assert.equal(replay.changed, false)
  assert.equal(replay.candidate_imports.ability_dsl.idempotent, 1)
  assert.equal(treeHash(value.graph), once)
})

test('IP failure leaves the predecessor graph byte-identical', () => {
  const value = fixture({ prohibited: true })
  const before = treeHash(value.graph)
  assert.throws(() => migrateGraphRoot({ graph_root: value.graph, repo_root: value.repo, raw_store_root: value.raw, write: true, import_candidates: true }), /IP boundary failed/)
  assert.equal(treeHash(value.graph), before)
})
