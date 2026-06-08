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
 * 2. SESSION FILES (secondary, for discovery only):
 *    Session JSONL files in ~/.claude/projects/<project>/<uuid>.jsonl
 *    Used only to discover active sessions and attach metadata.
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
    const candidates: Array<{ descriptor: AgentDescriptor; mtimeMs: number }> = []

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

          candidates.push({
            descriptor: {
              type: this.type,
              kind: this.kind,
              displayName: `${this.displayName} (${basename(projectPath)})`,
              sessionId: entry.replace('.jsonl', ''),
              projectPath,
              watchPath: sessionPath,
            },
            mtimeMs: st.mtimeMs,
          })
        }
      }
    } catch {
      // ~/.claude doesn't exist
    }

    if (!candidates.length) return []

    // Track all active sessions, not just the latest one
    const activeSessionIds = new Set(candidates.map(c => c.descriptor.sessionId))

    // Unregister stale instances that are no longer in the candidate set
    for (const instance of this.ctx.manager.getByType(this.type)) {
      if (instance.hookManaged) continue
      if (activeSessionIds.has(instance.sessionId!)) continue
      await this.stopWatching(instance.id)
      this.ctx.manager.unregister(instance.id)
    }

    return candidates.map(c => c.descriptor)
  }

  async startWatching(instance: AgentInstance): Promise<void> {
    if (!instance.watchPath) return
    void instance
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
