import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const workflow = readFileSync(new URL('./wf-verify-batch.js', import.meta.url), 'utf8')

describe('dsl verify batch drift gate', () => {
  test('requires pre/post generated-artifact idempotence instead of cleanliness', () => {
    assert.match(workflow, /mode: 'regen-idempotence'/)
    assert.match(workflow, /Before regeneration, capture each relevant generated artifact checksum/)
    assert.match(workflow, /After regeneration, capture the same checksums and compare them/)
    assert.match(workflow, /even if intended campaign edits remain uncommitted/)
    assert.match(workflow, /Do not use jj st or repository cleanliness as the drift result/)
  })
})
