import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { importAbilityDslCandidates, importLegacyClaimCandidates } from './claim-import.js'
import { queryClaims } from './retrieval.js'
import { GraphStore } from './store.js'
const repoRoot = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '')
const abilityFile = 'data/enrichment/adeptus-astartes/abilities.json'
const legacyFixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-claim-candidates-v1.json', import.meta.url), 'utf8'))

function setup() {
  const store = new GraphStore(mkdtempSync(join(tmpdir(), 'claim-import-')), { verify: false })
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 5, policy_version: 2 } })
  return { store, repository }
}

function counts(store) {
  const tables = ['events', 'objects', 'nodes', 'edges', 'claim_origins', 'claim_imports', 'claim_extractions', 'claim_occurrences', 'claim_assertions', 'claim_sets', 'claim_set_members', 'claim_review_decisions']
  return Object.fromEntries(tables.map(table => [table, store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
}

test('Ability DSL import maps Feel No Pain as an origin-bound non-authoritative candidate', () => {
  const { store, repository } = setup()
  const ability = JSON.parse(readFileSync(join(repoRoot, abilityFile), 'utf8'))[114]
  const input = { repo_root: repoRoot, repository_version_node_id: repository.node_id, faction_id: 'adeptus-astartes', file_path: abilityFile, record_index: 114, ability }
  const first = importAbilityDslCandidates(store, input)
  assert.equal(first.idempotent, false)
  const claims = queryClaims(store, { origin_id: first.origin_id })
  const feelNoPain = claims.claims.find(claim => claim.mechanic_facets?.predicate === 'mechanic.effect.feel-no-pain')
  assert.ok(feelNoPain)
  assert.equal(feelNoPain.lifecycle_state, 'proposed')
  assert.equal(feelNoPain.mechanic_facets.affected_entity, 'unit')
  assert.equal(feelNoPain.mechanic_facets.threshold, 6)
  assert.deepEqual(feelNoPain.memberships, [{ claim_set_id: first.claim_set_id, member_state: 'candidate' }])
  assert.deepEqual(feelNoPain.evidence, [])
  const assertionEvidence = store.db.prepare(`
    SELECT b.kind,b.path FROM claim_assertions a
    JOIN claim_assertion_evidence ae USING(assertion_id)
    JOIN claim_evidence_bindings b USING(binding_id)
    WHERE a.claim_occurrence_id=?
  `).all(feelNoPain.claim_occurrence_id).map(row => ({ ...row }))
  assert.deepEqual(assertionEvidence, [{ kind: 'structured_path', path: '/114/effect' }])
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM claim_evidence_bindings WHERE kind='source_span'").get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM claim_review_decisions').get().n, 0)

  const before = counts(store)
  const second = importAbilityDslCandidates(store, input)
  assert.deepEqual(second, { import_id: first.import_id, origin_id: first.origin_id, claim_set_id: first.claim_set_id, idempotent: true })
  assert.deepEqual(counts(store), before)
  store.close()
})

test('legacy certificate and workflow claims remain historical candidates with residual observations', () => {
  const { store } = setup()
  const certificate = store.createNode({ kind: 'source-formalization-certificate', payload: { faction_id: 'adeptus-astartes', ability_id: 'helix-gauntlet', status: 'historical', fingerprints: {}, claims: legacyFixture.certificate.claims } })
  const workflow = store.createNode({ kind: 'workflow-output', payload: { output_kind: 'historical', envelope: {}, result: legacyFixture.workflow_output.result, execution_identity: {} } })
  const subject_ref = 'ability:adeptus-astartes/helix-gauntlet'
  const certificateResult = importLegacyClaimCandidates(store, { artifact_node_id: certificate.node_id, subject_ref, claims: legacyFixture.certificate.claims, claims_pointer: '/claims' })
  const workflowResult = importLegacyClaimCandidates(store, { artifact_node_id: workflow.node_id, subject_ref, claims: legacyFixture.workflow_output.result.claims, claims_pointer: '/result/claims' })

  for (const result of [certificateResult, workflowResult]) {
    assert.equal(result.parsed, 1)
    assert.equal(result.residuals, 2)
    assert.equal(store.db.prepare('SELECT current_state FROM claim_origins WHERE origin_id=?').get(result.origin_id).current_state, 'historical')
    assert.equal(store.db.prepare('SELECT member_state FROM claim_set_members WHERE claim_set_id=?').get(result.claim_set_id).member_state, 'candidate')
    const observation = JSON.parse(store.db.prepare('SELECT payload_json FROM legacy_observations WHERE id=?').get(result.observation_id).payload_json)
    assert.equal(observation.unknown_count, 2)
    assert.equal(observation.authorizes_reuse, false)
  }
  assert.notEqual(certificateResult.origin_id, workflowResult.origin_id)
  assert.deepEqual(store.db.prepare("SELECT path FROM claim_evidence_bindings WHERE kind='structured_path' ORDER BY path").all().map(row => ({ ...row })), [
    { path: '/claims/0' },
    { path: '/claims/0/id' },
    { path: '/claims/0/object' },
    { path: '/claims/0/relation' },
    { path: '/claims/0/subject' },
    { path: '/result/claims/0' },
    { path: '/result/claims/0/id' },
    { path: '/result/claims/0/object' },
    { path: '/result/claims/0/relation' },
    { path: '/result/claims/0/subject' },
  ])
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM claim_origins WHERE origin_kind='primary-source'").get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM claim_review_decisions').get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM claim_relations').get().n, 0)
  for (const row of store.db.prepare('SELECT identity_json FROM claim_extractions').all()) {
    const identity = JSON.parse(row.identity_json)
    assert.equal(identity.extractor_identity.kind, 'legacy')
    assert.equal('model_id' in identity.extractor_identity, false)
  }

  const before = counts(store)
  const replay = importLegacyClaimCandidates(store, { artifact_node_id: certificate.node_id, subject_ref, claims: legacyFixture.certificate.claims, claims_pointer: '/claims' })
  assert.equal(replay.idempotent, true)
  assert.deepEqual(counts(store), before)
  store.close()
})

test('candidate import CLI writes once and reports an idempotent replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'claim-import-cli-'))
  const graphRoot = join(root, 'graph')
  const factionRoot = join(root, 'data', 'enrichment', 'adeptus-astartes')
  mkdirSync(factionRoot, { recursive: true })
  const ability = JSON.parse(readFileSync(join(repoRoot, abilityFile), 'utf8'))[114]
  writeFileSync(join(factionRoot, 'abilities.json'), `${JSON.stringify([ability], null, 2)}\n`)

  const store = new GraphStore(graphRoot, { repositoryRoot: root, verify: false })
  store.createNode({
    kind: 'repository-version',
    payload: {
      workspace_hash: 'a'.repeat(64),
      files: [],
      tool_versions: {},
      runner_hashes: [],
      schema_version: 5,
      policy_version: 2,
    },
  })
  store.close()

  const command = [
    fileURLToPath(new URL('./cli.js', import.meta.url)),
    'import-claim-candidates',
    '--repo-root',
    root,
    '--graph-root',
    graphRoot,
    '--write',
    '--json',
  ]
  const run = () => spawnSync(process.execPath, command, { encoding: 'utf8' })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  const firstResult = JSON.parse(first.stdout)
  assert.equal(firstResult.ok, true)
  assert.equal(firstResult.ability_dsl.imported, 1)
  assert.equal(firstResult.ability_dsl.idempotent, 0)

  const second = run()
  assert.equal(second.status, 0, second.stderr)
  const secondResult = JSON.parse(second.stdout)
  assert.equal(secondResult.ok, true)
  assert.equal(secondResult.ability_dsl.imported, 0)
  assert.equal(secondResult.ability_dsl.idempotent, 1)
})
