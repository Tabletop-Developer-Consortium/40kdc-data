import { canonicalJson, sha256 } from './canonical.js'
import { resolveSourceBinding } from './formalization.js'
import { abilityCampaignDag } from './readiness.js'

function requireString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} required`)
  return value
}

function memberKey(member) { return `${member.faction_id}/${member.ability_id}` }
function taskId(runId, label) { return `${runId}:${label}` }

function validateFamilyMembers(members) {
  if (!Array.isArray(members) || !members.length) throw new TypeError('family_members required')
  const keys = new Set()
  return members.map(member => {
    if (!member || Object.getPrototypeOf(member) !== Object.prototype) throw new TypeError('invalid family member')
    const normalized = {
      faction_id: requireString(member.faction_id, 'family member faction_id'),
      ability_id: requireString(member.ability_id, 'family member ability_id'),
      fit: member.fit,
      match_strength: member.match_strength,
      family_instance_node_id: requireString(member.family_instance_node_id, 'family_instance_node_id'),
    }
    if (!['faithful', 'needs-param'].includes(normalized.fit) || !['exact', 'near'].includes(normalized.match_strength)) {
      throw new TypeError(`unfaithful family member: ${memberKey(normalized)}`)
    }
    const key = memberKey(normalized)
    if (keys.has(key)) throw new TypeError(`duplicate family member: ${key}`)
    keys.add(key)
    return normalized
  }).sort((left, right) => memberKey(left).localeCompare(memberKey(right)))
}

function currentRepositoryHash(store) {
  const row = store.db.prepare("SELECT payload_json FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
  if (!row) throw new Error('repository-version node missing')
  return JSON.parse(row.payload_json).workspace_hash
}

function reusableFormalization(store, member, sourceHash) {
  const rows = store.db.prepare("SELECT node_id,payload_json FROM certificates WHERE state='certified' AND node_id IS NOT NULL ORDER BY rowid DESC").all()
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json || '{}')
    if (payload.faction_id === member.faction_id && payload.ability_id === member.ability_id && payload.fingerprints?.source_byte_hash === sourceHash) {
      return row.node_id
    }
  }
  return null
}

function projectedTaskRows(runId, dag) {
  return dag.map(entry => ({
    id: taskId(runId, entry.label),
    run_id: runId,
    state: 'pending',
    node_id: null,
    payload: {
      label: entry.label,
      kind: entry.kind,
      depends_on: entry.depends_on.map(label => taskId(runId, label)).sort(),
      payload: entry.payload,
    },
  }))
}

function assertFamilyProjection(store, templateNodeId, members) {
  const template = store.db.prepare("SELECT * FROM family_templates WHERE node_id=? AND state='current'").get(templateNodeId)
  if (!template) throw new Error('current family template projection missing')
  for (const member of members) {
    const row = store.db.prepare("SELECT payload_json FROM family_instances WHERE node_id=? AND state='current'").get(member.family_instance_node_id)
    if (!row) throw new Error(`current family instance projection missing: ${memberKey(member)}`)
    const payload = JSON.parse(row.payload_json || '{}')
    if (payload.faction_id !== member.faction_id || payload.ability_id !== member.ability_id || payload.fit !== member.fit || payload.match_strength !== member.match_strength) {
      throw new Error(`family instance projection drift: ${memberKey(member)}`)
    }
  }
}

export function certifyShapeFamily(store, { run_id, shape_package, shape_package_node_id }) {
  requireString(run_id, 'run_id')
  requireString(shape_package_node_id, 'shape_package_node_id')
  if (!store.hasNode(shape_package_node_id)) throw new Error('shape package node missing')
  const family = validateFamilyMembers((shape_package?.faithful_family || []).map(member => ({
    faction_id: member.faction_id || member.faction,
    ability_id: member.ability_id,
    fit: member.fit,
    match_strength: member.match_strength,
    family_instance_node_id: 'pending',
  })))
  let template
  let instances
  store.transaction(() => {
    template = store.createNode({
      kind: 'family-template',
      payload: {
        run_id,
        name: shape_package.name,
        kind: shape_package.kind,
        parameters: shape_package.parameters,
        schema_branch_hash: sha256(canonicalJson(shape_package.schema_branch)),
        member_keys: family.map(memberKey),
      },
      parents: [{ node_id: shape_package_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }],
    })
    instances = family.map(member => store.createNode({
      kind: 'family-instance',
      payload: {
        run_id,
        faction_id: member.faction_id,
        ability_id: member.ability_id,
        fit: member.fit,
        match_strength: member.match_strength,
        family_template_node_id: template.node_id,
      },
      parents: [{ node_id: template.node_id, edge_type: 'generalizes', authorizes_reuse: true, metadata: { fit: member.fit, match_strength: member.match_strength } }],
    }))
    store.appendEvent('shape-family-certified', {
      run_id,
      template: { id: `${run_id}:family:${template.node_id.slice(0, 16)}`, run_id, state: 'current', node_id: template.node_id, payload: template.payload },
      instances: instances.map((instance, index) => ({ id: `${run_id}:family-instance:${memberKey(family[index])}`, run_id, state: 'current', node_id: instance.node_id, payload: instance.payload })),
    }, { aggregate_kind: 'family-template', aggregate_id: template.node_id, node_id: template.node_id })
  })
  return {
    family_template_node_id: template.node_id,
    family_members: instances.map((instance, index) => ({ ...family[index], family_instance_node_id: instance.node_id })),
  }
}

export function expandCampaignScope(store, {
  run_id,
  expected_repository_hash,
  raw_store_root,
  family_template_node_id,
  family_members,
  apply_transaction_id,
}) {
  requireString(run_id, 'run_id')
  requireString(expected_repository_hash, 'expected_repository_hash')
  requireString(raw_store_root, 'raw_store_root')
  requireString(family_template_node_id, 'family_template_node_id')
  requireString(apply_transaction_id, 'apply_transaction_id')
  const run = store.db.prepare("SELECT * FROM runs WHERE run_id=? AND state='active'").get(run_id)
  if (!run) throw new Error(`active run not found: ${run_id}`)
  if (currentRepositoryHash(store) !== expected_repository_hash) throw new Error('repository-hash-drift')
  if (store.db.prepare('SELECT 1 FROM apply_transactions WHERE id=?').get(apply_transaction_id)) throw new Error('apply transaction already exists')
  const members = validateFamilyMembers(family_members)
  assertFamilyProjection(store, family_template_node_id, members)
  const activeClaim = store.db.prepare("SELECT run_id FROM claims WHERE faction_id=? AND ability_id=? AND state='active'")
  for (const member of members) {
    const collision = activeClaim.get(member.faction_id, member.ability_id)
    if (collision && collision.run_id !== run_id) throw new Error(`active-claim-collision: ${memberKey(member)}`)
  }

  const generation = `family-${family_template_node_id.slice(0, 12)}`
  const source_bindings = []
  const dag = []
  for (const member of members) {
    const source = resolveSourceBinding(raw_store_root, member.faction_id, member.ability_id)
    const formalization = reusableFormalization(store, member, source.byte_hash)
    source_bindings.push({
      faction_id: member.faction_id,
      ability_id: member.ability_id,
      expected_source_hash: source.byte_hash,
      source_formalization_node_id: formalization,
      store_key: source.store_key,
    })
    dag.push(...abilityCampaignDag({
      faction_id: member.faction_id,
      ability_id: member.ability_id,
      generation,
      source_formalization_node_id: formalization,
      source_binding: formalization ? null : source,
    }))
  }
  const memberTaskRows = projectedTaskRows(run_id, dag)
  const auditDependencies = dag.filter(entry => entry.kind === 'audit').map(entry => taskId(run_id, entry.label)).sort()
  const applyLabel = `family:${family_template_node_id.slice(0, 12)}:apply`
  const applyTask = {
    id: taskId(run_id, applyLabel),
    run_id,
    state: 'pending',
    node_id: null,
    payload: {
      label: applyLabel,
      kind: 'family-apply',
      depends_on: auditDependencies,
      payload: { apply_transaction_id, family_template_node_id, input_node_ids: [family_template_node_id, ...members.map(member => member.family_instance_node_id)].sort() },
    },
  }
  const existingClaims = new Set(store.db.prepare('SELECT faction_id,ability_id FROM claims WHERE run_id=?').all(run_id).map(row => `${row.faction_id}/${row.ability_id}`))
  const sequence = store.sequence() + 1
  const claims = members.filter(member => !existingClaims.has(memberKey(member))).map(member => ({
    faction_id: member.faction_id,
    ability_id: member.ability_id,
    run_id,
    state: 'active',
    claimed_sequence: sequence,
  }))
  let applyNode
  store.transaction(() => {
    applyNode = store.createNode({
      kind: 'apply-transaction',
      payload: {
        run_id,
        apply_transaction_id,
        expected_repository_hash,
        family_template_node_id,
        authorized_keys: members.map(memberKey),
        source_bindings,
      },
      parents: [
        { node_id: family_template_node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} },
        ...members.map(member => ({ node_id: member.family_instance_node_id, edge_type: 'satisfies', authorizes_reuse: true, metadata: { key: memberKey(member) } })),
      ],
    })
    store.appendEvent('campaign-scope-expanded', {
      run_id,
      family_template_node_id,
      family_members: members,
      source_bindings,
      apply_transaction: { id: apply_transaction_id, run_id, state: 'planned', node_id: applyNode.node_id, payload: applyNode.payload },
      claims,
      tasks: [...memberTaskRows, applyTask],
    }, { aggregate_kind: 'run', aggregate_id: run_id, node_id: applyNode.node_id })
  })
  return {
    run_id,
    family_template_node_id,
    apply_transaction_id,
    apply_transaction_node_id: applyNode.node_id,
    source_bindings,
    claimed_keys: claims.map(memberKey),
    task_ids: [...memberTaskRows, applyTask].map(row => row.id),
  }
}

function reportOutputs(report) {
  if (!report || !Array.isArray(report.abilities)) throw new TypeError('whole-corpus roundtrip report abilities required')
  const outputs = new Map()
  for (const ability of report.abilities) {
    const faction = ability?.faction_id || ability?.faction
    const key = `${requireString(faction, 'report faction')}/${requireString(ability?.ability_id, 'report ability_id')}`
    if (outputs.has(key)) throw new TypeError(`duplicate roundtrip ability: ${key}`)
    outputs.set(key, requireString(ability?.english, `untruncated english render for ${key}`))
  }
  return outputs
}

export function compareDescriberScope({ baseline, updated, authorized_keys }) {
  if (!Array.isArray(authorized_keys) || new Set(authorized_keys).size !== authorized_keys.length) throw new TypeError('authorized_keys must be unique')
  const before = reportOutputs(baseline)
  const after = reportOutputs(updated)
  if (canonicalJson([...before.keys()].sort()) !== canonicalJson([...after.keys()].sort())) throw new Error('whole-corpus-report-key-drift')
  const changed_keys = [...before.keys()].filter(key => before.get(key) !== after.get(key)).sort()
  const authorized = [...authorized_keys].sort()
  if (canonicalJson(changed_keys) !== canonicalJson(authorized)) {
    const unauthorized = changed_keys.filter(key => !authorized.includes(key))
    const unchanged = authorized.filter(key => !changed_keys.includes(key))
    if (unauthorized.length) throw new Error(`unauthorized-describer-drift: ${unauthorized.join(', ')}`)
    throw new Error(`authorized-output-unchanged: ${unchanged.join(', ')}`)
  }
  const hashOutputs = outputs => sha256(canonicalJson([...outputs].sort(([left], [right]) => left.localeCompare(right)).map(([key, render]) => [key, sha256(Buffer.from(render, 'utf8'))])))
  return { baseline_hash: hashOutputs(before), updated_hash: hashOutputs(after), changed_keys, authorized_keys: authorized }
}

export function recordDescriberScopeCheck(store, { run_id, baseline, updated, authorized_keys }) {
  const result = compareDescriberScope({ baseline, updated, authorized_keys })
  const check = {
    id: `${run_id}:describer-scope:${result.updated_hash.slice(0, 16)}`,
    run_id,
    state: 'passed',
    node_id: null,
    payload: result,
  }
  store.appendEvent('describer-scope-checked', { run_id, ...result, check }, { aggregate_kind: 'run', aggregate_id: run_id })
  return result
}
