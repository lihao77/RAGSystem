# 文档中心 / Documentation Index

本目录用于提供仓库级文档导航。系统实现细节请优先查看后端与前端架构文档。

This directory provides top-level documentation navigation. For implementation details, start with the backend and frontend architecture documents.

## 核心文档 / Core documents

- [../README.md](../README.md) — 仓库入口与快速开始 / repository entry and quick start
- [../backend-fastapi/docs/architecture.md](../backend-fastapi/docs/architecture.md) — 后端架构 / backend architecture
- [../backend-fastapi/docs/tools.md](../backend-fastapi/docs/tools.md) — 工具系统 / tools system
- [../frontend-client/docs/architecture.md](../frontend-client/docs/architecture.md) — 前端架构 / frontend architecture
- [OPERATIONS.md](OPERATIONS.md) — 运行、配置与验证 / operations, configuration, and verification

## 其他文档 / Additional documents

- [geoplus/README.md](geoplus/README.md) — GeoPLUS 相关说明 / GeoPLUS documentation
- [refactor/README.md](refactor/README.md) — 重构文档索引 / refactor documentation index
- [refactor/AGENT_FIRST_REFACTOR_PLAN.md](refactor/AGENT_FIRST_REFACTOR_PLAN.md) — 历史重构方案 / historical refactor plan
- [../frontend-client/README.md](../frontend-client/README.md) — 前端单独说明 / frontend-specific guide

## 维护约定 / Maintenance rules

- 修改系统代码后，请同步更新对应架构文档。
- 保持 README 负责总览，详细设计放在深层文档中。
- 不在示例配置或文档中提交真实密钥、令牌或部署地址。

- Update the matching architecture document whenever system behavior changes.
- Keep the root README high-level and put detailed design notes in deeper docs.
- Never commit real keys, tokens, or deployment addresses to docs or example configs.
