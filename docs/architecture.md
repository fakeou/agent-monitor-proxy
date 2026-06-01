# Agent Monitor Proxy — Architecture Design

## 1. Overview

Agent Monitor Proxy (AMP) is a **local proxy service** that discovers, intercepts, and monitors all running AI coding agents on a developer's machine. It provides a unified real-time API for any consumer application (desktop pets, dashboards, automation scripts) to observe agent activity without modifying the agents themselves.

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Monitor Proxy                       │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Discovery   │  │ Interceptor │  │    Analysis Engine   │ │
│  │  Layer       │  │ Layer       │  │                     │ │
│  │             │  │             │  │  ┌───────────────┐  │ │
│  │  Process    │  │  HTTP Proxy │  │  │ State Machine │  │ │
│  │  Scanner    │  │  Session    │  │  │ Token Counter │  │ │
│  │  Config     │  │  Watcher    │  │  │ Msg Parser    │  │ │
│  │  Detector   │  │  PTY Hook   │  │  │ Instance Mgr  │  │ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │ │
│         └────────────────┼──────────────────┘            │ │
│                          ▼                                │ │
│                 ┌─────────────────┐                       │ │
│                 │   Event Bus     │                       │ │
│                 └────────┬────────┘                       │ │
│                          ▼                                │ │
│                 ┌─────────────────┐                       │ │
│                 │  Exposure Layer │                       │ │
│                 │  WS / HTTP API  │                       │ │
│                 └─────────────────┘                       │ │
└─────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲              ▲
         │              │              │              │
    ┌────┴───┐    ┌────┴───┐    ┌─────┴──┐    ┌─────┴──┐
    │Claude  │    │ Codex  │    │ Cursor │    │ Kimi   │
    │Code    │    │ CLI    │    │ App    │    │ Code   │
    └────────┘    └────────┘    └────────┘    └────────┘
```

## 2. Design Principles

1. **Zero Intrusion** — Never modify agent code or config. Use environment injection and file observation only.
2. **Horizontal Extensibility** — Adding a new agent = implementing one Adapter interface. No core changes needed.
3. **Multi-Instance** — Track N instances of the same agent type independently.
4. **Real-Time First** — WebSocket push by default. HTTP polling as fallback.
5. **Local Only** — No cloud dependency. All data stays on the developer's machine.
6. **Open Source** — MIT license. Community can contribute adapters.

## 3. Layer Architecture

### 3.1 Discovery Layer

Discovers running agents through multiple strategies:

| Strategy | What it detects | How |
|----------|----------------|-----|
| Process Scan | CLI agents running in terminals | Scan process list for known binary names |
| Config Scan | Installed but not-yet-running agents | Check `~/.claude`, `~/.codex`, `~/.config/opencode` etc. |
| Port Scan | App agents with local servers | Check known ports (Cursor, etc.) |
| Watch | Newly started agents | Watch config directories for new session files |

Output: `Map<instanceId, AgentDescriptor>`

### 3.2 Interceptor Layer

Multiple interception strategies, each agent uses the appropriate ones:

#### 3.2.1 HTTP/HTTPS Proxy (Primary)

```
Agent → AMP Proxy (localhost:PORT) → api.anthropic.com / api.openai.com
                    │
                    ├─ Parse request: messages, tools, model, system prompt
                    ├─ Parse response: reply, tool_calls, usage
                    └─ Emit events to Analysis Engine
