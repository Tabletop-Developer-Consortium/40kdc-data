import { canonicalJson } from './canonical.js'
import { semanticKey } from './claims.js'
import {
  MECHANIC_PROPOSITION_SCHEMA_ID,
  MECHANIC_PROPOSITION_SCHEMA_VERSION,
  buildMechanicRegistry,
  mechanicClaimAdapter,
} from './mechanic-claims.js'

const WRAPPER_CHILDREN = Object.freeze({
  sequence: [{ path: ['steps'], role: 'members', ordered: true, array: true }],
  choice: [{ path: ['options'], role: 'members', array: true }],
  'dice-gated': [{ path: ['on_success'], role: 'on-success' }, { path: ['on_fail'], role: 'on-failure' }],
  conditional: [{ path: ['condition'], role: 'condition', condition: true }, { path: ['effect'], role: 'members' }],
  'dice-pool-allocation': [{ path: ['options'], child: ['effect'], role: 'members', array: true }],
  'select-units': [{ path: ['effect'], role: 'members' }],
  'movement-modifier': [{ path: ['modifier', 'condition'], role: 'condition', condition: true }],
  aura: [{ path: ['modifier', 'effect'], role: 'members' }],
  'leader-model-ability-grant': [{ path: ['grant', 'effect'], role: 'members' }],
  'designate-target': [{ path: ['applies', 'effect'], role: 'members' }],
  'persistent-designation': [{ path: ['consumer', 'effect'], role: 'members' }],
  'stance-select': [{ path: ['options'], child: ['effect'], role: 'members', array: true }],
  'risk-reward': [{ path: ['reward'], role: 'on-success' }, { path: ['risk', 'on_fail'], role: 'on-failure' }],
  'issue-orders': [{ path: ['options'], child: ['effect'], role: 'members', array: true }],
  'resource-action-menu': [{ path: ['actions'], child: ['effect'], role: 'members', array: true }],
})

function escapePointerToken(value) { return String(value).replaceAll('~', '~0').replaceAll('/', '~1') }
function pointerJoin(pointer, ...tokens) { return `${pointer}${tokens.map(token => `/${escapePointerToken(token)}`).join('')}` }
function getPath(value, path) { return path.reduce((current, key) => current?.[key], value) }
function proposition(value) { return { schema_id: MECHANIC_PROPOSITION_SCHEMA_ID, schema_version: MECHANIC_PROPOSITION_SCHEMA_VERSION, value } }
function argument(role, value) { return { role, value } }
function claimValue(predicate, args = [], qualifiers = []) { return { predicate, arguments: args, qualifiers } }

function makeAssertion(value, pointer, context) {
  const prop = proposition(value)
  const semantic_key = semanticKey({ adapter_id: mechanicClaimAdapter.adapter_id, proposition: prop, polarity: 'affirms', modality: 'asserted' }, mechanicClaimAdapter)
  return {
    extraction_local_id: `${context.ability_id}:${pointer || '/'}`,
    semantic_key,
    proposition: prop,
    polarity: 'affirms',
    modality: 'asserted',
    evidence: [{ kind: 'structured_path', origin_id: context.origin_id, path_kind: 'json_pointer', path: pointer }],
  }
}

function residualParameters(node, omitted) {
  const value = Object.fromEntries(Object.entries(node).filter(([key]) => !omitted.has(key)))
  return Object.keys(value).length ? value : null
}

function leafCandidate(node, pointer, context) {
  const args = []
  const omitted = new Set(['type'])
  if (node.target !== undefined) { args.push(argument('affected-entity', node.target)); omitted.add('target') }
  const threshold = node.type === 'feel-no-pain' ? node.modifier?.threshold : node.threshold
  if (threshold !== undefined) args.push(argument('threshold', threshold))
  if (node.type === 'feel-no-pain' && node.modifier?.scope !== undefined) args.push(argument('scope', node.modifier.scope))
  const parameters = residualParameters(node, omitted)
  if (parameters !== null) {
    const cleaned = structuredClone(parameters)
    if (node.type === 'feel-no-pain' && cleaned.modifier) {
      delete cleaned.modifier.threshold
      delete cleaned.modifier.scope
      if (Object.keys(cleaned.modifier).length === 0) delete cleaned.modifier
    }
    if (Object.keys(cleaned).length) args.push(argument('parameters', cleaned))
  }
  return makeAssertion(claimValue(`mechanic.effect.${node.type}`, args), pointer, context)
}

