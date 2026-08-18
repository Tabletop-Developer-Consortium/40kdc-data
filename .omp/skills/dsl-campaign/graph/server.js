import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { GraphQueryError, globalGraphSnapshot, globalGraphUpdates } from './retrieval.js'
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

function campaignList(store) {
  return store.db.prepare('SELECT run_id,campaign_id,state,kind,target,started,finished FROM runs ORDER BY campaign_id').all()
    .map(row => ({ ...row }))
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
      if (request.method === 'GET' && url.pathname === '/api/v1/graph/stream') {
        const query = graphQuery(url)
        globalGraphSnapshot(store, { ...query, limit: 2 })
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        response.write(': connected\n\n')
        const stream = { response, query, sequence: store.sequence() }
        streams.add(stream)
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
    for (const stream of streams) {
      if (sequence <= stream.sequence) continue
      try {
        const update = globalGraphUpdates(store, { ...stream.query, since: stream.sequence, limit: 250 })
        stream.sequence = update.through
        stream.response.write(`id: ${update.through}\ndata: ${JSON.stringify({
          graph_revision: update.graph_revision,
          affected_ability_ids: update.affected_ability_ids,
        })}\n\n`)
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
