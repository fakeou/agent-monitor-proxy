/**
 * End-to-end state verification tests.
 *
 * Traces every hook event for Claude Code and Codex through the
 * AgentStateController → InstanceManager → EventBus pipeline,
 * verifying that the state_change events emitted to external
 * consumers (WebSocket/SSE) are correct.
 */

import { describe, expect, test } from 'vitest'
import { EventBus } from '../src/core/bus.js'
import { InstanceManager } from '../src/core/manager.js'
import { AgentStateController } from '../src/core/state-controller.js'
import type { AgentState } from '../src/core/types.js'

function collectStateChanges(bus: EventBus): Array<{ from: AgentState; to: AgentState }> {
  return bus.getHistory({ type: 'state_change' }).map((e) => ({
    from: (e.data as { previousState: AgentState }).previousState,
    to: (e.data as { newState: AgentState }).newState,
  }))
}

describe('Claude Code state transitions (hook → bus)', () => {
  test('full lifecycle: SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    // SessionStart: register sets state to 'idle', SessionStart sets to 'idle' again → no event (same state)
    controller.handleClaudeHook({
      session_id: 's1',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/project',
    })
    expect(collectStateChanges(bus)).toEqual([])

    controller.handleClaudeHook({
      session_id: 's1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix the bug',
    })
    expect(collectStateChanges(bus)).toEqual([
      { from: 'idle', to: 'task_start' },
    ])

    controller.handleClaudeHook({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    })
    expect(collectStateChanges(bus).at(-1)).toEqual({ from: 'task_start', to: 'executing' })

    controller.handleClaudeHook({
      session_id: 's1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_output: 'All tests passed',
    })
    expect(collectStateChanges(bus).at(-1)).toEqual({ from: 'executing', to: 'thinking' })

    controller.handleClaudeHook({
      session_id: 's1',
      hook_event_name: 'Stop',
    })
    expect(collectStateChanges(bus).at(-1)).toEqual({ from: 'thinking', to: 'completed' })
  })

  test('Notification, UserPrompt, PermissionRequest all emit waiting_input', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 's2', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    bus.clearHistory()

    for (const eventName of ['Notification', 'UserPrompt', 'PermissionRequest'] as const) {
      controller.handleClaudeHook({ session_id: 's2', hook_event_name: eventName })
      const last = collectStateChanges(bus).at(-1)
      expect(last?.to, `${eventName} should emit waiting_input`).toBe('waiting_input')
    }
  })

  test('PostToolUse with AskUserQuestion emits waiting_input instead of thinking', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 's3', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 's3', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' })
    bus.clearHistory()

    controller.handleClaudeHook({
      session_id: 's3',
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion',
      tool_output: '{"question":"Which approach?"}',
    })

    const last = collectStateChanges(bus).at(-1)
    expect(last?.to).toBe('waiting_input')
  })

  test('completed event is emitted on Stop with correct reason', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 's4', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 's4', hook_event_name: 'Stop' })

    const completed = bus.getHistory({ type: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.data).toMatchObject({
      reason: 'claude-code_stop',
      session_id: 's4',
      agentType: 'claude-code',
    })
  })

  test('hookManaged is cleared on Stop so discovery can take over', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 's5', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    const instance = manager.getByType('claude-code')[0]!
    expect(instance.hookManaged).toBe(true)

    controller.handleClaudeHook({ session_id: 's5', hook_event_name: 'Stop' })
    expect(instance.hookManaged).toBe(false)
  })
})

