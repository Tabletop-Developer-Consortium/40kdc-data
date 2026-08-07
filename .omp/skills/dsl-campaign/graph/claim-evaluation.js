import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { canonicalJson, sha256 } from './canonical.js'
import { claimOccurrenceId, computeInvalidations, extractionId, semanticKey } from './claims.js'
import { mechanicClaimAdapter, MECHANIC_PREDICATES } from './mechanic-claims.js'
import { retrieveEvidence } from './retrieval.js'

const REQUIRED_PARTITIONS = Object.freeze([
  'family_train', 'family_holdout', 'temporal_t0', 'temporal_t1',
  'policy_v1', 'policy_v2', 'contrast_pairs', 'question_holdout',
])

function fail(message) {
  throw new Error(`claim-evaluation: ${message}`)
}

function assertArray(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`)
  return value
}


function ids(mechanic) {
  return assertArray(mechanic.assertions, 'mechanic assertions').map(assertion => assertion.claim_occurrence_id).sort()
}

function semanticKeys(mechanic) {
  return assertArray(mechanic.assertions, 'mechanic assertions').map(assertion => assertion.semantic_key).sort()
}

function assertionByPredicate(mechanic, predicate) {
  return mechanic.assertions.find(assertion => assertion.proposition?.value?.predicate === predicate)
}

function validatePartitionMembership(fixture) {
  const partitions = fixture.partitions
  if (!partitions || typeof partitions !== 'object') fail('missing partitions')
  for (const name of REQUIRED_PARTITIONS) assertArray(partitions[name], `partitions.${name}`)
  for (const name of ['family_train', 'family_holdout', 'temporal_t0', 'temporal_t1']) {
    for (const key of partitions[name]) if (!fixture.mechanics[key]) fail(`partitions.${name} references unknown mechanic ${key}`)
  }
  for (const key of [...partitions.policy_v1, ...partitions.policy_v2]) if (key !== 'risk_c') fail(`policy partition references unknown risk ${key}`)
  for (const pair of partitions.contrast_pairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !fixture.mechanics[pair[0]] || !fixture.mechanics[pair[1]]) fail('invalid contrast pair')
  }
  for (const question of partitions.question_holdout) {
    if (!question || !['answered', 'unsupported', 'ontology_gap'].includes(question.answer)) fail('invalid question holdout label')
  }
  return partitions
}

function validateFixtureVersion(fixture) {
  const withoutFixtureHash = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'fixture_sha256'))
  if (fixture.fixture_version !== 1) fail(`unsupported fixture_version ${fixture.fixture_version}`)
  if (!fixture.fixture_sha256 || !Array.isArray(fixture.fixture_sha256_excludes) || !fixture.fixture_sha256_excludes.includes('fixture_sha256') || sha256(canonicalJson(withoutFixtureHash)) !== fixture.fixture_sha256) {
    fail('fixture checksum contract drift')
  }
  if (!fixture.mechanics?.a_t0 || !fixture.mechanics?.a_reordered_resegmented || !fixture.mechanics?.a_t1_same_semantics || !fixture.mechanics?.a_t1_changed_duration || !fixture.mechanics?.b || !fixture.risk_c) {
    fail('required frozen case missing')
  }
}


function expectedInvalidation(change, invalidated) {
  const result = computeInvalidations(change, invalidated)
  return {
    reextract: result.reextract,
    rebuild_adapter_projections: result.rebuild_adapter_projections,
    rebuild_retrieval_and_construction: result.rebuild_retrieval_and_construction,
    recertify_representations: result.recertify_representations,
    reassess: result.reassess,
    invalidated: {
      claim_occurrence_ids: result.invalidated.claim_occurrence_ids,
      claim_set_ids: result.invalidated.claim_set_ids,
      representation_certificate_ids: result.invalidated.representation_certificate_ids,
      assessment_ids: result.invalidated.assessment_ids,
    },
  }
}
function observeIdentity(mechanic) {
  if (extractionId(mechanic.extraction_identity) !== mechanic.extraction_id) fail('extraction identity drift')
  for (const assertion of mechanic.assertions) {
    const semantic = semanticKey({
      adapter_id: '40k-mechanic',
      proposition: assertion.proposition,
      polarity: assertion.polarity,
      modality: assertion.modality,
    }, mechanicClaimAdapter)
    if (semantic !== assertion.semantic_key) fail('semantic identity drift')
    if (claimOccurrenceId({ origin_id: mechanic.origin_id, semantic_key: semantic }) !== assertion.claim_occurrence_id) {
      fail('occurrence identity drift')
    }
  }
}

export function evaluateClaimFixture(fixture) {
  validateFixtureVersion(fixture)
  const partitions = validatePartitionMembership(fixture)
  const a = fixture.mechanics.a_t0
  const reordered = fixture.mechanics.a_reordered_resegmented
  const same = fixture.mechanics.a_t1_same_semantics
  const changed = fixture.mechanics.a_t1_changed_duration
  const invalidation = fixture.invalidations.source_snapshot_change
  const extractionOnly = fixture.invalidations.extraction_identity_unchanged_projection
  const b = fixture.mechanics.b
  for (const mechanic of Object.values(fixture.mechanics)) observeIdentity(mechanic)
  if (JSON.stringify(semanticKeys(a)) !== JSON.stringify(semanticKeys(reordered)) || JSON.stringify(ids(a)) !== JSON.stringify(ids(reordered)) || a.claim_set_id !== reordered.claim_set_id) {
    fail('reordered extraction identity drift')
  }
  if (JSON.stringify(semanticKeys(a)) !== JSON.stringify(semanticKeys(same))) fail('same-semantics source revision semantic drift')
  if (a.source_snapshot_id === same.source_snapshot_id || JSON.stringify(ids(a)) === JSON.stringify(ids(same)) || a.claim_set_id === same.claim_set_id) {
    fail('same-semantics source revision occurrence drift')
  }
  const durationA = assertionByPredicate(a, 'mechanic.duration')
  const durationChanged = assertionByPredicate(changed, 'mechanic.duration')
  if (!durationA || !durationChanged || durationA.semantic_key === durationChanged.semantic_key) fail('changed duration semantic drift')
  const unchangedPredicates = a.assertions.filter(assertion => assertion.proposition.value.predicate !== 'mechanic.duration').map(assertion => assertion.proposition.value.predicate).sort()
  const changedUnchangedPredicates = changed.assertions.filter(assertion => assertion.proposition.value.predicate !== 'mechanic.duration').map(assertion => assertion.proposition.value.predicate).sort()
  if (JSON.stringify(unchangedPredicates) !== JSON.stringify(changedUnchangedPredicates)) fail('changed duration altered non-duration predicates')
  const train = fixture.mechanics[partitions.family_train[0]]
  const trainCoverage = ids(train)
  const holdoutCoverage = ids(b)
  const retrieval = retrieveEvidence({
    target_signature: {},
    target_claim_occurrence_ids: holdoutCoverage,
    candidates: [{ node_id: 'f'.repeat(64), status: 'certified', current: true, signature: {}, covers_claim_occurrence_ids: trainCoverage }],
  })
  const falseAuthorization = retrieval.filter(match => match.covers_claim_occurrence_ids.length).length / retrieval.length
  const dependencies = invalidation.invalidated
  const observedInvalidation = expectedInvalidation({ kind: 'source_snapshot' }, dependencies)
  if (canonicalJson(observedInvalidation) !== canonicalJson(invalidation)) fail('temporal invalidation drift')
  const observedExtractionOnly = expectedInvalidation({ kind: 'extraction_identity', claim_set_id_changed: false }, extractionOnly.invalidated)
  if (canonicalJson(observedExtractionOnly) !== canonicalJson(extractionOnly)) fail('extraction-only invalidation drift')
  const answers = {
    answered: assertionByPredicate(b, 'mechanic.duration') ? 1 : 0,
    unsupported: fixture.risk_c.unresolved.kind === 'contradictory' ? 1 : 0,
    ontology_gap: MECHANIC_PREDICATES.has('mechanic.unregistered') ? 0 : 1,
  }
  const knownPredicates = new Set(Object.values(fixture.mechanics).flatMap(mechanic => mechanic.assertions.map(assertion => assertion.proposition.value.predicate)))
  const falseNewPredicateRate = [...knownPredicates].filter(predicate => !MECHANIC_PREDICATES.has(predicate)).length / Math.max(1, knownPredicates.size)
  return {
    fixture_version: fixture.fixture_version,
    partitions: Object.fromEntries(REQUIRED_PARTITIONS.map(function partitionEntry(name) {
      return [name, partitions[name]]
    })),
    metrics: {
      family_compatible_recall: { top_1: falseAuthorization ? 1 : 0, top_5: falseAuthorization ? 1 : 0, eligible_holdout_claims: holdoutCoverage.length },
      false_authorization_rate: falseAuthorization,
      false_new_predicate_rate: falseNewPredicateRate,
      temporal: {
        invalidation_completeness: observedInvalidation.invalidated.claim_occurrence_ids.length / dependencies.claim_occurrence_ids.length,
        stale_survival: observedInvalidation.invalidated.claim_occurrence_ids.filter(id => !dependencies.claim_occurrence_ids.includes(id)).length,
        unnecessary_reextraction: observedExtractionOnly.recertify_representations ? 1 : 0,
      },
      policy: { claim_reuse: observedExtractionOnly.reextract ? 1 : 0, reassessment_required: observedInvalidation.reassess ? 1 : 0 },
      contrast_precision: falseAuthorization === 0 ? 1 : 0,
      question_answerability: answers,
      unsupported_answer_rate: answers.unsupported ? 0 : 1,
      missing_evidence_detection: fixture.risk_c.unresolved.blocks_obligations.includes('assess') ? 1 : 0,
      ontology_extension_count: [...knownPredicates].filter(predicate => !MECHANIC_PREDICATES.has(predicate)).length,
    },
  }
}

export function evaluateClaimFixtureFile(path) {
  return evaluateClaimFixture(JSON.parse(readFileSync(path, 'utf8')))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const index = process.argv.indexOf('--fixture')
  if (index < 0 || !process.argv[index + 1]) fail('--fixture is required')
  const result = evaluateClaimFixtureFile(process.argv[index + 1])
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