```

Setup: Set `HTTPS_PROXY` / `HTTP_PROXY` environment variables before launching the agent.

#### 3.2.2 Session File Watcher (Passive)

```
Agent writes → ~/.claude/projects/*/sessions/*.jsonl
                     │
                     ├─ fs.watch() detects new content
                     ├─ Tail-read new lines
                     └─ Parse JSONL → emit events
```

#### 3.2.3 App Log Watcher (App-specific)

```
Cursor App → ~/Library/Application Support/Cursor/logs/
Codex App  → ~/.codex/app-sessions/
                     │
                     ├─ Watch log directory
                     ├─ Parse log entries
                     └─ Emit events
```

### 3.3 Analysis Engine

Processes raw interceptor data into the unified data model:

```
Raw API Request/Response
        │
        ▼
┌───────────────────┐
│  Message Parser   │ → Extract role, content, tool_use, tool_result
├───────────────────┤
│  Token Counter    │ → Accumulate prompt_tokens, completion_tokens
├───────────────────┤
│  State Machine    │ → Infer: thinking / executing / waiting / completed
├───────────────────┤
│  Instance Manager │ → Track multiple instances, deduplicate
└───────────────────┘
        │
        ▼
  Unified AgentInstance model
```

#### State Machine Rules

```
                    ┌──────────┐
         ┌─────────│   idle   │◄─────────────┐
         │         └────┬─────┘              │
         │              │ receive user msg    │
         │              ▼                     │
         │         ┌──────────┐              │
         │         │ thinking │              │
         │         └────┬─────┘              │
         │              │ response with      │
         │              │ tool_use           │
         │              ▼                     │
         │         ┌──────────┐              │
         ├────────►│executing │              │
         │         └────┬─────┘              │
         │              │ tool_result        │
         │              │ (no more tool_use) │
         │              ▼                     │
         │    ┌─────────────────┐            │
         │    │ waiting_input   │────────────┘
         │    └─────────────────┘
         │              │
         │              │ end_turn / stop
         │              ▼
         │    ┌─────────────────┐
         └───►│   completed     │
              └─────────────────┘
```

### 3.4 Exposure Layer

#### WebSocket API

```typescript
// ws://localhost:AMP_PORT
{
  "type": "state_change",       // | "token_usage" | "message" | "tool_call" | "completed" | "instance_discovered" | "instance_lost"
  "instanceId": "claude-abc123",
  "timestamp": 1717200000000,
  "data": {
    "previousState": "thinking",
    "newState": "executing",
    "agentType": "claude-code",
    "agentKind": "cli",
    "project": "/path/to/project"
  }
}
```

#### HTTP REST API

```
GET  /api/instances              → List all tracked instances
GET  /api/instances/:id          → Get instance detail
GET  /api/instances/:id/stats    → Get token/message/tool stats
GET  /api/summary                → Global summary (total tokens, active count, etc.)
POST /api/instances/:id/action   → Send action (e.g., "inject_message")
GET  /api/events                 → SSE stream (alternative to WebSocket)
GET  /health                     → Health check
```

## 4. Adapter System

Each agent type implements the `AgentAdapter` interface:

```typescript
interface AgentAdapter {
  readonly type: string           // 'claude-code' | 'codex' | 'cursor' | ...
  readonly kind: 'cli' | 'app'
  readonly displayName: string

  // Lifecycle
  init(ctx: AdapterContext): Promise<void>
  destroy(): Promise<void>

  // Discovery
  discover(): Promise<AgentDescriptor[]>

  // Interception
  startWatching(instance: AgentInstance): Promise<void>
  stopWatching(instanceId: string): Promise<void>
}

interface AdapterContext {
  bus: EventBus                   // Emit events
  proxy?: ProxyServer             // Access to HTTP proxy (if applicable)
  config: AdapterConfig           // User config for this adapter
}
```

### Adding a New Agent

1. Create `src/adapters/my-agent.ts`
2. Implement `AgentAdapter`
3. Register in `src/adapters/registry.ts`
4. Done. No core changes needed.

## 5. Data Model

```typescript
interface AgentInstance {
  id: string                      // Unique: "{type}-{pid|sessionHash}"
  type: string                    // 'claude-code' | 'codex' | 'cursor' | ...
  kind: 'cli' | 'app'
  displayName: string             // Human-readable: "Claude Code (project-name)"

  pid?: number                    // OS process ID
  projectPath?: string            // Working directory / project
  sessionId?: string              // Agent's own session identifier

  state: AgentState
  stateChangedAt: number          // Timestamp of last state change

  stats: AgentStats
  session: SessionInfo

  discoveredAt: number            // When we first saw this instance
  lastActivityAt: number          // Last time we received data
}

type AgentState =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'stopped'

interface AgentStats {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  toolCallCount: number
  messageCount: number
  requestCount: number
  durationMs: number              // Total active time
}

interface SessionInfo {
  id: string
  startTime: number
  lastActivity: number
  messages: MessageSummary[]      // Recent messages (configurable limit)
  toolCalls: ToolCallSummary[]    // Recent tool calls
}

interface MessageSummary {
  role: 'user' | 'assistant' | 'system'
  contentPreview: string          // First N chars
  timestamp: number
  tokenCount?: number
}

interface ToolCallSummary {
  name: string                    // 'Bash' | 'Read' | 'Write' | ...
  inputPreview: string
  timestamp: number
  durationMs?: number
  status: 'pending' | 'success' | 'error'
}

// Events
interface MonitorEvent {
  type: MonitorEventType
  instanceId: string
  timestamp: number
  data: Record<string, unknown>
}

type MonitorEventType =
  | 'instance_discovered'
  | 'instance_lost'
  | 'state_change'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'token_usage'
  | 'completed'
  | 'error'
```

## 6. Directory Structure

```
agent-monitor-proxy/
├── src/
│   ├── core/
│   │   ├── types.ts              # All type definitions
│   │   ├── bus.ts                # EventBus (typed EventEmitter)
│   │   ├── manager.ts            # InstanceManager (tracks all agents)
│   │   └── config.ts             # Configuration loader
│   │
│   ├── adapters/
│   │   ├── base.ts               # AgentAdapter interface + BaseAdapter
│   │   ├── registry.ts           # Adapter registry (auto-discovery)
│   │   ├── claude-code.ts        # Claude Code adapter
│   │   ├── codex.ts              # Codex CLI adapter
│   │   ├── cursor.ts             # Cursor adapter
│   │   ├── opencode.ts           # OpenCode adapter
│   │   ├── gemini-cli.ts         # Gemini CLI adapter
│   │   └── kimi-code.ts          # Kimi Code adapter
│   │
│   ├── discovery/
│   │   ├── scanner.ts            # Process scanner
│   │   ├── config-detector.ts    # Config file detector
│   │   └── index.ts              # Discovery orchestrator
│   │
│   ├── proxy/
│   │   ├── server.ts             # HTTPS proxy server
│   │   ├── interceptor.ts        # Request/response interceptor
│   │   ├── parsers/
│   │   │   ├── anthropic.ts      # Anthropic API parser
│   │   │   ├── openai.ts         # OpenAI API parser
│   │   │   └── google.ts         # Google/Gemini API parser
│   │   └── cert.ts               # Self-signed CA cert generation
│   │
│   ├── server/
│   │   ├── http.ts               # REST API server
│   │   ├── ws.ts                 # WebSocket server
│   │   └── sse.ts                # Server-Sent Events
│   │
│   ├── utils/
│   │   ├── logger.ts             # Structured logger
│   │   ├── file-tail.ts          # Tail-read file utility
│   │   └── process.ts            # Process detection utilities
│   │
│   └── index.ts                  # Main entry point
│
├── docs/
│   ├── architecture.md           # This document
│   ├── adapters.md               # How to write adapters
│   └── api.md                    # API reference
│
├── tests/
│   ├── core/
│   ├── adapters/
│   └── proxy/
│
├── scripts/
│   ├── setup-proxy.sh            # Helper to configure proxy env vars
│   └── install-cert.sh           # Helper to install CA cert
│
├── package.json
├── tsconfig.json
├── .gitignore
├── LICENSE
└── README.md
```

## 7. Configuration

```yaml
# ~/.amp/config.yaml
server:
  port: 9527                    # HTTP + WebSocket port
  proxyPort: 9528               # HTTPS proxy port
  host: "127.0.0.1"

discovery:
  enabled: true
  interval: 5000                # Scan interval (ms)
  watchConfigDirs: true         # Watch agent config dirs for new sessions

proxy:
  enabled: true                 # Enable HTTP proxy interception
  targetHosts:                  # API hosts to intercept
    - "api.anthropic.com"
    - "api.openai.com"
    - "generativelanguage.googleapis.com"
  recordRequestBody: true       # Store request bodies (can be large)
  recordResponseBody: true      # Store response bodies

adapters:
  claude-code:
    enabled: true
    sessionDir: "~/.claude"
    hooksEnabled: true          # Install Claude Code hooks
  codex:
    enabled: true
    sessionDir: "~/.codex"
  cursor:
    enabled: true
  opencode:
    enabled: true
  gemini-cli:
    enabled: true

events:
  maxHistoryPerInstance: 1000   # Max events to keep in memory per instance
  tokenUsageGranularity: "per_request"  # "per_request" | "per_session"

logging:
  level: "info"                 # "debug" | "info" | "warn" | "error"
  file: "~/.amp/amp.log"
```

## 8. Security Considerations

1. **Local Only** — All servers bind to `127.0.0.1` by default. No external access.
2. **No Credential Storage** — API keys pass through the proxy transparently. We never log or store them.
3. **Request Body Control** — Users can disable request/response body recording to reduce memory usage and avoid sensitive data storage.
4. **CA Certificate** — Self-signed CA cert is generated locally and stored in `~/.amp/certs/`. Users must explicitly trust it.
5. **No Telemetry** — Zero phone-home behavior. Fully offline.

## 9. Performance Targets

- **Proxy Latency**: < 5ms added per request
- **Memory Usage**: < 100MB baseline, < 500MB with 10+ active agents
- **CPU Usage**: < 1% idle, < 5% during active monitoring
- **Startup Time**: < 2 seconds to full operation
- **Event Delivery**: < 50ms from agent action to WebSocket push

## 10. Extension Points

### Custom Adapters

```typescript
import { AgentAdapter, AdapterContext, AgentDescriptor } from '@agent-monitor/core'

export class MyAgentAdapter implements AgentAdapter {
  readonly type = 'my-agent'
  readonly kind = 'cli' as const
  readonly displayName = 'My Agent'

  async init(ctx: AdapterContext) { /* ... */ }
  async destroy() { /* ... */ }
  async discover(): Promise<AgentDescriptor[]> { /* ... */ }
  async startWatching(instance: AgentInstance) { /* ... */ }
  async stopWatching(instanceId: string) { /* ... */ }
}
```

### Event Middleware

```typescript
import { MonitorEvent } from '@agent-monitor/core'

// Filter or transform events before they reach consumers
amp.use((event: MonitorEvent, next: () => void) => {
  if (event.type === 'token_usage' && event.data.totalTokens > 100000) {
    console.warn(`High token usage: ${event.instanceId}`)
  }
  next()
})
```

### Plugin System (Future)

```typescript
// Plugins can extend AMP with new capabilities
amp.plugin({
  name: 'token-budget',
  init(amp) {
    amp.on('token_usage', (event) => {
      if (event.data.totalTokens > budget) {
        amp.broadcast({ type: 'budget_exceeded', ...event })
      }
    })
  }
})
```
