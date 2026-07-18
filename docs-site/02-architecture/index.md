---
status: current
audience: developer
source: backend-ts/src/app.ts, backend-ts/src/services/runtime/runtime-container.ts
verified_at: 2026-07-18
---

# 架构

按 C4 风格阅读：先看系统上下文，再看容器，再深入组件和时序。

## 架构地图

```text
System Context
  用户 / 管理员 / Widget / LLM / MCP
        |
Container
  Vue frontend -> Fastify API -> Tenant Runtime
                                  |-> SQLite/sqlite-vec
                                  |-> agent-sdk/agent-llm
                                  |-> MCP/Embedding
        |
Component
  execution / context / tools / permissions / delegation / outbox
```

- [系统上下文](./system-context)
- [容器架构](./container-architecture)
- [后端组件](./components)
- [关键时序](./sequences)
- [数据与存储](./data-and-storage)
- [Agent 运行时](./agent-runtime)
- [TS 后端分层](./backend-ts-layer)
- [前端架构](./frontend)
- [工具系统](./tool-system)
- [存储模型](./storage)
- [Local 与 SaaS 分离迁移路线](./local-saas-migration-roadmap)
