export const meta = {
  name: 'dsl-verify-batch',
  description: 'Post-apply verification: skitarius gates ∥ cogitator lever diff ∥ psyker cold-read',
  phases: [
    { title: 'Gates', detail: 'validate / test / translate-smoke / drift in the loop workspace' },
    { title: 'Levers', detail: 'cruncher-lever before/after diff vs committed baseline' },
    { title: 'ColdRead', detail: 'psyker intelligibility pass over the new renders, per faction' },
  ],
}

// args: {
//   repo_root: string,
//   campaign_id: string,
//   batch_id: string,
//   campaign_manifest_sha256: string,
//   candidate_commit_id: string,
//   expected_candidate_dsl_hashes: { "faction/ability": sha256 },
//   campaign_base_commit_id?: string, // required for sealed-campaign
//   baseline_commit_id?: string,      // required for intermediate verification; explicit committed parent
//   sealed_head?: boolean,           // closure-only: inspect @- after jj new
//   ability_ids: string[],           // the batch (worklist ids just applied by warpsmith)
//   faction_ids: string[],           // factions touched by the batch
//   touched_files: string[],         // data files warpsmith edited
//   allowed_files: string[],         // normalized exact repo-relative paths
//   decision_kind: "data" | "data-conformance" | "new-shape" | "describer-reword" | "scoring-describer" | "sealed-campaign",
//   implementation_matrix?: object,  // required and complete for source changes
//   gates?: string[],                // fixed complete gate set; caller cannot weaken it
// }
// Run AFTER warpsmith applied the batch to the working tree and BEFORE the batch
// commit: cogitator's baseline "committed" diffs working tree vs jj-committed state.
// Returns { batch_id, skitarius, cogitator, psyker: [...] } — the driver interprets:
// !overall_pass, verdict:"regressed", or any severity-3 finding fails the batch.

// The runtime may deliver args as a JSON string — normalize before touching fields.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !Array.isArray(args.ability_ids) || !args.ability_ids.length) throw new Error('args.ability_ids required')
if (!Array.isArray(args.faction_ids) || !args.faction_ids.length) throw new Error('args.faction_ids required')
if (!Array.isArray(args.touched_files) || !args.touched_files.length) throw new Error('args.touched_files required')
if (!args.campaign_id || !args.batch_id || !args.campaign_manifest_sha256 || !args.candidate_commit_id)
  throw new Error('campaign_id, batch_id, campaign_manifest_sha256, and candidate_commit_id required')
if (!args.repo_root) throw new Error('args.repo_root required (workspace identity is enforced, not advisory)')
if (!Array.isArray(args.allowed_files) || !args.allowed_files.length) throw new Error('args.allowed_files required')
if (!['data', 'data-conformance', 'new-shape', 'describer-reword', 'scoring-describer', 'sealed-campaign'].includes(args.decision_kind))
  throw new Error('invalid args.decision_kind')
if (args.sealed_head !== (args.decision_kind === 'sealed-campaign'))
  throw new Error('sealed_head and decision_kind:sealed-campaign must be used together')
if (!args.expected_candidate_dsl_hashes || typeof args.expected_candidate_dsl_hashes !== 'object')
  throw new Error('expected_candidate_dsl_hashes required')
if (args.sealed_head && !args.campaign_base_commit_id)
  throw new Error('sealed verification requires campaign_base_commit_id')
if (!args.sealed_head && !args.baseline_commit_id)
  throw new Error('intermediate verification requires explicit baseline_commit_id')
if (args.allowed_files.some(path => path.endsWith('/') || path.startsWith('/') || path.split('/').includes('..')))
  throw new Error('allowed_files must contain normalized exact repo-relative paths, not prefixes')
const translateCommands = args.faction_ids.map(f =>
  `(cd tools && npx tsx src/cli.ts translate ${quoteForCommand(`../data/enrichment/${f}/abilities.json`)})`)
