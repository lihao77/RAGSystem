# RAGSystem

中文 | [English](#english)

RAGSystem 是一个面向多智能体协作场景的 Agent-first 全栈项目，包含 FastAPI 后端与 Vue 3 前端。仓库重点提供 ReAct 编排、多 Agent 执行、SSE 流式交互、MCP 集成、Agent 配置管理与执行监控能力。

## 核心能力 / Key features

- 多智能体编排：基于 Orchestrator Agent 的动态委派与协作
- 流式交互：支持 SSE 流式执行、监控和中断/重连
- 工具与扩展：内置工具系统、Skills、MCP Server 集成
- 配置化运行：支持 Agent、模型提供方、MCP 服务的模板化配置
- 可视化前端：聊天、监控、Agent 配置、MCP 管理、向量库与模型管理页面

## 仓库结构 / Repository layout

```text
.
├── backend-fastapi/          # FastAPI backend
├── frontend-client/          # Vue 3 client
├── docs/                     # Top-level documentation index
└── .github/                  # GitHub templates and workflows
```

## 技术栈 / Tech stack

- 后端 / Backend: FastAPI, Pydantic, SSE, MCP, Python
- 前端 / Frontend: Vue 3, Vite, Axios, ECharts, Leaflet
- 运行模式 / Runtime: Agent-first orchestration with ReAct-style execution

## 快速开始 / Quick start

### 1. 环境要求 / Prerequisites

- Python 3.12（CI 使用 / used in CI）
- Node.js 20+
- npm

### 2. 后端最小配置 / Minimal backend configuration

先复制示例配置，再填入你自己的本地配置值。

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp backend-fastapi/model_adapter/configs/providers.yaml.example backend-fastapi/model_adapter/configs/providers.yaml
cp backend-fastapi/agents/configs/agent_configs.yaml.example backend-fastapi/agents/configs/agent_configs.yaml
cp backend-fastapi/mcp/configs/mcp_servers.yaml.example backend-fastapi/mcp/configs/mcp_servers.yaml
cp backend-fastapi/config/yaml/config.yaml.example backend-fastapi/config/yaml/config.yaml
cp frontend-client/.env.example frontend-client/.env
```

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

- [docs/README.md](docs/README.md) — 文档入口 / documentation index
- [backend-fastapi/docs/architecture.md](backend-fastapi/docs/architecture.md) — 后端架构 / backend architecture
- [backend-fastapi/docs/tools.md](backend-fastapi/docs/tools.md) — 工具系统 / tools system
- [frontend-client/docs/architecture.md](frontend-client/docs/architecture.md) — 前端架构 / frontend architecture
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — 运行与验证 / operations guide

## 贡献 / Contributing

欢迎提交 Issue 和 Pull Request。开始贡献前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证 / License

本项目基于 [MIT License](LICENSE) 开源。

---

## English

RAGSystem is an agent-first full-stack project for multi-agent collaboration. It combines a FastAPI backend with a Vue 3 frontend, and focuses on ReAct-style orchestration, streaming execution, MCP integration, agent configuration, and execution monitoring.

### Key features

- Multi-agent orchestration driven by an Orchestrator Agent
- SSE-based streaming execution, monitoring, stop, and reconnect flows
- Extensible tool system with Skills and MCP server integration
- Template-based local configuration for agents, model providers, and MCP servers
- Web UI for chat, monitoring, agent configuration, MCP management, vector libraries, and model providers

### Repository layout

```text
.
├── backend-fastapi/          # FastAPI backend
├── frontend-client/          # Vue 3 client
├── docs/                     # Top-level documentation index
└── .github/                  # GitHub templates and workflows
```

### Tech stack

- Backend: FastAPI, Pydantic, SSE, MCP, Python
- Frontend: Vue 3, Vite, Axios, ECharts, Leaflet
- Runtime: Agent-first orchestration with ReAct-style execution

### Quick start

#### 1. Prerequisites

- Python 3.12
- Node.js 20+
- npm

#### 2. Minimal backend configuration

Copy the example files and replace template values with your local settings.

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp backend-fastapi/model_adapter/configs/providers.yaml.example backend-fastapi/model_adapter/configs/providers.yaml
cp backend-fastapi/agents/configs/agent_configs.yaml.example backend-fastapi/agents/configs/agent_configs.yaml
cp backend-fastapi/mcp/configs/mcp_servers.yaml.example backend-fastapi/mcp/configs/mcp_servers.yaml
cp backend-fastapi/config/yaml/config.yaml.example backend-fastapi/config/yaml/config.yaml
cp frontend-client/.env.example frontend-client/.env
```

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

- [docs/README.md](docs/README.md)
- [backend-fastapi/docs/architecture.md](backend-fastapi/docs/architecture.md)
- [backend-fastapi/docs/tools.md](backend-fastapi/docs/tools.md)
- [frontend-client/docs/architecture.md](frontend-client/docs/architecture.md)
- [docs/OPERATIONS.md](docs/OPERATIONS.md)

### Contributing

Please open an Issue or Pull Request. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

### License

This project is released under the [MIT License](LICENSE).
