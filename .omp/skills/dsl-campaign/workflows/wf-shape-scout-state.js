export const FINDING_STATES = Object.freeze(['open', 'resolved', 'out-of-scope', 'superseded'])
const OPEN_FINDING_STATE = 'open'
const TERMINAL_FINDING_STATES = new Set(['resolved', 'out-of-scope', 'superseded'])


export function freezeShapeCharter({ seed, mechanic_slice, family, required_semantics, non_goals = [], deferred_candidates = [], acceptance_fixtures = [], reopening_rules }) {
  const exact_family = uniqueMembers(family)
  if (!mechanic_slice || !exact_family.length || !required_semantics?.length || !acceptance_fixtures.length || !reopening_rules) {
    throw new Error('shape_charter requires mechanic_slice, exact family, required_semantics, acceptance_fixtures, and reopening_rules')
  }
  if (!exact_family.some(member => member.ability_id === seed.ability_id && member.faction === seed.faction_id)) {
    throw new Error('shape_charter exact_family must include the seed')
  }
  return freezeCharterValue({
    mechanic_slice,
    exact_family,
    required_semantics,
    non_goals,
    deferred_candidates,
    acceptance_fixtures,
    reopening_rules,
  })
}

export function validateShapeCharter(charter, seed) {
  return freezeShapeCharter({ seed, mechanic_slice: charter?.mechanic_slice, family: charter?.exact_family,
    required_semantics: charter?.required_semantics, non_goals: charter?.non_goals,
    deferred_candidates: charter?.deferred_candidates, acceptance_fixtures: charter?.acceptance_fixtures,
    reopening_rules: charter?.reopening_rules })
}

export function assertCharterFamily(charter, coverage) {
  const frozen = memberKeys(charter.exact_family)
  const accepted = []
  for (const member of coverage || []) {
    const key = `${member.ability_id}/${member.faction}`
    if (!frozen.has(key)) throw new Error(`family drift: ${key} was discovered after charter freeze; defer it instead of broadening acceptance`)
    if (!isAcceptableCoverage(member)) {
      throw new Error(`frozen family member lacks exact-or-near faithful coverage: ${key}`)
    }
    accepted.push(member)
  }
  const acceptedKeys = memberKeys(accepted)
  if (acceptedKeys.size !== accepted.length) throw new Error('coverage includes duplicate frozen family member')
  if (acceptedKeys.size !== frozen.size) {
    for (const key of frozen) {
      if (!acceptedKeys.has(key)) throw new Error(`frozen family member missing from coverage: ${key}`)
    }
  }
  return mechanicKeys(accepted).size
}
export function countFamilyMechanics(members) {
  return mechanicKeys(members).size
}


export function mergeDeferredCandidates(charter, discoveries = []) {
  const frozen = memberKeys(charter.exact_family)
  const deferred = []
  const seen = new Set()
  for (const member of [...(charter.deferred_candidates || []), ...discoveries]) {
    const key = `${member?.ability_id}/${member?.faction}`
    if (!member?.ability_id || !member?.faction || frozen.has(key) || seen.has(key)) continue
    seen.add(key)
    deferred.push(member)
  }
  return deferred
}

export function prototypeAgentInput({ proposed_shape, shape_charter, deferred_family, lone_spear }) {
  return {
    prototype: { proposed_shape, shape_charter, worktree_mode: 'isolated-non-applied' },
    context: { deferred_family, lone_spear },
  }
}

export function prototypeAgentOptions() {
  return { isolated: true, apply: false, merge: false }
}

export function assertShapeIdentity(previous_shape, candidate) {
  if (!previous_shape) return
  for (const field of ['name', 'kind']) {
    if (candidate?.[field] !== previous_shape[field]) throw new Error(`illicit shape identity drift: ${field} changed from ${previous_shape[field]} to ${candidate?.[field]}`)
  }
}

export function normalizeFindingLedger(previous = [], findings = [], charter) {
  const byKey = new Map(previous.map(finding => [finding.key, { ...finding }]))
  for (const finding of findings) {
    if (!finding.key) throw new Error('finding ledger entries require stable key')
    const existing = byKey.get(finding.key)
    const state = finding.state || existing?.state || OPEN_FINDING_STATE
    const next = { ...existing, ...finding, state }
    assertFindingTransition(existing, next, charter)
    byKey.set(finding.key, next)
  }
  for (const finding of byKey.values()) {
    if (finding.state !== 'superseded') continue
    const replacement = byKey.get(finding.superseded_by)
    if (!replacement || replacement.key === finding.key ||
      ![OPEN_FINDING_STATE, 'resolved'].includes(replacement.state)) {
      throw new Error(`superseded finding requires a distinct open or resolved replacement: ${finding.key}`)
    }
  }
  return [...byKey.values()]
}

