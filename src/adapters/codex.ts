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

import { readdir, readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename } from 'node:path'
import type { AgentDescriptor, AgentInstance, AgentState } from '../core/types.js'
import { BaseAdapter } from './base.js'

const SESSION_ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000

export class CodexAdapter extends BaseAdapter {
  readonly type = 'codex'
  readonly kind = 'cli' as const
  readonly displayName = 'Codex CLI'

  private sessionDir = ''
  private fsWatchers = new Map<string, FSWatcher>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private staleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private seenTokenCountLines = new Map<string, Set<string>>()

  async init(ctx: import('./base.js').AdapterContext): Promise<void> {
    await super.init(ctx)
    this.sessionDir = this.resolveHome('~/.codex')
  }

  async discover(): Promise<AgentDescriptor[]> {
    const candidates: Array<{ descriptor: AgentDescriptor; mtimeMs: number }> = []
    try {
      const sessionsDir = join(this.sessionDir, 'sessions')
      await this.scanDir(sessionsDir, candidates, 0)
    } catch {
      // ~/.codex doesn't exist
    }

    const latest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!latest) {
      return []
    }

    for (const instance of this.ctx.manager.getByType(this.type)) {
      if (instance.sessionId === latest.descriptor.sessionId) continue
      await this.stopWatching(instance.id)
      this.ctx.manager.unregister(instance.id)
    }

