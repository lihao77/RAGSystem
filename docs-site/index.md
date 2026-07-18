---
layout: home

hero:
  name: RAGSystem
  text: 使用与开发手册
  tagline: 从启动、配置和日常使用，到 API、架构与生产运维
  actions:
    - theme: brand
      text: 开始使用
      link: /00-start/
    - theme: alt
      text: Memory 指南
      link: /03-guides/memory

features:
  - title: TS 后端
    details: 基于 Fastify v5 + TypeScript，运行于 Node.js 24+，默认监听 5002。
  - title: 共享协议包
    details: packages 下包含 agent-protocol、api-contracts、agent-llm、agent-sdk、agent-widget 五个包，分别承担线协议、HTTP 契约、模型通信、运行时内核和嵌入组件。
  - title: Agent 运行时
    details: run-engine 工具循环、context 压缩、delegation 委派、durable event outbox 终端事件投递。
  - title: 工具系统
    details: 内置工具（Bash / 文档 / 检索 / 记忆 / 技能 / 任务）+ MCP 一等公民集成 + per-tool 权限审批。
  - title: Memory 治理
    details: 个人 Memory 直接生效，共享 Memory 经过候选审核；Hybrid SaaS 使用 PostgreSQL 持久化。
  - title: 知识库与向量
    details: SQLite + sqlite-vec 驱动，embedder/reranker/vectorizer 可配置，knowledge.db 自包含。
---

## 推荐阅读路径

1. [开始使用](/00-start/)：安装、启动和健康检查。
2. [系统上下文](/02-architecture/system-context) → [后端组件](/02-architecture/components)：理解边界、依赖和代码落点。
3. [Memory 使用与治理](/03-guides/memory)：理解个人/共享 scope、审核、归档和 PostgreSQL 数据。
4. [接口约定](/04-api/conventions) → [HTTP 路由清单](/04-api/http) → [Memory API](/04-api/memory)：集成客户端或排查请求。
5. [生产运维](/06-operations/)：备份、探针、观测和升级。

::: tip 文档口径
页面中的实现结论以 `backend-ts/src`、`frontend-client/src`、`packages/*/src` 和 `package.json` 为准。
:::
