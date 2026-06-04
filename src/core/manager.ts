/**
 * Agent Monitor Proxy — Instance Manager
 *
 * Tracks all discovered agent instances.
 * Manages state transitions and stats aggregation.
 */

import type {
  AgentInstance,
  AgentState,
  AgentStats,
  AgentDescriptor,
  MonitorEvent,
  StateChangeEvent,
  TokenUsageEvent,
  SessionInfo,
  TokenBucket,
} from './types.js'
import { createEmptyStats, createEmptySession, createEmptyTokenBucket } from './types.js'
import { EventBus } from './bus.js'

export class InstanceManager {
  private instances = new Map<string, AgentInstance>()
  private bus: EventBus
  private maxMessages: number
  private maxToolCalls: number

  constructor(bus: EventBus, options?: { maxMessages?: number; maxToolCalls?: number }) {
    this.bus = bus
    this.maxMessages = options?.maxMessages ?? 100
    this.maxToolCalls = options?.maxToolCalls ?? 200
  }

  /**
   * Register a newly discovered instance.
   */
  register(descriptor: AgentDescriptor): AgentInstance {
    const id = this.buildId(descriptor)

    if (this.instances.has(id)) {
      // Already tracked — update last activity
      const existing = this.instances.get(id)!
      existing.lastActivityAt = Date.now()
      return existing
    }

    const instance: AgentInstance = {
      id,
      type: descriptor.type,
      kind: descriptor.kind,
      displayName: descriptor.displayName,
      pid: descriptor.pid,
      projectPath: descriptor.projectPath,
      sessionId: descriptor.sessionId,
      watchPath: descriptor.watchPath,
      state: 'idle',
      stateChangedAt: Date.now(),
      stats: createEmptyStats(),
      currentTaskTokens: createEmptyTokenBucket(),
      session: createEmptySession(descriptor.sessionId ?? id),
      discoveredAt: Date.now(),
      lastActivityAt: Date.now(),
    }

    this.instances.set(id, instance)

    this.bus.emit({
      type: 'instance_discovered',
      instanceId: id,
      timestamp: Date.now(),
      data: {
        type: descriptor.type,
        kind: descriptor.kind,
        displayName: descriptor.displayName,
        pid: descriptor.pid,
        projectPath: descriptor.projectPath,
      },
    })

    return instance
  }

  /**
   * Remove an instance (agent stopped / process exited).
   */
  unregister(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance) return

    this.updateState(instanceId, 'stopped')

    this.bus.emit({
      type: 'instance_lost',
      instanceId,
      timestamp: Date.now(),
      data: {
        type: instance.type,
        displayName: instance.displayName,
        reason: 'process_exited',
      },
    })

