import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { sha256 } from './canonical.js'
import { canonicalSourceText, persistClaimExtraction, persistSourceSnapshot } from './formalization.js'
import { importAbilityDslCandidates } from './claim-import.js'
import { projectedClaimSet } from './retrieval.js'
import { ensureTask, issueReadyTask } from './scheduler.js'
import { projectionChecksum, rebuildProjections } from './reducer.js'
import { SCHEMA_SQL } from './schema.js'
import { GraphStore } from './store.js'

function setup(text = 'Möbius units act. Fabricated shields improve.') {
  const root = mkdtempSync(join(tmpdir(), 'claim-formalization-')); const raw = join(root, 'raw'); mkdirSync(raw)
  const faction_id = 'fabricated-faction'; const ability_id = 'fabricated-rule'
  writeFileSync(join(raw, `${faction_id}.json`), JSON.stringify([{ ability_id, raw_text: text, source: { kind: 'json', ref: 'fabricated://rule', edition: '11e', phases: ['Command'] } }]))
  const store = new GraphStore(join(root, 'graph')); const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 4, policy_version: 2 } })
  const readiness = store.createNode({ kind: 'decision', payload: { state: 'answered' }, parents: [{ node_id: repository.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
  store.appendEvent('run-created', { row: { run_id: 'c012', campaign_id: 'c012', state: 'planned', kind: 'graph-backed' }, repository_parent_node_id: repository.node_id, readiness_parent_node_id: readiness.node_id }, { aggregate_kind: 'run', aggregate_id: 'c012', node_id: readiness.node_id }); store.appendEvent('run-started', { expected_state: 'planned' }, { aggregate_kind: 'run', aggregate_id: 'c012' })
  const issue = label => { ensureTask(store, { run_id: 'c012', label, kind: 'source-formalization', payload: { input_node_ids: [readiness.node_id] } }); return issueReadyTask(store, { run_id: 'c012', label, now: Date.now() }).envelope }
  return { store, raw, faction_id, ability_id, text, issue, readiness }
}
function proposition() { return { schema_id: '40k.mechanic-claim', schema_version: '1', value: { predicate: 'mechanic.trigger', arguments: [{ role: 'event', value: 'command' }], qualifiers: [] } } }
function identity() { return { extractor_contract_version: '1', formalization_policy_version: '1', normalization_version: '1', extractor_implementation: 'fabricated-implementation', extractor_identity: { kind: 'model', model_id: 'fabricated/model@1', prompt_sha256: 'b'.repeat(64), output_schema_sha256: 'c'.repeat(64), agent_contract_id: 'formalizer@1' }, ordered_parent_evidence_ids: [], lineage_root_origin_ids: [] } }
function signatures(labels, aggregate = { actor: 'fabricated', affected_entity: null, event: 'command', duration: 'turn' }) {
  return { aggregate, assertions: labels.map(extraction_local_id => ({ extraction_local_id, signature: { actor: 'fabricated', affected_entity: null, event: 'command', duration: 'turn' } })) }
}

test('v1 source freezing and extraction are exactly idempotent for a succeeded envelope', () => {
  const value = setup(); const sourceEnvelope = value.issue('freeze')
  const sourceInput = { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: sourceEnvelope, raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(value.text, 'utf8')) } }
  const source = persistSourceSnapshot(value.store, sourceInput)
  assert.equal(value.store.db.prepare('SELECT state FROM tasks WHERE id=?').get(sourceEnvelope.task_id).state, 'succeeded')
  const sourceCounts = value.store.db.prepare('SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM objects) objects,(SELECT COUNT(*) FROM edges) edges').get()
  assert.equal(persistSourceSnapshot(value.store, sourceInput).idempotent, true)
  assert.deepEqual(value.store.db.prepare('SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM objects) objects,(SELECT COUNT(*) FROM edges) edges').get(), sourceCounts)
  const extractionEnvelope = value.issue('extract')
  const extractionInput = { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: extractionEnvelope, source_snapshot_node_id: source.source_node_id, extraction_identity: identity(source.source_snapshot_id), assertions: [{ extraction_local_id: 'trigger', proposition: proposition(), polarity: 'affirms', modality: 'asserted', evidence_bindings: [{ kind: 'source_span', start: 0, end: Buffer.from('Möbius', 'utf8').length, coordinate_unit: 'utf8_byte' }] }], signatures: signatures(['trigger']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } }
  const output = persistClaimExtraction(value.store, extractionInput)
  assert.ok(value.store.hasNode(output.certificate_node_id)); assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='source-formalization-certificate'").get().n, 0)
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM claim_assertions WHERE decision_state='accepted'").get().n, 1)
  const extractionCounts = value.store.db.prepare('SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM objects) objects,(SELECT COUNT(*) FROM edges) edges').get()
  const replay = persistClaimExtraction(value.store, extractionInput)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.certificate_node_id, output.certificate_node_id)
  assert.deepEqual(value.store.db.prepare('SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM objects) objects,(SELECT COUNT(*) FROM edges) edges').get(), extractionCounts)
  value.store.close()
})

