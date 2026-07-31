export const meta = {
  name: 'dsl-close-campaign',
  description: 'Artifact-gated campaign closure: terminal ledger, CI-equivalent preflight, six-pair parity, prose drift, and inquisitor close review',
  phases: [
    { title: 'Inventory', detail: 'workspace/head identity + terminal artifact ledger' },
    { title: 'Preflight', detail: 'jj-compatible full local CI mirror' },
    { title: 'Parity', detail: 'fresh runners + all six implementation pairs' },
    { title: 'Drift', detail: 'normalized whole-corpus prose-diff artifact' },
    { title: 'Review', detail: 'inquisitor checks all ten anti-conditions' },
  ],
}

// args: {
//   repo_root: string,
//   campaign_id: string,
//   expected_head_commit_id: string, // @- after sealing the completed stack with jj new
//   campaign_manifest_path: string,  // frozen manifest from prioritization/materialization
//   campaign_manifest_sha256: string,
//   worklist: [{ ability_id, faction_id, status, cos_start, cos_best, attempts,
//                justification?, artifacts: { author, verify, review, rescore } }],
//   faction_means: [{ faction_id, mean_before, mean_after }],
//   final_verification: artifact reference covering every converged/improved pair,
//   prose_diff_path: string,         // normalized artifact described below
//   baseline_report_path: string,
//   current_report_path: string,
// }
//
// prose_diff_path JSON:
// { baseline_sha256, current_sha256, changes:[{ability_id,faction_id}],
//   non_worklist_changes:[], generated_at }
//
// The driver may create/push a bookmark and PR only when ready_to_publish === true.

if (typeof args === 'string') args = JSON.parse(args)
if (!args || !args.repo_root || !args.campaign_id) throw new Error('repo_root and campaign_id required')
if (!args.expected_head_commit_id) throw new Error('expected_head_commit_id required')
if (!Array.isArray(args.worklist) || !args.worklist.length) throw new Error('non-empty worklist required')
if (args.worklist.length > 40) throw new Error('worklist exceeds hard campaign cap of 40')

