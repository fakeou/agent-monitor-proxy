/**
 * Agent Monitor Proxy — Discovery Orchestrator
 *
 * Combines process scanning and adapter-based discovery.
 * Runs on an interval to detect new and lost agents.
 */

import type { AgentDescriptor, DiscoveryConfig } from '../core/types.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { InstanceManager } from '../core/manager.js'
import { scanForAgents } from './scanner.js'

export class DiscoveryOrchestrator {
  private registry: AdapterRegistry
  private manager: InstanceManager
  private config: DiscoveryConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private knownPids = new Set<number>()
  private knownSessions = new Set<string>()

  constructor(registry: AdapterRegistry, manager: InstanceManager, config: DiscoveryConfig) {
    this.registry = registry
    this.manager = manager
    this.config = config
  }

  /**
   * Start periodic discovery.
   */
  start(): void {
    if (this.timer) return

    // Run immediately
    this.runDiscovery()

    // Then on interval
    this.timer = setInterval(() => {
      this.runDiscovery()
    }, this.config.interval)
  }

  /**
   * Stop discovery.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Run a single discovery pass.
   */
  async runDiscovery(): Promise<void> {
    const allDescriptors: AgentDescriptor[] = []

    // 1. Process scan
    try {
      const processDescriptors = await scanForAgents()
      allDescriptors.push(...processDescriptors)
    } catch (err) {
      console.error('[discovery] Process scan failed:', err)
    }

    // 2. Adapter-based discovery (session files, config dirs, etc.)
    try {
      const adapterDescriptors = await this.registry.discoverAll()
      allDescriptors.push(...adapterDescriptors)
    } catch (err) {
      console.error('[discovery] Adapter discovery failed:', err)
    }

    // 3. Register new instances
    const currentIds = new Set<string>()

    for (const descriptor of allDescriptors) {
      const instance = this.manager.register(descriptor)
      currentIds.add(instance.id)

      // Start watching if newly discovered
      if (!this.knownSessions.has(instance.id)) {
        this.knownSessions.add(instance.id)
        const adapter = this.registry.get(descriptor.type)
        if (adapter) {
          try {
            await adapter.startWatching(instance)
          } catch (err) {
            console.error(`[discovery] Failed to start watching ${instance.id}:`, err)
          }
        }
      }
    }

    // 4. Detect lost instances (process-based)
    const currentPids = new Set(
      allDescriptors.filter((d) => d.pid).map((d) => d.pid!),
    )

    for (const pid of this.knownPids) {
      if (!currentPids.has(pid)) {
        // Process gone — find associated instance and unregister
        const instance = this.manager.getAll().find((i) => i.pid === pid)
        if (instance) {
          this.manager.unregister(instance.id)
          this.knownSessions.delete(instance.id)
          const adapter = this.registry.get(instance.type)
          if (adapter) {
            adapter.stopWatching(instance.id).catch(() => {})
          }
        }
      }
    }

    this.knownPids = currentPids
  }
}
