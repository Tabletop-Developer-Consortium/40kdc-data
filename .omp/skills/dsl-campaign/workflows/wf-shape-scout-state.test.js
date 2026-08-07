import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyRevision,
  assertRevision,
  assertScopedRefutations,
  assertCharterFamily,
  assertShapeIdentity,
  classifyBlocker,
  countFamilyMechanics,
  freezeShapeCharter,
  mergeDeferredCandidates,
  normalizeFindingLedger,
  psykerSeverityFindings,
  prototypeAgentInput,
  prototypeAgentOptions,
  prototypeGateDecision,
  preflightShapeCharter,
  resolveFindingLedger,
  terminalOutcome,
  validateShapePackage,
} from './wf-shape-scout-state.js'

const seed = { ability_id: 'seed', faction_id: 'example' }
const charter = () => freezeShapeCharter({
  seed,
  mechanic_slice: 'a constrained mechanic',
  family: [{ ability_id: 'seed', faction: 'example', rationale: { source: 'seed' } }, { ability_id: 'peer', faction: 'other' }],
  required_semantics: ['constraint survives'],
  non_goals: ['unrelated payload'],
  deferred_candidates: [],
  acceptance_fixtures: [{ name: 'positive fabricated probe', expected: { result: 'accepted' } }],
  reopening_rules: 'inquisitor must explicitly reopen',
})

const sliceSignature = {
  actor: 'source', affected_entity: 'target', event: 'selection', producer_ports: ['source'],
  consumer_ports: ['target'], polarity: 'positive', quantifier: 'one', timing: 'before battle',
  duration: 'battle', scope: 'army', ordering: 'before deployment', restrictions: [], exclusions: [],
}

function preflightCharter(overrides = {}) {
  return {
    exact_family: ['one', 'two', 'three', 'four'].map((ability_id, index) => ({
      ability_id,
      faction: `faction-${index}`,
      slice_signature: sliceSignature,
      parameter_values: { distance: index + 1 },
    })),
    acceptance_fixtures: [
      { id: 'positive', polarity: 'positive', input: { enabled: true }, expected: { applies: true } },
      { id: 'negative', polarity: 'negative', input: { enabled: false }, expected: { applies: false } },
    ],
    ...overrides,
  }
}

