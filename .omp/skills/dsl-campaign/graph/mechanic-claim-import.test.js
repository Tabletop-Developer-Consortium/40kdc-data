import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMechanicRegistry } from './mechanic-claims.js'
import {
  deriveTimingCandidates,
  mapAbilityDslToCandidates,
  mapConditionNodeToCandidates,
  mapEffectNodeToCandidates,
} from './mechanic-claim-import.js'

const origin_id = 'a'.repeat(64)
const leaf = (type = 'deep-strike') => ({ type, target: 'unit' })
const ability = overrides => ({ ability_id: 'fabricated-ability', effect: leaf(), ...overrides })
const valueOf = assertion => assertion.proposition.value
const byPredicate = (assertions, predicate) => assertions.filter(assertion => valueOf(assertion).predicate === predicate)
const argument = (assertion, role) => valueOf(assertion).arguments.find(item => item.role === role)?.value

function timing(overrides) {
  return deriveTimingCandidates({ ability: ability(overrides), origin_id })
}

test('generated registry covers every effect wrapper and required nested child path', () => {
  const registry = buildMechanicRegistry()
  const descriptors = registry.schema_descriptors.child_paths
  const covered = new Set(descriptors.map(item => item.container_type))
  for (const wrapper of registry.schema_descriptors.effect_wrapper_types) assert.ok(covered.has(wrapper), wrapper)
  assert.deepEqual(
    descriptors.filter(item => item.container_type === 'named-region-state').map(item => [item.path, item.role]),
    [
      ['modifier/consumer/attack_condition', 'attack-condition'],
      ['modifier/consumer/qualified_condition', 'condition'],
      ['modifier/consumer/default_branch/effect', 'default-branch'],
      ['modifier/consumer/qualified_branch/effect', 'qualified-branch'],
    ],
  )
})

test('closed no-effect leaves remain explicit inside dice-table bands', () => {
  const registry = buildMechanicRegistry()
  assert.ok(registry.schema_descriptors.effect_leaf_types.includes('no-effect'))
  assert.ok(!registry.schema_descriptors.effect_wrapper_types.includes('no-effect'))
  const result = mapEffectNodeToCandidates({
    origin_id,
    node: {
      type: 'dice-table',
      dice: 'D6',
      outcomes: [
        { results: [1], effect: { type: 'no-effect' } },
        { results: [2, 3, 4, 5, 6], effect: leaf('deep-strike') },
      ],
    },
  })
  assert.deepEqual(result.unresolved, [])
  const noop = byPredicate(result.assertions, 'mechanic.effect.no-effect')[0]
  assert.deepEqual(valueOf(noop).arguments, [])
  const table = byPredicate(result.assertions, 'mechanic.composition.dice-table')[0]
  assert.ok(argument(table, 'members').some(band => band.results[0] === 1 && band.effect === noop.semantic_key))
})

test('Feel No Pain preserves entity, integer threshold, scope, and exact record pointer', () => {
  const result = mapAbilityDslToCandidates({
    faction_id: 'fabricated-faction', origin_id, ability_pointer: '/114',
    ability: ability({ effect: { type: 'feel-no-pain', target: 'unit', modifier: { threshold: 6, scope: 'mortal-wounds' } } }),
  })
  const claim = byPredicate(result.assertions, 'mechanic.effect.feel-no-pain')[0]
  assert.equal(argument(claim, 'affected-entity'), 'unit')
  assert.equal(argument(claim, 'threshold'), 6)
  assert.equal(argument(claim, 'scope'), 'mortal-wounds')
  assert.deepEqual(claim.evidence, [{ kind: 'structured_path', origin_id, path_kind: 'json_pointer', path: '/114/effect' }])
})

