import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { reconcileAbilityCatalog } from './projection.js'
import { createMechanicGraphServer } from './server.js'

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mechanic-graph-server-repo-'))
  const root = join(repoRoot, 'graph')
  mkdirSync(join(repoRoot, 'data', 'core', 'fabricated-faction'), { recursive: true })
  mkdirSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction'), { recursive: true })
  writeFileSync(join(repoRoot, 'data', 'core', 'fabricated-faction', 'factions.json'), JSON.stringify([
    { id: 'fabricated-faction', name: 'Fabricated Faction' },
  ]))
  writeFileSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction', 'abilities.json'), JSON.stringify([
    { ability_id: 'alpha', name: 'Alpha' },
    { ability_id: 'beta', name: 'Beta' },
    { ability_id: 'gamma', name: 'Gamma' },
  ]))
  const runtime = createMechanicGraphServer({ root, port: 0, repositoryRoot: repoRoot })
  const { store } = runtime
  const repository = store.createNode({ kind: 'repository-version', payload: { workspace_hash: 'a'.repeat(64), files: [], tool_versions: {}, runner_hashes: [], schema_version: 2, policy_version: 1 } })
  reconcileAbilityCatalog(store, repoRoot, repository.node_id)
  for (const [runId, campaignId] of [['run-1', 'campaign-1'], ['run-2', 'campaign-2']]) {
    store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target) VALUES (?,?,?,?,?)').run(runId, campaignId, 'active', 'fixture', 'alpha')
  }
  const first = store.createNode({ kind: 'finding', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', state: 'resolved' } })
  const second = store.createNode({ kind: 'candidate-certificate', payload: { faction_id: 'fabricated-faction', ability_id: 'alpha', status: 'certified', fingerprints: {}, checks: [] } })
  store.db.prepare('INSERT INTO findings(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run('finding-1', 'run-1', 'resolved', first.node_id, '{}')
  store.db.prepare('INSERT INTO certificates(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)').run('certificate-2', 'run-2', 'certified', second.node_id, '{}')
  store.appendEvent('finding-resolved', { run_id: 'run-1' }, { aggregate_kind: 'run', aggregate_id: 'run-1', node_id: first.node_id })
  store.appendEvent('certificate-certified', { run_id: 'run-2' }, { aggregate_kind: 'run', aggregate_id: 'run-2', node_id: second.node_id })
  return { runtime, repoRoot, repository, first, second }
}

async function listen(runtime) {
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject)
    runtime.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${runtime.server.address().port}`
}

async function close(runtime) {
  await new Promise(resolve => runtime.server.close(resolve))
}

function sseDataReader(response) {
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  return {
    reader,
    async next() {
      for (;;) {
        const boundary = buffered.indexOf('\n\n')
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          const lines = frame.split('\n')
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart())
          if (!data.length) continue
          assert.equal(lines.some(line => line.startsWith('event:')), false)
          return JSON.parse(data.join('\n'))
        }
        const { done, value } = await reader.read()
        assert.equal(done, false, 'SSE stream ended before a data frame arrived')
        buffered += decoder.decode(value, { stream: true })
      }
    },
  }
}

async function within(promise, milliseconds) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function assertNoSseData(stream, milliseconds) {
  let timeout
  try {
    const result = await Promise.race([
      stream.next().then(() => 'data'),
      new Promise(resolve => { timeout = setTimeout(resolve, milliseconds, 'timeout') }),
    ])
    assert.equal(result, 'timeout', 'stream repeated an unchanged revision notice')
  } finally {
    clearTimeout(timeout)
  }
}

test('global ability view unifies campaigns and campaign mode filters the same node identities', async () => {
  const { runtime, first, second } = fixture()
  const origin = await listen(runtime)
  const ability = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha`).then(response => response.json())
  assert.equal(ability.root, 'root:mechanic-evidence')
  assert.ok(ability.nodes.some(node => node.id === first.node_id && node.campaign_refs.includes('campaign-1')))
  assert.ok(ability.nodes.some(node => node.id === second.node_id && node.campaign_refs.includes('campaign-2')))
  const campaign = await fetch(`${origin}/api/v1/graph/snapshot?mode=campaign&campaign_id=campaign-1`).then(response => response.json())
  assert.ok(campaign.nodes.some(node => node.id === first.node_id))
  assert.equal(campaign.nodes.some(node => node.id === second.node_id), false)
  assert.ok(ability.nodes.every(node => !JSON.stringify(node).includes('payload')))
  await close(runtime)
})