    return [latest.descriptor]
  }

  private async scanDir(
    dir: string,
    candidates: Array<{ descriptor: AgentDescriptor; mtimeMs: number }>,
    depth: number,
  ): Promise<void> {
    if (depth > 5) return
    const entries = await readdirSafe(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const st = await statSafe(fullPath)
      if (!st) continue

      if (entry.endsWith('.jsonl')) {
        const ageMs = Date.now() - st.mtimeMs
        if (ageMs > SESSION_ACTIVE_WINDOW_MS) {
          continue
        }

        const sessionId = entry.replace('.jsonl', '')
        const projectPath = await extractProjectPath(fullPath)

        candidates.push({
          descriptor: {
            type: this.type,
            kind: this.kind,
            displayName: projectPath
              ? `${this.displayName} (${basename(projectPath)})`
              : this.displayName,
            sessionId,
            projectPath,
            watchPath: fullPath,
          },
          mtimeMs: st.mtimeMs,
        })
      } else if (depth < 4) {
        await this.scanDir(fullPath, candidates, depth + 1)
      }
    }
  }

  async startWatching(instance: AgentInstance): Promise<void> {
    if (!instance.watchPath) return
    const watchPath = instance.watchPath

    // Get current file size
    const st = await statSafe(watchPath)
    let lastSize = st?.size ?? 0
    let lastState: AgentState = 'idle'

    // Initial read: process existing content (last 50 lines for state inference)
    try {
      const content = await readFile(watchPath, 'utf-8')
      const lines = content.split('\n')
      const recentLines = lines.slice(-50)
      for (const line of recentLines) {
        if (!line.trim()) continue
        const parsed = this.parseLine(instance.id, line.trim(), lastState, { replay: true })
        if (parsed.state) lastState = parsed.state
      }
    } catch { /* can't read yet */ }

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
      const staleTimer = this.staleTimers.get(instance.id)
      if (staleTimer) clearTimeout(staleTimer)
      this.staleTimers.delete(instance.id)
      this.seenTokenCountLines.delete(instance.id)
    })
  }

  async stopWatching(instanceId: string): Promise<void> {
    await super.stopWatching(instanceId)
  }

  private parseLine(
    instanceId: string,
    line: string,
    lastState: AgentState,
    options?: { replay?: boolean },
  ): { state: AgentState | null } {
    try {
      const entry = JSON.parse(line)
      const bus = this.ctx.bus
      const manager = this.ctx.manager
      const touch = (state: AgentState | null): { state: AgentState | null } => {
        this.scheduleStaleFallback(instanceId)
        return { state }
      }
      const resetTokenTracking = (): void => {
        manager.updateCurrentTokenBucket(instanceId, {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cachedPromptTokens: 0,
          reasoningTokens: 0,
        })
        this.seenTokenCountLines.delete(instanceId)
      }
      const settleCurrentTokens = (reason: string): void => {
        if (options?.replay) {
          resetTokenTracking()
        } else {
          manager.commitTokenBucket(instanceId, reason)
          this.seenTokenCountLines.delete(instanceId)
        }
      }

      // ── item.* ─────────────────────────────────────────────
      if (entry.type === 'item.started' && entry.item?.type === 'command_execution') {
        manager.recordToolCall(instanceId, {
          name: entry.item.command ?? 'command_execution',
          input: entry.item.command ?? '',
          status: 'pending',
        })
        manager.updateState(instanceId, 'executing')
        return touch('executing')
      }

      if (entry.type === 'item.completed' && entry.item?.type === 'command_execution') {
        manager.updateState(instanceId, 'thinking')
        return touch('thinking')
      }

      // ── event_msg ──────────────────────────────────────────
      if (entry.type === 'event_msg') {
        const payload = entry.payload
        if (!payload) return { state: null }

        switch (payload.type) {
          case 'user_message': {
            manager.recordMessage(instanceId, {
              role: 'user',
              content: stringifyContent(payload.content) ?? '(user message)',
            })
            if (lastState !== 'thinking') {
              manager.updateState(instanceId, 'thinking')
              return touch('thinking')
            }
            return touch(null)
          }

          case 'task_started': {
            if (lastState === 'idle') {
              resetTokenTracking()
            }
            manager.updateState(instanceId, 'thinking')
            return touch('thinking')
          }

          case 'token_count': {
            const lineKey = line.trim()
            let seen = this.seenTokenCountLines.get(instanceId)
            if (!seen) {
              seen = new Set<string>()
              this.seenTokenCountLines.set(instanceId, seen)
            }
            if (seen.has(lineKey)) {
              return touch(null)
            }
            seen.add(lineKey)

            const info = payload.info ?? {}
            const lastUsage = info.last_token_usage ?? info.total_token_usage ?? info
            const promptTokens = Number(lastUsage.input_tokens ?? 0)
            const completionTokens = Number(lastUsage.output_tokens ?? 0)
            const cachedPromptTokens = Number(lastUsage.cached_input_tokens ?? 0)
            const reasoningTokens = Number(lastUsage.reasoning_output_tokens ?? 0)

            manager.addCurrentTaskTokens(instanceId, {
              promptTokens,
              completionTokens,
              cachedPromptTokens,
              reasoningTokens,
            })
            return touch(null)
          }

          case 'turn_aborted': {
            manager.updateState(instanceId, 'interrupted')
            settleCurrentTokens('turn_aborted')
            return touch('interrupted')
          }

          case 'patch_apply_end':
          case 'exec_command_end': {
            manager.updateState(instanceId, 'thinking')
            return touch('thinking')
          }

          case 'task_complete': {
            if (!options?.replay) {
              bus.emit({
                type: 'completed',
                instanceId,
                timestamp: Date.now(),
                data: { reason: 'task_complete' },
              })
            }
            manager.updateState(instanceId, 'idle')
            settleCurrentTokens('task_complete')
            return touch('idle')
          }
        }
      }

      // ── response_item ──────────────────────────────────────
      if (entry.type === 'response_item') {
        const payload = entry.payload

        if (payload?.type === 'function_call') {
          manager.recordToolCall(instanceId, {
            name: payload.name ?? 'unknown',
            input: stringifyContent(payload.arguments) ?? JSON.stringify(payload.arguments ?? {}),
            status: 'pending',
          })
          manager.updateState(instanceId, 'executing')
          return touch('executing')
        }

        if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
          manager.updateState(instanceId, 'thinking')
          return touch('thinking')
        }

        if (!payload || payload.type !== 'message') return { state: null }

        const role = payload.role
        const content = payload.content ?? []

        if (role === 'assistant') {
          const textContent = content
            .filter((c: { type: string }) => c.type === 'output_text')
            .map((c: { text: string }) => c.text).join('')

          if (textContent) {
            manager.recordMessage(instanceId, {
              role: 'assistant',
              content: textContent,
            })
          }

          let hasToolCall = false
          for (const block of content) {
            if (block.type === 'function_call') {
              hasToolCall = true
              manager.recordToolCall(instanceId, {
                name: block.name ?? 'unknown',
                input: JSON.stringify(block.arguments ?? {}),
                status: 'pending',
              })
            }
          }

          if (hasToolCall && lastState !== 'executing') {
            manager.updateState(instanceId, 'executing')
            return touch('executing')
          }
        }
        return touch(null)
      }

      if (entry.type === 'turn.completed') {
        if (!options?.replay) {
          bus.emit({
            type: 'completed',
            instanceId,
            timestamp: Date.now(),
            data: { reason: 'turn.completed' },
          })
        }
        manager.updateState(instanceId, 'idle')
        settleCurrentTokens('turn.completed')
        return touch('idle')
      }

    } catch { /* skip malformed */ }

    return { state: null }
  }

  private scheduleStaleFallback(instanceId: string): void {
    const staleTimeoutMs = Number(this.ctx.config?.staleTimeoutMs ?? 30000)
    const existing = this.staleTimers.get(instanceId)
    if (existing) clearTimeout(existing)

    if (!Number.isFinite(staleTimeoutMs) || staleTimeoutMs <= 0) return

    const instance = this.ctx.manager.get(instanceId)
    if (!instance) return
    if (!['thinking', 'executing'].includes(instance.state)) return

    this.staleTimers.set(instanceId, setTimeout(() => {
      this.staleTimers.delete(instanceId)
      const current = this.ctx.manager.get(instanceId)
      if (!current) return
      if (!['thinking', 'executing'].includes(current.state)) return
      this.ctx.manager.updateState(instanceId, 'idle')
    }, staleTimeoutMs))
  }
}

function stringifyContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return undefined
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
