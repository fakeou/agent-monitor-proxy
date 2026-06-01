/**
 * Agent Monitor Proxy — Event Bus
 *
 * Typed event emitter for all monitor events.
 * Supports middleware, event history, and wildcard subscriptions.
 */

import { EventEmitter } from 'node:events'
import type { MonitorEvent, MonitorEventType } from './types.js'

export type EventListener = (event: MonitorEvent) => void | Promise<void>
export type EventMiddleware = (event: MonitorEvent, next: () => void) => void

export class EventBus {
  private emitter = new EventEmitter()
  private history: MonitorEvent[] = []
  private middlewares: EventMiddleware[] = []
  private maxHistory: number

  constructor(maxHistory = 10000) {
    this.maxHistory = maxHistory
    this.emitter.setMaxListeners(100)
  }

  /**
   * Emit an event. Runs through all middlewares first.
   */
  emit(event: MonitorEvent): void {
    let index = 0
    const middlewares = this.middlewares

    const runNext = () => {
      if (index < middlewares.length) {
        const mw = middlewares[index++]
        mw(event, runNext)
      } else {
        this.deliver(event)
      }
    }

    if (middlewares.length > 0) {
      runNext()
    } else {
      this.deliver(event)
    }
  }

  private deliver(event: MonitorEvent): void {
    // Store in history
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }

    // Emit to type-specific listeners
    this.emitter.emit(event.type, event)
    // Emit to wildcard listeners
    this.emitter.emit('*', event)
  }

  /**
   * Subscribe to a specific event type.
   */
  on(type: MonitorEventType | '*', listener: EventListener): () => void {
    this.emitter.on(type, listener)
    return () => {
      this.emitter.off(type, listener)
    }
  }

  /**
   * Subscribe to a specific event type, once.
   */
  once(type: MonitorEventType | '*', listener: EventListener): void {
    this.emitter.once(type, listener)
  }

  /**
   * Subscribe to events for a specific instance.
   */
  onInstance(instanceId: string, listener: EventListener): () => void {
    const wrapper = (event: MonitorEvent) => {
      if (event.instanceId === instanceId) {
        listener(event)
      }
    }
    this.emitter.on('*', wrapper)
    return () => {
      this.emitter.off('*', wrapper)
    }
  }

  /**
   * Add middleware. Middleware runs before event delivery.
   */
  use(middleware: EventMiddleware): void {
    this.middlewares.push(middleware)
  }

  /**
   * Get recent events, optionally filtered.
   */
  getHistory(options?: {
    type?: MonitorEventType
    instanceId?: string
    since?: number
    limit?: number
  }): MonitorEvent[] {
    let events = this.history

    if (options?.type) {
      events = events.filter((e) => e.type === options.type)
    }
    if (options?.instanceId) {
      events = events.filter((e) => e.instanceId === options.instanceId)
    }
    if (options?.since) {
      events = events.filter((e) => e.timestamp >= options.since!)
    }
    if (options?.limit) {
      events = events.slice(-options.limit)
    }

    return events
  }

  /**
   * Clear all history.
   */
  clearHistory(): void {
    this.history = []
  }

  /**
   * Remove all listeners.
   */
  removeAllListeners(): void {
    this.emitter.removeAllListeners()
    this.middlewares = []
  }
}
