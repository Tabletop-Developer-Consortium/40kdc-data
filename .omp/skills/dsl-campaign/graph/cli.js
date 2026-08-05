#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptIntake, intakeReport, prepareIntake } from './intake.js'
import { bootstrapRegistry, campaignView, recoverLegacy } from './legacy.js'
import { projectRegistry, reconcileAbilityCatalog, verifyProjection } from './projection.js'
import { readiness, startCampaign } from './readiness.js'
import { GraphStore } from './store.js'
import { createRepositoryVersion } from './versions.js'
import { verifyGraphIpBoundary } from './workflow-lineage.js'

const EXIT = { negative: 1, usage: 2, integrity: 3, external: 4 }

const BOOLEAN_OPTIONS = new Set(['json', 'next', 'dry_run', 'ip_boundary'])

function readJson(repoRoot, path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'))
}

function output(command, store, data = {}, ok = true, errors = [], warnings = []) {
  const { node_ids: nodeIds, ...result } = data
  const body = {
    command,
    ok,
    graph_sequence: store?.sequence?.() || 0,
    warnings,
    errors,
    ...result,
    node_ids: nodeIds || [],
  }
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
}

function requireOption(options, key) {
  if (!options[key] || options[key] === true) throw new TypeError(`--${key.replaceAll('_', '-')} required`)
  return options[key]
}

function runtimeCheck() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 18)) {
    throw Object.assign(new Error('graph CLI requires Node >=22.18'), { exitCode: EXIT.external })
  }
  const probe = new DatabaseSync(':memory:')
  try {
    if (typeof probe.prepare !== 'function' || typeof probe.exec !== 'function') {
      throw new Error('node:sqlite DatabaseSync lacks prepare/exec')
    }
  } finally {
    probe.close()
  }
}
function parse(argv) {
  const [command, ...rest] = argv
  const options = { _: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) options._.push(value)
    else {
      const key = value.slice(2).replaceAll('-', '_')
      if (BOOLEAN_OPTIONS.has(key)) options[key] = true
      else if (index + 1 < rest.length && !rest[index + 1].startsWith('--')) options[key] = rest[++index]
      else options[key] = true
    }
  }
  return { command, options }
}

const { command, options } = parse(process.argv.slice(2))
let store
try {
  runtimeCheck()
  if (!command) throw new TypeError('command required')
  const repoRoot = resolve(options.repo_root || '.')
  const root = resolve(repoRoot, options.graph_root || options.root || process.env.DSL_CLAIM_GRAPH_ROOT || '_private/claim-graph')
  store = new GraphStore(root, { repositoryRoot: repoRoot })
  const registryPath = resolve(repoRoot, options.registry || '_private/loop-state/registry.json')
  let result
  switch (command) {
    case 'init': result = { initialized: true, root }; break
    case 'bootstrap-registry': result = bootstrapRegistry(store, { repoRoot, registryPath: requireOption(options, 'registry') }); break
    case 'prepare-intake': {
      result = prepareIntake(store, { repoRoot, manifest: readJson(repoRoot, requireOption(options, 'manifest')) })
      result.prepared_batch_path = result.path
      delete result.prepared
      break
    }
    case 'accept-intake': result = acceptIntake(store, { repoRoot, result: readJson(repoRoot, requireOption(options, 'result')) }); break
    case 'intake-report': result = intakeReport(store, options.run_id || null); break
    case 'recover-legacy': result = recoverLegacy(store, { repoRoot, campaigns: String(options.campaigns || 'c007,c008,c009').split(',') }); break
    case 'project-registry': result = projectRegistry(store, registryPath); break
    case 'reconcile-repository': {
      const selectedPaths = store.db.prepare("SELECT payload_json FROM nodes WHERE kind='repository-version' ORDER BY rowid DESC LIMIT 1").get()
      const selected = selectedPaths ? JSON.parse(selectedPaths.payload_json).files.filter(file => file.path.startsWith('data/')).map(file => file.path) : []
      const repository = createRepositoryVersion(store, repoRoot, selected)
      store.appendEvent('repository-reconciled', { repository_version_node_id: repository.node.node_id }, { aggregate_kind: 'repository', aggregate_id: repository.node.node_id, node_id: repository.node.node_id })
      const projection = reconcileAbilityCatalog(store, repoRoot, repository.node.node_id)
      const registry = existsSync(registryPath) ? projectRegistry(store, registryPath) : null
      result = { repository_version_node_id: repository.node.node_id, workspace_hash: repository.payload.workspace_hash, projection, registry_projection: registry }
      break
    }
    case 'replay': result = { ...store.verifyEvents(), replay_checksum: store.replayChecksum() }; break
    case 'verify': {
      const integrity = store.reconcile()
      const projection = existsSync(registryPath) && store.db.prepare("SELECT value FROM meta WHERE key='registry_projection_hash'").get() ? verifyProjection(store, registryPath) : null
      const ipBoundary = options.ip_boundary
        ? verifyGraphIpBoundary(store, resolve(repoRoot, requireOption(options, 'store')))
        : null
      result = { integrity, projection, ip_boundary: ipBoundary, verified: (!projection || projection.ok) && (!ipBoundary || ipBoundary.clean) }
      if (!result.verified) process.exitCode = EXIT.integrity
      break
    }
    case 'campaign': result = campaignView(store, options._[0] || requireOption(options, 'id')); break
    case 'readiness': {
      result = readiness(store, { repoRoot, registryPath, worklist: options.worklist ? resolve(repoRoot, options.worklist) : null })
      if (!result.ready) process.exitCode = EXIT.negative
      break
    }
    case 'start-campaign': {
      result = startCampaign(store, { id: requireOption(options, 'id'), repoRoot, registryPath, worklist: resolve(repoRoot, requireOption(options, 'worklist')), dryRun: Boolean(options.dry_run) })
      if (!result.started && !result.dry_run) process.exitCode = EXIT.negative
      break
    }
    default: throw new TypeError(`unknown command: ${command}`)
  }
  output(command, store, result, process.exitCode === undefined || process.exitCode === 0, result.errors || [])
} catch (error) {
  const usage = error instanceof TypeError || /required|manifest|schema|unknown command/.test(error.message)
  const integrity = /hash|integrity|lineage|reconciliation|collision|object|sequence|projection/.test(error.message)
  process.exitCode = error.exitCode || (usage ? EXIT.usage : integrity ? EXIT.integrity : EXIT.external)
  output(command || null, store, {}, false, [error.message])
} finally {
  store?.close()
}