test('workflow evidence projects structural provenance without result payloads', async () => {
  const { runtime } = fixture()
  const taskId = 'c011:agent:shape:leader-relation:r2:trail:kroot-trail-shaper:task:1'
  const attemptId = 'c011:agent:shape:leader-relation:r2:trail:kroot-trail-shaper:attempt:3'
  runtime.store.db.prepare('INSERT INTO tasks(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(taskId, 'run-1', 'succeeded', '{}')
  runtime.store.db.prepare('INSERT INTO attempts(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(attemptId, 'run-1', 'succeeded', '{}')
  const workflow = runtime.store.createNode({
    kind: 'workflow-output',
    payload: {
      output_kind: 'kroot-trail-shaper',
      envelope: {
        run_id: 'run-1',
        task_id: taskId,
        attempt_id: attemptId,
        producer_contract_version: 1,
      },
      result: { campaign_id: 'campaign-2', private_payload: 'must not cross the browser boundary' },
    },
  })
  runtime.store.db.prepare('UPDATE tasks SET node_id=? WHERE id=?').run(workflow.node_id, taskId)
  runtime.store.db.prepare('UPDATE attempts SET node_id=? WHERE id=?').run(workflow.node_id, attemptId)
  const intakeTaskId = 'intake-fixture-task-01'
  const intakeAttemptId = 'intake-fixture-task-01-attempt-1'
  runtime.store.db.prepare('INSERT INTO tasks(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(intakeTaskId, 'run-1', 'succeeded', '{}')
  runtime.store.db.prepare('INSERT INTO attempts(id,run_id,state,payload_json) VALUES (?,?,?,?)').run(intakeAttemptId, 'run-1', 'succeeded', '{}')
  const intake = runtime.store.createNode({
    kind: 'workflow-output',
    payload: {
      output_kind: 'proposal',
      envelope: {
        run_id: 'run-1',
        task_id: intakeTaskId,
        attempt_id: intakeAttemptId,
        producer_contract_version: 1,
      },
    },
  })
  runtime.store.db.prepare('UPDATE tasks SET node_id=? WHERE id=?').run(intake.node_id, intakeTaskId)
  runtime.store.db.prepare('UPDATE attempts SET node_id=? WHERE id=?').run(intake.node_id, intakeAttemptId)
  runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
    .run(intake.node_id, 'fabricated-faction', 'alpha', 'direct', 0)
  runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
    .run(workflow.node_id, 'fabricated-faction', 'alpha', 'direct', 3)
  const origin = await listen(runtime)
  const snapshot = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha`).then(response => response.json())
  const node = snapshot.nodes.find(candidate => candidate.id === workflow.node_id)
  assert.ok(node)
  assert.equal(node.label, 'kroot trail shaper output')
  assert.deepEqual({
    output_kind: node.metadata.output_kind,
    task_id: node.metadata.task_id,
    attempt_id: node.metadata.attempt_id,
    workflow_stage: node.metadata.workflow_stage,
    workflow_task: node.metadata.workflow_task,
    workflow_round: node.metadata.workflow_round,
    workflow_lane: node.metadata.workflow_lane,
    attempt_number: node.metadata.attempt_number,
    lineage_distance: node.metadata.lineage_distance,
  }, {
    output_kind: 'kroot-trail-shaper',
    task_id: 'c011:agent:shape:leader-relation:r2:trail:kroot-trail-shaper:task:1',
    attempt_id: 'c011:agent:shape:leader-relation:r2:trail:kroot-trail-shaper:attempt:3',
    workflow_stage: 'shape',
    workflow_task: 'leader-relation',
    workflow_round: 'r2',
    workflow_lane: 'trail',
    attempt_number: 3,
    lineage_distance: 3,
  })
  assert.deepEqual(node.campaign_refs, ['campaign-1'])
  assert.equal(JSON.stringify(node).includes('result'), false)
  const intakeNode = snapshot.nodes.find(candidate => candidate.id === intake.node_id)
  assert.equal(intakeNode.label, 'proposal output')
  assert.equal(intakeNode.metadata.attempt_number, 1)
  assert.equal('workflow_stage' in intakeNode.metadata, false)
  assert.deepEqual(intakeNode.campaign_refs, ['campaign-1'])
  assert.equal(JSON.stringify(node).includes('must not cross'), false)
  const unrelated = await fetch(`${origin}/api/v1/graph/snapshot?mode=campaign&campaign_id=campaign-2`).then(response => response.json())
  assert.equal(unrelated.nodes.some(candidate => candidate.id === workflow.node_id), false)
  await close(runtime)
})

test('non-workflow payload fields cannot impersonate workflow provenance or campaign membership', async () => {
  const { runtime } = fixture()
  const finding = runtime.store.createNode({
    kind: 'finding',
    payload: {
      faction_id: 'fabricated-faction',
      ability_id: 'alpha',
      state: 'open',
      output_kind: 'private persisted result text',
      envelope: {
        run_id: 'run-2',
        task_id: 'c011:agent:shape:spoof:r2:trail:private:task:1',
        attempt_id: 'c011:agent:shape:spoof:r2:trail:private:attempt:1',
      },
      result: { campaign_id: 'campaign-2' },
    },
  })
  runtime.store.db.prepare('INSERT INTO findings(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)')
    .run('finding-spoof', 'run-1', 'open', finding.node_id, '{}')
  const unboundWorkflow = runtime.store.createNode({
    kind: 'workflow-output',
    payload: {
      output_kind: 'private persisted result text',
      envelope: {
        run_id: 'run-2',
        task_id: 'c011:agent:shape:spoof:r2:trail:private:task:1',
        attempt_id: 'c011:agent:shape:spoof:r2:trail:private:attempt:1',
        producer_contract_version: 1,
      },
    },
  })
  runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
    .run(unboundWorkflow.node_id, 'fabricated-faction', 'alpha', 'direct', 0)
  const origin = await listen(runtime)
  const ability = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha`).then(response => response.json())
  const projected = ability.nodes.find(candidate => candidate.id === finding.node_id)
  assert.equal(projected.label, 'finding')
  assert.equal('output_kind' in projected.metadata, false)
  assert.equal('task_id' in projected.metadata, false)
  assert.deepEqual(projected.campaign_refs, ['campaign-1'])
  const unbound = ability.nodes.find(candidate => candidate.id === unboundWorkflow.node_id)
  assert.equal(unbound.label, 'workflow output')
  assert.equal('output_kind' in unbound.metadata, false)
  assert.deepEqual(unbound.campaign_refs, [])
  const unrelated = await fetch(`${origin}/api/v1/graph/snapshot?mode=campaign&campaign_id=campaign-2`).then(response => response.json())
  assert.equal(unrelated.nodes.some(candidate => candidate.id === finding.node_id), false)
  await close(runtime)
})
test('index pagination is deterministic and stale revisions fail with current revision', async () => {
  const { runtime, first } = fixture()

  const origin = await listen(runtime)
  const page1Response = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=1`)
  const page1 = await page1Response.json()
  assert.equal(page1.nodes.length, 2)
  assert.equal(page1.nodes[1].metadata.ability_id, 'alpha')
  assert.equal(page1.page.truncated, true)
  const page2 = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=1&after=${encodeURIComponent(page1.page.next_cursor)}`).then(response => response.json())
  assert.equal(page2.nodes[1].metadata.ability_id, 'beta')
  runtime.store.appendEvent('finding-reopened', { run_id: 'run-1' }, { aggregate_kind: 'run', aggregate_id: 'run-1', node_id: first.node_id })
  const stale = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=1&after=${encodeURIComponent(page1.page.next_cursor)}`)
  assert.equal(stale.status, 409)
  const staleBody = await stale.json()
  assert.equal(staleBody.code, 'stale-cursor')
  assert.notEqual(staleBody.graph_revision, page1.graph_revision)
  await close(runtime)
})

test('paginated ability lineage retains real cross-page edges without synthetic evidence roots', async () => {
  const { runtime } = fixture()
  const parent = runtime.store.createNode({ kind: 'finding', payload: { state: 'resolved' } })
  const child = runtime.store.createNode({ kind: 'finding', payload: { state: 'open' }, input_node_ids: [parent.node_id] })
  const insertRef = runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
  insertRef.run(parent.node_id, 'fabricated-faction', 'gamma', 'direct', 0)
  insertRef.run(child.node_id, 'fabricated-faction', 'gamma', 'lineage', 1)
  const origin = await listen(runtime)
  const firstPage = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=gamma&limit=3`).then(response => response.json())
  const secondPage = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=gamma&limit=3&after=${encodeURIComponent(firstPage.page.next_cursor)}`).then(response => response.json())
  const lineage = secondPage.edges.find(edge => edge.source === parent.node_id && edge.target === child.node_id)
  assert.ok(lineage)
  assert.equal(secondPage.edges.some(edge => edge.source === 'ability:fabricated-faction:gamma' && edge.target === child.node_id), false)
  const mergedNodes = new Set([...firstPage.nodes, ...secondPage.nodes].map(node => node.id))
  assert.equal(mergedNodes.has(lineage.source) && mergedNodes.has(lineage.target), true)
  await close(runtime)
})


test('filters fail closed, legacy graph routes are removed, and updates stay bounded', async () => {
  const { runtime } = fixture()
  const origin = await listen(runtime)
  assert.equal((await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction`)).status, 400)
  assert.equal((await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=unknown`)).status, 404)
  assert.equal((await fetch(`${origin}/api/v1/campaigns/campaign-1/snapshot`)).status, 404)
  const update = await fetch(`${origin}/api/v1/graph/updates?since=0&mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=1`).then(response => response.json())
  assert.equal(update.page.truncated, true)
  assert.deepEqual(update.affected_ability_ids, [{ faction_id: 'fabricated-faction', ability_id: 'alpha' }])
  assert.equal('nodes' in update, false)
  await close(runtime)
})

test('ability streams remain open with a valid bounded probe while invalid bounds fail closed', async () => {
  const { runtime } = fixture()
  const origin = await listen(runtime)
  const fanIn = runtime.store.createNode({ kind: 'finding', payload: { state: 'open' } })
  const insertRef = runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
  insertRef.run(fanIn.node_id, 'fabricated-faction', 'alpha', 'direct', 0)
  insertRef.run(fanIn.node_id, 'fabricated-faction', 'beta', 'direct', 0)
  runtime.store.db.prepare('INSERT INTO findings(id,run_id,state,node_id,payload_json) VALUES (?,?,?,?,?)')
    .run('finding-fan-in', 'run-1', 'open', fanIn.node_id, '{}')
  const stream = await fetch(`${origin}/api/v1/graph/stream?mode=ability&faction_id=fabricated-faction&ability_id=alpha`)
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') || '', /^text\/event-stream/)
  await stream.body?.cancel()

  const invalid = await fetch(`${origin}/api/v1/graph/stream?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=2`)
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid-bound')

  const index = await fetch(`${origin}/api/v1/graph/stream?mode=index&limit=1`)
  assert.equal(index.status, 200)
  await index.body?.cancel()
  const campaignSnapshot = await fetch(`${origin}/api/v1/graph/snapshot?mode=campaign&campaign_id=campaign-1&limit=400`).then(response => response.json())
  const campaignResponse = await fetch(`${origin}/api/v1/graph/stream?mode=campaign&campaign_id=campaign-1`)
  assert.equal(campaignResponse.status, 200)
  assert.match(campaignResponse.headers.get('content-type') || '', /^text\/event-stream/)
  const campaign = sseDataReader(campaignResponse)
  assert.equal((await within(campaign.next(), 2_000)).graph_revision, campaignSnapshot.graph_revision)
  await campaign.reader.cancel()
  await close(runtime)
})


test('stream opening sends the current graph revision in an ordinary update notice', async () => {
  const { runtime, first } = fixture()
  let stream
  try {
    const origin = await listen(runtime)
    const snapshot = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha`).then(response => response.json())
    runtime.store.appendEvent('finding-reopened', { run_id: 'run-1' }, { aggregate_kind: 'run', aggregate_id: 'run-1', node_id: first.node_id })

    stream = sseDataReader(await fetch(`${origin}/api/v1/graph/stream?mode=ability&faction_id=fabricated-faction&ability_id=alpha`))
    const notice = await within(stream.next(), 2_000)
    assert.notEqual(notice.graph_revision, snapshot.graph_revision)
    assert.ok(Array.isArray(notice.affected_ability_ids))
    assert.deepEqual(notice.affected_ability_ids, [])
  } finally {
    try {
      await stream?.reader.cancel()
    } finally {
      await close(runtime)
    }
  }
})

