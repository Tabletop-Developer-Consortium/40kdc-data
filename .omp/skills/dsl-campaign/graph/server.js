import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { GraphQueryError, graphRevision, graphSubscriptionRevision, globalGraphSnapshot, globalGraphUpdates, queryClaims, queryUnresolved } from './retrieval.js'
import { GraphStore } from './store.js'

const HOST = '127.0.0.1'
const PORT = 4310

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function routeError(response, status, code, details = {}) {
  sendJson(response, status, { code, ...details })
}

function graphQuery(url, includeSince = false) {
  const query = {
    mode: url.searchParams.get('mode') || 'index',
    faction_id: url.searchParams.get('faction_id') || null,
    ability_id: url.searchParams.get('ability_id') || null,
    campaign_id: url.searchParams.get('campaign_id') || null,
    after: url.searchParams.get('after') || null,
    limit: url.searchParams.get('limit') || null,
    depth: url.searchParams.get('depth') || null,
  }
  if (includeSince) query.since = url.searchParams.get('since')
  return query
}

function claimQuery(url) {
  return Object.fromEntries([
    'subject_ref', 'faction_id', 'ability_id', 'lifecycle_state', 'state',
    'proposition_schema_id', 'schema_id', 'predicate', 'actor', 'affected_entity',
    'event', 'duration', 'has_precondition', 'semantic_key', 'source_snapshot_id',
    'kind', 'unresolved_kind', 'obligation', 'after', 'limit',
  ].map(key => [key, url.searchParams.get(key)]))
}


function campaignList(store) {
  const rows = store.db.prepare(`
    WITH state_counts AS (
      SELECT run_id, 'task' AS category, state, COUNT(*) AS total FROM tasks GROUP BY run_id, state
      UNION ALL
      SELECT run_id, 'claim' AS category, state, COUNT(*) AS total FROM claims GROUP BY run_id, state
      UNION ALL
      SELECT run_id, 'finding' AS category, state, COUNT(*) AS total FROM findings GROUP BY run_id, state
      UNION ALL
      SELECT run_id, 'check' AS category, state, COUNT(*) AS total FROM checks GROUP BY run_id, state
    )
    SELECT runs.run_id, runs.campaign_id, runs.state, runs.kind, runs.target, runs.started, runs.finished,
      state_counts.category, state_counts.state AS item_state, state_counts.total
    FROM runs
    LEFT JOIN state_counts ON state_counts.run_id = runs.run_id
    ORDER BY CASE WHEN runs.state = 'active' THEN 0 ELSE 1 END,
      runs.started DESC, runs.campaign_id ASC
  `).all()
  const campaigns = new Map()
  for (const row of rows) {
    let campaign = campaigns.get(row.run_id)
    if (!campaign) {
      campaign = {
        run_id: row.run_id,
        campaign_id: row.campaign_id,
        state: row.state,
        kind: row.kind,
        target: row.target,
        started: row.started,
        finished: row.finished,
        task_states: {},
        task_total: 0,
        claim_states: {},
        claim_total: 0,
        finding_states: {},
        finding_total: 0,
        check_states: {},
        check_total: 0,
      }
      campaigns.set(row.run_id, campaign)
    }
    if (!row.category) continue
    const states = campaign[`${row.category}_states`]
    const total = Number(row.total)
    states[row.item_state] = total
    campaign[`${row.category}_total`] += total
  }
  return [...campaigns.values()]
}

export function createMechanicGraphServer({
  root = process.env.DSL_CLAIM_GRAPH_ROOT || '_private/claim-graph',
  host = HOST,
  port = PORT,
  repositoryRoot = process.cwd(),
} = {}) {
  const store = new GraphStore(root, { repositoryRoot })
  const streams = new Set()
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port}`)
      if (request.method !== 'GET' && request.method !== 'POST') return routeError(response, 405, 'method-not-allowed')
      if (request.method === 'GET' && url.pathname === '/api/v1/graph/snapshot') {
        return sendJson(response, 200, globalGraphSnapshot(store, graphQuery(url)))
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/graph/updates') {
        return sendJson(response, 200, globalGraphUpdates(store, graphQuery(url, true)))
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/claims') {
        return sendJson(response, 200, queryClaims(store, claimQuery(url)))
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/unresolved') {
        return sendJson(response, 200, queryUnresolved(store, claimQuery(url)))
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/graph/stream') {
        const query = graphQuery(url)
        const revision = graphSubscriptionRevision(store, query)
        const sequence = store.sequence()
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        const stream = { response, query, sequence, revision }
        streams.add(stream)
        response.write(`id: ${sequence}\ndata: ${JSON.stringify({
          graph_revision: revision,
          affected_ability_ids: [],
        })}\n\n`)
        response.on('close', () => streams.delete(stream))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/campaigns') return sendJson(response, 200, campaignList(store))
      if (request.method === 'GET' && /^\/api\/v1\/reviews\/[^/]+\/source$/.test(url.pathname)) return routeError(response, 403, 'source-access-not-configured')
      if (request.method === 'POST' && /^\/api\/v1\/reviews\/[^/]+\/decisions$/.test(url.pathname)) return routeError(response, 403, 'decision-submission-not-authorized')
      return routeError(response, 404, 'not-found')
    } catch (error) {
      if (error instanceof GraphQueryError) return routeError(response, error.status, error.code, error.details)
      routeError(response, 500, error instanceof TypeError ? 'projection-contract-error' : 'internal-error')
    }
  })
  const watcher = setInterval(() => {
    const sequence = store.sequence()
    const revision = graphRevision(store)
    for (const stream of streams) {
      if (sequence === stream.sequence && revision === stream.revision) continue
      try {
        const update = globalGraphUpdates(store, { ...stream.query, since: stream.sequence, limit: 250 })
        stream.response.write(`id: ${update.through}\ndata: ${JSON.stringify({
          graph_revision: update.graph_revision,
          affected_ability_ids: update.affected_ability_ids,
        })}\n\n`)
        stream.sequence = update.through
        stream.revision = update.graph_revision
      } catch (error) {
        stream.response.write(`event: error\ndata: ${JSON.stringify({ code: error.code || 'stream-error' })}\n\n`)
      }
    }
  }, 500)
  watcher.unref()
  server.on('close', () => {
    clearInterval(watcher)
    for (const stream of streams) stream.response.end()
    store.close()
  })
  return { server, store, host, port }
}

export async function startMechanicGraphServer(options = {}) {
  const runtime = createMechanicGraphServer(options)
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject)
    runtime.server.listen(runtime.port, runtime.host, resolve)
  })
  console.log(`Mechanic Evidence Graph API listening on http://${runtime.host}:${runtime.port}`)
  return runtime
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const runtime = await startMechanicGraphServer()
  const stop = () => runtime.server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
