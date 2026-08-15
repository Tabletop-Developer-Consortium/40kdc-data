import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalSourceText,
  persistClaimExtraction,
  persistSourceSnapshot,
  resolveSourceBinding,
} from '../graph/formalization.js'
import { MECHANIC_REGISTRY, mechanicClaimAdapter } from '../graph/mechanic-claims.js'
import { failTask, issueReadyTask } from '../graph/scheduler.js'
import { GraphStore } from '../graph/store.js'
import { createTrustedAgent } from '../graph/workflow-runtime.js'

export const meta = {
  name: 'dsl-formalize-batch',
  description: 'Freeze authoritative sources and persist closed mechanic claim extractions before retrieval',
}

export const WHO_PROMPT_VERSION = 2
export const WHEN_PROMPT_VERSION = 2
export const WHAT_PROMPT_VERSION = 2
export const FORMALIZER_PROMPT_VERSION = 2
export const FORMALIZATION_IMPLEMENTATION_VERSION = '2'

// args: { repo_root, graph_root, run_id, raw_store_root?, model_identities: { who, when, what, formalizer }, abilities: [{ faction_id, ability_id, generation? }] }
if (typeof args === 'string') args = JSON.parse(args)
if (!args?.graph_root || !args?.run_id || !Array.isArray(args.abilities)) throw new Error('graph_root, run_id, and abilities required')
const modelIdentities = args.model_identities
if (!modelIdentities || !['who', 'when', 'what', 'formalizer'].every(key => typeof modelIdentities[key] === 'string' && modelIdentities[key])) {
  throw new Error('model_identities.who, model_identities.when, model_identities.what, and model_identities.formalizer required')
}
const rawStoreRoot = args.raw_store_root || join(args.repo_root, '..', '40kdc-abilities')
const graphAgent = createTrustedAgent({ driverArgs: args, invokeAgent: agent })

const JSON_VALUE = {}
const MECHANIC_VALUE = {
  type: 'object', additionalProperties: false, required: ['predicate', 'arguments', 'qualifiers'],
  properties: {
    predicate: { enum: MECHANIC_REGISTRY.predicates.values },
    arguments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['role', 'value'], properties: {
      role: { enum: MECHANIC_REGISTRY.argument_roles.values }, value: JSON_VALUE,
    } } },
    qualifiers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: {
      kind: { enum: MECHANIC_REGISTRY.qualifier_kinds.values }, value: JSON_VALUE,
    } } },
  },
}
const PASSIVE_RULE = 'Emit mechanic.duration continuous with timing.passive only when behavior is absent/passive, scope duration is absent/permanent, and there is no trigger, nested condition, finite duration, ability/local usage, or trigger/rule-state/resource-action cost. Map permanent to continuous; retain finite durations; one-use also emits mechanic.usage once-per-battle.'
const MECHANIC_CONTRACT = Object.freeze({
  registry_schema_sha256: MECHANIC_REGISTRY.registry_schema_sha256,
  predicates: MECHANIC_REGISTRY.predicates.values,
  argument_roles: MECHANIC_REGISTRY.argument_roles.values,
  qualifier_kinds: MECHANIC_REGISTRY.qualifier_kinds.values,
  passive_rule: PASSIVE_RULE,
})
const SOURCE_SPAN = {
  type: 'object', additionalProperties: false, required: ['kind', 'start', 'end', 'coordinate_unit'],
  properties: {
    kind: { const: 'source_span' },
    start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 1 },
    coordinate_unit: { const: 'utf8_byte' },
  },
}
const DERIVED_EVIDENCE = {
  type: 'object', additionalProperties: false, required: ['kind', 'derivation_local_parent_ids', 'derivation_rule_id', 'derivation_rule_version'],
  properties: {
    kind: { const: 'derived_evidence' },
    derivation_local_parent_ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, uniqueItems: true },
    derivation_rule_id: { type: 'string', minLength: 1 },
    derivation_rule_version: { type: 'string', minLength: 1 },
  },
}
const EVIDENCE = { oneOf: [SOURCE_SPAN, DERIVED_EVIDENCE] }
const PROPOSITION = {
  type: 'object', additionalProperties: false, required: ['schema_id', 'schema_version', 'value'],
  properties: { schema_id: { const: '40k.mechanic-claim' }, schema_version: { const: '1' }, value: MECHANIC_VALUE },
}
const ASSERTION = {
  type: 'object', additionalProperties: false,
  required: ['extraction_local_id', 'proposition', 'polarity', 'modality', 'evidence_bindings', 'derivation_parent_labels'],
  properties: {
    extraction_local_id: { type: 'string', minLength: 1 },
    proposition: PROPOSITION,
    polarity: { enum: ['affirms', 'denies'] },
    modality: { enum: ['asserted', 'conditional', 'permitted', 'required', 'possible'] },
    evidence_bindings: { type: 'array', minItems: 1, items: EVIDENCE },
    derivation_parent_labels: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
  },
}
const UNRESOLVED = {
  type: 'object', additionalProperties: false,
  required: ['extraction_local_id', 'extraction_local_focus', 'kind', 'evidence_bindings', 'candidate_local_labels', 'blocks_obligations'],
  properties: {
    extraction_local_id: { type: 'string', minLength: 1 },
    extraction_local_focus: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, uniqueItems: true },
    kind: { enum: ['ambiguous', 'unsupported', 'contradictory', 'incomplete_source', 'ontology_gap', 'awaiting_evidence'] },
    evidence_bindings: { type: 'array', items: EVIDENCE },
    candidate_local_labels: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    blocks_obligations: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
  },
}
const FORMALIZATION_OUT = {
  type: 'object', additionalProperties: false, required: ['clauses', 'assertions', 'unresolved', 'signatures', 'completeness'],
  properties: {
    clauses: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['extraction_local_id', 'start', 'end'], properties: {
      extraction_local_id: { type: 'string', minLength: 1 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 },
    } } },
    assertions: { type: 'array', items: ASSERTION },
    unresolved: { type: 'array', items: UNRESOLVED },
    signatures: { type: 'object', additionalProperties: false, required: ['aggregate', 'assertions'], properties: {
      aggregate: JSON_VALUE,
      assertions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['extraction_local_id', 'signature'], properties: {
        extraction_local_id: { type: 'string', minLength: 1 }, signature: JSON_VALUE,
      } } },
    } },
    completeness: { type: 'object', additionalProperties: false, required: ['state', 'obligations_checked'], properties: {
      state: { enum: ['complete', 'incomplete', 'disputed'] },
      obligations_checked: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
    } },
  },
}
const DECOMPOSITION_OUT = { type: 'object', additionalProperties: true }

