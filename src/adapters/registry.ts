/**
 * Agent Monitor Proxy — Adapter Registry
 *
 * Central registry for all agent adapters.
 * Handles adapter lifecycle and discovery orchestration.
 */

import type { AgentAdapter, AdapterContext } from './base.js'
import type { AgentDescriptor, AgentInstance, AdapterConfig } from '../core/types.js'
import type { EventBus } from '../core/bus.js'
import { homedir } from 'node:os'

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()
  private bus: EventBus

  constructor(bus: EventBus) {
    this.bus = bus
  }

  /**
   * Register an adapter.
   */
  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.type)) {
      throw new Error(`Adapter already registered: ${adapter.type}`)
    }
    this.adapters.set(adapter.type, adapter)
  }

  /**
   * Initialize all registered adapters.
   */
  async initAll(configs: Record<string, AdapterConfig>): Promise<void> {
    const home = homedir()

    for (const [type, adapter] of this.adapters) {
      const config = configs[type] ?? { enabled: true }
      if (config.enabled === false) {
        continue
      }

      const ctx: AdapterContext = {
        bus: this.bus,
        config,
        homeDir: home,
      }

      try {
        await adapter.init(ctx)
      } catch (err) {
        console.error(`Failed to init adapter "${type}":`, err)
      }
    }
  }

  /**
   * Destroy all adapters.
   */
  async destroyAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.destroy()
      } catch (err) {
        console.error(`Failed to destroy adapter "${adapter.type}":`, err)
      }
    }
  }

  /**
   * Run discovery across all adapters.
   */
  async discoverAll(): Promise<AgentDescriptor[]> {
    const results: AgentDescriptor[] = []

    for (const adapter of this.adapters.values()) {
      try {
        const descriptors = await adapter.discover()
        results.push(...descriptors)
      } catch (err) {
        console.error(`Discovery failed for "${adapter.type}":`, err)
      }
    }

    return results
  }

  /**
   * Get a specific adapter by type.
   */
  get(type: string): AgentAdapter | undefined {
    return this.adapters.get(type)
  }

  /**
   * Get all registered adapter types.
   */
  getTypes(): string[] {
    return Array.from(this.adapters.keys())
  }
}
