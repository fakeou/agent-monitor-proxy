import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js'
import { EventBus } from '../src/core/bus.js'
import { InstanceManager } from '../src/core/manager.js'

describe('ClaudeCodeAdapter', () => {
  test('discover only returns the latest Claude Code session and unregisters older tracked sessions', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new ClaudeCodeAdapter()
    const homeDir = await mkdtemp(join(tmpdir(), 'amp-claude-'))
    const projectDir = join(homeDir, '.claude', 'projects', '-tmp-project')

    await adapter.init({
      bus,
      manager,
      config: { enabled: true },
      homeDir,
    })

    await mkdir(projectDir, { recursive: true })
    const olderSession = join(projectDir, 'older-session.jsonl')
    const latestSession = join(projectDir, 'latest-session.jsonl')
    await writeFile(olderSession, '{"type":"user","message":{"content":"old"}}\n')
    await writeFile(latestSession, '{"type":"user","message":{"content":"new"}}\n')
    await utimes(olderSession, new Date(Date.now() - 1000), new Date(Date.now() - 1000))
    await utimes(latestSession, new Date(), new Date())

    const oldInstance = manager.register({
      type: 'claude-code',
      kind: 'cli',
      displayName: 'Claude Code',
      sessionId: 'older-session',
      watchPath: olderSession,
    })

    const descriptors = await adapter.discover()

    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]?.sessionId).toBe('latest-session')
    expect(manager.get(oldInstance.id)).toBeUndefined()
  })

  test('does not emit token usage by scanning Claude Code history', async () => {
    const bus = new EventBus()
    const manager = new InstanceManager(bus)
    const adapter = new ClaudeCodeAdapter()
    const homeDir = await mkdtemp(join(tmpdir(), 'amp-claude-tokens-'))
    const projectDir = join(homeDir, '.claude', 'projects', '-tmp-project')
    const sessionPath = join(projectDir, 'session.jsonl')

    await mkdir(projectDir, { recursive: true })
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: 'assistant',
        usage: { input_tokens: 100, output_tokens: 20 },
      }) + '\n',
    )

    await adapter.init({
      bus,
      manager,
      config: { enabled: true },
      homeDir,
    })

    const instance = manager.register({
      type: 'claude-code',
      kind: 'cli',
      displayName: 'Claude Code',
      sessionId: 'session',
      watchPath: sessionPath,
    })

    await adapter.startWatching(instance)

    expect(bus.getHistory({ type: 'token_usage' })).toHaveLength(0)
    expect(manager.get(instance.id)?.currentTaskTokens.totalTokens).toBe(0)
  })
})
