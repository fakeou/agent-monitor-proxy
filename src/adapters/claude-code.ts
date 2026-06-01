/**
 * Agent Monitor Proxy — Claude Code Adapter
 *
 * Two complementary monitoring strategies:
 *
 * 1. HOOKS (primary, real-time):
 *    Claude Code calls a hook script on events (PreToolUse, PostToolUse, Stop, etc.)
 *    The hook script POSTs data to AMP's /api/hooks/claude-code endpoint.
 *    → Zero polling, instant state updates
 *
 * 2. SESSION FILES (secondary, for history/token counting):
 *    Session JSONL files in ~/.claude/projects/<project>/<uuid>.jsonl
 *    Parsed on discovery to extract historical token usage.
 *    → One-time scan, no ongoing polling
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { AgentDescriptor, AgentInstance, AgentState } from '../core/types.js'
import { BaseAdapter } from './base.js'

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly type = 'claude-code'
  readonly kind = 'cli' as const
  readonly displayName = 'Claude Code'

  private sessionDir = ''

  async init(ctx: import('./base.js').AdapterContext): Promise<void> {
    await super.init(ctx)
    this.sessionDir = this.resolveHome('~/.claude')
  }

  /**
   * Discover existing Claude Code sessions.
   * Used for initial registration — real-time updates come via hooks.
   */
  async discover(): Promise<AgentDescriptor[]> {
    const descriptors: AgentDescriptor[] = []

    try {
      const projectsDir = join(this.sessionDir, 'projects')
      const projects = await readdirSafe(projectsDir)

      for (const project of projects) {
        const projectDir = join(projectsDir, project)
        const projectPath = decodeProjectPath(project)

        const entries = await readdirSafe(projectDir)
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue

          const sessionPath = join(projectDir, entry)
          const st = await statSafe(sessionPath)
          if (!st) continue

          // Include sessions from last 72 hours
          if (Date.now() - st.mtimeMs > 72 * 60 * 60 * 1000) continue

          descriptors.push({
            type: this.type,
            kind: this.kind,
            displayName: `${this.displayName} (${basename(projectPath)})`,
            sessionId: entry.replace('.jsonl', ''),
            projectPath,
            watchPath: sessionPath,
          })
        }
      }
    } catch {
      // ~/.claude doesn't exist
    }

    return descriptors
  }

  /**
   * Start watching — for Claude Code, this is a no-op.
   * Real-time monitoring is handled by hooks posting to /api/hooks/claude-code.
   * We just do an initial token usage scan of the session file.
   */
  async startWatching(instance: AgentInstance): Promise<void> {
    if (!instance.watchPath) return

    // One-time scan: extract historical token usage from the session file
    this.scanTokenUsage(instance.id, instance.watchPath)
  }

  /**
   * Scan a session file for token usage data (one-time, not ongoing).
   */
  private async scanTokenUsage(instanceId: string, filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')

      let totalPrompt = 0
      let totalCompletion = 0

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'assistant' && entry.usage) {
            totalPrompt += entry.usage.input_tokens ?? 0
            totalCompletion += entry.usage.output_tokens ?? 0
          }
        } catch { /* skip */ }
      }

      if (totalPrompt > 0 || totalCompletion > 0) {
        this.ctx.bus.emit({
          type: 'token_usage',
          instanceId,
          timestamp: Date.now(),
          data: {
            promptTokens: totalPrompt,
            completionTokens: totalCompletion,
            totalTokens: totalPrompt + totalCompletion,
            source: 'historical_scan',
          },
        })
      }
    } catch {
      // Can't read file — that's fine
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function decodeProjectPath(encoded: string): string {
  return '/' + encoded.replace(/^-/, '').replace(/-/g, '/')
}

async function readdirSafe(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

async function statSafe(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(path)
    return { size: Number(s.size), mtimeMs: Number(s.mtimeMs) }
  } catch { return null }
}
