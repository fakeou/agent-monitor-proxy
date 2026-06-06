/**
 * Agent Monitor Proxy — Dimcode Adapter
 *
 * Monitors dimcode CLI sessions by polling its SQLite database at
 * ~/.dimcode/v2/dimcode.sqlite. No changes to dimcode required.
 *
 * Discovery: queries the `sessions` table for recently active sessions.
 * Watching: polls `messages` and `usage_ledger` tables to infer state
 * transitions and track token usage.
 */

import { stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { type DatabaseSync } from 'node:sqlite'
import type { AgentDescriptor, AgentInstance, AgentState } from '../core/types.js'
import { BaseAdapter } from './base.js'

const SESSION_ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000 // 12 hours
const POLL_INTERVAL_MS = 3000
const STALE_TIMEOUT_MS = 30_000

interface DimcodeSession {
  sessionId: string
  cwd: string
  title: string | null
  status: string
  heldBy: string | null
  updatedAt: string
}

interface DimcodeMessage {
  messageId: string
  sessionId: string
  role: string
  parts: string
  orderKey: string
  createdAt: string
}

interface DimcodeUsage {
  ledgerId: string
  usage: string
  modelId: string
}

export class DimcodeAdapter extends BaseAdapter {
  readonly type = 'dimcode'
  readonly kind = 'cli' as const
  readonly displayName = 'Dimcode'

  private dbPath = ''
  private db: DatabaseSync | null = null

  async init(ctx: import('./base.js').AdapterContext): Promise<void> {
    await super.init(ctx)
    this.dbPath = join(this.ctx.homeDir, '.dimcode', 'v2', 'dimcode.sqlite')

    try {
      await stat(this.dbPath)
    } catch {
      // dimcode not installed or no data yet
      return
    }

    try {
      const { DatabaseSync } = await import('node:sqlite')
      this.db = new DatabaseSync(this.dbPath, { open: true, readOnly: true })
      this.log('debug', `Opened SQLite DB at ${this.dbPath}`)
    } catch (err) {
      this.log('warn', `Failed to open dimcode SQLite DB: ${err}`)
    }
  }

  async destroy(): Promise<void> {
    await super.destroy()
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
      this.db = null
    }
  }

  async discover(): Promise<AgentDescriptor[]> {
    if (!this.db) return []

    try {
      const cutoff = new Date(Date.now() - SESSION_ACTIVE_WINDOW_MS).toISOString()
      const rows = this.db.prepare(
        `SELECT sessionId, cwd, title, status, heldBy, updatedAt
         FROM sessions
         WHERE updatedAt > ? AND status = 'active'
         ORDER BY updatedAt DESC`
      ).all(cutoff) as unknown as DimcodeSession[]

      if (!rows.length) return []

      // Find the latest session whose CLI process is still alive
      const latest = rows.find(r => {
        if (!r.heldBy) return false // released session — CLI exited cleanly
        const pid = extractPid(r.heldBy)
        return pid ? isProcessAlive(pid) : true // no PID format → keep (unknown)
      })
      if (!latest) return []
      const projectPath = latest.cwd || undefined

      // Unregister stale instances
      for (const instance of this.ctx.manager.getByType(this.type)) {
        if (instance.hookManaged) continue
        if (instance.sessionId === latest.sessionId) continue
        await this.stopWatching(instance.id)
        this.ctx.manager.unregister(instance.id)
      }

      return [{
        type: this.type,
        kind: this.kind,
        displayName: projectPath
          ? `${this.displayName} (${basename(projectPath)})`
          : this.displayName,
        sessionId: latest.sessionId,
        projectPath,
        watchPath: this.dbPath,
      }]
    } catch (err) {
      this.log('error', `Discovery failed: ${err}`)
      return []
    }
  }

  async startWatching(instance: AgentInstance): Promise<void> {
    if (!this.db || !instance.sessionId) return

    let lastOrderKey = ''
    let lastLedgerId = ''
    let staleTimer: ReturnType<typeof setTimeout> | null = null

    // Replay recent messages to recover tool calls and infer current state
    const recentMessages = this.db.prepare(
      `SELECT messageId, sessionId, role, parts, orderKey, createdAt
       FROM messages
       WHERE sessionId = ?
       ORDER BY orderKey DESC
       LIMIT 50`
    ).all(instance.sessionId!) as unknown as DimcodeMessage[]

    // Process oldest first
    const reversed = recentMessages.reverse()
    let lastMsgCreatedAt = ''
    for (const msg of reversed) {
      lastOrderKey = msg.orderKey
      lastMsgCreatedAt = msg.createdAt
      this.applyMessageState(instance, msg)
    }

    // If the last message is stale (older than timeout), mark completed immediately
    // instead of waiting for the stale timer to fire during the first poll cycle
    if (lastMsgCreatedAt) {
      const msgAge = Date.now() - new Date(lastMsgCreatedAt).getTime()
      const inst = this.ctx.manager.get(instance.id)
      const s = inst?.state
      if (inst && msgAge > STALE_TIMEOUT_MS && (s === 'thinking' || s === 'executing' || s === 'task_start')) {
        this.ctx.manager.updateState(instance.id, 'completed')
      }
    }

    // Settle initial token usage from usage_ledger
    const latestUsage = this.db.prepare(
      `SELECT ledgerId, usage, modelId FROM usage_ledger
       WHERE sessionId = ?
       ORDER BY createdAt DESC
       LIMIT 1`
    ).all(instance.sessionId!) as unknown as DimcodeUsage[]

    if (latestUsage.length > 0) {
      const row = latestUsage[0]!
      lastLedgerId = row.ledgerId
      const usage = JSON.parse(row.usage)
      const promptTokens = usage.promptTokens ?? 0
      const completionTokens = usage.completionTokens ?? 0
      if (promptTokens > 0 || completionTokens > 0) {
        const inst = this.ctx.manager.get(instance.id)
        if (inst) {
          inst.stats.promptTokens = promptTokens
          inst.stats.completionTokens = completionTokens
          inst.stats.totalTokens = promptTokens + completionTokens
        }
      }
    }

    // Poll for new messages
    const interval = setInterval(() => {
      if (!this.db) return

      try {
        // Check if session is still active
        const session = this.db.prepare(
          `SELECT status, updatedAt FROM sessions WHERE sessionId = ?`
        ).get(instance.sessionId!) as unknown as DimcodeSession | undefined

        if (!session || session.status !== 'active') {
          this.ctx.manager.updateState(instance.id, 'completed')
          return
        }

        // Get new messages since last check
        const newMessages = this.db.prepare(
          `SELECT messageId, sessionId, role, parts, orderKey, createdAt
           FROM messages
           WHERE sessionId = ? AND orderKey > ?
           ORDER BY orderKey ASC`
        ).all(instance.sessionId!, lastOrderKey) as unknown as DimcodeMessage[]

        for (const msg of newMessages) {
          lastOrderKey = msg.orderKey
          this.applyMessageState(instance, msg)
        }

        // Sync new token usage — directly update stats (usage_ledger has cumulative totals per run)
        const newUsage = this.db.prepare(
          `SELECT ledgerId, usage, modelId FROM usage_ledger
           WHERE sessionId = ? AND ledgerId > ?
           ORDER BY createdAt ASC`
        ).all(instance.sessionId!, lastLedgerId) as unknown as DimcodeUsage[]

        for (const row of newUsage) {
          lastLedgerId = row.ledgerId
          const usage = JSON.parse(row.usage)
          const promptTokens = usage.promptTokens ?? 0
          const completionTokens = usage.completionTokens ?? 0
          if (promptTokens > 0 || completionTokens > 0) {
            const inst = this.ctx.manager.get(instance.id)
            if (inst) {
              inst.stats.promptTokens = promptTokens
              inst.stats.completionTokens = completionTokens
              inst.stats.totalTokens = promptTokens + completionTokens
              inst.lastActivityAt = Date.now()
            }
          }
        }

        // Stale fallback: mark completed after timeout
        if (staleTimer) clearTimeout(staleTimer)
        const state = this.ctx.manager.get(instance.id)?.state
        if (state === 'thinking' || state === 'executing') {
          staleTimer = setTimeout(() => {
            const current = this.ctx.manager.get(instance.id)
            if (current && (current.state === 'thinking' || current.state === 'executing')) {
              this.ctx.manager.updateState(instance.id, 'completed')
            }
          }, STALE_TIMEOUT_MS)
        }
      } catch (err) {
        this.log('error', `Poll failed for ${instance.sessionId}: ${err}`)
      }
    }, POLL_INTERVAL_MS)

    this.watchHandles.set(instance.id, () => {
      clearInterval(interval)
      if (staleTimer) clearTimeout(staleTimer)
    })
  }

  private applyMessageState(instance: AgentInstance, msg: DimcodeMessage): void {
    const parts = parseParts(msg.parts)
    const current = this.ctx.manager.get(instance.id)
    const currentState = current?.state

    switch (msg.role) {
      case 'user':
        this.ctx.manager.recordMessage(instance.id, {
          role: 'user',
          content: extractTextContent(parts),
        })
        this.ctx.manager.updateState(instance.id, 'task_start')
        break

      case 'assistant': {
        // Check if it contains tool_use
        const hasToolUse = parts.some((p: PartsEntry) => p.type === 'tool_use')
        const hasThinking = parts.some((p: PartsEntry) => p.type === 'thinking')

        if (hasToolUse) {
          // Record tool calls
          for (const part of parts) {
            if (part.type === 'tool_use') {
              this.ctx.manager.recordToolCall(instance.id, {
                name: part.name ?? 'unknown',
                input: truncate(JSON.stringify(part.input ?? {}), 200),
                status: 'pending',
              })
            }
          }
          this.ctx.manager.updateState(instance.id, 'executing')
        } else if (hasThinking) {
          this.ctx.manager.updateState(instance.id, 'thinking')
        } else {
          // Plain assistant message — turn completed
          this.ctx.manager.recordMessage(instance.id, {
            role: 'assistant',
            content: extractTextContent(parts),
          })
          // If we were in an active state, this means the turn is done
          if (currentState === 'task_start' || currentState === 'thinking' || currentState === 'executing') {
            this.ctx.manager.updateState(instance.id, 'completed')
          }
        }
        break
      }

      case 'tool_result': {
        // Tool completed
        const isError = parts.some((p: PartsEntry) => p.is_error === true)
        // Find the tool name from parts if available
        const toolName = parts.find((p: PartsEntry) => p.type === 'tool_result')?.tool_use_id ?? 'unknown'
        this.ctx.manager.recordToolCall(instance.id, {
          name: truncate(toolName, 50),
          input: '',
          status: isError ? 'error' : 'success',
        })
        this.ctx.manager.updateState(instance.id, 'thinking')
        break
      }
    }
  }

}

// ── Helpers ─────────────────────────────────────────────────────

type PartsEntry = {
  type?: string
  name?: string
  input?: unknown
  content?: string | unknown[]
  is_error?: boolean
  tool_use_id?: string
  thinking?: string
  text?: string
}

function parseParts(partsJson: string): PartsEntry[] {
  try {
    const parsed = JSON.parse(partsJson)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function extractTextContent(parts: PartsEntry[]): string {
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') return part.text
    if (part.type === 'thinking' && typeof part.thinking === 'string') return part.thinking
    if (typeof part.content === 'string') return part.content
  }
  return ''
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/** Extract PID from dimcode heldBy format: "cli-48414@hostname" */
function extractPid(heldBy: string): number | null {
  const m = heldBy.match(/^cli-(\d+)@/)
  return m ? Number(m[1]) : null
}

/** Check if a process is still running (signal 0) */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
