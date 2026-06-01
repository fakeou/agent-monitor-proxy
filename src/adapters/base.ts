/**
 * Agent Monitor Proxy — Adapter Base
 *
 * Defines the AgentAdapter interface that all agent adapters must implement.
 * Provides a BaseAdapter with common utilities.
 */

import type { AgentDescriptor, AgentInstance, AdapterConfig } from '../core/types.js'
import type { EventBus } from '../core/bus.js'
import type { InstanceManager } from '../core/manager.js'

/**
 * Context provided to adapters during initialization.
 */
export interface AdapterContext {
  /** Emit events to the central event bus */
  bus: EventBus
  /** Update tracked instance state and stats */
  manager: InstanceManager
  /** Adapter-specific configuration */
  config: AdapterConfig
  /** Resolve home directory paths */
  homeDir: string
}

/**
 * Result of a parse operation on a session file line.
 */
export interface ParsedSessionEntry {
  /** State to transition to (if any) */
  state?: AgentInstance['state']
  /** Token usage (if any) */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    model?: string
  }
  /** Message (if any) */
  message?: {
    role: 'user' | 'assistant' | 'system'
    content: string
    tokenCount?: number
  }
  /** Tool call (if any) */
  toolCall?: {
    name: string
    input: string
    status?: 'pending' | 'success' | 'error'
    durationMs?: number
  }
  /** Mark as completed */
  completed?: boolean
}

/**
 * Every agent type must implement this interface.
 */
export interface AgentAdapter {
  /** Unique type identifier (e.g., 'claude-code', 'codex', 'cursor') */
  readonly type: string
  /** Whether this adapter monitors a CLI tool or a desktop app */
  readonly kind: 'cli' | 'app'
  /** Human-readable display name */
  readonly displayName: string

  /** One-time initialization */
  init(ctx: AdapterContext): Promise<void>
  /** Cleanup on shutdown */
  destroy(): Promise<void>

  /**
   * Discover running or installed instances of this agent.
   * Called periodically by the discovery layer.
   */
  discover(): Promise<AgentDescriptor[]>

  /**
   * Start monitoring a specific instance.
   * Called after an instance is registered by the InstanceManager.
   */
  startWatching(instance: AgentInstance): Promise<void>

  /**
   * Stop monitoring a specific instance.
   */
  stopWatching(instanceId: string): Promise<void>
}

/**
 * Base adapter with common utilities. Extend this instead of implementing
 * AgentAdapter directly to get shared functionality.
 */
export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly type: string
  abstract readonly kind: 'cli' | 'app'
  abstract readonly displayName: string

  protected ctx!: AdapterContext
  protected watchHandles = new Map<string, () => void>() // instanceId → cleanup fn

  async init(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
  }

  async destroy(): Promise<void> {
    for (const [id, cleanup] of this.watchHandles) {
      cleanup()
    }
    this.watchHandles.clear()
  }

  abstract discover(): Promise<AgentDescriptor[]>

  abstract startWatching(instance: AgentInstance): Promise<void>

  async stopWatching(instanceId: string): Promise<void> {
    const cleanup = this.watchHandles.get(instanceId)
    if (cleanup) {
      cleanup()
      this.watchHandles.delete(instanceId)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  protected log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
    const prefix = `[${this.type}]`
    const fn = level === 'debug' ? console.debug
      : level === 'warn' ? console.warn
      : level === 'error' ? console.error
      : console.log
    if (data !== undefined) {
      fn(`${prefix} ${msg}`, data)
    } else {
      fn(`${prefix} ${msg}`)
    }
  }

  protected resolveHome(subpath: string): string {
    const path = this.ctx.homeDir
    return subpath.replace(/^~/, path)
  }
}