test('v1 rejects legacy local claim IDs, malformed multibyte spans, and derivation cycles without writes', () => {
  const value = setup(); const source = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze'), raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(value.text, 'utf8')) } }); const envelope = value.issue('reject')
  const base = { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope, source_snapshot_node_id: source.source_node_id, extraction_identity: identity(source.source_snapshot_id), signatures: signatures(['x']), unresolved: [], completeness: { state: 'incomplete', obligations_checked: [] } }
  assert.throws(() => persistClaimExtraction(value.store, { ...base, assertions: [{ claim_id: 'old', extraction_local_id: 'x', proposition: proposition(), polarity: 'affirms', modality: 'asserted', evidence_bindings: [] }] }), /legacy claim_id/)
  assert.equal(value.store.db.prepare('SELECT COUNT(*) AS n FROM claim_extractions').get().n, 0); value.store.close()
})
test('primary revisions reconcile imported Feel No Pain candidates without granting them authority', () => {
  const sourceA = 'This unit has Feel No Pain 5+.'
  const value = setup(sourceA)
  const repository = value.store.db.prepare("SELECT node_id FROM nodes WHERE kind='repository-version' ORDER BY rowid LIMIT 1").get()
  const imported = importAbilityDslCandidates(value.store, {
    repo_root: new URL('../../../..', import.meta.url).pathname,
    repository_version_node_id: repository.node_id,
    faction_id: value.faction_id,
    file_path: 'data/enrichment/fabricated-faction/abilities.json',
    record_index: 114,
    ability: {
      ability_id: value.ability_id,
      name: 'Fabricated Helix',
      authored_by: 'community',
      game_version: { edition: '11th', dataslate: 'test' },
      ability_type: 'datasheet',
      behavior: 'passive',
      effect: { type: 'feel-no-pain', target: 'unit', modifier: { threshold: 6, scope: 'mortal-wounds' } },
      scope: { range: 'unit', duration: 'permanent' },
    },
  })
  const fnp = threshold => ({
    schema_id: '40k.mechanic-claim',
    schema_version: '1',
    value: {
      predicate: 'mechanic.effect.feel-no-pain',
      arguments: [
        { role: 'affected-entity', value: 'unit' },
        { role: 'scope', value: 'mortal-wounds' },
        { role: 'threshold', value: threshold },
      ],
      qualifiers: [],
    },
  })
  const assertion = threshold => [{
    extraction_local_id: 'fnp',
    proposition: fnp(threshold),
    polarity: 'affirms',
    modality: 'asserted',
    evidence_bindings: [
      { kind: 'source_span', start: 0, end: 9, coordinate_unit: 'utf8_byte' },
      { kind: 'source_span', start: 27, end: 29, coordinate_unit: 'utf8_byte' },
      { kind: 'source_span', start: 0, end: 30, coordinate_unit: 'utf8_byte' },
    ],
  }]
  const sourceOne = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-fnp-five'), raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(sourceA, 'utf8')) } })
  const revisionA = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-fnp-five'), source_snapshot_node_id: sourceOne.source_node_id, extraction_identity: identity(sourceOne.source_snapshot_id), assertions: assertion(5), signatures: signatures(['fnp']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  const importedFnp = value.store.db.prepare("SELECT o.claim_occurrence_id,o.state FROM claim_occurrences o JOIN semantic_claims s USING(semantic_key) WHERE o.origin_id=? AND json_extract(s.proposition_json,'$.value.predicate')='mechanic.effect.feel-no-pain'").get(imported.origin_id)
  assert.equal(importedFnp.state, 'contradicted')
  const contradiction = value.store.db.prepare("SELECT r.*,source.origin_id AS source_origin_id,target.origin_id AS target_origin_id FROM claim_relations r JOIN claim_occurrences source ON source.claim_occurrence_id=r.source_occurrence_id JOIN claim_occurrences target ON target.claim_occurrence_id=r.target_occurrence_id WHERE r.relation_type='contradicts' AND target.origin_id=?").get(imported.origin_id)
  assert.ok(contradiction)

  const sourceB = 'This unit has Feel No Pain 6+.'
  writeFileSync(join(value.raw, `${value.faction_id}.json`), JSON.stringify([{ ability_id: value.ability_id, raw_text: sourceB, source: { kind: 'json', ref: 'fabricated://rule', edition: '11e', phases: ['Command'] } }]))
  const sourceTwo = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-fnp-six'), raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(sourceB, 'utf8')) } })
  const revisionB = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-fnp-six'), source_snapshot_node_id: sourceTwo.source_node_id, extraction_identity: { ...identity(sourceTwo.source_snapshot_id), extractor_identity: { ...identity().extractor_identity, model_id: 'fabricated/model@2' } }, assertions: assertion(6), signatures: signatures(['fnp']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  assert.equal(value.store.db.prepare('SELECT state FROM claim_sets WHERE claim_set_id=?').get(revisionA.claim_set_id).state, 'invalidated')
  assert.equal(projectedClaimSet(value.store, { certificate_node_id: revisionB.certificate_node_id, obligation: 'represent' }).authorization.status, 'full')
  const equivalent = value.store.db.prepare("SELECT r.*,source.origin_id AS source_origin_id,target.origin_id AS target_origin_id FROM claim_relations r JOIN claim_occurrences source ON source.claim_occurrence_id=r.source_occurrence_id JOIN claim_occurrences target ON target.claim_occurrence_id=r.target_occurrence_id WHERE r.relation_type='semantically_equivalent_to' AND target.origin_id=?").get(imported.origin_id)
  assert.ok(equivalent)
  assert.notEqual(equivalent.source_origin_id, equivalent.target_origin_id)
  assert.throws(() => projectedClaimSet(value.store, { certificate_node_id: revisionA.certificate_node_id }), /current claim-set certificate projection missing/)
  value.store.close()
})

