---
status: current
audience: developer
source: backend-ts/src/services/agent, backend-ts/src/services/runtime/event-outbox
verified_at: 2026-07-18
---

# 关键时序

## Agent 请求

```text
Client -> POST/WS: session + task
API -> SessionApplication: 校验租户和归属
API -> AgentExecutionService: 创建 run
Execution -> ContextBuilder: 历史/记忆/检索
Execution -> LLM: complete/stream
LLM -> ToolRegistry: tool call
ToolRegistry -> PermissionPolicy: approve/interrupt
Execution -> Outbox: durable event
Outbox -> RealtimeHub -> Client: seq event
Execution -> ConversationStore: final state/metrics
```

## RAG 入库

```text
Upload -> blob store -> extract dispatcher -> chunks
      -> embedder -> sqlite-vec -> index status
```

## 断线恢复

客户端保存最后确认的 `seq`；重新连接后由 session WebSocket/outbox 查询缺失事件，必要时使用 context snapshot 恢复 UI 状态。客户端不得把事件顺序交给网络到达顺序。
