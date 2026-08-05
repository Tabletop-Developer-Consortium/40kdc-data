import { readFileSync } from 'node:fs'
import { canonicalJson, sha256 } from './canonical.js'
import { verifyProjection } from './projection.js'
import { repositoryVersionPayload } from './versions.js'

function parseWorklist(worklist) {
  if (!worklist) return null
  const value = typeof worklist === 'string' ? JSON.parse(readFileSync(worklist, 'utf8')) : worklist
  const entries = Array.isArray(value) ? value : value.entries
  if (!Array.isArray(entries) || !entries.length) throw new TypeError('worklist must contain entries')
  return entries.map(entry => {
    if (typeof entry === 'string' && entry.includes('/')) {
      const [faction_id, ability_id] = entry.split('/')
      return { faction_id, ability_id }
    }
    if (!entry || typeof entry.faction_id !== 'string' || typeof entry.ability_id !== 'string') throw new TypeError('worklist entries require faction_id and ability_id')
    return { faction_id: entry.faction_id, ability_id: entry.ability_id }
  })
}

export function nextCampaignId(store) {
  let maximum = 0n
  for (const { campaign_id: campaignId } of store.db.prepare('SELECT DISTINCT campaign_id FROM runs ORDER BY campaign_id').all()) {
    const match = /^c(\d+)$/.exec(campaignId)
    if (match) {
      const value = BigInt(match[1])
      if (value > maximum) maximum = value
    }
  }
  return `c${(maximum + 1n).toString().padStart(3, '0')}`
}

