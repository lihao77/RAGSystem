# 文档中心 / Documentation Center

本目录是仓库级正式文档中心，负责统一索引主线文档、当前专题文档与历史归档文档。

This directory is the canonical repository-level documentation center for mainline docs, active topic docs, and archived docs.

## 主线文档 / Mainline documents

- [../README.md](../README.md) — 中文仓库入口与快速开始 / Chinese repository entry and quick start
- [../README.en.md](../README.en.md) — English repository entry and quick start / 英文仓库入口与快速开始
- [../backend-ts/README.md](../backend-ts/README.md) — TypeScript 后端入口 / TypeScript backend entry
- [../frontend-client/docs/README.md](../frontend-client/docs/README.md) — 前端文档入口 / frontend documentation entry
- [OPERATIONS.md](OPERATIONS.md) — 运行、配置与验证 / operations, configuration, and verification
- [BACKEND_PLUGIN_CONFIG.md](BACKEND_PLUGIN_CONFIG.md) — 后端插件配置与接入契约 / backend plugin configuration and module contract

## 专题文档 / Topic documents

- [refactor/README.md](refactor/README.md) — 当前重构与演进专题 / active refactor and evolution topics
- [geoplus/README.md](geoplus/README.md) — GeoPLUS 扩展专题 / GeoPLUS extension topics

当前主线专题文档：
- [refactor/ADAPTIVE_AGENT_EXPERIENCE_PLAN.md](refactor/ADAPTIVE_AGENT_EXPERIENCE_PLAN.md) — AutoDream 记忆治理方案 / AutoDream memory governance plan
- [refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md](refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md) — Claude Code 对标演进路线图 / alignment roadmap vs Claude Code
- [refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md](refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md) — 工具体系差异分析 / tooling gap analysis vs Claude Code

## 归档文档 / Archived documents

- [archive/README.md](archive/README.md) — 历史文档归档入口 / archive entry

## 维护约定 / Maintenance rules

- 仓库级正式文档索引以本文件为唯一入口。
- README 负责总览与导航，详细设计与实现说明放在对应 `docs/` 文档中。
- 修改系统行为后，请同步更新对应架构文档或专题文档。
- archive 中的历史文档只保留参考价值，不作为当前主线依据。
- 不在示例配置或文档中提交真实密钥、令牌或部署地址。

- This file is the single repository-level documentation index.
- Keep README files high-level and place detailed design notes in `docs/`.
- Update the matching architecture or topic docs whenever system behavior changes.
- Archived docs are reference-only and should not be treated as current guidance.
- Never commit real keys, tokens, or deployment addresses to docs or example configs.