function controlsForWrapper(node, childSpecs) {
  const controls = structuredClone(node)
  delete controls.type
  for (const spec of childSpecs) {
    const parent = spec.path.slice(0, -1).reduce((value, key) => value?.[key], controls)
    if (parent && typeof parent === 'object') delete parent[spec.path.at(-1)]
  }
  return controls
}

function mapCondition(node, pointer, context, out) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.type === 'string') {
    if (!context.registry.predicates.has(`mechanic.condition.${node.type}`)) {
      out.unresolved.push(ontologyGap(pointer, node.type, context.origin_id))
      return null
    }
    const args = node.parameters === undefined ? [] : [argument('parameters', node.parameters)]
    const qualifiers = node.negated ? [{ kind: 'condition.negated', value: true }] : []
    const assertion = makeAssertion(claimValue(`mechanic.condition.${node.type}`, args, qualifiers), pointer, context)
    out.assertions.push(assertion)
    return assertion.semantic_key
  }
  const operator = node.operator
  const operands = node.operands
  if (!context.registry.predicates.has(`mechanic.composition.${operator}`)) {
    out.unresolved.push(ontologyGap(pointer, operator ?? 'condition', context.origin_id))
    return null
  }
  if (operator === 'not' && (!Array.isArray(operands) || operands.length !== 1)) {
    out.unresolved.push(ontologyGap(pointer, 'not-arity', context.origin_id))
    return null
  }
  const members = (operands ?? []).map((child, index) => mapCondition(child, pointerJoin(pointer, 'operands', index), context, out)).filter(Boolean)
  if (operator !== 'not') members.sort()
  const qualifiers = operator === 'not' ? [{ kind: 'condition.negated', value: true }] : []
  const assertion = makeAssertion(claimValue(`mechanic.composition.${operator}`, [argument('members', members), argument('operator', operator)], qualifiers), pointer, context)
  out.assertions.push(assertion)
  return assertion.semantic_key
}
function namedRegionCandidate(node, pointer, context, out) {
  const consumer = node.modifier?.consumer
  if (!consumer || typeof consumer !== 'object') {
    out.unresolved.push(ontologyGap(pointer, 'named-region-state', context.origin_id))
    return null
  }
  const args = []
  if (node.target !== undefined) args.push(argument('affected-entity', node.target))
  const condition = mapCondition(consumer.qualified_condition, pointerJoin(pointer, 'modifier', 'consumer', 'qualified_condition'), context, out)
  const defaultBranch = mapEffect(consumer.default_branch?.effect, pointerJoin(pointer, 'modifier', 'consumer', 'default_branch', 'effect'), context, out)
  const qualifiedBranch = mapEffect(consumer.qualified_branch?.effect, pointerJoin(pointer, 'modifier', 'consumer', 'qualified_branch', 'effect'), context, out)
  if (condition) args.push(argument('condition', condition))
  if (defaultBranch) args.push(argument('default-branch', defaultBranch))
  if (qualifiedBranch) args.push(argument('qualified-branch', qualifiedBranch))
  const controls = structuredClone(node)
  delete controls.type
  delete controls.target
  delete controls.modifier.consumer.qualified_condition
  delete controls.modifier.consumer.default_branch.effect
  delete controls.modifier.consumer.qualified_branch.effect
  args.push(argument('parameters', controls))
  const assertion = makeAssertion(claimValue('mechanic.effect.named-region-state', args), pointer, context)
  out.assertions.push(assertion)
  return assertion.semantic_key
}

function resourceActionMenuCandidate(node, pointer, context, out) {
  const members = (node.actions ?? []).map((action, index) => {
    const actionPointer = pointerJoin(pointer, 'actions', index)
    const effect = mapEffect(action.effect, pointerJoin(actionPointer, 'effect'), context, out)
    const triggers = (Array.isArray(action.when) ? action.when : [action.when]).map((trigger, triggerIndex) => {
      const triggerPointer = Array.isArray(action.when)
        ? pointerJoin(actionPointer, 'when', triggerIndex)
        : pointerJoin(actionPointer, 'when')
      const assertion = triggerCandidate(trigger, triggerPointer, context)
      out.assertions.push(assertion)
      if (trigger.condition) mapCondition(trigger.condition, pointerJoin(triggerPointer, 'condition'), context, out)
      return assertion.semantic_key
    })
    const conditions = (action.eligibility?.requires ?? []).map((condition, conditionIndex) =>
      mapCondition(condition, pointerJoin(actionPointer, 'eligibility', 'requires', conditionIndex), context, out),
    ).filter(Boolean)
    const member = structuredClone(action)
    member.effect = effect
    member.when = triggers
    if (member.eligibility?.requires) member.eligibility.requires = conditions
    return member
  })
  members.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  const args = [argument('members', members)]
  const controls = structuredClone(node)
  delete controls.type
  delete controls.actions
  if (Object.keys(controls).length) args.push(argument('parameters', controls))
  const assertion = makeAssertion(claimValue('mechanic.composition.resource-action-menu', args), pointer, context)
  out.assertions.push(assertion)
  return assertion.semantic_key
}