export function readiness(store, { repoRoot, registryPath, worklist = null } = {}) {
  const errors = []
  let integrity
  try { integrity = store.reconcile() } catch (error) { errors.push(error.message) }
  const bootstrap = store.db.prepare("SELECT value FROM meta WHERE key='registry_bootstrap_hash'").get()
  if (!bootstrap) errors.push('registry bootstrap missing')
  for (const campaign of ['c007', 'c008', 'c009']) if (!store.db.prepare('SELECT value FROM meta WHERE key LIKE ?').get(`legacy_recovery_%${campaign}%`)) errors.push(`${campaign} recovery missing`)
  const intakeRun = store.db.prepare("SELECT run_id,state FROM runs WHERE kind='certification-intake' ORDER BY rowid DESC LIMIT 1").get()
  const intakeCount = intakeRun ? Number(store.db.prepare('SELECT count(*) AS n FROM ability_evidence WHERE run_id=?').get(intakeRun.run_id).n) : 0
  if (!intakeRun || intakeRun.state !== 'completed' || intakeCount !== 12) errors.push(`certification intake incomplete: ${intakeCount}/12`)
  if (registryPath) {
    const projection = verifyProjection(store, registryPath)
    if (!projection.ok) errors.push('registry projection mismatch')
  }
  const latestVersion = store.db.prepare("SELECT payload_json FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
  if (!latestVersion) errors.push('repository version missing')
  else {
    const recorded = JSON.parse(latestVersion.payload_json)
    const selectedPaths = recorded.files.filter(file => file.path.startsWith('data/')).map(file => file.path)
    const current = repositoryVersionPayload(repoRoot, selectedPaths).workspace_hash
    if (recorded.workspace_hash !== current) errors.push('repository reconciliation required')
  }
  const blockers = Number(store.db.prepare("SELECT count(*) AS n FROM apply_transactions WHERE state='reconciliation-required'").get().n)
  if (blockers) errors.push(`${blockers} apply transaction blocker(s)`)
  const liveLeases = Number(store.db.prepare("SELECT count(*) AS n FROM leases JOIN runs USING(run_id) WHERE leases.state='active' AND runs.state NOT IN ('completed','aborted','superseded','failed-final')").get().n)
  if (liveLeases) errors.push(`${liveLeases} live lease(s) remain`)
  const excluded_claims = store.db.prepare("SELECT faction_id,ability_id,run_id FROM claims WHERE state='active' ORDER BY faction_id,ability_id").all()
  const missing_ability_metadata = store.db.prepare(`
    SELECT DISTINCT refs.faction_id,refs.ability_id
    FROM node_ability_refs AS refs
    LEFT JOIN ability_catalog AS catalog
      ON catalog.faction_id=refs.faction_id AND catalog.ability_id=refs.ability_id
    WHERE catalog.ability_id IS NULL
    ORDER BY refs.faction_id,refs.ability_id
  `).all().map(row => `${row.faction_id}/${row.ability_id}`)
  if (missing_ability_metadata.length) errors.push(`ability metadata missing: ${missing_ability_metadata.join(', ')}`)
  let parsed = null
  try { parsed = parseWorklist(worklist) } catch (error) { errors.push(error.message) }
  if (parsed) {
    const active = new Set(excluded_claims.map(claim => `${claim.faction_id}/${claim.ability_id}`))
    const overlaps = parsed.filter(entry => active.has(`${entry.faction_id}/${entry.ability_id}`))
    if (overlaps.length) errors.push(`worklist overlaps active claims: ${overlaps.map(entry => `${entry.faction_id}/${entry.ability_id}`).join(', ')}`)
  }
  return { ready: errors.length === 0, next_campaign_id: nextCampaignId(store), graph_sequence: store.sequence(), replay_checksum: store.replayChecksum(), projection_checksum: store.projectionChecksum(), integrity, intake_outcomes: intakeCount, excluded_claims, missing_ability_metadata, worklist: parsed, errors }
}

export function campaignDag(campaignId, worklist) {
  return worklist.flatMap(entry => {
    const key = `${entry.faction_id}/${entry.ability_id}`
    return [
      { task_id: `${campaignId}:${key}:source-formalization`, kind: 'source-formalization', faction_id: entry.faction_id, ability_id: entry.ability_id, depends_on: [] },
      { task_id: `${campaignId}:${key}:retrieval`, kind: 'certified-retrieval', faction_id: entry.faction_id, ability_id: entry.ability_id, depends_on: [`${campaignId}:${key}:source-formalization`] },
      { task_id: `${campaignId}:${key}:construction-plan`, kind: 'construction-plan', faction_id: entry.faction_id, ability_id: entry.ability_id, depends_on: [`${campaignId}:${key}:retrieval`] },
      { task_id: `${campaignId}:${key}:author`, kind: 'author', faction_id: entry.faction_id, ability_id: entry.ability_id, depends_on: [`${campaignId}:${key}:construction-plan`] },
    ]
  })
}

export function startCampaign(store, { id, repoRoot, registryPath, worklist, dryRun = false }) {
  const gate = readiness(store, { repoRoot, registryPath, worklist })
  if (!gate.ready) return { started: false, dry_run: dryRun, gate, dag: gate.worklist ? campaignDag(id, gate.worklist) : [] }
  if (id !== gate.next_campaign_id) throw new TypeError(`next campaign id is ${gate.next_campaign_id}`)
  const dag = campaignDag(id, gate.worklist)
  if (dryRun) return { started: false, dry_run: true, gate, dag, state_unchanged: true }
  const readinessNode = store.createNode({ kind: 'decision', payload: { campaign_id: id, state: 'answered', readiness_checksum: gate.replay_checksum, authorizes_reuse: false } })
  store.appendEvent('run-created', { campaign_id: id, worklist_hash: sha256(canonicalJson(gate.worklist)), readiness_parent_node_id: readinessNode.node_id }, {
    aggregate_kind: 'run', aggregate_id: id, node_id: readinessNode.node_id,
    projection: (db, sequence) => {
      db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,started,source_hash) VALUES (?,?,?,?,?,?,?)').run(id, id, 'active', 'graph-backed', 'curated', new Date().toISOString(), gate.replay_checksum)
      for (const entry of gate.worklist) db.prepare('INSERT INTO claims(faction_id,ability_id,run_id,state,claimed_sequence) VALUES (?,?,?,?,?)').run(entry.faction_id, entry.ability_id, id, 'active', sequence)
      for (const task of dag) db.prepare('INSERT INTO tasks(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(task.task_id, id, task.depends_on.length ? 'pending' : 'ready', null, canonicalJson(task))
    },
  })
  return { started: true, dry_run: false, gate, dag, readiness_node_id: readinessNode.node_id }
}