test('composition mapping preserves sequence order, unordered duplicates, and not arity', () => {
  const ordered = mapEffectNodeToCandidates({
    origin_id,
    node: { type: 'sequence', steps: [leaf('deep-strike'), leaf('fight-first')] },
  })
  const sequence = byPredicate(ordered.assertions, 'mechanic.composition.sequence')[0]
  const orderedLeaves = ordered.assertions.filter(item => valueOf(item).predicate.startsWith('mechanic.effect.'))
  assert.deepEqual(argument(sequence, 'members'), orderedLeaves.map(item => item.semantic_key))

  const bundled = mapEffectNodeToCandidates({
    origin_id,
    node: {
      type: 'rules-bundle',
      steps: [leaf('deep-strike'), leaf('fight-first')],
    },
  })
  const bundle = byPredicate(bundled.assertions, 'mechanic.composition.rules-bundle')[0]
  const bundledLeaves = bundled.assertions.filter(item => valueOf(item).predicate.startsWith('mechanic.effect.'))
  assert.deepEqual(argument(bundle, 'members'), bundledLeaves.map(item => item.semantic_key))
  assert.equal(argument(bundle, 'parameters'), undefined)
  const named = mapEffectNodeToCandidates({
    origin_id,
    node: {
      type: 'named-effect',
      name: 'Fabricated Power',
      kind: 'psychic',
      level: 1,
      effect: leaf('deep-strike'),
    },
  })
  const namedEffect = byPredicate(named.assertions, 'mechanic.composition.named-effect')[0]
  const namedLeaf = byPredicate(named.assertions, 'mechanic.effect.deep-strike')[0]
  assert.equal(argument(namedEffect, 'members'), namedLeaf.semantic_key)
  assert.deepEqual(argument(namedEffect, 'parameters'), {
    name: 'Fabricated Power',
    kind: 'psychic',
    level: 1,
  })

  const tabled = mapEffectNodeToCandidates({
    origin_id,
    node: {
      type: 'dice-table',
      dice: 'D6',
      outcomes: [
        { results: [4, 5, 6], effect: leaf('deep-strike') },
        { results: [1, 2, 3], effect: leaf('fight-first') },
      ],
    },
  })
  const table = byPredicate(tabled.assertions, 'mechanic.composition.dice-table')[0]
  const tableLeaves = tabled.assertions
    .filter(item => valueOf(item).predicate.startsWith('mechanic.effect.'))
    .map(item => item.semantic_key)
    .sort()
  const outcomes = argument(table, 'members')
  assert.deepEqual(outcomes.map(outcome => outcome.results).sort((left, right) => left[0] - right[0]), [[1, 2, 3], [4, 5, 6]])
  assert.deepEqual(outcomes.map(outcome => outcome.effect).sort(), tableLeaves)
  assert.deepEqual(argument(table, 'parameters'), { dice: 'D6' })

  const repeated = mapEffectNodeToCandidates({
    origin_id,
    node: { type: 'choice', options: [leaf('fight-first'), leaf('deep-strike'), leaf('fight-first')] },
  })
  const members = argument(byPredicate(repeated.assertions, 'mechanic.composition.choice')[0], 'members')
  assert.equal(members.length, 3)
  assert.equal(members[1], members[2])
  assert.deepEqual(members, [...members].sort())

  const negated = mapConditionNodeToCandidates({ origin_id, node: { operator: 'not', operands: [{ type: 'phase-is', parameters: { phase: 'command' } }] } })
  assert.deepEqual(valueOf(byPredicate(negated.assertions, 'mechanic.composition.not')[0]).qualifiers, [{ kind: 'condition.negated', value: true }])
  const invalid = mapConditionNodeToCandidates({ origin_id, node: { operator: 'not', operands: [{ type: 'phase-is' }, { type: 'timing-is' }] } })
  assert.equal(byPredicate(invalid.assertions, 'mechanic.composition.not').length, 0)
  assert.deepEqual(invalid.unresolved.map(item => item.kind), ['ontology_gap'])
})

test('named region state maps three children and retains all producer and consumer controls', () => {
  const branch = effect => ({ source: { kind: 'unit' }, beneficiary: { kind: 'unit' }, target: 'unit', timing: { event: 'phase-start' }, duration: 'phase', effect, optional: false })
  const node = {
    type: 'named-region-state', target: 'unit',
    modifier: {
      region_ref: 'fabricated-region', branch_precedence: 'qualified-replaces-default',
      producer: { region_ref: 'fabricated-region', mode: 'complete', parent_ref: null, baseline: [{ zone: 'deployment' }], phase_extensions: [{ zone: 'no-mans-land' }], additive_extensions: [{ kind: 'fabricated', source_gate: { owner: 'self' } }] },
      consumer: {
        state_ref: 'fabricated-region', beneficiary_gate: { owner: 'self', operator: 'and', keywords: ['FABRICATED'] }, membership: { kind: 'inside' },
        qualified_condition: { type: 'phase-is', parameters: { phase: 'command' } },
        default_branch: branch(leaf('deep-strike')),
        qualified_branch: branch(leaf('fight-first')),
      },
    },
  }
  const result = mapEffectNodeToCandidates({ origin_id, pointer: '/effect~1escaped', node })
  const parent = byPredicate(result.assertions, 'mechanic.effect.named-region-state')[0]
  assert.ok(argument(parent, 'condition'))
  assert.ok(argument(parent, 'default-branch'))
  assert.ok(argument(parent, 'qualified-branch'))
  const controls = argument(parent, 'parameters')
  assert.deepEqual(controls.modifier.producer, node.modifier.producer)
  assert.equal(controls.modifier.consumer.default_branch.duration, 'phase')
  assert.equal(Object.hasOwn(controls.modifier.consumer.default_branch, 'effect'), false)
  assert.deepEqual(parent.evidence[0].path, '/effect~1escaped')
})