export function resolveFindingLedger(ledger, currentFindings, charter) {
  return normalizeFindingLedger(ledger, currentFindings, charter)
}

export function applyRevision(previous_shape, revision) {
  if (!revision?.changes?.length) throw new Error('revision requires non-empty changes')
  const next = structuredClone(previous_shape)
  for (const change of revision.changes) {
    if (!['add', 'replace', 'remove'].includes(change.op) || !change.path?.startsWith('/') ||
      change.path === '/' || !change.finding_id) {
      throw new Error('revision change must be machine-applicable')
    }
    applyPointer(next, change)
  }
  return next
}

export function assertRevision(previous_shape, proposed_shape, revision, ledger) {
  if (!deepEqual(applyRevision(previous_shape, revision), proposed_shape)) throw new Error('revision changes do not reproduce proposed_shape')
  assertShapeIdentity(previous_shape, proposed_shape)
  const addressed = new Set(revision.changes.map(change => change.finding_id))
  for (const finding of ledger.filter(isOpenFinding)) if (!addressed.has(finding.key)) throw new Error(`open finding not addressed: ${finding.key}`)
}

export function validateShapePackage(shape_package, charter, seed, candidate, coverage, trail, prototype) {
  if (!shape_package || !isNonEmptyString(shape_package.name) ||
    !['effect-leaf', 'condition', 'container', 'modifier-extension'].includes(shape_package.kind) ||
    shape_package.seed_ability_id !== seed.ability_id || shape_package.seed_faction_id !== seed.faction_id) {
    throw new Error('invalid shape_package identity')
  }
  if (shape_package.name !== candidate?.name || shape_package.kind !== candidate?.kind ||
    !deepEqual(shape_package.parameters, candidate?.parameters) ||
    !deepEqual(shape_package.schema_branch, candidate?.schema_sketch) ||
    !deepEqual(shape_package.seed_encoding, candidate?.seed_encoding)) {
    throw new Error('shape_package candidate artifact drift')
  }
  if (!isPlainObject(shape_package.schema_branch) || !hasConcreteEvidence(shape_package.schema_branch) ||
    !isPlainObject(shape_package.seed_encoding) || !hasConcreteEvidence(shape_package.seed_encoding) ||
    !Array.isArray(shape_package.parameters) || !shape_package.parameters.every(isShapeParameter)) {
    throw new Error('invalid shape_package schema, seed encoding, or parameters')
  }
  const describer = shape_package.describer
  if (!isPlainObject(describer) || !Array.isArray(describer.render_rules) || !describer.render_rules.length ||
    !describer.render_rules.every(isRenderRule) || !Array.isArray(describer.conformance_cases) ||
    !describer.conformance_cases.length || !describer.conformance_cases.every(isConformanceCase) ||
    !Array.isArray(describer.port_notes) || !describer.port_notes.length ||
    !describer.port_notes.every(isNonEmptyString)) {
    throw new Error('invalid shape_package describer')
  }
  const requiredForms = shape_package.kind === 'condition'
    ? ['condition-lead-in', 'condition-predicate']
    : ['inline-single-effect', 'container']
  const renderForms = new Set(describer.render_rules.map(rule => rule?.form))
  if (requiredForms.some(form => !renderForms.has(form))) throw new Error('shape_package describer missing required render form')
  if (trail?.proposed_shape_name !== candidate.name ||
    !deepEqual(describer.render_rules, trail.render_rules) ||
    !deepEqual(describer.port_notes, trail.port_notes) ||
    !deepEqual(describer.conformance_cases, trail.conformance_cases) ||
    !deepEqual(shape_package.cost, trail.cost)) {
    throw new Error('shape_package trail artifact drift')
  }
  if (!deepEqual(prototype?.prototype?.proposed_shape, candidate)) {
    throw new Error('shape_package prototype candidate drift')
  }
  const cost = shape_package.cost
  if (!cost?.schema_change || !cost?.spec_bump || !Number.isInteger(cost?.conformance_cases) ||
    cost.conformance_cases < 1 || !Array.isArray(cost.files) ||
    !['tools/', 'crates/', 'python/', 'go/'].every(prefix => cost.files.some(file => file.startsWith(prefix)))) {
    throw new Error('invalid shape_package cost')
  }
  if (cost.conformance_cases !== describer.conformance_cases.length) {
    throw new Error('shape_package conformance case count drift')
  }
  const family = shape_package.faithful_family || []
  assertCharterFamily(charter, family)
  assertExactMemberKeys(family, coverage, 'shape_package coverage drift')
  for (const member of family) {
    const covered = coverage.find(item => member.ability_id === item.ability_id && member.faction === item.faction)
    if (member.fit !== covered.fit || member.match_strength !== covered.match_strength) {
      throw new Error(`shape_package coverage drift: ${member.ability_id}/${member.faction}`)
    }
  }
  return shape_package
}
export function assertScopedRefutations(refutations, mechanic_slice, charter) {
  if (!Array.isArray(refutations) || refutations.length < 2) throw new Error('scoped eversor panel requires at least two members')
  const frozen = mechanicKeys(charter.exact_family)
  const voterIds = new Set()
  const sampleIds = new Set()
  for (const refutation of refutations) {
    if (!isNonEmptyString(refutation?.voter_id) || !isNonEmptyString(refutation?.ability_id) ||
      refutation?.review_scope?.mechanic_slice !== mechanic_slice || typeof refutation?.refuted !== 'boolean' ||
      !Array.isArray(refutation?.divergences)) {
      throw new Error('eversor refutation requires voter, frozen ability, matching review scope, refuted status, and divergences')
    }
    if (voterIds.has(refutation.voter_id) || sampleIds.has(refutation.ability_id)) {
      throw new Error('scoped eversor panel requires distinct voters and frozen samples')
    }
    if (!frozen.has(refutation.ability_id)) throw new Error(`eversor sample is outside frozen family: ${refutation.ability_id}`)
    voterIds.add(refutation.voter_id)
    sampleIds.add(refutation.ability_id)
    if (refutation.refuted || refutation.divergences.length) throw new Error('scoped eversor refutation remains unresolved')
  }
}