test('persists trusted evidence IDs and signatures, then preserves an unchanged claim set across re-extraction', () => {
  const value = setup()
  const source = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze'), raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(value.text, 'utf8')) } })
  const rootAssertions = [{ extraction_local_id: 'trigger', proposition: proposition(), polarity: 'affirms', modality: 'asserted', evidence_bindings: [{ kind: 'source_span', start: 0, end: Buffer.from('Möbius', 'utf8').length, coordinate_unit: 'utf8_byte' }], derivation_parent_labels: [] }]
  const rootOutput = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-root'), source_snapshot_node_id: source.source_node_id, extraction_identity: identity(source.source_snapshot_id), assertions: rootAssertions, signatures: signatures(['trigger']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  assert.deepEqual(projectedClaimSet(value.store, { certificate_node_id: rootOutput.certificate_node_id }).authorization, {
    certificate_node_id: rootOutput.certificate_node_id,
    claim_set_id: rootOutput.claim_set_id,
    subject_ref: `ability:${value.faction_id}/${value.ability_id}`,
    obligation: 'retrieve',
    status: 'full',
  })
  const assertions = [{ extraction_local_id: 'derived', proposition: { ...proposition(), value: { predicate: 'mechanic.duration', arguments: [{ role: 'duration', value: 'turn' }], qualifiers: [] } }, polarity: 'affirms', modality: 'asserted', evidence_bindings: [{ kind: 'derived_evidence', derivation_local_parent_ids: ['trigger'], derivation_rule_id: 'fabricated-rule', derivation_rule_version: '1' }], derivation_parent_labels: ['trigger'] }]
  const firstIdentity = identity(source.source_snapshot_id); firstIdentity.extractor_identity.model_id = 'fabricated/model@2'
  const first = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-one'), source_snapshot_node_id: source.source_node_id, extraction_identity: firstIdentity, assertions, signatures: signatures(['derived']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  const span = JSON.parse(value.store.db.prepare("SELECT payload_json FROM nodes WHERE kind='claim-evidence-binding' AND json_extract(payload_json, '$.kind')='source_span'").get().payload_json)
  const derived = JSON.parse(value.store.db.prepare("SELECT payload_json FROM nodes WHERE kind='claim-evidence-binding' AND json_extract(payload_json, '$.kind')='derived_evidence'").get().payload_json)
  assert.equal(span.origin_id, first.origin_id)
  assert.deepEqual(derived.parent_claim_occurrence_ids, [value.store.db.prepare("SELECT claim_occurrence_id FROM claim_assertions WHERE extraction_local_id='trigger'").get().claim_occurrence_id])
  assert.throws(() => projectedClaimSet(value.store, { certificate_node_id: first.certificate_node_id }), /complete claim set retains candidate members/)
  const secondIdentity = identity(source.source_snapshot_id); secondIdentity.extractor_identity.model_id = 'fabricated/model@3'
  const second = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-two'), source_snapshot_node_id: source.source_node_id, extraction_identity: secondIdentity, assertions, signatures: signatures(['derived']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  assert.notEqual(first.extraction_id, second.extraction_id)
  assert.equal(first.claim_set_id, second.claim_set_id)
  const candidate = value.store.db.prepare("SELECT assertion_id,node_id,decision_state FROM claim_assertions WHERE extraction_local_id='derived' ORDER BY assertion_id LIMIT 1").get()
  assert.equal(candidate.decision_state, 'proposed')
  const certificate = JSON.parse(value.store.db.prepare('SELECT payload_json FROM nodes WHERE node_id=?').get(second.certificate_node_id).payload_json)
  assert.deepEqual(certificate.assertion_ids, [])
  assert.deepEqual(certificate.assertion_node_ids, [])
  assert.equal(value.store.db.prepare('SELECT 1 FROM edges WHERE parent_node_id=? AND child_node_id=?').get(candidate.node_id, second.certificate_node_id), undefined)
  assert.throws(() => projectedClaimSet(value.store, { certificate_node_id: second.certificate_node_id }), /complete claim set retains candidate members/)
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='claim-set-certificate'").get().n, 3)
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM claim_occurrences WHERE state='invalidated'").get().n, 0)
  const revised = 'Möbius units act differently. Fabricated shields improve.'
  writeFileSync(join(value.raw, `${value.faction_id}.json`), JSON.stringify([{ ability_id: value.ability_id, raw_text: revised, source: { kind: 'json', ref: 'fabricated://rule', edition: '11e', phases: ['Command'] } }]))
  const revisedSource = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-revised'), raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(revised, 'utf8')) } })
  const revisedAssertions = [{ extraction_local_id: 'trigger', proposition: proposition(), polarity: 'affirms', modality: 'asserted', evidence_bindings: [{ kind: 'source_span', start: 0, end: Buffer.from('Möbius', 'utf8').length, coordinate_unit: 'utf8_byte' }] }]
  const revisedOutput = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-revised'), source_snapshot_node_id: revisedSource.source_node_id, extraction_identity: identity(revisedSource.source_snapshot_id), assertions: revisedAssertions, signatures: signatures(['trigger']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  assert.equal(value.store.db.prepare('SELECT COUNT(*) AS n FROM claim_occurrences WHERE origin_id=? AND state=?').get(first.origin_id, 'invalidated').n, 1)
  assert.equal(value.store.db.prepare('SELECT COUNT(*) AS n FROM claim_occurrences WHERE origin_id=? AND state=?').get(first.origin_id, 'proposed').n, 1)
  const equivalent = value.store.db.prepare("SELECT * FROM claim_relations WHERE relation_type='semantically_equivalent_to'").get()
  assert.ok(equivalent)
  assert.equal(equivalent.source_occurrence_id, revisedOutput.accepted_claim_occurrence_ids[0])
  const replay = new DatabaseSync(':memory:'); replay.exec(SCHEMA_SQL)
  rebuildProjections(replay, value.store.eventRows(), { objects: value.store.db.prepare('SELECT * FROM objects').all(), nodes: value.store.db.prepare('SELECT * FROM nodes').all(), edges: value.store.db.prepare('SELECT * FROM edges').all() })
  assert.equal(projectionChecksum(replay), projectionChecksum(value.store.db))
  replay.close()
  value.store.close()
})

