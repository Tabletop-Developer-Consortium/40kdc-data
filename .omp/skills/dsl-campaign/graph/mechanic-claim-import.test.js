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
      ['modifier/consumer/qualified_condition', 'condition'],
      ['modifier/consumer/default_branch/effect', 'default-branch'],
      ['modifier/consumer/qualified_branch/effect', 'qualified-branch'],
    ],
  )
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