    this.instances.delete(instanceId)
  }

  /**
   * Get a specific instance.
   */
  get(instanceId: string): AgentInstance | undefined {
    return this.instances.get(instanceId)
  }

  /**
   * Get all active instances.
   */
  getAll(): AgentInstance[] {
    return Array.from(this.instances.values())
  }

  /**
   * Get instances filtered by type.
   */
  getByType(type: string): AgentInstance[] {
    return this.getAll().filter((i) => i.type === type)
  }

  /**
   * Get instances filtered by state.
   */
  getByState(state: AgentState): AgentInstance[] {
    return this.getAll().filter((i) => i.state === state)
  }

  /**
   * Update instance state. Emits state_change event if changed.
   */
  updateState(instanceId: string, newState: AgentState): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.state === newState) return false

    const previousState = instance.state
    instance.state = newState
    instance.stateChangedAt = Date.now()
    instance.lastActivityAt = Date.now()

    // Update duration if transitioning to completed/stopped
    if (newState === 'completed' || newState === 'stopped') {
      instance.stats.durationMs = Date.now() - instance.discoveredAt
    }

    this.bus.emit({
      type: 'state_change',
      instanceId,
      timestamp: Date.now(),
      data: {
        previousState,
        newState,
        agentType: instance.type,
        agentKind: instance.kind,
        project: instance.projectPath,
        currentTaskTokens: { ...instance.currentTaskTokens },
      } satisfies StateChangeEvent,
    })

    return true
  }

  /**
   * Record token usage for an instance.
   */
  recordTokenUsage(
    instanceId: string,
    usage: {
      promptTokens: number
      completionTokens: number
      model?: string
      requestId?: string
      reason?: string
      cachedPromptTokens?: number
      reasoningTokens?: number
      settle?: boolean
    },
  ): void {
    const instance = this.instances.get(instanceId)
    if (!instance) return

    instance.currentTaskTokens.promptTokens += usage.promptTokens
    instance.currentTaskTokens.completionTokens += usage.completionTokens
    instance.currentTaskTokens.totalTokens += usage.promptTokens + usage.completionTokens
    instance.currentTaskTokens.cachedPromptTokens = usage.cachedPromptTokens ?? instance.currentTaskTokens.cachedPromptTokens
    instance.currentTaskTokens.reasoningTokens = usage.reasoningTokens ?? instance.currentTaskTokens.reasoningTokens
    instance.currentTaskTokens.updatedAt = Date.now()
    if (usage.settle) {
      instance.stats.promptTokens += instance.currentTaskTokens.promptTokens
      instance.stats.completionTokens += instance.currentTaskTokens.completionTokens
      instance.stats.totalTokens += instance.currentTaskTokens.totalTokens
    }
    instance.stats.requestCount++
    instance.lastActivityAt = Date.now()
    instance.session.lastActivity = Date.now()

    this.bus.emit({
      type: 'token_usage',
      instanceId,
      timestamp: Date.now(),
      data: {
        settlementId: `${instanceId}:${usage.reason ?? 'usage'}:${instance.currentTaskTokens.updatedAt ?? Date.now()}`,
        settledTokens: { ...instance.currentTaskTokens },
        model: usage.model,
        requestId: usage.requestId,
        reason: usage.reason,
      } satisfies TokenUsageEvent,
    })
  }

  commitTokenBucket(
    instanceId: string,
    reason: string,
    options?: { model?: string; requestId?: string; settlementKey?: string },
  ): TokenBucket | null {
    const instance = this.instances.get(instanceId)
    if (!instance) return null

    const snapshot = { ...instance.currentTaskTokens, updatedAt: Date.now() }
    if (snapshot.totalTokens <= 0) {
      instance.currentTaskTokens = createEmptyTokenBucket()
      return snapshot
    }

    instance.stats.promptTokens += snapshot.promptTokens
    instance.stats.completionTokens += snapshot.completionTokens
    instance.stats.totalTokens += snapshot.totalTokens
    instance.stats.requestCount++

    this.bus.emit({
      type: 'token_usage',
      instanceId,
      timestamp: Date.now(),
      data: {
        settlementId: `${instanceId}:${reason}:${options?.settlementKey ?? snapshot.updatedAt ?? Date.now()}`,
        settledTokens: snapshot,
        model: options?.model,
        requestId: options?.requestId,
        reason,
      } satisfies TokenUsageEvent,
    })

    instance.currentTaskTokens = createEmptyTokenBucket()
    this.bus.emit({
      type: 'token_update',
      instanceId,
      timestamp: Date.now(),
      data: {
        updateKind: 'reset',
        deltaTokens: createEmptyTokenBucket(),
        currentTaskTokens: { ...instance.currentTaskTokens },
      },
    })
    return snapshot
  }

  addCurrentTaskTokens(
    instanceId: string,
    delta: {
      promptTokens?: number
      completionTokens?: number
      cachedPromptTokens?: number
      reasoningTokens?: number
    },
  ): TokenBucket | null {
    const instance = this.instances.get(instanceId)
    if (!instance) return null
    const deltaTokens: TokenBucket = {
      promptTokens: delta.promptTokens ?? 0,
      completionTokens: delta.completionTokens ?? 0,
      totalTokens: (delta.promptTokens ?? 0) + (delta.completionTokens ?? 0),
      cachedPromptTokens: delta.cachedPromptTokens,
      reasoningTokens: delta.reasoningTokens,
      updatedAt: Date.now(),
    }

    instance.currentTaskTokens.promptTokens += deltaTokens.promptTokens
    instance.currentTaskTokens.completionTokens += deltaTokens.completionTokens
    instance.currentTaskTokens.totalTokens += deltaTokens.totalTokens
    if (typeof delta.cachedPromptTokens === 'number') {
      instance.currentTaskTokens.cachedPromptTokens =
        (instance.currentTaskTokens.cachedPromptTokens ?? 0) + delta.cachedPromptTokens
    }
    if (typeof delta.reasoningTokens === 'number') {
      instance.currentTaskTokens.reasoningTokens =
        (instance.currentTaskTokens.reasoningTokens ?? 0) + delta.reasoningTokens
    }
    instance.currentTaskTokens.updatedAt = Date.now()
    instance.lastActivityAt = Date.now()
    instance.session.lastActivity = Date.now()
    this.bus.emit({
      type: 'token_update',
      instanceId,
      timestamp: Date.now(),
      data: {
        updateKind: 'delta',
        deltaTokens,
        currentTaskTokens: { ...instance.currentTaskTokens },
      },
    })
    return { ...instance.currentTaskTokens }
  }

  updateCurrentTokenBucket(
    instanceId: string,
    bucket: Partial<TokenBucket>,
  ): TokenBucket | null {
    const instance = this.instances.get(instanceId)
    if (!instance) return null

    if (typeof bucket.promptTokens === 'number') {
      instance.currentTaskTokens.promptTokens = bucket.promptTokens
    }
    if (typeof bucket.completionTokens === 'number') {
      instance.currentTaskTokens.completionTokens = bucket.completionTokens
    }
    if (typeof bucket.totalTokens === 'number') {
      instance.currentTaskTokens.totalTokens = bucket.totalTokens
    } else {
      instance.currentTaskTokens.totalTokens =
        instance.currentTaskTokens.promptTokens + instance.currentTaskTokens.completionTokens
    }
    if (typeof bucket.cachedPromptTokens === 'number') {
      instance.currentTaskTokens.cachedPromptTokens = bucket.cachedPromptTokens
    }
    if (typeof bucket.reasoningTokens === 'number') {
      instance.currentTaskTokens.reasoningTokens = bucket.reasoningTokens
    }
    instance.currentTaskTokens.updatedAt = Date.now()
    instance.lastActivityAt = Date.now()
    instance.session.lastActivity = Date.now()
    this.bus.emit({
      type: 'token_update',
      instanceId,
      timestamp: Date.now(),
      data: {
        updateKind: 'reset',
        deltaTokens: createEmptyTokenBucket(),
        currentTaskTokens: { ...instance.currentTaskTokens },
      },
    })
    return { ...instance.currentTaskTokens }
  }

  /**
   * Record a message for an instance.
   */
  recordMessage(
    instanceId: string,
    message: { role: 'user' | 'assistant' | 'system'; content: string; tokenCount?: number },
  ): void {
    const instance = this.instances.get(instanceId)
    if (!instance) return

    instance.stats.messageCount++
    instance.lastActivityAt = Date.now()
    instance.session.lastActivity = Date.now()

    const summary = {
      role: message.role,
      contentPreview: message.content.slice(0, 200),
      timestamp: Date.now(),
      tokenCount: message.tokenCount,
    }

    instance.session.messages.push(summary)
    if (instance.session.messages.length > this.maxMessages) {
      instance.session.messages = instance.session.messages.slice(-this.maxMessages)
    }

    this.bus.emit({
      type: 'message',
      instanceId,
      timestamp: Date.now(),
      data: summary,
    })
  }

  /**
   * Record a tool call for an instance.
   */
  recordToolCall(
    instanceId: string,
    toolCall: { name: string; input: string; status?: 'pending' | 'success' | 'error'; durationMs?: number },
  ): void {
    const instance = this.instances.get(instanceId)
    if (!instance) return

    instance.stats.toolCallCount++
    instance.lastActivityAt = Date.now()
    instance.session.lastActivity = Date.now()

    const summary = {
      name: toolCall.name,
      inputPreview: toolCall.input.slice(0, 200),
      timestamp: Date.now(),
      status: toolCall.status ?? 'pending',
      durationMs: toolCall.durationMs,
    }

    instance.session.toolCalls.push(summary)
    if (instance.session.toolCalls.length > this.maxToolCalls) {
      instance.session.toolCalls = instance.session.toolCalls.slice(-this.maxToolCalls)
    }

    const eventType = toolCall.status === 'success' || toolCall.status === 'error'
      ? 'tool_result'
      : 'tool_call'

    this.bus.emit({
      type: eventType,
      instanceId,
      timestamp: Date.now(),
      data: summary,
    })
  }

  /**
   * Get a global summary of all instances.
   */
  getSummary(): {
    totalInstances: number
    activeInstances: number
    totalTokens: number
    totalToolCalls: number
    totalMessages: number
    byType: Record<string, { count: number; tokens: number }>
    byState: Record<AgentState, number>
  } {
    const all = this.getAll()
    const byType: Record<string, { count: number; tokens: number }> = {}
    const byState: Record<AgentState, number> = {
      idle: 0, task_start: 0, thinking: 0, executing: 0, waiting_input: 0,
      completed: 0, interrupted: 0, failed: 0, stopped: 0,
    }

    let totalTokens = 0
    let totalToolCalls = 0
    let totalMessages = 0

    for (const instance of all) {
      totalTokens += instance.stats.totalTokens
      totalToolCalls += instance.stats.toolCallCount
      totalMessages += instance.stats.messageCount
      byState[instance.state]++

      if (!byType[instance.type]) {
        byType[instance.type] = { count: 0, tokens: 0 }
      }
      byType[instance.type].count++
      byType[instance.type].tokens += instance.stats.totalTokens
    }

    return {
      totalInstances: all.length,
      activeInstances: all.filter((i) => !['stopped', 'completed'].includes(i.state)).length,
      totalTokens,
      totalToolCalls,
      totalMessages,
      byType,
      byState,
    }
  }

  /**
   * Remove all instances.
   */
  clear(): void {
    this.instances.clear()
  }

  private buildId(descriptor: AgentDescriptor): string {
    const parts = [descriptor.type]
    if (descriptor.pid) parts.push(String(descriptor.pid))
    else if (descriptor.sessionId) {
      // Use last 20 chars of session ID to avoid collisions (e.g., rollout-2026-...)
      // Session IDs are typically UUIDs or timestamps, so the tail is most unique
      const id = descriptor.sessionId
      parts.push(id.length > 20 ? id.slice(-20) : id)
    }
    else parts.push(String(Date.now()))
    return parts.join('-')
  }
}
