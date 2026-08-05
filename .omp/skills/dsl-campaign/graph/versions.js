import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { FORMALIZATION_POLICY_VERSION, PRODUCER_CONTRACT_VERSION, SCHEMA_VERSION } from './schema.js'
const IGNORED_RUNTIME_FILES = new Set(['.DS_Store'])

const ROOTS = [
  '.omp/skills/dsl-campaign', '.omp/agents', 'schemas/enrichment/ability-dsl', 'conformance',
  'tools/src/abilities', 'tools/src/cruncher', 'tools/src/validate.ts', 'tools/src/generated.ts',
  'crates/wh40kdc/src', 'python/src/wh40kdc', 'go',
]
const RUNNERS = ['tools/src/runner.ts', 'crates/wh40kdc/src/bin/runner.rs', 'python/src/wh40kdc/runner.py', 'go/cmd/wh40kdc-runner']
const METADATA_ROOTS = ['data/core', 'data/enrichment']

function filesUnder(repoRoot, entry) {
  const absolute = join(repoRoot, entry)
  if (!existsSync(absolute)) return []
  if (statSync(absolute).isFile()) return [absolute]
  return readdirSync(absolute, { withFileTypes: true })
    .filter(child => !IGNORED_RUNTIME_FILES.has(child.name))
    .flatMap(child => filesUnder(repoRoot, join(entry, child.name)))
}

function commandVersion(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8' }).trim() } catch { return 'unavailable' }
}

function hashPath(repoRoot, path) {
  const absolute = join(repoRoot, path)
  if (!existsSync(absolute)) return null
  if (statSync(absolute).isDirectory()) {
    const hashes = filesUnder(repoRoot, path)
      .sort()
      .map(file => [relative(repoRoot, file), sha256(readFileSync(file))])
    return sha256(canonicalJson(hashes))
  }
  return sha256(readFileSync(absolute))
}

export function repositoryMetadataPaths(repoRoot) {
  return METADATA_ROOTS.flatMap(entry => filesUnder(repoRoot, entry))
    .filter(path => /\/(factions|abilities)\.json$/.test(path))
    .map(path => relative(repoRoot, path))
    .sort()
}

export function repositoryVersionPayload(repoRoot, selectedDslPaths = []) {
  const metadataPaths = repositoryMetadataPaths(repoRoot)
  const paths = [...new Set([...ROOTS.flatMap(entry => filesUnder(repoRoot, entry)), ...metadataPaths.map(path => join(repoRoot, path)), ...selectedDslPaths.map(path => join(repoRoot, path))])]
    .filter(path => existsSync(path) && statSync(path).isFile())
    .sort()
  const files = paths.map(path => ({ path: relative(repoRoot, path), byte_hash: sha256(readFileSync(path)) }))
  const runner_hashes = RUNNERS.map(path => ({ path, byte_hash: hashPath(repoRoot, path) }))
  const tool_versions = {
    node: process.version,
    npm: commandVersion('npm', ['--version']),
    rust: commandVersion('rustc', ['--version']),
    python: commandVersion('python3', ['--version']),
    go: commandVersion('go', ['version']),
  }
  return {
    workspace_hash: sha256(canonicalJson({ files, tool_versions, runner_hashes })),
    files,
    tool_versions,
    runner_hashes,
    schema_version: SCHEMA_VERSION,
    policy_version: FORMALIZATION_POLICY_VERSION,
    producer_contract_version: PRODUCER_CONTRACT_VERSION,
  }
}

export function createRepositoryVersion(store, repoRoot, selectedDslPaths = []) {
  const payload = repositoryVersionPayload(repoRoot, selectedDslPaths)
  const node = store.createNode({ kind: 'repository-version', payload: {
    workspace_hash: payload.workspace_hash,
    files: payload.files,
    tool_versions: payload.tool_versions,
    runner_hashes: payload.runner_hashes,
    schema_version: payload.schema_version,
    policy_version: payload.policy_version,
  } })
  return { node, payload }
}
