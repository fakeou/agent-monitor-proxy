import { mkdtemp, mkdir, writeFile, appendFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'
import { EventBus } from '../src/core/bus.js'
import { InstanceManager } from '../src/core/manager.js'

describe('CodexAdapter', () => {
  test('writes state changes through the instance manager path', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })

    const updateStateSpy = vi.spyOn(manager, 'updateState')
    const descriptor = {
      type: 'event_msg',
      payload: {
        type: 'user_message',
      },
    }

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify(descriptor),
      'idle',
    )

    expect(result.state).toBe('thinking')
    expect(updateStateSpy).toHaveBeenCalledWith(instance.id, 'thinking')
  })

  test('returns to idle when a codex task completes', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    manager.updateState(instance.id, 'thinking')

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete' },
      }),
      'thinking',
    )

    expect(result.state).toBe('idle')
    expect(manager.get(instance.id)?.state).toBe('idle')
  })

  test('maps codex turn_aborted to interrupted instead of failed', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    manager.updateState(instance.id, 'thinking')

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'turn_aborted' },
      }),
      'thinking',
    )

    expect(result.state).toBe('interrupted')
    expect(manager.get(instance.id)?.state).toBe('interrupted')
  })

  test('keeps codex token_count in the current task bucket and settles once on completion', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    const parser = adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }

    parser.parseLine(
      instance.id,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      'idle',
    )
    parser.parseLine(
      instance.id,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 110, output_tokens: 12, total_tokens: 122 },
            last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      }),
      'thinking',
    )

    expect(manager.get(instance.id)?.currentTaskTokens).toMatchObject({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    })
    expect(bus.getHistory({ type: 'token_usage' })).toHaveLength(0)
    const updateEvents = bus.getHistory({ type: 'token_update' })
    expect(updateEvents.at(-1)?.data).toMatchObject({
      updateKind: 'delta',
      deltaTokens: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      },
      currentTaskTokens: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      },
    })

    parser.parseLine(
      instance.id,
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'pwd',
          status: 'in_progress',
        },
      }),
      'thinking',
    )

    const executingEvent = bus.getHistory({ type: 'state_change' }).at(-1)
    expect(executingEvent?.data).toMatchObject({
      newState: 'executing',
      currentTaskTokens: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      },
    })

    parser.parseLine(
      instance.id,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      'thinking',
    )

    const tokenEvents = bus.getHistory({ type: 'token_usage' })
    expect(tokenEvents).toHaveLength(1)
    expect(tokenEvents[0]?.data).toMatchObject({
      settlementId: expect.any(String),
      settledTokens: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      },
      reason: 'task_complete',
    })
    expect(manager.get(instance.id)?.currentTaskTokens.totalTokens).toBe(0)
  })

  test('uses codex cumulative totals as a delta to avoid duplicate token_count entries', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    const parser = adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }

    parser.parseLine(
      instance.id,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      'idle',
    )

    const firstTokenCount = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 110, output_tokens: 12, total_tokens: 122 },
          last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      },
    })

    parser.parseLine(instance.id, firstTokenCount, 'thinking')
    parser.parseLine(instance.id, firstTokenCount, 'thinking')
    parser.parseLine(
      instance.id,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 125, output_tokens: 15, total_tokens: 140 },
            last_token_usage: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
          },
        },
      }),
      'thinking',
    )

    parser.parseLine(
      instance.id,
      JSON.stringify({ type: 'turn.completed' }),
      'thinking',
    )

    const tokenEvents = bus.getHistory({ type: 'token_usage' })
    expect(tokenEvents).toHaveLength(1)
    expect(tokenEvents[0]?.data).toMatchObject({
      settlementId: expect.any(String),
      settledTokens: {
        promptTokens: 25,
        completionTokens: 5,
        totalTokens: 30,
      },
      reason: 'turn.completed',
    })
  })

  test('settles the current codex token bucket when a turn is aborted', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    const parser = adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }

    parser.parseLine(
      instance.id,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      'idle',
    )
    parser.parseLine(
      instance.id,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
            last_token_usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
          },
        },
      }),
      'thinking',
    )
    parser.parseLine(
      instance.id,
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } }),
      'thinking',
    )

    expect(manager.get(instance.id)?.state).toBe('interrupted')
    const tokenEvents = bus.getHistory({ type: 'token_usage' })
    expect(tokenEvents).toHaveLength(1)
    expect(tokenEvents[0]?.data).toMatchObject({
      settlementId: expect.any(String),
      settledTokens: {
        promptTokens: 20,
        completionTokens: 4,
        totalTokens: 24,
      },
      reason: 'turn_aborted',
    })
    expect(manager.get(instance.id)?.currentTaskTokens.totalTokens).toBe(0)
  })

  test('recognizes codex function_call response items as executing tool calls', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pnpm test"}',
        },
      }),
      'thinking',
    )

    expect(result.state).toBe('executing')
    expect(manager.get(instance.id)?.state).toBe('executing')
    expect(manager.get(instance.id)?.stats.toolCallCount).toBe(1)
  })

  test('returns from executing to thinking when a codex tool call outputs', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    manager.updateState(instance.id, 'executing')

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_123',
          output: 'ok',
        },
      }),
      'executing',
    )

    expect(result.state).toBe('thinking')
    expect(manager.get(instance.id)?.state).toBe('thinking')
  })

  test('returns from executing to thinking when a codex custom tool completes', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })
    manager.updateState(instance.id, 'executing')

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          success: true,
        },
      }),
      'executing',
    )

    expect(result.state).toBe('thinking')
    expect(manager.get(instance.id)?.state).toBe('thinking')
  })

  test('understands codex exec item events and returns to idle at turn completion', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })

    const started = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: '/bin/zsh -lc "pwd"',
          status: 'in_progress',
        },
      }),
      'thinking',
    )

    const completed = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: '/bin/zsh -lc "pwd"',
          aggregated_output: '/Users/ousu/Documents/work/agent-monitor-proxy\n',
          exit_code: 0,
          status: 'completed',
        },
      }),
      started.state ?? 'executing',
    )

    const turnCompleted = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      completed.state ?? 'thinking',
    )

    expect(started.state).toBe('executing')
    expect(manager.get(instance.id)?.stats.toolCallCount).toBe(1)
    expect(completed.state).toBe('thinking')
    expect(turnCompleted.state).toBe('idle')
    expect(manager.get(instance.id)?.state).toBe('idle')
  })

  test('buffers partial codex JSONL writes before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amp-codex-partial-'))
    const home = join(root, '.codex')
    const sessionDir = join(home, 'sessions', '2026', '06', '02')
    await mkdir(sessionDir, { recursive: true })
    const sessionPath = join(sessionDir, 'rollout-2026-06-02T12-00-00-partial.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'rollout-2026-06-02T12-00-00-partial',
          cwd: '/tmp/partial',
          timestamp: '2026-06-02T12:00:00.000Z',
        },
      }),
      '',
    ].join('\n'))

    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()
    await adapter.init({
      bus,
      manager,
      config: {},
      homeDir: root,
    })

    const [descriptor] = await adapter.discover()
    const instance = manager.register(descriptor!)
    await adapter.startWatching(instance)

    const tokenLine = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
          },
        },
      },
    })
    const completeLine = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })

    await appendFile(sessionPath, `${tokenLine}\n${completeLine.slice(0, 20)}`)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(bus.getHistory({ type: 'token_usage' })).toHaveLength(0)

    await appendFile(sessionPath, `${completeLine.slice(20)}\n`)
    await new Promise((resolve) => setTimeout(resolve, 350))

    const tokenEvents = bus.getHistory({ type: 'token_usage' })
    expect(tokenEvents).toHaveLength(1)
    expect(tokenEvents[0]?.data).toMatchObject({
      settledTokens: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
      reason: 'task_complete',
    })
    expect(manager.get(instance.id)?.currentTaskTokens.totalTokens).toBe(0)

    await adapter.stopWatching(instance.id)
  })

  test('settles a just-completed codex session discovered after the task finished', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amp-codex-completed-before-watch-'))
    const home = join(root, '.codex')
    const sessionDir = join(home, 'sessions', '2026', '06', '02')
    await mkdir(sessionDir, { recursive: true })
    const sessionPath = join(sessionDir, 'rollout-2026-06-02T12-10-00-completed.jsonl')
    await writeFile(sessionPath, [
      JSON.stringify({
        timestamp: '2026-06-02T12:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'rollout-2026-06-02T12-10-00-completed',
          cwd: '/tmp/completed-before-watch',
          timestamp: '2026-06-02T12:10:00.000Z',
        },
      }),
      JSON.stringify({ timestamp: '2026-06-02T12:10:01.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({
        timestamp: '2026-06-02T12:10:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 200,
              output_tokens: 30,
              total_tokens: 230,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T12:10:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-completed-before-watch',
        },
      }),
      '',
    ].join('\n'))

    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()
    await adapter.init({
      bus,
      manager,
      config: {},
      homeDir: root,
    })

    const [descriptor] = await adapter.discover()
    const instance = manager.register(descriptor!)
    await adapter.startWatching(instance)

    const tokenEvents = bus.getHistory({ type: 'token_usage' })
    expect(tokenEvents).toHaveLength(1)
    expect(tokenEvents[0]?.data).toMatchObject({
      settlementId: `${instance.id}:task_complete:turn-completed-before-watch`,
      settledTokens: {
        promptTokens: 200,
        completionTokens: 30,
        totalTokens: 230,
      },
      reason: 'task_complete',
    })
    expect(manager.get(instance.id)?.currentTaskTokens.totalTokens).toBe(0)

    await adapter.stopWatching(instance.id)
  })

  test('assistant messages do not force a completed turn back to thinking', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      }),
      'idle',
    )

    expect(result.state).toBeNull()
    expect(manager.get(instance.id)?.state).toBe('idle')
    expect(manager.get(instance.id)?.stats.messageCount).toBe(1)
  })

  test('discover only returns the latest active session', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()
    const homeDir = await mkdtemp(join(tmpdir(), 'amp-codex-'))

    await adapter.init({
      bus,
      manager,
      config: { enabled: true },
      homeDir,
    })

    const olderSession = 'rollout-old.jsonl'
    const latestSession = 'rollout-new.jsonl'
    const olderPath = join(homeDir, '.codex', 'sessions', '2026', '06', '01')
    const latestPath = olderPath
    await mkdir(olderPath, { recursive: true })

    await writeFile(
      join(olderPath, olderSession),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { cwd: '/tmp/old-project' },
        }),
      ].join('\n'),
    )
    await writeFile(
      join(latestPath, latestSession),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { cwd: '/tmp/new-project' },
        }),
      ].join('\n'),
    )

    const oldStat = await utimes(join(olderPath, olderSession), new Date(Date.now() - 1000), new Date(Date.now() - 1000))
    const newStat = await utimes(join(latestPath, latestSession), new Date(), new Date())
    void oldStat
    void newStat

    const oldInstance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: 'old-session',
      watchPath: join(olderPath, olderSession),
    })

    const descriptors = await adapter.discover()

    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]?.sessionId).toBe('rollout-new')
    expect(manager.get(oldInstance.id)).toBeUndefined()
  })

  test('discovers the newest codex session by session creation time, not mtime', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()
    const homeDir = await mkdtemp(join(tmpdir(), 'amp-codex-created-at-'))
    const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '06', '01')

    await adapter.init({
      bus,
      manager,
      config: { enabled: true },
      homeDir,
    })

    await mkdir(sessionDir, { recursive: true })
    const oldLongRunningSession = join(sessionDir, 'rollout-old-long-running.jsonl')
    const newShortSession = join(sessionDir, 'rollout-new-short.jsonl')
    await writeFile(
      oldLongRunningSession,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          timestamp: '2026-06-01T10:08:59.146Z',
          cwd: '/tmp/project',
        },
      }) + '\n',
    )
    await writeFile(
      newShortSession,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          timestamp: '2026-06-01T14:43:20.357Z',
          cwd: '/tmp/project',
        },
      }) + '\n',
    )

    await utimes(oldLongRunningSession, new Date(), new Date())
    await utimes(
      newShortSession,
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    )

    const descriptors = await adapter.discover()

    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]?.sessionId).toBe('rollout-new-short')
  })

  test('settles turn.completed usage when no token_count was observed', () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()

    ;(adapter as unknown as { ctx: { bus: EventBus; manager: InstanceManager } }).ctx = { bus, manager }

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: '019e82a8-76f6-7432-8abd-d79880f4cc80',
    })

    const result = (adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 12,
          reasoning_output_tokens: 5,
        },
      }),
      'thinking',
    )

    expect(result.state).toBe('idle')
    expect(bus.getHistory({ type: 'token_usage' })).toHaveLength(1)
    expect(bus.getHistory({ type: 'token_usage' })[0]?.data).toMatchObject({
      settlementId: expect.any(String),
      settledTokens: {
        promptTokens: 100,
        completionTokens: 12,
        totalTokens: 112,
        cachedPromptTokens: 40,
        reasoningTokens: 5,
      },
      reason: 'turn.completed',
    })
    expect(bus.getHistory({ type: 'token_update' })[0]?.data).toMatchObject({
      updateKind: 'reset',
      deltaTokens: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      currentTaskTokens: {
        promptTokens: 100,
        completionTokens: 12,
        totalTokens: 112,
      },
    })
  })

  test('stale active codex sessions fall back to idle', async () => {
    vi.useFakeTimers()
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new CodexAdapter()
    const homeDir = await mkdtemp(join(tmpdir(), 'amp-codex-stale-'))
    const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '06', '01')
    const sessionPath = join(sessionDir, 'rollout-stale.jsonl')

    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/stale-project' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
        '',
      ].join('\n'),
    )

    await adapter.init({
      bus,
      manager,
      config: { enabled: true, staleTimeoutMs: 1000 },
      homeDir,
    })

    const instance = manager.register({
      type: 'codex',
      kind: 'cli',
      displayName: 'Codex CLI',
      sessionId: 'rollout-stale',
      watchPath: sessionPath,
    })

    await adapter.startWatching(instance)
    expect(manager.get(instance.id)?.state).toBe('thinking')

    await vi.advanceTimersByTimeAsync(1001)
    expect(manager.get(instance.id)?.state).toBe('idle')

    ;(adapter as unknown as {
      parseLine: (id: string, line: string, lastState: string) => { state: string | null }
    }).parseLine(
      instance.id,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      'idle',
    )
    await vi.advanceTimersByTimeAsync(250)
    expect(manager.get(instance.id)?.state).toBe('thinking')

    await vi.advanceTimersByTimeAsync(1001)
    expect(manager.get(instance.id)?.state).toBe('idle')

    await adapter.destroy()
    vi.useRealTimers()
  })
})
