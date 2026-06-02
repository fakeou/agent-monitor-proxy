import { readFileSync } from 'node:fs'
import type { EventBus } from './bus.js'
import type { AgentDescriptor, AgentInstance, AgentState } from './types.js'
import type { InstanceManager } from './manager.js'

type JsonObject = Record<string, unknown>

export interface AgentHookPayload extends JsonObject {
  session_id?: string
  hook_event_name?: string
  cwd?: string
  transcript_path?: string
  prompt?: string
  tool_name?: string
  tool_input?: unknown
  tool_output?: unknown
}

export interface CodexAppNotification {
  method: string
  params?: unknown
}

export class AgentStateController {
  constructor(
    private readonly manager: InstanceManager,
    private readonly bus: EventBus,
  ) {}

  handleCodexHook(payload: AgentHookPayload): AgentInstance {
    const instance = this.ensureCurrentSession({
      type: 'codex',
      kind: 'cli',
      displayName: displayName('Codex CLI', payload.cwd, payload.session_id),
      sessionId: sessionId(payload),
      projectPath: stringValue(payload.cwd),
      watchPath: stringValue(payload.transcript_path),
    })

    this.applyHookLifecycle(instance, payload, 'codex')
    return instance
  }

  handleClaudeHook(payload: AgentHookPayload): AgentInstance {
    const instance = this.ensureCurrentSession({
      type: 'claude-code',
      kind: 'cli',
      displayName: displayName('Claude Code', payload.cwd, payload.session_id),
      sessionId: sessionId(payload),
      projectPath: stringValue(payload.cwd),
      watchPath: stringValue(payload.transcript_path),
    })

    this.applyHookLifecycle(instance, payload, 'claude-code')
    return instance
  }

  handleCodexAppNotification(notification: CodexAppNotification): AgentInstance | null {
    const params = objectValue(notification.params)

    switch (notification.method) {
      case 'thread/started': {
        const thread = objectValue(params.thread)
        if (thread.ephemeral === true) return null
        const instance = this.ensureCodexAppThread(thread)
        this.updateState(instance, stateFromCodexThreadStatus(objectValue(thread.status)))
        return instance
      }

      case 'thread/status/changed': {
        const threadId = stringValue(params.threadId)
        if (!threadId) return null
        const instance = this.ensureCodexAppThread({ id: threadId })
        this.updateState(instance, stateFromCodexThreadStatus(objectValue(params.status)))
        return instance
      }

      case 'turn/started': {
        const threadId = stringValue(params.threadId)
        if (!threadId) return null
        const instance = this.ensureCodexAppThread({ id: threadId })
        this.updateState(instance, 'thinking')
        return instance
      }

      case 'turn/completed': {
        const threadId = stringValue(params.threadId)
        if (!threadId) return null
        const turn = objectValue(params.turn)
        const status = stringValue(turn.status)
        const instance = this.ensureCodexAppThread({ id: threadId })
        const state: AgentState = status === 'interrupted'
          ? 'interrupted'
          : status === 'failed'
            ? 'failed'
            : 'completed'
        this.updateState(instance, state)
        this.emitCompleted(instance, state === 'interrupted' ? 'turn_interrupted' : status === 'failed' ? 'turn_failed' : 'turn_completed')
        return instance
      }

      case 'thread/closed': {
        const threadId = stringValue(params.threadId)
        if (!threadId) return null
        const instance = this.ensureCodexAppThread({ id: threadId })
        this.updateState(instance, 'completed')
        this.emitCompleted(instance, 'thread_closed')
        return instance
      }

      default:
        return null
    }
  }