export function classifyBlocker(finding) {
  const evidence = finding?.blocker_evidence || {}
  const resolved_or_out_of_scope = isTerminalFinding(finding)
  const blocks = Boolean(evidence.concrete_slice_divergence && evidence.frozen_exact_member &&
    evidence.not_honestly_composable_or_separate && !resolved_or_out_of_scope)
  return { blocks, evidence: {
    concrete_slice_divergence: Boolean(evidence.concrete_slice_divergence),
    frozen_exact_member: Boolean(evidence.frozen_exact_member),
    not_honestly_composable_or_separate: Boolean(evidence.not_honestly_composable_or_separate),
    resolved_or_out_of_scope,
  } }
}

export function prototypeGateDecision(report, candidate) {
  const prototype = report?.prototype
  if (!prototype || prototype.applied_to_parent !== false) return { passes: false, reason: 'prototype-parent-contamination' }
  if (!deepEqual(prototype.proposed_shape, candidate)) return { passes: false, reason: 'prototype-candidate-drift' }
  if (!hasConcreteEvidence(prototype.worktree) || !hasConcreteEvidence(prototype.positive_probe) ||
    !hasConcreteEvidence(prototype.negative_probe) || !hasConcreteEvidence(prototype.render_evidence)) {
    return { passes: false, reason: 'prototype-evidence-incomplete' }
  }
  const skitarius = report.skitarius
  if (!skitarius?.overall_pass || skitarius.worktree !== prototype.worktree) return { passes: false, reason: 'prototype-skitarius-failed' }
  if (!hasConcreteEvidence(skitarius.compiler_evidence) || !hasConcreteEvidence(skitarius.schema_evidence) ||
    !hasConcreteEvidence(skitarius.render_evidence)) return { passes: false, reason: 'prototype-evidence-incomplete' }
  return { passes: true, reason: 'prototype-verified' }
}

export function terminalOutcome({ rounds, max_rounds, finding_ledger }) {
  const unresolved = finding_ledger.filter(isOpenFinding)
  if (rounds < max_rounds) return null
  const blockers = unresolved.map(classifyBlocker).filter(result => result.blocks)
  return blockers.length
    ? { reason: 'rounds-exhausted-unresolved-slice-tradeoff', maintainer_decision: 'required' }
    : { reason: 'rounds-exhausted-conservative-defer', maintainer_decision: 'not-required' }
}