const FIXED_GATE_COMMANDS = {
  validate: 'cd tools && npm run validate',
  test: 'cd tools && npm test',
  'translate-smoke': translateCommands.join(' && '),
  drift: 'just verify-regen-stable',
  'format-lint': 'cargo fmt --all -- --check && test -z "$(gofmt -l go/)" && (cd python && ruff check .)',
  parity: 'cd tools && npm run codegen:data && npx tsc && cd .. && cargo build --release --bin wh40kdc-runner && ' +
    '(cd go && go build -o wh40kdc-runner ./cmd/wh40kdc-runner) && ' +
    'for pair in ts,rust ts,py rust,py ts,go rust,go py,go; do ' +
    'PATH="$PWD/python/.venv/bin:$PATH" python3 tooling/parity/differ.py --pair "$pair" --quiet; ' +
    'for area in effect-translation' + (['scoring-describer', 'sealed-campaign'].includes(args.decision_kind) ? ' scoring-translation' : '') + '; do ' +
    'out=$(mktemp); trap \'rm -f "$out"\' EXIT; PATH="$PWD/python/.venv/bin:$PATH" python3 tooling/parity/differ.py --pair "$pair" --area "$area" --json >"$out"; ' +
    'python3 - "$out" "$area" <<\'PY\'\nimport json,sys\np=json.load(open(sys.argv[1]))\na=sys.argv[2]\nskipped=p.get("skipped", [])\nif p.get("ok") is not True or not isinstance(p.get("cases_run"), int) or p["cases_run"] <= 0 or a in skipped:\n raise SystemExit(f"fail-closed parity proof for {a}: {p}")\nPY\n' +
    'rm -f "$out"; trap - EXIT; done; done',
}
const GATES = Object.keys(FIXED_GATE_COMMANDS)
if (args.gates && (args.gates.length !== GATES.length || GATES.some(g => !args.gates.includes(g))))
  throw new Error('campaign verification gates are fixed and cannot be weakened')
