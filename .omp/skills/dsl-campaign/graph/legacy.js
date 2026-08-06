import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'

const C007 = ['chaos-daemons/the-shadow-of-chaos', 'grey-knights/hallowed-ground', 'necrons/power-matrix', 'thousand-sons/flow-of-magic']
const C008 = [...C007]
const C009 = ['chaos-daemons/the-shadow-of-chaos', 'adeptus-astartes/specialised-weapon-system', 'grey-knights/hallowed-ground', 'astra-militarum/born-soldiers', 'necrons/power-matrix', 'thousand-sons/flow-of-magic']
const EXPECTED = {
  c007: { status: 'aborted', size: 4, worklist: C007 },
  c008: { status: 'aborted', size: 4, worklist: C008 },
  c009: { status: 'open', size: 6, worklist: C009 },
}
const CAMPAIGN_FIELDS = ['id', 'kind', 'target', 'bookmark', 'status', 'pr', 'worklist_size', 'mean_before', 'mean_after', 'started', 'finished']
const LEDGER_FIELDS = ['status', 'campaign', 'cos_start', 'cos_best', 'attempts']

function allow(source, fields) { return Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]])) }
function artifactHash(path) { return sha256(readFileSync(path)) }

export function bootstrapRegistry(store, { repoRoot, registryPath }) {
  const absolute = resolve(repoRoot, registryPath)
  const sourceHash = artifactHash(absolute)
  const prior = store.db.prepare("SELECT value FROM meta WHERE key='registry_bootstrap_hash'").get()
  if (prior) {
    if (prior.value !== sourceHash && !store.db.prepare("SELECT value FROM meta WHERE key='registry_writer_frozen'").get()) throw new Error('registry changed after bootstrap')
    return { idempotent: true, source_hash: prior.value, node_ids: [] }
  }
  const registry = JSON.parse(readFileSync(absolute, 'utf8'))
  const nodes = []
  for (const campaign of registry.campaigns || []) {
    const payload = { campaign_id: campaign.id, observation_type: 'campaign', status: campaign.status, summary: canonicalJson(allow(campaign, CAMPAIGN_FIELDS)), artifact_hashes: { registry: sourceHash }, known_members: [], unknown_count: campaign.worklist_size || 0, authorizes_reuse: false }
    const node = store.createNode({ kind: 'legacy-observation', payload })
    nodes.push(node.node_id)
  }
  for (const [key, row] of Object.entries(registry.ability_ledger || {})) {
    const [faction_id, ability_id] = key.split('/')
    const payload = { campaign_id: row.campaign, observation_type: 'ability-ledger', status: row.status, summary: canonicalJson({ faction_id, ability_id, ...allow(row, LEDGER_FIELDS) }), artifact_hashes: { registry: sourceHash }, known_members: [key], unknown_count: 0, authorizes_reuse: false }
    const node = store.createNode({ kind: 'legacy-observation', payload })
    nodes.push(node.node_id)
  }
  for (const [index, escalation] of (registry.escalations || []).entries()) {
    const payload = { campaign_id: escalation.campaign, observation_type: 'escalation', status: escalation.resolved === false ? 'open' : 'answered', summary: canonicalJson({ raised_by: escalation.raised_by, resolved: escalation.resolved === false ? false : true }), artifact_hashes: { registry: sourceHash, row: sha256(canonicalJson(escalation)) }, known_members: [], unknown_count: 0, authorizes_reuse: false }
    nodes.push(store.createNode({ kind: 'legacy-observation', payload }).node_id)
  }
  for (const shape of registry.blocked_shapes || []) {
    const payload = { campaign_id: null, observation_type: 'blocked-shape', status: 'blocked', summary: canonicalJson({ artifact_only: true }), artifact_hashes: { registry: sourceHash, row: sha256(canonicalJson(shape)) }, known_members: [], unknown_count: 0, authorizes_reuse: false }
    nodes.push(store.createNode({ kind: 'legacy-observation', payload }).node_id)
  }
  store.appendEvent('registry-bootstrapped', { source_hash: sourceHash, campaigns: (registry.campaigns || []).length, ability_rows: Object.keys(registry.ability_ledger || {}).length }, {
    projection: (db, sequence) => {
      for (const campaign of registry.campaigns || []) db.prepare('INSERT OR IGNORE INTO runs(run_id,campaign_id,state,kind,target,started,finished,source_hash) VALUES (?,?,?,?,?,?,?,?)').run(`legacy-${campaign.id}`, campaign.id, campaign.status === 'open' ? 'active' : campaign.status, campaign.kind, campaign.target, campaign.started, campaign.finished, sourceHash)
      for (const [key, row] of Object.entries(registry.ability_ledger || {})) db.prepare('INSERT OR REPLACE INTO legacy_observations(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(key, `legacy-${row.campaign}`, row.status, null, canonicalJson(allow(row, LEDGER_FIELDS)))
      const c005 = Object.entries(registry.ability_ledger || {}).filter(([, row]) => row.campaign === 'c005')
      for (const [key] of c005) {
        const [faction, ability] = key.split('/')
        db.prepare('INSERT OR IGNORE INTO claims(faction_id,ability_id,run_id,state,claimed_sequence) VALUES (?,?,?,?,?)').run(faction, ability, 'legacy-c005', 'active', sequence)
      }
      const c009 = C009
      for (const key of c009) {
        const [faction, ability] = key.split('/')
        db.prepare('INSERT OR IGNORE INTO claims(faction_id,ability_id,run_id,state,claimed_sequence) VALUES (?,?,?,?,?)').run(faction, ability, 'legacy-c009', 'active', sequence)
      }
      db.prepare("INSERT INTO meta(key,value) VALUES ('registry_bootstrap_hash',?)").run(sourceHash)
      db.prepare("INSERT INTO meta(key,value) VALUES ('registry_writer_frozen','1')").run()
      if (registry.claim_graph?.authority) db.prepare("INSERT INTO meta(key,value) VALUES ('registry_is_graph_projection','1')").run()
    },
  })
  return { idempotent: false, source_hash: sourceHash, node_ids: nodes }
}

function observation(store, campaignId, observation_type, status, summary, artifact_hashes, known_members = [], unknown_count = 0) {
  const node = store.createNode({ kind: 'legacy-observation', payload: { campaign_id: campaignId, observation_type, status, summary, artifact_hashes, known_members, unknown_count, authorizes_reuse: false } })
  store.db.prepare('INSERT OR IGNORE INTO legacy_observations(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run(`${campaignId}:${observation_type}:${node.node_id.slice(0, 8)}`, `legacy-${campaignId}`, status, node.node_id, canonicalJson({ summary }))
  return node
}

export function recoverLegacy(store, { repoRoot, loopStateRoot = join(repoRoot, '_private/loop-state'), campaigns = ['c007', 'c008', 'c009'] }) {
  const marker = `legacy_recovery_${campaigns.join('_')}`
  if (store.db.prepare('SELECT value FROM meta WHERE key=?').get(marker)) return { idempotent: true, node_ids: [] }
  for (const id of campaigns) {
    const run = store.db.prepare('SELECT state FROM runs WHERE campaign_id=?').get(id)
    const expected = EXPECTED[id]
    if (!run || !expected) throw new Error(`legacy campaign missing: ${id}`)
    const projectedC009 = id === 'c009' && run.state === 'aborted' && store.db.prepare("SELECT value FROM meta WHERE key='registry_is_graph_projection'").get()
    const compatibleState = run.state === expected.status || (expected.status === 'open' && run.state === 'active') || projectedC009
    if (!compatibleState) throw new Error(`${id} status mismatch: expected ${expected.status}, got ${run.state}`)
  }
  const regionPath = join(loopStateRoot, 'roundtrip-necrons-power-matrix.md')
  const visibilityPath = join(loopStateRoot, 'roundtrip-c009-shapes.md')
  const artifacts = { region: artifactHash(regionPath), visibility: artifactHash(visibilityPath) }
  const nodes = []
  if (campaigns.includes('c007')) {
    nodes.push(observation(store, 'c007', 'three-round-not-converged', 'aborted', 'three rounds retained unresolved producer, consumer, expiry, precedence, and parity findings', { region: artifacts.region, baseline: 'unavailable', package: 'unavailable', prototype: 'unavailable' }, C007).node_id)
    nodes.push(observation(store, 'c007', 'excluded-analogue', 'excluded', 'static-zone damage does not define or mutate named region state', { region: artifacts.region }, ['rad-bombardment']).node_id)
  }
  if (campaigns.includes('c008')) {
    const implementation = observation(store, 'c008', 'named-region-state-implementation', 'implemented-unshipped', 'four-port implementation exists at commit 2199a194f8ee without post-repair full gate or prose diff', { region: artifacts.region, commit: '2199a194f8ee' }, C008)
    nodes.push(implementation.node_id)
    nodes.push(observation(store, 'c008', 'targeted-gates', 'passed-targeted', 'targeted parity, lever, audit, and review claims retained without close authority', { region: artifacts.region }, ['necrons/power-matrix', 'thousand-sons/flow-of-magic']).node_id)
    for (const key of ['chaos-daemons/the-shadow-of-chaos', 'grey-knights/hallowed-ground']) nodes.push(observation(store, 'c008', `needs-schema-${key}`, 'needs-schema', 'negative observation remains discovery-only', { region: artifacts.region }, [key]).node_id)
    for (const key of ['necrons/power-matrix', 'thousand-sons/flow-of-magic']) {
      const correspondence = store.createNode({ kind: 'retrieval-match', payload: { campaign_id: 'c008', ability_key: key, match_type: 'corresponds_to_current_implementation', authorizes_reuse: false } })
      store.db.prepare('INSERT OR IGNORE INTO edges(parent_node_id,child_node_id,edge_type,authorizes_reuse,metadata_json) VALUES (?,?,?,?,?)').run(implementation.node_id, correspondence.node_id, 'corresponds_to_current_implementation', 0, '{"authorizes_reuse":false}')
      nodes.push(correspondence.node_id)
    }
  }
  if (campaigns.includes('c009')) {
    const open = observation(store, 'c009', 'observed-open-run', 'open', 'paused unresolved run observed before supersession', { visibility: artifacts.visibility }, C009)
    const branchA = observation(store, 'c009', 'charter-A-current_attack_target_visibility', 'untrusted', 'fixed attacking-model observer with visible or not-visible polarity', { visibility: artifacts.visibility, prototype: 'unavailable' }, ['adeptus-astartes/specialised-weapon-system', 'astra-militarum/born-soldiers', 'grey-knights/hallowed-ground', 'necrons/power-matrix'], 0)
    const branchB = observation(store, 'c009', 'charter-B-attack-target-visibility', 'untrusted', 'configurable or aggregate observer scope; claimed seven members', { visibility: artifacts.visibility, prototype: 'unavailable' }, C009, 1)
    nodes.push(open.node_id, branchA.node_id, branchB.node_id)
    const oldDecision = store.createNode({ kind: 'decision', payload: { campaign_id: 'c009', state: 'superseded', choice: 'unresolved-contract-choice', authorizes_reuse: false }, input_node_ids: [open.node_id] })
    const recovery = store.createNode({ kind: 'maintainer-decision', payload: { decision_id: 'c009-recovery', state: 'answered', text: 'both branches are preserved and neither selected', authorizes_reuse: false }, input_node_ids: [branchA.node_id, branchB.node_id] })
    nodes.push(oldDecision.node_id, recovery.node_id)
    store.appendEvent('lineage-mismatch', { campaign_id: 'c009', classification: 'invalid-output', reason: 'cross-branch attachment rejected' }, { aggregate_kind: 'run', aggregate_id: 'legacy-c009' })
    store.appendEvent('run-superseded', { campaign_id: 'c009', observed_parent_node_id: open.node_id, recovery_decision_node_id: recovery.node_id }, { aggregate_kind: 'run', aggregate_id: 'legacy-c009', node_id: recovery.node_id, projection: (db, sequence) => {
      db.prepare("UPDATE runs SET state='superseded',finished='2026-08-05' WHERE campaign_id='c009'").run()
      db.prepare("UPDATE claims SET state='released',released_sequence=? WHERE run_id='legacy-c009' AND state='active'").run(sequence)
    } })
  }
  store.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(marker, sha256(canonicalJson({ campaigns, artifacts })))
  store.syncMirror()
  return { idempotent: false, node_ids: nodes, artifacts }
}

export function campaignView(store, campaignId) {
  const run = store.db.prepare('SELECT * FROM runs WHERE campaign_id=?').get(campaignId) || null
  const observations = run ? store.db.prepare("SELECT id,state,node_id,payload_json FROM legacy_observations WHERE run_id=? AND id LIKE ? ORDER BY id").all(run.run_id, `${campaignId}:%`) : []
  const claims = run ? store.db.prepare('SELECT faction_id,ability_id,state FROM claims WHERE run_id=? ORDER BY faction_id,ability_id').all(run.run_id) : []
  const events = run ? store.db.prepare('SELECT sequence,event_type,payload_json FROM events WHERE aggregate_id=? ORDER BY sequence').all(run.run_id) : []
  return { run, observations, claims, events }
}
