import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256 } from './canonical.js'

export const MECHANIC_ADAPTER_ID = '40k-mechanic'
export const MECHANIC_ONTOLOGY_VERSION = 1
export const MECHANIC_IDENTITY_ONTOLOGY_VERSION = 1
export const MECHANIC_PROPOSITION_SCHEMA_ID = '40k.mechanic-claim'
export const MECHANIC_PROPOSITION_SCHEMA_VERSION = '1'
export const MECHANIC_TERMINAL_EFFECT_TYPES = Object.freeze(['no-effect'])

const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/
const ROLE_IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../schemas/enrichment/ability-dsl')

const ARGUMENT_ROLES = [
  'actor', 'affected-entity', 'characteristic', 'duration', 'event', 'operation', 'range',
  'source-unit', 'target', 'trigger', 'threshold', 'scope', 'parameters', 'members',
  'condition', 'default-branch', 'qualified-branch', 'on-success', 'on-failure', 'operator',
  'frequency', 'count', 'per', 'required-keywords', 'excluded-keywords', 'optional', 'window',
  'cost', 'lineage-root', 'after-move', 'attack-condition', 'source-ability', 'event-binding',
]

const QUALIFIER_KINDS = [
  'ability-dsl.duration.end-of-turn', 'ability-dsl.duration.until-end-of-turn',
  'ability-dsl.event.command-phase', 'ability-dsl.event.start-of-turn',
  'condition.no-advance', 'condition.negated', 'selection.friendly', 'selection.nearby',
  'timing.passive',
]
export const MECHANIC_CHILD_DESCRIPTORS = Object.freeze([
  { container_type: 'sequence', path: 'steps/*', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'rules-bundle', path: 'steps/*', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'named-effect', path: 'effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'choice', path: 'options/*', child_kind: 'effect', role: 'members', ordered: false },
  { container_type: 'dice-gated', path: 'on_success', child_kind: 'effect', role: 'on-success', ordered: true },
  { container_type: 'dice-gated', path: 'on_fail', child_kind: 'effect', role: 'on-failure', ordered: true },
  { container_type: 'dice-table', path: 'outcomes/*/effect', child_kind: 'effect', role: 'members', ordered: false },
  { container_type: 'conditional', path: 'condition', child_kind: 'condition', role: 'condition', ordered: true },
  { container_type: 'conditional', path: 'effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'dice-pool-allocation', path: 'options/*/effect', child_kind: 'effect', role: 'members', ordered: false },
  { container_type: 'select-units', path: 'effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'select-units', path: 'selector/eligibility', child_kind: 'condition', role: 'condition', ordered: true },
  { container_type: 'movement-modifier', path: 'modifier/condition', child_kind: 'condition', role: 'condition', ordered: true },
  { container_type: 'movement-modifier', path: 'after_move', child_kind: 'effect', role: 'after-move', ordered: true },
  { container_type: 'aura', path: 'modifier/effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'leader-model-ability-grant', path: 'grant/effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'designate-target', path: 'applies/effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'designate-target', path: 'select/eligibility', child_kind: 'condition', role: 'condition', ordered: true },
  { container_type: 'persistent-designation', path: 'consumer/effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'stance-select', path: 'options/*/effect', child_kind: 'effect', role: 'members', ordered: false },
  { container_type: 'risk-reward', path: 'reward', child_kind: 'effect', role: 'on-success', ordered: true },
  { container_type: 'risk-reward', path: 'risk/on_fail', child_kind: 'effect', role: 'on-failure', ordered: true },
  { container_type: 'issue-orders', path: 'options/*/effect', child_kind: 'effect', role: 'members', ordered: false },
  { container_type: 'resource-action-menu', path: 'actions/*/effect', child_kind: 'effect', role: 'members', ordered: false },
  { container_type: 'resource-action-menu', path: 'actions/*/when', child_kind: 'trigger', role: 'trigger', ordered: false },
  { container_type: 'resource-action-menu', path: 'actions/*/eligibility/requires/*', child_kind: 'condition', role: 'condition', ordered: false },
  { container_type: 'for-each-unit', path: 'effect', child_kind: 'effect', role: 'members', ordered: true },
  { container_type: 'named-region-state', path: 'modifier/consumer/attack_condition', child_kind: 'condition', role: 'attack-condition', ordered: true },
  { container_type: 'named-region-state', path: 'modifier/consumer/qualified_condition', child_kind: 'condition', role: 'condition', ordered: true },
  { container_type: 'named-region-state', path: 'modifier/consumer/default_branch/effect', child_kind: 'effect', role: 'default-branch', ordered: true },
  { container_type: 'named-region-state', path: 'modifier/consumer/qualified_branch/effect', child_kind: 'effect', role: 'qualified-branch', ordered: true },
  { container_type: 'compound-condition', path: 'operands/*', child_kind: 'condition', role: 'members', ordered: false },
  { container_type: 'ability-trigger', path: 'trigger/*/condition', child_kind: 'condition', role: 'condition', ordered: false },
])

function assertChildDescriptors(wrapperTypes, descriptors = MECHANIC_CHILD_DESCRIPTORS) {
  const covered = new Set(descriptors.map(item => item.container_type))
  for (const type of wrapperTypes) {
    if (!covered.has(type)) throw new TypeError(`unmapped reachable effect wrapper: ${type}`)
  }
  for (const item of descriptors) {
    if (!item.path || !['effect', 'condition', 'trigger'].includes(item.child_kind)) throw new TypeError(`invalid mechanic child descriptor: ${item.container_type}`)
  }
}


function loadSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'))
}

function frozenRegistry(values) {
  const entries = Object.freeze([...new Set(values)].sort())
  return Object.freeze({ has(value) { return entries.includes(value) }, values: entries })
}

function referencedDef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) throw new TypeError(`unsupported local schema reference: ${ref}`)
  return ref.slice('#/$defs/'.length)
}

