export const meta = {
  name: 'dsl-review-batch',
  description: 'Strict inquisitor batch review with independently validated immutable evidence',
  phases: [{ title: 'Review', detail: 'inquisitor emits exactly one terminal review per requested key' }],
}

if (typeof args === 'string') args = JSON.parse(args)
if (!args?.repo_root || !args.campaign_id || !args.batch_id || !args.campaign_manifest_sha256 ||
    !args.candidate_commit_id || !args.candidate_dsl_hashes || !Array.isArray(args.faction_ids) ||
    !args.faction_ids.length || !Array.isArray(args.ability_keys) || !args.ability_keys.length)
  throw new Error('complete campaign/manifest/candidate/hash/faction/key binding required')
if (!args.author_artifact || !args.verify_artifact || !args.rescore_artifact || !args.agent_outputs)
  throw new Error('author, verify, rescore, and agent_outputs review evidence required')
const keys = [...args.ability_keys].sort()
if (new Set(keys).size !== keys.length || Object.keys(args.candidate_dsl_hashes).sort().some((x, i) => x !== keys[i]) ||
    Object.keys(args.candidate_dsl_hashes).length !== keys.length) throw new Error('candidate hashes must exactly cover keys')
const factions = new Set(args.faction_ids)
if (keys.some(key => !key.includes('/') || !factions.has(key.slice(0, key.indexOf('/')))))
  throw new Error('ability keys contain an undeclared faction')
const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
const hashBytes = bytes => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const hashCanonical = value => hashBytes(canonicalJson(value))
async function readHashed(ref, label) {
  if (!ref || typeof ref.path !== 'string' || typeof ref.sha256 !== 'string') throw new Error(`${label} artifact ref incomplete`)
  const file = Bun.file(ref.path)
  if (!(await file.exists())) throw new Error(`${label} artifact missing`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (hashBytes(bytes) !== ref.sha256) throw new Error(`${label} file hash mismatch`)
  return { json: JSON.parse(new TextDecoder().decode(bytes)), file_sha256: ref.sha256 }
}
function exactKeys(actual, label) {
  const sorted = [...(actual || [])].sort()
  if (sorted.length !== keys.length || new Set(sorted).size !== keys.length || sorted.some((x, i) => x !== keys[i]))
    throw new Error(`${label} keys mismatch`)
}
async function envelope(ref, kind) {
  const artifact = await readHashed(ref, kind)
  const { binding, payload } = artifact.json
  const phaseCommit = kind === 'author' ? 'author_candidate_commit_id' : 'candidate_commit_id'
  const expectedCommit = kind === 'author' ? ref.author_candidate_commit_id : args.candidate_commit_id
  if (!binding || binding.kind !== kind || binding.campaign_id !== args.campaign_id || binding.batch_id !== args.batch_id ||
      binding.campaign_manifest_sha256 !== args.campaign_manifest_sha256 || binding[phaseCommit] !== expectedCommit ||
      ref[phaseCommit] !== expectedCommit || binding.payload_sha256 !== ref.payload_sha256 ||
      binding.payload_sha256 !== hashBytes(JSON.stringify(payload))) throw new Error(`${kind} envelope binding mismatch`)
  exactKeys(binding.ability_keys, kind); exactKeys(ref.ability_keys, `${kind} ref`)
  if (canonicalJson(binding.candidate_dsl_hashes) !== canonicalJson(args.candidate_dsl_hashes))
    throw new Error(`${kind} candidate hashes mismatch`)
  return { payload, file_sha256: artifact.file_sha256, payload_sha256: binding.payload_sha256 }
}
const author = await envelope(args.author_artifact, 'author')
const verify = await envelope(args.verify_artifact, 'verify')
if (verify.payload.pass !== true) throw new Error('verification payload did not pass')
const rescore = await readHashed(args.rescore_artifact, 'rescore')
const rb = args.rescore_artifact.binding
if (!rb || rb.kind !== 'rescore' || rb.campaign_id !== args.campaign_id || rb.batch_id !== args.batch_id ||
    rb.campaign_manifest_sha256 !== args.campaign_manifest_sha256 || rb.candidate_commit_id !== args.candidate_commit_id ||
    rb.payload_sha256 !== rescore.file_sha256) throw new Error('rescore reference binding mismatch')
exactKeys(rb.ability_keys, 'rescore'); exactKeys(args.rescore_artifact.ability_keys || rb.ability_keys, 'rescore ref')
if (canonicalJson(rb.candidate_dsl_hashes) !== canonicalJson(args.candidate_dsl_hashes) ||
    canonicalJson(args.rescore_artifact.candidate_dsl_hashes || rb.candidate_dsl_hashes) !== canonicalJson(args.candidate_dsl_hashes))
  throw new Error('rescore candidate hashes mismatch')
if (rescore.json.kind !== 'roundtrip' || !Array.isArray(rescore.json.abilities) || !rescore.json.abilities.length)
  throw new Error('rescore is not a nonempty roundtrip report')
const scored = rescore.json.abilities.map(row => `${row.faction}/${row.ability_id}`).sort()
if (scored.length !== keys.length || scored.some((x, i) => x !== keys[i]) ||
    rescore.json.abilities.some(row => !Number.isFinite(row.score) || typeof row.english !== 'string'))
  throw new Error('rescore report does not exactly cover keys with actual roundtrip rows')
const evidence_digests = {
  author_file_sha256: author.file_sha256, author_payload_sha256: author.payload_sha256,
  verify_file_sha256: verify.file_sha256, verify_payload_sha256: verify.payload_sha256,
  rescore_file_sha256: rescore.file_sha256, agent_outputs_sha256: hashCanonical(args.agent_outputs),
}
const q = s => `'${String(s).replaceAll("'", "'\\''")}'`
async function assertWorkspace() {
  const check = await tool.bash({ command: `set -eu; expected=$(cd ${q(args.repo_root)} && pwd -P); ` +
    `test "$(pwd -P)" = "$expected"; test "$(jj root)" = "$expected"; ` +
    `test "$(jj log -r @ --no-graph -T 'commit_id')" = ${q(args.candidate_commit_id)}; ` +
    `test "$(sed -n 's/^model: //p' .omp/agents/inquisitor.md)" = openai-codex/gpt-5.6-luna`, timeout: 30 })
  if (check?.hasError || check?.details?.exitCode > 0 || check?.exitCode > 0) throw new Error('review workspace/candidate check failed')
}
await assertWorkspace()
const REVIEW_OUT = { type: 'object', additionalProperties: false, required: ['mode', 'reviews'], properties: {
  mode: { const: 'review' }, reviews: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['agent', 'faction_id', 'ability_id', 'verdict', 'required_changes'], properties: {
      agent: { type: 'string' }, faction_id: { type: 'string' }, ability_id: { type: 'string' },
      verdict: { enum: ['accept', 'revise', 'reject'] }, required_changes: { type: 'array', items: { type: 'string' } } } } } } }