test('persists unresolved-only source claims and rejects a source snapshot for another subject', () => {
  const value = setup()
  const source = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze'), raw_store_root: value.raw, source_binding: { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(value.text, 'utf8')) } })
  const unresolved = [{ extraction_local_id: 'unknown', extraction_local_focus: ['fabricated-focus'], kind: 'unsupported', evidence_bindings: [{ kind: 'source_span', start: 0, end: 1, coordinate_unit: 'utf8_byte' }], candidate_local_labels: [], blocks_obligations: ['represent'] }]
  const output = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('unresolved-only'), source_snapshot_node_id: source.source_node_id, extraction_identity: identity(source.source_snapshot_id), assertions: [], signatures: signatures([]), unresolved, completeness: { state: 'incomplete', obligations_checked: ['represent'] } })
  assert.equal(value.store.db.prepare('SELECT COUNT(*) AS n FROM claim_sets WHERE claim_set_id=?').get(output.claim_set_id).n, 1)
  assert.equal(value.store.db.prepare('SELECT COUNT(*) AS n FROM claim_set_members WHERE claim_set_id=?').get(output.claim_set_id).n, 0)
  assert.throws(() => persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: 'other-ability', envelope: value.issue('misbound'), source_snapshot_node_id: source.source_node_id, extraction_identity: identity(source.source_snapshot_id), assertions: [], signatures: signatures([]), unresolved, completeness: { state: 'incomplete', obligations_checked: ['represent'] } }), /subject/)
  value.store.close()
})

