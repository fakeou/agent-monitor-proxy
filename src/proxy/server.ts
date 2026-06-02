/**
 * Agent Monitor Proxy — HTTP Proxy Server
 *
 * Intercepts API requests from coding agents, forwards them to the real API,
 * and extracts token usage from responses to update instance token buckets.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { EventBus } from '../core/bus.js'
import type { InstanceManager } from '../core/manager.js'
import type { ProxyConfig, AgentInstance } from '../core/types.js'

export interface ProxyServer {
  start(): Promise<void>
  stop(): Promise<void>
  getPort(): number
}

export function createProxyServer(
  config: ProxyConfig,
  bus: EventBus,
  manager: InstanceManager,
  port: number,
): ProxyServer {
  let server: ReturnType<typeof createServer> | null = null

  const upstream = config.upstream?.replace(/\/+$/, '')

  return {
    async start() {
      server = createServer((req, res) => {
        handleRequest(req, res, upstream, manager)
      })

      return new Promise((resolve) => {
        server!.listen(port, '127.0.0.1', () => {
          console.log(`[proxy] Listening on http://127.0.0.1:${port}`)
          if (upstream) {
            console.log(`[proxy] Forwarding to ${upstream}`)
          } else {
            console.log(`[proxy] No upstream configured — token capture disabled`)
          }
          resolve()
        })
      })
    },

    async stop() {
      if (server) {
        return new Promise((resolve) => {
          server!.close(() => resolve())
        })
      }
    },

    getPort() {
      return port
    },
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string | undefined,
  manager: InstanceManager,
): Promise<void> {
  // CORS for preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  // Read request body
  const body = await readBody(req)

  // No upstream configured — pass through without token tracking
  if (!upstream) {
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', note: 'proxy running, no upstream configured' }))
    return
  }

  // Build upstream URL
  const targetPath = req.url ?? '/'
  const targetUrl = upstream + targetPath

  try {
    // Forward headers (strip hop-by-hop)
    const fwdHeaders: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.headers)) {
      if (!val) continue
      const lk = key.toLowerCase()
      if (lk === 'host' || lk === 'connection' || lk === 'transfer-encoding') continue
      fwdHeaders[key] = Array.isArray(val) ? val[0] : val
    }

    // Forward request to upstream
    const upstreamRes = await fetch(targetUrl, {
      method: req.method ?? 'POST',
      headers: fwdHeaders,
      body: body || undefined,
    })

    // Read response body
    const responseBody = await upstreamRes.text()

    // Extract token usage from response
    try {
      const parsed = JSON.parse(responseBody)
      if (parsed.usage) {
        const instance = findTargetInstance(manager, body)
        if (instance) {
          manager.addCurrentTaskTokens(instance.id, {
            promptTokens: Number(parsed.usage.input_tokens ?? 0),
            completionTokens: Number(parsed.usage.output_tokens ?? 0),
            cachedPromptTokens: Number(parsed.usage.cache_read_input_tokens ?? 0) || undefined,
            reasoningTokens: Number(parsed.usage.reasoning_output_tokens ?? 0) || undefined,
          })
        }
      }
    } catch {
      // Non-JSON response — skip token extraction
    }

    // Return response to agent
    const resHeaders: Record<string, string> = { ...corsHeaders() }
    upstreamRes.headers.forEach((val, key) => {
      const lk = key.toLowerCase()
      if (lk === 'transfer-encoding' || lk === 'connection') return
      resHeaders[key] = val
    })

    res.writeHead(upstreamRes.status, resHeaders)
    res.end(responseBody)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upstream unreachable'
    res.writeHead(502, { ...corsHeaders(), 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'proxy_error', detail: message }))
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString() })
    req.on('end', () => { resolve(body) })
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
  }
}

/**
 * Find the instance to attribute token usage to.
 * Heuristic: check request body for agent-specific fields,
 * then return the most recently active instance of that type.
 */
function findTargetInstance(manager: InstanceManager, requestBody: string): AgentInstance | undefined {
  let agentType = 'claude-code'

  try {
    const parsed = JSON.parse(requestBody)
    // Anthropic format: has "model" + "messages" + "max_tokens"
    // OpenAI format: has "model" + "messages" (different structure)
    // Detect Anthropic by presence of max_tokens or system as top-level field
    if (parsed.max_tokens !== undefined || parsed.system !== undefined) {
      agentType = 'claude-code'
    }
  } catch {
    // Can't parse — default to claude-code
  }

  // Find the most recently active instance of this type
  const instances = manager.getByType(agentType)
    .filter((i) => i.hookManaged !== false)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)

  return instances[0]
}