test('resource action members retain effect, trigger, eligibility, cost, and local controls', () => {
  const node = {
    type: 'resource-action-menu', menu_id: 'fabricated-menu', pool_id: 'fabricated-pool', shared_usage: { default_manoeuvre_max_per_phase: 1 },
    actions: [{
      id: 'fabricated-action', label: 'Fabricated Action',
      when: [{ event: 'after-move', cost: { cp: 1 } }],
      cost: { pool_id: 'fabricated-pool', amount: 1 },
      eligibility: { requires_keyword: ['FABRICATED'], requires: [{ type: 'phase-is', parameters: { phase: 'movement' } }] },
      usage: { repeatable_if_different_unit: true }, duration: 'immediate', effect: leaf('deep-strike'),
    }],
  }
  const result = mapEffectNodeToCandidates({ origin_id, node })
  const parent = byPredicate(result.assertions, 'mechanic.composition.resource-action-menu')[0]
  const member = argument(parent, 'members')[0]
  assert.match(member.effect, /^[a-f0-9]{64}$/)
  assert.match(member.when[0], /^[a-f0-9]{64}$/)
  assert.match(member.eligibility.requires[0], /^[a-f0-9]{64}$/)
  assert.deepEqual(member.cost, node.actions[0].cost)
  assert.deepEqual(member.usage, node.actions[0].usage)
  assert.deepEqual(argument(parent, 'parameters'), { menu_id: 'fabricated-menu', pool_id: 'fabricated-pool', shared_usage: node.shared_usage })
})

test('timing mapper distinguishes passive defaults, explicit durations, usage, costs, and reactive abilities', () => {
  const inferred = timing({})
  assert.deepEqual(valueOf(byPredicate(inferred, 'mechanic.duration')[0]), {
    predicate: 'mechanic.duration', arguments: [{ role: 'duration', value: 'continuous' }], qualifiers: [{ kind: 'timing.passive', value: true }],
  })
  const permanent = timing({ scope: { duration: 'permanent' } })
  assert.deepEqual(valueOf(byPredicate(permanent, 'mechanic.duration')[0]).qualifiers, [{ kind: 'timing.passive', value: true }])
  for (const duration of ['phase', 'turn', 'battle-round', 'battle', 'until-next-command-phase']) {
    assert.equal(argument(byPredicate(timing({ scope: { duration } }), 'mechanic.duration')[0], 'duration'), duration)
  }
  const oneUse = timing({ scope: { duration: 'one-use' } })
  assert.equal(argument(byPredicate(oneUse, 'mechanic.usage')[0], 'frequency'), 'once-per-battle')
  assert.equal(timing({ behavior: 'reactive' }).length, 0)
  assert.equal(timing({ usage: { frequency: 'once-per-turn' } }).length, 0)
  assert.equal(timing({ effect: { type: 'conditional', condition: { type: 'phase-is' }, effect: leaf() } }).length, 0)
  assert.equal(timing({ effect: { type: 'rule-state', target: 'unit', modifier: { cost: { cp: 1 } } } }).length, 0)
  assert.equal(timing({ effect: { type: 'resource-action-menu', actions: [{ when: { event: 'after-move' }, cost: { amount: 1 }, effect: leaf() }] } }).length, 0)
  assert.equal(timing({ effect: { type: 'resource-action-menu', actions: [{ when: { event: 'after-move', cost: { cp: 1 } }, effect: leaf() }] } }).length, 0)
})