describe('Codex CLI state transitions (hook → bus)', () => {
  test('full lifecycle: UserPromptSubmit → PreToolUse → PostToolUse → Stop', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexHook({
      session_id: 'c1',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/codex-project',
      prompt: 'run tests',
    })
    expect(collectStateChanges(bus)).toEqual([{ from: 'idle', to: 'task_start' }])

    controller.handleCodexHook({
      session_id: 'c1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    })
    expect(collectStateChanges(bus).at(-1)).toEqual({ from: 'task_start', to: 'executing' })

    controller.handleCodexHook({
      session_id: 'c1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_output: 'Tests passed',
    })
    expect(collectStateChanges(bus).at(-1)).toEqual({ from: 'executing', to: 'thinking' })

    controller.handleCodexHook({
      session_id: 'c1',
      hook_event_name: 'Stop',
    })
    expect(collectStateChanges(bus).at(-1)).toEqual({ from: 'thinking', to: 'completed' })
  })

  test('completed event is emitted on Stop with correct reason', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexHook({ session_id: 'c2', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleCodexHook({ session_id: 'c2', hook_event_name: 'Stop' })

    const completed = bus.getHistory({ type: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.data).toMatchObject({
      reason: 'codex_stop',
      session_id: 'c2',
      agentType: 'codex',
    })
  })

  test('Notification/UserPrompt/PermissionRequest emit waiting_input', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexHook({ session_id: 'c3', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    bus.clearHistory()

    for (const eventName of ['Notification', 'UserPrompt', 'PermissionRequest'] as const) {
      controller.handleCodexHook({ session_id: 'c3', hook_event_name: eventName })
      const last = collectStateChanges(bus).at(-1)
      expect(last?.to, `${eventName} should emit waiting_input`).toBe('waiting_input')
    }
  })
})

describe('Codex App state transitions (notification → bus)', () => {
  test('thread/started → turn/started → turn/completed lifecycle', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: {
        thread: {
          id: 't1',
          cwd: '/tmp/app',
          name: 'My App',
          status: { type: 'active' },
          ephemeral: false,
        },
      },
    })
    expect(manager.getByType('codex-app')[0]?.state).toBe('thinking')

    controller.handleCodexAppNotification({
      method: 'turn/started',
      params: { threadId: 't1' },
    })
    expect(collectStateChanges(bus).at(-1)?.to).toBe('thinking')

    controller.handleCodexAppNotification({
      method: 'turn/completed',
      params: {
        threadId: 't1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    })
    expect(collectStateChanges(bus).at(-1)?.to).toBe('completed')
    expect(bus.getHistory({ type: 'completed' }).at(-1)?.data).toMatchObject({
      reason: 'turn_completed',
      session_id: 't1',
    })
  })

  test('turn/completed with interrupted status emits interrupted', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 't2', status: { type: 'active' }, ephemeral: false } },
    })
    controller.handleCodexAppNotification({
      method: 'turn/started',
      params: { threadId: 't2' },
    })
    bus.clearHistory()

    controller.handleCodexAppNotification({
      method: 'turn/completed',
      params: { threadId: 't2', turn: { status: 'interrupted' } },
    })

    expect(manager.getByType('codex-app')[0]?.state).toBe('interrupted')
    expect(bus.getHistory({ type: 'completed' }).at(-1)?.data).toMatchObject({
      reason: 'turn_interrupted',
    })
  })

  test('turn/completed with failed status emits failed', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 't3', status: { type: 'active' }, ephemeral: false } },
    })
    controller.handleCodexAppNotification({
      method: 'turn/started',
      params: { threadId: 't3' },
    })
    bus.clearHistory()

    controller.handleCodexAppNotification({
      method: 'turn/completed',
      params: { threadId: 't3', turn: { status: 'failed' } },
    })

    expect(manager.getByType('codex-app')[0]?.state).toBe('failed')
    expect(bus.getHistory({ type: 'completed' }).at(-1)?.data).toMatchObject({
      reason: 'turn_failed',
    })
  })

  test('thread/status/changed with waitingOnApproval emits waiting_input', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 't4', status: { type: 'active' }, ephemeral: false } },
    })
    bus.clearHistory()

    controller.handleCodexAppNotification({
      method: 'thread/status/changed',
      params: {
        threadId: 't4',
        status: { type: 'active', isWaitingOnApproval: true },
      },
    })

    expect(manager.getByType('codex-app')[0]?.state).toBe('waiting_input')
  })

  test('thread/status/changed with waitingOnUserInput emits waiting_input', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 't5', status: { type: 'active' }, ephemeral: false } },
    })
    bus.clearHistory()

    controller.handleCodexAppNotification({
      method: 'thread/status/changed',
      params: {
        threadId: 't5',
        status: { type: 'active', waitingOnUserInput: true },
      },
    })

    expect(manager.getByType('codex-app')[0]?.state).toBe('waiting_input')
  })

  test('thread/closed emits completed', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 't6', status: { type: 'active' }, ephemeral: false } },
    })
    bus.clearHistory()

    controller.handleCodexAppNotification({
      method: 'thread/closed',
      params: { threadId: 't6' },
    })

    expect(manager.getByType('codex-app')[0]?.state).toBe('completed')
    expect(bus.getHistory({ type: 'completed' }).at(-1)?.data).toMatchObject({
      reason: 'thread_closed',
      session_id: 't6',
    })
  })

  test('ephemeral threads are ignored', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    const result = controller.handleCodexAppNotification({
      method: 'thread/started',
      params: {
        thread: { id: 'eph-1', status: { type: 'active' }, ephemeral: true },
      },
    })

    expect(result).toBeNull()
    expect(manager.getByType('codex-app')).toHaveLength(0)
  })

  test('invalid threadId returns null without error', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    expect(controller.handleCodexAppNotification({
      method: 'turn/started',
      params: {},
    })).toBeNull()

    expect(controller.handleCodexAppNotification({
      method: 'turn/completed',
      params: { turn: { status: 'completed' } },
    })).toBeNull()
  })
})