const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`
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
async function runChecked(label, command, timeout) {
  phase(label)
  const marker = `__DSL_GATE_${label.toUpperCase()}_OK__`
  const result = await tool.bash({ command: `set -eu; ${command}; printf '${marker}\\n'`, timeout })
  const failed = typeof result === 'object' && result &&
    (result.hasError || result.details?.timedOut ||
      (result.details?.exitCode != null && result.details.exitCode !== 0) ||
      ('exitCode' in result && result.exitCode !== 0))
  if (failed || !resultText(result).includes(marker)) throw new Error(`${label} failed: ${resultText(result)}`)
  return { label, pass: true, output_tail: resultText(result).slice(-2000) }
}
async function fileHash(path) {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`artifact not found: ${path}`)
  return new Bun.CryptoHasher('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex')
}
async function verifyArtifact(ref, label, kind, expectedKeys, expectedCommit, expectedBatch) {
  if (!ref || typeof ref.path !== 'string' || typeof ref.sha256 !== 'string' ||
      (kind === 'author' ? ref.author_candidate_commit_id : ref.candidate_commit_id) !== expectedCommit || ref.batch_id !== expectedBatch ||
      !Array.isArray(ref.ability_keys))
    throw new Error(`${label} artifact reference is incomplete or misbound`)
  const actual = await fileHash(ref.path)
  if (actual !== ref.sha256) throw new Error(`${label} artifact hash mismatch`)
  const envelope = await Bun.file(ref.path).json()
  const binding = envelope.binding
  const payloadHash = new Bun.CryptoHasher('sha256').update(JSON.stringify(envelope.payload)).digest('hex')
  const keys = [...(binding?.ability_keys || [])].sort()
  if (!binding || binding.kind !== kind || binding.campaign_id !== args.campaign_id ||
      binding.batch_id !== expectedBatch ||
      binding.campaign_manifest_sha256 !== args.campaign_manifest_sha256 ||
      (kind === 'author' ? binding.author_candidate_commit_id : binding.candidate_commit_id) !== expectedCommit ||
      binding.payload_sha256 !== payloadHash || binding.payload_sha256 !== ref.payload_sha256 ||
      keys.length !== expectedKeys.length || expectedKeys.some((key, i) => key !== keys[i]) ||
      ref.ability_keys.length !== keys.length || [...ref.ability_keys].sort().some((key, i) => key !== keys[i]))
    throw new Error(`${label} artifact envelope binding mismatch`)
  return envelope.payload
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}
const sha256Canonical = value => new Bun.CryptoHasher('sha256').update(canonicalJson(value)).digest('hex')
function extractRoundtripRows(report) {
  if (!report || report.kind !== 'roundtrip' || !Array.isArray(report.abilities))
    throw new Error('expected a kind:roundtrip report with abilities[]')
  const rows = report.abilities.map(row => {
    if (typeof row.ability_id !== 'string' || typeof row.faction !== 'string' ||
        !Number.isFinite(row.score) || typeof row.english !== 'string')
      throw new Error('roundtrip ability row lacks ability_id, faction, score, or english')
    return { faction_id: row.faction, ability_id: row.ability_id, cosine: row.score,
      describer_sha256: new Bun.CryptoHasher('sha256').update(row.english).digest('hex') }
  })
  rows.sort((a, b) => `${a.faction_id}/${a.ability_id}`.localeCompare(`${b.faction_id}/${b.ability_id}`))
  const keys = new Set(rows.map(x => `${x.faction_id}/${x.ability_id}`))
  if (!rows.length || keys.size !== rows.length) throw new Error('roundtrip report has no unique scored/rendered ability rows')
  return rows
}
async function assertSealedHead() {
  const root = quote(args.repo_root)
  const result = await tool.bash({ command:
    `set -eu; expected=$(cd ${root} && pwd -P); ` +
    `test "$(pwd -P)" = "$expected"; test "$(jj root)" = "$expected"; ` +
    `test -z "$(jj diff --summary -r @)"; ` +
    `test "$(jj log -r @ --no-graph -T 'conflict')" = "false"; ` +
    `test "$(jj log -r @- --no-graph -T 'conflict')" = "false"; ` +
    `head=$(jj log -r @- --no-graph -T 'commit_id'); test "$head" = ${quote(args.expected_head_commit_id)}; ` +
    `for role in ${ROLE_MANIFEST.map(quote).join(' ')}; do file=".omp/agents/$role.md"; ` +
    `test -f "$file"; model=$(sed -n 's/^model: //p' "$file"); test "$model" = "openai-codex/gpt-5.6-luna"; done; ` +
    `test -f AGENTS.md; grep -q '40kdc-data' AGENTS.md; printf '__DSL_CLOSE_IDENTITY_OK__\\n'`, timeout: 30 })
  if (!resultText(result).includes('__DSL_CLOSE_IDENTITY_OK__'))
    throw new Error('close identity failed: candidate/child must be clean, conflict-free, and pinned to the expected full commit id')
}

phase('Inventory')
await assertSealedHead()

if (!args.campaign_manifest_path || !args.campaign_manifest_sha256)
  throw new Error('campaign manifest path + sha256 required')
if (await fileHash(args.campaign_manifest_path) !== args.campaign_manifest_sha256)
  throw new Error('campaign manifest hash mismatch')
const manifest = await Bun.file(args.campaign_manifest_path).json()
if (manifest.campaign_id !== args.campaign_id || !manifest.campaign_base_commit_id ||
    !Array.isArray(manifest.worklist) || !manifest.worklist.length)
  throw new Error('invalid campaign manifest')
{
  const relation = await tool.bash({ command:
    `set -eu; test "$(jj log -r ${quote(manifest.campaign_base_commit_id)} --no-graph -T 'commit_id')" = ` +
    `${quote(manifest.campaign_base_commit_id)}; ` +
    `jj log -r ${quote(manifest.campaign_base_commit_id)}'::'${quote(args.expected_head_commit_id)} ` +
    `--no-graph -T 'commit_id ++ "\\n"' | grep -Fxq ${quote(args.expected_head_commit_id)}; ` +
    `printf '__DSL_BASE_HEAD_OK__\\n'`, timeout: 30 })
  if (!resultText(relation).includes('__DSL_BASE_HEAD_OK__'))
    throw new Error('frozen campaign base is not an ancestor of the sealed head')
}

const terminal = new Set(['converged', 'improved', 'needs-schema', 'abandoned'])
const keys = new Set()
const completedKeys = []
for (const item of args.worklist) {
  const key = `${item.faction_id}/${item.ability_id}`
  if (keys.has(key)) throw new Error(`duplicate worklist entry: ${key}`)
  keys.add(key)
  if (!terminal.has(item.status)) throw new Error(`non-terminal worklist entry: ${key} (${item.status})`)
  if (!Number.isFinite(item.cos_start) || !Number.isFinite(item.cos_best))
    throw new Error(`missing score artifact for ${key}`)
  if (!Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > 4)
    throw new Error(`invalid attempt count for ${key}`)
  if (item.cos_best < item.cos_start && !item.justification)
    throw new Error(`unjustified cosine drop for ${key}`)
  if ((item.status === 'converged' || item.status === 'improved')) {
    if (!item.batch_id || !item.candidate_commit_id || !item.author_candidate_commit_id || !item.candidate_dsl_sha256)
      throw new Error(`batch/commit/DSL-hash binding missing for ${key}`)
    completedKeys.push(key)
    const required = ['author', 'verify', 'review', 'rescore']
    const missing = required.filter(k => !item.artifacts || !item.artifacts[k])
    if (missing.length) throw new Error(`completion artifacts missing for ${key}: ${missing.join(', ')}`)
    const evidence = {}
    for (const kind of ['author', 'verify', 'review']) {
      const artifactKeys = [...(item.artifacts[kind].ability_keys || [])].sort()
      if (!artifactKeys.includes(key)) throw new Error(`${key}:${kind} reference omits its ability key`)
      const artifactCommit = kind === 'author' ? item.author_candidate_commit_id : item.candidate_commit_id
      evidence[kind] = await verifyArtifact(item.artifacts[kind], `${key}:${kind}`, kind,
        artifactKeys, artifactCommit, item.batch_id)
    }
    const rescoreRef = item.artifacts.rescore
    if (!rescoreRef?.binding || await fileHash(rescoreRef.path) !== rescoreRef.sha256)
      throw new Error(`rescore artifact reference invalid for ${key}`)
    const rb = rescoreRef.binding
    if (rb.kind !== 'rescore' || rb.campaign_id !== args.campaign_id || rb.batch_id !== item.batch_id ||
        rb.campaign_manifest_sha256 !== args.campaign_manifest_sha256 ||
        rb.candidate_commit_id !== item.candidate_commit_id || rb.payload_sha256 !== rescoreRef.sha256 ||
        JSON.stringify(rb.ability_keys) !== JSON.stringify([key]))
      throw new Error(`rescore artifact binding mismatch for ${key}`)
    const rescoreRows = extractRoundtripRows(await Bun.file(rescoreRef.path).json())
      .filter(x => x.faction_id === item.faction_id && x.ability_id === item.ability_id)
    if (rescoreRows.length !== 1 || rescoreRows[0].cosine !== item.cos_best)
      throw new Error(`rescore report does not contain exactly one matching score for ${key}`)
    const authorRow = (evidence.author.results || []).find(r =>
      r.ability?.ability_id === item.ability_id && r.ability?.faction_id === item.faction_id)
    if (!authorRow || authorRow.status !== 'accepted') throw new Error(`author artifact does not accept ${key}`)
    const authorEnvelope = await Bun.file(item.artifacts.author.path).json()
    const verifyEnvelope = await Bun.file(item.artifacts.verify.path).json()
    const reviewEnvelope = await Bun.file(item.artifacts.review.path).json()
    const expectedReviewDigests = {
      author_file_sha256: item.artifacts.author.sha256,
      author_payload_sha256: item.artifacts.author.payload_sha256,
      verify_file_sha256: item.artifacts.verify.sha256,
      verify_payload_sha256: item.artifacts.verify.payload_sha256,
      rescore_file_sha256: item.artifacts.rescore.sha256,
      agent_outputs_sha256: item.artifacts.review.agent_outputs_sha256,
    }
    if (!expectedReviewDigests.agent_outputs_sha256 ||
        canonicalJson(reviewEnvelope.binding.evidence_digests) !== canonicalJson(expectedReviewDigests))
      throw new Error(`review evidence digests do not match ledger artifact references for ${key}`)
    const authorHash = authorEnvelope.binding.candidate_dsl_hashes?.[key]
    const verifyHash = verifyEnvelope.binding.candidate_dsl_hashes?.[key]
    const reviewHash = reviewEnvelope.binding.candidate_dsl_hashes?.[key]
    const appliedRows = await Bun.file(`data/enrichment/${item.faction_id}/abilities.json`).json()
    const applied = appliedRows.filter(row => row.ability_id === item.ability_id)
    const appliedHash = applied.length === 1 ? sha256Canonical(applied[0]) : null
    if (!authorHash || authorHash !== verifyHash || authorHash !== reviewHash ||
        authorHash !== item.candidate_dsl_sha256 || authorHash !== appliedHash)
      throw new Error(`author/verify/review/ledger/applied DSL hashes disagree for ${key}`)
    if (evidence.verify.pass !== true || !(evidence.verify.cogitator?.abilities || []).some(x =>
      x.ability_id === item.ability_id && x.faction_id === item.faction_id))
      throw new Error(`verification artifact does not pass ${key}`)
    const terminalReviews = (evidence.review.reviews || []).filter(x =>
      x.ability_id === item.ability_id && x.faction_id === item.faction_id)
    if (terminalReviews.length !== 1 || terminalReviews[0].verdict !== 'accept')
      throw new Error(`review artifact does not accept ${key}`)
  } else if (item.status === 'needs-schema') {
    if (!item.reason || !item.author_candidate_commit_id || !item.artifacts?.author || !item.artifacts?.inbox)
      throw new Error(`needs-schema terminal evidence missing for ${key}`)
    const authorKeys = [...(item.artifacts.author.ability_keys || [])].sort()
    const author = await verifyArtifact(item.artifacts.author, `${key}:author`, 'author', authorKeys,
      item.author_candidate_commit_id, item.batch_id)
    const inboxKeys = [...(item.artifacts.inbox.ability_keys || [])].sort()
    const inbox = await verifyArtifact(item.artifacts.inbox, `${key}:inbox`, 'inbox', inboxKeys,
      item.candidate_commit_id, item.batch_id)
    if (!authorKeys.includes(key) || !inboxKeys.includes(key)) throw new Error(`needs-schema batch artifacts omit ${key}`)
    if (!(author.results || []).some(r => r.ability?.ability_id === item.ability_id &&
      r.ability?.faction_id === item.faction_id && r.status === 'needs-schema') ||
      !(inbox.entries || []).some(x => x.ability_id === item.ability_id && x.faction_id === item.faction_id && x.resisted_schema))
      throw new Error(`needs-schema artifacts do not bind ${key}`)
  } else if (item.status === 'abandoned') {
    if (!item.reason || !item.author_candidate_commit_id || !item.artifacts?.author)
      throw new Error(`abandonment author/reason missing for ${key}`)
    const authorKeys = [...(item.artifacts.author.ability_keys || [])].sort()
    const author = await verifyArtifact(item.artifacts.author, `${key}:author`, 'author', authorKeys,
      item.author_candidate_commit_id, item.batch_id)
    const authorRows = (author.results || []).filter(r => r.ability?.ability_id === item.ability_id &&
      r.ability?.faction_id === item.faction_id)
    if (authorRows.length !== 1 || !['rejected', 'no-prose', 'agent-error'].includes(authorRows[0].status))
      throw new Error(`abandonment author status is not exactly rejected/no-prose/agent-error for ${key}`)
  }
}
const manifestKeys = new Set(manifest.worklist.map(x => `${x.faction_id}/${x.ability_id}`))
if (manifestKeys.size !== manifest.worklist.length || manifestKeys.size !== keys.size ||
    [...manifestKeys].some(key => !keys.has(key)))
  throw new Error('close worklist does not exactly match the frozen campaign manifest')
for (const frozen of manifest.worklist) {
  const item = args.worklist.find(x => x.faction_id === frozen.faction_id && x.ability_id === frozen.ability_id)
  if (item.cos_start !== frozen.cos_start) throw new Error(`cos_start differs from frozen manifest for ${frozen.faction_id}/${frozen.ability_id}`)
}
if (!args.final_verification) throw new Error('final sealed-head verification artifact required')
const finalVerification = await verifyArtifact(args.final_verification, 'final verification', 'verify',
  completedKeys.sort(), args.expected_head_commit_id, args.final_verification.batch_id)
if (finalVerification.pass !== true) throw new Error('final sealed-head verification did not pass')
const finalEnvelope = await Bun.file(args.final_verification.path).json()
if (finalEnvelope.binding.sealed_head !== true ||
    finalEnvelope.binding.campaign_base_commit_id !== manifest.campaign_base_commit_id ||
    finalEnvelope.binding.sealed_head_commit_id !== args.expected_head_commit_id)
  throw new Error('final verification is not bound to the frozen base and sealed head')

const preflight = await runChecked('Preflight',
  `PATH="$PWD/python/.venv/bin:$PATH" just preflight`, 3600)
const parity = await runChecked('Parity',
  `set -eu; cd tools && npm run codegen:data && npx tsc; cd ..; ` +
  `cargo build --release --bin wh40kdc-runner; ` +
  `(cd go && go build -o wh40kdc-runner ./cmd/wh40kdc-runner); ` +
  `for pair in ts,rust ts,py rust,py ts,go rust,go py,go; do ` +
  `PATH="$PWD/python/.venv/bin:$PATH" python3 tooling/parity/differ.py --pair "$pair" --quiet; ` +
  `out=$(mktemp); trap 'rm -f "$out"' EXIT; ` +
  `for area in effect-translation scoring-translation; do ` +
  `PATH="$PWD/python/.venv/bin:$PATH" python3 tooling/parity/differ.py --pair "$pair" --area "$area" --json >"$out"; ` +
  `python3 - "$out" "$area" <<'PY'\nimport json,sys\np=json.load(open(sys.argv[1])); a=sys.argv[2]\nif p.get("ok") is not True or not isinstance(p.get("cases_run"),int) or p["cases_run"] <= 0 or a in p.get("skipped",[]): raise SystemExit(f"fail-closed parity for {a}: {p}")\nPY\n` +
  `done; rm -f "$out"; trap - EXIT; done`, 3600)
await assertSealedHead()

phase('Drift')
if (!args.prose_diff_path) throw new Error('prose_diff_path required')
if (!args.baseline_report_path || !args.current_report_path)
  throw new Error('baseline_report_path and current_report_path required')
const driftFile = Bun.file(args.prose_diff_path)
if (!(await driftFile.exists())) throw new Error(`prose diff artifact not found: ${args.prose_diff_path}`)
const drift = await driftFile.json()
if (!drift.baseline_sha256 || !drift.current_sha256 || !Array.isArray(drift.changes) ||
    !Array.isArray(drift.non_worklist_changes))
  throw new Error('invalid normalized prose-diff artifact')
if (await fileHash(args.baseline_report_path) !== drift.baseline_sha256 ||
    await fileHash(args.current_report_path) !== drift.current_sha256)
  throw new Error('prose-diff hashes are not bound to the supplied roundtrip reports')
if (manifest.baseline_sha256 !== drift.baseline_sha256)
  throw new Error('prose baseline does not match the frozen campaign manifest')
const baselineRows = extractRoundtripRows(await Bun.file(args.baseline_report_path).json())
const currentRows = extractRoundtripRows(await Bun.file(args.current_report_path).json())
const baselineRowsHash = new Bun.CryptoHasher('sha256').update(JSON.stringify(baselineRows)).digest('hex')
if (baselineRowsHash !== manifest.baseline_rows_sha256) throw new Error('parsed baseline rows differ from frozen manifest')
const baselineByKey = new Map(baselineRows.map(x => [`${x.faction_id}/${x.ability_id}`, x]))
const currentByKey = new Map(currentRows.map(x => [`${x.faction_id}/${x.ability_id}`, x]))
const allReportKeys = new Set([...baselineByKey.keys(), ...currentByKey.keys()])
const derivedChanges = [...allReportKeys].filter(key =>
  baselineByKey.get(key)?.describer_sha256 !== currentByKey.get(key)?.describer_sha256)
  .map(key => { const [faction_id, ...id] = key.split('/'); return { faction_id, ability_id: id.join('/') } })
const derivedKeys = new Set(derivedChanges.map(x => `${x.faction_id}/${x.ability_id}`))
const suppliedKeys = new Set(drift.changes.map(x => `${x.faction_id}/${x.ability_id}`))
if (derivedKeys.size !== suppliedKeys.size || [...derivedKeys].some(key => !suppliedKeys.has(key)))
  throw new Error('normalized prose diff does not match report-derived describer changes')
const nonWorklist = derivedChanges.filter(c => !keys.has(`${c.faction_id}/${c.ability_id}`))
if (nonWorklist.length || drift.non_worklist_changes.length)
  throw new Error(`non-worklist describer drift: ${JSON.stringify(nonWorklist)}`)
for (const item of args.worklist) {
  const current = currentByKey.get(`${item.faction_id}/${item.ability_id}`)
  if (!current || current.cosine !== item.cos_best)
    throw new Error(`current roundtrip score does not equal cos_best for ${item.faction_id}/${item.ability_id}`)
}
const targetFactions = [...new Set(manifest.worklist.map(x => x.faction_id))].sort()
if (!Array.isArray(args.faction_means) || args.faction_means.length !== targetFactions.length)
  throw new Error('one faction_means row is required per target faction')
for (const faction_id of targetFactions) {
  const beforeRows = baselineRows.filter(x => x.faction_id === faction_id)
  const afterRows = currentRows.filter(x => x.faction_id === faction_id)
  if (!beforeRows.length || !afterRows.length) throw new Error(`roundtrip report lacks target faction ${faction_id}`)
  const before = beforeRows.reduce((n, x) => n + x.cosine, 0) / beforeRows.length
  const after = afterRows.reduce((n, x) => n + x.cosine, 0) / afterRows.length
  const supplied = args.faction_means.filter(x => x.faction_id === faction_id)
  if (supplied.length !== 1 || Math.abs(supplied[0].mean_before - before) > 1e-12 ||
      Math.abs(supplied[0].mean_after - after) > 1e-12)
    throw new Error(`caller-supplied mean does not match reports for ${faction_id}`)
  if (after < before) throw new Error(`target faction mean regressed: ${faction_id}`)
}
const driftHash = new Bun.CryptoHasher('sha256').update(new Uint8Array(await driftFile.arrayBuffer())).digest('hex')

const CLOSE_OUT = {
  type: 'object',
  required: ['mode', 'decision', 'anti_conditions', 'required_changes'],
  properties: {
    mode: { const: 'close' },
    decision: { enum: ['accept', 'revise', 'reject'] },
    anti_conditions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'pass', 'evidence'],
        properties: {
          id: { type: 'integer', minimum: 1, maximum: 10 },
          pass: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    required_changes: { type: 'array', items: { type: 'string' } },
  },
};
phase('Review')
const closeReview = await runAgent(
  `Repo root ${args.repo_root} was hard-verified. Perform the campaign-wide close review. ` +
  `Check each of the ten anti-conditions against these machine-verified artifacts; do not ` +
  `accept unless all ten have one passing evidence row. Input:\n` + JSON.stringify({
    mode: 'close', campaign_id: args.campaign_id, worklist: args.worklist,
    faction_means: args.faction_means,
    gates: { preflight, parity }, prose_diff: { ...drift, artifact_sha256: driftHash },
  }),
  { agent: 'inquisitor', schema: CLOSE_OUT, label: `close:${args.campaign_id}` }
)
if (!closeReview) throw new Error('inquisitor close review returned nothing')
const antiIds = new Set(closeReview.anti_conditions.filter(x => x.pass).map(x => x.id))
const exactAnti = closeReview.anti_conditions.length === 10 && antiIds.size === 10 &&
  closeReview.anti_conditions.every(x => x.pass && x.evidence.trim())
if (closeReview.decision !== 'accept' || closeReview.required_changes.length || !exactAnti)
  throw new Error(`campaign close rejected: ${closeReview.required_changes.join('; ') || 'anti-condition evidence incomplete'}`)
await assertSealedHead()

return {
  campaign_id: args.campaign_id,
  ready_to_publish: true,
  publish_commit_id: args.expected_head_commit_id,
  worklist_size: args.worklist.length,
  terminal_counts: args.worklist.reduce((out, x) => ({ ...out, [x.status]: (out[x.status] || 0) + 1 }), {}),
  gates: { preflight, parity },
  prose_diff: { path: args.prose_diff_path, sha256: driftHash, changed: drift.changes.length },
  close_review: closeReview,
  provenance: { workflow: 'dsl-close-campaign', required_roles: ['inquisitor'] },
}
