export const meta = {
  name: 'dsl-prioritize',
  description: 'Scout shape families, then inquisitor curates the next campaign worklist',
  phases: [
    { title: 'Scout', detail: 'swarmlord family sweep per candidate shape (skipped when none)' },
    { title: 'Curate', detail: 'inquisitor picks the campaign from live signals' },
  ],
}

// args: {
//   repo_root: string,
//   campaign_id: string,
//   campaign_base_commit_id: string,  // immutable ancestor from which the campaign range starts
//   scout_shapes: [{ shape: {effect_type|condition_type|pattern, example_ability_id?}, exclude_factions?: [] }],
//   artifacts: {                       // paths + small excerpts the driver prepared
//     roundtrip_report_path,           // the fresh --faction all report (json)
//     roundtrip_report_sha256,         // hash captured when baseline was created
//     sub080_summary,                  // driver-computed: [{faction, mean, n_below, worst: [{id, cos}]}]
//     loop_state_paths,                // _private/loop-state/*.md in THIS workspace
//     registry_excerpt,                // campaigns[] statuses + blocked_shapes[] (dedup source)
//   },
//   worklist_cap: number,
// }
// Returns { scouts, curation }. The DRIVER materializes the worklist, writes the
// registry entry and roundtrip-<target>.md — no writes happen in this workflow.

// The runtime may deliver args as a JSON string — normalize before touching fields.
if (typeof args === 'string') args = JSON.parse(args)
if (!args || !args.artifacts) throw new Error('args.artifacts required')
if (!args.repo_root) throw new Error('args.repo_root required (workspace identity is enforced, not advisory)')
if (!args.campaign_id || !args.campaign_base_commit_id)
  throw new Error('args.campaign_id and args.campaign_base_commit_id required')
const CAP = args.worklist_cap || 30
if (CAP > 40) throw new Error(`worklist_cap ${CAP} exceeds the hard cap of 40`)
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
async function assertWorkspace() {
  const root = quote(args.repo_root)
  const check = await tool.bash({ command:
    `set -eu; expected=$(cd ${root} && pwd -P); ` +
    `test "$(pwd -P)" = "$expected"; test "$(jj root)" = "$expected"; ` +
    `test -f AGENTS.md; test -f .omp/skills/dsl-campaign/SKILL.md; ` +
    `for role in ${ROLE_MANIFEST.map(quote).join(' ')}; do file=".omp/agents/$role.md"; ` +
    `test -f "$file"; model=$(sed -n 's/^model: //p' "$file"); test "$model" = "openai-codex/gpt-5.6-luna"; done; ` +
    `base=$(jj log -r ${quote(args.campaign_base_commit_id)} --no-graph -T 'commit_id'); ` +
    `test "$base" = ${quote(args.campaign_base_commit_id)}; ` +
    `test "$(jj log -r ${quote(args.campaign_base_commit_id)}'::@' --no-graph -T 'commit_id ++ "\\n"' | tail -n 1)" != ""; ` +
    `jj log -r ${quote(args.campaign_base_commit_id)}'::@' --no-graph -T 'commit_id ++ "\\n"' | grep -Fxq "$(jj log -r @ --no-graph -T 'commit_id')"; ` +
    `grep -q '40kdc-data' AGENTS.md; printf '__DSL_WORKSPACE_OK__:%s\\n' "$expected"`, timeout: 20 })
  if (!resultText(check).includes('__DSL_WORKSPACE_OK__'))
    throw new Error(`workspace preflight failed: cwd and jj root must both equal ${args.repo_root}`)
  return { repo_root: args.repo_root, verified: true, role_manifest_verified: ROLE_MANIFEST }
}
const workspace = await assertWorkspace()
const reportPath = args.artifacts.roundtrip_report_path
if (!reportPath || !args.artifacts.roundtrip_report_sha256)
  throw new Error('fresh roundtrip report path + sha256 are required')
const reportFile = Bun.file(reportPath)
if (!(await reportFile.exists())) throw new Error(`roundtrip report not found: ${reportPath}`)
const reportHash = new Bun.CryptoHasher('sha256').update(new Uint8Array(await reportFile.arrayBuffer())).digest('hex')
if (reportHash !== args.artifacts.roundtrip_report_sha256)
  throw new Error('roundtrip report hash changed after baseline creation')
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
const baselineRows = extractRoundtripRows(await reportFile.json())
const baselineRowsSha256 = new Bun.CryptoHasher('sha256').update(JSON.stringify(baselineRows)).digest('hex')
const PRE = `Verified repo root: ${args.repo_root}. The workflow hard-checked that its cwd and jj root ` +
  `match this path. Run every command there; never read or write another checkout.\n`