  private applyHookLifecycle(instance: AgentInstance, payload: AgentHookPayload, agentType: string): void {
    const eventName = stringValue(payload.hook_event_name)

    switch (eventName) {
      case 'SessionStart':
        this.updateState(instance, 'idle')
        break

      case 'UserPromptSubmit':
        if (typeof payload.prompt === 'string' && payload.prompt.trim()) {
          this.manager.recordMessage(instance.id, {
            role: 'user',
            content: payload.prompt,
          })
          this.manager.addCurrentTaskTokens(instance.id, {
            promptTokens: estimateTokens(payload.prompt),
          })
        }
        this.updateState(instance, 'thinking')
        break

      case 'PreToolUse':
        this.manager.recordToolCall(instance.id, {
          name: stringValue(payload.tool_name) ?? 'unknown',
          input: preview(payload.tool_input),
          status: 'pending',
        })
        this.updateState(instance, 'executing')
        break

      case 'PostToolUse':
        this.manager.recordToolCall(instance.id, {
          name: stringValue(payload.tool_name) ?? 'unknown',
          input: preview(payload.tool_input),
          status: outputLooksFailed(payload.tool_output) ? 'error' : 'success',
        })
        if (typeof payload.tool_output === 'string' && payload.tool_output.trim()) {
          this.manager.addCurrentTaskTokens(instance.id, {
            completionTokens: estimateTokens(payload.tool_output),
          })
        }
        this.updateState(instance, 'thinking')
        break

      case 'Notification':
      case 'UserPrompt':
      case 'PermissionRequest':
        this.updateState(instance, 'waiting_input')
        break

      case 'Stop': {
        this.updateState(instance, 'completed')

        // Read real token usage from transcript JSONL and commit only the
        // delta since last settlement (avoids double-counting across Stops).
        if (instance.watchPath) {
          try {
            const total = readTranscriptTokens(instance.watchPath)
            const alreadySettled = instance.stats.totalTokens
            const delta = Math.max(0, total.totalTokens - alreadySettled)
            if (delta > 0) {
              // Split delta proportionally between input/output
              const ratio = total.totalTokens > 0 ? delta / total.totalTokens : 1
              this.manager.updateCurrentTokenBucket(instance.id, {
                promptTokens: Math.round(total.inputTokens * ratio),
                completionTokens: Math.round(total.outputTokens * ratio),
                totalTokens: delta,
              })
            }
          } catch {
            // Transcript read failed — fall back to estimates from addCurrentTaskTokens
          }
        }

        this.manager.commitTokenBucket(instance.id, `${agentType}_stop`)
        instance.hookManaged = false
        this.emitCompleted(instance, `${agentType}_stop`)
        break
      }

      default:
        break
    }
  }

  private ensureCodexAppThread(thread: JsonObject): AgentInstance {
    const id = stringValue(thread.id) ?? 'unknown'
    const cwd = stringValue(thread.cwd)
    return this.ensureCurrentSession({
      type: 'codex-app',
      kind: 'app',
      displayName: displayName('Codex App', cwd, stringValue(thread.name) ?? id),
      sessionId: id,
      projectPath: cwd,
      watchPath: stringValue(thread.path),
    })
  }

  private ensureCurrentSession(descriptor: AgentDescriptor): AgentInstance {
    for (const existing of this.manager.getByType(descriptor.type)) {
      if (existing.sessionId === descriptor.sessionId) continue
      this.manager.unregister(existing.id)
    }

    const instance = this.manager.register(descriptor)
    if (descriptor.projectPath) instance.projectPath = descriptor.projectPath
    if (descriptor.watchPath) instance.watchPath = descriptor.watchPath
    instance.displayName = descriptor.displayName
    instance.hookManaged = true
    return instance
  }

  private updateState(instance: AgentInstance, state: AgentState): void {
    this.manager.updateState(instance.id, state)
  }

  private emitCompleted(instance: AgentInstance, reason: string): void {
    this.bus.emit({
      type: 'completed',
      instanceId: instance.id,
      timestamp: Date.now(),
      data: {
        reason,
        session_id: instance.sessionId,
        agentType: instance.type,
      },
    })
  }
}

function sessionId(payload: AgentHookPayload): string {
  return stringValue(payload.session_id) ?? 'unknown'
}

function displayName(prefix: string, cwd?: unknown, fallback?: unknown): string {
  const project = basename(stringValue(cwd))
  if (project) return `${prefix} (${project})`
  const suffix = stringValue(fallback)
  return suffix ? `${prefix} (${suffix.slice(0, 8)})` : prefix
}

function basename(path?: string): string | null {
  if (!path) return null
  const clean = path.replace(/\/+$/, '')
  const value = clean.split('/').filter(Boolean).at(-1)
  return value || null
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 200)
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value).slice(0, 200)
  } catch {
    return String(value).slice(0, 200)
  }
}

function outputLooksFailed(value: unknown): boolean {
  const text = preview(value).toLowerCase()
  return text.includes('error') || text.includes('failed')
}

/** Rough token estimate: ~4 characters per token for mixed Chinese/English text. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function readTranscriptTokens(filePath: string): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.trim().split('\n')
  const seen = new Set<string>()
  let inputTokens = 0
  let outputTokens = 0

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'assistant') continue
      const msg = entry.message
      if (!msg?.usage) continue
      const msgId = msg.id
      if (!msgId || seen.has(msgId)) continue
      seen.add(msgId)
      inputTokens += Number(msg.usage.input_tokens ?? 0)
      outputTokens += Number(msg.usage.output_tokens ?? 0)
    } catch {
      // Skip unparseable lines
    }
  }

  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function stateFromCodexThreadStatus(status: JsonObject): AgentState {
  const type = stringValue(status.type)
  if (type === 'active') {
    if (status.isWaitingOnApproval === true || status.waitingOnApproval === true) return 'waiting_input'
    if (status.isWaitingOnUserInput === true || status.waitingOnUserInput === true) return 'waiting_input'
    return 'thinking'
  }
  if (type === 'idle') return 'completed'
  if (type === 'systemError') return 'failed'
  return 'completed'
}
