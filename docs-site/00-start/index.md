---
status: current
audience: all
source: package.json, backend-ts/package.json
verified_at: 2026-07-18
---

# 开始使用

RAGSystem 是一个 Agent-first 的 RAG 与多智能体协作系统。推荐按下面的路径阅读：

1. [安装与启动](./getting-started)
2. [核心概念](/01-concepts/)
3. [系统上下文](/02-architecture/system-context)
4. [知识库流程](/03-guides/knowledge-base)
5. [HTTP 与实时 API](/04-api/)

## 运行时基线

| 项目 | 当前值 |
|---|---|
| 后端 | Fastify 5 + TypeScript |
| Node.js | >= 24 |
| 默认端口 | 5002 |
| 主存储 | SQLite + `node:sqlite` |
| 向量存储 | SQLite + `sqlite-vec` |
| 前端 | Vue 3 + Vite |
| 实时协议 | WebSocket、SSE、AG-UI |

## 选择入口

| 目标 | 页面 |
|---|---|
| 第一次运行 | [安装与启动](./getting-started) |
| 配置服务 | [配置指南](/03-guides/configuration) |
| 接入知识库 | [知识库指南](/03-guides/knowledge-base) |
| 开发 Agent/工具 | [Agent 开发](/05-sdk/agent-development) |
| 接入 Widget | [Widget 集成](/03-guides/widget) |
| 生产部署 | [运维手册](/06-operations/) |
