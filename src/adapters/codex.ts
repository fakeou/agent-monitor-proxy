/**
 * Agent Monitor Proxy — Codex CLI Adapter
 *
 * Monitors Codex CLI by fs.watch on session JSONL files.
 * Infers state from the last entry's `type` and `payload.type` fields.
 *
 * Session files: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Format:
 *   type=event_msg, payload.type=user_message   → User sent message
 *   type=event_msg, payload.type=task_started   → Task started
 *   type=event_msg, payload.type=token_count    → Token stats
 *   type=event_msg, payload.type=turn_aborted   → Turn aborted
 *   type=event_msg, payload.type=task_complete  → Task completed
 *   type=response_item, payload.type=message    → Agent response
 *   type=session_meta                           → Session metadata (has cwd)
 */

import { readdir, readFile, stat, open } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename } from 'node:path'
import type { AgentDescriptor, AgentInstance, AgentState } from '../core/types.js'
import { BaseAdapter } from './base.js'

export class CodexAdapter extends BaseAdapter {
  readonly type = 'codex'
  readonly kind = 'cli' as const
  readonly displayName = 'Codex CLI'

  private sessionDir = ''
  private fsWatchers = new Map<string, FSWatcher>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async init(ctx: import('./base.js').AdapterContext): Promise<void> {
    await super.init(ctx)
    this.sessionDir = this.resolveHome('~/.codex')
  }

  async discover(): Promise<AgentDescriptor[]> {
    const descriptors: AgentDescriptor[] = []
    try {
      const sessionsDir = join(this.sessionDir, 'sessions')
      await this.scanDir(sessionsDir, descriptors, 0)
    } catch {
      // ~/.codex doesn't exist
    }
    return descriptors
  }

  private async scanDir(
    dir: string,
    descriptors: AgentDescriptor[],
    depth: number,
  ): Promise<void> {
    if (depth > 5) return
    const entries = await readdirSafe(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const st = await statSafe(fullPath)
      if (!st) continue

      if (entry.endsWith('.jsonl')) {
        if (Date.now() - st.mtimeMs > 72 * 60 * 60 * 1000) continue
        const sessionId = entry.replace('.jsonl', '')
        const projectPath = await extractProjectPath(fullPath)
        descriptors.push({
          type: this.type,
          kind: this.kind,
          displayName: projectPath
            ? `${this.displayName} (${basename(projectPath)})`
            : this.displayName,
          sessionId,
          projectPath,
          watchPath: fullPath,
        })
      } else if (depth < 3) {
        await this.scanDir(fullPath, descriptors, depth + 1)
      }
    }
  }

  async startWatching(instance: AgentInstance): Promise<void> {
    if (!instance.watchPath) return
    const watchPath = instance.watchPath

    // Track file size to know where to start reading
    let lastSize = 0
    const st = await statSafe(watchPath)
    if (st) lastSize = st.size

    let lastState: AgentState = 'idle'

    // Use fs.watch — OS-level file change notification, zero polling
    const watcher = watch(watchPath, { persistent: false }, (eventType) => {
      if (eventType !== 'change') return

      // Debounce: coalesce rapid writes (Codex writes many lines quickly)
      const existing = this.debounceTimers.get(instance.id)
      if (existing) clearTimeout(existing)

      this.debounceTimers.set(instance.id, setTimeout(async () => {
        this.debounceTimers.delete(instance.id)

        const currentStat = await statSafe(watchPath)
        if (!currentStat || currentStat.size <= lastSize) return

        const newContent = await readFileFromOffset(watchPath, lastSize)
        lastSize = currentStat.size

        for (const line of newContent.split('\n')) {
          if (!line.trim()) continue
          const parsed = this.parseLine(instance.id, line.trim(), lastState)
          if (parsed.state) lastState = parsed.state
        }
      }, 200)) // 200ms debounce
    })

    this.fsWatchers.set(instance.id, watcher)
    this.watchHandles.set(instance.id, () => {
      watcher.close()
      this.fsWatchers.delete(instance.id)
      const timer = this.debounceTimers.get(instance.id)
      if (timer) clearTimeout(timer)
      this.debounceTimers.delete(instance.id)
    })
  }

