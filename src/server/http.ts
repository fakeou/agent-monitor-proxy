/**
 * Agent Monitor Proxy — HTTP + WebSocket Server
 *
 * Exposes the REST API and WebSocket endpoint for consumers.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { InstanceManager } from '../core/manager.js'
import type { EventBus, EventListener } from '../core/bus.js'
import type { ServerConfig } from '../core/types.js'
import { AgentStateController } from '../core/state-controller.js'

export class AMPHttpServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private wss: WebSocketServer | null = null
  private manager: InstanceManager
  private bus: EventBus
  private config: ServerConfig
  private stateController: AgentStateController
  private unsubscribers: Array<() => void> = []

  constructor(manager: InstanceManager, bus: EventBus, config: ServerConfig) {
    this.manager = manager
    this.bus = bus
    this.config = config
    this.stateController = new AgentStateController(manager, bus)
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => this.handleRequest(req, res))

    // WebSocket server on the same HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer })
    this.wss.on('connection', (ws) => this.handleConnection(ws))

    // Subscribe to all events and broadcast to WebSocket clients
    const unsub = this.bus.on('*', (event) => {
      this.broadcast(JSON.stringify(event))
    })
    this.unsubscribers.push(unsub)

    return new Promise((resolve) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        console.log(`[server] HTTP + WS on http://${this.config.host}:${this.config.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub()
    this.unsubscribers = []

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => resolve())
      })
    }
  }

  // ── HTTP Request Handler ─────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      // Route matching
      if (url.pathname === '/health') {
        this.json(res, { status: 'ok', timestamp: Date.now() })
      } else if (url.pathname === '/api/instances' && method === 'GET') {
        this.json(res, this.manager.getAll())
      } else if (url.pathname.match(/^\/api\/instances\/[^/]+$/) && method === 'GET') {
        const id = url.pathname.split('/').pop()!
        const instance = this.manager.get(id)
        if (instance) {
          this.json(res, instance)
        } else {
          this.json(res, { error: 'Instance not found' }, 404)
        }
      } else if (url.pathname.match(/^\/api\/instances\/[^/]+\/stats$/) && method === 'GET') {
        const id = url.pathname.split('/')[3]!
        const instance = this.manager.get(id)
        if (instance) {
          this.json(res, instance.stats)
        } else {
          this.json(res, { error: 'Instance not found' }, 404)
        }
      } else if (url.pathname === '/api/summary' && method === 'GET') {
        this.json(res, this.manager.getSummary())
      } else if (url.pathname === '/api/hooks/claude-code' && method === 'POST') {
        await this.handleClaudeCodeHook(req, res)
      } else if (url.pathname === '/api/hooks/codex' && method === 'POST') {
        await this.handleCodexHook(req, res)
      } else if (url.pathname === '/api/events/codex-app' && method === 'POST') {
        await this.handleCodexAppNotification(req, res)
      } else if (url.pathname === '/api/events' && method === 'GET') {
        // Server-Sent Events stream
        this.handleSSE(req, res)
        return
      } else {
        this.json(res, { error: 'Not found' }, 404)
      }
    } catch (err) {
      console.error('[server] Request error:', err)
      this.json(res, { error: 'Internal server error' }, 500)
    }
  }

  // ── WebSocket ────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    console.log('[server] WebSocket client connected')

    // Send current state on connect
    ws.send(JSON.stringify({
      type: 'init',
      timestamp: Date.now(),
      data: {
        instances: this.manager.getAll(),
        summary: this.manager.getSummary(),
      },
    }))

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this.handleWsMessage(ws, msg)
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })

    ws.on('close', () => {
      console.log('[server] WebSocket client disconnected')
    })
  }

  private handleWsMessage(ws: WebSocket, msg: { type?: string; instanceId?: string }): void {
    // Handle client requests
    if (msg.type === 'subscribe' && msg.instanceId) {
      // Subscribe to specific instance events
      const unsub = this.bus.onInstance(msg.instanceId, (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event))
        }
      })
      ws.on('close', unsub)
    }
  }

  private broadcast(data: string): void {
    if (!this.wss) return
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  // ── SSE ──────────────────────────────────────────────────────

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const listener: EventListener = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const unsub = this.bus.on('*', listener)

    res.on('close', () => {
      unsub()
    })
  }

  // ── Hook Handlers ─────────────────────────────────────────────

  /**
   * Handle Claude Code hook events.
   * Claude Code POSTs hook data to this endpoint.
   *
   * Hook payload:
   * {
   *   session_id: string,
   *   hook_event_name: "PreToolUse" | "PostToolUse" | "Notification" | "Stop" | "SubagentStop",
   *   tool_name?: string,
   *   tool_input?: object,
   *   tool_output?: string,
   *   transcript_path?: string
   * }
   */
  private async handleClaudeCodeHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    try {
      const hook = JSON.parse(body)
      const instance = this.stateController.handleClaudeHook(hook)
      this.json(res, { ok: true, event: hook.hook_event_name, instanceId: instance.id })
    } catch (err) {
      this.json(res, { error: 'Invalid hook payload', detail: String(err) }, 400)
    }
  }

  /**
   * Handle Codex hook events (for future use).
   */
  private async handleCodexHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    try {
      const hook = JSON.parse(body)
      const instance = this.stateController.handleCodexHook(hook)
      this.json(res, { ok: true, event: hook.hook_event_name, instanceId: instance.id })
    } catch {
      this.json(res, { error: 'Invalid payload' }, 400)
    }
  }

  private async handleCodexAppNotification(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    try {
      const notification = JSON.parse(body)
      const instance = this.stateController.handleCodexAppNotification(notification)
      this.json(res, { ok: true, instanceId: instance?.id })
    } catch {
      this.json(res, { error: 'Invalid payload' }, 400)
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk.toString() })
      req.on('end', () => { resolve(body) })
    })
  }

  // ── Helpers ──────────────────────────────────────────────────

  private json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }
}