describe('shape scout state', () => {
  test('preflights a homogeneous family with distinct parameter values', () => {
    const result = preflightShapeCharter(preflightCharter(), 4)
    assert.equal(result.ok, true)
    assert.equal(result.family_size, 4)
    assert.deepEqual(result.fixture_ids, ['negative', 'positive'])
  })

  test('rejects below-threshold families before shape work', () => {
    const value = preflightCharter()
    assert.deepEqual(preflightShapeCharter({ ...value, exact_family: value.exact_family.slice(0, 3) }, 4), {
      ok: false, reason: 'below-threshold',
    })
  })

  test('rejects heterogeneous family signatures', () => {
    const value = preflightCharter()
    value.exact_family[3] = { ...value.exact_family[3], slice_signature: { ...sliceSignature, scope: 'unit' } }
    assert.deepEqual(preflightShapeCharter(value, 4), { ok: false, reason: 'heterogeneous-family' })
  })

  test('rejects malformed and positive-only fixture contracts', () => {
    const value = preflightCharter()
    assert.deepEqual(preflightShapeCharter({ ...value, acceptance_fixtures: [{ id: 'positive', polarity: 'positive', input: {}, expected: {}, note: 'extra' }] }, 4), {
      ok: false, reason: 'invalid-fixture-contract',
    })
    assert.deepEqual(preflightShapeCharter({ ...value, acceptance_fixtures: [value.acceptance_fixtures[0]] }, 4), {
      ok: false, reason: 'missing-negative-fixture',
    })
  })

  test('rejects acceptance-family drift after a charter freezes it', () => {
    assert.throws(() => assertCharterFamily(charter(), [
      { ability_id: 'seed', faction: 'example', fit: 'faithful', match_strength: 'exact' },
      { ability_id: 'peer', faction: 'other', fit: 'needs-param', match_strength: 'near' },
      { ability_id: 'new-discovery', faction: 'third', fit: 'faithful', match_strength: 'exact' },
    ]), /family drift/)
  })

  test('deep-freezes charter members, fixtures, and collections', () => {
    const frozen = charter()
    assert.ok(Object.isFrozen(frozen.exact_family[0]))
    assert.ok(Object.isFrozen(frozen.exact_family[0].rationale))
    assert.ok(Object.isFrozen(frozen.acceptance_fixtures[0].expected))
    assert.throws(() => { frozen.exact_family[0].rationale.source = 'changed' })
    assert.throws(() => { frozen.acceptance_fixtures[0].expected.result = 'changed' })
    assert.throws(() => { frozen.required_semantics.push('changed') })
  })

  test('requires revisions to carry the candidate identity forward', () => {
    assert.throws(() => assertShapeIdentity({ name: 'stable-shape', kind: 'effect-leaf' },
      { name: 'replacement-shape', kind: 'effect-leaf' }), /identity drift/)
    assert.doesNotThrow(() => assertShapeIdentity({ name: 'stable-shape', kind: 'effect-leaf' },
      { name: 'stable-shape', kind: 'effect-leaf' }))
  })

  test('preserves omitted findings and gates every terminal transition on evidence', () => {
    const open = [{ key: 'f1', state: 'open', axis: 'fidelity', situation: 'gap' }]
    assert.deepEqual(resolveFindingLedger(open, [], charter()), open)
    assert.throws(() => resolveFindingLedger(open, [{ key: 'f1', state: 'resolved' }], charter()), /resolution_evidence/)
    assert.throws(() => resolveFindingLedger([], [{ key: 'f1', state: 'resolved', resolution_evidence: 'fabricated probe passes' }], charter()), /prior open finding/)
    assert.throws(() => resolveFindingLedger(open, [{ key: 'f1', state: 'out-of-scope', orthogonal_gap: true }], charter()), /scope_evidence/)
    assert.throws(() => resolveFindingLedger(open, [{ key: 'f1', state: 'superseded', superseded_by: 'f2' }], charter()), /supersession_evidence/)
    assert.throws(() => resolveFindingLedger([], [{ key: 'f1', state: 'open', blocker_evidence: { resolved_or_out_of_scope: true } }], charter()), /cannot claim/)
    const orthogonal = resolveFindingLedger([], [{
      key: 'f2', state: 'open', orthogonal_gap: true,
      scope_evidence: 'the charter excludes this payload',
      blocker_evidence: { resolved_or_out_of_scope: false },
    }], charter())
    const outOfScope = resolveFindingLedger(orthogonal, [{
      key: 'f2', state: 'out-of-scope',
      blocker_evidence: { resolved_or_out_of_scope: true },
    }], charter())
    assert.equal(outOfScope[0].state, 'out-of-scope')
    const resolved = resolveFindingLedger(open, [{ key: 'f1', state: 'resolved', resolution_evidence: 'fabricated probe passes' }], charter())
    assert.equal(resolved[0].state, 'resolved')
    assert.throws(() => resolveFindingLedger(resolved, [{ key: 'f1', state: 'out-of-scope', orthogonal_gap: true, scope_evidence: 'different claim' }], charter()), /prior open finding/)
  })

  test('requires supersession evidence and a real replacement finding', () => {
    const open = [{ key: 'f1', state: 'open', axis: 'fidelity', situation: 'gap' }]
    const superseded = { key: 'f1', state: 'superseded', superseded_by: 'f2', supersession_evidence: 'split into a narrower replacement' }
    assert.throws(() => resolveFindingLedger(open, [superseded], charter()), /distinct open or resolved replacement/)
    assert.throws(() => resolveFindingLedger(open, [{ ...superseded, superseded_by: 'f1' }], charter()), /distinct open or resolved replacement/)
    const ledger = resolveFindingLedger(open, [
      superseded,
      { key: 'f2', state: 'open', axis: 'fidelity', situation: 'narrower gap' },
    ], charter())
    assert.equal(ledger.find(finding => finding.key === 'f1').state, 'superseded')
    assert.equal(ledger.find(finding => finding.key === 'f2').state, 'open')
  })

  test('merges charter-deferred candidates with new discoveries without changing acceptance', () => {
    const frozen = freezeShapeCharter({
      seed,
      mechanic_slice: 'a constrained mechanic',
      family: [{ ability_id: 'seed', faction: 'example' }, { ability_id: 'peer', faction: 'other' }],
      required_semantics: ['constraint survives'],
      non_goals: ['unrelated payload'],
      deferred_candidates: [{ ability_id: 'previous-discovery', faction: 'third' }],
      acceptance_fixtures: [{ name: 'positive fabricated probe' }],
      reopening_rules: 'inquisitor must explicitly reopen',
    })
    assert.deepEqual(mergeDeferredCandidates(frozen, [
      { ability_id: 'seed', faction: 'example' },
      { ability_id: 'previous-discovery', faction: 'third' },
      { ability_id: 'later-discovery', faction: 'fourth', why: 'near mechanic' },
    ]), [
      { ability_id: 'previous-discovery', faction: 'third' },
      { ability_id: 'later-discovery', faction: 'fourth', why: 'near mechanic' },
    ])
    assert.deepEqual(frozen.deferred_candidates, [{ ability_id: 'previous-discovery', faction: 'third' }])
    assert.equal(frozen.exact_family.length, 2)
  })

  test('requires exact-or-near coverage for every frozen member and counts shared slugs once', () => {
    assert.throws(() => assertCharterFamily(charter(), [
      { ability_id: 'seed', faction: 'example', fit: 'faithful', match_strength: 'exact' },
      { ability_id: 'peer', faction: 'other', fit: 'faithful', match_strength: 'stretch' },
    ]), /exact-or-near/)
    assert.equal(assertCharterFamily(charter(), [
      { ability_id: 'seed', faction: 'example', fit: 'faithful', match_strength: 'exact' },
      { ability_id: 'peer', faction: 'other', fit: 'needs-param', match_strength: 'near' },
    ]), 2)
    const shared = freezeShapeCharter({
      seed,
      mechanic_slice: 'a constrained mechanic',
      family: ['example', 'a', 'b', 'c'].map(faction => ({ ability_id: 'seed', faction })),
      required_semantics: ['constraint survives'],
      acceptance_fixtures: [{ name: 'fixture' }],
      reopening_rules: 'inquisitor must explicitly reopen',
    })
    const sharedCoverage = shared.exact_family.map(member => ({ ...member, fit: 'faithful', match_strength: 'exact' }))
    assert.equal(countFamilyMechanics(shared.exact_family), 1)
    assert.equal(assertCharterFamily(shared, sharedCoverage), 1)
  })

  test('only normalized terminal state closes all four blocker conditions', () => {
    const evidence = {
      concrete_slice_divergence: true, frozen_exact_member: true,
      not_honestly_composable_or_separate: true, resolved_or_out_of_scope: false,
    }
    assert.equal(classifyBlocker({ state: 'open', blocker_evidence: evidence }).blocks, true)
    assert.equal(classifyBlocker({ state: 'open', blocker_evidence: { ...evidence, resolved_or_out_of_scope: true } }).blocks, true)
    assert.equal(classifyBlocker({ state: 'resolved', blocker_evidence: evidence }).blocks, false)
  })

  test('resolved ledger blockers no longer block acceptance', () => {
    const blocker = {
      key: 'fidelity:in-slice divergence',
      state: 'open',
      blocker_evidence: {
        concrete_slice_divergence: true,
        frozen_exact_member: true,
        not_honestly_composable_or_separate: true,
        resolved_or_out_of_scope: false,
      },
    }
    const [resolved] = resolveFindingLedger([blocker], [{ key: blocker.key, state: 'resolved', resolution_evidence: 'fabricated probe' }], charter())
    const classification = classifyBlocker(resolved)
    assert.equal(resolved.state, 'resolved')
    assert.equal(classification.blocks, false)
    assert.equal(classification.evidence.resolved_or_out_of_scope, true)
  })

  test('only an unresolved in-slice blocker asks a maintainer after exhaustion', () => {
    assert.deepEqual(terminalOutcome({ rounds: 3, max_rounds: 3, finding_ledger: [{ state: 'open', blocker_evidence: {
      concrete_slice_divergence: true, frozen_exact_member: true,
      not_honestly_composable_or_separate: true, resolved_or_out_of_scope: false,
    }}] }), { reason: 'rounds-exhausted-unresolved-slice-tradeoff', maintainer_decision: 'required' })
    assert.deepEqual(terminalOutcome({ rounds: 3, max_rounds: 3, finding_ledger: [{ state: 'out-of-scope', blocker_evidence: {} }] }),
      { reason: 'rounds-exhausted-conservative-defer', maintainer_decision: 'not-required' })
  })

  test('requires an explicitly isolated prototype and concrete evidence before advancing', () => {
    const input = prototypeAgentInput({
      proposed_shape: { name: 'stable-shape' },
      shape_charter: charter(),
      lone_spear: { coverage: [] },
    })
    assert.deepEqual(prototypeAgentOptions(), { isolated: true, apply: false, merge: false })
    assert.equal(input.prototype.worktree_mode, 'isolated-non-applied')
    assert.deepEqual(input.prototype.proposed_shape, { name: 'stable-shape' })
    const jjInput = prototypeAgentInput({
      proposed_shape: { name: 'stable-shape' },
      shape_charter: charter(),
      lone_spear: { coverage: [] },
      workspace: '/tmp/jj-prototype',
    })
    assert.deepEqual(prototypeAgentOptions('/tmp/jj-prototype'), { isolated: false })
    assert.equal(jjInput.prototype.worktree_mode, 'jj-isolated-non-applied')
    assert.equal(jjInput.prototype.workspace, '/tmp/jj-prototype')

    const proposed_shape = { name: 'stable-shape' }
    const evidence = {
      prototype: {
        worktree: '/tmp/prototype',
        applied_to_parent: false,
        proposed_shape,
        positive_probe: { command: 'positive' },
        negative_probe: { command: 'negative' },
        render_evidence: { output: 'render' },
      },
      skitarius: {
        worktree: '/tmp/prototype',
        overall_pass: true,
        compiler_evidence: { command: 'compile' },
        schema_evidence: { command: 'schema' },
        render_evidence: { output: 'render' },
      },
    }
    assert.deepEqual(prototypeGateDecision(evidence, proposed_shape), { passes: true, reason: 'prototype-verified' })
    assert.deepEqual(prototypeGateDecision(evidence, proposed_shape, '/tmp/prototype'),
      { passes: true, reason: 'prototype-verified' })
    assert.deepEqual(prototypeGateDecision(evidence, proposed_shape, '/tmp/other'),
      { passes: false, reason: 'prototype-workspace-drift' })
    assert.deepEqual(prototypeGateDecision({ ...evidence, prototype: { ...evidence.prototype, proposed_shape: { name: 'other' } } }, proposed_shape),
      { passes: false, reason: 'prototype-candidate-drift' })
    assert.deepEqual(prototypeGateDecision({ ...evidence, skitarius: { overall_pass: false } }, proposed_shape),
      { passes: false, reason: 'prototype-skitarius-failed' })
    assert.deepEqual(prototypeGateDecision({ ...evidence, prototype: { ...evidence.prototype, applied_to_parent: true } }, proposed_shape),
      { passes: false, reason: 'prototype-parent-contamination' })
    assert.deepEqual(prototypeGateDecision({ ...evidence, skitarius: { ...evidence.skitarius, compiler_evidence: {} } }, proposed_shape),
      { passes: false, reason: 'prototype-evidence-incomplete' })
  })

  test('requires machine-applicable revisions to reproduce the prior candidate and address open findings', () => {
    const prior = { name: 'stable', kind: 'effect-leaf', modifier: { radius: 6 } }
    const revision = { changes: [{ op: 'replace', path: '/modifier/radius', finding_id: 'f1', value: 9 }] }
    const next = { name: 'stable', kind: 'effect-leaf', modifier: { radius: 9 } }
    assert.deepEqual(applyRevision(prior, revision), next)
    assert.doesNotThrow(() => assertRevision(prior, next, revision, [{ key: 'f1', state: 'open' }]))
    assert.throws(() => assertRevision(prior, prior, revision, [{ key: 'f1', state: 'open' }]), /do not reproduce/)
    assert.throws(() => assertRevision(prior, next, revision, [{ key: 'other', state: 'open' }]), /not addressed/)
    assert.throws(() => applyRevision(prior, { changes: [{ op: 'replace', path: '/modifier/missing', finding_id: 'f1', value: 9 }] }), /path does not exist/)
    assert.throws(() => applyRevision(prior, { changes: [{ op: 'remove', path: '/modifier/missing', finding_id: 'f1' }] }), /path does not exist/)
    assert.throws(() => applyRevision(prior, { changes: [{ op: 'replace', path: '/', finding_id: 'f1', value: {} }] }), /machine-applicable/)
  })

  test('turns every severity-3 psyker finding into an open fidelity blocker', () => {
    const findings = psykerSeverityFindings({
      findings: [
        { severity: '2', phrase: 'minor', issue: 'wording' },
        { severity: '3', phrase: 'undefined source', issue: 'source gate is missing' },
      ],
    })
    assert.deepEqual(findings, [{
      key: 'psyker:severity-3:1',
      state: 'open',
      axis: 'fidelity',
      severity: 3,
      situation: 'undefined source — source gate is missing',
      required_change: 'source gate is missing',
      blocker_evidence: {
        concrete_slice_divergence: true,
        frozen_exact_member: true,
        not_honestly_composable_or_separate: true,
        resolved_or_out_of_scope: false,
      },
    }])
    assert.equal(classifyBlocker(findings[0]).blocks, true)
  })

  test('strictly binds shape packages to candidate, trail, prototype, coverage, and ports', () => {
    const candidate = {
      name: 'stable',
      kind: 'effect-leaf',
      schema_sketch: { type: 'stable' },
      seed_encoding: { type: 'stable', radius: 6 },
      parameters: [{ load_bearing: true, type: 'integer', name: 'radius' }],
    }
    const coverage = [
      { ability_id: 'seed', faction: 'example', fit: 'faithful', match_strength: 'exact' },
      { ability_id: 'peer', faction: 'other', fit: 'needs-param', match_strength: 'near' },
    ]
    const describer = {
      render_rules: [{ form: 'inline-single-effect', template: 'inline', expected_output: 'inline output' }, { form: 'container', template: 'container', expected_output: 'container output' }],
      conformance_cases: [{ case: 'fixture', expected_phrase: 'output' }],
      port_notes: ['all ports'],
    }
    const cost = { schema_change: true, spec_bump: true, conformance_cases: 1, files: ['tools/a', 'crates/a', 'python/a', 'go/a'] }
    const trail = { proposed_shape_name: 'stable', ...describer, cost }
    const prototype = { prototype: { proposed_shape: candidate } }
    const shape_package = {
      name: 'stable', kind: 'effect-leaf', seed_ability_id: 'seed', seed_faction_id: 'example',
      schema_branch: candidate.schema_sketch, seed_encoding: candidate.seed_encoding,
      parameters: candidate.parameters, describer, cost, faithful_family: coverage,
    }
    const validate = value => validateShapePackage(value, charter(), seed, candidate, coverage, trail, prototype)
    assert.doesNotThrow(() => validate(shape_package))
    assert.doesNotThrow(() => validate({ ...shape_package, parameters: [{ name: 'radius', type: 'integer', load_bearing: true }] }))
    assert.throws(() => validate({}), /identity/)
    assert.throws(() => validate({ ...shape_package, name: 'drifted' }), /candidate artifact/)
    assert.throws(() => validate({ ...shape_package, parameters: [{ name: 'radius', type: 'integer', load_bearing: false }] }), /candidate artifact/)
    assert.throws(() => validate({ ...shape_package, schema_branch: { type: 'other' } }), /candidate artifact/)
    assert.throws(() => validate({ ...shape_package, seed_encoding: { type: 'other' } }), /candidate artifact/)
    assert.throws(() => validate({ ...shape_package, faithful_family: [{ ...coverage[0], match_strength: 'near' }, coverage[1]] }), /coverage drift/)
    assert.throws(() => validate({ ...shape_package, describer: { ...describer, render_rules: [describer.render_rules[0]] } }), /required render form/)
    assert.throws(() => validate({ ...shape_package, faithful_family: [...coverage, { ability_id: 'deferred', faction: 'other', fit: 'faithful', match_strength: 'exact' }] }), /family drift/)
    assert.throws(() => validate({ ...shape_package, cost: { ...cost, files: ['tools/a'] } }), /trail artifact drift/)
    assert.throws(() => validateShapePackage(shape_package, charter(), seed, candidate, coverage, { ...trail, port_notes: ['drift'] }, prototype), /trail artifact drift/)
    assert.throws(() => validateShapePackage(shape_package, charter(), seed, candidate, coverage, trail, { prototype: { proposed_shape: { ...candidate, kind: 'condition' } } }), /prototype candidate drift/)
  })

  test('requires distinct scoped eversor voters on distinct frozen family members', () => {
    const panel = [
      { voter_id: 'eversor-1', ability_id: 'seed', review_scope: { mechanic_slice: 'a constrained mechanic' }, refuted: false, divergences: [] },
      { voter_id: 'eversor-2', ability_id: 'peer', review_scope: { mechanic_slice: 'a constrained mechanic' }, refuted: false, divergences: [] },
    ]
    assert.doesNotThrow(() => assertScopedRefutations(panel, 'a constrained mechanic', charter()))
    assert.throws(() => assertScopedRefutations(panel.slice(0, 1), 'a constrained mechanic', charter()), /at least two/)
    assert.throws(() => assertScopedRefutations([{ ...panel[0], refuted: true }, panel[1]], 'a constrained mechanic', charter()), /refutation/)
    assert.throws(() => assertScopedRefutations([{ ...panel[0] }, { ...panel[1], voter_id: 'eversor-1' }], 'a constrained mechanic', charter()), /distinct voters/)
    assert.throws(() => assertScopedRefutations([{ ...panel[0] }, { ...panel[1], ability_id: 'seed' }], 'a constrained mechanic', charter()), /distinct voters/)
    assert.throws(() => assertScopedRefutations([{ ...panel[0] }, { ...panel[1], ability_id: 'outside' }], 'a constrained mechanic', charter()), /outside frozen family/)
    assert.throws(() => assertScopedRefutations([{ ...panel[0], divergences: [{ situation: 'gap' }] }, panel[1]], 'a constrained mechanic', charter()), /refutation/)
  })
})
