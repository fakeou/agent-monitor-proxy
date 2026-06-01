# Agent Monitor Proxy 接入说明

## 项目定位

Agent Monitor Proxy, 简称 AMP, 是一个本地运行的 agent 状态与事件层。它不负责替代 Codex 或 Claude Code, 也不做完整 Dashboard 产品。当前目标是把不同 CLI agent 的运行状态统一成一套本地 API, 方便外部应用读取:

- 当前活跃会话是谁
- 当前状态是 idle, thinking, executing, waiting_input, interrupted, stopped 等
- 最近消息和工具调用
- 当前任务的 token bucket
- 任务完成或用户中断事件

默认服务运行在本机:

- HTTP API: `http://127.0.0.1:9527`
- WebSocket: `ws://127.0.0.1:9527`
- SSE: `http://127.0.0.1:9527/api/events`
- Proxy 预留端口: `127.0.0.1:9528`

## 当前支持的 agent

### Codex CLI

Codex 通过读取 session JSONL 文件接入:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

当前只跟踪最新的活跃 Codex session, 避免同一个 Codex 启动出多个重复实例。状态主要从 JSONL 事件推断:

- `user_message` / `task_started` -> `thinking`
- `item.started` 且 `item.type=command_execution` -> `executing`
- `item.completed` 且 `item.type=command_execution` -> `thinking`
- `task_complete` / `turn.completed` -> `idle`
- `turn_aborted` -> `interrupted`

如果 Codex 停在 `thinking` 或 `executing` 后没有后续事件, 会经过 stale fallback 回到 `idle`, 避免 UI 永久卡住。

### Claude Code

Claude Code 通过 hooks 接入。hook 脚本会把 Claude Code 的事件 POST 到:

```text
POST /api/hooks/claude-code
```

安装 hook:

```bash
./scripts/setup-claude-hooks.sh
```

当前 Claude Code 的实时状态来自 hook:

- `PreToolUse` -> `executing`
- `PostToolUse` -> `executing`
- `Notification` -> `waiting_input`
- `Stop` / `SubagentStop` -> `idle`

Claude 的 session JSONL 只用于发现最新会话和项目路径, 不再做历史 token 扫描。

## Token 语义

当前 token 不再表达历史总量, 而是表达当前任务的 token bucket。

每个实例上有:

```ts
currentTaskTokens: {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
  reasoningTokens?: number
  updatedAt?: number
}
```

Codex 收到 `token_count` 时, 只更新当前任务 bucket。状态变化事件会带上当前 bucket:

```json
{
  "type": "state_change",
  "data": {
    "newState": "executing",
    "currentTaskTokens": {
      "promptTokens": 100,
      "completionTokens": 20,
      "totalTokens": 120
    }
  }
}
```

`token_update` 事件表示当前任务 bucket 的增量变化, 只用于 UI 进度展示, 不能拿来做计费。

任务结束时只发一次 `token_usage`, 然后清空 bucket:

- `task_complete`
- `turn.completed`
- `turn_aborted`

用户取消时也会把本次任务 bucket 结算出去, `reason` 为 `turn_aborted`。

如果下游要把 token 换算成虚拟货币, 只能消费 `token_usage.settledTokens`。下游需要按 `settlementId` 去重, 不要把 `token_update` 当作计费源。

## 对外 API

### 获取实例列表

```bash
curl http://127.0.0.1:9527/api/instances
```

返回每个实例的当前状态、session 信息、工具调用、消息摘要和 `currentTaskTokens`。

### 获取全局摘要

```bash
curl http://127.0.0.1:9527/api/summary
```

摘要包含实例数量、活跃数量、按类型和状态聚合的信息。注意: UI 当前更关注实例上的 `currentTaskTokens`, 不应把历史总 token 当作当前任务 token 使用。

### 订阅 WebSocket

```js
const ws = new WebSocket('ws://127.0.0.1:9527')

ws.onmessage = (message) => {
  const event = JSON.parse(message.data)
  console.log(event.type, event.instanceId, event.data)
}
```

连接后会先收到一次 `init` 事件, 里面包含当前实例和 summary。之后会收到实时事件。

### 订阅 SSE

```bash
curl http://127.0.0.1:9527/api/events
```

## Debug 面板

Debug 面板在 `debug-panel/` 下, 用 Electron 打开:

```bash
cd debug-panel
npm run start
```

面板会连接 `ws://127.0.0.1:9527`, 并通过 HTTP 拉取实例列表和 summary。当前面板里的 token 展示是当前任务 bucket, 不是历史总量。

## 本地开发

安装依赖:

```bash
pnpm install
```

启动 AMP:

```bash
pnpm dev
```

验证:

```bash
pnpm test
pnpm typecheck
pnpm build
```

常用调试命令:

```bash
curl http://127.0.0.1:9527/health
curl http://127.0.0.1:9527/api/instances
curl http://127.0.0.1:9527/api/summary
```

## 新 agent 如何接入

新增 agent 通常实现一个 adapter, 继承 `BaseAdapter`:

```ts
export class MyAgentAdapter extends BaseAdapter {
  readonly type = 'my-agent'
  readonly kind = 'cli' as const
  readonly displayName = 'My Agent'

  async discover() {
    return []
  }

  async startWatching(instance) {
    // 监听 session 文件、hook、socket 或其它本地事件源
  }
}
```

接入时优先回答三个问题:

1. 如何稳定发现当前活跃会话?
2. 哪些事件能可靠映射到 `thinking` / `executing` / `idle` / `interrupted`?
3. token 是否能按当前任务结算? 如果只能拿历史总量, 不要接入为当前任务 token。

状态变化应通过 `InstanceManager.updateState()` 写入。消息、工具调用和 token bucket 应通过 `InstanceManager` 的对应方法写入, 避免 adapter 直接绕过 manager 发统计事件。

## 设计原则

- 本地优先, 不依赖云服务。
- 只做状态和事件层, 不把 UI 或业务逻辑塞进核心。
- 当前只保留最新活跃 session, 尽量避免重复实例。
- token 以当前任务 bucket 为准, 完成或中断时结算一次。
- 无法准确实时获取的数据宁可不报, 不用历史扫描伪装实时数据。
