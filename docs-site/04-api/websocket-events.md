# WebSocket 与事件

本章描述 TS 后端的实时通信机制：会话 WebSocket、SSE 流、AG-UI 网关。基于 `backend-ts/src/routes/agent/ws.ts`、`stream.ts`、`contracts/events.ts` 与 `agent-protocol`。

## 三条实时通道

| 通道 | 路径 | 协议 | 用途 |
|------|------|------|------|
| 会话 WebSocket | `/api/agent/sessions/:sessionId/ws` | WS | 会话级持久双向事件 |
| 流式执行 | `/api/agent/stream` | SSE | 启动任务并推流 |
| AG-UI 网关 | `/api/agui` | SSE + interrupt | AG-UI 协议兼容 |

## 会话 WebSocket

### 连接

```
POST /api/agent/sessions/:sessionId/ws-ticket
WS /api/agent/sessions/:sessionId/ws?after_seq=<cursor>&ticket=<one-time-ticket>
```

::: tip 出处
`routes/agent/ws.ts:30-34`，通过 `{ websocket: true }` 注册。
:::

### 查询参数

| 参数 | 说明 |
|------|------|
| `after_seq` | 重连游标，从指定 seq 续传（断线重连用） |
| `ticket` | 普通前端与 Widget 共用的短时、单次 ticket，绑定身份、租户和 session |

### 鉴权

普通浏览器会话先通过带 `Authorization` header 的 HTTP 请求签发 ticket。ticket 默认 60 秒有效，保存时只保留 SHA-256 哈希，绑定当前 identity 与 session，并在握手校验时先删除再验证，因此失败尝试和成功连接都不能重放。password profile 不再接受长期 session JWT query。

Widget 的 15 分钟 JWT 或 publishable key + Origin 只用于调用 `POST /api/widget/sessions/:sessionId/ws-ticket`。签发端点校验 app、tenant、session 来源后生成同一种单次 ticket；JWT 和 publishable key 都不进入 WS URL。

local profile 可由本地 identity provider 直接建连；frontend-client 与 agent-widget 的正式客户端统一走 ticket。

### seq 机制

envelope 自带 `seq`（由 `EnvelopeProjector` 从 `session_seq` 盖戳），兼作：

- **持久化去重**：连接内不重复发送
- **连续性游标**：追踪已发最大 seq，供 heartbeat 与重连 `after_seq`

（`ws.ts:62-70`）

### 下行消息

| 类型 | 说明 |
|------|------|
| `heartbeat` | 每 20 秒心跳 |
| `session.reconnect` | 重连提示 |
| `ack` | 确认 |
| run/tool/interaction 事件 | 各类运行时事件 |

### 上行消息（客户端 → 服务端）

经 `ClientToServerEnvelopeSchema`（`contracts/events.ts`）校验，类型包括：

| 类型 | 说明 |
|------|------|
| `user_driven_change` | 用户驱动变更 |
| `abort` | 中止任务 |
| `tools.register` | 注册工具 |
| `delegate_result` | 委派结果 |
| `interaction` | 交互响应 |

## 流式执行（SSE）

### 启动

```
POST /api/agent/stream
```

（`routes/agent/stream.ts`）

启动 agent 流式执行，返回 SSE 流，推送运行时事件（工具调用、思考、结果）。

### 交互响应

| 端点 | 说明 |
|------|------|
| `POST /api/agent/sessions/:sessionId/approvals/:approvalId/respond` | 响应审批 |
| `POST /api/agent/sessions/:sessionId/inputs/:inputId/respond` | 响应用户输入 |
| `POST /api/agent/sessions/:sessionId/interactions/:interactionId/respond` | 统一响应（approval/input） |

### 停止

```
POST /api/agent/stream/stop
```

停止会话内正在执行的任务。

## 事件投递架构（Durable Outbox）

终端事件通过**持久化 outbox** 模式保证可靠投递：

```
run-engine 产出事件
    │
    ▼
DurableClientEventPublisher (client-event-publisher.ts)
    │  写入 conversationStore 持久化（带 seq）
    ▼
OutboxDispatcher (dispatcher.ts) ── 周期轮询未投递事件
    │
    ▼
EnvelopeProjector (projector.ts) ── 盖戳 session_seq
    │
    ▼
RealtimeEventHub (realtime-event-hub.ts)
    │
    ▼
SSE / WebSocket 推送前端
```

::: tip 出处
`services/runtime/event-outbox/`（dispatcher + projector + client-event-publisher）。容器创建时启动 dispatcher（`runtime-container.ts:127-128`）。
:::

### outbox 管理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agent/event-outbox` | 列出事件（`?status=` `?session_id=` `?run_id=` `?limit=` `?offset=`） |
| `GET` | `/api/agent/event-outbox/:id` | 单个事件 |
| `POST` | `/api/agent/event-outbox/:id/retry` | 重新入队 |
| `POST` | `/api/agent/event-outbox/retry` | 批量重新入队 |
| `DELETE` | `/api/agent/event-outbox/delivered` | 清理已投递（`?before=` `?older_than_hours=` `?limit=`） |

## AG-UI 网关

```
SSE /api/agui
```

（`routes/agent/agui.ts`，`app.ts:191` 以独立前缀 `/api/agui` 注册）

- 将内部事件翻译为 **AG-UI 协议**
- 含 interrupt 状态机，支持中断/恢复
- 翻译逻辑在 `services/agui-gateway/`

## 上下文快照

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agent/context-snapshot` | 上下文快照预览（`?session_id=` `?selected_llm=` `?thread_key=`） |
| `GET` | `/api/agent/tool-call/raw-result` | 工具调用原始结果（`?session_id=` `?call_id=` 必填） |

## 事件契约

事件结构定义在 `contracts/events.ts` 与 `@ragsystem/agent-protocol`（前后端共享）。详见 [agent-protocol 协议](./agent-protocol)。