test('stream watcher emits exactly one notice for a projection-only revision change', async () => {
  const { runtime, repoRoot, repository } = fixture()
  let stream
  try {
    const origin = await listen(runtime)
    stream = sseDataReader(await fetch(`${origin}/api/v1/graph/stream?mode=ability&faction_id=fabricated-faction&ability_id=alpha`))
    const initial = await within(stream.next(), 2_000)
    const sequence = runtime.store.sequence()

    writeFileSync(join(repoRoot, 'data', 'enrichment', 'fabricated-faction', 'abilities.json'), JSON.stringify([
      { ability_id: 'alpha', name: 'Alpha Revised' },
      { ability_id: 'beta', name: 'Beta' },
      { ability_id: 'gamma', name: 'Gamma' },
    ]))
    reconcileAbilityCatalog(runtime.store, repoRoot, repository.node_id)
    assert.equal(runtime.store.sequence(), sequence)

    const changed = await within(stream.next(), 2_000)
    assert.notEqual(changed.graph_revision, initial.graph_revision)
    assert.deepEqual(changed.affected_ability_ids, [])
    await assertNoSseData(stream, 1_100)
  } finally {
    try {
      await stream?.reader.cancel()
    } finally {
      await close(runtime)
    }
  }
})

test('referenced abilities without repository metadata remain navigable with fallback labels', async () => {
  const { runtime } = fixture()
  const nodeId = 'd'.repeat(64)
  runtime.store.db.prepare('INSERT INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)').run(nodeId, nodeId, 'finding', `objects/${nodeId}.json`, nodeId)
  runtime.store.db.prepare('INSERT INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)').run(nodeId, 'finding', 1, '{}')
  runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)').run(nodeId, 'missing-faction', 'missing-ability', 'ownership', 0)
  const origin = await listen(runtime)
  const index = await fetch(`${origin}/api/v1/graph/snapshot?mode=index&limit=100`).then(response => response.json())
  const fallback = index.nodes.find(node => node.metadata?.ability_id === 'missing-ability')
  assert.equal(fallback.label, 'Unknown ability (missing-ability) — missing-faction')
  assert.equal(fallback.metadata.metadata_status, 'missing')
  const ability = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=missing-faction&ability_id=missing-ability`).then(response => response.json())
  assert.ok(ability.nodes.some(node => node.id === nodeId))
  await close(runtime)
})

test('truncated descendant pages always provide a deterministic continuation cursor', async () => {
  const { runtime } = fixture()
  const origin = await listen(runtime)
  const response = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=3`)
  const page = await response.json()
  assert.equal(response.status, 200)
  assert.equal(page.nodes.length, 3)
  assert.equal(page.page.truncated, true)
  assert.ok(page.page.next_cursor)
  assert.equal((await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=2`)).status, 400)
  await close(runtime)
})

test('ability responses enforce the 400-node hard cap', async () => {
  const { runtime } = fixture()
  runtime.store.transaction(() => {
    const objectInsert = runtime.store.db.prepare('INSERT INTO objects(node_id,content_hash,kind,relative_path,byte_hash) VALUES (?,?,?,?,?)')
    const nodeInsert = runtime.store.db.prepare('INSERT INTO nodes(node_id,kind,producer_contract_version,payload_json) VALUES (?,?,?,?)')
    const refInsert = runtime.store.db.prepare('INSERT INTO node_ability_refs(node_id,faction_id,ability_id,source_kind,distance) VALUES (?,?,?,?,?)')
    for (let index = 0; index < 410; index += 1) {
      const nodeId = index.toString(16).padStart(64, '0')
      objectInsert.run(nodeId, nodeId, 'finding', `objects/${nodeId}.json`, nodeId)
      nodeInsert.run(nodeId, 'finding', 1, '{}')
      refInsert.run(nodeId, 'fabricated-faction', 'alpha', 'ownership', 0)
    }
  })
  const origin = await listen(runtime)
  const response = await fetch(`${origin}/api/v1/graph/snapshot?mode=ability&faction_id=fabricated-faction&ability_id=alpha&limit=999&depth=8`).then(value => value.json())
  assert.equal(response.nodes.length, 400)
  assert.equal(response.page.truncated, true)
  assert.ok(response.page.next_cursor)
  await close(runtime)
})

test('campaign progress is active-first and aggregates state counts without payloads', async () => {
  const { runtime } = fixture()
  runtime.store.transaction(() => {
    runtime.store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,started,finished) VALUES (?,?,?,?,?,?,?)').run(
      'run-c011', 'c011', 'active', 'author', 'adeptus-custodes', '2026-02-11T10:00:00.000Z', null,
    )
    runtime.store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,started,finished) VALUES (?,?,?,?,?,?,?)').run(
      'run-c099', 'c099', 'completed', 'author', 'other', '2026-12-01T10:00:00.000Z', '2026-12-02T10:00:00.000Z',
    )
    runtime.store.db.prepare('INSERT INTO runs(run_id,campaign_id,state,kind,target,started,finished) VALUES (?,?,?,?,?,?,?)').run(
      'run-empty', 'c000', 'completed', 'review', 'empty', '2026-01-01T10:00:00.000Z', '2026-01-02T10:00:00.000Z',
    )
    const insert = table => runtime.store.db.prepare(`INSERT INTO ${table}(id,run_id,state,payload_json) VALUES (?,?,?,?)`)
    insert('tasks').run('task-open-1', 'run-c011', 'open', '{}')
    insert('tasks').run('task-open-2', 'run-c011', 'open', '{}')
    insert('tasks').run('task-done', 'run-c011', 'done', '{}')
    runtime.store.db.prepare('INSERT INTO claims(faction_id,ability_id,run_id,state,claimed_sequence) VALUES (?,?,?,?,?)').run(
      'adeptus-custodes', 'shield-host', 'run-c011', 'active', 1,
    )
    runtime.store.db.prepare('INSERT INTO claims(faction_id,ability_id,run_id,state,claimed_sequence,released_sequence) VALUES (?,?,?,?,?,?)').run(
      'adeptus-custodes', 'auric-champions', 'run-c011', 'released', 2, 3,
    )
    insert('findings').run('finding-open-1', 'run-c011', 'open', '{}')
    insert('findings').run('finding-open-2', 'run-c011', 'open', '{}')
    insert('findings').run('findings-resolved', 'run-c011', 'resolved', '{}')
    insert('checks').run('check-passed-1', 'run-c011', 'passed', '{}')
    insert('checks').run('check-passed-2', 'run-c011', 'passed', '{}')
    insert('checks').run('check-failed', 'run-c011', 'failed', '{}')
  })

  const origin = await listen(runtime)
  const response = await fetch(`${origin}/api/v1/campaigns`)
  const campaigns = await response.json()
  const c011 = campaigns.find(campaign => campaign.campaign_id === 'c011')
  const empty = campaigns.find(campaign => campaign.campaign_id === 'c000')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(campaigns[0].campaign_id, 'c011')
  assert.deepEqual(c011, {
    run_id: 'run-c011',
    campaign_id: 'c011',
    state: 'active',
    kind: 'author',
    target: 'adeptus-custodes',
    started: '2026-02-11T10:00:00.000Z',
    finished: null,
    task_states: { done: 1, open: 2 },
    task_total: 3,
    claim_states: { active: 1, released: 1 },
    claim_total: 2,
    finding_states: { open: 2, resolved: 1 },
    finding_total: 3,
    check_states: { failed: 1, passed: 2 },
    check_total: 3,
  })
  assert.deepEqual(empty.task_states, {})
  assert.equal(empty.task_total, 0)
  assert.deepEqual(empty.claim_states, {})
  assert.equal(empty.claim_total, 0)
  assert.deepEqual(empty.finding_states, {})
  assert.equal(empty.finding_total, 0)
  assert.deepEqual(empty.check_states, {})
  assert.equal(empty.check_total, 0)
  assert.equal(JSON.stringify(c011).includes('payload'), false)
  await close(runtime)
})
