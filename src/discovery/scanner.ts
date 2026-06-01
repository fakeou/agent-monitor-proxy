/**
 * Agent Monitor Proxy — Process Scanner
 *
 * Scans running processes to detect active coding agent instances.
 * Works on macOS, Linux, and Windows.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentDescriptor } from '../core/types.js'

const execFileAsync = promisify(execFile)

/** Known agent binary patterns and their types */
const KNOWN_AGENTS: Array<{
  patterns: RegExp[]
  type: string
  kind: 'cli' | 'app'
  displayName: string
  /** If true, only match the main process, not sub-processes */
  mainProcessOnly?: boolean
}> = [
  // CLI agents — match the actual CLI binary (not end-anchored, to handle args after binary)
  // Order matters: more specific patterns first
  {
    patterns: [/\/claude-code[\s/]/i, /\/claude-code$/i],
    type: 'claude-code',
    kind: 'cli',
    displayName: 'Claude Code',
  },
  {
    patterns: [/\/bin\/codex[\s/]/i, /\/bin\/codex$/i, /codex-darwin.*\/codex[\s/]/i],
    type: 'codex',
    kind: 'cli',
    displayName: 'Codex CLI',
  },
  {
    patterns: [/\/opencode[\s/]/i, /\/opencode$/i],
    type: 'opencode',
    kind: 'cli',
    displayName: 'OpenCode',
  },
  {
    patterns: [/\/gemini-cli[\s/]/i, /\/gemini[\s/]/i],
    type: 'gemini-cli',
    kind: 'cli',
    displayName: 'Gemini CLI',
  },
  {
    patterns: [/\/kimi-cli[\s/]/i, /\/kimi[\s/]/i],
    type: 'kimi-code',
    kind: 'cli',
    displayName: 'Kimi Code',
  },
  // App agents — match the main app process only (not sub-processes)
  {
    patterns: [/Codex\.app\/Contents\/MacOS\/Codex/i],
    type: 'codex-app',
    kind: 'app',
    displayName: 'Codex App',
    mainProcessOnly: true,
  },
  {
    patterns: [/Cursor\.app\/Contents\/MacOS\/Cursor/i],
    type: 'cursor',
    kind: 'app',
    displayName: 'Cursor',
    mainProcessOnly: true,
  },
]

/** Patterns to skip — these are sub-processes, not main agents */
const SKIP_PATTERNS = [
  /--type=renderer/i,
  /--type=gpu-process/i,
  /--type=utility/i,
  /--type=broker/i,
  /Crashpad/i,
  /browser_crashpad/i,
  /bare-modifier/i,
  /CursorUIViewService/i,
  /Helper\.app/i,
  /codex.*\.app\/Contents\/Frameworks/i,
  /codex.*\.app\/Contents\/Resources\/codex/i,
  /node_repl/i,
]

export interface ProcessInfo {
  pid: number
  ppid: number
  command: string
  args: string[]
  cwd?: string
}

/**
 * Scan all running processes for known coding agents.
 */
export async function scanForAgents(): Promise<AgentDescriptor[]> {
  const processes = await getRunningProcesses()
  const descriptors: AgentDescriptor[] = []

  for (const proc of processes) {
    const match = matchAgent(proc)
    if (match) {
      descriptors.push({
        type: match.type,
        kind: match.kind,
        displayName: match.displayName,
        pid: proc.pid,
        projectPath: proc.cwd,
        commandLine: proc.command,
      })
    }
  }

  return descriptors
}

/**
 * Get all running processes with their command lines.
 */
async function getRunningProcesses(): Promise<ProcessInfo[]> {
  const platform = process.platform

  if (platform === 'darwin' || platform === 'linux') {
    return getUnixProcesses()
  }
  if (platform === 'win32') {
    return getWindowsProcesses()
  }
  return []
}

async function getUnixProcesses(): Promise<ProcessInfo[]> {
  try {
    // ps -eo pid,ppid,args gives us PID, PPID, and full command
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid,args'], {
      maxBuffer: 10 * 1024 * 1024,
    })

    const processes: ProcessInfo[] = []
    const lines = stdout.split('\n').slice(1) // Skip header

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const parts = trimmed.split(/\s+/)
      const pid = parseInt(parts[0], 10)
      const ppid = parseInt(parts[1], 10)
      const command = parts.slice(2).join(' ')

      if (isNaN(pid)) continue

      processes.push({
        pid,
        ppid,
        command,
        args: parts.slice(2),
      })
    }

    return processes
  } catch {
    return []
  }
}

async function getWindowsProcesses(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync('wmic', [
      'process', 'get', 'ProcessId,ParentProcessId,CommandLine', '/format:csv',
    ], { maxBuffer: 10 * 1024 * 1024 })

    const processes: ProcessInfo[] = []
    const lines = stdout.split('\n').slice(1)

    for (const line of lines) {
      const parts = line.trim().split(',')
      if (parts.length < 4) continue

      const ppid = parseInt(parts[1], 10)
      const command = parts[2] ?? ''
      const pid = parseInt(parts[3], 10)

      if (isNaN(pid)) continue

      processes.push({ pid, ppid, command, args: command.split(/\s+/) })
    }

    return processes
  } catch {
    return []
  }
}

/**
 * Match a process against known agent patterns.
 * Returns null if the process should be skipped (sub-process, helper, etc.).
 */
function matchAgent(proc: ProcessInfo): { type: string; kind: 'cli' | 'app'; displayName: string } | null {
  // Skip known sub-process patterns
  for (const skip of SKIP_PATTERNS) {
    if (skip.test(proc.command)) return null
  }

  for (const agent of KNOWN_AGENTS) {
    for (const pattern of agent.patterns) {
      if (pattern.test(proc.command) || pattern.test(proc.args[0] ?? '')) {
        return {
          type: agent.type,
          kind: agent.kind,
          displayName: agent.displayName,
        }
      }
    }
  }

  return null
}