test('move consequences and selector eligibility remain linked graph children', () => {
  const node = {
    type: 'select-units',
    selector: {
      owner: 'friendly',
      target_kind: 'model',
      selection_limit: { count: 1, period: 'turn' },
      eligibility: { type: 'is-battle-shocked' },
    },
    effect: {
      type: 'movement-modifier',
      target: 'unit',
      modifier: { move_type: 'normal', distance: 6 },
      after_move: leaf('attack-restriction'),
    },
  }
  const result = mapEffectNodeToCandidates({ origin_id, node })
  assert.deepEqual(result.unresolved, [])
  const selection = byPredicate(result.assertions, 'mechanic.composition.select-units')[0]
  const eligibility = byPredicate(result.assertions, 'mechanic.condition.is-battle-shocked')[0]
  assert.equal(argument(selection, 'condition'), eligibility.semantic_key)
  assert.deepEqual(argument(selection, 'parameters').selector.selection_limit, node.selector.selection_limit)
  const movement = byPredicate(result.assertions, 'mechanic.composition.movement-modifier')[0]
  const restriction = byPredicate(result.assertions, 'mechanic.effect.attack-restriction')[0]
  assert.equal(argument(movement, 'after-move'), restriction.semantic_key)
  assert.equal(restriction.evidence[0].path, '/effect/effect/after_move')
})

test('model membership and designation history remain in claim import', () => {
  const iterator = {
    type: 'for-each-unit',
    selector: {
      owner: 'friendly',
      target_kind: 'model',
      member_of: 'bearer-unit',
      keywords: ['FABRICATED'],
    },
    effect: leaf(),
  }
  const mapped = mapEffectNodeToCandidates({ origin_id, node: iterator })
  assert.deepEqual(mapped.unresolved, [])
  const parent = byPredicate(mapped.assertions, 'mechanic.composition.for-each-unit')[0]
  assert.deepEqual(argument(parent, 'parameters').selector, iterator.selector)
  assert.ok(argument(parent, 'members'))

  const designation = mapEffectNodeToCandidates({
    origin_id,
    node: {
      type: 'designate-target',
      select: {
        eligibility: {
          type: 'was-hit-by-attack',
          parameters: {
            subject: 'target',
            attack_type: 'ranged',
            source: { event_var: 'fabricated-shot' },
            window: 'just-finished-shooting-sequence',
          },
        },
      },
      applies: { attacker_keywords: ['FABRICATED'], effect: leaf() },
    },
  })
  assert.deepEqual(designation.unresolved, [])
  const target = byPredicate(designation.assertions, 'mechanic.composition.designate-target')[0]
  const history = byPredicate(designation.assertions, 'mechanic.condition.was-hit-by-attack')[0]
  assert.equal(argument(target, 'condition'), history.semantic_key)
  assert.deepEqual(argument(target, 'parameters').applies.attacker_keywords, ['FABRICATED'])
})

test('region attack eligibility differs from qualified-branch membership', () => {
  const result = mapEffectNodeToCandidates({
    origin_id,
    node: {
      type: 'named-region-state',
      modifier: {
        producer: { region_ref: 'fabricated' },
        consumer: {
          attack_condition: { type: 'target-is-visible' },
          qualified_condition: {
            type: 'unit-has-keyword',
            parameters: { keyword: 'FABRICATED' },
          },
          default_branch: { effect: leaf('deep-strike') },
          qualified_branch: { effect: leaf('fight-first') },
        },
      },
    },
  })
  assert.deepEqual(result.unresolved, [])
  const parent = byPredicate(result.assertions, 'mechanic.effect.named-region-state')[0]
  const visible = byPredicate(result.assertions, 'mechanic.condition.target-is-visible')[0]
  const qualified = byPredicate(result.assertions, 'mechanic.condition.unit-has-keyword')[0]
  assert.equal(argument(parent, 'attack-condition'), visible.semantic_key)
  assert.equal(argument(parent, 'condition'), qualified.semantic_key)
  assert.notEqual(argument(parent, 'attack-condition'), argument(parent, 'condition'))
})

test('cross-ability trigger provenance changes trigger identity', () => {
  const trigger = {
    event: 'ability-target-selected',
    binds_event_variable: 'fabricated-selection',
    subject: { owner: 'enemy' },
    source_ability: {
      ability_id: 'fabricated-source',
      owner: 'friendly',
      keywords: ['FABRICATED'],
    },
  }
  const first = byPredicate(timing({ trigger }), 'mechanic.trigger')[0]
  assert.deepEqual(argument(first, 'source-ability'), trigger.source_ability)
  assert.equal(argument(first, 'event-binding'), trigger.binds_event_variable)
  const second = byPredicate(timing({
    trigger: {
      ...trigger,
      source_ability: { ...trigger.source_ability, keywords: ['OTHER'] },
    },
  }), 'mechanic.trigger')[0]
  assert.notEqual(first.semantic_key, second.semantic_key)
})