describe('External consumer event stream verification', () => {
  test('WebSocket/SSE consumers see correct state_change sequence for a Claude Code session', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    // Simulate a full Claude Code session
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'SessionStart', cwd: '/tmp/ws-project' })
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'UserPromptSubmit', prompt: 'do something' })
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/index.ts' } })
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_output: 'export const foo = 42' })
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/index.ts' } })
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_output: 'File edited' })
    controller.handleClaudeHook({ session_id: 'ws1', hook_event_name: 'Stop' })

    const stateChanges = collectStateChanges(bus)
    expect(stateChanges).toEqual([
      { from: 'idle', to: 'task_start' },      // UserPromptSubmit
      { from: 'task_start', to: 'executing' }, // PreToolUse (Read)
      { from: 'executing', to: 'thinking' }, // PostToolUse (Read)
      { from: 'thinking', to: 'executing' }, // PreToolUse (Edit)
      { from: 'executing', to: 'thinking' }, // PostToolUse (Edit)
      { from: 'thinking', to: 'completed' }, // Stop
    ])

    // Verify tool_call and tool_result events
    const toolCalls = bus.getHistory({ type: 'tool_call' })
    const toolResults = bus.getHistory({ type: 'tool_result' })
    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)
    expect(toolCalls[0]?.data).toMatchObject({ name: 'Read', status: 'pending' })
    expect(toolResults[0]?.data).toMatchObject({ name: 'Read', status: 'success' })

    // Verify completed event
    const completed = bus.getHistory({ type: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.data).toMatchObject({ reason: 'claude-code_stop' })
  })

  test('WebSocket/SSE consumers see correct state_change sequence for a Codex CLI session', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexHook({ session_id: 'ws2', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/codex-ws', prompt: 'fix bug' })
    controller.handleCodexHook({ session_id: 'ws2', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git diff' } })
    controller.handleCodexHook({ session_id: 'ws2', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_output: 'diff output here' })
    controller.handleCodexHook({ session_id: 'ws2', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'fix.ts' } })
    controller.handleCodexHook({ session_id: 'ws2', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_output: 'Written' })
    controller.handleCodexHook({ session_id: 'ws2', hook_event_name: 'Stop' })

    const stateChanges = collectStateChanges(bus)
    expect(stateChanges).toEqual([
      { from: 'idle', to: 'task_start' },
      { from: 'task_start', to: 'executing' },
      { from: 'executing', to: 'thinking' },
      { from: 'thinking', to: 'executing' },
      { from: 'executing', to: 'thinking' },
      { from: 'thinking', to: 'completed' },
    ])

    const completed = bus.getHistory({ type: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.data).toMatchObject({ reason: 'codex_stop' })
  })

  test('state_change events include currentTaskTokens for external consumers', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'tk1', hook_event_name: 'UserPromptSubmit', prompt: 'analyze' })
    // Must send PreToolUse first to change state to 'executing', otherwise PostToolUse
    // sets 'thinking' → 'thinking' (same state, no event emitted)
    controller.handleClaudeHook({ session_id: 'tk1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
    controller.handleClaudeHook({
      session_id: 'tk1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_output: 'A'.repeat(400), // ~100 tokens
    })

    const stateChanges = bus.getHistory({ type: 'state_change' })
    const lastChange = stateChanges.at(-1)
    expect(lastChange?.data).toMatchObject({
      newState: 'thinking',
      agentType: 'claude-code',
      currentTaskTokens: expect.objectContaining({
        completionTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      }),
    })
    expect((lastChange?.data as { currentTaskTokens: { completionTokens: number } }).currentTaskTokens.completionTokens).toBeGreaterThan(0)
  })

  test('multiple concurrent sessions are tracked independently', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    // Claude Code session
    controller.handleClaudeHook({ session_id: 'multi-claude', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 'multi-claude', hook_event_name: 'PreToolUse', tool_name: 'Read' })

    // Codex session (different type, can coexist)
    controller.handleCodexHook({ session_id: 'multi-codex', hook_event_name: 'UserPromptSubmit', prompt: 'go' })

    const claudeInstances = manager.getByType('claude-code')
    const codexInstances = manager.getByType('codex')

    expect(claudeInstances).toHaveLength(1)
    expect(claudeInstances[0]?.state).toBe('executing')
    expect(codexInstances).toHaveLength(1)
    expect(codexInstances[0]?.state).toBe('task_start')

    // Both should have state_change events
    const claudeEvents = bus.getHistory({ type: 'state_change' }).filter(
      (e) => e.instanceId === claudeInstances[0]?.id,
    )
    const codexEvents = bus.getHistory({ type: 'state_change' }).filter(
      (e) => e.instanceId === codexInstances[0]?.id,
    )
    expect(claudeEvents.length).toBeGreaterThanOrEqual(2)
    expect(codexEvents.length).toBeGreaterThanOrEqual(1)
  })

  test('new session of same type replaces old one (CLI single-session behavior)', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'old-session', hook_event_name: 'UserPromptSubmit', prompt: 'task 1' })
    expect(manager.getByType('claude-code')).toHaveLength(1)
    expect(manager.getByType('claude-code')[0]?.sessionId).toBe('old-session')

    controller.handleClaudeHook({ session_id: 'new-session', hook_event_name: 'UserPromptSubmit', prompt: 'task 2' })
    expect(manager.getByType('claude-code')).toHaveLength(1)
    expect(manager.getByType('claude-code')[0]?.sessionId).toBe('new-session')
    expect(manager.getByType('claude-code')[0]?.state).toBe('task_start')

    // Old session should have been unregistered (emitted instance_lost)
    const lost = bus.getHistory({ type: 'instance_lost' })
    expect(lost).toHaveLength(1)
    expect(lost[0]?.data).toMatchObject({ type: 'claude-code', reason: 'process_exited' })
  })
})

