import { describe, expect, test } from 'vitest'
import { EventBus } from '../src/core/bus.js'
import { InstanceManager } from '../src/core/manager.js'
import { AgentStateController } from '../src/core/state-controller.js'

describe('AgentStateController', () => {
  test('drives a single active Codex CLI session from hook events', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexHook({
      session_id: 'codex-session-a',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/project-a',
      prompt: 'fix the tests',
    })
    controller.handleCodexHook({
      session_id: 'codex-session-a',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    })

    const codex = manager.getByType('codex')
    expect(codex).toHaveLength(1)
    expect(codex[0]?.state).toBe('executing')
    expect(codex[0]?.projectPath).toBe('/tmp/project-a')

    controller.handleCodexHook({
      session_id: 'codex-session-b',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/project-b',
      prompt: 'continue',
    })

    const active = manager.getByType('codex')
    expect(active).toHaveLength(1)
    expect(active[0]?.sessionId).toBe('codex-session-b')
    expect(active[0]?.state).toBe('task_start')
  })

  test('maps Claude Code Stop to completed instead of idle', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({
      session_id: 'claude-session',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/claude-project',
      prompt: 'work',
    })
    controller.handleClaudeHook({
      session_id: 'claude-session',
      hook_event_name: 'Stop',
    })

    const instance = manager.getByType('claude-code')[0]
    expect(instance?.state).toBe('completed')
    expect(bus.getHistory({ type: 'completed' })).toHaveLength(1)
  })

  test('maps Codex app-server turn notifications to active and terminal states', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: {
        thread: {
          id: 'thread-a',
          cwd: '/tmp/app-project',
          name: 'App Project',
          status: { type: 'active' },
          ephemeral: false,
        },
      },
    })
    controller.handleCodexAppNotification({
      method: 'turn/started',
      params: {
        threadId: 'thread-a',
        turn: { id: 'turn-a', status: 'in_progress' },
      },
    })
    expect(manager.getByType('codex-app')[0]?.state).toBe('thinking')

    controller.handleCodexAppNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-a',
        turn: { id: 'turn-a', status: 'interrupted' },
      },
    })

    const instance = manager.getByType('codex-app')[0]
    expect(instance?.state).toBe('interrupted')
    expect(bus.getHistory({ type: 'completed' }).at(-1)?.data).toMatchObject({
      reason: 'turn_interrupted',
      session_id: 'thread-a',
    })
  })
})
