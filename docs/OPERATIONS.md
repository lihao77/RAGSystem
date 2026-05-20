# 运行说明 / Operations Guide

## 服务入口 / Service entrypoints

### 后端 / Backend

```bash
cd backend-fastapi
pip install -r requirements.txt
python main.py
```

- 默认地址 / Default URL: `http://localhost:5001`
- 可通过 `.env` 配置 `FASTAPI_HOST`、`FASTAPI_PORT`、`FASTAPI_RELOAD`
- 若 `frontend-client/dist` 存在，后端会托管前端构建产物

### 前端 / Frontend

```bash
cd frontend-client
npm install
npm run dev
```

- 默认地址 / Default URL: `http://localhost:5174`
- `/api` 与 WebSocket 代理到 / proxies `/api` and WebSocket traffic to `http://localhost:5001`
- 可通过 `frontend-client/.env` 配置 `VITE_DEV_PORT` 与 `VITE_API_PROXY_TARGET`

### 桌面安装包 / Desktop installer

```bash
cd desktop-electron
npm install
cd ../backend-fastapi
pip install -r requirements.txt pyinstaller
cd ../desktop-electron
npm run build:installer
```

- 输出目录 / Output directory: `desktop-electron/release`
- 安装包类型 / Installer type: Windows NSIS `.exe`
- 后端打包使用 `backend-fastapi/ragsystem_backend.spec`，会自动排除 `agents/skills/**/.venv` 等本地虚拟环境，并通过 `sys.path` 注入 + `hiddenimports` 显式兜底收集 `tools.local.*` 子模块，避免桌面包缺少 direct 工具
- 桌面端启动时会自动拉起内置后端，并把运行时数据统一写入用户主目录下的 `~/.ragsystem`
- Electron 会把后端进程工作目录固定到 `~/.ragsystem`，避免安装目录（如 `Program Files`）下的只读写入错误

## 最小配置链路 / Minimal configuration chain

先复制环境变量示例：

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp frontend-client/.env.example frontend-client/.env
```

后端启动时会把缺失的运行时配置从 `.example` 模板初始化到运行时目录；其中 Agent 配置由 `AgentConfigManager` 管理，并会生成一套系统默认 `default` team（包含 `orchestrator_agent`、`team_maker`、`plan_agent`、`explor_agent`、`general_agent`、`review_agent`、`test_agent`）。正式生效配置优先从运行时目录读取，而不是直接从 `backend-fastapi/...` 源码目录读取。

- 默认运行时数据根目录：`~/.ragsystem`
- 若设置 `RAG_DATA_ROOT`，则运行时数据根目录变为 `<RAG_DATA_ROOT>`
- 运行时主配置文件位于 `<data-root>/config`：
  - `app/config.yaml`
  - `agents/team_index.yaml`
  - `agents/teams/*.yaml`
  - `model_adapter/providers.yaml`
  - `vector_store/vectorizers.yaml`
  - `mcp/mcp_servers.yaml`
  - `daemon/daemon.yaml`

源码目录中的以下文件只作为初始化模板或系统默认配置来源：

- `backend-fastapi/config/yaml/config.yaml.example`
- `backend-fastapi/agents/configs/agent_configs.yaml.example`
- `backend-fastapi/model_adapter/configs/providers.yaml.example`
- `backend-fastapi/vector_store/configs/vectorizers.yaml.example`
- `backend-fastapi/mcp/configs/mcp_servers.yaml.example`
- `backend-fastapi/config/yaml/daemon.yaml.example`

模型 Provider、MCP Server、向量化器和守护 Agent 配置会在缺失时从模板 seed；填入密钥、服务地址或启用项后即可使用，也可通过前端管理页面写入。

## 常用接口与页面 / Common endpoints and pages

- `POST /api/agent/stream` — 启动执行，实时内容经 WebSocket 推送 / start execution; realtime content is delivered over WebSocket
- `/api/agent/sessions/{session_id}/ws` — session WebSocket 实时通道 / session realtime WebSocket
- `POST /api/agent/execute` — 同步执行 / synchronous execution
- `GET /api/agent/execution/overview` — 执行概览 / execution overview
- `/monitor` — 监控页面 / monitoring UI
- `/team-builder` — Team 编排页面 / team composition UI
- `/agent-config` — Agent 配置页面 / agent configuration UI
- `/mcp` — MCP 管理页面 / MCP management UI
- `/vector-library` — 向量库页面 / vector library UI
- `/model-providers` — 模型提供方页面 / model provider UI
- `/daemon` — 守护 Agent 页面 / daemon agent UI
- `/system-config` — 系统配置页面 / system configuration UI

## 验证命令 / Verification commands

```bash
cd backend-fastapi
python -m compileall .
python -m py_compile main.py
pytest --basetemp=.pytest-tmp agents/tests/
cd ../frontend-client
npm run build
npm test
npm run screenshot:smoke
```