function mapEffect(node, pointer, context, out) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    out.unresolved.push(ontologyGap(pointer, 'effect-node', context.origin_id))
    return null
  }
  if (node.type === 'named-region-state') return namedRegionCandidate(node, pointer, context, out)
  const leafPredicate = `mechanic.effect.${node.type}`
  if (context.registry.predicates.has(leafPredicate)) {
    const assertion = leafCandidate(node, pointer, context)
    out.assertions.push(assertion)
    return assertion.semantic_key
  }
  const compositionPredicate = `mechanic.composition.${node.type}`
  const childSpecs = WRAPPER_CHILDREN[node.type]
  if (!context.registry.predicates.has(compositionPredicate) || !childSpecs) {
    out.unresolved.push(ontologyGap(pointer, node.type, context.origin_id))
    return null
  }
  if (node.type === 'resource-action-menu') return resourceActionMenuCandidate(node, pointer, context, out)
  const args = []
  for (const spec of childSpecs) {
    const value = getPath(node, spec.path)
    if (spec.array) {
      const members = (value ?? []).map((entry, index) => {
        const child = spec.child ? getPath(entry, spec.child) : entry
        const childPointer = pointerJoin(pointer, ...spec.path, index, ...(spec.child ?? []))
        return spec.condition ? mapCondition(child, childPointer, context, out) : mapEffect(child, childPointer, context, out)
      }).filter(Boolean)
      if (!spec.ordered) members.sort()
      args.push(argument(spec.role, members))
    } else if (value !== undefined && value !== null) {
      const childPointer = pointerJoin(pointer, ...spec.path)
      const key = spec.condition ? mapCondition(value, childPointer, context, out) : mapEffect(value, childPointer, context, out)
      if (key) args.push(argument(spec.role, key))
    }
  }

  const controls = controlsForWrapper(node, childSpecs)
  if (Object.keys(controls).length) args.push(argument('parameters', controls))
  const assertion = makeAssertion(claimValue(compositionPredicate, args), pointer, context)
  out.assertions.push(assertion)
  return assertion.semantic_key
}

function ontologyGap(pointer, focus, origin_id) {
  return { kind: 'ontology_gap', canonical_focus: { pointer, focus, origin_id }, candidate_semantic_keys: [], blocks_obligations: ['retrieve', 'represent'] }
}

function triggerCandidate(trigger, pointer, context) {
  const args = [argument('event', trigger.event)]
  for (const [field, role] of [['subject', 'actor'], ['proximity', 'scope'], ['move_types', 'parameters'], ['optional', 'optional'], ['cost', 'cost'], ['window', 'window']]) {
    if (trigger[field] !== undefined) args.push(argument(role, trigger[field]))
  }
  return makeAssertion(claimValue('mechanic.trigger', args), pointer, context)
}

function hasGate(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasGate)
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'condition' || key === 'when' || key === 'usage' || key === 'cost') && child !== undefined && child !== null) return true
    if (key === 'duration' && child !== undefined && child !== null && child !== 'permanent') return true
    if (hasGate(child)) return true
  }
  return false
}

