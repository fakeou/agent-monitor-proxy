import { afterEach, describe, expect, test } from 'vitest'
import { AMPHttpServer } from '../src/server/http.js'
import { EventBus } from '../src/core/bus.js'
import { InstanceManager } from '../src/core/manager.js'

const servers: AMPHttpServer[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()))
  servers.length = 0
})

describe('Claude Code hook endpoint', () => {
  test('uses the same session-based instance id as the instance manager', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const port = 19527
    const server = new AMPHttpServer(manager, bus, { host: '127.0.0.1', port, proxyPort: 19528 })
    servers.push(server)

    await server.start()

    const sessionId = '2a5287ef-942e-4538-92bf-2a80b0f57b1c'
    const registered = manager.register({
      type: 'claude-code',
      kind: 'cli',
      displayName: 'Claude Code',
      sessionId,
    })

    const response = await fetch(`http://127.0.0.1:${port}/api/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'README.md' },
      }),
    })

    expect(response.status).toBe(200)
    expect(manager.getByType('claude-code')).toHaveLength(1)
    expect(manager.get(registered.id)?.state).toBe('executing')
  })

  test('marks a Claude Code session completed on Stop', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const port = 19529
    const server = new AMPHttpServer(manager, bus, { host: '127.0.0.1', port, proxyPort: 19530 })
    servers.push(server)

    await server.start()

    const sessionId = 'cf51808a-1112-47d4-80c7-8671e2bae375'
    await fetch(`http://127.0.0.1:${port}/api/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
      }),
    })

    await fetch(`http://127.0.0.1:${port}/api/hooks/claude-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'Stop',
      }),
    })

    const instance = manager.getByType('claude-code')[0]
    expect(instance?.state).toBe('completed')
    expect(bus.getHistory({ type: 'completed' })).toHaveLength(1)
  })

  test('maps Codex hook events through the HTTP endpoint', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const port = 19531
    const server = new AMPHttpServer(manager, bus, { host: '127.0.0.1', port, proxyPort: 19532 })
    servers.push(server)

    await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/api/hooks/codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'codex-http-session',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp/codex-http',
        prompt: 'run',
      }),
    })

    expect(response.status).toBe(200)
    const instance = manager.getByType('codex')[0]
    expect(instance?.state).toBe('task_start')
    expect(instance?.projectPath).toBe('/tmp/codex-http')
  })

  test('maps Codex app-server notifications through the HTTP endpoint', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const port = 19533
    const server = new AMPHttpServer(manager, bus, { host: '127.0.0.1', port, proxyPort: 19534 })
    servers.push(server)

    await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/api/events/codex-app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'codex-app-thread',
          status: { type: 'active', isWaitingOnApproval: true },
        },
      }),
    })

    expect(response.status).toBe(200)
    const instance = manager.getByType('codex-app')[0]
    expect(instance?.state).toBe('waiting_input')
  })
})
