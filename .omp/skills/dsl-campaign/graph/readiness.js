import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { resolveSourceBinding } from './formalization.js'
import { projectRegistry, verifyProjection } from './projection.js'
import { wholeGraphPriorities } from './retrieval.js'
import { ensureTask } from './scheduler.js'
import { repositoryVersionPayload } from './versions.js'

function parseWorklist(worklist) {
  if (!worklist) return null
  const value = typeof worklist === 'string' ? JSON.parse(readFileSync(worklist, 'utf8')) : worklist
  const entries = Array.isArray(value) ? value : value.entries
  if (!Array.isArray(entries) || !entries.length) throw new TypeError('worklist must contain entries')
  const parsed = entries.map(entry => {
    if (typeof entry === 'string' && entry.includes('/')) {
      const [faction_id, ability_id] = entry.split('/')
      return { faction_id, ability_id }
    }
    if (!entry || typeof entry.faction_id !== 'string' || !entry.faction_id || typeof entry.ability_id !== 'string' || !entry.ability_id) throw new TypeError('worklist entries require faction_id and ability_id')
    return { ...entry, faction_id: entry.faction_id, ability_id: entry.ability_id }
  })
  const keys = parsed.map(entry => `${entry.faction_id}/${entry.ability_id}`)
  if (new Set(keys).size !== keys.length) throw new TypeError('worklist entries must be unique')
  return parsed
}