test('incomplete source revision cannot displace complete current source authority', () => {
  const value = setup()
  const binding = text => ({ store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(text, 'utf8')) })
  const accepted = [{ extraction_local_id: 'trigger', proposition: proposition(), polarity: 'affirms', modality: 'asserted', evidence_bindings: [{ kind: 'source_span', start: 0, end: Buffer.from('Möbius', 'utf8').length, coordinate_unit: 'utf8_byte' }] }]
  const unresolved = [{ extraction_local_id: 'unknown', extraction_local_focus: ['fabricated-focus'], kind: 'unsupported', evidence_bindings: [{ kind: 'source_span', start: 0, end: 1, coordinate_unit: 'utf8_byte' }], candidate_local_labels: [], blocks_obligations: ['represent'] }]

  const firstSource = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-first'), raw_store_root: value.raw, source_binding: binding(value.text) })
  const first = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-first'), source_snapshot_node_id: firstSource.source_node_id, extraction_identity: identity(firstSource.source_snapshot_id), assertions: accepted, signatures: signatures(['trigger']), unresolved: [], completeness: { state: 'complete', obligations_checked: ['retrieve', 'represent'] } })
  const revised = 'Möbius units act differently. Fabricated shields improve.'
  writeFileSync(join(value.raw, `${value.faction_id}.json`), JSON.stringify([{ ability_id: value.ability_id, raw_text: revised, source: { kind: 'json', ref: 'fabricated://rule', edition: '11e', phases: ['Command'] } }]))
  const secondSource = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-second'), raw_store_root: value.raw, source_binding: binding(revised) })
  const second = persistClaimExtraction(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('extract-second'), source_snapshot_node_id: secondSource.source_node_id, extraction_identity: identity(secondSource.source_snapshot_id), assertions: [], signatures: signatures([]), unresolved, completeness: { state: 'incomplete', obligations_checked: ['represent'] } })
  assert.equal(value.store.db.prepare('SELECT state FROM claim_sets WHERE claim_set_id=?').get(first.claim_set_id).state, 'current')
  assert.equal(value.store.db.prepare('SELECT current_state FROM claim_origins WHERE origin_id=?').get(first.origin_id).current_state, 'current')
  assert.equal(projectedClaimSet(value.store, { certificate_node_id: first.certificate_node_id }).claim_set_id, first.claim_set_id)
  assert.throws(() => projectedClaimSet(value.store, { certificate_node_id: second.certificate_node_id }), /claim set is not complete/)
  value.store.close()
})
test('source snapshot identity ignores run and graph-node metadata', () => {
  const value = setup()
  const binding = { store_key: `${value.faction_id}/${value.ability_id}`, byte_hash: sha256(Buffer.from(value.text, 'utf8')) }
  const first = persistSourceSnapshot(value.store, { run_id: 'c012', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-identity-first'), raw_store_root: value.raw, source_binding: binding })
  const alternateParent = value.store.createNode({ kind: 'decision', payload: { state: 'answered' }, parents: [{ node_id: value.readiness.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }] })
  const second = persistSourceSnapshot(value.store, { run_id: 'different-run', faction_id: value.faction_id, ability_id: value.ability_id, envelope: value.issue('freeze-identity-second'), raw_store_root: value.raw, source_binding: binding, parents: [alternateParent.node_id] })
  assert.equal(first.source_snapshot_id, second.source_snapshot_id)
  assert.equal(first.source_node_id, second.source_node_id)
  const projection = value.store.db.prepare('SELECT run_id,node_id FROM source_snapshots WHERE id=?').get(first.source_snapshot_id)
  assert.equal(projection.run_id, null)
  assert.equal(projection.node_id, null)
  value.store.close()
})

test('canonical source text remains deterministic for fabricated raw prose', () => assert.equal(canonicalSourceText({ raw_text: ' Fabricated source. ' }), 'Fabricated source.'))