  async stopWatching(instanceId: string): Promise<void> {
    await super.stopWatching(instanceId)
  }

  private parseLine(
    instanceId: string,
    line: string,
    lastState: AgentState,
  ): { state: AgentState | null } {
    try {
      const entry = JSON.parse(line)
      const bus = this.ctx.bus

      // ── event_msg ──────────────────────────────────────────
      if (entry.type === 'event_msg') {
        const payload = entry.payload
        if (!payload) return { state: null }

        switch (payload.type) {
          case 'user_message': {
            bus.emit({
              type: 'message',
              instanceId,
              timestamp: Date.now(),
              data: { role: 'user', contentPreview: '(user message)' },
            })
            if (lastState !== 'thinking') {
              this.emitState(instanceId, lastState, 'thinking')
              return { state: 'thinking' }
            }
            return { state: null }
          }

          case 'task_started': {
            this.emitState(instanceId, lastState, 'thinking')
            return { state: 'thinking' }
          }

          case 'token_count': {
            if (payload.info) {
              bus.emit({
                type: 'token_usage',
                instanceId,
                timestamp: Date.now(),
                data: {
                  promptTokens: payload.info.input_tokens ?? 0,
                  completionTokens: payload.info.output_tokens ?? 0,
                  totalTokens: (payload.info.input_tokens ?? 0) + (payload.info.output_tokens ?? 0),
                },
              })
            }
            return { state: null }
          }

          case 'turn_aborted': {
            this.emitState(instanceId, lastState, 'failed')
            return { state: 'failed' }
          }

          case 'task_complete': {
            bus.emit({
              type: 'completed',
              instanceId,
              timestamp: Date.now(),
              data: { reason: 'task_complete' },
            })
            this.emitState(instanceId, lastState, 'completed')
            return { state: 'completed' }
          }
        }
      }

      // ── response_item ──────────────────────────────────────
      if (entry.type === 'response_item') {
        const payload = entry.payload
        if (!payload || payload.type !== 'message') return { state: null }

        const role = payload.role
        const content = payload.content ?? []

        if (role === 'assistant') {
          const textContent = content
            .filter((c: { type: string }) => c.type === 'output_text')
            .map((c: { text: string }) => c.text).join('')

          if (textContent) {
            bus.emit({
              type: 'message',
              instanceId,
              timestamp: Date.now(),
              data: { role: 'assistant', contentPreview: textContent.slice(0, 200) },
            })
          }

          let hasToolCall = false
          for (const block of content) {
            if (block.type === 'function_call') {
              hasToolCall = true
              bus.emit({
                type: 'tool_call',
                instanceId,
                timestamp: Date.now(),
                data: {
                  name: block.name ?? 'unknown',
                  inputPreview: JSON.stringify(block.arguments ?? {}).slice(0, 200),
                },
              })
            }
          }

          const newState: AgentState = hasToolCall ? 'executing' : 'thinking'
          if (newState !== lastState) {
            this.emitState(instanceId, lastState, newState)
            return { state: newState }
          }
        }
        return { state: null }
      }

    } catch { /* skip malformed */ }

    return { state: null }
  }

  private emitState(instanceId: string, previous: AgentState, next: AgentState): void {
    this.ctx.bus.emit({
      type: 'state_change',
      instanceId,
      timestamp: Date.now(),
      data: {
        previousState: previous,
        newState: next,
        agentType: this.type,
        agentKind: this.kind,
      },
    })
  }
}

// ── Helpers ─────────────────────────────────────────────────────

async function readdirSafe(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

async function statSafe(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(path)
    return { size: Number(s.size), mtimeMs: Number(s.mtimeMs) }
  } catch { return null }
}

async function readFileFromOffset(path: string, offset: number): Promise<string> {
  const content = await readFile(path, 'utf-8')
  return content.slice(offset)
}

async function extractProjectPath(sessionPath: string): Promise<string | undefined> {
  try {
    const content = await readFile(sessionPath, 'utf-8')
    const lines = content.split('\n').slice(0, 5)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'session_meta' && entry.payload?.cwd) {
          return entry.payload.cwd
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return undefined
}
