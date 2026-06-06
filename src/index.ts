/**
 * Agent Monitor Proxy — Main Entry Point
 *
 * Boots up the proxy service:
 * 1. Load configuration
 * 2. Initialize event bus and instance manager
 * 3. Register adapters
 * 4. Start discovery
 * 5. Start HTTP/WS server
 * 6. Optionally start API proxy
 */

import { EventBus } from './core/bus.js'
import { InstanceManager } from './core/manager.js'
import { AdapterRegistry } from './adapters/registry.js'
import { DiscoveryOrchestrator } from './discovery/index.js'
import { AMPHttpServer } from './server/http.js'
import { createProxyServer } from './proxy/server.js'
import { ClaudeCodeAdapter } from './adapters/claude-code.js'
import { CodexAdapter } from './adapters/codex.js'
import { DimcodeAdapter } from './adapters/dimcode.js'
import type { AMPConfig } from './core/types.js'
import { DEFAULT_CONFIG } from './core/types.js'

export interface AMPOptions {
  config?: Partial<AMPConfig>
  /** Custom adapters to register beyond the built-in ones */
  adapters?: import('./adapters/base.js').AgentAdapter[]
}

export class AgentMonitorProxy {
  private config: AMPConfig
  private bus: EventBus
  private manager: InstanceManager
  private registry: AdapterRegistry
  private discovery: DiscoveryOrchestrator
  private httpServer: AMPHttpServer
  private proxyServer: ReturnType<typeof createProxyServer> | null = null

  constructor(options?: AMPOptions) {
    // Merge config
    this.config = mergeConfig(DEFAULT_CONFIG, options?.config ?? {})

    // Core
    this.bus = new EventBus(this.config.events.maxHistoryPerInstance)
    this.manager = new InstanceManager(this.bus)

    // Adapters
    this.registry = new AdapterRegistry(this.bus, this.manager)

    // Register built-in adapters
    this.registry.register(new ClaudeCodeAdapter())
    this.registry.register(new CodexAdapter())
    this.registry.register(new DimcodeAdapter())

    // Register custom adapters
    if (options?.adapters) {
      for (const adapter of options.adapters) {
        this.registry.register(adapter)
      }
    }

    // Discovery
    this.discovery = new DiscoveryOrchestrator(
      this.registry,
      this.manager,
      this.config.discovery,
    )

    // HTTP + WS Server
    this.httpServer = new AMPHttpServer(this.manager, this.bus, this.config.server)
  }

  /**
   * Start the proxy service.
   */
  async start(): Promise<void> {
    console.log('╔══════════════════════════════════════╗')
    console.log('║     Agent Monitor Proxy (AMP)        ║')
    console.log('╚══════════════════════════════════════╝')
    console.log()

    // Initialize adapters
    await this.registry.initAll(this.config.adapters)
    console.log(`[amp] Initialized ${this.registry.getTypes().length} adapters: ${this.registry.getTypes().join(', ')}`)

    // Start HTTP + WS server
    await this.httpServer.start()

    // Start proxy (optional)
    if (this.config.proxy.enabled) {
      this.proxyServer = createProxyServer(
        this.config.proxy,
        this.bus,
        this.manager,
        this.config.server.proxyPort,
      )
      await this.proxyServer.start()
    }

    // Start discovery
    this.discovery.start()
    console.log(`[amp] Discovery scanning every ${this.config.discovery.interval}ms`)

    console.log()
    console.log(`[amp] Ready. API: http://${this.config.server.host}:${this.config.server.port}`)
    if (this.config.proxy.enabled) {
      console.log(`[amp] Proxy: http://${this.config.server.host}:${this.config.server.proxyPort}`)
    }
    console.log(`[amp] WebSocket: ws://${this.config.server.host}:${this.config.server.port}`)
    console.log()
  }

  /**
   * Stop the proxy service.
   */
  async stop(): Promise<void> {
    console.log('[amp] Shutting down...')
    this.discovery.stop()
    await this.httpServer.stop()
    if (this.proxyServer) {
      await this.proxyServer.stop()
    }
    await this.registry.destroyAll()
    this.bus.removeAllListeners()
    this.manager.clear()
    console.log('[amp] Stopped.')
  }

  /**
   * Get the event bus (for programmatic use).
   */
  getBus(): EventBus {
    return this.bus
  }

  /**
   * Get the instance manager (for programmatic use).
   */
  getManager(): InstanceManager {
    return this.manager
  }

  /**
   * Get the adapter registry (for programmatic use).
   */
  getRegistry(): AdapterRegistry {
    return this.registry
  }
}

// ── Config Merge ────────────────────────────────────────────────

function mergeConfig(base: AMPConfig, override: Partial<AMPConfig>): AMPConfig {
  return {
    server: { ...base.server, ...override.server },
    discovery: { ...base.discovery, ...override.discovery },
    proxy: { ...base.proxy, ...override.proxy },
    adapters: { ...base.adapters, ...override.adapters },
    events: { ...base.events, ...override.events },
    logging: { ...base.logging, ...override.logging },
  }
}

// ── CLI Entry Point ─────────────────────────────────────────────

async function main(): Promise<void> {
  const amp = new AgentMonitorProxy()

  // Graceful shutdown
  const shutdown = async () => {
    await amp.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await amp.start()
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((err) => {
    console.error('Failed to start AMP:', err)
    process.exit(1)
  })
}

export { EventBus } from './core/bus.js'
export { InstanceManager } from './core/manager.js'
export { AgentStateController } from './core/state-controller.js'
export { AdapterRegistry } from './adapters/registry.js'
export { BaseAdapter, type AgentAdapter, type AdapterContext } from './adapters/base.js'
export type * from './core/types.js'
