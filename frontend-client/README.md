# Frontend Client

中文 | [English](#english)

`frontend-client/` 是 RAGSystem 的 Vue 3 前端，提供聊天、执行过程、运行工作台、Agent 编排、MCP 管理、知识库、模型提供方、Skill 库、记忆、定时任务和系统配置界面。

## 开发启动 / Development

```bash
cp .env.example .env
npm install
npm run dev
```

默认端口为 `http://localhost:5174`，`/api` 与 WebSocket 会代理到 TypeScript 后端 `http://localhost:5002`。

## 主要页面 / Main pages

- `/` 或 `/chat/:id?` — 聊天页面
- `/admin` — 管理中心
- `/agent-studio` — Agent 编排（Team 与 Agent 配置；`/team-builder`、`/agent-config` 重定向至此）
- `/monitor`、`/agent-monitor` — 执行监控
- `/mcp` — MCP 管理
- `/knowledge-base` — 知识库管理
- `/skill-library` — Skill 库
- `/model-providers` — 模型提供方管理
- `/memory` — 记忆管理
- `/scheduler` — 定时任务
- `/bots` — 机器人
- `/system-config` — 系统配置

## 构建 / Build

```bash
npm run build
npm test
npm run screenshot:smoke
```

## 文档 / Documentation

- [docs/README.md](docs/README.md) — 前端文档入口
- [docs/architecture.md](docs/architecture.md) — 前端架构总览
- [../docs/README.md](../docs/README.md) — 仓库文档中心

## 维护约定 / Maintenance

- 本 README 只负责前端子项目入口与开发说明，不承担完整 docs 索引职责。
- 详细设计、通信链路与实现说明统一写在 `docs/` 中。
- 修改前端系统行为后，需同步更新对应文档，避免实现与文档语义漂移。

---

## English

`frontend-client/` is the Vue 3 frontend for RAGSystem. It provides chat, execution process inspection, the run workbench, agent studio, MCP management, knowledge base management, model provider management, the skill library, memory management, scheduled tasks, and system configuration.

### Development

```bash
cp .env.example .env
npm install
npm run dev
```

The dev server runs on `http://localhost:5174` by default and proxies `/api` plus WebSocket traffic to the TypeScript backend at `http://localhost:5002`.

### Main pages

- `/` or `/chat/:id?` — chat
- `/admin` — admin center
- `/agent-studio` — agent studio for team and agent configuration (`/team-builder` and `/agent-config` redirect here)
- `/monitor`, `/agent-monitor` — execution monitoring
- `/mcp` — MCP management
- `/knowledge-base` — knowledge base management
- `/skill-library` — skill library
- `/model-providers` — model provider management
- `/memory` — memory management
- `/scheduler` — scheduled tasks
- `/bots` — bots
- `/system-config` — system configuration

### Build

```bash
npm run build
npm test
npm run screenshot:smoke
```

### Documentation

- [docs/README.md](docs/README.md) — frontend documentation entry
- [docs/architecture.md](docs/architecture.md) — frontend architecture overview
- [../docs/README.md](../docs/README.md) — repository documentation center

### Maintenance

- This README is only the frontend project entry and development guide, not the full docs index.
- Put detailed design and implementation notes in `docs/`.
- Update the matching docs whenever frontend behavior changes.