export function buildMechanicRegistry({
  abilitySchema = loadSchema('ability'),
  effectSchema = loadSchema('effect'),
  conditionSchema = loadSchema('condition'),
  scopeSchema = loadSchema('scope'),
} = {}) {
  const singleEffectTypes = effectSchema.$defs['single-effect'].properties.type.enum
  const effectNodeDefs = effectSchema.$defs['effect-node'].oneOf.slice(1).map(entry => referencedDef(entry.$ref))
  const effectNodeTypes = effectNodeDefs.map(name => effectSchema.$defs[name].properties.type.const)
  const terminalEffectTypes = effectNodeTypes.filter(type => MECHANIC_TERMINAL_EFFECT_TYPES.includes(type))
  if (terminalEffectTypes.length !== MECHANIC_TERMINAL_EFFECT_TYPES.length) {
    throw new TypeError('declared terminal effect type is absent from the effect-node schema')
  }
  const effectTypes = [...singleEffectTypes, ...terminalEffectTypes]
  const wrapperTypes = effectNodeTypes.filter(type => !MECHANIC_TERMINAL_EFFECT_TYPES.includes(type))
  const conditionTypes = conditionSchema.$defs['simple-condition'].properties.type.enum
  assertChildDescriptors(wrapperTypes)
  const compoundTypes = conditionSchema.$defs['compound-condition'].properties.operator.enum
  const predicates = [
    ...effectTypes.map(type => `mechanic.effect.${type}`),
    ...conditionTypes.map(type => `mechanic.condition.${type}`),
    ...wrapperTypes.map(type => `mechanic.composition.${type}`),
    ...compoundTypes.map(type => `mechanic.composition.${type}`),
    'mechanic.trigger', 'mechanic.duration', 'mechanic.scope.range', 'mechanic.usage',
    'mechanic.selection.applies-to', 'mechanic.selection.nearby-friendly',
    'mechanic.effect.characteristic-modifier', 'mechanic.precondition.no-advance',
    'mechanic.legacy.relational-assertion',
  ]
  const schemaDescriptors = Object.freeze({
    effect_leaf_types: Object.freeze([...effectTypes]),
    effect_wrapper_types: Object.freeze([...wrapperTypes]),
    condition_types: Object.freeze([...conditionTypes]),
    compound_condition_types: Object.freeze([...compoundTypes]),
    child_paths: MECHANIC_CHILD_DESCRIPTORS,
  })
  const registry_schema_sha256 = sha256(canonicalJson({ abilitySchema, effectSchema, conditionSchema, scopeSchema }))
  return Object.freeze({
    predicates: frozenRegistry(predicates),
    argument_roles: frozenRegistry(ARGUMENT_ROLES),
    qualifier_kinds: frozenRegistry(QUALIFIER_KINDS),
    schema_descriptors: schemaDescriptors,
    registry_schema_sha256,
  })
}

export const MECHANIC_REGISTRY = buildMechanicRegistry()
export const MECHANIC_PREDICATES = MECHANIC_REGISTRY.predicates
export const MECHANIC_ARGUMENT_ROLES = MECHANIC_REGISTRY.argument_roles
export const MECHANIC_QUALIFIER_KINDS = MECHANIC_REGISTRY.qualifier_kinds

