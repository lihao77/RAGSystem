# RAGSystem

中文 | [English](#english)

RAGSystem 是一个面向多智能体协作场景的 Agent-first 全栈项目，包含 FastAPI 后端与 Vue 3 前端。仓库当前聚焦于 ReAct 编排、多 Agent 执行、Skill 化能力收敛、SSE 流式交互、Memory 与 Hook 系统、MCP 集成，以及面向配置驱动的 Agent 运行时。

## 核心能力 / Key features

- 多智能体编排：基于 Orchestrator Agent 的动态委派、协作与连续执行
- 子 Agent 会话：支持 child agent 创建、找回与 send_message 续接
- 流式交互：支持 SSE 流式执行、监控和中断/重连
- 工具与扩展：内置工具运行时、Skills、MCP Server 集成
- 记忆与钩子：支持按需记忆召回、会话记忆写入与 Hook 事件扩展
- 配置化运行：支持 Agent、模型提供方、MCP 服务的模板化配置
- 可视化前端：聊天、监控、Team 编排、Agent 配置、MCP 管理、向量库与模型管理页面

前端主导航同时提供 TeamBuilder 入口（`/team-builder`），用于生成、切换与整理 Team 方案；生成后的 Team 可继续进入 Agent 配置页做细调。

## 仓库结构 / Repository layout

```text
.
├── backend-fastapi/          # FastAPI backend and agent runtime
├── frontend-client/          # Vue 3 client and execution visualization
├── docs/                     # Canonical documentation center
└── .github/                  # GitHub templates and workflows
```

## 技术栈 / Tech stack

- 后端 / Backend: FastAPI, Pydantic, SSE, MCP, Python
- 前端 / Frontend: Vue 3, Vite, Axios, ECharts, Leaflet
- 运行模式 / Runtime: Agent-first orchestration with ReAct-style execution, Skills, Memory, and Hooks

## 快速开始 / Quick start

### 1. 环境要求 / Prerequisites

- Python 3.12（CI 使用 / used in CI）
- Node.js 20+
- npm

### 2. 环境与运行时配置 / Environment and runtime config

先复制环境变量示例：

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp frontend-client/.env.example frontend-client/.env
```

后端启动时会自动初始化 app 与 agent 的运行时配置；MCP 与模型提供方配置需由用户在运行时目录中自行提供，正式生效的配置不再直接存放在 `backend-fastapi/...` 源码目录。

- 默认运行时配置根目录：`~/.ragsystem/config`
- 若设置 `RAG_DATA_ROOT`，则配置目录变为 `<RAG_DATA_ROOT>/config`
- 主要配置文件：
  - `app/config.yaml`
  - `agents/team_index.yaml`
  - `agents/teams/*.yaml`
  - `mcp/mcp_servers.yaml`（按需创建）
  - `model_adapter/providers.yaml`（按需创建）

更完整的运行、配置与验证说明见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

Windows PowerShell 可使用 `Copy-Item` 代替 `cp`。

### 3. 启动后端 / Start the backend

```bash
cd backend-fastapi
python main.py
```

默认监听 `http://localhost:5001`。当 `frontend-client/dist` 存在时，后端也会托管前端构建产物。

### 4. 启动前端 / Start the frontend

```bash
cd frontend-client
npm install
npm run dev
```

默认开发地址为 `http://localhost:5174`，并通过 Vite 代理 `/api` 到 `http://localhost:5001`。

## 测试与验证 / Testing

后端：

```bash
cd backend-fastapi
python -m compileall .
python -m py_compile main.py
pytest --basetemp=.pytest-tmp agents/tests/
```

前端：

```bash
cd frontend-client
npm run build
```

## 文档导航 / Documentation

- [docs/README.md](docs/README.md) — 仓库正式文档中心 / canonical repository documentation center
- [backend-fastapi/docs/README.md](backend-fastapi/docs/README.md) — 后端文档入口 / backend documentation entry
- [frontend-client/docs/README.md](frontend-client/docs/README.md) — 前端文档入口 / frontend documentation entry
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 运行、配置与验证 / operations, configuration, and verification
- [docs/refactor/README.md](docs/refactor/README.md) — 当前演进专题 / active evolution topics

## 贡献 / Contributing

欢迎提交 Issue 和 Pull Request。开始贡献前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证 / License

本项目基于 [MIT License](LICENSE) 开源。

---

## English

RAGSystem is an agent-first full-stack project for multi-agent collaboration. It combines a FastAPI backend with a Vue 3 frontend, and currently focuses on ReAct-style orchestration, multi-agent execution, Skill-based capabilities, SSE streaming, Memory and Hook systems, MCP integration, and a configuration-driven agent runtime.

### Key features

- Multi-agent orchestration driven by an Orchestrator Agent for delegation, collaboration, and continuous execution
- Child agent sessions with create, resume, and send_message continuation flows
- SSE-based streaming execution, monitoring, stop, and reconnect flows
- Extensible runtime with local tools, Skills, and MCP server integration
- Memory recall, session memory write-back, and Hook-based event extensibility
- Template-based local configuration for agents, model providers, and MCP servers
- Web UI for chat, monitoring, team composition, agent configuration, MCP management, vector libraries, and model providers

The primary navigation also exposes a TeamBuilder entry (`/team-builder`) for generating, switching, and organizing team plans before refining individual agents in the agent configuration page.

### Repository layout

```text
.
├── backend-fastapi/          # FastAPI backend and agent runtime
├── frontend-client/          # Vue 3 client and execution visualization
├── docs/                     # Canonical documentation center
└── .github/                  # GitHub templates and workflows
```

### Tech stack

- Backend: FastAPI, Pydantic, SSE, MCP, Python
- Frontend: Vue 3, Vite, Axios, ECharts, Leaflet
- Runtime: Agent-first orchestration with ReAct-style execution, Skills, Memory, and Hooks

### Quick start

#### 1. Prerequisites

- Python 3.12
- Node.js 20+
- npm

#### 2. Environment and runtime config

Copy the environment templates first:

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp frontend-client/.env.example frontend-client/.env
```

When the backend starts, it initializes runtime app and agent configs. MCP and model provider configs must be created by the user in the runtime config directory. The effective configs are no longer meant to live directly under the `backend-fastapi/...` source tree.

- Default runtime config root: `~/.ragsystem/config`
- If `RAG_DATA_ROOT` is set, the config root becomes `<RAG_DATA_ROOT>/config`
- Main runtime config files:
  - `app/config.yaml`
  - `agents/team_index.yaml`
  - `agents/teams/*.yaml`
  - `mcp/mcp_servers.yaml` (create when needed)
  - `model_adapter/providers.yaml` (create when needed)

For fuller run, configuration, and verification guidance, see [docs/OPERATIONS.md](docs/OPERATIONS.md).

#### 3. Start the backend

```bash
cd backend-fastapi
python main.py
```

The backend listens on `http://localhost:5001` by default. If `frontend-client/dist` exists, the backend also serves the built frontend assets.

#### 4. Start the frontend

```bash
cd frontend-client
npm install
npm run dev
```

The frontend runs on `http://localhost:5174` by default and proxies `/api` to `http://localhost:5001`.

### Testing

Backend:

```bash
cd backend-fastapi
python -m compileall .
python -m py_compile main.py
pytest --basetemp=.pytest-tmp agents/tests/
```

Frontend:

```bash
cd frontend-client
npm run build
```

### Documentation

- [docs/README.md](docs/README.md) — canonical repository documentation center
- [backend-fastapi/docs/README.md](backend-fastapi/docs/README.md) — backend documentation entry
- [frontend-client/docs/README.md](frontend-client/docs/README.md) — frontend documentation entry
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — operations, configuration, and verification
- [docs/refactor/README.md](docs/refactor/README.md) — active evolution topics

### Contributing

Please open an Issue or Pull Request. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

### License

This project is released under the [MIT License](LICENSE).
