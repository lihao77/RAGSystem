---
status: current
audience: all
source: backend-ts/src, packages/*/src
verified_at: 2026-07-18
---

# 核心概念

## Tenant Runtime

每个租户通过 `TenantRuntimeRegistry` 获取一个 `RuntimeContainer`。Runtime 持有该租户的会话、存储、Agent、工具、Provider、MCP 和事件服务，所有业务请求都在 tenant identity 下执行。

## Agent Run

一次用户请求会创建一个 run。run 由 Agent Execution Service 驱动，经过上下文构建、LLM 调用、工具调用、委派和终态持久化。前端通过事件而不是轮询内部对象观察 run。

## Tool

Tool 是 Agent 可以调用的能力。内置工具、MCP 工具和宿主工具统一进入 per-agent registry，调用前经过权限策略，调用后产生 observation 和事件。

## Knowledge Base

知识库由源文件、文档块、Embedding、向量集合和可选 reranker 构成。UI 检索和 Agent `KnowledgeTools` 复用同一个后端服务。

## Event

事件是客户端可见的事实记录。服务端先写 durable outbox，再由 dispatcher 发布到实时 hub；断线恢复依靠序号、outbox 和 context snapshot。

## Profile

部署行为由 `deployment/auth/tenancy/execution/storage/ui` 六个轴组合决定，不应把某个环境变量直接等同于完整部署模式。
