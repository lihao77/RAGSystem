# 文档中心

当前文档只保留与现有系统直接对应的最小集合。

## 架构文档（开发前必读）

- [后端架构](../backend-fastapi/docs/architecture.md) — Agent 体系、占位符、事件、上下文、配置、Skills、API
- [工具系统](../backend-fastapi/docs/tools.md) — 注册链路、执行流程、数据模型、工具清单、Artifact
- [前端架构](../frontend-client/docs/architecture.md) — SSE 通信、消息结构、可视化渲染、态势大屏

## 其他文档

- [../README.md](../README.md) — 项目入口、快速启动
- [OPERATIONS.md](OPERATIONS.md) — 运维指南
- [geoplus/README.md](geoplus/README.md) — GeoPLUS 治理
- [refactor/AGENT_FIRST_REFACTOR_PLAN.md](refactor/AGENT_FIRST_REFACTOR_PLAN.md) — 重构历史（已完成）
- [../frontend-client/README.md](../frontend-client/README.md) — 前端启动指南

## 维护原则

- 修改系统代码后，必须同步更新对应的架构文档
- 只保留当前系统还在使用的文档
- 方案类文档统一放到 `docs/refactor/`