describe('State protection (Open Island patterns)', () => {
  test('terminal state: stale hooks do not overwrite completed', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'term1', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 'term1', hook_event_name: 'Stop' })

    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')

    // Stale hooks arriving after Stop must not change state
    controller.handleClaudeHook({ session_id: 'term1', hook_event_name: 'Notification' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')

    controller.handleClaudeHook({ session_id: 'term1', hook_event_name: 'PreToolUse', tool_name: 'Read' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')

    controller.handleClaudeHook({ session_id: 'term1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_output: 'data' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')

    controller.handleClaudeHook({ session_id: 'term1', hook_event_name: 'PermissionRequest' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')

    // Only one state_change to completed, no further changes
    const stateChanges = collectStateChanges(bus)
    const completedChanges = stateChanges.filter((s) => s.to === 'completed')
    expect(completedChanges).toHaveLength(1)
  })

  test('terminal state: UserPromptSubmit can escape completed to start new task', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'escape1', hook_event_name: 'UserPromptSubmit', prompt: 'task 1' })
    controller.handleClaudeHook({ session_id: 'escape1', hook_event_name: 'Stop' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')

    // New user prompt starts a fresh task
    controller.handleClaudeHook({ session_id: 'escape1', hook_event_name: 'UserPromptSubmit', prompt: 'task 2' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('task_start')

    const stateChanges = collectStateChanges(bus)
    expect(stateChanges.at(-1)).toEqual({ from: 'completed', to: 'task_start' })
  })

  test('actionable state: PreToolUse does not overwrite waiting_input', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'act1', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 'act1', hook_event_name: 'Notification' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('waiting_input')

    // PreToolUse should NOT change state from waiting_input
    controller.handleClaudeHook({ session_id: 'act1', hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('waiting_input')

    // But tool call should still be recorded
    const toolCalls = bus.getHistory({ type: 'tool_call' })
    expect(toolCalls.some((t) => t.data.name === 'Bash')).toBe(true)
  })

  test('actionable state: PostToolUse does not overwrite waiting_input but still tracks tokens', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'act2', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 'act2', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' })
    controller.handleClaudeHook({ session_id: 'act2', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_output: 'Pick an option' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('waiting_input')

    // Stale PostToolUse should NOT change state from waiting_input
    controller.handleClaudeHook({ session_id: 'act2', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_output: 'file contents here' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('waiting_input')

    // But tool result and tokens should still be recorded
    const toolResults = bus.getHistory({ type: 'tool_result' })
    expect(toolResults.some((t) => t.data.name === 'Read')).toBe(true)
  })

  test('actionable state: Stop can still transition waiting_input to completed', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleClaudeHook({ session_id: 'act3', hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    controller.handleClaudeHook({ session_id: 'act3', hook_event_name: 'Notification' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('waiting_input')

    controller.handleClaudeHook({ session_id: 'act3', hook_event_name: 'Stop' })
    expect(manager.getByType('claude-code')[0]?.state).toBe('completed')
  })

  test('terminal state: Codex thread/closed is protected from stale turn/started', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 'closed-1', status: { type: 'active' } } },
    })
    controller.handleCodexAppNotification({
      method: 'thread/closed',
      params: { threadId: 'closed-1' },
    })
    expect(manager.getByType('codex-app')[0]?.state).toBe('completed')

    // Stale turn/started should not overwrite completed
    controller.handleCodexAppNotification({
      method: 'turn/started',
      params: { threadId: 'closed-1', turn: { id: 'stale-turn' } },
    })
    expect(manager.getByType('codex-app')[0]?.state).toBe('completed')
  })

  test('interrupted is recoverable: turn/started can transition from interrupted to thinking', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const controller = new AgentStateController(manager, bus)

    controller.handleCodexAppNotification({
      method: 'thread/started',
      params: { thread: { id: 'rec-1', status: { type: 'active' } } },
    })
    controller.handleCodexAppNotification({
      method: 'turn/completed',
      params: { threadId: 'rec-1', turn: { status: 'interrupted' } },
    })
    expect(manager.getByType('codex-app')[0]?.state).toBe('interrupted')

    // New turn can start from interrupted (it's a recoverable state)
    controller.handleCodexAppNotification({
      method: 'turn/started',
      params: { threadId: 'rec-1', turn: { id: 'new-turn' } },
    })
    expect(manager.getByType('codex-app')[0]?.state).toBe('thinking')
  })
})
