import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256 } from './canonical.js'
import { INTAKE_KEYS } from './intake.js'

export function intakeManifest(repoRoot) {
  return {
    schema_version: 1,
    entries: INTAKE_KEYS.map(key => {
      const [faction_id, ability_id] = key.split('/')
      const dsl_path = `data/enrichment/${faction_id}/abilities.json`
      const records = JSON.parse(readFileSync(join(repoRoot, dsl_path), 'utf8'))
      const ability = records.find(record => (record.ability_id ?? record.id) === ability_id)
      if (!ability) throw new Error(`fixture ability missing: ${key}`)
      return { faction_id, ability_id, dsl_path, dsl_hash: sha256(JSON.stringify(ability)) }
    }),
  }
}

export function legacyFixture(root) {
  const campaigns = [
    { id: 'c005', kind: 'dsl-campaign', target: 'fixture', status: 'completed', worklist_size: 9, started: null, finished: null },
    { id: 'c007', kind: 'dsl-campaign', target: 'fixture', status: 'aborted', worklist_size: 4, started: null, finished: null },
    { id: 'c008', kind: 'dsl-campaign', target: 'fixture', status: 'aborted', worklist_size: 4, started: null, finished: null },
    { id: 'c009', kind: 'dsl-campaign', target: 'fixture', status: 'open', worklist_size: 6, started: null, finished: null },
  ]
  const c005Keys = ['aeldari/far-reaching-doom', ...INTAKE_KEYS.filter(key => key !== 'necrons/power-matrix').slice(0, 8)]
  const ability_ledger = Object.fromEntries(c005Keys.map(key => [
    key,
    { campaign: 'c005', status: 'completed', cos_start: 0, cos_best: 1, attempts: 1 },
  ]))
  const registryPath = join(root, 'registry.json')
  writeFileSync(registryPath, `${JSON.stringify({ campaigns, ability_ledger, escalations: [], blocked_shapes: [] }, null, 2)}\n`)
  const loopStateRoot = join(root, 'loop-state')
  mkdirSync(loopStateRoot, { recursive: true })
  writeFileSync(join(loopStateRoot, 'roundtrip-necrons-power-matrix.md'), canonicalJson({ fixture: 'region' }))
  writeFileSync(join(loopStateRoot, 'roundtrip-c009-shapes.md'), canonicalJson({ fixture: 'visibility' }))
  return { registryPath, loopStateRoot }
}