if (args.faction_ids.length > 1 && args.ability_ids.some(id => !id.includes('/')))
  throw new Error('multi-faction batches require faction/ability_id keys')
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`
function quoteForCommand(s) { return `'${String(s).replaceAll("'", "'\\''")}'` }
const ROLE_MANIFEST = ['arch-magos', 'chronomancer', 'cogitator', 'data-enginseer', 'eversor',
  'inquisitor', 'kroot-flesh-shaper', 'kroot-lone-spear', 'kroot-trail-shaper',
  'kroot-war-shaper', 'psyker', 'skitarius', 'swarmlord', 'target-dummy', 'vox-hound', 'warpsmith']
function resultText(v) {
  if (typeof v === 'string') return v
  if (!v) return ''
  if (typeof v.text === 'string') return v.text
  if (typeof v.output === 'string') return v.output
  if (typeof v.stdout === 'string') return v.stdout
  if (Array.isArray(v.content)) return v.content.map(x => typeof x === 'string' ? x : (x.text || '')).join('\n')
  return ''
}
const runAgent = (prompt, options) => agent(prompt, {
  ...options, model: 'openai-codex/gpt-5.6-luna', schemaMode: 'strict',
})
async function assertWorkspaceAndScope() {
  const root = quote(args.repo_root)
  const revision = args.sealed_head ? '@-' : '@'
  const check = await tool.bash({ command:
    `set -eu; expected=$(cd ${root} && pwd -P); ` +
    `test "$(pwd -P)" = "$expected"; test "$(jj root)" = "$expected"; ` +
    `test -f AGENTS.md; grep -q '40kdc-data' AGENTS.md; ` +
    `for role in ${ROLE_MANIFEST.map(quote).join(' ')}; do file=".omp/agents/$role.md"; ` +
    `test -f "$file"; model=$(sed -n 's/^model: //p' "$file"); test "$model" = "openai-codex/gpt-5.6-luna"; done; ` +
    `test "$(jj log -r ${revision} --no-graph -T 'commit_id')" = ${quote(args.candidate_commit_id)}; ` +
    (!args.sealed_head
      ? `test "$(jj log -r ${quote(args.baseline_commit_id)} --no-graph -T 'commit_id')" = ${quote(args.baseline_commit_id)}; ` +
        `test "$(jj log -r ${quote(args.candidate_commit_id)}- --no-graph -T 'commit_id')" = ${quote(args.baseline_commit_id)}; ` +
        `jj log -r ${quote(args.baseline_commit_id)}'::'${quote(args.candidate_commit_id)} --no-graph -T 'commit_id ++ "\\n"' | grep -Fxq ${quote(args.candidate_commit_id)}; `
      : '') +
    `printf '__DSL_WORKSPACE_OK__\\n'; printf '__DSL_CHANGED_BEGIN__\\n'; ` +
    (args.sealed_head
      ? `test "$(jj log -r ${quote(args.campaign_base_commit_id)} --no-graph -T 'commit_id')" = ${quote(args.campaign_base_commit_id)}; ` +
        `jj diff --name-only --from ${quote(args.campaign_base_commit_id)} --to @-; `
      : `jj diff --name-only -r ${revision}; `) +
    `printf '__DSL_CHANGED_END__\\n'`, timeout: 30 })
  const text = resultText(check)
  if (!text.includes('__DSL_WORKSPACE_OK__'))
    throw new Error(`workspace preflight failed: cwd and jj root must both equal ${args.repo_root}`)
  const match = text.match(/__DSL_CHANGED_BEGIN__\s*([\s\S]*?)\s*__DSL_CHANGED_END__/)
  if (!match) throw new Error('could not read jj changed-path inventory')
  const changed = match[1].split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const generated = path => path === 'tools/src/generated.ts' ||
    path.startsWith('crates/wh40kdc/schemas/') || path === 'crates/wh40kdc/src/generated.rs' ||
    path === 'crates/wh40kdc/src/data/bundle.generated.json' ||
    ['python/src/wh40kdc/_bundle.json', 'python/src/wh40kdc/_spec.py', 'python/src/wh40kdc/_types.py'].includes(path) ||
    path.startsWith('python/src/wh40kdc/schemas/') ||
    path.startsWith('go/') && ['bundle.json', 'share_registry.json', 'schemas/', 'spec.go'].some(x => path === `go/${x}` || path.startsWith(`go/${x}`))
  const dataPath = path => args.faction_ids.some(f => path === `data/enrichment/${f}/abilities.json`)
  const sourcePath = path => path.startsWith('schemas/enrichment/ability-dsl/') ||
    path.startsWith('tools/src/translate/') || path.startsWith('tools/src/cruncher/') ||
    path.startsWith('crates/wh40kdc/src/translate/') || path.startsWith('crates/wh40kdc/src/cruncher/') ||
    path.startsWith('python/src/wh40kdc/') || path.startsWith('go/translate_') ||
    path.startsWith('go/cruncher_') || path.startsWith('conformance/') ||
    ['conformance/SPEC_VERSION', 'tools/package.json', 'crates/wh40kdc/Cargo.toml',
      'python/src/wh40kdc/_version.py', 'go/version.go', 'Cargo.lock'].includes(path)
  const outsidePolicy = changed.filter(path => !dataPath(path) && !generated(path) && !sourcePath(path))
  if (outsidePolicy.length) throw new Error(`changed paths outside fixed campaign policy: ${outsidePolicy.join(', ')}`)
  const hasConformance = changed.some(path => path.startsWith('conformance/'))
  const scoringFiles = ['tools/src/translate/scoring.ts', 'python/src/wh40kdc/translate/scoring.py', 'go/translate_scoring.go']
  const derivedKind = scoringFiles.some(path => changed.includes(path)) ? 'scoring-describer'
    : hasConformance && changed.some(dataPath) ? 'data-conformance'
    : changed.some(path => !dataPath(path) && !generated(path)) ? 'source' : 'data'
  if (args.decision_kind !== 'sealed-campaign' &&
      (['data', 'data-conformance', 'scoring-describer'].includes(args.decision_kind) ? args.decision_kind : 'source') !== derivedKind)
    throw new Error(`decision_kind ${args.decision_kind} disagrees with diff-derived ${derivedKind}`)
  const allowed = path => args.allowed_files.includes(path)
  const unexpected = changed.filter(path => !allowed(path))
  if (unexpected.length) throw new Error(`changed paths outside warpsmith allowlist: ${unexpected.join(', ')}`)
  if (!changed.length) throw new Error('jj changed-path inventory is empty')
  const undeclared = (args.touched_files || []).filter(path => !changed.includes(path))
  if (undeclared.length) throw new Error(`declared touched paths absent from jj diff: ${undeclared.join(', ')}`)
  return { repo_root: args.repo_root, verified: true, role_manifest_verified: ROLE_MANIFEST,
    changed_files: changed, allowed_files: args.allowed_files, change_kind: derivedKind }
}
const workspace = await assertWorkspaceAndScope()
const PATH_FAMILIES = {
  data: p => args.faction_ids.some(f => p === `data/enrichment/${f}/abilities.json`),
  canonical_schema: p => /^schemas\/enrichment\/ability-dsl\/(ability|condition|effect|scope|trigger)\.schema\.json$/.test(p),
  typescript_describer: p => /^tools\/src\/translate\/(condition|effect|index)\.ts$/.test(p),
  rust_describer: p => /^crates\/wh40kdc\/src\/translate\/(effect|mod)\.rs$/.test(p),
  python_describer: p => /^python\/src\/wh40kdc\/translate\/(condition|effect|__init__)\.py$/.test(p),
  go_describer: p => /^go\/translate_(condition|effect)\.go$/.test(p),
  typescript_cruncher: p => p === 'tools/src/cruncher/from-dsl.ts',
  rust_cruncher: p => p === 'crates/wh40kdc/src/cruncher/buffs.rs',
  python_cruncher: p => p === 'python/src/wh40kdc/cruncher/from_dsl.py',
  go_cruncher: p => p === 'go/cruncher_from_dsl.go',
  conformance: p => p.startsWith('conformance/') && p !== 'conformance/SPEC_VERSION' &&
    !p.startsWith('conformance/scoring-translation/'),
  scoring_conformance: p => p.startsWith('conformance/scoring-translation/'),
  spec_version: p => ['conformance/SPEC_VERSION', 'python/src/wh40kdc/_spec.py', 'go/spec.go'].includes(p),
  generated_types: p => ['tools/src/generated.ts', 'crates/wh40kdc/src/generated.rs',
    'python/src/wh40kdc/_types.py'].includes(p),
  typescript_scoring_describer: p => p === 'tools/src/translate/scoring.ts',
  python_scoring_describer: p => p === 'python/src/wh40kdc/translate/scoring.py',
  go_scoring_describer: p => p === 'go/translate_scoring.go',
  embedded_schemas: p => p === 'crates/wh40kdc/schemas/bundled.schema.json' ||
    p.startsWith('python/src/wh40kdc/schemas/') || p.startsWith('go/schemas/'),
  rust_bundle: p => p === 'crates/wh40kdc/src/data/bundle.generated.json',
  python_bundle: p => p === 'python/src/wh40kdc/_bundle.json',
  go_bundle: p => p === 'go/bundle.json',
  version_lockstep: p => ['tools/package.json', 'crates/wh40kdc/Cargo.toml',
    'python/src/wh40kdc/_version.py', 'go/version.go', 'Cargo.lock'].includes(p),
}
const REQUIRED = {
  'new-shape': ['canonical_schema', 'typescript_describer', 'rust_describer', 'python_describer', 'go_describer',
    'typescript_cruncher', 'rust_cruncher', 'python_cruncher', 'go_cruncher', 'conformance', 'spec_version',
    'generated_types', 'embedded_schemas', 'rust_bundle', 'python_bundle', 'go_bundle',
    'version_lockstep', 'data'],
  'describer-reword': ['typescript_describer', 'rust_describer', 'python_describer', 'go_describer', 'conformance', 'spec_version'],
  'scoring-describer': ['typescript_scoring_describer', 'python_scoring_describer', 'go_scoring_describer',
    'scoring_conformance', 'spec_version'],
  data: ['data', 'rust_bundle', 'python_bundle', 'go_bundle'],
  'data-conformance': ['data', 'rust_bundle', 'python_bundle', 'go_bundle', 'conformance', 'spec_version'],
}
const EXACT_SURFACE_FILES = {
  data: args.decision_kind === 'sealed-campaign'
    ? workspace.changed_files.filter(path => PATH_FAMILIES.data(path))
    : args.faction_ids.map(f => `data/enrichment/${f}/abilities.json`),
  generated_types: ['tools/src/generated.ts', 'crates/wh40kdc/src/generated.rs',
    'python/src/wh40kdc/_types.py'],
  spec_version: ['conformance/SPEC_VERSION', 'python/src/wh40kdc/_spec.py', 'go/spec.go'],
  rust_bundle: ['crates/wh40kdc/src/data/bundle.generated.json'],
  python_bundle: ['python/src/wh40kdc/_bundle.json'],
  go_bundle: ['go/bundle.json'],
  version_lockstep: ['tools/package.json', 'crates/wh40kdc/Cargo.toml',
    'python/src/wh40kdc/_version.py', 'go/version.go', 'Cargo.lock'],
}
{
  const requiredForDecision = args.decision_kind === 'sealed-campaign'
    ? Object.keys(args.implementation_matrix || {}).filter(k => PATH_FAMILIES[k])
    : REQUIRED[args.decision_kind]
  if (!requiredForDecision.length) throw new Error('implementation matrix has no recognized decision surfaces')
  const missing = requiredForDecision.filter(k => !args.implementation_matrix ||
    !args.implementation_matrix[k] || args.implementation_matrix[k].required !== true ||
    !Array.isArray(args.implementation_matrix[k].files) || !args.implementation_matrix[k].files.length)
  if (missing.length) throw new Error(`source change has incomplete implementation matrix: ${missing.join(', ')}`)
  const changed = new Set(workspace.changed_files)
  const matrixFiles = requiredForDecision.flatMap(k => args.implementation_matrix[k].files.map(path => ({ k, path })))
  const invalid = matrixFiles.filter(({ k, path }) => typeof path !== 'string' || path.startsWith('/') ||
    path.endsWith('/') || path.split('/').includes('..') || !PATH_FAMILIES[k](path))
  if (invalid.length) throw new Error(`implementation matrix has invalid surface paths: ${invalid.map(x => `${x.k}:${x.path}`).join(', ')}`)
  const unbound = requiredForDecision.filter(k => !args.implementation_matrix[k].files.some(path => changed.has(path)))
  if (unbound.length) throw new Error(`implementation matrix rows do not intersect the actual diff: ${unbound.join(', ')}`)
  const incompleteExact = requiredForDecision.filter(k => EXACT_SURFACE_FILES[k]?.some(path =>
    !args.implementation_matrix[k].files.includes(path) || !changed.has(path)))
  if (incompleteExact.length)
    throw new Error(`implementation matrix omits required exact files: ${incompleteExact.join(', ')}`)
  if (requiredForDecision.includes('embedded_schemas')) {
    const schemaFiles = args.implementation_matrix.embedded_schemas.files
    if (!schemaFiles.some(p => p === 'crates/wh40kdc/schemas/bundled.schema.json') ||
        !schemaFiles.some(p => p.startsWith('python/src/wh40kdc/schemas/')) ||
        !schemaFiles.some(p => p.startsWith('go/schemas/')))
      throw new Error('embedded_schemas must include changed Rust, Python, and Go schema artifacts')
  }
  const declared = new Set(matrixFiles.map(x => x.path))
  const unclassified = workspace.changed_files.filter(path => !declared.has(path))
  if (unclassified.length) throw new Error(`changed paths not declared on an exact decision surface: ${unclassified.join(', ')}`)
}
const PRE = `Verified repo root: ${args.repo_root}; changed paths passed the warpsmith allowlist. ` +
  `Run every command there and report any requested gate that cannot run in not_run.\n`

async function runFixedGate(gate, command) {
  phase(`Gate: ${gate}`)
  const marker = `__DSL_FIXED_GATE_${gate.replaceAll('-', '_').toUpperCase()}_OK__`
  const result = await tool.bash({ command: `set -eu; ${command}; printf '${marker}\\n'`, timeout: 3600 })
  const text = resultText(result)
  const failed = typeof result === 'object' && result &&
    (result.hasError || result.details?.timedOut ||
      (result.details?.exitCode != null && result.details.exitCode !== 0) ||
      ('exitCode' in result && result.exitCode !== 0))
  if (failed || !text.includes(marker)) throw new Error(`fixed gate ${gate} failed: ${text.slice(-2000)}`)
  return { gate, command, pass: true, output_tail: text.slice(-2000) }
}
const machineGates = []
for (const gate of GATES) machineGates.push(await runFixedGate(gate, FIXED_GATE_COMMANDS[gate]))

// ---- frozen Output contracts, transcribed to JSON Schema (do not redesign) ----
const SKITARIUS_OUT = {
  type: 'object', required: ['gates_run', 'overall_pass', 'not_run'],
  properties: {
    gates_run: { type: 'array', items: { type: 'object', required: ['gate', 'command', 'pass'],
      properties: { gate: { type: 'string' }, command: { type: 'string' }, pass: { type: 'boolean' },
        failures: { type: 'array', items: { type: 'object', required: ['file', 'message'],
          properties: { file: { type: 'string' }, message: { type: 'string' } } } } } } },
    overall_pass: { type: 'boolean' },
    not_run: { type: 'array', items: { type: 'string' } },
  },
}
const COGITATOR_OUT = {
  type: 'object', required: ['abilities', 'levers_before', 'levers_after', 'regressions', 'additions', 'verdict'],
  properties: {
    abilities: { type: 'array', items: { type: 'object', required: ['faction_id', 'ability_id'],
      properties: { faction_id: { type: 'string' }, ability_id: { type: 'string' } } } },
    levers_before: { type: 'object', additionalProperties: true }, levers_after: { type: 'object', additionalProperties: true },
    regressions: { type: 'array', items: { type: 'object', required: ['faction_id', 'ability_id', 'lever', 'change'],
      properties: { faction_id: { type: 'string' }, ability_id: { type: 'string' }, lever: { type: 'string' }, change: { type: 'string' } } } },
    additions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    verdict: { enum: ['clean', 'regressed'] },
  },
}
const PSYKER_OUT = {
  type: 'object', required: ['faction_id', 'findings', 'clean'],
  properties: {
    faction_id: { type: 'string' },
    findings: { type: 'array', items: { type: 'object',
      required: ['ability_id', 'describer_output', 'problem', 'player_reading', 'severity'],
      properties: { ability_id: { type: 'string' }, describer_output: { type: 'string' },
        problem: { enum: ['ambiguous', 'misleading', 'ungrammatical', 'jargon-leak', 'missing-clause-signal'] },
        player_reading: { type: 'string' }, severity: { type: 'integer', minimum: 1, maximum: 3 } } } },
    clean: { type: 'array', items: { type: 'string' } },
  },
}

const idsByFaction = {}
for (const f of args.faction_ids) idsByFaction[f] = []
const requestedPairs = []
for (const id of args.ability_ids) {
  // shape-led batches span factions; ability ids arrive as "faction/ability_id" or bare
  const slash = id.indexOf('/')
  if (slash > 0) {
    const faction = id.slice(0, slash)
    const ability = id.slice(slash + 1)
    if (!idsByFaction[faction] || !ability) throw new Error(`unknown or malformed ability key: ${id}`)
    idsByFaction[faction].push(ability)
    requestedPairs.push({ faction_id: faction, ability_id: ability })
  } else {
    if (args.faction_ids.length !== 1) throw new Error('bare ability id is ambiguous in a multi-faction batch')
    idsByFaction[args.faction_ids[0]].push(id)
    requestedPairs.push({ faction_id: args.faction_ids[0], ability_id: id })
  }
}
const requestedPairKeys = new Set(requestedPairs.map(x => `${x.faction_id}/${x.ability_id}`))
if (requestedPairKeys.size !== requestedPairs.length) throw new Error('duplicate faction/ability request')
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}
const applied_dsl_hashes = {}
for (const [faction, ids] of Object.entries(idsByFaction)) {
  const rows = await Bun.file(`data/enrichment/${faction}/abilities.json`).json()
  for (const ability_id of ids) {
    const matches = rows.filter(row => row.ability_id === ability_id)
    const key = `${faction}/${ability_id}`
    if (matches.length !== 1) throw new Error(`applied ability lookup is not unique: ${key}`)
    applied_dsl_hashes[key] = new Bun.CryptoHasher('sha256').update(canonicalJson(matches[0])).digest('hex')
    if (args.expected_candidate_dsl_hashes[key] !== applied_dsl_hashes[key])
      throw new Error(`applied DSL hash differs from accepted author candidate: ${key}`)
  }
}
const expectedHashKeys = Object.keys(args.expected_candidate_dsl_hashes).sort()
if (expectedHashKeys.length !== requestedPairKeys.size || [...requestedPairKeys].sort().some((key, i) => key !== expectedHashKeys[i]))
  throw new Error('expected_candidate_dsl_hashes does not cover the exact requested faction/ability set')

const [skitarius, cogitator, ...psyker] = await parallel([
  () => runAgent(
    PRE + `Run exactly these mechanical gates in this workspace and report honestly (a gate you ` +
    `could not run goes in not_run, never in gates_run as passed). Input:\n` +
    JSON.stringify({ gates: GATES, machine_gate_artifacts: machineGates,
      touched: { factions: args.faction_ids, files: args.touched_files || [] } }),
    { agent: 'skitarius', schema: SKITARIUS_OUT, label: `gates:${args.batch_id}` }
  ),
  () => runAgent(
    PRE + `Diff cruncher levers for these abilities, working tree vs committed. Any dropped lever is a ` +
    `regression regardless of how much prettier the new phrasing reads. Input:\n` +
    JSON.stringify(args.sealed_head
      ? { abilities: requestedPairs, baseline_commit_id: args.campaign_base_commit_id,
          candidate_commit_id: args.candidate_commit_id }
      : { abilities: requestedPairs, baseline: 'committed',
          baseline_commit_id: args.baseline_commit_id,
          candidate_commit_id: args.candidate_commit_id }),
    { agent: 'cogitator', schema: COGITATOR_OUT, label: `levers:${args.batch_id}` }
  ),
  ...args.faction_ids.map(f => () =>
    runAgent(
      PRE + `Cold-read the describer renders for these just-edited abilities. Input:\n` +
      JSON.stringify({ faction_id: f, scope: idsByFaction[f] }),
      { agent: 'psyker', schema: PSYKER_OUT, label: `coldread:${f}:${args.batch_id}` }
    )
  ),
])

const psy = psyker.filter(Boolean)
const sev3 = psy.flatMap(p => (p.findings || []).filter(x => x.severity === 3))
const missingRoles = []
if (!skitarius) missingRoles.push('skitarius')
if (!cogitator) missingRoles.push('cogitator')
if (psy.length !== args.faction_ids.length) missingRoles.push('psyker')
if (missingRoles.length) throw new Error(`verification provenance incomplete: ${missingRoles.join(', ')}`)
const gateNames = skitarius.gates_run.map(g => g.gate)
const badGateSet = new Set(gateNames).size !== GATES.length || gateNames.length !== GATES.length ||
  GATES.some(g => !gateNames.includes(g)) || skitarius.gates_run.some(g => g.pass !== true ||
    g.command !== FIXED_GATE_COMMANDS[g.gate])
if (badGateSet) throw new Error('skitarius did not pass the exact fixed campaign gate set')
const cogitatorPairs = new Set(cogitator.abilities.map(x => `${x.faction_id}/${x.ability_id}`))
if (cogitatorPairs.size !== cogitator.abilities.length || cogitatorPairs.size !== requestedPairKeys.size ||
    [...requestedPairKeys].some(key => !cogitatorPairs.has(key)))
  throw new Error('cogitator result does not cover the exact requested faction/ability set')
const psykerFactions = new Set(psy.map(p => p.faction_id))
if (psykerFactions.size !== args.faction_ids.length || args.faction_ids.some(f => !psykerFactions.has(f)))
  throw new Error('psyker results do not cover the exact requested faction set')
for (const result of psy) {
  const reported = [...result.clean, ...result.findings.map(x => x.ability_id)]
  const actual = new Set(reported)
  const expected = new Set(idsByFaction[result.faction_id])
  if (actual.size !== reported.length || actual.size !== expected.size || [...expected].some(id => !actual.has(id)))
    throw new Error(`psyker result does not cover the exact requested abilities for ${result.faction_id}`)
}
const postWorkspace = await assertWorkspaceAndScope()
if (postWorkspace.changed_files.length !== workspace.changed_files.length ||
    postWorkspace.changed_files.some(path => !workspace.changed_files.includes(path)))
  throw new Error('verification gates created new tracked paths after the initial allowlist audit')
const notRun = skitarius.not_run || []
const pass = !badGateSet && skitarius.overall_pass === true && notRun.length === 0 &&
  cogitator.verdict === 'clean' && cogitator.regressions.length === 0 && sev3.length === 0
log(`verify ${args.batch_id}: gates=${skitarius ? (skitarius.overall_pass ? 'PASS' : 'FAIL') : 'ERROR'} ` +
  `levers=${cogitator ? cogitator.verdict : 'ERROR'} sev3=${sev3.length}`)
const payload = {
  batch_id: args.batch_id, pass, workspace, applied_dsl_hashes,
  machine_gates: machineGates, skitarius, cogitator, psyker: psy,
  provenance: { workflow: 'dsl-verify-batch', required_roles: ['skitarius', 'cogitator', 'psyker'] },
}
const ability_keys = requestedPairs.map(x => `${x.faction_id}/${x.ability_id}`).sort()
const payload_sha256 = new Bun.CryptoHasher('sha256').update(JSON.stringify(payload)).digest('hex')
return { binding: { kind: 'verify', campaign_id: args.campaign_id, batch_id: args.batch_id,
  campaign_manifest_sha256: args.campaign_manifest_sha256, ability_keys,
  candidate_commit_id: args.candidate_commit_id, candidate_dsl_hashes: applied_dsl_hashes,
  sealed_head: args.sealed_head === true, campaign_base_commit_id: args.campaign_base_commit_id || null,
  sealed_head_commit_id: args.sealed_head ? args.candidate_commit_id : null, payload_sha256 }, payload }
