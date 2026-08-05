import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'

export const GLOBAL_ROOT_ID = 'root:mechanic-evidence'

export function abilityProjectionId(factionId, abilityId) {
  return `ability:${factionId}:${abilityId}`
}

export function abilityProjectionLabel(metadata) {
  if (!metadata) return null
  return `${metadata.ability_name} — ${metadata.faction_name} (${metadata.faction_id}) · ${metadata.ability_id}`
}

export function missingAbilityLabel(factionId, abilityId) {
  return `Unknown ability (${abilityId}) — ${factionId}`
}
export function projectionScope(abilityRefs) {
  if (abilityRefs.length === 1) return 'ability'
  if (abilityRefs.length > 1) return 'family'
  return 'global'
}


function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}`
  const fd = openSync(temporary, 'w', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function jsonArray(path) {
  if (!existsSync(path)) return []
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) throw new TypeError(`${path}: expected JSON array`)
  return value
}

function repositoryCatalog(repoRoot, repositoryVersionId) {
  const factions = new Map()
  const coreRoot = join(repoRoot, 'data', 'core')
  if (existsSync(coreRoot)) {
    for (const entry of readdirSync(coreRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name))) {
      for (const faction of jsonArray(join(coreRoot, entry.name, 'factions.json'))) {
        if (typeof faction?.id === 'string' && typeof faction?.name === 'string') factions.set(faction.id, faction.name)
      }
    }
  }
  const catalog = []
  const enrichmentRoot = join(repoRoot, 'data', 'enrichment')
  if (existsSync(enrichmentRoot)) {
    for (const entry of readdirSync(enrichmentRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name))) {
      const factionId = entry.name
      for (const ability of jsonArray(join(enrichmentRoot, factionId, 'abilities.json'))) {
        if (typeof ability?.ability_id !== 'string' || typeof ability?.name !== 'string') continue
        catalog.push({
          faction_id: factionId,
          ability_id: ability.ability_id,
          ability_name: ability.name,
          faction_name: factions.get(factionId) || factionId,
          repository_version_id: repositoryVersionId,
        })
      }
    }
  }
  return catalog.sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
}

function refKey(factionId, abilityId) {
  return `${factionId}\0${abilityId}`
}

function addRef(refs, nodeId, factionId, abilityId, sourceKind, distance) {
  if (typeof factionId !== 'string' || !factionId || typeof abilityId !== 'string' || !abilityId) return false
  let nodeRefs = refs.get(nodeId)
  if (!nodeRefs) refs.set(nodeId, nodeRefs = new Map())
  const key = refKey(factionId, abilityId)
  const prior = nodeRefs.get(key)
  const ranks = { direct: 0, 'explicit-ownership': 1, ownership: 2, lineage: 3, 'family-instance': 4 }
  if (prior && (prior.distance < distance || (prior.distance === distance && ranks[prior.source_kind] <= ranks[sourceKind]))) return false
  nodeRefs.set(key, { faction_id: factionId, ability_id: abilityId, source_kind: sourceKind, distance })
  return true
}

function directRefs(payload) {
  const found = new Map()
  const visit = (value, inheritedFaction = null) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inheritedFaction)
      return
    }
    const factionId = typeof value.faction_id === 'string' ? value.faction_id : inheritedFaction
    if (factionId && typeof value.ability_id === 'string') found.set(refKey(factionId, value.ability_id), { faction_id: factionId, ability_id: value.ability_id })
    if (factionId && Array.isArray(value.ability_ids)) {
      for (const abilityId of value.ability_ids) if (typeof abilityId === 'string') found.set(refKey(factionId, abilityId), { faction_id: factionId, ability_id: abilityId })
    }
    for (const child of Object.values(value)) visit(child, factionId)
  }
  visit(payload)
  return [...found.values()].sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
}
function compositeRef(value) {
  if (typeof value !== 'string') return null
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1 || value.indexOf('/', separator + 1) !== -1) return null
  return { faction_id: value.slice(0, separator), ability_id: value.slice(separator + 1) }
}

function projectionOwnershipRefs(store) {
  const ownership = []
  const visit = (value, nodeId) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const child of value) visit(child, nodeId)
      return
    }
    const ref = compositeRef(value.ability_key)
    if (ref) ownership.push({ node_id: nodeId, ...ref })
    if (Array.isArray(value.known_members)) {
      for (const member of value.known_members) {
        const ref = compositeRef(member)
        if (ref) ownership.push({ node_id: nodeId, ...ref })
      }
    }
    for (const child of Object.values(value)) visit(child, nodeId)
  }
  for (const row of store.db.prepare('SELECT node_id,payload_json FROM nodes ORDER BY node_id').all()) visit(JSON.parse(row.payload_json), row.node_id)
  for (const row of store.db.prepare('SELECT id,node_id FROM ability_evidence WHERE node_id IS NOT NULL ORDER BY id').all()) {
    const ref = compositeRef(row.id)
    if (ref) ownership.push({ node_id: row.node_id, ...ref })
  }
  return ownership.sort((a, b) => a.node_id.localeCompare(b.node_id) || a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
}


function lineageChildren(store) {
  const children = new Map()
  for (const edge of store.db.prepare("SELECT parent_node_id,child_node_id FROM edges WHERE edge_type='derived_from' ORDER BY parent_node_id,child_node_id").all()) {
    if (!children.has(edge.parent_node_id)) children.set(edge.parent_node_id, [])
    children.get(edge.parent_node_id).push(edge.child_node_id)
  }
  return children
}

function propagateLineage(store, refs, seedNodeIds = [...refs.keys()]) {
  const children = lineageChildren(store)
  for (const seedNodeId of [...seedNodeIds].sort()) {
    const seedRefs = [...(refs.get(seedNodeId)?.values() || [])].sort((a, b) => a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
    for (const seedRef of seedRefs) {
      const queue = [[seedNodeId, seedRef.distance]]
      const visited = new Set([seedNodeId])
      while (queue.length) {
        const [parentNodeId, distance] = queue.shift()
        for (const childNodeId of children.get(parentNodeId) || []) {
          if (visited.has(childNodeId)) continue
          visited.add(childNodeId)
          addRef(refs, childNodeId, seedRef.faction_id, seedRef.ability_id, 'lineage', distance + 1)
          queue.push([childNodeId, distance + 1])
        }
      }
    }
  }
}

function familyJoinTargets(store) {
  const templateRows = store.db.prepare('SELECT id,node_id,payload_json FROM family_templates WHERE node_id IS NOT NULL ORDER BY id').all()
  const templatesById = new Map(templateRows.map(row => [row.id, row.node_id]))
  const joins = []
  for (const row of store.db.prepare('SELECT id,node_id,payload_json FROM family_instances WHERE node_id IS NOT NULL ORDER BY id').all()) {
    const payload = JSON.parse(row.payload_json || '{}')
    const target = payload.family_template_node_id || payload.template_node_id
      || templatesById.get(payload.family_template_id || payload.template_id || payload.family_id)
    if (target) joins.push({ instance_node_id: row.node_id, template_node_id: target })
  }
  for (const row of templateRows) {
    const payload = JSON.parse(row.payload_json || '{}')
    for (const instanceId of payload.family_instance_ids || payload.instance_ids || []) {
      const instance = store.db.prepare('SELECT node_id FROM family_instances WHERE id=?').get(instanceId)
      if (instance?.node_id) joins.push({ instance_node_id: instance.node_id, template_node_id: row.node_id })
    }
  }
  return joins.sort((a, b) => a.template_node_id.localeCompare(b.template_node_id) || a.instance_node_id.localeCompare(b.instance_node_id))
}

export function rebuildNodeAbilityRefs(store) {
  const existing = store.db.prepare("SELECT node_id,faction_id,ability_id,distance FROM node_ability_refs WHERE source_kind='explicit-ownership' ORDER BY node_id,faction_id,ability_id").all()
  const refs = new Map()
  for (const row of store.db.prepare('SELECT node_id,payload_json FROM nodes ORDER BY node_id').all()) {
    for (const ref of directRefs(JSON.parse(row.payload_json))) addRef(refs, row.node_id, ref.faction_id, ref.ability_id, 'direct', 0)
  }
  for (const ref of projectionOwnershipRefs(store)) addRef(refs, ref.node_id, ref.faction_id, ref.ability_id, 'ownership', 0)
  for (const ref of existing) {
    if (store.hasNode(ref.node_id)) addRef(refs, ref.node_id, ref.faction_id, ref.ability_id, 'explicit-ownership', Number(ref.distance))
  }
  propagateLineage(store, refs)
  const familyTargets = new Set()
  for (const join of familyJoinTargets(store)) {
    for (const ref of refs.get(join.instance_node_id)?.values() || []) {
      if (addRef(refs, join.template_node_id, ref.faction_id, ref.ability_id, 'family-instance', ref.distance)) familyTargets.add(join.template_node_id)
    }
  }
  propagateLineage(store, refs, [...familyTargets])
  const rows = [...refs.entries()].flatMap(([nodeId, nodeRefs]) => [...nodeRefs.values()].map(ref => ({ node_id: nodeId, ...ref })))
    .sort((a, b) => a.node_id.localeCompare(b.node_id) || a.faction_id.localeCompare(b.faction_id) || a.ability_id.localeCompare(b.ability_id))
  store.transaction(() => {
    store.db.exec('DELETE FROM node_ability_refs')
    const insert = store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
    for (const row of rows) insert.run(row.node_id, row.faction_id, row.ability_id, row.source_kind, row.distance)
  })
  return rows
}

export function reconcileAbilityCatalog(store, repoRoot, repositoryVersionId) {
  const catalog = repositoryCatalog(repoRoot, repositoryVersionId)
  store.transaction(() => {
    store.db.exec('DELETE FROM ability_catalog')
    const insert = store.db.prepare('INSERT INTO ability_catalog(faction_id,ability_id,ability_name,faction_name,repository_version_id) VALUES (?,?,?,?,?)')
    for (const row of catalog) insert.run(row.faction_id, row.ability_id, row.ability_name, row.faction_name, row.repository_version_id)
  })
  const refs = rebuildNodeAbilityRefs(store)
  return { catalog_count: catalog.length, ref_count: refs.length }
}

function projectedCampaignStatus(state, fallback = 'open') {
  if (state === 'completed' || state === 'converged') return 'converged'
  if (['aborted', 'superseded', 'failed-final'].includes(state)) return 'aborted'
  if (['planned', 'active', 'paused', 'reconciliation-required'].includes(state)) return 'open'
  return fallback
}

function runScoreSummary(store, runId) {
  const summary = {}
  for (const row of store.db.prepare('SELECT payload_json FROM checks WHERE run_id=? ORDER BY rowid DESC').all(runId)) {
    const payload = JSON.parse(row.payload_json)
    if (summary.mean_before == null && Number.isFinite(payload.baseline_mean)) summary.mean_before = payload.baseline_mean
    if (summary.mean_after == null) {
      if (Number.isFinite(payload.terminal_mean)) summary.mean_after = payload.terminal_mean
      else if (Number.isFinite(payload.updated_mean)) summary.mean_after = payload.updated_mean
    }
  }
  return summary
}

function projectCampaign(store, run, current = null) {
  const scores = runScoreSummary(store, run.run_id)
  const worklistSize = Number(store.db.prepare('SELECT count(*) AS n FROM claims WHERE run_id=?').get(run.run_id).n)
  const superseded = run.state === 'superseded'
  return {
    ...(current || {}),
    id: run.campaign_id,
    kind: current?.kind ?? run.kind,
    target: current?.target ?? run.target,
    bookmark: current?.bookmark ?? null,
    status: projectedCampaignStatus(run.state, current?.status),
    pr: current?.pr ?? null,
    worklist_size: current?.worklist_size ?? worklistSize,
    mean_before: current?.mean_before ?? scores.mean_before ?? null,
    mean_after: current?.mean_after ?? scores.mean_after ?? null,
    started: current?.started ?? run.started ?? null,
    finished: run.finished ?? current?.finished ?? null,
    notes: superseded
      ? 'Generated compatibility projection: superseded in the Mechanic Evidence Graph; legacy branches remain discovery-only and authorize no reuse.'
      : current?.notes ?? `Generated compatibility projection: ${run.state} in the Mechanic Evidence Graph.`,
  }
}

export function registryProjection(store, current) {
  const projected = structuredClone(current)
  const runs = new Map()
  for (const run of store.db.prepare('SELECT rowid,* FROM runs ORDER BY rowid').all()) {
    if (/^c\d+$/.test(run.campaign_id)) runs.set(run.campaign_id, run)
  }
  const seen = new Set()
  projected.campaigns = (projected.campaigns || []).map(campaign => {
    seen.add(campaign.id)
    const run = runs.get(campaign.id)
    return run ? projectCampaign(store, run, campaign) : campaign
  })
  for (const [campaignId, run] of [...runs].sort(([left], [right]) => left.localeCompare(right))) {
    if (!seen.has(campaignId)) projected.campaigns.push(projectCampaign(store, run))
  }
  projected.claim_graph = {
    schema_version: 2,
    authority: '_private/claim-graph/index.sqlite',
    registry_writer_frozen: true,
    graph_sequence: store.sequence(),
    replay_checksum: store.replayChecksum(),
  }
  return projected
}

export function projectRegistry(store, registryPath) {
  const current = JSON.parse(readFileSync(registryPath, 'utf8'))
  const projected = registryProjection(store, current)
  const bytes = `${JSON.stringify(projected, null, 2)}\n`
  const hash = sha256(bytes)
  const prior = store.db.prepare("SELECT value FROM meta WHERE key='registry_projection_hash'").get()
  if (!prior || prior.value !== hash || readFileSync(registryPath, 'utf8') !== bytes) atomicWrite(registryPath, bytes)
  store.db.prepare("INSERT INTO meta(key,value) VALUES ('registry_projection_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash)
  return { path: registryPath, hash, changed: !prior || prior.value !== hash, projection: projected }
}

export function verifyProjection(store, registryPath) {
  const current = JSON.parse(readFileSync(registryPath, 'utf8'))
  const expected = registryProjection(store, current)
  const bytes = `${JSON.stringify(expected, null, 2)}\n`
  const actual = readFileSync(registryPath, 'utf8')
  const recorded = store.db.prepare("SELECT value FROM meta WHERE key='registry_projection_hash'").get()
  const actualHash = sha256(actual)
  return { ok: actual === bytes && recorded?.value === actualHash, expected_hash: sha256(bytes), actual_hash: actualHash, recorded_hash: recorded?.value || null }
}