function assertFindingTransition(previous, next, charter) {
  if (!FINDING_STATES.includes(next.state)) throw new Error(`invalid finding state: ${next.state}`)
  if (next.state === OPEN_FINDING_STATE && next.blocker_evidence?.resolved_or_out_of_scope) {
    throw new Error('open finding cannot claim resolved_or_out_of_scope evidence')
  }
  if (next.state !== OPEN_FINDING_STATE && !isOpenFinding(previous)) {
    throw new Error(`${next.state} finding requires a prior open finding`)
  }
  if (next.state === 'resolved' && !hasConcreteEvidence(next.resolution_evidence)) {
    throw new Error('resolved finding requires resolution_evidence')
  }
  if (next.state === 'out-of-scope' &&
    (!(next.orthogonal_gap || charter?.non_goals?.includes(next.mechanic)) ||
      !hasConcreteEvidence(next.scope_evidence))) {
    throw new Error('out-of-scope finding requires charter grounding and scope_evidence')
  }
  if (next.state === 'superseded' &&
    (!isNonEmptyString(next.superseded_by) || !hasConcreteEvidence(next.supersession_evidence))) {
    throw new Error('superseded finding requires superseded_by and supersession_evidence')
  }
}
function applyPointer(root, change) {
  const parts = change.path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  const key = parts.pop()
  let target = root
  for (const part of parts) {
    if (Array.isArray(target)) {
      target = target[arrayIndex(part, target.length, false)]
    } else if (target && typeof target === 'object' && Object.hasOwn(target, part)) {
      target = target[part]
    } else {
      throw new Error(`revision path does not exist: ${change.path}`)
    }
  }
  if (!target || typeof target !== 'object' || key == null) throw new Error(`revision path does not exist: ${change.path}`)
  if (Array.isArray(target)) {
    if (change.op === 'add') {
      const index = key === '-' ? target.length : arrayIndex(key, target.length, true)
      if (change.value === undefined) throw new Error('revision add requires value')
      target.splice(index, 0, change.value)
      return
    }
    const index = arrayIndex(key, target.length, false)
    if (change.op === 'remove') { target.splice(index, 1); return }
    if (change.value === undefined) throw new Error('revision replace requires value')
    target[index] = change.value
    return
  }
  if (change.op === 'add') {
    if (change.value === undefined) throw new Error('revision add requires value')
    target[key] = change.value
    return
  }
  if (!Object.hasOwn(target, key)) throw new Error(`revision path does not exist: ${change.path}`)
  if (change.op === 'remove') { delete target[key]; return }
  if (change.value === undefined) throw new Error('revision replace requires value')
  target[key] = change.value
}
function arrayIndex(value, length, allowEnd) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`invalid array index: ${value}`)
  const index = Number(value)
  if (index > length || (!allowEnd && index === length)) throw new Error(`array index does not exist: ${value}`)
  return index
}
function assertExactMemberKeys(left, right, error) {
  const leftKeys = memberKeys(left)
  const rightKeys = memberKeys(right)
  if (leftKeys.size !== left.length || rightKeys.size !== right.length || leftKeys.size !== rightKeys.size ||
    [...leftKeys].some(key => !rightKeys.has(key))) {
    throw new Error(error)
  }
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isShapeParameter(parameter) {
  return isPlainObject(parameter) && isNonEmptyString(parameter.name) &&
    isNonEmptyString(parameter.type) && typeof parameter.load_bearing === 'boolean'
}
function isRenderRule(rule) {
  return isPlainObject(rule) &&
    ['inline-single-effect', 'container', 'condition-lead-in', 'condition-predicate', 'negated'].includes(rule.form) &&
    isNonEmptyString(rule.template) && isNonEmptyString(rule.expected_output)
}
function isConformanceCase(item) {
  return isPlainObject(item) && isNonEmptyString(item.case) && isNonEmptyString(item.expected_phrase)
}
function uniqueMembers(members) {
  const seen = new Set()
  return (members || []).filter(member => member?.ability_id && member?.faction && !seen.has(`${member.ability_id}/${member.faction}`) && seen.add(`${member.ability_id}/${member.faction}`))
}

function isAcceptableCoverage(member) {
  return ['faithful', 'needs-param'].includes(member.fit) && ['exact', 'near'].includes(member.match_strength)
}
function isOpenFinding(finding) {
  return finding?.state === OPEN_FINDING_STATE
}
function isTerminalFinding(finding) {
  return TERMINAL_FINDING_STATES.has(finding?.state)
}

function hasConcreteEvidence(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasConcreteEvidence)
  return Object.values(value).some(item => typeof item === 'number' || typeof item === 'boolean' || hasConcreteEvidence(item))
}
function deepEqual(left, right) {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
}

function freezeCharterValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCharterValue))
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCharterValue(item)])))
  }
  return value
}

function memberKeys(members) { return new Set((members || []).map(member => `${member.ability_id}/${member.faction}`)) }
function mechanicKeys(members) { return new Set((members || []).map(member => member.ability_id)) }