export function deriveTimingCandidates({ ability, origin_id, registry = buildMechanicRegistry(), ability_pointer = '' }) {
  const context = { ability_id: ability.ability_id, origin_id, registry }
  const assertions = []
  const triggerList = ability.trigger === undefined ? [] : (Array.isArray(ability.trigger) ? ability.trigger : [ability.trigger])
  for (const [index, trigger] of triggerList.entries()) {
    const pointer = Array.isArray(ability.trigger) ? pointerJoin(ability_pointer, 'trigger', index) : pointerJoin(ability_pointer, 'trigger')
    assertions.push(triggerCandidate(trigger, pointer, context))
  }
  const duration = ability.scope?.duration
  const passive = (ability.behavior === undefined || ability.behavior === 'passive') &&
    triggerList.length === 0 && !hasGate(ability.effect) && ability.usage === undefined
  if (duration !== undefined) {
    const mapped = duration === 'permanent' ? 'continuous' : duration
    const qualifiers = duration === 'permanent' && passive ? [{ kind: 'timing.passive', value: true }] : []
    assertions.push(makeAssertion(claimValue('mechanic.duration', [argument('duration', mapped)], qualifiers), pointerJoin(ability_pointer, 'scope', 'duration'), context))
    if (duration === 'one-use') {
      assertions.push(makeAssertion(claimValue('mechanic.usage', [argument('frequency', 'once-per-battle')]), pointerJoin(ability_pointer, 'scope', 'duration'), context))
    }
  } else if (passive) {
    assertions.push(makeAssertion(claimValue('mechanic.duration', [argument('duration', 'continuous')], [{ kind: 'timing.passive', value: true }]), pointerJoin(ability_pointer, 'effect'), context))
  }
  return assertions
}

export function mapEffectNodeToCandidates({ node, pointer = '/effect', origin_id, registry = buildMechanicRegistry(), ability_id = 'anonymous' }) {
  const out = { assertions: [], unresolved: [] }
  mapEffect(node, pointer, { ability_id, origin_id, registry }, out)
  return out
}

export function mapConditionNodeToCandidates({ node, pointer = '/condition', origin_id, registry = buildMechanicRegistry(), ability_id = 'anonymous' }) {
  const out = { assertions: [], unresolved: [] }
  mapCondition(node, pointer, { ability_id, origin_id, registry }, out)
  return out
}

export function mapAbilityDslToCandidates({ faction_id, ability, origin_id, registry = buildMechanicRegistry(), ability_pointer = '' }) {
  const out = { assertions: [], unresolved: [] }
  const context = { ability_id: ability.ability_id, faction_id, origin_id, registry, ability_pointer }
  mapEffect(ability.effect, pointerJoin(ability_pointer, 'effect'), context, out)
  const triggers = ability.trigger === undefined ? [] : (Array.isArray(ability.trigger) ? ability.trigger : [ability.trigger])
  for (const [index, trigger] of triggers.entries()) {
    const pointer = Array.isArray(ability.trigger) ? pointerJoin(ability_pointer, 'trigger', index) : pointerJoin(ability_pointer, 'trigger')
    out.assertions.push(triggerCandidate(trigger, pointer, context))
    if (trigger.condition) mapCondition(trigger.condition, pointerJoin(pointer, 'condition'), context, out)
  }
  if (ability.scope?.range !== undefined) {
    const args = [argument('range', ability.scope.range)]
    if (ability.scope.range_inches !== undefined) args.push(argument('parameters', { range_inches: ability.scope.range_inches }))
    out.assertions.push(makeAssertion(claimValue('mechanic.scope.range', args), pointerJoin(ability_pointer, 'scope', 'range'), context))
  }
  out.assertions.push(...deriveTimingCandidates({ ability, origin_id, registry, ability_pointer }))
  if (ability.usage !== undefined) {
    const args = [argument('frequency', ability.usage.frequency)]
    if (ability.usage.count !== undefined) args.push(argument('count', ability.usage.count))
    if (ability.usage.per !== undefined) args.push(argument('per', ability.usage.per))
    out.assertions.push(makeAssertion(claimValue('mechanic.usage', args), pointerJoin(ability_pointer, 'usage'), context))
  }
  if (ability.applies_to !== undefined && ability.applies_to !== null) {
    const args = []
    if (ability.applies_to.required_keywords !== undefined) args.push(argument('required-keywords', ability.applies_to.required_keywords))
    if (ability.applies_to.excluded_keywords !== undefined) args.push(argument('excluded-keywords', ability.applies_to.excluded_keywords))
    out.assertions.push(makeAssertion(claimValue('mechanic.selection.applies-to', args), pointerJoin(ability_pointer, 'applies_to'), context))
  }
  return { ...out, completeness: { state: 'incomplete', obligations_checked: ['retrieve', 'represent'] }, registry_schema_sha256: registry.registry_schema_sha256 }
}
