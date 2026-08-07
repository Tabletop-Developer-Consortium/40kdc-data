import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { evaluateClaimFixture } from './claim-evaluation.js'
import { canonicalJson, sha256 } from './canonical.js'

const fixturePath = new URL('./fixtures/claim-conformance-v1.json', import.meta.url)
function fixture() { return JSON.parse(readFileSync(fixturePath, 'utf8')) }

test('frozen claim evaluation reports deterministic named metrics and partitions', () => {
  const result = evaluateClaimFixture(fixture())
  assert.deepEqual(Object.keys(result.partitions), [
    'family_train', 'family_holdout', 'temporal_t0', 'temporal_t1',
    'policy_v1', 'policy_v2', 'contrast_pairs', 'question_holdout',
  ])
  assert.deepEqual(result.metrics.family_compatible_recall, { top_1: 0, top_5: 0, eligible_holdout_claims: 5 })
  assert.equal(result.metrics.false_authorization_rate, 0)
  assert.deepEqual(result.metrics.temporal, { invalidation_completeness: 1, stale_survival: 0, unnecessary_reextraction: 0 })
  assert.deepEqual(result.metrics.question_answerability, { answered: 1, unsupported: 1, ontology_gap: 1 })
})

test('frozen claim evaluation rejects partition and fixture drift', () => {
  const missingPartition = fixture()
  delete missingPartition.partitions.family_holdout
  missingPartition.fixture_sha256 = sha256(canonicalJson(Object.fromEntries(Object.entries(missingPartition).filter(([key]) => key !== 'fixture_sha256'))))
  assert.throws(() => evaluateClaimFixture(missingPartition), /partitions\.family_holdout/)
  const changedDuration = fixture()
  changedDuration.mechanics.a_t1_changed_duration.assertions.find(assertion => assertion.proposition.value.predicate === 'mechanic.duration').semantic_key = changedDuration.mechanics.a_t0.assertions.find(assertion => assertion.proposition.value.predicate === 'mechanic.duration').semantic_key
  assert.throws(() => evaluateClaimFixture(changedDuration), /fixture checksum contract drift/)
  changedDuration.fixture_sha256 = sha256(canonicalJson(Object.fromEntries(Object.entries(changedDuration).filter(([key]) => key !== 'fixture_sha256'))))
  assert.throws(() => evaluateClaimFixture(changedDuration), /semantic identity drift/)
})
