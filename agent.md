# Agent Monitor Proxy (AMP)

本地 agent 状态与事件层。把 CLI agent 的运行状态统一成一套本地 API。

- **HTTP API**: `http://127.0.0.1:9527`
- **WebSocket**: `ws://127.0.0.1:9527`
- **SSE**: `http://127.0.0.1:9527/api/events`

## 快速开始

```bash
pnpm install
pnpm dev
```

验证：

```bash
curl http://127.0.0.1:9527/health          # → { "status": "ok" }
curl http://127.0.0.1:9527/api/instances   # → []
```

## 接入 agent

每个 agent 执行一次安装脚本即可。Hook 脚本会转发事件到 AMP，AMP 没启动也不阻塞 agent（fail-open）。

### Claude Code

```bash
./scripts/setup-claude-hooks.sh
```

| 事件 | 触发时机 | 状态 |
|---|---|---|
| `UserPromptSubmit` | 用户发送消息 | `thinking` |
| `PreToolUse` | 工具执行前 | `executing` |
| `PostToolUse` | 工具执行后 | `thinking` |
| `Notification` | 权限请求 / 通知 | `waiting_input` |
| `Stop` | 会话结束 | `completed` |

### Codex CLI

```bash
./scripts/setup-codex-hooks.sh
```

| 事件 | 触发时机 | 状态 |
|---|---|---|
| `SessionStart` | 会话启动 / 恢复 | `idle` |
| `UserPromptSubmit` | 用户发送消息 | `thinking` |
| `PreToolUse` | 工具执行前 | `executing` |
| `PostToolUse` | 工具执行后 | `thinking` |
| `Notification` | 通知 | `waiting_input` |
| `Stop` | 会话结束 | `completed` |

### Codex App

```text
POST /api/events/codex-app
```

支持 `thread/started`、`thread/status/changed`、`turn/started`、`turn/completed`、`thread/closed`。

### hook 原理

`amp-hook.sh` 是最简单的转发层——读 stdin → curl POST → 结束：

```
agent 调用 hook → stdin 传入 JSON → POST http://127.0.0.1:9527/api/hooks/<agent>
```

## 对外 API

### REST

```bash
# 所有实例
curl http://127.0.0.1:9527/api/instances

# 单个实例
curl http://127.0.0.1:9527/api/instances/claude-code-<session-id>

# 全局摘要
curl http://127.0.0.1:9527/api/summary
```

返回的实例结构：

```json
{
  "id": "claude-code-my-session",
  "type": "claude-code",
  "displayName": "Claude Code (my-project)",
  "state": "thinking",
  "sessionId": "my-session",
  "projectPath": "/Users/me/my-project",
  "stats": {
    "totalTokens": 15000,
    "promptTokens": 10000,
    "completionTokens": 5000,
    "toolCallCount": 12,
    "messageCount": 8,
    "requestCount": 5,
    "durationMs": 120000
  },
  "currentTaskTokens": {
    "promptTokens": 800,
    "completionTokens": 200,
    "totalTokens": 1000,
    "cachedPromptTokens": 400
  },
  "session": {
    "messages": [{ "role": "user", "contentPreview": "...", "timestamp": 1700000000000 }],
    "toolCalls": [{ "name": "Bash", "inputPreview": "...", "status": "success", "timestamp": 1700000000000 }]
  }
}
```

### WebSocket

```js
const ws = new WebSocket('ws://127.0.0.1:9527')

ws.onmessage = (msg) => {
  const { type, instanceId, timestamp, data } = JSON.parse(msg.data)
  // 根据 type 处理不同事件
}
```

连接后先收到 `init`（全量快照），之后实时推送。

### SSE

```bash
curl http://127.0.0.1:9527/api/events
# data: {"type":"state_change","instanceId":"...","data":{...}}
```

### 事件类型

| type | data | 说明 |
|---|---|---|
| `init` | `{ instances, summary }` | 连接后首次推送，全量快照 |
| `state_change` | `{ previousState, newState, currentTaskTokens }` | 状态变化 |
| `message` | `{ role, contentPreview, timestamp }` | 消息记录 |
| `tool_call` | `{ name, inputPreview, status }` | 工具调用 |
| `token_update` | `{ updateKind, deltaTokens, currentTaskTokens }` | bucket 变化，UI 展示用 |
| `token_usage` | `{ settlementId, settledTokens, reason }` | 结算事件，可做计费 |
| `completed` | `{ reason, session_id }` | 任务完成 |
| `instance_discovered` / `instance_lost` | `{ type, displayName }` | 实例发现 / 丢失 |

## Token 统计

**默认：文本估算，无需额外配置。** Hook 事件自带文本，按 `字符数 / 4` 估算 token。

| hook 事件 | 文本 | 累计到 |
|---|---|---|
| `UserPromptSubmit` | `prompt` | `promptTokens` |
| `PostToolUse` | `tool_output` | `completionTokens` |

每次 `Stop` 自动结算：

```
currentTaskTokens → commitTokenBucket()
                  → stats 累积
                  → bucket 归零
                  → 发出 token_usage 事件（带 settlementId）
```

### 事件流示例

```
state_change: idle → thinking           (UserPromptSubmit)
token_update: promptTokens += 50        (估算 prompt 文本)
state_change: thinking → executing      (PreToolUse)
state_change: executing → thinking      (PostToolUse)
token_update: completionTokens += 30    (估算 tool_output)
state_change: thinking → completed      (Stop)
token_usage: { settlementId, settledTokens: { prompt: 50, completion: 30 } }
```

### 对接计费

消费 `token_usage` 事件，按 `settlementId` 去重：

```js
const seen = new Set()
ws.onmessage = (msg) => {
  const event = JSON.parse(msg.data)
  if (event.type !== 'token_usage') return
  const { settlementId, settledTokens } = event.data
  if (seen.has(settlementId)) return
  seen.add(settlementId)
  // settledTokens.promptTokens / completionTokens → 扣费
}
```

**不要消费 `token_update` 做计费**——它不承诺 exactly-once，只适合 UI 进度展示。

### 精确 token（可选）

如果要用 API 返回的真实 token 数而非估算：

```bash
AMP_UPSTREAM_URL="https://api.deepseek.com/anthropic" pnpm dev
```

然后把 Claude Code 的 `ANTHROPIC_BASE_URL` 改为 `http://127.0.0.1:9528`。Proxy 会转发请求并从响应 `usage` 中提取精确 token。

## 新增 agent

实现 adapter 继承 `BaseAdapter`，再在 `AgentStateController` 处理状态映射：

```ts
class MyAdapter extends BaseAdapter {
  readonly type = 'my-agent'
  readonly kind = 'cli' as const
  readonly displayName = 'My Agent'

  async discover() { return [] }
  async startWatching(instance) { /* 监听 hook 或文件 */ }
}
```

hook 转发脚本就是 `amp-hook.sh` 的模式：stdin → curl → AMP。

## 设计原则

- 本地优先，不依赖云服务
- hook 优先于文件扫描——hook 管理的实例 discovery 不触碰
- 只做状态和事件层，UI 由外部消费者负责
- token 按任务结算，不伪造历史数据
