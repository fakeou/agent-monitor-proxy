# Agent Monitor Proxy (AMP)

> Universal monitoring proxy for AI coding agents. Discover, intercept, and observe all your Claude Code, Codex, Cursor, and other agents from a single service.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What is this?

AMP is a **local proxy service** that automatically discovers and monitors all running AI coding agents on your machine. It provides a unified real-time API for any consumer application to observe agent activity.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Claude Code│  │  Codex CLI  │  │   Cursor    │  │  Kimi Code  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       └────────────────┼────────────────┼────────────────┘
                        ▼
              ┌─────────────────┐
              │  Agent Monitor  │
              │     Proxy       │
              │                 │
              │  ┌───────────┐  │
              │  │ Discovery │  │
              │  │ Interceptor│  │
              │  │ Analyzer  │  │
              │  └─────┬─────┘  │
              │        ▼        │
              │  ┌───────────┐  │
              │  │ REST API  │  │
              │  │ WebSocket │  │
              │  └───────────┘  │
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │  Your App       │
              │  (Desktop Pet,  │
              │   Dashboard,    │
              │   Automation)   │
              └─────────────────┘
```

## Features

- **Auto-Discovery** — Scans running processes and config directories to find all agents
- **Multi-Instance** — Track N instances of the same agent type independently
- **Real-Time Events** — WebSocket push for state changes, token usage, tool calls
- **REST API** — Query instances, stats, and history via HTTP
- **Extensible** — Add new agents by implementing a single `AgentAdapter` interface
- **Zero Intrusion** — No modification to agents. Uses environment injection and file observation
- **Local Only** — No cloud dependency. All data stays on your machine

## Quick Start

```bash
# Install
npm install -g agent-monitor-proxy

# Start
amp

# Or run directly
npx agent-monitor-proxy
```

Then connect your consumer:

```typescript
const ws = new WebSocket('ws://localhost:9527')

ws.on('message', (event) => {
  const { type, instanceId, data } = JSON.parse(event)
  console.log(`[${instanceId}] ${type}:`, data)
})
```

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/instances` | List all tracked instances |
| GET | `/api/instances/:id` | Get instance detail |
| GET | `/api/instances/:id/stats` | Get instance stats |
| GET | `/api/summary` | Global summary |
| GET | `/api/events` | SSE event stream |

### WebSocket

Connect to `ws://localhost:9527` and receive real-time events:

```json
{
  "type": "state_change",
  "instanceId": "claude-code-12345",
  "timestamp": 1717200000000,
  "data": {
    "previousState": "thinking",
    "newState": "executing",
    "agentType": "claude-code",
    "agentKind": "cli"
  }
}
```

### Event Types

| Event | When |
|-------|------|
| `instance_discovered` | New agent instance found |
| `instance_lost` | Agent process exited |
| `state_change` | Agent state changed (idle/thinking/executing/waiting/completed/stopped) |
| `message` | User or assistant message sent |
| `tool_call` | Agent called a tool |
| `tool_result` | Tool call completed |
| `token_usage` | Token usage recorded |
| `completed` | Task completed |

## Writing Adapters

Add support for a new agent by implementing `AgentAdapter`:

```typescript
import { BaseAdapter, type AgentAdapter, type AgentDescriptor, type AgentInstance } from 'agent-monitor-proxy'

export class MyAgentAdapter extends BaseAdapter {
  readonly type = 'my-agent'
  readonly kind = 'cli' as const
  readonly displayName = 'My Agent'

  async discover(): Promise<AgentDescriptor[]> {
    // Scan for running instances
    return []
  }

  async startWatching(instance: AgentInstance): Promise<void> {
    // Start monitoring this instance
  }
}

// Register it
const amp = new AgentMonitorProxy({
  adapters: [new MyAgentAdapter()],
})
```

## Programmatic Usage

```typescript
import { AgentMonitorProxy } from 'agent-monitor-proxy'

const amp = new AgentMonitorProxy({
  config: {
    server: { port: 9527, proxyPort: 9528, host: '127.0.0.1' },
  },
})

// Listen to events
amp.getBus().on('token_usage', (event) => {
  console.log(`Token usage: ${event.data.totalTokens}`)
})

amp.getBus().on('state_change', (event) => {
  if (event.data.newState === 'completed') {
    console.log(`Agent ${event.instanceId} completed!`)
  }
})

await amp.start()
```

## Supported Agents

| Agent | Status | Adapter |
|-------|--------|---------|
| Claude Code (CLI) | ✅ Built-in | `claude-code` |
| Codex CLI | ✅ Built-in | `codex` |
| Cursor | 🔜 Planned | `cursor` |
| OpenCode | 🔜 Planned | `opencode` |
| Gemini CLI | 🔜 Planned | `gemini-cli` |
| Kimi Code | 🔜 Planned | `kimi-code` |

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full design document.

## License

MIT