function entryFor(factionId, abilityId) {
  const rows = JSON.parse(readFileSync(join(rawStoreRoot, `${factionId}.json`), 'utf8'))
  return rows.find(row => (row.ability_id ?? row.id) === abilityId) || null
}

function issueSourceEnvelope(store, { run_id, label }) {
  const issued = issueReadyTask(store, { run_id, label, now: Date.now() })
  if (!issued.issued) throw new Error(issued.reason)
  return issued.envelope
}

const results = await pipeline(args.abilities, async ability => {
  const generation = ability.generation || 'initial'
  const common = { faction_id: ability.faction_id, ability_id: ability.ability_id, generation }
  const prefix = `ability:${ability.faction_id}/${ability.ability_id}:${generation}`
  const sourceLabel = `${prefix}:source-retrieval`
  const sourceStore = new GraphStore(args.graph_root)
  let sourceSnapshot
  try {
    // The durable source task must exist even when the raw-store lookup itself fails.
    const sourceEnvelope = issueSourceEnvelope(sourceStore, {
      run_id: args.run_id, label: sourceLabel,
    })
    let entry
    let sourceText
    let binding
    try {
      entry = entryFor(ability.faction_id, ability.ability_id)
      sourceText = canonicalSourceText(entry)
      binding = resolveSourceBinding(rawStoreRoot, ability.faction_id, ability.ability_id)
    } catch (error) {
      failTask(sourceStore, { run_id: args.run_id, label: sourceLabel, reason: 'source-unavailable' })
      return { ability, status: 'source-unavailable', reason: error.message }
    }
    sourceSnapshot = persistSourceSnapshot(sourceStore, {
      run_id: args.run_id, ...common, envelope: sourceEnvelope, raw_store_root: rawStoreRoot,
      source_binding: binding, parents: sourceEnvelope.input_node_ids,
    })

    const basePrompt = JSON.stringify({
      ability_id: ability.ability_id, faction_id: ability.faction_id, source_snapshot_id: sourceSnapshot.source_snapshot_id, source_text: sourceText,
      mechanic_contract: MECHANIC_CONTRACT,
    })
    const helperOptions = (agentType, taskKind, label, modelId, promptId, promptVersion) => ({
      agentType, taskKind, phase: 'Formalize', label, dependsOn: [sourceLabel], inputNodeIds: [sourceSnapshot.source_node_id],
      schema: DECOMPOSITION_OUT, taskPayload: common, graphSourceTexts: [sourceText], graphEphemeralKeys: ['raw_text', 'source_text'],
      authoritative: true, modelId, promptId, promptVersion, agentContractId: `${agentType}@${promptVersion}`, sourceSnapshotId: sourceSnapshot.source_snapshot_id,
    })
    const [who, when, what] = await parallel([
      () => graphAgent(`Decompose WHO into relational mechanic claims with no quoted source text. Input:\n${basePrompt}`,
        helperOptions('target-dummy', 'target-decomposition', `${prefix}:who`, modelIdentities.who, 'formalize-who', WHO_PROMPT_VERSION)),
      () => graphAgent(`Decompose WHEN into relational mechanic claims with no quoted source text. Input:\n${basePrompt}`,
        helperOptions('chronomancer', 'timing-decomposition', `${prefix}:when`, modelIdentities.when, 'formalize-when', WHEN_PROMPT_VERSION)),
      () => graphAgent(`Decompose WHAT into relational mechanic claims with no quoted source text. Input:\n${basePrompt}`,
        helperOptions('vox-hound', 'effect-decomposition', `${prefix}:what`, modelIdentities.what, 'formalize-what', WHAT_PROMPT_VERSION)),
    ])
    const helperNodeIds = [who.sealed_output_node_id, when.sealed_output_node_id, what.sealed_output_node_id]
    const formalized = await graphAgent(`Aggregate sealed WHO/WHEN/WHAT analyses into closed, extraction-local mechanic propositions. Emit no source text and no semantic, occurrence, evidence-binding, extraction, assertion, unresolved, claim-set, certificate, or graph node IDs. Evidence locations are UTF-8 byte spans or derived local parents only. A complete output must check both retrieve and represent. Apply the supplied passive rule exactly. Input:\n${JSON.stringify({
      source_snapshot_id: sourceSnapshot.source_snapshot_id, source_text: sourceText, sealed_helper_node_ids: helperNodeIds, who, when, what,
      mechanic_contract: MECHANIC_CONTRACT,
    })}`, {
      agentType: 'inquisitor', taskKind: 'source-formalization', phase: 'Formalize', label: `${prefix}:source-formalization`,
      dependsOn: [sourceLabel, `${prefix}:who`, `${prefix}:when`, `${prefix}:what`], inputNodeIds: helperNodeIds,
      completion: 'deferred', schema: FORMALIZATION_OUT, taskPayload: common, graphSourceTexts: [sourceText], graphEphemeralKeys: ['raw_text', 'source_text'],
      authoritative: true, modelId: modelIdentities.formalizer, promptId: 'formalize-claims', promptVersion: FORMALIZER_PROMPT_VERSION,
      agentContractId: `inquisitor@${FORMALIZER_PROMPT_VERSION}`, sourceSnapshotId: sourceSnapshot.source_snapshot_id,
      orderedParentEvidenceNodeIds: helperNodeIds,
    })
    const store = new GraphStore(args.graph_root)
    try {
      const persisted = persistClaimExtraction(store, {
        run_id: args.run_id, ...common, envelope: formalized.execution_envelope,
        source_snapshot_node_id: sourceSnapshot.source_node_id, raw_store_root: rawStoreRoot, adapter: mechanicClaimAdapter,
        extraction_identity: {
          extractor_contract_version: FORMALIZER_PROMPT_VERSION,
          formalization_policy_version: FORMALIZER_PROMPT_VERSION,
          normalization_version: 1,
          extractor_implementation: `wf-formalize-batch@${FORMALIZATION_IMPLEMENTATION_VERSION}`,
          model_and_prompt_identity: formalized.execution_identity,
          ordered_parent_evidence_ids: helperNodeIds,
        },
        clauses: formalized.clauses, assertions: formalized.assertions, unresolved: formalized.unresolved,
        signatures: formalized.signatures, completeness: formalized.completeness,
        parents: helperNodeIds,
      })
      return { ability, status: 'certified', ...persisted }
    } finally {
      store.close()
    }
  } finally {
    sourceStore.close()
  }
})


return { run_id: args.run_id, results }
