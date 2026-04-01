# 后端文档入口 / Backend Docs

本目录是 `backend-fastapi/` 的正式文档入口，集中索引后端架构、工具系统与后端实现约定。

## 当前文档

- [architecture.md](architecture.md) — 后端架构总览，包含 Agent 体系、运行时分层、请求链路与核心模块说明
- [tools.md](tools.md) — 工具系统总览，包含工具注册、执行流程、权限、路径治理与 Artifact 约定

## 推荐阅读顺序

1. [architecture.md](architecture.md)
2. [tools.md](tools.md)

## 维护约定

- 本 README 只负责后端文档导航与阅读顺序。
- 详细设计、实现约束与结构说明写在具体 docs 文档中，不写回仓库根 README。
- 修改后端系统行为后，必须同步更新对应文档：
  - 架构与运行时行为变更 → 更新 [architecture.md](architecture.md)
  - 工具系统、权限、执行链路变更 → 更新 [tools.md](tools.md)
- 历史评估或已废弃方案不要继续放在本目录主线入口，统一从仓库归档入口查看。

## 返回上层

- [../../docs/README.md](../../docs/README.md) — 仓库文档中心
- [../CLAUDE.md](../CLAUDE.md) — 后端开发代理工作指引
