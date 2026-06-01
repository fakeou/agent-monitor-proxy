import { describe, expect, test, vi } from 'vitest'
import { promisify } from 'node:util'

vi.mock('node:child_process', () => {
  const execFile = vi.fn()
  Object.assign(execFile, {
    [promisify.custom]: vi.fn(async (cmd: string) => {
      if (cmd !== 'ps') {
        throw new Error(`Unexpected command: ${cmd}`)
      }

      return {
        stdout: [
          '  PID PPID ARGS',
          '  101  1 /usr/local/bin/codex',
          '  103  1 /Applications/Codex.app/Contents/MacOS/Codex',
          '  102  1 /usr/local/bin/claude-code',
        ].join('\n'),
        stderr: '',
      }
    }),
  })

  return {
    execFile,
  }
})

import { scanForAgents } from '../src/discovery/scanner.js'

describe('scanForAgents', () => {
  test('does not classify codex process as a tracked instance', async () => {
    const agents = await scanForAgents()

    expect(agents.map((agent) => agent.type)).toEqual(['claude-code'])
  })
})
