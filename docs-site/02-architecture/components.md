---
status: current
audience: developer
source: backend-ts/src/services, backend-ts/src/tools, packages/*/src
verified_at: 2026-07-18
---

# 后端组件

## 请求组件

`app.ts` 注册插件和身份 scope；`routes/` 解析输入、做角色/资源检查并调用 service；`services/` 实现用例；`contracts/` 定义可替换端口。

## Agent 组件

```text
AgentExecutionService
  -> context builder/compression
  -> agent-sdk Runtime/Kernel
  -> Tool Registry
  -> LLM client
  -> Delegation / BackgroundTask
  -> Metrics + Outbox Publisher
```

## RAG 组件

```text
KnowledgeBaseService
  -> DocumentExtractDispatcher
  -> Embedder factory
  -> IVectorStore / sqlite-vec
  -> scoring / reranker
```

## 可靠性组件

`OutboxDispatcher` 负责持久事件投递，`RealtimeEventHub` 负责进程内广播，`PendingInteractionService` 负责等待用户输入，`BackgroundTaskService` 负责异步任务，`PermissionPolicyService` 负责工具授权。
