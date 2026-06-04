/**
 * Agent Monitor Proxy — Core Type Definitions
 *
 * All shared types for the monitoring system.
 * No runtime dependencies. Pure type definitions.
 */

// ─── Agent State ────────────────────────────────────────────────

export type AgentState =
  | 'idle'           // Agent is running but not processing
  | 'task_start'     // User submitted a prompt, task is starting
  | 'thinking'       // Waiting for LLM API response
  | 'executing'      // Running a tool (Bash, Read, Write, etc.)
  | 'waiting_input'  // Needs user input (approval, prompt, etc.)
  | 'completed'      // Task finished successfully
  | 'interrupted'    // User interrupted the task
  | 'failed'         // Task failed / errored
  | 'stopped'        // Process exited

export const AGENT_STATE_ORDER: AgentState[] = [
  'idle', 'task_start', 'thinking', 'executing', 'waiting_input', 'completed', 'interrupted', 'failed', 'stopped',
]

// ─── Agent Instance ─────────────────────────────────────────────

export interface AgentInstance {
  /** Unique identifier: "{type}-{pidOrSessionHash}" */
  id: string
  /** Agent type identifier */
  type: string
  /** Whether this is a CLI tool or a desktop app */
  kind: 'cli' | 'app'
  /** Human-readable display name */
  displayName: string

  /** OS process ID (if available) */
  pid?: number
  /** Working directory / project path */
  projectPath?: string
  /** Agent's own session identifier */
  sessionId?: string
  /** Path to session/log file being monitored */
  watchPath?: string

  /** Current state */
  state: AgentState
  /** Timestamp of last state change */
  stateChangedAt: number

  /** Accumulated statistics */
  stats: AgentStats
  /** Token usage for the currently active task/turn. Resets after settlement. */
  currentTaskTokens: TokenBucket
  /** Current session info */
  session: SessionInfo

  /** When we first discovered this instance */
  discoveredAt: number
  /** Last time we received data from this instance */
  lastActivityAt: number

  /** When true, discovery must not unregister this instance — hooks own it */
  hookManaged?: boolean
}

export interface AgentStats {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  toolCallCount: number
  messageCount: number
  requestCount: number
  /** Total active time in ms */
  durationMs: number
}

export interface TokenBucket {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
  reasoningTokens?: number
  updatedAt?: number
}

export function createEmptyTokenBucket(): TokenBucket {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
}

export function createEmptyStats(): AgentStats {
  return {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    toolCallCount: 0,
    messageCount: 0,
    requestCount: 0,
    durationMs: 0,
  }
}

export interface SessionInfo {
  id: string
  startTime: number
  lastActivity: number
  /** Recent messages (bounded by config) */
  messages: MessageSummary[]
  /** Recent tool calls (bounded by config) */
  toolCalls: ToolCallSummary[]
}

export function createEmptySession(id: string): SessionInfo {
  const now = Date.now()
  return {
    id,
    startTime: now,
    lastActivity: now,
    messages: [],
    toolCalls: [],
  }
}

export interface MessageSummary {
  role: 'user' | 'assistant' | 'system'
  contentPreview: string
  timestamp: number
  tokenCount?: number
}

export interface ToolCallSummary {
  name: string
  inputPreview: string
  timestamp: number
  durationMs?: number
  status: 'pending' | 'success' | 'error'
}

// ─── Events ─────────────────────────────────────────────────────

export type MonitorEventType =
  | 'instance_discovered'
  | 'instance_lost'
  | 'state_change'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'token_update'
  | 'token_usage'
  | 'completed'
  | 'error'

export interface MonitorEvent<T = Record<string, unknown>> {
  type: MonitorEventType
  instanceId: string
  timestamp: number
  data: T
}

export interface StateChangeEvent {
  previousState: AgentState
  newState: AgentState
  agentType: string
  agentKind: 'cli' | 'app'
  project?: string
  currentTaskTokens: TokenBucket
}

export interface TokenUsageEvent {
  settlementId: string
  settledTokens: TokenBucket
  model?: string
  requestId?: string
  reason?: string
}

export interface TokenUpdateEvent {
  updateKind: 'delta' | 'reset'
  deltaTokens: TokenBucket
  currentTaskTokens: TokenBucket
}

export interface MessageEvent {
  role: 'user' | 'assistant' | 'system'
  contentPreview: string
  tokenCount?: number
}

export interface ToolCallEvent {
  name: string
  inputPreview: string
  requestId?: string
}

export interface ToolResultEvent {
  name: string
  status: 'success' | 'error'
  durationMs?: number
  outputPreview?: string
}

export interface InstanceDiscoveredEvent {
  type: string
  kind: 'cli' | 'app'
  displayName: string
  pid?: number
  projectPath?: string
}

// ─── Agent Descriptor (from Discovery) ──────────────────────────

export interface AgentDescriptor {
  type: string
  kind: 'cli' | 'app'
  displayName: string
  pid?: number
  projectPath?: string
  sessionId?: string
  watchPath?: string
  binaryPath?: string
  commandLine?: string
}

// ─── Configuration ──────────────────────────────────────────────

export interface AMPConfig {
  server: ServerConfig
  discovery: DiscoveryConfig
  proxy: ProxyConfig
  adapters: Record<string, AdapterConfig>
  events: EventsConfig
  logging: LoggingConfig
}

export interface ServerConfig {
  port: number
  proxyPort: number
  host: string
}

export interface DiscoveryConfig {
  enabled: boolean
  interval: number
  watchConfigDirs: boolean
}

export interface ProxyConfig {
  enabled: boolean
  /** Base URL to forward API requests to (e.g. https://api.anthropic.com) */
  upstream?: string
  recordRequestBody: boolean
  recordResponseBody: boolean
}

export interface AdapterConfig {
  enabled: boolean
  [key: string]: unknown
}

export interface EventsConfig {
  maxHistoryPerInstance: number
  tokenUsageGranularity: 'per_request' | 'per_session'
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error'
  file?: string
}

export const DEFAULT_CONFIG: AMPConfig = {
  server: {
    port: 9527,
    proxyPort: 9528,
    host: '127.0.0.1',
  },
  discovery: {
    enabled: true,
    interval: 5000,
    watchConfigDirs: true,
  },
  proxy: {
    enabled: true,
    upstream: process.env.AMP_UPSTREAM_URL || undefined,
    recordRequestBody: true,
    recordResponseBody: true,
  },
  adapters: {},
  events: {
    maxHistoryPerInstance: 1000,
    tokenUsageGranularity: 'per_request',
  },
  logging: {
    level: 'info',
  },
}