phase('Review')
const review = await agent(`Perform mode:review over exactly these keys using only validated payloads. Input:\n` + JSON.stringify({
  mode: 'review', campaign_id: args.campaign_id, batch_id: args.batch_id, ability_keys: keys,
  candidate_commit_id: args.candidate_commit_id, candidate_dsl_hashes: args.candidate_dsl_hashes,
  author_payload: author.payload, verify_payload: verify.payload, rescore_report: rescore.json,
  agent_outputs: args.agent_outputs,
}), { agent: 'inquisitor', model: 'openai-codex/gpt-5.6-luna', schemaMode: 'strict', schema: REVIEW_OUT, label: `review:${args.batch_id}` })
if (!review) throw new Error('inquisitor returned nothing')
const reviewed = review.reviews.map(x => `${x.faction_id}/${x.ability_id}`).sort()
if (reviewed.length !== keys.length || new Set(reviewed).size !== keys.length || reviewed.some((x, i) => x !== keys[i]))
  throw new Error('review must have exactly one terminal row per key')
if (review.reviews.some(x => x.verdict === 'accept' && x.required_changes.length))
  throw new Error('accept review cannot contain required_changes')
await assertWorkspace()
const payload_sha256 = hashBytes(JSON.stringify(review))
return { binding: { kind: 'review', campaign_id: args.campaign_id, batch_id: args.batch_id,
  campaign_manifest_sha256: args.campaign_manifest_sha256, ability_keys: keys,
  faction_ids: [...args.faction_ids].sort(), candidate_commit_id: args.candidate_commit_id,
  candidate_dsl_hashes: args.candidate_dsl_hashes, evidence_digests, payload_sha256 }, payload: review }