function fail(message) { throw new TypeError(message) }

function exactKeys(value, keys, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${name} has unexpected fields`)
}

function registered(id, registry, name, matcher) {
  if (typeof id !== 'string' || !matcher.test(id)) fail(`${name} must be a kebab-case identifier`)
  if (!registry.has(id)) fail(`unknown ${name}: ${id}`)
  return id
}

function canonicalEntries(entries, key, registry, name) {
  if (!Array.isArray(entries)) fail(`${name} must be an array`)
  const seen = new Set()
  const canonical = entries.map((entry, index) => {
    exactKeys(entry, [key, 'value'], `${name}[${index}]`)
    const id = registered(entry[key], registry, key, key === 'kind' ? IDENTIFIER : ROLE_IDENTIFIER)
    if (seen.has(id)) fail(`duplicate ${key}: ${id}`)
    seen.add(id)
    canonicalJson(entry.value)
    return { [key]: id, value: entry.value }
  })
  canonical.sort((left, right) => left[key].localeCompare(right[key]) || canonicalJson(left.value).localeCompare(canonicalJson(right.value)))
  return canonical
}

export function canonicalizeMechanicValue(value, registry = MECHANIC_REGISTRY) {
  exactKeys(value, ['predicate', 'arguments', 'qualifiers'], 'mechanic claim value')
  return {
    predicate: registered(value.predicate, registry.predicates, 'predicate', IDENTIFIER),
    arguments: canonicalEntries(value.arguments, 'role', registry.argument_roles, 'arguments'),
    qualifiers: canonicalEntries(value.qualifiers, 'kind', registry.qualifier_kinds, 'qualifiers'),
  }
}

export function validateMechanicProposition(proposition, registry = MECHANIC_REGISTRY) {
  exactKeys(proposition, ['schema_id', 'schema_version', 'value'], 'proposition')
  if (proposition.schema_id !== MECHANIC_PROPOSITION_SCHEMA_ID) fail(`proposition.schema_id must be ${MECHANIC_PROPOSITION_SCHEMA_ID}`)
  if (proposition.schema_version !== MECHANIC_PROPOSITION_SCHEMA_VERSION) fail(`proposition.schema_version must be ${MECHANIC_PROPOSITION_SCHEMA_VERSION}`)
  canonicalizeMechanicValue(proposition.value, registry)
}

export function canonicalizeMechanicFacetValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  return canonicalJson(value)
}

export function mechanicQueryFacets(value, registry = MECHANIC_REGISTRY) {
  const canonical = canonicalizeMechanicValue(value, registry)
  const argumentsByRole = Object.fromEntries(canonical.arguments.map(({ role, value: argumentValue }) => [role, argumentValue]))
  const qualifierKinds = new Set(canonical.qualifiers.map(({ kind }) => kind))
  const threshold = argumentsByRole.threshold
  if (threshold !== undefined && !Number.isInteger(threshold)) fail('threshold facet must be an integer')
  return Object.freeze({
    predicate: canonical.predicate,
    actor: canonicalizeMechanicFacetValue(argumentsByRole.actor ?? null),
    affected_entity: canonicalizeMechanicFacetValue(argumentsByRole['affected-entity'] ?? argumentsByRole.target ?? null),
    event: canonicalizeMechanicFacetValue(argumentsByRole.event ?? argumentsByRole.trigger ?? null),
    duration: canonicalizeMechanicFacetValue(argumentsByRole.duration ?? null),
    threshold: threshold ?? null,
    has_precondition: qualifierKinds.has('condition.no-advance'),
  })
}

export const mechanicClaimAdapter = Object.freeze({
  adapter_id: MECHANIC_ADAPTER_ID,
  ontology_version: MECHANIC_ONTOLOGY_VERSION,
  identity_ontology_version: MECHANIC_IDENTITY_ONTOLOGY_VERSION,
  proposition_schema_id: MECHANIC_PROPOSITION_SCHEMA_ID,
  proposition_schema_version: MECHANIC_PROPOSITION_SCHEMA_VERSION,
  registry: MECHANIC_REGISTRY,
  registry_schema_sha256: MECHANIC_REGISTRY.registry_schema_sha256,
  validateProposition: validateMechanicProposition,
  canonicalizeProposition(value, proposition) {
    validateMechanicProposition(proposition)
    return canonicalizeMechanicValue(value)
  },
})