// ---- frozen Output contracts, transcribed to JSON Schema (do not redesign) ----
const SWARMLORD_OUT = {
  type: 'object',
  required: ['shape', 'candidates', 'keyword_sweep_terms', 'sweep_counts', 'estimated_family_size'],
  properties: {
    shape: { type: 'object', additionalProperties: true },
    candidates: { type: 'array', items: { type: 'object',
      required: ['ability_id', 'faction', 'evidence', 'match_strength', 'already_authored', 'current_encoding'],
      properties: { ability_id: { type: 'string' }, faction: { type: 'string' }, evidence: { type: 'string' },
        match_strength: { enum: ['exact', 'near', 'stretch'] }, already_authored: { type: 'boolean' },
        current_encoding: { enum: ['empty-stub', 'opaque-grant', 'wrong-shape', 'none'] } } } },
    keyword_sweep_terms: { type: 'array', items: { type: 'string' } },
    sweep_counts: { type: 'object', additionalProperties: true },
    estimated_family_size: { type: 'integer' },
  },
}
const INQUISITOR_OUT = {
  type: 'object', required: ['mode', 'priorities'],
  properties: {
    mode: { enum: ['curate', 'review'] },
    priorities: { type: 'array', items: { type: 'object', required: ['target', 'faction_id', 'ability_id', 'cos_start', 'reason', 'expected_gain'],
      properties: { target: { type: 'string' }, faction_id: { type: 'string' }, ability_id: { type: 'string' },
        cos_start: { type: 'number' }, reason: { type: 'string' },
        expected_gain: { enum: ['fidelity', 'coverage', 'lever', 'schema-unblock'] } } } },
    reviews: { type: 'array', items: { type: 'object', additionalProperties: true } },
    inbox_updates: { type: 'array', items: { type: 'object', additionalProperties: true,
      required: ['mechanic', 'resists_schema', 'proposal', 'also_unblocks'] } },
    escalate_to_user: { type: 'array', items: { type: 'string' } },
  },
}

phase('Scout')
const scouts = (await parallel((args.scout_shapes || []).map(s => () =>
  runAgent(
    PRE + `Scout the cross-faction family for this shape. estimated_family_size counts exact+near only ` +
    `— stretches don't justify shapes. Input:\n` + JSON.stringify(s),
    { agent: 'swarmlord', schema: SWARMLORD_OUT,
      label: `scout:${s.shape.effect_type || s.shape.condition_type || s.shape.pattern}` }
  )
))).filter(Boolean)

phase('Curate')
const curation = await runAgent(
  PRE + `Curate the next campaign. Pick ONE coherent worklist chunk (≤ ${CAP} abilities) from the ` +
  `sub-0.80-cosine corpus: per-faction worst tail, a swarmlord family (exact+near, family size ≥ 4), ` +
  `or an inbox schema-unblock. Do not re-propose anything in registry blocked_shapes (its reopen_when ` +
  `must be met with the new evidence cited). No cherry-picking easy chunks — draw from the worst tail ` +
  `or a real family. Reserve escalate_to_user for genuine maintainer calls. Input:\n` +
  JSON.stringify({
    mode: 'curate',
    artifacts: {
      roundtrip_report_path: args.artifacts.roundtrip_report_path,
      sub080_summary: args.artifacts.sub080_summary,
      loop_state_paths: args.artifacts.loop_state_paths,
      registry_excerpt: args.artifacts.registry_excerpt,
      agent_outputs: scouts,
    },
  }),
  { agent: 'inquisitor', schema: INQUISITOR_OUT, label: 'curate' }
)
if (!curation) throw new Error('inquisitor returned nothing — cannot pick a campaign')
if (!curation.priorities.length) throw new Error('inquisitor returned an empty worklist')
if (curation.priorities.length > CAP)
  throw new Error(`inquisitor returned ${curation.priorities.length} priorities, above cap ${CAP}`)
const worklist = curation.priorities.map(x => ({ faction_id: x.faction_id, ability_id: x.ability_id, cos_start: x.cos_start }))
  .sort((a, b) => `${a.faction_id}/${a.ability_id}`.localeCompare(`${b.faction_id}/${b.ability_id}`))
const worklistKeys = new Set(worklist.map(x => `${x.faction_id}/${x.ability_id}`))
if (worklistKeys.size !== worklist.length || worklist.some(x => !x.faction_id || !x.ability_id || !Number.isFinite(x.cos_start)))
  throw new Error('inquisitor returned duplicate or incomplete faction/ability worklist rows')
for (const item of worklist) {
  if (item.cos_start >= 0.80)
    throw new Error(`curated target is not in the sub-0.80 corpus: ${item.faction_id}/${item.ability_id}`)
  const source = baselineRows.find(x => x.faction_id === item.faction_id && x.ability_id === item.ability_id)
  if (!source || source.cosine !== item.cos_start)
    throw new Error(`curated cos_start is not present in baseline report for ${item.faction_id}/${item.ability_id}`)
}
const campaignManifest = { campaign_id: args.campaign_id,
  campaign_base_commit_id: args.campaign_base_commit_id, baseline_sha256: reportHash,
  baseline_rows_sha256: baselineRowsSha256, worklist }
const campaignManifestJson = JSON.stringify(campaignManifest)
const campaignManifestSha256 = new Bun.CryptoHasher('sha256').update(campaignManifestJson).digest('hex')

log(`curated: ${curation.priorities.length} priorities, ${scouts.length} families scouted` +
  (curation.escalate_to_user && curation.escalate_to_user.length ? `, ${curation.escalate_to_user.length} escalation(s)` : ''))
return {
  scouts, curation, workspace,
  artifacts: { roundtrip_report_path: reportPath, roundtrip_report_sha256: reportHash },
  campaign_manifest: campaignManifest,
  campaign_manifest_json: campaignManifestJson,
  campaign_manifest_sha256: campaignManifestSha256,
  provenance: { workflow: 'dsl-prioritize', required_roles: ['swarmlord', 'inquisitor'] },
}