function latestRepositoryNode(store) {
  return store.db.prepare("SELECT node_id,payload_json FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get() || null
}

export function nextCampaignId(store) {
  const planned = store.db.prepare("SELECT campaign_id FROM runs WHERE state='planned' AND kind='graph-backed' ORDER BY campaign_id").all()
  if (planned.length > 1) throw new Error('multiple prepared campaigns')
  if (planned.length === 1) return planned[0].campaign_id
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
  const latestVersion = latestRepositoryNode(store)
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
  const excluded_claims = store.db.prepare("SELECT faction_id,ability_id,run_id FROM claims WHERE state='active' ORDER BY faction_id,ability_id").all().map(row => ({ ...row }))
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
  let next_campaign_id = null
  try { next_campaign_id = nextCampaignId(store) } catch (error) { errors.push(error.message) }
  return { ready: errors.length === 0, next_campaign_id, graph_sequence: store.sequence(), replay_checksum: store.replayChecksum(), projection_checksum: store.projectionChecksum(), integrity, intake_outcomes: intakeCount, excluded_claims, missing_ability_metadata, worklist: parsed, errors }
}

function task(label, kind, depends_on, payload) { return { label, kind, depends_on, payload } }

export function abilityCampaignDag({ faction_id, ability_id, generation, source_formalization_node_id = null, source_binding = null }) {
  if (!['initial'].includes(generation) && (typeof generation !== 'string' || !generation)) throw new TypeError('generation required')
  const key = `${faction_id}/${ability_id}`
  const prefix = `ability:${key}:${generation}`
  const common = { faction_id, ability_id, generation }
  const tasks = []
  let formalizationDependency
  if (source_formalization_node_id) {
    formalizationDependency = null
  } else {
    const source = `${prefix}:source-retrieval`
    const who = `${prefix}:who`
    const when = `${prefix}:when`
    const what = `${prefix}:what`
    const formalize = `${prefix}:source-formalization`
    tasks.push(
      task(source, 'source-retrieval', [], { ...common, source_binding }),
      task(who, 'target-decomposition', [source], common),
      task(when, 'timing-decomposition', [source], common),
      task(what, 'effect-decomposition', [source], common),
      task(formalize, 'source-formalization', [source, who, when, what], common),
    )
    formalizationDependency = formalize
  }
  const retrieval = `${prefix}:certified-retrieval`
  const plan = `${prefix}:construction-plan`
  const author = `${prefix}:author`
  const verify = `${prefix}:verify`
  const audit = `${prefix}:audit`
  tasks.push(
    task(retrieval, 'certified-retrieval', formalizationDependency ? [formalizationDependency] : [], { ...common, input_node_ids: source_formalization_node_id ? [source_formalization_node_id] : [] }),
    task(plan, 'construction-plan', [retrieval], common),
    task(author, 'author', [plan], common),
    task(verify, 'verify', [author], common),
    task(audit, 'audit', [verify], common),
  )
  return tasks
}

function taskId(runId, label) { return `${runId}:${label}` }

function registerDag(store, runId, dag) {
  return dag.map(entry => ensureTask(store, {
    run_id: runId,
    label: entry.label,
    kind: entry.kind,
    depends_on: entry.depends_on.map(label => taskId(runId, label)),
    payload: entry.payload,
  }))
}

export function prioritizationDag(store, { run_id, scout_shapes = [], curation_input }) {
  if (!Array.isArray(scout_shapes)) throw new TypeError('scout_shapes must be an array')
  const canonical = scout_shapes.map(shape => ({ shape, encoded: canonicalJson(shape) })).sort((left, right) => left.encoded.localeCompare(right.encoded))
  if (new Set(canonical.map(item => item.encoded)).size !== canonical.length) throw new TypeError('duplicate canonical scout shape')
  const tasks = canonical.map(({ shape, encoded }, index) => {
    const ordinal = String(index + 1).padStart(2, '0')
    const label = `prioritize:scout:${ordinal}:${sha256(encoded).slice(0, 12)}`
    return task(label, 'prioritize-scout', [], { shape })
  })
  tasks.push(task('prioritize:curate', 'prioritize-curate', tasks.map(entry => entry.label), curation_input))
  registerDag(store, run_id, tasks)
  return tasks
}

function validatePrioritizeInput(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('prioritize input must be an object')
  if (!Number.isInteger(input.worklist_cap) || input.worklist_cap < 1 || input.worklist_cap > 40) throw new TypeError('worklist_cap must be 1..40')
  if (!Array.isArray(input.scout_shapes || [])) throw new TypeError('scout_shapes must be an array')
  if (!Array.isArray(input.excluded_claims || [])) throw new TypeError('excluded_claims must be an array')
  if (!input.artifacts || Object.getPrototypeOf(input.artifacts) !== Object.prototype) throw new TypeError('artifacts must be an object')
  return input
}

export function prepareCampaign(store, { id, repoRoot, registryPath, prioritizeInput }) {
  const input = validatePrioritizeInput(prioritizeInput)
  const gate = readiness(store, { repoRoot, registryPath })
  if (!gate.ready) return { prepared: false, gate }
  if (id !== gate.next_campaign_id) throw new TypeError(`next campaign id is ${gate.next_campaign_id}`)
  if (canonicalJson(input.excluded_claims) !== canonicalJson(gate.excluded_claims)) throw new TypeError('prioritize exclusions differ from readiness projection')
  const repository = latestRepositoryNode(store)
  const ranking = wholeGraphPriorities(store, { repoRoot })
  const curationInput = {
    worklist_cap: input.worklist_cap,
    artifacts: input.artifacts,
    excluded_claims: input.excluded_claims,
    frozen_whole_graph_ranking: ranking,
  }
  const readinessNode = store.createNode({
    kind: 'decision',
    payload: { campaign_id: id, state: 'answered', readiness_checksum: gate.replay_checksum, authorizes_reuse: false },
    parents: [{ node_id: repository.node_id, edge_type: 'derived_from', authorizes_reuse: false, metadata: {} }],
  })
  let dag
  store.transaction(() => {
    store.appendEvent('run-created', {
      row: { run_id: id, campaign_id: id, state: 'planned', kind: 'graph-backed', target: 'curated', source_hash: gate.replay_checksum },
      repository_parent_node_id: repository.node_id,
      readiness_parent_node_id: readinessNode.node_id,
      prioritize_input_hash: sha256(canonicalJson(input)),
    }, { aggregate_kind: 'run', aggregate_id: id, node_id: readinessNode.node_id })
    dag = prioritizationDag(store, { run_id: id, scout_shapes: input.scout_shapes || [], curation_input: curationInput })
  })
  projectRegistry(store, registryPath)
  return { prepared: true, run_id: id, state: 'planned', gate, dag, readiness_node_id: readinessNode.node_id }
}

function campaignSourceBinding(repoRoot, entry) {
  try {
    return resolveSourceBinding(join(repoRoot, '..', '40kdc-abilities'), entry.faction_id, entry.ability_id)
  } catch (error) {
    if (error.code === 'ENOENT' || /source-unavailable|authoritative source entry count: 0/.test(error.message)) return null
    throw error
  }
}

export function startCampaign(store, { id, repoRoot, registryPath, worklist, dryRun = false }) {
  const parsed = parseWorklist(worklist)
  const prepared = store.db.prepare("SELECT * FROM runs WHERE run_id=? AND campaign_id=? AND state='planned'").get(id, id)
  if (!prepared) throw new Error(`prepared campaign not found: ${id}`)
  const gate = readiness(store, { repoRoot, registryPath, worklist: parsed })
  if (!gate.ready) return { started: false, dry_run: dryRun, gate, dag: [] }
  if (id !== gate.next_campaign_id) throw new TypeError(`next campaign id is ${gate.next_campaign_id}`)
  const dag = parsed.flatMap(entry => abilityCampaignDag({
    faction_id: entry.faction_id,
    ability_id: entry.ability_id,
    generation: 'initial',
    source_binding: campaignSourceBinding(repoRoot, entry),
  }))
  if (dryRun) return { started: false, dry_run: true, gate, dag, state_unchanged: true }
  const started = new Date().toISOString()
  store.transaction(() => {
    const sequence = store.sequence() + 1
    store.appendEvent('run-started', {
      expected_state: 'planned',
      row: { started },
      worklist_hash: sha256(canonicalJson(parsed)),
      rows: {
        claims: parsed.map(entry => ({ faction_id: entry.faction_id, ability_id: entry.ability_id, run_id: id, state: 'active', claimed_sequence: sequence })),
      },
    }, { aggregate_kind: 'run', aggregate_id: id })
    registerDag(store, id, dag)
  })
  projectRegistry(store, registryPath)
  return { started: true, dry_run: false, gate, dag, run_id: id }
}
