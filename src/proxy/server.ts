/**
 * Agent Monitor Proxy — HTTP/HTTPS Proxy Server
 *
 * Intercepts API traffic from coding agents.
 * Parses Anthropic, OpenAI, and Google API requests/responses
 * to extract messages, tool calls, and token usage.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { EventBus } from '../core/bus.js'
import type { ProxyConfig } from '../core/types.js'
import { parseAnthropicRequest, parseAnthropicResponse } from './parsers/anthropic.js'
import { parseOpenAIRequest, parseOpenAIResponse } from './parsers/openai.js'

export interface ProxyServer {
  start(): Promise<void>
  stop(): Promise<void>
  getPort(): number
}

/**
 * Create a proxy server that intercepts API traffic.
 *
 * This is a simplified MITM proxy. In production, you'd want to use
 * a proper HTTP proxy library like `http-mitm-proxy` or `mockttp`.
 * For the MVP, we provide a passthrough proxy that records traffic metadata.
 */
export function createProxyServer(
  config: ProxyConfig,
  bus: EventBus,
  port: number,
): ProxyServer {
  let server: ReturnType<typeof createServer> | null = null

  return {
    async start() {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        handleRequest(req, res, config, bus)
      })

      return new Promise((resolve) => {
        server!.listen(port, '127.0.0.1', () => {
          console.log(`[proxy] Listening on 127.0.0.1:${port}`)
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
  config: ProxyConfig,
  bus: EventBus,
): Promise<void> {
  const host = req.headers.host ?? ''

  // Check if this is a target host
  const isTarget = config.targetHosts.some((h) => host.includes(h))
  if (!isTarget) {
    res.writeHead(404)
    res.end('Not a monitored host')
    return
  }

  // Read request body
  let body = ''
  for await (const chunk of req) {
    body += chunk.toString()
  }

  // Determine which API we're dealing with
  const isAnthropic = host.includes('anthropic.com')
  const isOpenAI = host.includes('openai.com')
  const isGoogle = host.includes('googleapis.com')

  // Parse request for metadata
  let requestMeta: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(body)
    if (isAnthropic) {
      requestMeta = parseAnthropicRequest(parsed) as unknown as Record<string, unknown>
    } else if (isOpenAI) {
      requestMeta = parseOpenAIRequest(parsed) as unknown as Record<string, unknown>
    }
  } catch {
    // Non-JSON body — skip
  }

  // Forward to actual API (simplified — in production use a proper HTTP client)
  const targetHost = host.replace(/:\d+$/, '')
  const targetPort = isAnthropic ? 443 : isOpenAI ? 443 : 443

  // For MVP: log the interception, don't actually proxy yet
  // In production, forward the request and parse the response
  console.log(`[proxy] Intercepted ${req.method} ${host}${req.url}`, {
    messages: requestMeta.messageCount,
    model: requestMeta.model,
  })

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ status: 'intercepted', meta: requestMeta }))
}

/**
 * Generate a self-signed CA certificate for HTTPS interception.
 * Returns { cert, key } as PEM strings.
 */
export async function generateCACert(): Promise<{ cert: string; key: string }> {
  // In production, use node-forge or similar to generate a real CA cert
  // For MVP, return placeholder
  return {
    cert: 'PLACEHOLDER_CA_CERT',
    key: 'PLACEHOLDER_CA_KEY',
  }
}
